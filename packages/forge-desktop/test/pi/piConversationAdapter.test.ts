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
}

/** 工具事件捕获器（P1-A 映射验证） */
interface ToolCapture {
  started: Array<{ toolEventId: string; name: string; input: unknown }>;
  completed: Array<{ toolEventId: string; text: string | null }>;
  errors: Array<{ toolEventId: string; message: string }>;
}

function captureToolHandlers(adapter: PiConversationAdapter): ToolCapture {
  const cap: ToolCapture = { started: [], completed: [], errors: [] };
  adapter.setEventHandlers({
    onToolStarted: (_sid, e) => cap.started.push({ toolEventId: e.toolEventId, name: e.tool.name, input: e.tool.input }),
    onToolCompleted: (_sid, e) => cap.completed.push({ toolEventId: e.toolEventId, text: e.result.text }),
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
  assert.deepEqual(cap.completed, [{ toolEventId: 'call-1', text: '文件内容' }]);
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

// ===== P3-B：附件 =====

test('P3-B：图片附件经 normalizeImages 转为 pi image content 随 prompt 透传', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose() }),
    { resolveModel: async (model) => ({ resolved: model }) },
  );
  await adapter.sendMessage('session-att', '看图', {
    attachments: [
      { kind: 'image', name: 'photo.png', mimeType: 'image/png', data: 'aGVsbG8=' },
    ],
  });
  assert.equal(fake.imageCalls.length, 1, '附图时应传 images 参数');
  const images = fake.imageCalls[0] as { images: Array<{ type: string; data: string; mimeType: string }> };
  assert.deepEqual(images.images, [
    { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
  ]);
});

test('P3-B：无附件时不传 images（与旧行为一致），文本附件不转图片', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose() }),
    { resolveModel: async (model) => ({ resolved: model }) },
  );
  await adapter.sendMessage('session-plain', '纯文本');
  assert.equal(fake.imageCalls.length, 0, '纯文本不带 images 参数');
  await adapter.sendMessage('session-text-att', '带文本附件', {
    attachments: [{ kind: 'text', name: 'a.txt', content: '附件内容' }],
  });
  assert.equal(fake.imageCalls.length, 0, '文本附件不转图片');
});

test('P3-B：无效图片附件（空 data / 非 image）被过滤不抛错', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(
    async () => ({ session: fake, dispose: () => fake.dispose() }),
    { resolveModel: async (model) => ({ resolved: model }) },
  );
  await adapter.sendMessage('session-bad-att', '带坏附件', {
    attachments: [
      { kind: 'text', name: 't.md', content: 'x' },
      { kind: 'image', name: 'empty.png', mimeType: 'image/png', data: '' },
      { kind: 'image', name: 'ok.png', mimeType: 'image/png', data: 'ZGF0YQ==' },
    ],
  });
  assert.equal(fake.imageCalls.length, 1, '空 data 图片过滤，有效图片保留');
  const images = fake.imageCalls[0] as { images: Array<{ data: string }> };
  assert.equal(images.images.length, 1);
  assert.equal(images.images[0]?.data, 'ZGF0YQ==');
});
