/**
 * 子 Agent 注册表单元测试（wu-06-subagent-core）。
 *
 * 覆盖 docs/test/06_subagent/unit.md：
 * - U-SA-001 记录幂等合并（AC-SA-001/002）：顺序/乱序/重复事件收敛、终态不回退
 * - U-SA-002 终态语义（AC-SA-003）：failed/stopped 不误标 completed、活跃计数递减
 * - 列表展示排序与按会话归组（SA-F01）
 *
 * 运行方式：node --test（Node 24 原生 TS 类型剥离），不引入测试框架。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SubagentRegistry,
  isTerminalStatus,
} from '../../src/subagent/subagentService.ts';

/** 固定基准时间（毫秒） */
const BASE_MS = Date.parse('2026-08-28T10:00:00.000Z');

/** 基于基准时间的 ISO 时间戳辅助 */
const iso = (offsetMs: number): string => new Date(BASE_MS + offsetMs).toISOString();

/** 假时钟：时间可推进、计时器不真实等待 */
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

function makeRegistry(): { clock: FakeClock; registry: SubagentRegistry } {
  const clock = new FakeClock();
  return { clock, registry: new SubagentRegistry({ clock }) };
}

test('U-SA-001.1 顺序事件 created→started→completed 收敛为 completed 单条记录', () => {
  const { registry } = makeRegistry();
  registry.ingest('s1', {
    agentId: 'a1',
    agentType: 'general-purpose',
    description: '研究国产LLM定价',
    status: 'queued',
    startedAt: iso(0),
  });
  registry.ingest('s1', { agentId: 'a1', status: 'running' });
  registry.ingest('s1', {
    agentId: 'a1',
    status: 'completed',
    result: '结论全文',
    usage: { inputTokens: 1200, outputTokens: 3400 },
    finishedAt: iso(5),
  });
  const list = registry.list('s1');
  assert.equal(list.length, 1);
  const rec = list[0];
  assert.equal(rec.agentId, 'a1');
  assert.equal(rec.agentType, 'general-purpose');
  assert.equal(rec.description, '研究国产LLM定价');
  assert.equal(rec.status, 'completed');
  assert.equal(rec.startedAt, iso(0));
  assert.equal(rec.finishedAt, iso(5));
  assert.equal(rec.result, '结论全文');
  assert.deepEqual(rec.usage, { inputTokens: 1200, outputTokens: 3400 });
  assert.equal(rec.error, null);
});

test('U-SA-001.2 乱序：completed 先于 started 到达按最终状态收敛', () => {
  const { registry } = makeRegistry();
  // 终态事件先到，started 类事件迟到
  registry.ingest('s1', {
    agentId: 'a1',
    agentType: 'Explore',
    description: '扫描代码',
    status: 'completed',
    result: 'R',
    finishedAt: iso(3),
  });
  registry.ingest('s1', { agentId: 'a1', status: 'queued', startedAt: iso(0) });
  registry.ingest('s1', { agentId: 'a1', status: 'running' });
  const rec = registry.get('s1', 'a1');
  assert.ok(rec !== null);
  assert.equal(rec.status, 'completed'); // 不因缺 started 崩溃或丢记录，按最终状态收敛
  assert.equal(rec.result, 'R');
  assert.equal(rec.finishedAt, iso(3));
  assert.equal(registry.list('s1').length, 1); // 单条记录
  assert.equal(registry.activeCount('s1'), 0);
});

test('U-SA-001.3 重复 completed：无新增记录、终态字段不回退', () => {
  const { registry } = makeRegistry();
  registry.ingest('s1', {
    agentId: 'a1',
    agentType: 'T',
    description: 'D',
    status: 'completed',
    result: 'R1',
    finishedAt: iso(2),
  });
  const before = registry.get('s1', 'a1');
  assert.ok(before !== null);
  // 完全重复 + 缺字段重复两种变体
  registry.ingest('s1', { agentId: 'a1', status: 'completed', result: 'R1', finishedAt: iso(2) });
  registry.ingest('s1', { agentId: 'a1', status: 'completed' });
  const after = registry.get('s1', 'a1');
  assert.deepEqual(after, before); // finishedAt/result 一经设置不变
  assert.equal(registry.list('s1').length, 1); // 无新增记录
});

test('U-SA-001 负向：终态后再到 started 不回退为 running', () => {
  const { registry } = makeRegistry();
  registry.ingest('s1', {
    agentId: 'a1',
    agentType: 'T',
    description: 'D',
    status: 'completed',
    result: 'R',
    finishedAt: iso(2),
  });
  registry.ingest('s1', { agentId: 'a1', status: 'running' });
  registry.ingest('s1', { agentId: 'a1', status: 'queued' });
  const rec = registry.get('s1', 'a1');
  assert.ok(rec !== null);
  assert.equal(rec.status, 'completed');
  assert.equal(rec.result, 'R');
});

test('U-SA-001 负向：不同 agentId 事件互不污染', () => {
  const { registry } = makeRegistry();
  registry.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'one', status: 'running' });
  registry.ingest('s1', { agentId: 'a2', agentType: 'T', description: 'two', status: 'queued' });
  registry.ingest('s1', { agentId: 'a1', status: 'completed', result: 'r1', finishedAt: iso(1) });
  const a2 = registry.get('s1', 'a2');
  assert.ok(a2 !== null);
  assert.equal(a2.status, 'queued'); // 未知/其他 agentId 事件不污染既有记录
  assert.equal(a2.description, 'two');
  assert.equal(registry.get('s1', 'a1')?.status, 'completed');
  assert.equal(registry.list('s1').length, 2);
});

test('U-SA-001 边界：description/result 空串按缺失处理、后到非空值生效；usage 缺省不报错', () => {
  const { registry } = makeRegistry();
  registry.ingest('s1', { agentId: 'a1', agentType: 'T', description: '', status: 'queued' });
  const created = registry.get('s1', 'a1');
  assert.ok(created !== null);
  assert.equal(created.description, ''); // 空串按缺失建档
  assert.equal(created.usage, undefined); // usage 缺省不报错
  registry.ingest('s1', { agentId: 'a1', status: 'running', description: '真实描述' });
  assert.equal(registry.get('s1', 'a1')?.description, '真实描述'); // 后到非空值生效
  registry.ingest('s1', { agentId: 'a1', status: 'completed', result: '', finishedAt: iso(1) });
  const done = registry.get('s1', 'a1');
  assert.ok(done !== null);
  assert.equal(done.result, null); // result 空串按缺失 → null
});

test('U-SA-002 failed/stopped 终态语义：error 落位、不误标 completed、活跃计数递减', () => {
  const { registry } = makeRegistry();
  registry.ingest('s1', { agentId: 'a1', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  registry.ingest('s1', { agentId: 'a2', agentType: 'T', description: 'd', status: 'running', startedAt: iso(0) });
  assert.equal(registry.activeCount('s1'), 2); // 活跃计数 = queued+running

  registry.ingest('s1', { agentId: 'a1', status: 'failed', error: 'boom', finishedAt: iso(2) });
  const failed = registry.get('s1', 'a1');
  assert.ok(failed !== null);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'boom'); // error/reason 字段落位
  assert.equal(failed.result, null); // 失败记录不携带 result
  assert.equal(isTerminalStatus(failed.status), true); // isTerminal() 判定为真

  registry.ingest('s1', { agentId: 'a2', status: 'stopped', error: 'user', finishedAt: iso(3) });
  const stopped = registry.get('s1', 'a2');
  assert.ok(stopped !== null);
  assert.equal(stopped.status, 'stopped');
  assert.equal(stopped.error, 'user');
  assert.equal(isTerminalStatus(stopped.status), true);
  assert.equal(registry.activeCount('s1'), 0); // 活跃计数随之递减

  // 不误标 completed：终态后再到 completed 不改状态不带 result
  registry.ingest('s1', { agentId: 'a1', status: 'completed', result: 'late' });
  const stillFailed = registry.get('s1', 'a1');
  assert.ok(stillFailed !== null);
  assert.equal(stillFailed.status, 'failed');
  assert.equal(stillFailed.result, null);
});

test('列表排序：运行中在前、终态按 finishedAt 倒序', () => {
  const { registry } = makeRegistry();
  registry.ingest('s1', { agentId: 'done-early', agentType: 'T', description: 'd', status: 'completed', finishedAt: iso(1) });
  registry.ingest('s1', { agentId: 'running-1', agentType: 'T', description: 'd', status: 'running' });
  registry.ingest('s1', { agentId: 'done-late', agentType: 'T', description: 'd', status: 'completed', finishedAt: iso(5) });
  registry.ingest('s1', { agentId: 'failed-mid', agentType: 'T', description: 'd', status: 'failed', error: 'x', finishedAt: iso(3) });
  registry.ingest('s1', { agentId: 'queued-2', agentType: 'T', description: 'd', status: 'queued' });
  const ids = registry.list('s1').map((r) => r.agentId);
  assert.deepEqual(ids, ['running-1', 'queued-2', 'done-late', 'failed-mid', 'done-early']);
});

test('会话不存在/空返回空数组；活跃计数只统计 queued+running', () => {
  const { registry } = makeRegistry();
  assert.deepEqual(registry.list('no-session'), []);
  registry.ingest('s1', { agentId: 'q', agentType: 'T', description: 'd', status: 'queued' });
  registry.ingest('s1', { agentId: 'r', agentType: 'T', description: 'd', status: 'running' });
  registry.ingest('s1', { agentId: 'c', agentType: 'T', description: 'd', status: 'completed', finishedAt: iso(1) });
  assert.equal(registry.activeCount('s1'), 2);
  assert.deepEqual(
    registry.list('s1').map((r) => r.agentId),
    ['q', 'r', 'c'],
  );
  assert.equal(registry.activeCount('no-session'), 0);
});
