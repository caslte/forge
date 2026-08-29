/**
 * 子 agent 方法接线测试（wu-06-subagent-desktop，A-SA-001~006 + 接线断言）。
 *
 * 验证 createForgeCore 组装的 subagent/queryList|stop|clearFinished 方法信封与
 * 错误码（1001/1002/5000）、subagent.updated/removed 事件桥接、conversation/cancelStream
 * 级联终止、done 门控接线、会话删除清理与扩展缺失静默降级。
 *
 * mock 手法与 createForgeCore.test.ts 对齐：fake pi 会话 + fake 事件总线（模拟
 * pi-subagents 扩展在 pi.events 上的生命周期事件与 cross-extension-rpc stop 回复）。
 * 使用 node:test（Node 24 type stripping）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createForgeCore, invoke, type ForgeCoreBundle } from '../src/createForgeCore.ts';
import { MockModelsFileAdapter, MockKeychainAdapter } from '../src/mock/modelAdapters.ts';
import type {
  SubagentInfo,
  SubagentRemovedPayload,
  SubagentUpdatedPayload,
} from '../src/ipc-contract.ts';
import type { PiAgentSessionFactory } from '../src/pi/piConversationAdapter.ts';

let requestCounter = 0;

/** fake pi 事件总线：记录发射 + 按 channel 多路订阅 + 测试钩子模拟扩展 stop 回复 */
class FakeSubagentBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  readonly emitted: Array<{ channel: string; data: unknown }> = [];
  /** 测试钩子：收到 stop 请求时同步回复（模拟扩展 RPC handler） */
  onStopRequest: ((requestId: string, agentId: string) => void) | null = null;

  emit(channel: string, data: unknown): void {
    this.emitted.push({ channel, data });
    if (channel === 'subagents:rpc:stop' && this.onStopRequest !== null) {
      const payload = data as { requestId: string; agentId: string };
      this.onStopRequest(payload.requestId, payload.agentId);
    }
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => {
      set.delete(handler);
    };
  }

  /** 发射过的 stop 请求（cross-extension-rpc 请求载荷） */
  stopRequests(): Array<{ requestId: string; agentId: string }> {
    return this.emitted
      .filter((e) => e.channel === 'subagents:rpc:stop')
      .map((e) => e.data as { requestId: string; agentId: string });
  }

  /** 模拟扩展对 stop 请求的回复信封 */
  replyStop(requestId: string, reply: { success: boolean; error?: string }): void {
    this.emit(`subagents:rpc:stop:reply:${requestId}`, reply);
  }
}

/** 可手动控制完成时机的 fake pi 会话（abort 语义与真实 pi 一致：中止主轮并 resolve prompt） */
class FakeSubagentSession {
  readonly listeners = new Set<(event: unknown) => void>();
  promptCalls: string[] = [];
  abortCalls = 0;
  private pending: (() => void) | null = null;

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    return new Promise<void>((resolve) => {
      this.pending = resolve;
    });
  }

  /** 手动完成主轮（发出最终助手消息并 resolve prompt） */
  finish(content = '主轮回答'): void {
    for (const listener of this.listeners) {
      listener({ type: 'message_end', message: { role: 'assistant', content } });
    }
    this.pending?.();
    this.pending = null;
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
    this.pending?.();
    this.pending = null;
  }
}

interface SubagentFakeFactory {
  factory: PiAgentSessionFactory<FakeSubagentSession>;
  sessions: Map<string, FakeSubagentSession>;
  buses: Map<string, FakeSubagentBus>;
  /** plain 模式：不暴露 events/stopSubagent（扩展缺失静默降级路径） */
  plain?: boolean;
}

/** fake 工厂：每会话独立总线 + 按 cross-extension-rpc 协议实现的 stop 通道 */
function subagentFakeFactory(options: { plain?: boolean } = {}): SubagentFakeFactory {
  const sessions = new Map<string, FakeSubagentSession>();
  const buses = new Map<string, FakeSubagentBus>();
  const factory: PiAgentSessionFactory<FakeSubagentSession> = async (factoryOptions) => {
    const sessionId = factoryOptions.sessionId ?? `auto-${sessions.size}`;
    const session = new FakeSubagentSession();
    const bus = new FakeSubagentBus();
    sessions.set(sessionId, session);
    buses.set(sessionId, bus);
    if (options.plain === true) {
      return { session, dispose: () => undefined };
    }
    return {
      session,
      dispose: () => undefined,
      events: bus,
      handle: {
        stopSubagent: async (agentId: string) => {
          const requestId = `req-${(requestCounter += 1)}`;
          await new Promise<void>((resolve, reject) => {
            const off = bus.on(`subagents:rpc:stop:reply:${requestId}`, (raw) => {
              off();
              const reply = raw as { success?: boolean; error?: string };
              if (reply !== null && typeof reply === 'object' && reply.success === true) {
                resolve();
              } else {
                reject(new Error(reply?.error ?? '终止失败'));
              }
            });
            bus.emit('subagents:rpc:stop', { requestId, agentId });
          });
        },
      },
    };
  };
  return { factory, sessions, buses, plain: options.plain };
}

/** 等待条件成立（默认最多 1s） */
async function waitFor(condition: () => boolean, ms = 1000): Promise<void> {
  for (let i = 0; i < Math.ceil(ms / 5); i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

interface SubagentTestContext {
  root: string;
  core: ForgeCoreBundle;
  sessionId: string;
  session: FakeSubagentSession;
  bus: FakeSubagentBus;
  sessions: Map<string, FakeSubagentSession>;
  buses: Map<string, FakeSubagentBus>;
  updated: SubagentUpdatedPayload[];
  removed: SubagentRemovedPayload[];
  statusEvents: Array<{ sessionId: string; status: string }>;
}

/** 组装内核 + 项目 + 会话（seeded 模型使 providerReady 通过） */
async function setupSubagentCore(
  deps: Partial<Parameters<typeof createForgeCore>[1]> = {},
  factoryOptions: { plain?: boolean } = {},
): Promise<SubagentTestContext> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-subagent-'));
  const storeFile = path.join(root, 'forge-store.json');
  const projectDir = path.join(root, 'my-project');
  fs.mkdirSync(projectDir, { recursive: true });
  const modelsFile = new MockModelsFileAdapter();
  await modelsFile.writeProviders([
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o-mini'],
      lastError: null,
    },
  ]);
  const fake = subagentFakeFactory(factoryOptions);
  const core = createForgeCore(storeFile, {
    modelsFile,
    keychain: new MockKeychainAdapter(),
    trustStore: {
      hasTrustRequiringResources: () => false,
      getDecision: () => null,
      setDecision: () => undefined,
    },
    piAgentSessionFactory: fake.factory,
    ...deps,
  });
  const addRes = await invoke(core.methodTable, 'project/addProject', { path: projectDir });
  assert.equal(addRes.code, 0, `addProject 应成功: ${addRes.message}`);
  const created = await invoke(core.methodTable, 'session/createSession', { projectPath: projectDir });
  assert.equal(created.code, 0, `createSession 应成功: ${created.message}`);
  const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;

  const updated: SubagentUpdatedPayload[] = [];
  const removed: SubagentRemovedPayload[] = [];
  const statusEvents: Array<{ sessionId: string; status: string }> = [];
  core.eventBus.on('subagent.updated', (p: unknown) => updated.push(p as SubagentUpdatedPayload));
  core.eventBus.on('subagent.removed', (p: unknown) => removed.push(p as SubagentRemovedPayload));
  core.eventBus.on('conversation.statusChanged', (p: unknown) =>
    statusEvents.push(p as { sessionId: string; status: string }),
  );
  return {
    root,
    core,
    sessionId,
    // 懒加载：factory 回调在 sendMessage 异步路径中触发，建立会话后才能拿到 lease/session/bus。
    // 在 setup 阶段（factory 未调用时）这些是 undefined，使用时已同步为非空（参见 startPendingSend
    // 的 waitFor）。getter 语义下在测试使用 ctx.bus.emit() 时总线必然已存在。
    get session() {
      return fake.sessions.get(sessionId)!;
    },
    get bus() {
      return fake.buses.get(sessionId)!;
    },
    sessions: fake.sessions,
    buses: fake.buses,
    updated,
    removed,
    statusEvents,
  };
}

async function cleanup(ctx: SubagentTestContext): Promise<void> {
  // wu-06：逐个删除 buses map 中所有会话，清理子 agent 门控计时器（默认 30 分钟 setTimeout
  // 会泄漏阻塞进程退出）。A-SA-001 等多会话测试还会创建会话 B，未清理会产生计时器泄漏。
  // deleteSession 幂等；副作用 dispose 计时器 + 事件退订是清理路径唯一作用。
  for (const sid of ctx.buses.keys()) {
    try {
      await invoke(ctx.core.methodTable, 'session/deleteSession', { sessionId: sid });
    } catch {
      // 清理路径不需错误冒泡
    }
  }
  fs.rmSync(ctx.root, { recursive: true, force: true });
}

/** 启动一次未完成的 sendMessage（工厂已创建 lease，prompt 挂起）。
 *  返回的是仍在进行中的 sending promise，调用方不能 `await startPendingSend(...)`（那会
 *  等到 sendMessage 结束，而结束时所需 finish() 在用例末尾，形成自锁死循环），
 *  应 `const sending = startPendingSend(ctx)` 拿到句柄，在用例末尾 `await sending` 收尾。
 *  调用方在测试中途访问 ctx.bus / ctx.session 前需 `await waitFor(() => ctx.buses.has(sessionId))`
 *  同步等待工厂回调（因为 sendMessage 本身在等待 prompt() 解决，不能被 await）。 */
function startPendingSend(
  ctx: SubagentTestContext,
  sessionId = ctx.sessionId,
): Promise<{ code: number; message: string; data: unknown }> {
  void waitFor(() => ctx.sessions.has(sessionId));
  return invoke(ctx.core.methodTable, 'conversation/sendMessage', {
    sessionId,
    content: '派生子 agent 帮我研究',
  });
}

async function queryList(ctx: SubagentTestContext, sessionId = ctx.sessionId): Promise<SubagentInfo[]> {
  const res = await invoke(ctx.core.methodTable, 'subagent/queryList', { sessionId });
  assert.equal(res.code, 0, `queryList 应成功: ${res.message}`);
  return (res.data as { subagents: SubagentInfo[] }).subagents;
}

test('A-SA-001: 子 agent 事件按会话归组并映射为 queryList 记录与 updated 事件', async () => {
  const ctx = await setupSubagentCore();
  try {
    const sending = startPendingSend(ctx);
    assert.ok(sending, 'sendMessage 应已启动');
    await waitFor(() => ctx.buses.has(ctx.sessionId));

    // 扩展生命周期事件（pi-subagents 在 pi.events 上的真实载荷形状）
    ctx.bus.emit('subagents:created', { id: 'ag-1', type: 'general-purpose', description: '研究定价' });
    ctx.bus.emit('subagents:started', { id: 'ag-1', type: 'general-purpose', description: '研究定价' });

    const running = await queryList(ctx);
    assert.equal(running.length, 1, '应有一条运行中记录');
    assert.equal(running[0]?.agentId, 'ag-1');
    assert.equal(running[0]?.status, 'running');
    assert.equal(running[0]?.agentType, 'general-purpose');
    assert.equal(running[0]?.description, '研究定价');
    assert.equal(running[0]?.finishedAt, null);

    // subagent.updated 事件桥接到 forge 事件总线（携带 sessionId + 完整记录）
    assert.ok(
      ctx.updated.some(
        (u) => u.sessionId === ctx.sessionId && u.subagent.agentId === 'ag-1' && u.subagent.status === 'running',
      ),
      `应推送 running 记录事件，实际: ${JSON.stringify(ctx.updated)}`,
    );

    // 完成：result 全文 + Token 用量（AC-SA-014）
    ctx.bus.emit('subagents:completed', {
      id: 'ag-1',
      type: 'general-purpose',
      description: '研究定价',
      status: 'completed',
      result: '定价结论全文',
      tokens: { input: 1200, output: 3400, total: 4600 },
    });
    const done = await queryList(ctx);
    assert.equal(done.length, 1);
    assert.equal(done[0]?.status, 'completed');
    assert.equal(done[0]?.result, '定价结论全文');
    assert.deepEqual(done[0]?.usage, { inputTokens: 1200, outputTokens: 3400 });

    // 多会话归组隔离：会话 B 的事件不串扰会话 A
    const createdB = await invoke(ctx.core.methodTable, 'session/createSession', {
      projectPath: path.join(ctx.root, 'my-project'),
    });
    const sidB = (createdB.data as { session: { sessionId: string } }).session.sessionId;
    const sendingB = invoke(ctx.core.methodTable, 'conversation/sendMessage', {
      sessionId: sidB,
      content: 'B 的问题',
    });
    await waitFor(() => ctx.sessions.has(sidB));
    ctx.buses.get(sidB)!.emit('subagents:created', { id: 'ag-1', type: 'Explore', description: 'B 的探查' });
    ctx.buses.get(sidB)!.emit('subagents:started', { id: 'ag-1', type: 'Explore', description: 'B 的探查' });

    const listA = await queryList(ctx);
    assert.equal(listA.length, 1);
    assert.equal(listA[0]?.status, 'completed', '会话 A 的 ag-1 不受会话 B 事件影响');
    const listB = await queryList(ctx, sidB);
    assert.equal(listB.length, 1);
    assert.equal(listB[0]?.status, 'running', '会话 B 的 ag-1 独立登记');
    assert.equal(listB[0]?.agentType, 'Explore');

    ctx.session.finish();
    await sending;
    ctx.sessions.get(sidB)!.finish();
    await sendingB;
  } finally {
    await cleanup(ctx);
  }
});

test('A-SA-002: 失败与终止事件不误标已完成（failed/stopped 语义）', async () => {
  const ctx = await setupSubagentCore();
  try {
    const sending = startPendingSend(ctx);

    await waitFor(() => ctx.buses.has(ctx.sessionId));
    ctx.bus.emit('subagents:created', { id: 'ag-e', type: 'general-purpose', description: '会失败的' });
    ctx.bus.emit('subagents:started', { id: 'ag-e', type: 'general-purpose', description: '会失败的' });
    ctx.bus.emit('subagents:failed', {
      id: 'ag-e',
      type: 'general-purpose',
      description: '会失败的',
      status: 'error',
      error: '模型超时',
    });

    ctx.bus.emit('subagents:created', { id: 'ag-s', type: 'Explore', description: '会被终止的' });
    ctx.bus.emit('subagents:started', { id: 'ag-s', type: 'Explore', description: '会被终止的' });
    ctx.bus.emit('subagents:failed', {
      id: 'ag-s',
      type: 'Explore',
      description: '会被终止的',
      status: 'stopped',
      error: '已被用户终止',
    });

    const list = await queryList(ctx);
    const failed = list.find((s) => s.agentId === 'ag-e');
    const stopped = list.find((s) => s.agentId === 'ag-s');
    assert.equal(failed?.status, 'failed', 'error 状态应映射为 failed');
    assert.equal(failed?.error, '模型超时');
    assert.equal(failed?.result, null, '失败记录不应有 result');
    assert.equal(stopped?.status, 'stopped', 'stopped 状态应保持 stopped（不误标 failed/completed）');
    assert.equal(stopped?.error, '已被用户终止');

    // 终态不可逆：迟到的事件不得把终态记录改写
    ctx.bus.emit('subagents:failed', { id: 'ag-s', type: 'Explore', status: 'aborted', error: '迟到' });
    const after = await queryList(ctx);
    assert.equal(after.find((s) => s.agentId === 'ag-s')?.status, 'stopped');

    ctx.session.finish();
    await sending;
  } finally {
    await cleanup(ctx);
  }
});

test('A-SA-003: 停止按钮级联终止（cancelStream → 主轮 abort + 全部活跃子 agent stopped → done）', async () => {
  const ctx = await setupSubagentCore();
  try {
    const sending = startPendingSend(ctx);
    await waitFor(() => ctx.buses.has(ctx.sessionId));
    for (const agentId of ['ag-1', 'ag-2']) {
      ctx.bus.emit('subagents:created', { id: agentId, type: 'general-purpose', description: `任务 ${agentId}` });
      ctx.bus.emit('subagents:started', { id: agentId, type: 'general-purpose', description: `任务 ${agentId}` });
    }
    // 扩展对 stop 请求回复成功
    ctx.bus.onStopRequest = (requestId) => ctx.bus.replyStop(requestId, { success: true });

    const cancelRes = await invoke(ctx.core.methodTable, 'conversation/cancelStream', { sessionId: ctx.sessionId });
    assert.equal(cancelRes.code, 0, `cancelStream 应成功: ${cancelRes.message}`);
    await sending; // abort 已 resolve prompt

    // 主轮 abort + 每个活跃子 agent 各一次 stop RPC
    assert.equal(ctx.session.abortCalls, 1, '主轮应被 abort');
    const requested = ctx.bus.stopRequests().map((r) => r.agentId).sort();
    assert.deepEqual(requested, ['ag-1', 'ag-2'], '应级联终止全部活跃子 agent');

    const list = await queryList(ctx);
    assert.deepEqual(
      list.map((s) => s.status).sort(),
      ['stopped', 'stopped'],
      '两个子 agent 均应转 stopped',
    );

    const statuses = ctx.statusEvents.filter((e) => e.sessionId === ctx.sessionId).map((e) => e.status);
    assert.ok(statuses.includes('canceled'), `应发射 canceled，实际: ${statuses.join(',')}`);
    assert.equal(statuses.filter((s) => s === 'done').length, 1, 'done 应恰好发射一次');
    assert.equal(statuses.at(-1), 'done', '级联终止后主会话应转 done');

    // 重复取消幂等：不产生新 stop 请求、不报错
    const before = ctx.bus.stopRequests().length;
    const repeat = await invoke(ctx.core.methodTable, 'conversation/cancelStream', { sessionId: ctx.sessionId });
    assert.equal(repeat.code, 0);
    assert.equal(ctx.bus.stopRequests().length, before, '重复取消不应产生新 stop 请求');
  } finally {
    await cleanup(ctx);
  }
});

test('A-SA-003: 单个终止只影响目标（subagent/stop），重复终止幂等，未知返回 1002', async () => {
  const ctx = await setupSubagentCore();
  try {
    const sending = startPendingSend(ctx);
    await waitFor(() => ctx.buses.has(ctx.sessionId));
    for (const agentId of ['ag-1', 'ag-2']) {
      ctx.bus.emit('subagents:created', { id: agentId, type: 'general-purpose', description: agentId });
      ctx.bus.emit('subagents:started', { id: agentId, type: 'general-purpose', description: agentId });
    }
    ctx.bus.onStopRequest = (requestId) => ctx.bus.replyStop(requestId, { success: true });

    // 终止 ag-1：只有 ag-1 的 stop 请求
    const stopRes = await invoke(ctx.core.methodTable, 'subagent/stop', {
      sessionId: ctx.sessionId,
      agentId: 'ag-1',
    });
    assert.equal(stopRes.code, 0, `stop 应成功: ${stopRes.message}`);
    assert.deepEqual(ctx.bus.stopRequests().map((r) => r.agentId), ['ag-1']);

    let list = await queryList(ctx);
    assert.equal(list.find((s) => s.agentId === 'ag-1')?.status, 'stopped', '目标应转 stopped');
    assert.equal(list.find((s) => s.agentId === 'ag-2')?.status, 'running', '其他子 agent 不受影响');

    // 重复终止已终态：幂等成功且不发新请求
    const before = ctx.bus.stopRequests().length;
    const repeat = await invoke(ctx.core.methodTable, 'subagent/stop', {
      sessionId: ctx.sessionId,
      agentId: 'ag-1',
    });
    assert.equal(repeat.code, 0, '重复终止应幂等成功');
    assert.equal(ctx.bus.stopRequests().length, before, '幂等终止不应产生新 stop 请求');

    // 未知 agentId → 1002
    const missing = await invoke(ctx.core.methodTable, 'subagent/stop', {
      sessionId: ctx.sessionId,
      agentId: 'ghost',
    });
    assert.equal(missing.code, 1002, `未知子 agent 应返回 1002，实际: ${missing.code}`);

    // 参数缺失 → 1001
    const bad = await invoke(ctx.core.methodTable, 'subagent/stop', { sessionId: ctx.sessionId });
    assert.equal(bad.code, 1001);

    ctx.session.finish();
    await sending;
  } finally {
    await cleanup(ctx);
  }
});

test('A-SA-003: stop RPC 失败重试恰一次后映射 5000，记录保留原状态', async () => {
  const ctx = await setupSubagentCore();
  try {
    const sending = startPendingSend(ctx);
    await waitFor(() => ctx.buses.has(ctx.sessionId));
    ctx.bus.emit('subagents:created', { id: 'ag-1', type: 'general-purpose', description: '任务' });
    ctx.bus.emit('subagents:started', { id: 'ag-1', type: 'general-purpose', description: '任务' });
    ctx.bus.onStopRequest = (requestId) =>
      ctx.bus.replyStop(requestId, { success: false, error: 'Agent is not running' });

    const stopRes = await invoke(ctx.core.methodTable, 'subagent/stop', {
      sessionId: ctx.sessionId,
      agentId: 'ag-1',
    });
    assert.equal(stopRes.code, 5000, `终止失败应返回 5000，实际: ${stopRes.code} ${stopRes.message}`);
    assert.equal(ctx.bus.stopRequests().length, 2, '失败应重试恰一次（共 2 次请求）');
    const list = await queryList(ctx);
    assert.equal(list.find((s) => s.agentId === 'ag-1')?.status, 'running', '失败后记录保留原状态可重试');

    ctx.session.finish();
    await sending;
  } finally {
    await cleanup(ctx);
  }
});

test('A-SA-004: clearFinished 批量移除终态 Tab 记录，运行中保留并发射 removed 事件', async () => {
  const ctx = await setupSubagentCore();
  try {
    const sending = startPendingSend(ctx);
    await waitFor(() => ctx.buses.has(ctx.sessionId));
    ctx.bus.emit('subagents:created', { id: 'ag-done', type: 'general-purpose', description: '已完成' });
    ctx.bus.emit('subagents:started', { id: 'ag-done', type: 'general-purpose', description: '已完成' });
    ctx.bus.emit('subagents:completed', { id: 'ag-done', type: 'general-purpose', status: 'completed', result: 'ok' });
    ctx.bus.emit('subagents:created', { id: 'ag-run', type: 'Explore', description: '运行中' });
    ctx.bus.emit('subagents:started', { id: 'ag-run', type: 'Explore', description: '运行中' });

    const res = await invoke(ctx.core.methodTable, 'subagent/clearFinished', { sessionId: ctx.sessionId });
    assert.equal(res.code, 0, `clearFinished 应成功: ${res.message}`);
    assert.deepEqual((res.data as { removed: string[] }).removed, ['ag-done'], '应移除终态记录');

    const list = await queryList(ctx);
    assert.deepEqual(list.map((s) => s.agentId), ['ag-run'], '运行中记录应保留');

    assert.equal(ctx.removed.length, 1, '应发射一次 subagent.removed');
    assert.equal(ctx.removed[0]?.sessionId, ctx.sessionId);
    assert.deepEqual(ctx.removed[0]?.agentIds, ['ag-done']);

    // 无终态时重复清除：removed 空且不重复发射事件
    const repeat = await invoke(ctx.core.methodTable, 'subagent/clearFinished', { sessionId: ctx.sessionId });
    assert.equal(repeat.code, 0);
    assert.deepEqual((repeat.data as { removed: string[] }).removed, []);
    assert.equal(ctx.removed.length, 1, '无变化不应重复发射 removed');

    ctx.session.finish();
    await sending;
  } finally {
    await cleanup(ctx);
  }
});

test('A-SA-005: 删除会话清空子 agent 内存态、退订事件且延迟 done 兜底被清理', async () => {
  // 注入小超时窗口：若删除路径未清理等待器/门控计时器，done 会在窗口后泄漏发射
  const ctx = await setupSubagentCore({ subagentDoneTimeoutMs: 150 });
  try {
    const sending = startPendingSend(ctx);
    await waitFor(() => ctx.buses.has(ctx.sessionId));
    ctx.bus.emit('subagents:created', { id: 'ag-1', type: 'general-purpose', description: '任务' });
    ctx.bus.emit('subagents:started', { id: 'ag-1', type: 'general-purpose', description: '任务' });

    // 主轮结束但仍活跃 → done 延迟（等待器已武装）
    ctx.session.finish();
    await sending;
    assert.equal(ctx.statusEvents.filter((e) => e.status === 'done').length, 0, '活跃期不应发 done');

    const delRes = await invoke(ctx.core.methodTable, 'session/deleteSession', { sessionId: ctx.sessionId });
    assert.equal(delRes.code, 0, `deleteSession 应成功: ${delRes.message}`);

    // 内存态清空 + 事件退订
    const list = await queryList(ctx);
    assert.equal(list.length, 0, '删除会话后子 agent 内存态应清空');
    const updatedBefore = ctx.updated.length;
    ctx.bus.emit('subagents:completed', { id: 'ag-1', type: 'general-purpose', status: 'completed', result: '迟到' });
    assert.equal(ctx.updated.length, updatedBefore, '删除后事件总线监听应已退订');

    // 兜底窗口过后不泄漏 done（计时器已清理）
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(
      ctx.statusEvents.filter((e) => e.status === 'done').length,
      0,
      '删除会话后不应有延迟 done 泄漏',
    );
  } finally {
    await cleanup(ctx);
  }
});

test('A-SA-006: 扩展缺失（无事件源/停止通道）静默降级：空列表、stop 1002、无报错', async () => {
  const ctx = await setupSubagentCore({}, { plain: true });
  try {
    const sending = startPendingSend(ctx);
    await waitFor(() => ctx.buses.has(ctx.sessionId));
    ctx.session.finish();
    await sending;

    const list = await queryList(ctx);
    assert.equal(list.length, 0, '扩展缺失时 queryList 应为空列表');

    const stopRes = await invoke(ctx.core.methodTable, 'subagent/stop', {
      sessionId: ctx.sessionId,
      agentId: 'ag-1',
    });
    assert.equal(stopRes.code, 1002, `扩展缺失时 stop 应返回 1002，实际: ${stopRes.code}`);

    const clearRes = await invoke(ctx.core.methodTable, 'subagent/clearFinished', { sessionId: ctx.sessionId });
    assert.equal(clearRes.code, 0);
    assert.deepEqual((clearRes.data as { removed: string[] }).removed, []);

    assert.equal(ctx.updated.length, 0, '扩展缺失不应产生 subagent.updated 事件');
    const statuses = ctx.statusEvents.filter((e) => e.sessionId === ctx.sessionId).map((e) => e.status);
    assert.equal(statuses.at(-1), 'done', '无子 agent 时停止/收尾行为与现状一致');
  } finally {
    await cleanup(ctx);
  }
});
