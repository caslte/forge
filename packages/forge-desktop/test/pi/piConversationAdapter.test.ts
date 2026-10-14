import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PiConversationAdapter,
  type PiAgentSessionFactory,
} from '../../src/pi/piConversationAdapter.ts';

type Listener = (event: { type: string; delta?: string }) => void;

interface MinimalEvent {
  type: string;
  delta?: string;
  assistantMessageEvent?: { type?: string; delta?: string };
  message?: {
    role?: string;
    content?: string | Array<{ type?: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
  };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  /** compaction_start / compaction_end：触发原因（manual / threshold / overflow） */
  reason?: string;
  /** compaction_end：失败原因（成功时缺省） */
  errorMessage?: string;
  /** compaction_end：是否被中止 */
  aborted?: boolean;
}

/** 工具事件捕获器（P1-A 映射验证） */
interface ToolCapture {
  started: Array<{ toolEventId: string; name: string; input: unknown }>;
  completed: Array<{ toolEventId: string; text: string | null; details: unknown }>;
  errors: Array<{ toolEventId: string; message: string }>;
}

function captureToolHandlers(adapter: PiConversationAdapter): ToolCapture {
  const cap: ToolCapture = { started: [], completed: [], errors: [] };
  adapter.setEventHandlers({
    onToolStarted: (_sid, e) => cap.started.push({ toolEventId: e.toolEventId, name: e.tool.name, input: e.tool.input }),
    onToolCompleted: (_sid, e) => cap.completed.push({ toolEventId: e.toolEventId, text: e.result.text, details: e.result.details }),
    onToolError: (_sid, e) => cap.errors.push({ toolEventId: e.toolEventId, message: e.error.message }),
  });
  return cap;
}

class FakePiSession {
  readonly listeners = new Set<(event: MinimalEvent) => void>();
  promptCalls: string[] = [];
  /** P3-B：图片附件参数记录（prompt 第二参 images） */
  imageCalls: unknown[] = [];
  abortCalls = 0;
  disposed = false;
  promptError: Error | null = null;
  /** setModel 热切换调用记录（P1-C） */
  setModelCalls: unknown[] = [];
  /** setThinkingLevel 调用记录（默认思考级别应用） */
  setThinkingLevelCalls: string[] = [];
  /** P3-A 压缩：compact() 调次数 */
  compactCalls = 0;
  /** P3-A 压缩：compact() 返回值（pi CompactionResult 形态，无 message 字段） */
  compactResult: { summary: string; tokensBefore: number; estimatedTokensAfter: number } | null = null;
  /** P3-A 压缩：compact() 抛出的错误（非空时优先抛出） */
  compactError: Error | null = null;

  subscribe(listener: (event: MinimalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string, images?: unknown): Promise<void> {
    this.promptCalls.push(text);
    if (images) this.imageCalls.push(images);
    if (this.promptError !== null) {
      for (const listener of this.listeners) listener({
        type: 'message_end',
        message: { role: 'assistant', content: 'partial', stopReason: 'error', errorMessage: this.promptError.message },
      });
      throw this.promptError;
    }
    const assistant = { role: 'assistant', content: '' };
    for (const listener of this.listeners) listener({ type: 'message_start', message: assistant });
    for (const listener of this.listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '你好' } });
    }
    for (const listener of this.listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '，forge' } });
    }
    // thinking_delta 不应进入正文（真实 pi 会发）
    for (const listener of this.listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'thinking_delta', delta: '思考中' } });
    }
    for (const listener of this.listeners) listener({
      type: 'message_end',
      // 真实 pi AssistantMessage.content 为内容块数组
      message: { role: 'assistant', content: [{ type: 'text', text: '你好，forge' }] },
    });
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
  }

  async setModel(model: unknown): Promise<void> {
    this.setModelCalls.push(model);
  }

  /** 思考级别调用记录（默认 off 策略） */
  async setThinkingLevel(level: string): Promise<void> {
    this.setThinkingLevelCalls.push(level);
  }

  /** P3-A 手动压缩：返回真实 pi 的 CompactionResult 形态（不含 message 字段） */
  async compact(): Promise<unknown> {
    this.compactCalls += 1;
    if (this.compactError !== null) throw this.compactError;
    return this.compactResult;
  }

  /** 测试辅助：向订阅者广播任意事件 */
  emit(event: MinimalEvent): void {
    for (const listener of this.listeners) listener(event);
  }

  dispose(): void {
    this.disposed = true;
  }
}

test('发送消息时映射 pi 文本增量和最终助手消息', async () => {
  const fake = new FakePiSession();
  const factory: PiAgentSessionFactory<FakePiSession> = async (options) => {
    assert.equal(options.cwd, 'D:/project');
    return { session: fake, dispose: () => fake.dispose() };
  };
  const adapter = new PiConversationAdapter(factory);

  const deltas: string[] = [];
  let finalText = '';
  adapter.onDelta('session-1', (text) => deltas.push(text));
  adapter.onMessage('session-1', (message) => {
    if (message.role === 'assistant') finalText = message.content;
  });

  await adapter.sendMessage('session-1', '你好', { cwd: 'D:/project' });

  assert.deepEqual(deltas, ['你好', '，forge']);
  assert.equal(finalText, '你好，forge');
});

test('发送消息前应用默认思考级别 off（thinking 内容默认关闭，幂等不重复设）', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));

  await adapter.sendMessage('session-tl', 'hello');

  // 缺省 defaultThinkingLevel='off'：首次创建会话时应用一次
  assert.deepEqual(fake.setThinkingLevelCalls, ['off']);
  // 同一级别再次发送：与已应用级别相同，不再重复 setThinkingLevel（幂等）
  await adapter.sendMessage('session-tl', 'world');
  assert.deepEqual(fake.setThinkingLevelCalls, ['off']);
});

test('可注入自定义默认思考级别', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose() }),
    { defaultThinkingLevel: 'medium' },
  );

  await adapter.sendMessage('session-tl2', 'hello');

  assert.deepEqual(fake.setThinkingLevelCalls, ['medium']);
});

test('sendMessage options.thinkingLevel 与当前已应用级别不同时调用 setThinkingLevel', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));

  // 首次创建会话应用默认 off
  await adapter.sendMessage('session-tl-diff', 'hello');
  assert.deepEqual(fake.setThinkingLevelCalls, ['off']);

  // 发送时指定不同级别 -> 对已有 lease 调用 setThinkingLevel
  await adapter.sendMessage('session-tl-diff', '切到 high', { thinkingLevel: 'high' });
  assert.deepEqual(fake.setThinkingLevelCalls, ['off', 'high']);

  // 同级重复发送 -> 不再设置（幂等）
  await adapter.sendMessage('session-tl-diff', '仍是 high', { thinkingLevel: 'high' });
  assert.deepEqual(fake.setThinkingLevelCalls, ['off', 'high']);

  // 再切回不同级别 -> 再次设置
  await adapter.sendMessage('session-tl-diff', '切回 off', { thinkingLevel: 'off' });
  assert.deepEqual(fake.setThinkingLevelCalls, ['off', 'high', 'off']);
});

test('会话不支持 setThinkingLevel 时忽略不报错', async () => {
  const session: {
    subscribe: (listener: (event: unknown) => void) => () => void;
    prompt: (text: string) => Promise<void>;
    abort: () => Promise<void>;
  } = {
    subscribe: () => () => undefined,
    prompt: async () => undefined,
    abort: async () => undefined,
  };
  const adapter = new PiConversationAdapter(async () => ({ session, dispose: () => undefined }));

  // 尽管指定了 thinkingLevel，但 lease 无 setThinkingLevel 能力，应静默忽略不抛错
  await adapter.sendMessage('session-no-tl', 'hello', { thinkingLevel: 'high' });
});

test('assistant 消息文本中的 thinking/reasoning 包裹块被剥离（兜底展示过滤）', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));

  const messages: string[] = [];
  adapter.onMessage('session-strip', (m) => messages.push(m.content));

  // 先 sendMessage 建立订阅，再广播含思考包裹块的 message_end
  await adapter.sendMessage('session-strip', 'hello');
  fake.emit({
    type: 'message_end',
    message: {
      role: 'assistant',
      content: '答案在前<thinking>这是思考过程不应展示</thinking>，结论在后',
    },
  });

  assert.deepEqual(messages, ['你好，forge', '答案在前，结论在后']);
});

test('流式阶段剥离 MiniMax 混流思考正文（增量清洗，思考期不出字）', async () => {
  // 专用静默 fake：prompt 不发任何增量，由测试自行驱动 text_delta
  const listeners = new Set<(event: MinimalEvent) => void>();
  const silentFake = {
    subscribe(listener: (event: MinimalEvent) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async prompt(): Promise<void> {},
    async abort(): Promise<void> {},
    dispose(): void {},
    async setThinkingLevel(): Promise<void> {},
  };
  const adapter = new PiConversationAdapter(async () => ({ session: silentFake, dispose: () => silentFake.dispose() }));

  const deltas: string[] = [];
  adapter.onDelta('session-live', (t) => deltas.push(t));

  await adapter.sendMessage('session-live', 'hi'); // 建立订阅
  const emit = (delta: string) => {
    for (const listener of listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta } });
    }
  };
  emit(' thinkingThe');
  emit(' user');
  emit(' response');
  emit('\n\n你好！');

  // 思考期不输出任何增量（'助手正在思考'占位可见），收尾标记后一次性补发正式回答
  assert.deepEqual(deltas, ['你好！']);
});

test('assistant 最终消息剥离 MiniMax 混流思考正文', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));

  const messages: string[] = [];
  adapter.onMessage('session-final', (m) => messages.push(m.content));

  await adapter.sendMessage('session-final', 'hi');
  fake.emit({
    type: 'message_end',
    message: { role: 'assistant', content: ' thinking为了把话说清楚，先梳理一遍。 response\n\n最终回答' },
  });

  assert.equal(messages[messages.length - 1], '最终回答');
});

test('取消时停止当前 pi 会话并保留已生成文本', async () => {
  const fake = new FakePiSession();
  const factory: PiAgentSessionFactory<FakePiSession> = async () => ({ session: fake, dispose: () => fake.dispose() });
  const adapter = new PiConversationAdapter(factory);
  await adapter.sendMessage('session-2', '开始', {});

  await adapter.cancelStream('session-2');

  assert.equal(fake.abortCalls, 1);
  assert.equal(adapter.getPartialContent('session-2'), '你好，forge');
});

test('发送异常时映射 error 并保留增量文本', async () => {
  const fake = new FakePiSession();
  fake.promptError = new Error('No API key found for the selected model');
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));

  const errors: Array<{ message: string; partialText: string }> = [];
  adapter.onError?.('session-error', (error) => {
    errors.push({ message: error.message, partialText: adapter.getPartialContent('session-error') });
  });

  await assert.rejects(
    adapter.sendMessage('session-error', 'hello'),
    /模型凭据未配置/,
  );

  assert.equal(errors.length, 1);
  assert.equal(
    errors[0]?.message,
    '模型凭据未配置（No API key found for the selected model）：请在设置中为对应模型填写并保存 API Key 后重试',
  );
  assert.equal(errors[0]?.partialText, 'partial');
});

test('发送完成后无 session 文件时回退内存历史（user + assistant）', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  await adapter.sendMessage('session-3', '你好', {});

  const history = await adapter.loadHistory('session-3');

  assert.equal(history.length, 2);
  assert.equal(history[0]?.role, 'user');
  assert.equal(history[0]?.content, '你好');
  assert.equal(history[1]?.role, 'assistant');
  assert.equal(history[1]?.content, '你好，forge');
});

/** 可挂起 prompt 的会话：模拟流式进行中（轮次未结束）的切回场景 */
class HeldPromptSession {
  readonly listeners = new Set<(event: MinimalEvent) => void>();
  /** 释放挂起的 prompt（轮次结束） */
  release!: () => void;

  subscribe(listener: (event: MinimalEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.release = resolve;
    });
  }

  async abort(): Promise<void> {}

  dispose(): void {}

  /** 测试辅助：向订阅者广播任意事件 */
  emit(event: MinimalEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}

test('流式进行中 loadHistory 追加未完成助手消息（切回会话不截断，内存路径）', async () => {
  const fake = new HeldPromptSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  const send = adapter.sendMessage('session-live', '讲个故事', {});
  // 让 sendMessage 完成 lease 创建与事件订阅（首个 await 后同步执行到 prompt 挂起）
  await new Promise((resolve) => setImmediate(resolve));
  // 轮次进行中：增量已到达，message_end 未到
  fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '从前' } });
  fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '有座山' } });

  // 此时切回会话：历史末尾应带上进行中的助手消息，后续 delta 才有正确的追加基点
  const mid = await adapter.loadHistory('session-live');
  assert.equal(mid.length, 2);
  assert.equal(mid[0]?.role, 'user');
  assert.equal(mid[0]?.content, '讲个故事');
  assert.equal(mid[1]?.role, 'assistant');
  assert.equal(mid[1]?.content, '从前有座山');

  // 轮次正常结束后：最终消息已在历史中，进行中快照不得重复出现
  fake.emit({
    type: 'message_end',
    message: { role: 'assistant', content: [{ type: 'text', text: '从前有座山，山里有庙。' }] },
  });
  fake.release();
  await send;

  const done = await adapter.loadHistory('session-live');
  assert.equal(done.length, 2, '结束后不重复追加进行中快照');
  assert.equal(done[done.length - 1]?.content, '从前有座山，山里有庙。');
});

test('流式进行中 loadHistory 追加未完成助手消息（切回会话不截断，磁盘 JSONL 路径）', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'forge-live-'));
  const file = pathMod.join(tmp, 'session-live-file.jsonl');
  const header = { type: 'session', version: 3, id: 'forge-session-live-file', timestamp: '2026-01-01T00:00:00.000Z', cwd: tmp };
  const entry1 = { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: '历史一' } };
  fsMod.writeFileSync(file, [header, entry1].map((x) => JSON.stringify(x)).join('\n'), 'utf8');

  try {
    const fake = new HeldPromptSession();
    const adapter = new PiConversationAdapter(async () => ({
      session: fake,
      dispose: () => fake.dispose(),
      handle: { sessionFile: file },
    }));
    const send = adapter.sendMessage('session-live-file', '继续', {});
    await new Promise((resolve) => setImmediate(resolve));
    fake.emit({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: '正在生成' } });

    // pi 仅在 message_end 时落盘 assistant 消息；切回时磁盘历史不含进行中消息，
    // loadHistory 必须补上未完成快照，否则后续 delta 追加丢失基点（切回后内容截断）
    const mid = await adapter.loadHistory('session-live-file');
    assert.equal(mid.length, 2);
    assert.equal(mid[0]?.role, 'user');
    assert.equal(mid[0]?.content, '历史一');
    assert.equal(mid[1]?.role, 'assistant');
    assert.equal(mid[1]?.content, '正在生成');

    fake.emit({
      type: 'message_end',
      message: { role: 'assistant', content: [{ type: 'text', text: '正在生成完毕' }] },
    });
    fake.release();
    await send;
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('工具开始与成功结束映射为 started/completed 回调', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  const cap = captureToolHandlers(adapter);

  await adapter.sendMessage('session-tool', '读一下', {});
  fake.emit({ type: 'tool_execution_start', toolCallId: 'call-1', toolName: 'read', args: { path: 'a.ts' } });
  fake.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-1',
    toolName: 'read',
    result: { content: [{ type: 'text', text: '文件内容' }] },
    isError: false,
  });

  assert.deepEqual(cap.started, [
    { toolEventId: 'call-1', name: 'read', input: { path: 'a.ts' } },
  ]);
  assert.deepEqual(cap.completed, [{ toolEventId: 'call-1', text: '文件内容', details: undefined }]);
  assert.equal(cap.errors.length, 0);
});

test('工具失败结束映射为 error 回调并提取错误文本', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  const cap = captureToolHandlers(adapter);

  await adapter.sendMessage('session-tool-err', '改一下', {});
  fake.emit({ type: 'tool_execution_start', toolCallId: 'call-2', toolName: 'edit', args: { file_path: 'b.ts' } });
  fake.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-2',
    toolName: 'edit',
    result: { content: [{ type: 'text', text: 'old_string not found' }] },
    isError: true,
  });

  assert.equal(cap.completed.length, 0);
  assert.deepEqual(cap.errors, [
    { toolEventId: 'call-2', message: 'old_string not found' },
  ]);
});

test('同一会话两次发送复用同一 pi 会话实例', async () => {
  const fake = new FakePiSession();
  let factoryCalls = 0;
  const adapter = new PiConversationAdapter(async () => {
    factoryCalls += 1;
    return { session: fake, dispose: () => fake.dispose() };
  });

  await adapter.sendMessage('session-reuse', '第一轮', {});
  await adapter.sendMessage('session-reuse', '第二轮', {});

  assert.equal(factoryCalls, 1, '工厂只应被调用一次');
  assert.deepEqual(fake.promptCalls, ['第一轮', '第二轮'], '两次 prompt 都落在同一会话实例');
});

// ===== TE-S05: tool_execution_end result.details 透传 =====

test('TE-S05: pi 工具 result.details 透传到 onToolCompleted.result.details（todo 工具场景）', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  const cap = captureToolHandlers(adapter);

  await adapter.sendMessage('session-todo', '列todo', {});
  fake.emit({ type: 'tool_execution_start', toolCallId: 'call-todo', toolName: 'todo', args: { action: 'list' } });
  fake.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-todo',
    toolName: 'todo',
    result: {
      content: [{ type: 'text', text: '[ ] #1: 修复\n[x] #2: 完成' }],
      details: {
        action: 'list',
        tasks: [
          { id: 1, subject: '修复', status: 'pending' },
          { id: 2, subject: '完成', status: 'completed' },
        ],
        nextId: 3,
      },
    },
    isError: false,
  });

  assert.equal(cap.completed.length, 1);
  const completed = cap.completed[0];
  assert.equal(completed?.toolEventId, 'call-todo');
  assert.equal(completed?.text, '[ ] #1: 修复\n[x] #2: 完成');
  assert.deepEqual(completed?.details, {
    action: 'list',
    tasks: [
      { id: 1, subject: '修复', status: 'pending' },
      { id: 2, subject: '完成', status: 'completed' },
    ],
    nextId: 3,
  });
});

test('TE-S05: pi 工具 result 无 details → onToolCompleted.result.details 为 undefined（序列化后字段不出现）', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  const cap = captureToolHandlers(adapter);

  await adapter.sendMessage('session-read', '读一下', {});
  fake.emit({ type: 'tool_execution_start', toolCallId: 'call-read', toolName: 'read', args: { path: 'a.ts' } });
  fake.emit({
    type: 'tool_execution_end',
    toolCallId: 'call-read',
    toolName: 'read',
    result: { content: [{ type: 'text', text: 'file contents' }] },
    isError: false,
  });

  const completed = cap.completed[0];
  assert.equal(completed?.toolEventId, 'call-read');
  assert.equal(completed?.text, 'file contents');
  // 序列化后 details 字段不应出现
  const serialized = JSON.parse(JSON.stringify(completed));
  assert.equal('details' in serialized, false, 'details 未提供时序列化结果不出现该字段');
});

test('TE-S05: pi 工具 result.details 为非对象（string/number）原样透传不抛错', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  const cap = captureToolHandlers(adapter);

  for (const badDetails of ['plain string', 42, null, [1, 2], { any: 'object' }]) {
    await adapter.sendMessage(`session-bad-${Math.random()}`, 'x', {});
    const id = `call-bad-${Math.random()}`;
    fake.emit({ type: 'tool_execution_start', toolCallId: id, toolName: 'weird', args: {} });
    fake.emit({
      type: 'tool_execution_end',
      toolCallId: id,
      toolName: 'weird',
      result: { content: [{ type: 'text', text: 'ok' }], details: badDetails },
      isError: false,
    });
  }

  // 最后一个 completed 事件应原值透传 details
  const last = cap.completed[cap.completed.length - 1];
  assert.deepEqual(last?.details, { any: 'object' });
});

test('不同会话各自持有独立 pi 会话实例', async () => {
  const fakes = [new FakePiSession(), new FakePiSession()];
  const created: FakePiSession[] = [];
  const adapter = new PiConversationAdapter(async () => {
    const session = fakes[created.length] ?? new FakePiSession();
    created.push(session);
    return { session, dispose: () => session.dispose() };
  });

  await adapter.sendMessage('session-a', 'A1', {});
  await adapter.sendMessage('session-b', 'B1', {});
  await adapter.sendMessage('session-a', 'A2', {});

  assert.equal(created.length, 2, '两个会话各创建一次');
  assert.deepEqual(created[0]?.promptCalls, ['A1', 'A2']);
  assert.deepEqual(created[1]?.promptCalls, ['B1']);
});

test('运行中会话更换模型时经 setModel 热切换', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose() }),
    { resolveModel: async (model) => ({ resolved: model }) },
  );

  await adapter.sendMessage('session-hot', '第一轮', { model: 'model-a' });
  await adapter.sendMessage('session-hot', '换模型', { model: 'model-b' });
  await adapter.sendMessage('session-hot', '不换', { model: 'model-b' });

  assert.deepEqual(fake.setModelCalls, [{ resolved: 'model-b' }], '仅模型变化时热切换一次');
});

test('热切换解析失败时抛出稳定错误且不影响已有会话', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose() }),
    {
      resolveModel: async (model) => {
        throw new Error(`模型未配置或不可用: ${model}`);
      },
    },
  );

  await adapter.sendMessage('session-bad', '第一轮', {});
  await assert.rejects(
    adapter.sendMessage('session-bad', '换坏模型', { model: 'ghost-model' }),
    /模型未配置或不可用: ghost-model/,
  );
  assert.equal(fake.disposed, false, '已有会话不被销毁');
});

// ===== P2-D：重启恢复与资源释放 =====

test('P2-D：重启后 loadHistory 经 resolveSessionFile 从磁盘 JSONL 恢复历史', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'forge-restart-'));
  const file = pathMod.join(tmp, 'session-restart.jsonl');
  const header = { type: 'session', version: 3, id: 'forge-session-restart', timestamp: '2026-01-01T00:00:00.000Z', cwd: tmp };
  const entry1 = { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: '历史一' } };
  const entry2 = { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '历史二' }] } };
  fsMod.writeFileSync(file, [header, entry1, entry2].map((x) => JSON.stringify(x)).join('\n'), 'utf8');

  try {
    const fake = new FakePiSession();
    // 模拟重启：新建 adapter（内存 sessionFiles 空），注入 resolveSessionFile 命中磁盘文件
    const restarted = new PiConversationAdapter(
      async () => ({ session: fake, dispose: () => fake.dispose() }),
      {
        resolveModel: async (model) => ({ resolved: model }),
        resolveSessionFile: (sessionId) =>
          sessionId === 'session-restart' ? file : undefined,
      },
    );
    const messages = await restarted.loadHistory('session-restart');
    assert.equal(messages.length, 2, '重启后应从磁盘恢复两条历史');
    assert.equal(messages[0]?.role, 'user');
    assert.equal(messages[0]?.content, '历史一');
    assert.equal(messages[1]?.role, 'assistant');
    assert.equal(messages[1]?.content, '历史二');
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

// ===== P3-A：无 lease 时磁盘用量估算（重启恢复后进入会话即可见用量） =====

test('P3-A：无 lease 时经 resolveSessionFile 从磁盘估算用量（最后 assistant usage + 尾部估算）', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'forge-usage-'));
  const file = pathMod.join(tmp, 'session-usage.jsonl');
  const header = { type: 'session', version: 3, id: 'forge-session-usage', timestamp: '2026-01-01T00:00:00.000Z', cwd: tmp };
  const m1 = { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: '历史一' } };
  const m2 = { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }], stopReason: 'stop', usage: { totalTokens: 1234 } } };
  const m3 = { type: 'message', id: 'm3', parentId: 'm2', timestamp: '2026-01-01T00:00:02.000Z', message: { role: 'user', content: '随后追问' } };
  fsMod.writeFileSync(file, [header, m1, m2, m3].map((x) => JSON.stringify(x)).join('\n'), 'utf8');

  try {
    const fake = new FakePiSession();
    const base = {
      resolveModel: async () => ({ contextWindow: 100000 }),
      resolveSessionFile: (sessionId: string) => (sessionId === 'session-usage' ? file : undefined),
    };
    // 注入会话模型解析 → 磁盘估算：最后 assistant usage(1234) + 尾部 user 消息(ceil(4/4)=1)
    const adapter = new PiConversationAdapter(
      async () => ({ session: fake, dispose: () => fake.dispose() }),
      { ...base, resolveSessionModel: async () => 'test-model' },
    );
    const usage = await adapter.getContextUsage('session-usage');
    assert.equal(usage?.tokens, 1235, '应为 1234 + 尾部估算 1');
    assert.equal(usage?.contextWindow, 100000);
    assert.ok(Math.abs((usage?.percent ?? 0) - 1.235) < 1e-9, 'percent 应为 tokens/contextWindow 百分比');

    // 未注入 resolveSessionModel（无 lease 且无模型信息）→ 未知，不报错
    const noModel = new PiConversationAdapter(
      async () => ({ session: fake, dispose: () => fake.dispose() }),
      base,
    );
    assert.equal(await noModel.getContextUsage('session-usage'), null, '无模型元数据时应返回 null');
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P3-A：压缩边界之后无新 assistant 用量时磁盘估算返回 tokens 未知（与 pi 行为一致）', async () => {
  const fsMod = await import('node:fs');
  const osMod = await import('node:os');
  const pathMod = await import('node:path');
  const tmp = fsMod.mkdtempSync(pathMod.join(osMod.tmpdir(), 'forge-usage-compact-'));
  const file = pathMod.join(tmp, 'session-usage-compact.jsonl');
  const header = { type: 'session', version: 3, id: 'forge-session-usage-compact', timestamp: '2026-01-01T00:00:00.000Z', cwd: tmp };
  const m1 = { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:00.000Z', message: { role: 'user', content: '压缩前' } };
  const m2 = { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:01.000Z', message: { role: 'assistant', content: [{ type: 'text', text: '回复' }], stopReason: 'stop', usage: { totalTokens: 1234 } } };
  const c1 = { type: 'compaction', id: 'c1', parentId: 'm2', timestamp: '2026-01-01T00:00:02.000Z', summary: '摘要', tokensBefore: 1234 };
  const m3 = { type: 'message', id: 'm3', parentId: 'c1', timestamp: '2026-01-01T00:00:03.000Z', message: { role: 'user', content: '压缩后追问' } };
  fsMod.writeFileSync(file, [header, m1, m2, c1, m3].map((x) => JSON.stringify(x)).join('\n'), 'utf8');

  try {
    const fake = new FakePiSession();
    const adapter = new PiConversationAdapter(
      async () => ({ session: fake, dispose: () => fake.dispose() }),
      {
        resolveModel: async () => ({ contextWindow: 100000 }),
        resolveSessionFile: (sessionId) => (sessionId === 'session-usage-compact' ? file : undefined),
        resolveSessionModel: async () => 'test-model',
      },
    );
    const usage = await adapter.getContextUsage('session-usage-compact');
    assert.deepEqual(usage, { tokens: null, contextWindow: 100000, percent: null }, '压缩前的 usage 会虚报压缩后上下文，应视为未知');
  } finally {
    fsMod.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-D：removeSession 中止执行并 dispose lease，幂等可重复调用', async () => {
  const fake = new FakePiSession();
  const disposeCalls: string[] = [];
  const adapter = new PiConversationAdapter(
    async () => ({
      session: fake,
      dispose: () => {
        disposeCalls.push('disposed');
        fake.disposed = true;
      },
    }),
    { resolveModel: async (model) => ({ resolved: model }) },
  );
  await adapter.sendMessage('session-rm', '跑着');
  assert.equal(fake.abortCalls, 0);
  await adapter.removeSession('session-rm');
  assert.equal(fake.abortCalls, 1, '删除前应先 abort 停止执行（P2-D 先 stop）');
  assert.equal(disposeCalls.length, 1, 'lease 应被 dispose');
  assert.equal(fake.disposed, true);
  // 幂等：未知会话 / 重复删除无副作用
  await adapter.removeSession('session-rm');
  await adapter.removeSession('ghost-session');
  assert.equal(fake.abortCalls, 1);
  assert.equal(disposeCalls.length, 1);
  // 删除后再发消息应重建新 lease（不复用已释放实例；工厂返回同一 fake 实例，prompt 再调一次）
  await adapter.sendMessage('session-rm', '再来一轮');
  assert.equal(fake.promptCalls.length, 2, '重建后新会话执行 prompt');
});

// ===== 附件统一给路径：adapter 不再透传 images =====

test('附件统一给路径：prompt 恒单参调用，残留 attachments 选项不转图片', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose() }),
    { resolveModel: async (model) => ({ resolved: model }) },
  );
  await adapter.sendMessage('session-plain', '纯文本');
  // 路径行已随正文发送；即使 options 残留旧附件键也不转图片（给路径后 adapter 不读该键）
  await adapter.sendMessage('session-legacy-att', '带路径附件\nC:\\repo\\a.ts', {
    attachments: [{ kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'aGVsbG8=' }],
  } as never);
  assert.equal(fake.promptCalls.length, 2);
  // CV-S09 竞态修复后直发会传 { preflightResult } 选项对象（非 images）；
  // 断言退化为：任何第二参都不得携带 images（数组或 images 键）
  const imagesPassed = fake.imageCalls.filter(
    (c) => Array.isArray(c) || (c as { images?: unknown }).images !== undefined,
  );
  assert.equal(imagesPassed.length, 0, '任何情况下不再传 images 参数');
});

// ===== wu-06：子 agent 事件映射、终止通道与删除清理 =====

import { SubagentService } from '@forge/core';

/** 子 agent 扩展事件总线 fake（pi.events 结构） */
class SubagentTestBus {
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

/** 收集 SubagentService sink 事件 */
function collectingSink(): {
  events: Array<{ sessionId: string; event: string; payload: unknown }>;
  sink: { emit: (sessionId: string, event: string, payload: unknown) => boolean };
} {
  const events: Array<{ sessionId: string; event: string; payload: unknown }> = [];
  return {
    events,
    sink: {
      emit: (sessionId, event, payload) => {
        events.push({ sessionId, event, payload });
        return true;
      },
    },
  };
}

test('subagents 生命周期事件映射为 SubagentService ingest 并按会话归组', async () => {
  const { sink, events } = collectingSink();
  const service = new SubagentService({ sink });
  const bus = new SubagentTestBus();
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose(), events: bus }),
    { subagentService: service },
  );
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '派生任务');

  // pi-subagents 真实载荷形状（created → started → completed）
  bus.emit('subagents:created', { id: 'ag-9', type: 'Explore', description: '探查代码' });
  bus.emit('subagents:started', { id: 'ag-9', type: 'Explore', description: '探查代码' });
  bus.emit('subagents:completed', {
    id: 'ag-9',
    type: 'Explore',
    description: '探查代码',
    status: 'completed',
    result: '探查结论',
    tokens: { input: 10, output: 20, total: 30 },
  });

  const list = service.queryList('s1');
  assert.ok(list.ok && list.data.length === 1, `会话 s1 应有一条记录: ${JSON.stringify(list)}`);
  const record = list.ok ? list.data[0]! : null;
  assert.equal(record?.agentId, 'ag-9');
  assert.equal(record?.status, 'completed');
  assert.equal(record?.agentType, 'Explore');
  assert.equal(record?.description, '探查代码');
  assert.equal(record?.result, '探查结论');
  assert.deepEqual(record?.usage, { inputTokens: 10, outputTokens: 20 });

  // failed 事件：error → failed；stopped/aborted → stopped
  bus.emit('subagents:created', { id: 'ag-f', type: 'general-purpose' });
  bus.emit('subagents:failed', { id: 'ag-f', type: 'general-purpose', status: 'error', error: 'boom' });
  bus.emit('subagents:created', { id: 'ag-s', type: 'general-purpose' });
  bus.emit('subagents:failed', { id: 'ag-s', type: 'general-purpose', status: 'aborted', error: '中止' });
  const list2 = service.queryList('s1');
  const byId = new Map(list2.ok ? list2.data.map((r) => [r.agentId, r]) : []);
  assert.equal(byId.get('ag-f')?.status, 'failed');
  assert.equal(byId.get('ag-f')?.error, 'boom');
  assert.equal(byId.get('ag-s')?.status, 'stopped', 'aborted 应映射为 stopped');

  // sink 收到 subagent.updated（完整记录）且绑定会话
  assert.ok(events.some((e) => e.sessionId === 's1' && e.event === 'subagent.updated'));

  // 其他会话不受影响（事件绑定 lease 所属会话）
  assert.ok(service.queryList('other').ok && service.queryList('other').data.length === 0);
});

test('removeSession 退订扩展事件总线并清理子 agent 会话内存态', async () => {
  const { sink, events } = collectingSink();
  const service = new SubagentService({ sink });
  const bus = new SubagentTestBus();
  const fake = new FakePiSession();
  let disposed = false;
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => (disposed = true), events: bus }),
    { subagentService: service },
  );
  adapter.onMessage('s-del', () => undefined);
  await adapter.sendMessage('s-del', '任务');

  bus.emit('subagents:created', { id: 'ag-1', type: 'general-purpose', description: '任务' });
  assert.equal(service.queryList('s-del').ok && service.queryList('s-del').data.length, 1);

  await adapter.removeSession('s-del');
  assert.ok(disposed, 'lease 应被 dispose');

  // 退订后迟到事件不再 ingest（无 updated、无记录）
  const before = events.length;
  bus.emit('subagents:completed', { id: 'ag-1', type: 'general-purpose', status: 'completed', result: '迟到' });
  assert.equal(events.length, before, '退订后不应再收到子 agent 事件');
  assert.equal(service.queryList('s-del').ok && service.queryList('s-del').data.length, 0, '内存态应清空');

  // removeSession 幂等
  await adapter.removeSession('s-del');
});

test('stopSubagent 委托 lease 句柄的扩展 stop 通道；通道缺失时抛错', async () => {
  const stopped: string[] = [];
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => undefined,
    handle: {
      stopSubagent: async (agentId: string) => {
        stopped.push(agentId);
      },
    },
  }));
  adapter.onMessage('s-stop', () => undefined);
  await adapter.sendMessage('s-stop', '任务');
  await adapter.stopSubagent('s-stop', 'ag-1');
  assert.deepEqual(stopped, ['ag-1'], '应委托 lease 句柄的 stopSubagent');

  // 通道缺失（扩展缺失/未激活会话）→ 抛错（上层映射 1002/5000）
  await assert.rejects(adapter.stopSubagent('s-unknown', 'ag-1'), /终止通道不可用/);
});

test('未注入 subagentService 时静默降级：不订阅事件、无副作用', async () => {
  const bus = new SubagentTestBus();
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => undefined,
    events: bus,
  }));
  adapter.onMessage('s-plain', () => undefined);
  // 不抛错即通过（事件总线被忽略）
  await adapter.sendMessage('s-plain', '普通问题');
  assert.equal(fake.promptCalls.length, 1);
});

// ===== 上下文压缩（P3-A / CV-S07）=====

/** 压缩事件捕获器 */
interface CompactionCapture {
  compacted: Array<{
    sessionId: string;
    reason: string;
    tokensBefore: number | null;
    tokensAfter: number | null;
    summary: string | null;
  }>;
  errors: Array<{ sessionId: string; message: string }>;
}

/** 挂上压缩/错误事件捕获 */
function compactionCapture(adapter: PiConversationAdapter): CompactionCapture {
  const cap: CompactionCapture = { compacted: [], errors: [] };
  adapter.setEventHandlers({
    onCompacted: (sid, info) =>
      cap.compacted.push({
        sessionId: sid,
        reason: info.reason,
        tokensBefore: info.tokensBefore,
        tokensAfter: info.tokensAfter,
        summary: info.summary,
      }),
    onError: (sid, e) => cap.errors.push({ sessionId: sid, message: e.message }),
  });
  return cap;
}

/** 已激活会话（发过消息、lease 存在）+ 压缩事件捕获 */
async function activeAdapterWithCompactionCapture(): Promise<{
  fake: FakePiSession;
  adapter: PiConversationAdapter;
  cap: CompactionCapture;
}> {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  const cap = compactionCapture(adapter);
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '问题');
  return { fake, adapter, cap };
}

test('自动压缩完成（threshold）回调 onCompacted 且 reason=auto（自动压缩可被 UI 感知）', async () => {
  const { fake, cap } = await activeAdapterWithCompactionCapture();

  fake.emit({
    type: 'compaction_end',
    reason: 'threshold',
    result: { summary: '已压缩摘要', tokensBefore: 90000, estimatedTokensAfter: 12000 },
    aborted: false,
  });

  assert.equal(cap.compacted.length, 1, '自动压缩完成应回调一次 onCompacted');
  const info = cap.compacted[0]!;
  assert.equal(info.sessionId, 's1');
  assert.equal(info.reason, 'auto', '阈值触发的自动压缩应标记为 auto');
  assert.equal(info.tokensBefore, 90000);
  assert.equal(info.tokensAfter, 12000);
  assert.equal(info.summary, '已压缩摘要');
  assert.deepEqual(cap.errors, [], '成功时不应上报错误');
});

test('手动压缩完成（manual）回调 onCompacted 且 reason=manual', async () => {
  const { fake, cap } = await activeAdapterWithCompactionCapture();

  fake.emit({
    type: 'compaction_end',
    reason: 'manual',
    result: { summary: '手动摘要', tokensBefore: 40000, estimatedTokensAfter: 6000 },
    aborted: false,
  });

  assert.equal(cap.compacted.length, 1);
  assert.equal(cap.compacted[0]!.reason, 'manual');
  assert.equal(cap.compacted[0]!.tokensBefore, 40000);
  assert.equal(cap.compacted[0]!.tokensAfter, 6000);
});

test('自动压缩失败（errorMessage）走 onError 上报，不回调 onCompacted', async () => {
  const { fake, cap } = await activeAdapterWithCompactionCapture();

  fake.emit({
    type: 'compaction_end',
    reason: 'overflow',
    result: undefined,
    aborted: false,
    errorMessage: 'Auto-compaction failed: provider timeout',
  });

  assert.deepEqual(cap.compacted, [], '失败不应回调 onCompacted');
  assert.equal(cap.errors.length, 1, '自动压缩失败必须上报，不能静默');
  assert.equal(cap.errors[0]!.sessionId, 's1');
  assert.match(cap.errors[0]!.message, /Auto-compaction failed/);
});

test('压缩被中止（aborted 且无 errorMessage）不回调 onCompacted 也不误报错误', async () => {
  const { fake, cap } = await activeAdapterWithCompactionCapture();

  fake.emit({ type: 'compaction_end', reason: 'manual', result: undefined, aborted: true });

  assert.deepEqual(cap.compacted, [], '中止不算压缩完成');
  assert.deepEqual(cap.errors, [], '用户中止不是错误');
});

test('compact 返回 pi 压缩详情（tokensBefore/tokensAfter/summary），不再恒空', async () => {
  const fake = new FakePiSession();
  fake.compactResult = { summary: '摘要', tokensBefore: 50000, estimatedTokensAfter: 8000 };
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '问题');

  const res = await adapter.compact('s1');
  assert.equal(res.ok, true);
  assert.equal(fake.compactCalls, 1);
  assert.equal(res.tokensBefore, 50000);
  assert.equal(res.tokensAfter, 8000);
  assert.equal(res.summary, '摘要');
});

test('compact 抛错返回 ok:false 与错误信息，不抛出（不破坏会话历史）', async () => {
  const fake = new FakePiSession();
  fake.compactError = new Error('Nothing to compact (session too small)');
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '问题');

  const res = await adapter.compact('s1');
  assert.equal(res.ok, false);
  assert.match(res.message ?? '', /Nothing to compact/);
});

// ===== CV-S09 消息队列 =====

/** 支持 isStreaming/clearQueue 的 fake（模拟流式中 + 待发队列） */
class QueuedFakePiSession extends FakePiSession {
  isStreaming = true;
  clearQueueCalls = 0;
  queueContent: string[] = [];
  /** followUp/steer 直入队记录（CV-S09 队列编辑走真实 pi 同路径） */
  followUpCalls: string[] = [];
  steerCalls: string[] = [];
  clearQueue(): { steering: string[]; followUp: string[] } {
    this.clearQueueCalls += 1;
    const followUp = [...this.queueContent];
    this.queueContent = [];
    return { steering: [], followUp };
  }
  /** 对齐真实 pi：followUp 为同步 push（队尾追加），失败仅当命令不可排队 */
  async followUp(text: string): Promise<void> {
    this.followUpCalls.push(text);
    this.queueContent.push(text);
  }
  /** 对齐真实 pi：steer 直入 steering 队列（本 fake 只记录，不参与 followUp 镜像） */
  async steer(text: string): Promise<void> {
    this.steerCalls.push(text);
  }
  /** 对齐真实 pi：abort 结束在途轮次，isStreaming 翻 false */
  override async abort(): Promise<void> {
    await super.abort();
    this.isStreaming = false;
  }
}

test('CV-S09：streaming 中 sendMessage 以 followUp 入队，不应用思考级别/不重置轮次', async () => {
  const fake = new QueuedFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  await adapter.sendMessage('s1', '第一轮'); // 先建立 lease（直发路径）
  const thinkingCallsBefore = fake.setThinkingLevelCalls.length;

  await adapter.sendMessage('s1', '排队消息');

  assert.deepEqual(fake.promptCalls, ['第一轮', '排队消息']);
  const followUpOpt = fake.imageCalls.find(
    (c) => (c as { streamingBehavior?: string }).streamingBehavior === 'followUp',
  );
  assert.ok(followUpOpt !== undefined, '排队消息应以 streamingBehavior:followUp 入队');
  assert.equal(fake.setThinkingLevelCalls.length, thinkingCallsBefore, '入队不应用思考级别');
});

test('CV-S09：queue_update 转发 onQueueUpdated；派发时 user 气泡经 onMessage 转发', async () => {
  const fake = new QueuedFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  const queueUpdates: string[][] = [];
  const userMessages: string[] = [];
  adapter.setEventHandlers({
    onQueueUpdated: (_sid, followUp) => queueUpdates.push([...followUp]),
    onMessage: (_sid, message) => {
      if (message.role === 'user') userMessages.push(message.content);
    },
  });
  // 先建 lease（订阅在直发路径内建立）
  await adapter.sendMessage('s1', '第一轮');

  // 入队两条（无离队）
  fake.emit({ type: 'queue_update', followUp: ['a', 'b'] } as MinimalEvent);
  // 派发一条：pi 先发 queue_update（移除）再发 message_start(user)
  fake.emit({ type: 'queue_update', followUp: ['b'] } as MinimalEvent);
  fake.emit({ type: 'message_start', message: { role: 'user', content: 'a' } } as MinimalEvent);

  assert.deepEqual(queueUpdates, [['a', 'b'], ['b']]);
  assert.deepEqual(userMessages, ['a'], '离队 + message_start(user) = 派发，转发 user 气泡');
});

test('CV-S09：直发路径的 user message_start 不转发（pendingDelivery 为空）', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  const userMessages: string[] = [];
  adapter.setEventHandlers({
    onMessage: (_sid, message) => {
      if (message.role === 'user') userMessages.push(message.content);
    },
  });
  await adapter.sendMessage('s1', '第一轮');

  fake.emit({ type: 'message_start', message: { role: 'user', content: '直发' } } as MinimalEvent);

  assert.deepEqual(userMessages, [], '无离队记录时不转发');
});

test('CV-S09：cancelStream 清空队列并返回文本，清空不派发（无 user 气泡）', async () => {
  const fake = new QueuedFakePiSession();
  fake.queueContent = ['q1', 'q2'];
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  const queueUpdates: string[][] = [];
  const userMessages: string[] = [];
  adapter.setEventHandlers({
    onQueueUpdated: (_sid, followUp) => queueUpdates.push([...followUp]),
    onMessage: (_sid, message) => {
      if (message.role === 'user') userMessages.push(message.content);
    },
  });

  // 先建 lease（首条走直发路径）+ 模拟在途队列镜像（入队时 queue_update 已建立）
  await adapter.sendMessage('s1', '第一轮');
  fake.emit({ type: 'queue_update', followUp: ['q1', 'q2'] } as MinimalEvent);

  const cleared = await adapter.cancelStream('s1');

  assert.deepEqual(cleared, ['q1', 'q2']);
  assert.equal(fake.clearQueueCalls, 1);
  assert.equal(fake.abortCalls, 1);
  // 清空触发的 queue_update 事件不产生 user 气泡（清空 ≠ 派发）
  const userAfterClear = userMessages.length;
  fake.emit({ type: 'message_start', message: { role: 'user', content: 'q1' } } as MinimalEvent);
  assert.equal(userMessages.length, userAfterClear, '取消后 user message_start 不再转发');
});

// ===== CV-S09 队列编辑：删除 / 按位插入 / 立即发送（steer 插队） =====

test('队列编辑：removeQueuedMessage 删中间一条，剩余按原序回灌', async () => {
  const fake = new QueuedFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  await adapter.sendMessage('s1', '第一轮'); // 建 lease（直发路径）
  fake.queueContent = ['a', 'b', 'c'];

  const next = await adapter.removeQueuedMessage('s1', 1);

  assert.deepEqual(next, ['a', 'c']);
  assert.deepEqual(fake.queueContent, ['a', 'c'], '重建后队列应等于返回值');
  assert.deepEqual(fake.followUpCalls, ['a', 'c'], '回灌走 session.followUp（与真实 pi 同路径）');
});

test('队列编辑：removeQueuedMessage index 越界抛错且队列原样保留', async () => {
  const fake = new QueuedFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  await adapter.sendMessage('s1', '第一轮');
  fake.queueContent = ['a', 'b'];

  await assert.rejects(() => adapter.removeQueuedMessage('s1', 5), /队列已变化/);
  assert.deepEqual(fake.queueContent, ['a', 'b'], '软失败必须恢复原队列，不得吞掉待发消息');
});

test('队列编辑：sendQueuedMessageNow 打断当前轮，摘出条目立即直发，剩余回灌', async () => {
  const fake = new QueuedFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  await adapter.sendMessage('s1', '第一轮'); // 在途轮次（fake isStreaming=true）
  fake.queueContent = ['a', 'b', 'c'];

  const next = await adapter.sendQueuedMessageNow('s1', 1);

  assert.deepEqual(next, ['a', 'c']);
  assert.equal(fake.abortCalls, 1, '在途轮次应被中止（不等 AI 跑完）');
  assert.equal(fake.isStreaming, false, 'abort 后轮次结束');
  // 摘出的 'b' 以全新轮次直发（空闲路径 prompt），'a'/'c' 回灌排在其后 FIFO
  assert.deepEqual(fake.promptCalls, ['第一轮', 'b']);
  assert.deepEqual(fake.followUpCalls, ['a', 'c']);
  assert.deepEqual(fake.queueContent, ['a', 'c']);
});

test('队列编辑：sendQueuedMessageNow index 越界抛错且不打断当前轮', async () => {
  const fake = new QueuedFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  await adapter.sendMessage('s1', '第一轮');
  fake.queueContent = ['a', 'b'];

  await assert.rejects(() => adapter.sendQueuedMessageNow('s1', 9), /队列已变化/);
  assert.equal(fake.abortCalls, 0, '软失败不得中止在途轮次');
  assert.deepEqual(fake.queueContent, ['a', 'b'], '软失败必须恢复原队列');
});

test('队列编辑：sendQueuedMessageNow 会话空闲时直接直发不 abort', async () => {
  const fake = new QueuedFakePiSession();
  fake.isStreaming = false; // 竞态窗口：点击时轮次恰好已收尾
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  await adapter.sendMessage('s1', '第一轮');
  fake.queueContent = ['a', 'b'];

  const next = await adapter.sendQueuedMessageNow('s1', 0);

  assert.deepEqual(next, ['b']);
  assert.equal(fake.abortCalls, 0, '空闲时无需中止');
  assert.deepEqual(fake.promptCalls, ['第一轮', 'a']);
  assert.deepEqual(fake.queueContent, ['b']);
});

/** abort 时模拟 pi 发出 aborted 错误事件 + 被打断轮的收尾 assistant 消息 */
class AbortNoisyFakePiSession extends QueuedFakePiSession {
  override async abort(): Promise<void> {
    await super.abort();
    this.emit({ type: 'agent_end', errorMessage: 'This operation was aborted' } as MinimalEvent);
    this.emit({
      type: 'message_end',
      message: { role: 'assistant', content: '', stopReason: 'error', errorMessage: 'This operation was aborted' },
    } as MinimalEvent);
    this.emit({
      type: 'message_end',
      message: { role: 'assistant', content: '被打断轮的半截文本', stopReason: 'aborted' },
    } as MinimalEvent);
  }
}

test('打断抑制窗：cancelStream / sendQueuedMessageNow 期间 aborted 错误事件不上报', async () => {
  const fake = new AbortNoisyFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  const errors: string[] = [];
  const assistantMessages: string[] = [];
  adapter.setEventHandlers({
    onError: (_sid, error) => errors.push(error.message),
    onMessage: (_sid, message) => {
      if (message.role === 'assistant') assistantMessages.push(message.content);
    },
  });
  await adapter.sendMessage('s1', '第一轮');
  fake.queueContent = ['a', 'b'];
  const msgCountBefore = assistantMessages.length;

  await adapter.cancelStream('s1');
  assert.deepEqual(errors, [], '停止的 abort 收尾不该弹错误横幅');
  assert.equal(
    assistantMessages.length, msgCountBefore,
    '被打断轮的收尾消息不转发 UI（流式占位已展示同文）',
  );

  fake.isStreaming = true; // 模拟新一轮在途
  fake.queueContent = ['c'];
  await adapter.sendQueuedMessageNow('s1', 0);
  assert.deepEqual(errors, [], '立即发送的 abort 收尾同样不上报');
  // 摘出条目直发的新轮次自身收尾照常转发（+1），被打断轮的收尾不转发
  assert.equal(assistantMessages.length, msgCountBefore + 1);
  assert.ok(
    !assistantMessages.includes('被打断轮的半截文本'),
    '被打断轮的收尾消息不得出现在消息流',
  );
});

test('打断抑制窗只盖住 abort 窗口，之后的真错误与正常收尾照常转发', async () => {
  const fake = new QueuedFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));
  const errors: string[] = [];
  const assistantMessages: string[] = [];
  adapter.setEventHandlers({
    onError: (_sid, error) => errors.push(error.message),
    onMessage: (_sid, message) => {
      if (message.role === 'assistant') assistantMessages.push(message.content);
    },
  });
  await adapter.sendMessage('s1', '第一轮');
  await adapter.cancelStream('s1');
  // 窗口已撤：后续真错误（如鉴权失败）必须照常透传
  fake.emit({
    type: 'agent_end',
    errorMessage: 'No API key found for the selected model',
  } as MinimalEvent);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /No API key/);
  // 窗口已撤：正常完成的 assistant 消息照常转发
  fake.emit({
    type: 'message_end',
    message: { role: 'assistant', content: '正常回复', stopReason: 'stop' },
  } as MinimalEvent);
  assert.ok(
    assistantMessages.includes('正常回复'),
    '窗口外的正常收尾消息不受抑制窗影响',
  );
});

/** 模拟 pi 直发 preflight 窗口的 fake：prompt 先挂起（鉴权/压缩预检，isStreaming 尚 false），
 *  测试手动放行提交；提交后进入轮次执行窗口，再手动放行收尾。 */
class PreflightGateFakePiSession extends FakePiSession {
  isStreaming = false;
  /** followUp 入队记录（真实 pi：同步 push + queue_update 后立即返回） */
  followUpCalls: string[] = [];
  /** preflight 阶段抛出的错误（非空时提交放行后抛出，模拟鉴权失败） */
  submitError: Error | null = null;
  private submitGate: (() => void) | undefined;
  private turnGate: (() => void) | undefined;

  async prompt(text: string, opts?: unknown): Promise<void> {
    const o = opts as
      | { streamingBehavior?: string; preflightResult?: (ok: boolean) => void }
      | undefined;
    if (o?.streamingBehavior === 'followUp') {
      this.followUpCalls.push(text);
      return;
    }
    this.promptCalls.push(text);
    // preflight 窗口：挂起且 isStreaming 保持 false（真实 pi 在 _runAgentPrompt 才置位）
    await new Promise<void>((res) => {
      this.submitGate = res;
    });
    if (this.submitError !== null) {
      o?.preflightResult?.(false);
      throw this.submitError;
    }
    this.isStreaming = true;
    o?.preflightResult?.(true);
    // 轮次执行窗口
    await new Promise<void>((res) => {
      this.turnGate = res;
    });
    this.isStreaming = false;
  }

  /** 放行 preflight（模拟 pi 完成鉴权/压缩预检并提交轮次） */
  completeSubmit(): void {
    this.submitGate?.();
  }

  /** 放行轮次收尾 */
  finishTurn(): void {
    this.turnGate?.();
  }
}

/** 排空微任务队列（node:test 无 vue nextTick，用 setImmediate 两跳保证 Promise 链走完） */
async function settle(): Promise<void> {
  await new Promise<void>((res) => setImmediate(res));
  await new Promise<void>((res) => setImmediate(res));
}

test('CV-S09 竞态回归：直发 preflight 窗口内到达的消息等待提交后入队，不二次直发', async () => {
  const fake = new PreflightGateFakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => undefined }));

  // 第一条直发：挂在 preflight（isStreaming 仍 false，模拟鉴权/压缩预检进行中）
  const first = adapter.sendMessage('s1', '第一条');
  await settle();
  assert.equal(fake.isStreaming, false, '前置：第一条仍在 preflight 窗口');

  // 第二条在窗口内到达：旧缺陷行为是 isStreaming=false → 误走直发与启动中的轮次相撞
  const second = adapter.sendMessage('s1', '第二条');
  await settle();
  assert.equal(fake.promptCalls.length, 1, 'preflight 窗口内不得对第二条二次直发');
  assert.deepEqual(fake.followUpCalls, [], '提交完成前不得提前 followUp（pi 仍空闲会滞留队列）');

  // pi 完成提交：isStreaming=true + preflightResult(true) → 第二条应 followUp 入队
  fake.completeSubmit();
  await second;
  assert.deepEqual(fake.followUpCalls, ['第二条'], '提交完成后第二条应以 followUp 入队');

  fake.finishTurn();
  await first;
  assert.deepEqual(fake.promptCalls, ['第一条']);
});

test('CV-S09 竞态回归：上一条直发 factory 失败时释放等待者，后续消息不悬挂', async () => {
  let fail = true;
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => {
    if (fail) throw new Error('factory 失败');
    return { session: fake, dispose: () => undefined };
  });

  const first = adapter.sendMessage('s1', 'a');
  const second = adapter.sendMessage('s1', 'b');

  await assert.rejects(first, /factory 失败/);
  await assert.rejects(second, /factory 失败/, '等待中的消息必须被释放并收到同一错误，不得悬挂');
});

// ===== Path 2：ask_user_question 双向往返（契约 §4.2.1 ① ④ / §4.4）=====

import { ASK_USER_REQUEST_CHANNEL, askUserReplyChannel } from '@forge/extensions';

/** 一份最小合法问卷载荷（扩展侧 emit 的形状） */
function askRequestPayload(): Record<string, unknown> {
  return {
    requestId: 'req-1',
    questions: [
      {
        question: '用哪个缓存实现？',
        header: 'Cache',
        options: [
          { label: '内存缓存', description: '快但进程内' },
          { label: 'Redis', description: '跨进程' },
        ],
      },
    ],
    timeoutMs: 60_000,
  };
}

test('Path 2：按会话订阅 ask-user:request，补齐**必需** sessionId 后上抛 onAskUserQuestionRequested', async () => {
  const bus = new SubagentTestBus();
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => fake.dispose(),
    events: bus,
  }));
  const seen: Array<{ sessionId: string; payload: Record<string, unknown> }> = [];
  adapter.setEventHandlers({
    onAskUserQuestionRequested: (sessionId, payload) =>
      seen.push({ sessionId, payload: payload as unknown as Record<string, unknown> }),
  });
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '任务');

  bus.emit(ASK_USER_REQUEST_CHANNEL, askRequestPayload());

  assert.equal(seen.length, 1, '请求应被上抛一次');
  assert.equal(seen[0]!.sessionId, 's1');
  assert.equal(seen[0]!.payload.requestId, 'req-1');
  assert.equal(seen[0]!.payload.sessionId, 's1', '载荷必须带 sessionId（多窗格据此认领）');
  assert.equal(seen[0]!.payload.timeoutMs, 60_000, 'timeoutMs 原样透传供面板驱动倒计时');
  assert.equal(Array.isArray(seen[0]!.payload.questions), true);
});

test('Path 2：畸形请求载荷一律静默忽略（宁可不弹，也不弹残缺面板）', async () => {
  const bus = new SubagentTestBus();
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => fake.dispose(),
    events: bus,
  }));
  const seen: unknown[] = [];
  adapter.setEventHandlers({ onAskUserQuestionRequested: (_sid, payload) => seen.push(payload) });
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '任务');

  bus.emit(ASK_USER_REQUEST_CHANNEL, null);
  bus.emit(ASK_USER_REQUEST_CHANNEL, 'text');
  bus.emit(ASK_USER_REQUEST_CHANNEL, { questions: [], timeoutMs: 1000 }); // 缺 requestId
  bus.emit(ASK_USER_REQUEST_CHANNEL, { requestId: 'r', questions: [], timeoutMs: 1000 }); // 空问卷
  bus.emit(ASK_USER_REQUEST_CHANNEL, { requestId: 'r', questions: {}, timeoutMs: 1000 }); // questions 非数组
  bus.emit(ASK_USER_REQUEST_CHANNEL, { requestId: 'r', questions: [{}], timeoutMs: 0 }); // timeoutMs 非正
  bus.emit(ASK_USER_REQUEST_CHANNEL, { requestId: 'r', questions: [{}], timeoutMs: Number.NaN });
  bus.emit(ASK_USER_REQUEST_CHANNEL, { requestId: '', questions: [{}], timeoutMs: 1000 }); // requestId 空

  assert.equal(seen.length, 0, '八种畸形载荷都不得上抛');
});

test('Path 2：replyAskUserQuestion 经**该会话**总线投递回填；无 lease 返回 false 不投递', async () => {
  const bus = new SubagentTestBus();
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => fake.dispose(),
    events: bus,
  }));
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '任务');

  const replies: Array<Record<string, unknown>> = [];
  bus.on(askUserReplyChannel('req-1'), (data) => replies.push(data as Record<string, unknown>));

  const answers = [{ questionIndex: 0, question: 'q', kind: 'option', answer: '内存缓存' }];
  const ok = adapter.replyAskUserQuestion('s1', 'req-1', { answers, cancelled: false, globalNote: '备注' });
  assert.equal(ok, true);
  assert.equal(replies.length, 1);
  assert.equal(replies[0]!.requestId, 'req-1');
  assert.deepEqual(replies[0]!.answers, answers);
  assert.equal(replies[0]!.cancelled, false);
  assert.equal(replies[0]!.globalNote, '备注');

  // 取消态：globalNote 缺省时字段不出现在载荷里（与扩展侧 isAskUserReplyPayload 宽松校验一致）
  adapter.replyAskUserQuestion('s1', 'req-1', { answers: [], cancelled: true });
  assert.equal(replies.length, 2);
  assert.equal(replies[1]!.cancelled, true);
  assert.equal('globalNote' in replies[1]!, false);

  // 错窗格 / 会话已删 → 无 lease → 不投递（作答被丢弃，模型收到 DECLINE）
  assert.equal(adapter.replyAskUserQuestion('other', 'req-1', { answers: [], cancelled: false }), false);
  assert.equal(replies.length, 2, '无 lease 的会话不得产生任何回填');
});

test('Path 2：会话隔离——每会话各自订阅，sessionId 取自订阅闭包，A 的请求不会投到 B', async () => {
  const busA = new SubagentTestBus();
  const busB = new SubagentTestBus();
  const adapter = new PiConversationAdapter(async (options) => {
    const fake = new FakePiSession();
    return { session: fake, dispose: () => fake.dispose(), events: options.sessionId === 'A' ? busA : busB };
  });
  const seen: string[] = [];
  adapter.setEventHandlers({ onAskUserQuestionRequested: (sessionId) => seen.push(sessionId) });
  adapter.onMessage('A', () => undefined);
  adapter.onMessage('B', () => undefined);
  // 生产路径由 resolveSendOptions(sessionId) 注入 sessionId；测试按同形状传入
  await adapter.sendMessage('A', 'a 的任务', { sessionId: 'A' });
  await adapter.sendMessage('B', 'b 的任务', { sessionId: 'B' });

  busA.emit(ASK_USER_REQUEST_CHANNEL, askRequestPayload());

  assert.deepEqual(seen, ['A'], 'A 的总线事件只能认领为 A（总线私有，无需从 ctx 反查）');

  // B 的回填只落在 B 的总线上
  const repliesA: unknown[] = [];
  const repliesB: unknown[] = [];
  busA.on(askUserReplyChannel('req-1'), (d) => repliesA.push(d));
  busB.on(askUserReplyChannel('req-1'), (d) => repliesB.push(d));
  adapter.replyAskUserQuestion('B', 'req-1', { answers: [], cancelled: true });
  assert.equal(repliesA.length, 0, 'A 的总线不得收到 B 会话的回填');
  assert.equal(repliesB.length, 1);
});

test('Path 2：removeSession 退订问卷 channel，迟到请求不再上抛（幂等）', async () => {
  const bus = new SubagentTestBus();
  const fake = new FakePiSession();
  let disposed = false;
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => (disposed = true),
    events: bus,
  }));
  const seen: unknown[] = [];
  adapter.setEventHandlers({ onAskUserQuestionRequested: (_sid, payload) => seen.push(payload) });
  adapter.onMessage('s-del', () => undefined);
  await adapter.sendMessage('s-del', '任务');

  bus.emit(ASK_USER_REQUEST_CHANNEL, askRequestPayload());
  assert.equal(seen.length, 1);

  await adapter.removeSession('s-del');
  assert.ok(disposed, 'lease 应被 dispose');

  bus.emit(ASK_USER_REQUEST_CHANNEL, { ...askRequestPayload(), requestId: 'req-2' });
  assert.equal(seen.length, 1, '退订后迟到请求不得再上抛（否则会弹出无主问卷）');
  await adapter.removeSession('s-del'); // 幂等
});

test('Path 2：lease 无事件总线（扩展未激活）时静默降级，不抛错也不上抛', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  const seen: unknown[] = [];
  adapter.setEventHandlers({ onAskUserQuestionRequested: (_sid, payload) => seen.push(payload) });
  adapter.onMessage('s1', () => undefined);
  await adapter.sendMessage('s1', '任务');

  assert.deepEqual(seen, []);
  assert.equal(adapter.replyAskUserQuestion('s1', 'req-1', { answers: [], cancelled: true }), false);
});

// ===== 回归：一轮多条 assistant 消息（MiniMax-M3 混流）不重发上一条正文 =====
//
// 真机事故（edu-community 会话）：一轮内 pi 依次产生多条 assistant 消息，每条正文
// 都是 <think>…</think> 混流形态。此前 partialContent 为轮次级累积：带正文的消息
// message_end 后正文残留在 partialContent，后续纯思考消息 message_end 把
// forwardedClean 置空 → 再下一条纯思考消息流式时 strip 结果=旧正文 ≠ prev('')
// → 整段旧正文被当新增量重发，前端在工具卡片之后 push 出重复文本卡
//（「AI 回复重复发同样的话，切会话再切回才恢复」——磁盘历史本就正确）。

/** 静默 fake：prompt 不自发事件，由测试自行驱动完整消息序列 */
function makeSilentFake(): {
  session: {
    subscribe(listener: (event: MinimalEvent) => void): () => void;
    prompt(text: string): Promise<void>;
    abort(): Promise<void>;
    dispose(): void;
    setThinkingLevel(level: string): Promise<void>;
  };
  listeners: Set<(event: MinimalEvent) => void>;
} {
  const listeners = new Set<(event: MinimalEvent) => void>();
  return {
    session: {
      subscribe(listener: (event: MinimalEvent) => void): () => void {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async prompt(): Promise<void> {},
      async abort(): Promise<void> {},
      dispose(): void {},
      async setThinkingLevel(): Promise<void> {},
    },
    listeners,
  };
}

test('一轮多条 assistant 消息时上一条正文不重发（真机重复话术回归）', async () => {
  const { session, listeners } = makeSilentFake();
  const adapter = new PiConversationAdapter(async () => ({ session, dispose: () => undefined }));

  const deltas: string[] = [];
  const assistantMessages: string[] = [];
  adapter.onDelta('session-dup', (t) => deltas.push(t));
  adapter.onMessage('session-dup', (m) => {
    if (m.role === 'assistant') assistantMessages.push(m.content);
  });

  await adapter.sendMessage('session-dup', '你不要改全局的'); // 建立订阅 + 重置轮次状态

  const emitDelta = (text: string): void => {
    for (const listener of listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    }
  };
  const endAssistant = (text: string): void => {
    for (const listener of listeners) {
      listener({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    }
  };

  // 消息1：<think>思考</think> + 正文（edit 前的确认话术）——正常转发
  emitDelta('<think>revert the change in controller');
  emitDelta('</think>明白了，回退上次的改动。');
  endAssistant('<think>revert the change in controller</think>明白了，回退上次的改动。');

  // 消息2：纯思考（无正文，对应后续 edit 工具调用）
  emitDelta('<think>checking the edit result</think>');
  endAssistant('<think>checking the edit result</think>');

  // 消息3：又是纯思考（对应 read 工具调用）——修复前这里会把消息1正文整段重发
  emitDelta('<think>reading the file back</think>');
  endAssistant('<think>reading the file back</think>');

  // 修复后：增量恰好等于消息1正文，一次性转发，无重复
  assert.deepEqual(deltas, ['明白了，回退上次的改动。']);
  assert.equal((deltas.join('').match(/明白了/g) ?? []).length, 1, '正文不得在流式增量中重复');
  // 终态 assistant 消息只有消息1一条（消息2/3 清洗后为空，不产生气泡）
  assert.deepEqual(assistantMessages, ['明白了，回退上次的改动。']);
});

test('正文消息后跟正文消息：第二条只转发自己的增量（消息级收敛不误伤）', async () => {
  const { session, listeners } = makeSilentFake();
  const adapter = new PiConversationAdapter(async () => ({ session, dispose: () => undefined }));

  const deltas: string[] = [];
  adapter.onDelta('session-two-text', (t) => deltas.push(t));

  await adapter.sendMessage('session-two-text', '继续');

  const emitDelta = (text: string): void => {
    for (const listener of listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: text } });
    }
  };
  const endAssistant = (text: string): void => {
    for (const listener of listeners) {
      listener({
        type: 'message_end',
        message: { role: 'assistant', content: [{ type: 'text', text }] },
      });
    }
  };

  // 消息1：正文 A
  emitDelta('第一段正文。');
  endAssistant('第一段正文。');
  // 消息2：另一段正文 B（工具调用之间的正常输出）
  emitDelta('<think>brief</think>第二段正文。');
  endAssistant('<think>brief</think>第二段正文。');

  assert.deepEqual(deltas, ['第一段正文。', '第二段正文。']);
});
