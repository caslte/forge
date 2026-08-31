/**
 * 子 Agent 管理服务单元测试（wu-06-subagent-core）。
 *
 * 覆盖 docs/test/06_subagent/unit.md：
 * - U-SA-003 主会话 done 门控（AC-SA-004/005）
 * - U-SA-004 超时兜底（AC-SA-006，注入假时钟不真实等待 30 分钟）
 * - U-SA-005 级联终止编排（AC-SA-016/017）
 * - U-SA-006 按会话隔离（AC-SA-021）
 * - U-SA-007 会话删除清理（AC-SA-022）
 * - clearFinished / stop 错误码契约（docs/api/06_subagent.md §2/§3/§6）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SubagentService,
  SUBAGENT_DONE_TIMEOUT_MS,
  type SubagentResult,
  type SubagentStopPort,
} from '../../src/subagent/subagentService.ts';

/** 固定基准时间（毫秒） */
const BASE_MS = Date.parse('2026-08-28T10:00:00.000Z');

/** 基于基准时间的 ISO 时间戳辅助 */
const iso = (offsetMs: number): string => new Date(BASE_MS + offsetMs).toISOString();

/** 假时钟：时间可推进、计时器不真实等待（超时兜底测试用） */
class FakeClock {
  private current = BASE_MS;
  private seq = 0;
  private readonly timers = new Map<number, { at: number; fn: () => void }>();

  now(): number {
    return this.current;
  }

  setTimeout(fn: () => void, ms: number): unknown {
    const id = ++this.seq;
    this.timers.set(id, { at: this.current + ms, fn });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** 推进虚拟时间，按到期顺序触发沿途到期计时器 */
  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = [...this.timers.entries()]
        .filter(([, t]) => t.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (due === undefined) break;
      this.timers.delete(due[0]);
      this.current = due[1].at;
      due[1].fn();
    }
    this.current = target;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

/** 事件收集器：记录经 EventSink 发射的全部事件供断言 */
class RecordingSink {
  readonly events: Array<{ sessionId: string; event: string; payload: unknown }> = [];

  emit(sessionId: string, event: string, payload: unknown): boolean {
    this.events.push({ sessionId, event, payload });
    return true;
  }

  all(eventName: string): Array<{ sessionId: string; event: string; payload: unknown }> {
    return this.events.filter((e) => e.event === eventName);
  }

  /** 统计某会话发出的 done 事件数（conversation.statusChanged 且 status=done） */
  doneCount(sessionId: string): number {
    return this.events.filter(
      (e) =>
        e.event === 'conversation.statusChanged' &&
        e.sessionId === sessionId &&
        (e.payload as { status?: string }).status === 'done',
    ).length;
  }
}

/** 终止端口桩：按 agentId 脚本化成功/首次失败/持续失败行为，记录调用序列 */
function makeStopPort(script: Record<string, 'ok' | 'fail' | 'fail-once'> = {}): {
  calls: string[];
  port: SubagentStopPort;
} {
  const calls: string[] = [];
  const port: SubagentStopPort = {
    async stop(_sessionId: string, agentId: string): Promise<void> {
      calls.push(agentId);
      const mode = script[agentId] ?? 'ok';
      if (mode === 'fail') {
        throw new Error(`rpc down: ${agentId}`);
      }
      if (mode === 'fail-once') {
        const attempts = calls.filter((c) => c === agentId).length;
        if (attempts === 1) {
          throw new Error(`first attempt failed: ${agentId}`);
        }
      }
    },
  };
  return { calls, port };
}

/** 构造被测服务 + 假时钟 + 事件收集器 + 日志收集器 */
function makeService(options: { timeoutMs?: number } = {}): {
  clock: FakeClock;
  sink: RecordingSink;
  warnings: string[];
  service: SubagentService;
} {
  const clock = new FakeClock();
  const sink = new RecordingSink();
  const warnings: string[] = [];
  const service = new SubagentService({
    sink,
    clock,
    logger: { warn: (m: string) => warnings.push(m) },
    ...options,
  });
  return { clock, sink, warnings, service };
}

/** 断言错误联合的 code（可附带消息子串） */
function expectErr<T>(res: SubagentResult<T>, code: 1001 | 1002 | 5000, messageHint?: string): void {
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, code);
    if (messageHint !== undefined) {
      assert.ok(res.message.includes(messageHint));
    }
  }
}

test('SUBAGENT_DONE_TIMEOUT_MS 默认 30 分钟', () => {
  assert.equal(SUBAGENT_DONE_TIMEOUT_MS, 30 * 60 * 1000);
});

test('U-SA-003.1 主轮结束时仍有活跃子 agent 不发 done（保持等待）', () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 0); // 计数=1，done 延迟
  // 负向：计数>0 时任何信号组合都不得发出 done
  service.notifyMainTurnEnd('s1');
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 0);
});

test('U-SA-003.2 子 agent 全部终态后计数归零发 done 恰好一次', () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 0);
  service.ingest('s1', { agentId: 'a1', status: 'completed', result: 'R', finishedAt: iso(1) });
  assert.equal(sink.doneCount('s1'), 1); // 计数=0 → done
  const doneEvents = sink.all('conversation.statusChanged');
  assert.equal(doneEvents.length, 1);
  assert.equal(doneEvents[0].sessionId, 's1');
  assert.deepEqual(doneEvents[0].payload, { status: 'done' });
  // 不重发：重复主轮结束信号 / 重复完成事件
  service.notifyMainTurnEnd('s1');
  service.ingest('s1', { agentId: 'a1', status: 'completed', result: 'R', finishedAt: iso(1) });
  assert.equal(sink.doneCount('s1'), 1);
});

test('U-SA-003.3 反向序列：子 agent 先完成，主轮结束后立即 done 且无残留计时器', () => {
  const { service, sink, clock } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'completed', result: 'R', finishedAt: iso(1) });
  assert.equal(sink.doneCount('s1'), 0); // 主轮未结束，不发 done
  assert.equal(clock.pendingCount, 0); // 无残留计时器
  service.notifyMainTurnEnd('s1'); // 主轮结束 → 立即 done
  assert.equal(sink.doneCount('s1'), 1);
  assert.equal(clock.pendingCount, 0); // 仍无计时器残留
});

test('U-SA-003.4 两个子 agent 先后完成，done 仅在最后一个完成时发出一次', () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.ingest('s1', { agentId: 'a2', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 0);
  service.ingest('s1', { agentId: 'a1', status: 'completed', finishedAt: iso(1) });
  assert.equal(sink.doneCount('s1'), 0); // 还剩 a2 活跃
  service.ingest('s1', { agentId: 'a2', status: 'completed', finishedAt: iso(2) });
  assert.equal(sink.doneCount('s1'), 1); // 仅第二个完成时发出一次
});

test('U-SA-004.1 主轮结束后 29 分钟无事件仍保持等待（不发 done）', () => {
  assert.equal(SUBAGENT_DONE_TIMEOUT_MS, 30 * 60 * 1000); // 默认窗口 30 分钟
  const { service, sink, clock } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  assert.equal(clock.pendingCount, 1); // 计时器已启动
  clock.advance(29 * 60_000);
  assert.equal(sink.doneCount('s1'), 0); // 窗口内不放行
});

test('U-SA-004.2 推进至 30 分钟整触发兜底：done 恰好一次 + 兜底日志，不重发', () => {
  const { service, sink, clock, warnings } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  clock.advance(30 * 60_000); // 累计 30 分钟整
  assert.equal(sink.doneCount('s1'), 1);
  assert.equal(warnings.length, 1); // 兜底日志写入
  assert.ok(warnings[0].includes('s1')); // 日志可定位会话
  // 超时恰好触发一次：继续推进不重发
  clock.advance(30 * 60_000);
  assert.equal(sink.doneCount('s1'), 1);
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 1);
});

test('U-SA-004.3 窗口内子 agent 事件重置计时（30 分钟窗口重新起算）', () => {
  const { service, sink, clock, warnings } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  clock.advance(20 * 60_000); // 第 20 分钟
  service.ingest('s1', { agentId: 'a1', status: 'running', usage: { inputTokens: 1, outputTokens: 1 } }); // 任意子 agent 事件
  clock.advance(10 * 60_000); // 原窗口第 30 分钟点：旧计时器已被重置清除
  assert.equal(sink.doneCount('s1'), 0);
  clock.advance(20 * 60_000); // 重置后第 30 分钟 → 兜底触发
  assert.equal(sink.doneCount('s1'), 1);
  assert.ok(warnings.some((w) => w.includes('s1')));
});

test('U-SA-004.4 兜底后迟到 completed 只更新记录，不重发 done、不复活计时器', () => {
  const { service, sink, clock } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  clock.advance(SUBAGENT_DONE_TIMEOUT_MS); // 兜底触发
  assert.equal(sink.doneCount('s1'), 1);
  service.ingest('s1', { agentId: 'a1', status: 'completed', result: 'late', finishedAt: iso(60 * 60_000) });
  const list = service.queryList('s1');
  assert.ok(list.ok);
  assert.equal(list.data[0].status, 'completed'); // 子 agent 记录照常更新
  assert.equal(list.data[0].result, 'late');
  assert.equal(sink.doneCount('s1'), 1); // 不得把会话拉回 running/done 重发
  assert.equal(clock.pendingCount, 0); // 不复活计时器
});

test('U-SA-004.5 多子 agent 计数不清零也放行兜底（与单个一致）', () => {
  const { service, sink, clock } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.ingest('s1', { agentId: 'a2', agentType: 'T', description: 'd', status: 'queued', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  clock.advance(SUBAGENT_DONE_TIMEOUT_MS);
  assert.equal(sink.doneCount('s1'), 1); // 计数仍为 2 也放行
});

test('U-SA-005.1 级联终止恰好覆盖活跃子 agent，终态记录不被触碰', async () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.ingest('s1', { agentId: 'b', agentType: 'T', description: 'd', status: 'queued', startedAt: iso(0) });
  service.ingest('s1', { agentId: 'c', agentType: 'T', description: 'd', status: 'completed', result: 'R', finishedAt: iso(1) });
  const { calls, port } = makeStopPort();
  const res = await service.stopAllActive('s1', port);
  assert.ok(res.ok);
  assert.deepEqual(res.data, { stopped: ['a', 'b'], failed: [] });
  assert.deepEqual(calls, ['a', 'b']); // 终止调用恰好覆盖 a、b（每个一次），c 不被调用
  const list = service.queryList('s1');
  assert.ok(list.ok);
  const byId = new Map(list.data.map((r) => [r.agentId, r]));
  assert.equal(byId.get('a')?.status, 'stopped');
  assert.equal(byId.get('b')?.status, 'stopped');
  assert.equal(byId.get('c')?.status, 'completed'); // 级联不触碰终态记录
  assert.equal(sink.doneCount('s1'), 0); // 主轮未结束，级联本身不发 done
});

test('U-SA-005.2 级联后活跃归零且主轮已结束则发 done', async () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.ingest('s1', { agentId: 'b', agentType: 'T', description: 'd', status: 'queued', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1'); // 主轮已结束（计数 2 → done 延迟）
  assert.equal(sink.doneCount('s1'), 0);
  const { port } = makeStopPort();
  const res = await service.stopAllActive('s1', port);
  assert.ok(res.ok);
  assert.equal(sink.doneCount('s1'), 1); // a、b 置 stopped → 活跃归零 → done 发出
});

test('U-SA-005.3 重复级联零次新增终止调用（幂等）', async () => {
  const { service } = makeService();
  service.ingest('s1', { agentId: 'a', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  const { calls, port } = makeStopPort();
  await service.stopAllActive('s1', port);
  calls.length = 0; // 重置调用记录
  const res2 = await service.stopAllActive('s1', port);
  assert.ok(res2.ok);
  assert.deepEqual(res2.data, { stopped: [], failed: [] });
  assert.deepEqual(calls, []); // 已终态不再触发终止调用
});

test('U-SA-005.4 单个终止首次失败自动重试一次成功', async () => {
  const { service } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  const { calls, port } = makeStopPort({ a1: 'fail-once' });
  const res = await service.stop('s1', 'a1', port);
  assert.deepEqual(res, { ok: true, data: null });
  assert.deepEqual(calls, ['a1', 'a1']); // 首次失败后重试恰一次
  const list = service.queryList('s1');
  assert.ok(list.ok);
  assert.equal(list.data[0].status, 'stopped');
});

test('U-SA-005.5 持续失败：记日志、不阻塞其余、保留原状态、done 仍按剩余计数延迟', async () => {
  const { service, sink, warnings } = makeService();
  service.ingest('s1', { agentId: 'a', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.ingest('s1', { agentId: 'b', agentType: 'T', description: 'd', status: 'queued', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  const { calls, port } = makeStopPort({ a: 'fail' });
  const res = await service.stopAllActive('s1', port);
  assert.ok(res.ok);
  assert.deepEqual(res.data, { stopped: ['b'], failed: ['a'] });
  assert.deepEqual(calls, ['a', 'a', 'b']); // a 重试恰一次；b 处理不中断
  const list = service.queryList('s1');
  assert.ok(list.ok);
  const byId = new Map(list.data.map((r) => [r.agentId, r]));
  assert.equal(byId.get('a')?.status, 'running'); // a 保留原状态
  assert.equal(byId.get('b')?.status, 'stopped');
  assert.ok(warnings.length > 0); // 持续失败记日志
  assert.equal(sink.doneCount('s1'), 0); // a 仍活跃 → done 仍延迟（按剩余计数规则）
});

test('stop 成功：记录置 stopped（error 带原因）并发射 subagent.updated', async () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  const { calls, port } = makeStopPort();
  const res = await service.stop('s1', 'a1', port);
  assert.deepEqual(res, { ok: true, data: null });
  assert.deepEqual(calls, ['a1']);
  const updated = sink.all('subagent.updated');
  assert.equal(updated.length, 2); // 建档 1 次 + 终止成功 1 次
  assert.equal(updated[1].sessionId, 's1');
  const payload = updated[1].payload as { agentId: string; status: string; error: string | null; finishedAt: string | null };
  assert.equal(payload.agentId, 'a1');
  assert.equal(payload.status, 'stopped');
  assert.equal(payload.error, '已被用户终止');
  assert.ok(payload.finishedAt !== null);
});

test('stop 幂等：已终态直接成功且不调 stopPort', async () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'c1', agentType: 'T', description: 'd', status: 'completed', result: 'R', finishedAt: iso(1) });
  const baseline = sink.all('subagent.updated').length; // 建档事件基线
  const { calls, port } = makeStopPort();
  const res = await service.stop('s1', 'c1', port);
  assert.deepEqual(res, { ok: true, data: null }); // 幂等成功
  assert.deepEqual(calls, []); // 不调 stopPort
  assert.equal(sink.all('subagent.updated').length, baseline); // 无变化不新增发射
});

test('stop 错误码：子 agent 不存在返回 1002；参数缺失返回 1001', async () => {
  const { service } = makeService();
  const { port } = makeStopPort();
  expectErr(await service.stop('s1', 'missing', port), 1002);
  expectErr(await service.stop('', 'a1', port), 1001);
  expectErr(await service.stop('s1', '', port), 1001);
});

test('stop 持续失败：重试恰一次后返回 5000，记录保留原状态', async () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  const baseline = sink.all('subagent.updated').length; // 建档事件基线
  const { calls, port } = makeStopPort({ a1: 'fail' });
  expectErr(await service.stop('s1', 'a1', port), 5000, 'rpc down');
  assert.deepEqual(calls, ['a1', 'a1']); // 重试恰一次
  const list = service.queryList('s1');
  assert.ok(list.ok);
  assert.equal(list.data[0].status, 'running'); // 保留原状态（可重试）
  assert.equal(sink.all('subagent.updated').length, baseline); // 状态未变不新增事件
});

test('U-SA-006 会话隔离：A/B 列表互不串扰、done 按会话独立', () => {
  const { service, sink } = makeService();
  service.ingest('A', { agentId: 'a1', agentType: 'T', description: 'A 的', status: 'running', startedAt: iso(0) });
  service.ingest('B', { agentId: 'b1', agentType: 'T', description: 'B 的', status: 'running', startedAt: iso(0) });
  const la = service.queryList('A');
  const lb = service.queryList('B');
  assert.ok(la.ok);
  assert.ok(lb.ok);
  assert.deepEqual(la.data.map((r) => r.agentId), ['a1']); // A 只含 a1
  assert.deepEqual(lb.data.map((r) => r.agentId), ['b1']); // B 只含 b1，无跨会话泄漏
  service.notifyMainTurnEnd('A');
  service.notifyMainTurnEnd('B');
  service.ingest('A', { agentId: 'a1', status: 'completed', result: 'ra', finishedAt: iso(1) });
  assert.equal(sink.doneCount('A'), 1); // A 计数归零只发 A 的 done
  assert.equal(sink.doneCount('B'), 0); // A 的事件不改变 B 的门控（b1 仍活跃）
  service.ingest('B', { agentId: 'b1', status: 'stopped', error: 'user', finishedAt: iso(2) });
  assert.equal(sink.doneCount('B'), 1); // B 自行收敛
});

test('U-SA-007 disposeSession：清内存态/计时器，迟到事件丢弃不重建，重复幂等', () => {
  const { service, sink, clock } = makeService();
  service.ingest('sX', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('sX');
  assert.equal(clock.pendingCount, 1); // 门控计时器存活
  service.disposeSession('sX');
  assert.equal(clock.pendingCount, 0); // 计时器清除（无残留监听）
  const list = service.queryList('sX');
  assert.ok(list.ok);
  assert.deepEqual(list.data, []); // 内存态清空、注册表无残留键
  const updatedBefore = sink.all('subagent.updated').filter((e) => e.sessionId === 'sX').length;
  // 迟到事件：丢弃不报错、不重建记录
  service.ingest('sX', { agentId: 'a1', status: 'completed', result: 'late', finishedAt: iso(1) });
  const list2 = service.queryList('sX');
  assert.ok(list2.ok);
  assert.deepEqual(list2.data, []);
  assert.equal(
    sink.all('subagent.updated').filter((e) => e.sessionId === 'sX').length,
    updatedBefore,
  );
  // 门控信号同样忽略
  service.notifyMainTurnEnd('sX');
  assert.equal(sink.doneCount('sX'), 0);
  // 重复删除幂等
  service.disposeSession('sX');
  service.disposeSession('sX');
  assert.equal(clock.pendingCount, 0);
});

test('clearFinished：移除全部终态返回 id 列表、活跃保留、发 subagent.removed', () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'completed', result: 'R', finishedAt: iso(1) });
  service.ingest('s1', { agentId: 'a2', agentType: 'T', description: 'd', status: 'failed', error: 'x', finishedAt: iso(2) });
  service.ingest('s1', { agentId: 'b1', agentType: 'T', description: 'd', status: 'running' });
  const res = service.clearFinished('s1');
  assert.ok(res.ok);
  assert.deepEqual([...res.data].sort(), ['a1', 'a2']);
  const list = service.queryList('s1');
  assert.ok(list.ok);
  assert.deepEqual(list.data.map((r) => r.agentId), ['b1']); // 活跃记录保留
  const removed = sink.all('subagent.removed');
  assert.equal(removed.length, 1);
  assert.deepEqual(
    (removed[0].payload as { agentIds: string[] }).agentIds.sort(),
    ['a1', 'a2'],
  );
});

test('clearFinished：无终态返回空列表且不发 subagent.removed', () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'b1', agentType: 'T', description: 'd', status: 'running' });
  const res = service.clearFinished('s1');
  assert.ok(res.ok);
  assert.deepEqual(res.data, []);
  assert.equal(sink.all('subagent.removed').length, 0);
});

test('错误码：queryList/clearFinished 参数缺失返回 1001；会话不存在返回空列表', () => {
  const { service } = makeService();
  expectErr(service.queryList(''), 1001);
  expectErr(service.clearFinished(''), 1001);
  const list = service.queryList('nope');
  assert.ok(list.ok);
  assert.deepEqual(list.data, []); // 会话不存在/空返回 []
});

// ===== 主轮看门狗强制放行（wu-06 兜底补充：主轮结束信号整体丢失）=====

test('forceDone：无前置信号直接发 done 恰好一次，迟到门控信号与子 agent 事件不复活', () => {
  const { service, sink } = makeService();
  // 主轮结束信号丢失（notifyMainTurnEnd 未达）时看门狗强制放行
  service.forceDone('s1');
  assert.equal(sink.doneCount('s1'), 1, 'forceDone 应直接发 done 恰好一次');

  // 迟到的主轮结束信号不重复发 done
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 1, '迟到 notifyMainTurnEnd 不得重复发 done');

  // 迟到子 agent 事件只更新记录，不复活门控、不重发 done
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running' });
  service.ingest('s1', { agentId: 'a1', status: 'completed', result: 'R' });
  assert.equal(sink.doneCount('s1'), 1, '迟到子 agent 事件不得重发 done');
  const updated = sink.all('subagent.updated');
  assert.equal(updated.length, 2, '迟到事件仍应更新子 agent 记录（列表最终一致）');
});

test('forceDone：与活跃子 agent 兜底共用收敛语义（forceDone 后清空兜底计时器）', () => {
  const { service, sink, clock } = makeService({ timeoutMs: 60_000 });
  // 主轮结束 + 活跃子 agent → 延迟 done 并启动兜底计时
  service.ingest('s1', { agentId: 'a1', status: 'running' });
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 0);
  assert.equal(clock.pendingCount, 1, '计数>0 应启动兜底计时');

  // 看门狗在子 agent 兜底窗口内强制放行 → done 恰好一次且计时器清理
  service.forceDone('s1');
  assert.equal(sink.doneCount('s1'), 1);
  assert.equal(clock.pendingCount, 0, 'forceDone 应清理兜底计时器');

  // 子 agent 后续完成不再重发 done
  service.ingest('s1', { agentId: 'a1', status: 'completed', result: 'R' });
  assert.equal(sink.doneCount('s1'), 1);
});

test('forceDone：已销毁会话忽略；重复调用幂等', () => {
  const { service, sink } = makeService();
  service.disposeSession('s1');
  service.forceDone('s1');
  assert.equal(sink.doneCount('s1'), 0, '已销毁会话的 forceDone 应忽略');

  service.forceDone('s2');
  service.forceDone('s2');
  assert.equal(sink.doneCount('s2'), 1, '重复 forceDone 应幂等');
});

// ===== U-SA-008 门控按轮重置（notifyMainTurnStart）：修复多轮对话第二轮起 done 永不发射 =====

test('U-SA-008.1 notifyMainTurnStart 重置门控：新一轮再次发 done（多轮各一次）', () => {
  const { service, sink } = makeService();
  // 第一轮：无子 agent，主轮结束立即 done
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 1);
  // 新一轮：门控重置后主轮结束可再次 done（修复前 doneSent 跨轮保留，done 被短路）
  service.notifyMainTurnStart('s1');
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 2);
  // 同轮内重复信号不重发（每轮恰好一次语义不变）
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 2);
});

test('U-SA-008.2 notifyMainTurnStart 清残留兜底计时器：重置后超时不再发 done', () => {
  const { service, sink, clock } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.notifyMainTurnEnd('s1');
  assert.equal(clock.pendingCount, 1, '计数>0 应启动兜底计时');
  service.notifyMainTurnStart('s1'); // 新一轮：重置门控并清计时器
  assert.equal(clock.pendingCount, 0, '残留兜底计时器应被清空');
  clock.advance(30 * 60_000);
  assert.equal(sink.doneCount('s1'), 0, '上一轮残留计时器超时不得发 done');
});

test('U-SA-008.3 notifyMainTurnStart 移除上一轮未终态孤儿记录并发 subagent.removed，终态保留', () => {
  const { service, sink } = makeService();
  service.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  service.ingest('s1', { agentId: 'a2', agentType: 'T', description: 'd', status: 'completed', result: 'R', finishedAt: iso(1) });
  service.notifyMainTurnStart('s1');
  const removed = sink.all('subagent.removed');
  assert.equal(removed.length, 1);
  assert.deepEqual(removed[0].payload, { agentIds: ['a1'] });
  const list = service.queryList('s1');
  assert.ok(list.ok);
  if (list.ok) {
    assert.equal(list.data.length, 1, '终态记录应保留');
    assert.equal(list.data[0].agentId, 'a2');
  }
  // 孤儿清掉后新一轮门控计数从 0 起算：主轮结束立即 done
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 1);
});

test('U-SA-008.4 已销毁会话 notifyMainTurnStart 忽略（不重建门控）；重复调用幂等', () => {
  const { service, sink } = makeService();
  service.disposeSession('s1');
  service.notifyMainTurnStart('s1');
  service.notifyMainTurnEnd('s1');
  assert.equal(sink.doneCount('s1'), 0, '已销毁会话的门控信号应丢弃');

  // 未产生任何门控信号的会话上重复调用为无操作
  service.notifyMainTurnStart('s2');
  service.notifyMainTurnStart('s2');
  assert.equal(sink.doneCount('s2'), 0);
});
