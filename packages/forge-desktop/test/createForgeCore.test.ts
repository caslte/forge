/**
 * createForgeCore 集成测试。
 *
 * 验证 forge-desktop 内核组装正确：组装 forge-core 5 个 service+api + mock pi adapter +
 * model mock + 统一事件汇，经 methodTable 跑通 project/session/conversation/tool/model
 * 全流程，且未知方法返回 404。这是 main.ts IPC 路由的纯 TS 契约基线。
 *
 * 使用 node:test + Node 22 --experimental-strip-types；真实文件系统用 fs.mkdtempSync
 * 临时目录并在 finally 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createForgeCore,
  generateSessionTitle,
  invoke,
} from '../src/createForgeCore.ts';
import { MockModelsFileAdapter, MockKeychainAdapter } from '../src/mock/modelAdapters.ts';
import type {
  PiAgentSessionFactory,
  PiAgentSessionFactoryOptions,
} from '../src/pi/piConversationAdapter.ts';

/** 等待 mock 异步回复（replyDelayMs 默认 300） */
function waitForReply(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 400));
}

/** 创建临时目录与项目子目录 */
function makeTempProject(): { root: string; storeFile: string; projectDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-core-int-'));
  const storeFile = path.join(root, 'forge-store.json');
  const projectDir = path.join(root, 'my-project');
  fs.mkdirSync(projectDir, { recursive: true });
  return { root, storeFile, projectDir };
}

/** mock 依赖：测试隔离，不读真实 pi models.json；信任端口用中立 fake（无资源、无决策） */
function mockDeps() {
  return {
    modelsFile: new MockModelsFileAdapter(),
    keychain: new MockKeychainAdapter(),
    trustStore: {
      hasTrustRequiringResources: () => false,
      getDecision: () => null,
      setDecision: () => undefined,
    },
  };
}

/** 预置 provider 的 mock 依赖：providerReady 真实检查（models 非空）通过 */
async function seededModelDeps(): Promise<Parameters<typeof mockDeps>[0] & { modelsFile: MockModelsFileAdapter }> {
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
  return { modelsFile, keychain: new MockKeychainAdapter(), trustStore: { hasTrustRequiringResources: () => false, getDecision: () => null, setDecision: () => undefined } };
}

interface FakeEvent {
  type: string;
  delta?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  /** compaction_start / compaction_end：触发原因（manual / threshold / overflow） */
  reason?: string;
  /** compaction_end：失败原因 */
  errorMessage?: string;
  /** compaction_end：是否被中止 */
  aborted?: boolean;
}

/** 模拟真实 pi 会话：prompt 时按 pi 事件流发出增量和最终助手消息 */
class FakePiSession {
  readonly listeners = new Set<(event: FakeEvent) => void>();
  promptCalls: string[] = [];
  promptError: Error | null = null;
  /** prompt 时附加发出的工具事件序列 */
  toolEvents: FakeEvent[] = [];
  /** message_end 后 prompt resolve 前的延迟（毫秒） */
  completionDelayMs = 0;
  /** P3-A：compact() 调用次数 */
  compactCalls = 0;
  /** P3-A：compact() 返回值（真实 pi CompactionResult 形态，无 message 字段） */
  compactResult: unknown = { summary: '手动摘要', tokensBefore: 60000, estimatedTokensAfter: 7000 };

  subscribe(listener: (event: FakeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    if (this.promptError !== null) {
      throw this.promptError;
    }
    for (const event of this.toolEvents) {
      for (const listener of this.listeners) listener(event);
    }
    for (const listener of this.listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } });
    }
    for (const listener of this.listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '，forge' } });
    }
    for (const listener of this.listeners) {
      listener({ type: 'message_end', message: { role: 'assistant', content: '你好，forge' } });
    }
    if (this.completionDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.completionDelayMs));
    }
  }

  async abort(): Promise<void> {}

  /** P3-A：手动压缩，返回真实 pi CompactionResult 形态 */
  async compact(): Promise<unknown> {
    this.compactCalls += 1;
    return this.compactResult;
  }

  /** 测试辅助：向订阅者广播任意事件（如 pi 自动触发的 compaction_end） */
  emit(event: FakeEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

function fakeSessionFactory(): PiAgentSessionFactory<FakePiSession> {
  return async () => {
    const session = new FakePiSession();
    return { session, dispose: () => undefined };
  };
}

test('createForgeCore 全流程：project → session → conversation → tool → model 可跑通', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const { methodTable, eventBus } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: fakeSessionFactory(),
    });

    // 监听 conversation.statusChanged / delta / message 事件
    const statusEvents: { sessionId: string; status: string }[] = [];
    eventBus.on('conversation.statusChanged', (p: unknown) => {
      const e = p as { sessionId: string; status: string };
      statusEvents.push(e);
    });
    const deltas: string[] = [];
    eventBus.on('conversation.delta', (p: unknown) => {
      const e = p as { sessionId: string; delta: { text: string } };
      deltas.push(e.delta.text);
    });
    const messages: { role: string; content: string }[] = [];
    eventBus.on('conversation.message', (p: unknown) => {
      const e = p as { sessionId: string; message: { role: string; content: string } };
      messages.push(e.message);
    });

    // project/addProject
    const addRes = await invoke(methodTable, 'project/addProject', { path: projectDir });
    assert.equal(addRes.code, 0, `addProject 应成功，message: ${addRes.message}`);

    // project/queryProjectList
    const listRes = await invoke(methodTable, 'project/queryProjectList', {});
    assert.equal(listRes.code, 0);
    const projects = (listRes.data as { projects: unknown[] }).projects;
    assert.equal(projects.length, 1, '应有 1 个项目');

    // session/createSession
    const createSess = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    assert.equal(createSess.code, 0, `createSession 应成功，message: ${createSess.message}`);
    const sessionId = (createSess.data as { session: { sessionId: string } }).session.sessionId;
    assert.ok(typeof sessionId === 'string' && sessionId.length > 0);

    // conversation/sendMessage
    const sendRes = await invoke(methodTable, 'conversation/sendMessage', {
      sessionId,
      content: '你好',
    });
    assert.equal(sendRes.code, 0, `sendMessage 应成功，message: ${sendRes.message}`);

    // 等待 mock 异步回复
    await waitForReply();

    // conversation/queryHistory 应有 user + assistant 两条
    const histRes = await invoke(methodTable, 'conversation/queryHistory', { sessionId });
    assert.equal(histRes.code, 0);
    const history = (histRes.data as { messages: { role: string; content: string }[] }).messages;
    assert.equal(history.length, 2, '应有 user + assistant 两条消息');
    assert.equal(history[0]?.role, 'user');
    assert.equal(history[0]?.content, '你好');
    assert.equal(history[1]?.role, 'assistant');
    assert.equal(history[1]?.content, '你好，forge');

    // conversation.statusChanged 事件应被触发（streaming + done）
    const statuses = statusEvents.map((e) => e.status);
    assert.ok(statuses.includes('streaming'), `应触发 streaming 事件，实际: ${statuses.join(',')}`);
    assert.ok(statuses.includes('done'), `应触发 done 事件，实际: ${statuses.join(',')}`);

    // pi 增量与最终助手消息应通过事件推送
    assert.equal(deltas.join(''), '你好，forge', `增量事件应为完整文本，实际: ${deltas.join('')}`);
    assert.deepEqual(
      messages.map((m) => ({ role: m.role, content: m.content })),
      [{ role: 'assistant', content: '你好，forge' }],
      '应推送一条 assistant 完整消息事件',
    );

    // tool/queryToolEvents（空列表）
    const toolRes = await invoke(methodTable, 'tool/queryToolEvents', { sessionId });
    assert.equal(toolRes.code, 0);
    const events = (toolRes.data as { events: unknown[] }).events;
    assert.equal(events.length, 0, 'mock 下工具事件应为空');

    // model/queryProviderList（seeded 态 1 个 provider）
    const modelRes = await invoke(methodTable, 'model/queryProviderList', {});
    assert.equal(modelRes.code, 0);
    const providers = (modelRes.data as { providers: unknown[] }).providers;
    assert.equal(providers.length, 1, 'seeded 下应有 1 个 provider');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('invoke 未知方法返回 404 信封', async () => {
  const { root, storeFile } = makeTempProject();
  try {
    const { methodTable } = createForgeCore(storeFile, mockDeps());
    const res = await invoke(methodTable, 'unknown/method', {});
    assert.equal(res.code, 404);
    assert.equal(res.data, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('sendMessage 将会话生效模型传入 pi runtime options', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const requested: PiAgentSessionFactoryOptions[] = [];
    const factory: PiAgentSessionFactory<{
      subscribe(): () => void;
      prompt(): Promise<void>;
      abort(): Promise<void>;
    }> = async (options) => {
      requested.push(options);
      return {
        session: {
          subscribe: () => () => undefined,
          prompt: async () => undefined,
          abort: async () => undefined,
        },
        dispose: () => undefined,
      };
    };
    const modelDeps = mockDeps();
    const core = createForgeCore(storeFile, { ...modelDeps, piAgentSessionFactory: factory });

    await invoke(core.methodTable, 'project/addProject', { path: projectDir });
    const created = await invoke(core.methodTable, 'session/createSession', { projectPath: projectDir });
    const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;
    await invoke(core.methodTable, 'model/saveProvider', {
      name: 'Test Provider',
      type: 'openai-completions',
      baseUrl: 'https://example.com/v1',
      apiKey: 'env:TEST_API_KEY',
      models: ['test-model'],
    });
    const providers = await invoke(core.methodTable, 'model/queryProviderList', {});
    assert.equal((providers.data as { providers: unknown[] }).providers.length, 1);
    const models = await invoke(core.methodTable, 'model/queryModels', {});
    assert.deepEqual((models.data as { models: string[] }).models, ['test-model']);
    await invoke(core.methodTable, 'model/setDefault', { model: 'test-model' });

    await invoke(core.methodTable, 'conversation/sendMessage', { sessionId, content: 'hello' });

    assert.equal(requested.length, 1);
    assert.equal(requested[0]?.sessionId, sessionId);
    assert.equal(requested[0]?.cwd, projectDir);
    assert.equal(requested[0]?.model, 'test-model');
    // MP-S05：未设置任何思考级别时兜底 'off'（thinking 内容默认关闭）
    assert.equal(requested[0]?.thinkingLevel, 'off');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('未注入工厂时默认使用真实 pi 对话适配器而不是 mock', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    // 空 agentDir 强制真实 pi 无凭据可用，隔离开发机 ~/.pi 配置
    const emptyAgentDir = path.join(root, '.pi-agent-empty');
    fs.mkdirSync(emptyAgentDir, { recursive: true });
    const core = createForgeCore(storeFile, { ...mockDeps(), piAgentDir: emptyAgentDir });

    await invoke(core.methodTable, 'project/addProject', { path: projectDir });
    const created = await invoke(core.methodTable, 'session/createSession', { projectPath: projectDir });
    const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;

    const result = await invoke(core.methodTable, 'conversation/sendMessage', { sessionId, content: 'hello' });

    assert.notEqual(result.code, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('凭据失败时状态置为 error 并发射 conversation.error', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const failingFactory: PiAgentSessionFactory<FakePiSession> = async () => {
      const session = new FakePiSession();
      session.promptError = new Error('No API key found for provider openai');
      return { session, dispose: () => undefined };
    };
    const { methodTable, eventBus } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: failingFactory,
    });

    const statusEvents: { sessionId: string; status: string }[] = [];
    eventBus.on('conversation.statusChanged', (p: unknown) => {
      statusEvents.push(p as { sessionId: string; status: string });
    });
    const errors: { sessionId: string; code: number; message: string }[] = [];
    eventBus.on('conversation.error', (p: unknown) => {
      errors.push(p as { sessionId: string; code: number; message: string });
    });

    await invoke(methodTable, 'project/addProject', { path: projectDir });
    const created = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;

    const sendRes = await invoke(methodTable, 'conversation/sendMessage', { sessionId, content: '你好' });
    assert.notEqual(sendRes.code, 0, '凭据失败时发送应返回错误信封');

    const statuses = statusEvents.map((e) => e.status);
    assert.ok(statuses.includes('error'), `应触发 error 状态事件，实际: ${statuses.join(',')}`);
    assert.equal(errors.length, 1, '应发射一次 conversation.error 事件');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('pi 工具事件映射为 tool.started/completed 并可查询', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const factory: PiAgentSessionFactory<FakePiSession> = async () => {
      const session = new FakePiSession();
      session.toolEvents = [
        { type: 'tool_execution_start', toolCallId: 'call-9', toolName: 'edit', args: { file_path: 'x.ts' } },
        {
          type: 'tool_execution_end',
          toolCallId: 'call-9',
          toolName: 'edit',
          result: { content: [{ type: 'text', text: 'done' }] },
          isError: false,
        },
      ];
      return { session, dispose: () => undefined };
    };
    const { methodTable, eventBus } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: factory,
    });

    const started: unknown[] = [];
    const completed: unknown[] = [];
    eventBus.on('tool.started', (p: unknown) => started.push(p));
    eventBus.on('tool.completed', (p: unknown) => completed.push(p));

    await invoke(methodTable, 'project/addProject', { path: projectDir });
    const created = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;

    await invoke(methodTable, 'conversation/sendMessage', { sessionId, content: '改文件' });

    assert.equal(started.length, 1, '应发射 tool.started');
    assert.equal(completed.length, 1, '应发射 tool.completed');

    const toolRes = await invoke(methodTable, 'tool/queryToolEvents', { sessionId });
    assert.equal(toolRes.code, 0);
    const events = (toolRes.data as { events: Array<{ status: string; toolEventId: string }> }).events;
    assert.equal(events.length, 1, '同一工具调用只保留一张卡片');
    assert.equal(events[0]?.toolEventId, 'call-9');
    assert.equal(events[0]?.status, 'completed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

/** 可手动控制完成时机的 pi 会话（用于并发交错验证） */
class DeferredPiSession {
  readonly listeners = new Set<(event: FakeEvent) => void>();
  promptCalls: string[] = [];
  private pending: (() => void) | null = null;

  subscribe(listener: (event: FakeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    return new Promise<void>((resolve) => {
      this.pending = resolve;
    });
  }

  /** 手动完成当前 prompt 并发出最终助手消息 */
  finish(content: string): void {
    for (const listener of this.listeners) {
      listener({ type: 'message_end', message: { role: 'assistant', content } });
    }
    this.pending?.();
    this.pending = null;
  }

  abortCalls = 0;

  abort(): Promise<void> {
    this.abortCalls += 1;
    return Promise.resolve();
  }
}

test('双会话并发发送：事件按 sessionId 隔离互不串扰', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const sessions = new Map<string, DeferredPiSession>();
    const factory: PiAgentSessionFactory<DeferredPiSession> = async (options) => {
      const session = new DeferredPiSession();
      sessions.set(options.sessionId ?? `auto-${sessions.size}`, session);
      return { session, dispose: () => undefined };
    };
    const { methodTable, eventBus } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: factory,
    });

    const deltasBySession = new Map<string, string[]>();
    eventBus.on('conversation.delta', (p: unknown) => {
      const e = p as { sessionId: string; delta: { text: string } };
      const list = deltasBySession.get(e.sessionId) ?? [];
      list.push(e.delta.text);
      deltasBySession.set(e.sessionId, list);
    });
    const messagesBySession = new Map<string, string[]>();
    eventBus.on('conversation.message', (p: unknown) => {
      const e = p as { sessionId: string; message: { content: string } };
      const list = messagesBySession.get(e.sessionId) ?? [];
      list.push(e.message.content);
      messagesBySession.set(e.sessionId, list);
    });

    await invoke(methodTable, 'project/addProject', { path: projectDir });
    const createdA = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const createdB = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sidA = (createdA.data as { session: { sessionId: string } }).session.sessionId;
    const sidB = (createdB.data as { session: { sessionId: string } }).session.sessionId;

    // 同时发起两个会话的发送，不互相阻塞
    const sendA = invoke(methodTable, 'conversation/sendMessage', { sessionId: sidA, content: 'A 的问题' });
    const sendB = invoke(methodTable, 'conversation/sendMessage', { sessionId: sidB, content: 'B 的问题' });

    // 等待发送链路完成工厂调用（resolveSendOptions 异步）
    for (let i = 0; i < 50 && sessions.size < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const sessionA = sessions.get(sidA);
    const sessionB = sessions.get(sidB);
    assert.ok(sessionA && sessionB, '两个会话都应创建各自的 pi 会话实例');
    assert.notEqual(sessionA, sessionB);

    // A 完成时 B 尚未完成
    sessionA.finish('A 的回答');
    await sendA;
    assert.deepEqual(deltasBySession.get(sidB) ?? [], [], 'A 完成前 B 不应收到任何增量');

    sessionB.finish('B 的回答');
    await sendB;

    assert.deepEqual(messagesBySession.get(sidA), ['A 的回答'], 'A 只收到自己的消息');
    assert.deepEqual(messagesBySession.get(sidB), ['B 的回答'], 'B 只收到自己的消息');

    const histA = await invoke(methodTable, 'conversation/queryHistory', { sessionId: sidA });
    const histB = await invoke(methodTable, 'conversation/queryHistory', { sessionId: sidB });
    const msgsA = (histA.data as { messages: Array<{ role: string; content: string }> }).messages;
    const msgsB = (histB.data as { messages: Array<{ role: string; content: string }> }).messages;
    assert.deepEqual(
      msgsA.map((m) => m.content),
      ['A 的问题', 'A 的回答'],
    );
    assert.deepEqual(
      msgsB.map((m) => m.content),
      ['B 的问题', 'B 的回答'],
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('中间助手消息完成不提前结束会话流式状态', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const session = new FakePiSession();
    session.completionDelayMs = 30;
    const { methodTable, eventBus } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: async () => ({ session, dispose: () => undefined }),
    });
    await invoke(methodTable, 'project/addProject', { path: projectDir });
    const created = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;

    const statuses: string[] = [];
    eventBus.on('conversation.statusChanged', (payload: unknown) => {
      statuses.push((payload as { status: string }).status);
    });

    const sending = invoke(methodTable, 'conversation/sendMessage', {
      sessionId,
      content: '先读文件，再回答',
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    assert.ok(statuses.at(-1) === 'streaming', `message_end 后应仍是 streaming，实际: ${statuses.join(',')}`);

    await sending;
    assert.equal(statuses.at(-1), 'done', '整轮 prompt 完成后才应变为 done');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// 回归：会话树状态圆点数据源（createForgeCore onStatusChange → sessionApi.setSessionStatus）
test('流式状态同步到 session 层：querySessionList 反映 running→done 且发射 session.statusChanged', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const sessions = new Map<string, DeferredPiSession>();
    const factory: PiAgentSessionFactory<DeferredPiSession> = async (options) => {
      const session = new DeferredPiSession();
      sessions.set(options.sessionId ?? `auto-${sessions.size}`, session);
      return { session, dispose: () => undefined };
    };
    const { methodTable, eventBus } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: factory,
    });
    await invoke(methodTable, 'project/addProject', { path: projectDir });
    const created = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;

    const sessionStatuses: string[] = [];
    eventBus.on('session.statusChanged', (p: unknown) => {
      sessionStatuses.push((p as { sessionId: string; status: string }).status);
    });

    const listStatus = async (): Promise<string> => {
      const res = await invoke(methodTable, 'session/querySessionList', { projectPath: projectDir });
      const list = (res.data as { sessions: Array<{ sessionId: string; status: string }> }).sessions;
      return list.find((s) => s.sessionId === sessionId)?.status ?? '(missing)';
    };

    // 发送后不 finish：流式进行中，会话应为 running（会话树黄色圆点数据源）
    const sending = invoke(methodTable, 'conversation/sendMessage', { sessionId, content: '分析中' });
    for (let i = 0; i < 50 && !sessions.has(sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.ok(sessions.has(sessionId), 'pi 会话应已创建');
    assert.equal(await listStatus(), 'running', '流式进行中 querySessionList 应为 running');
    assert.ok(sessionStatuses.includes('running'), '应发射 session.statusChanged(running)');

    // 完成后：会话应为 done（会话树绿色圆点数据源）
    sessions.get(sessionId)!.finish('完成回答');
    await sending;
    assert.equal(await listStatus(), 'done', '流式完成后 querySessionList 应为 done');
    assert.ok(sessionStatuses.includes('done'), '应发射 session.statusChanged(done)');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('createForgeCore 跨实例隔离：两个 store 文件互不干扰', async () => {
  const root1 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-iso1-'));
  const root2 = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-iso2-'));
  try {
    const store1 = path.join(root1, 's.json');
    const store2 = path.join(root2, 's.json');
    const proj1 = path.join(root1, 'p1');
    const proj2 = path.join(root2, 'p2');
    fs.mkdirSync(proj1, { recursive: true });
    fs.mkdirSync(proj2, { recursive: true });

    const a = createForgeCore(store1, mockDeps());
    const b = createForgeCore(store2, mockDeps());
    await invoke(a.methodTable, 'project/addProject', { path: proj1 });
    await invoke(b.methodTable, 'project/addProject', { path: proj2 });

    const la = await invoke(a.methodTable, 'project/queryProjectList', {});
    const lb = await invoke(b.methodTable, 'project/queryProjectList', {});
    const na = (la.data as { projects: unknown[] }).projects.length;
    const nb = (lb.data as { projects: unknown[] }).projects.length;
    assert.equal(na, 1, '实例 a 应只有自己的 1 个项目');
    assert.equal(nb, 1, '实例 b 应只有自己的 1 个项目');
  } finally {
    fs.rmSync(root1, { recursive: true, force: true });
    fs.rmSync(root2, { recursive: true, force: true });
  }
});

// ===== MP-S05 / MP-S06：ThinkLevelsPort 注入与会话思考级别生效 =====

test('ThinkLevelsPort 已注入：未知模型 getModelThinkingLevels 返回 1004（模型未配置）', async () => {
  const { root, storeFile } = makeTempProject();
  try {
    const { methodTable } = createForgeCore(storeFile, mockDeps());
    const res = await invoke(methodTable, 'model/getModelThinkingLevels', {
      model: 'definitely-not-a-real-forge-model-xyz',
    });
    // 端口已注入（不再是 5000「能力未配置」）；模型解析失败 -> 1004
    assert.equal(res.code, 1004, `应返回 1004，实际 code=${res.code} message=${res.message}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('resolveSendOptions 携带会话生效思考级别：session 覆盖优先，经适配器应用到会话', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const appliedLevels: string[] = [];
    const session = {
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      setThinkingLevel: async (level: string) => {
        appliedLevels.push(level);
      },
    };
    const factory: PiAgentSessionFactory<typeof session> = async () => ({
      session,
      dispose: () => undefined,
    });
    // seededModelDeps 提供非空模型，providerReady 通过，sendMessage 可走通
    const { methodTable } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: factory,
    });

    await invoke(methodTable, 'project/addProject', { path: projectDir });
    const created = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;

    // 未设置思考级别 -> 兜底 off 应用
    await invoke(methodTable, 'conversation/sendMessage', { sessionId, content: '第一轮' });
    assert.deepEqual(appliedLevels, ['off'], '未设置级别应兜底应用 off');

    // 会话级设置 high（同时同步全局默认）-> 同一会话下一轮按 high 生效
    const setRes = await invoke(methodTable, 'model/setSessionThinkingLevel', { sessionId, level: 'high' });
    assert.equal(setRes.code, 0, `setSessionThinkingLevel 应成功，message: ${setRes.message}`);
    await invoke(methodTable, 'conversation/sendMessage', { sessionId, content: '第二轮' });
    assert.deepEqual(appliedLevels, ['off', 'high'], '会话级别覆盖应生效为 high');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('MP-QA-G01 回归：运行中全局默认切到 high 后新建会话发送应应用 high（非启动快照 off）', async () => {
  const { root, storeFile, projectDir } = makeTempProject();
  try {
    const appliedLevels: string[] = [];
    const session = {
      subscribe: () => () => undefined,
      prompt: async () => undefined,
      abort: async () => undefined,
      setThinkingLevel: async (level: string) => {
        appliedLevels.push(level);
      },
    };
    const factory: PiAgentSessionFactory<typeof session> = async () => ({
      session,
      dispose: () => undefined,
    });
    // seededModelDeps 提供非空模型，providerReady 通过，sendMessage 可走通
    const { methodTable } = createForgeCore(storeFile, {
      ...(await seededModelDeps()),
      piAgentSessionFactory: factory,
    });

    await invoke(methodTable, 'project/addProject', { path: projectDir });
    const createdA = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sidA = (createdA.data as { session: { sessionId: string } }).session.sessionId;

    // 启动时全局默认缺失 -> 兜底 off（等价初始快照 off）
    await invoke(methodTable, 'conversation/sendMessage', { sessionId: sidA, content: '第一轮' });
    assert.deepEqual(appliedLevels, ['off'], '启动初始兜底应为 off');

    // 用户 setSessionThinkingLevel(high) 写当前会话并同步全局默认到 high
    const setRes = await invoke(methodTable, 'model/setSessionThinkingLevel', { sessionId: sidA, level: 'high' });
    assert.equal(setRes.code, 0, `setSessionThinkingLevel 应成功，message: ${setRes.message}`);
    assert.deepEqual(appliedLevels, ['off'], '同步全局默认不应触发新一轮发送');

    // 新建会话（无覆盖，继承全局默认）
    const createdB = await invoke(methodTable, 'session/createSession', { projectPath: projectDir });
    const sidB = (createdB.data as { session: { sessionId: string } }).session.sessionId;
    await invoke(methodTable, 'conversation/sendMessage', { sessionId: sidB, content: '第二轮' });

    // MP-QA-G01 修复前：启动快照会以初始 off 盖掉实时全局 high，新会话实际发送 off；
    // 修复后应每次实时读取全局，新会话应用 high（而非初始 off）。
    assert.deepEqual(appliedLevels, ['off', 'high'], '新会话应继承实时全局默认 high，而非启动快照 off');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== wu-06：子 agent done 门控接线（SA-F02）=====

/** 子 agent 门控测试用 fake 总线（扩展生命周期事件源） */
class GateTestBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();
  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }
}

interface GateFixture {
  root: string;
  sessionId: string;
  methodTable: ReturnType<typeof createForgeCore>['methodTable'];
  eventBus: import('node:events').EventEmitter;
  sessions: Map<string, DeferredPiSession>;
  buses: Map<string, GateTestBus>;
}

/** 带 fake 扩展事件总线的门控测试装配 */
async function makeGateFixture(deps: Partial<Parameters<typeof createForgeCore>[1]> = {}): Promise<GateFixture> {
  const { root, storeFile, projectDir } = makeTempProject();
  const sessions = new Map<string, DeferredPiSession>();
  const buses = new Map<string, GateTestBus>();
  const factory: PiAgentSessionFactory<DeferredPiSession> = async (options) => {
    const session = new DeferredPiSession();
    const bus = new GateTestBus();
    const sid = options.sessionId ?? `auto-${sessions.size}`;
    sessions.set(sid, session);
    buses.set(sid, bus);
    return { session, dispose: () => undefined, events: bus };
  };
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
  const core = createForgeCore(storeFile, {
    modelsFile,
    keychain: new MockKeychainAdapter(),
    trustStore: {
      hasTrustRequiringResources: () => false,
      getDecision: () => null,
      setDecision: () => undefined,
    },
    piAgentSessionFactory: factory,
    ...deps,
  });
  await invoke(core.methodTable, 'project/addProject', { path: projectDir });
  const created = await invoke(core.methodTable, 'session/createSession', { projectPath: projectDir });
  assert.equal(created.code, 0, `createSession 应成功: ${created.message}`);
  const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;
  return {
    root,
    sessionId,
    methodTable: core.methodTable,
    eventBus: core.eventBus,
    sessions,
    buses,
  };
}

test('子 agent 活跃时主轮结束 done 延迟，子 agent 完成后收敛且恰好一次', async () => {
  const fx = await makeGateFixture();
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );

    // 派生一个运行中子 agent（事件先于主轮结束到达）
    const sending = invoke(fx.methodTable, 'conversation/sendMessage', {
      sessionId: fx.sessionId,
      content: '研究一下',
    });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fx.buses.get(fx.sessionId)!.emit('subagents:created', { id: 'ag-1', type: 'general-purpose', description: '研究' });
    fx.buses.get(fx.sessionId)!.emit('subagents:started', { id: 'ag-1', type: 'general-purpose', description: '研究' });

    // 主轮结束：活跃计数=1 → done 延迟
    fx.sessions.get(fx.sessionId)!.finish('主轮回答');
    await sending;
    assert.ok(
      !statuses.some((e) => e.sessionId === fx.sessionId && e.status === 'done'),
      `活跃子 agent 存在时主轮结束不应立即 done，实际: ${JSON.stringify(statuses)}`,
    );

    // 子 agent 完成 → 计数归零 → done 收敛
    fx.buses
      .get(fx.sessionId)!
      .emit('subagents:completed', { id: 'ag-1', type: 'general-purpose', status: 'completed', result: '结论' });
    const doneEvents = statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done');
    assert.equal(doneEvents.length, 1, `done 应恰好发射一次，实际: ${JSON.stringify(statuses)}`);
    assert.ok(!statuses.some((e) => e.sessionId === fx.sessionId && e.status === 'error'));
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('无活跃子 agent 时主轮结束立即 done（与现状一致）', async () => {
  const fx = await makeGateFixture();
  try {
    // 同步等待工厂创建（sendMessage 本身在等待 prompt()，不能被 await）
    const sending = invoke(fx.methodTable, 'conversation/sendMessage', { sessionId: fx.sessionId, content: '普通问题' });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );
    fx.sessions.get(fx.sessionId)!.finish('普通回答');
    await sending;
    const doneEvents = statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done');
    assert.equal(doneEvents.length, 1, '无子 agent 时 done 语义与现状完全一致');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('活跃子 agent 超时兜底（注入小窗口）到期自动发 done 且恰好一次', async () => {
  const fx = await makeGateFixture({ subagentDoneTimeoutMs: 80 });
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );
    const sending = invoke(fx.methodTable, 'conversation/sendMessage', {
      sessionId: fx.sessionId,
      content: '长任务',
    });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fx.buses.get(fx.sessionId)!.emit('subagents:created', { id: 'ag-1', type: 'general-purpose', description: '长任务' });
    fx.buses.get(fx.sessionId)!.emit('subagents:started', { id: 'ag-1', type: 'general-purpose', description: '长任务' });
    fx.sessions.get(fx.sessionId)!.finish('主轮回答');
    await sending;

    // 兜底窗口内不发 done
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.ok(!statuses.some((e) => e.status === 'done'), '窗口内不应发 done');

    // 兜底到期自动放行（窗口内无任何子 agent 事件）
    await new Promise((resolve) => setTimeout(resolve, 300));
    const doneEvents = statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done');
    assert.equal(doneEvents.length, 1, `超时兜底应自动发 done 恰好一次，实际: ${JSON.stringify(statuses)}`);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('主轮看门狗：prompt 挂起（主轮结束信号丢失）且无活动时到期真中断 pi run 并置 canceled', async () => {
  const fx = await makeGateFixture({ subagentMainTurnTimeoutMs: 120 });
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );

    // prompt 永不 finish（模拟 pi 侧 run 生命周期竞态挂起）——notifyMainTurnEnd
    // 永远不会到达，done 门控的子 agent 兜底不会启动，只有看门狗能放行
    void invoke(fx.methodTable, 'conversation/sendMessage', {
      sessionId: fx.sessionId,
      content: '挂起',
    });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    // 窗口内不发 done
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.ok(!statuses.some((e) => e.status === 'done'), '看门狗窗口内不应发 done');

    // 窗口到期（布防起 120ms 无任何活动）真中断：abort pi run + 状态置 canceled
    await new Promise((resolve) => setTimeout(resolve, 400));
    const cancelEvents = statuses.filter(
      (e) => e.sessionId === fx.sessionId && e.status === 'canceled',
    );
    assert.equal(cancelEvents.length, 1, `看门狗应真中断恰好一次，实际: ${JSON.stringify(statuses)}`);
    assert.ok(
      fx.sessions.get(fx.sessionId)!.abortCalls >= 1,
      '看门狗必须真正 abort pi 侧 run（不得只改 forge 状态留下僵尸轮）',
    );

    // 迟到的主轮结束（prompt 最终返回）照常收敛 done（恰好一次，不重复）
    fx.sessions.get(fx.sessionId)!.finish('迟到回答');
    await new Promise((resolve) => setTimeout(resolve, 50));
    const doneAfter = statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done');
    assert.equal(doneAfter.length, 1, '迟到的主轮结束不得重复发 done');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('主轮看门狗：活动刷新窗口——窗口内持续有 delta 时不触发，静默后才放行', async () => {
  const fx = await makeGateFixture({ subagentMainTurnTimeoutMs: 200 });
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );
    void invoke(fx.methodTable, 'conversation/sendMessage', {
      sessionId: fx.sessionId,
      content: '长任务',
    });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const session = fx.sessions.get(fx.sessionId)!;

    // 布防后 300ms 内持续发 delta（每次刷新活动时间戳），期间不应触发看门狗
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      for (const listener of session.listeners) {
        listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '…' } });
      }
    }
    assert.ok(
      !statuses.some((e) => e.sessionId === fx.sessionId && e.status === 'done'),
      `持续活动期间看门狗不应触发，实际: ${JSON.stringify(statuses)}`,
    );

    // 静默超过窗口后真中断（abort + canceled）
    await new Promise((resolve) => setTimeout(resolve, 500));
    const cancelEvents = statuses.filter(
      (e) => e.sessionId === fx.sessionId && e.status === 'canceled',
    );
    assert.equal(cancelEvents.length, 1, '静默超窗后看门狗应真中断恰好一次');
    assert.ok(session.abortCalls >= 1, '静默超窗后必须真正 abort pi 侧 run');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ===== wu-06 回归：门控按轮重置（notifyMainTurnStart）=====

test('同一会话连续两轮：每轮主轮结束各发一次 done（门控按轮重置）', async () => {
  const fx = await makeGateFixture();
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );

    // 第一轮：streaming → done
    const send1 = invoke(fx.methodTable, 'conversation/sendMessage', { sessionId: fx.sessionId, content: '第一轮' });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fx.sessions.get(fx.sessionId)!.finish('第一轮回答');
    await send1;
    assert.equal(
      statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done').length,
      1,
      `第一轮应发 done，实际: ${JSON.stringify(statuses)}`,
    );

    // 第二轮（同一会话）：修复前 doneSent 跨轮保留，notifyMainTurnEnd 被短路，
    // done 永不发射，conversationService 状态永久卡在 streaming
    const send2 = invoke(fx.methodTable, 'conversation/sendMessage', { sessionId: fx.sessionId, content: '第二轮' });
    for (let i = 0; i < 100 && fx.sessions.get(fx.sessionId)!.promptCalls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fx.sessions.get(fx.sessionId)!.finish('第二轮回答');
    await send2;
    const doneCount = statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done').length;
    assert.equal(doneCount, 2, `第二轮应再发一次 done（共 2 次），实际: ${JSON.stringify(statuses)}`);
    // 第二轮状态链完整：进入过 streaming（done 缺席即卡「进行中」的回归形态）
    assert.ok(
      statuses.some((e) => e.sessionId === fx.sessionId && e.status === 'streaming'),
      '第二轮应进入 streaming',
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('第二轮子 agent 活跃：done 延迟至子 agent 完成后收敛（重置后的门控仍按判据工作）', async () => {
  const fx = await makeGateFixture();
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );

    // 第一轮：普通完成（建立上一轮 doneSent=true 的门控状态）
    const send1 = invoke(fx.methodTable, 'conversation/sendMessage', { sessionId: fx.sessionId, content: '第一轮' });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fx.sessions.get(fx.sessionId)!.finish('第一轮回答');
    await send1;
    assert.equal(statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done').length, 1);

    // 第二轮：主轮结束时有活跃子 agent → done 延迟；子 agent 完成 → 收敛
    const send2 = invoke(fx.methodTable, 'conversation/sendMessage', { sessionId: fx.sessionId, content: '第二轮' });
    for (let i = 0; i < 100 && fx.sessions.get(fx.sessionId)!.promptCalls.length < 2; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    fx.buses.get(fx.sessionId)!.emit('subagents:created', { id: 'ag-2', type: 'general-purpose', description: '研究' });
    fx.buses.get(fx.sessionId)!.emit('subagents:started', { id: 'ag-2', type: 'general-purpose', description: '研究' });
    fx.sessions.get(fx.sessionId)!.finish('第二轮回答');
    await send2;
    assert.equal(
      statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done').length,
      1,
      `子 agent 活跃时第二轮不应立即 done（此时仅第一轮的 done），实际: ${JSON.stringify(statuses)}`,
    );
    fx.buses
      .get(fx.sessionId)!
      .emit('subagents:completed', { id: 'ag-2', type: 'general-purpose', status: 'completed', result: '结论' });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(
      statuses.filter((e) => e.sessionId === fx.sessionId && e.status === 'done').length,
      2,
      `两轮各发一次 done，实际: ${JSON.stringify(statuses)}`,
    );
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

// ===== 上下文压缩（P3-A）=====

interface CompactFixture {
  root: string;
  sessionId: string;
  methodTable: ReturnType<typeof createForgeCore>['methodTable'];
  eventBus: import('node:events').EventEmitter;
  session: FakePiSession;
}

/** 压缩测试装配：建项目+会话并跑完一轮对话，返回可手动 emit 事件的 fake 会话 */
async function makeCompactFixture(): Promise<CompactFixture> {
  const { root, storeFile, projectDir } = makeTempProject();
  const session = new FakePiSession();
  const factory: PiAgentSessionFactory<FakePiSession> = async () => ({
    session,
    dispose: () => undefined,
  });
  const core = createForgeCore(storeFile, {
    ...(await seededModelDeps()),
    piAgentSessionFactory: factory,
  });
  await invoke(core.methodTable, 'project/addProject', { path: projectDir });
  const created = await invoke(core.methodTable, 'session/createSession', { projectPath: projectDir });
  const sessionId = (created.data as { session: { sessionId: string } }).session.sessionId;
  await invoke(core.methodTable, 'conversation/sendMessage', { sessionId, content: '你好' });
  await waitForReply(); // 等助手回复完成，会话处于可压缩状态
  return { root, sessionId, methodTable: core.methodTable, eventBus: core.eventBus, session };
}

test('自动压缩完成时 eventBus 发射 conversation.compacted（UI 可感知自动压缩）', async () => {
  const fx = await makeCompactFixture();
  try {
    const compacted: unknown[] = [];
    fx.eventBus.on('conversation.compacted', (p: unknown) => compacted.push(p));

    // 模拟 pi 运行时按阈值触发的自动压缩
    fx.session.emit({
      type: 'compaction_end',
      reason: 'threshold',
      result: { summary: '自动压缩摘要', tokensBefore: 88000, estimatedTokensAfter: 9000 },
      aborted: false,
    });

    assert.equal(compacted.length, 1, '自动压缩应发射一次 conversation.compacted');
    assert.deepEqual(compacted[0], {
      sessionId: fx.sessionId,
      reason: 'auto',
      tokensBefore: 88000,
      tokensAfter: 9000,
      summary: '自动压缩摘要',
    });
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('自动压缩失败时 eventBus 发射 conversation.error，不静默', async () => {
  const fx = await makeCompactFixture();
  try {
    const errors: { sessionId: string; code: number; message: string }[] = [];
    fx.eventBus.on('conversation.error', (p: unknown) => {
      errors.push(p as { sessionId: string; code: number; message: string });
    });
    const compacted: unknown[] = [];
    fx.eventBus.on('conversation.compacted', (p: unknown) => compacted.push(p));

    fx.session.emit({
      type: 'compaction_end',
      reason: 'overflow',
      result: undefined,
      aborted: false,
      errorMessage: 'Auto-compaction failed: provider timeout',
    });

    assert.deepEqual(compacted, [], '失败不应发射 compressed');
    assert.equal(errors.length, 1, '自动压缩失败必须上报，不能静默');
    assert.equal(errors[0]!.sessionId, fx.sessionId);
    assert.match(errors[0]!.message, /Auto-compaction failed/);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('conversation/compact 返回压缩详情（tokensBefore/tokensAfter/summary）', async () => {
  const fx = await makeCompactFixture();
  try {
    const res = await invoke(fx.methodTable, 'conversation/compact', { sessionId: fx.sessionId });

    assert.equal(res.code, 0, `compact 应成功，message: ${res.message}`);
    assert.equal(fx.session.compactCalls, 1, '应委托 pi 会话 compact');
    const result = (res.data as { result: { ok: boolean; tokensBefore: number | null; tokensAfter: number | null; summary: string | null } }).result;
    assert.equal(result.ok, true);
    assert.equal(result.tokensBefore, 60000, '压缩前 token 应透传到 UI');
    assert.equal(result.tokensAfter, 7000, '压缩后 token 应透传到 UI');
    assert.equal(result.summary, '手动摘要');
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('conversation/compact 会话不存在返回 1002，不抛异常', async () => {
  const fx = await makeCompactFixture();
  try {
    const res = await invoke(fx.methodTable, 'conversation/compact', { sessionId: 'sess-not-exist' });
    assert.equal(res.code, 1002);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});



// ===== 自动重试状态同步（可重试错误如 network_error：pi 内部自动重试，轮次未终止）=====

/** 向 fake 会话的订阅者广播原始 pi 事件（DeferredPiSession.listeners 为公开只读集合） */
function emitRaw(session: DeferredPiSession, event: Record<string, unknown>): void {
  for (const listener of session.listeners) {
    listener(event as never);
  }
}

test('自动重试恢复：可重试错误后 auto_retry_start 恢复 streaming，轮次正常 done', async () => {
  const fx = await makeGateFixture();
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );
    const sending = invoke(fx.methodTable, 'conversation/sendMessage', {
      sessionId: fx.sessionId,
      content: '研究一下',
    });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const session = fx.sessions.get(fx.sessionId)!;

    // ① 中途可重试错误（pi 真实形态：message_end + stopReason=error）→ error 状态
    emitRaw(session, {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Provider finish_reason: network_error' },
    });
    // ② pi 决定自动重试 → 状态应恢复 streaming
    emitRaw(session, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'Provider finish_reason: network_error' });
    // ③ 重试成功，轮次正常结束
    session.finish('恢复后的回答');
    await sending;

    const seq = statuses.filter((e) => e.sessionId === fx.sessionId).map((e) => e.status);
    assert.ok(seq.includes('error'), `错误状态应出现，实际: ${JSON.stringify(seq)}`);
    assert.ok(
      seq.indexOf('streaming', seq.indexOf('error') + 1) > -1,
      `error 后应恢复 streaming（红点回进行中），实际: ${JSON.stringify(seq)}`,
    );
    const doneEvents = seq.filter((s) => s === 'done');
    assert.equal(doneEvents.length, 1, `恢复的轮次应正常 done 恰好一次（不被 errorEmittedThisTurn 短路），实际: ${JSON.stringify(seq)}`);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('自动重试耗尽：auto_retry_end(success=false) 后进入终态 error，不卡 streaming', async () => {
  const fx = await makeGateFixture();
  try {
    const statuses: Array<{ sessionId: string; status: string }> = [];
    fx.eventBus.on('conversation.statusChanged', (p: unknown) =>
      statuses.push(p as { sessionId: string; status: string }),
    );
    const sending = invoke(fx.methodTable, 'conversation/sendMessage', {
      sessionId: fx.sessionId,
      content: '长任务',
    });
    for (let i = 0; i < 100 && !fx.sessions.has(fx.sessionId); i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const session = fx.sessions.get(fx.sessionId)!;

    // ① 错误 → ② 重试启动（状态恢复 streaming）→ ③ 重试耗尽 → 轮次以错误终止
    emitRaw(session, {
      type: 'message_end',
      message: { role: 'assistant', content: [], stopReason: 'error', errorMessage: 'Provider finish_reason: network_error' },
    });
    emitRaw(session, { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: 'Provider finish_reason: network_error' });
    emitRaw(session, { type: 'auto_retry_end', success: false, attempt: 1, finalError: 'Provider finish_reason: network_error' });
    session.finish(''); // 无正文：仅结束 prompt（错误轮次不产生助手消息）
    await sending;

    const seq = statuses.filter((e) => e.sessionId === fx.sessionId).map((e) => e.status);
    assert.equal(seq[seq.length - 1], 'error', `重试耗尽应终态 error（不能卡 streaming），实际: ${JSON.stringify(seq)}`);
    assert.ok(!seq.includes('done'), `错误轮次不应发 done，实际: ${JSON.stringify(seq)}`);
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true });
  }
});

test('generateSessionTitle：附件路径行的消息取首行生成标题', () => {
  // 统一给路径后路径行随正文换行追加，标题只取首行
  assert.equal(generateSessionTitle('解释一下\nC:\\repo\\a.ts'), '解释一下');
  assert.equal(generateSessionTitle('看看\nC:\\Users\\x\\AppData\\Local\\Temp\\forge-paste-143025.png'), '看看');
  // 纯路径消息（无正文）：用路径本身
  assert.equal(generateSessionTitle('C:\\repo\\a.ts'), 'C:\\repo\\a.ts');
  // 无附件消息行为不变
  assert.equal(generateSessionTitle('第一句。第二句'), '第一句');
});
