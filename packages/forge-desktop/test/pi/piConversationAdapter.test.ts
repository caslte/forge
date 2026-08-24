import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  PiConversationAdapter,
  type PiAgentSessionFactory,
} from '../../src/pi/piConversationAdapter.ts';

type Listener = (event: { type: string; delta?: string }) => void;

class FakePiSession {
  readonly listeners = new Set<Listener>();
  promptCalls: string[] = [];
  abortCalls = 0;
  disposed = false;

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
    const assistant = { role: 'assistant', content: '' };
    for (const listener of this.listeners) listener({ type: 'message_start', message: assistant });
    for (const listener of this.listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { delta: '你好' } });
    }
    for (const listener of this.listeners) {
      listener({ type: 'message_update', assistantMessageEvent: { delta: '，forge' } });
    }
    for (const listener of this.listeners) listener({
      type: 'message_end',
      message: { role: 'assistant', content: '你好，forge' },
    });
  }

  async abort(): Promise<void> {
    this.abortCalls += 1;
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

test('发送完成后从当前会话读取助手历史', async () => {
  const fake = new FakePiSession();
  const adapter = new PiConversationAdapter(async () => ({ session: fake, dispose: () => fake.dispose() }));
  await adapter.sendMessage('session-3', '你好', {});

  const history = await adapter.loadHistory('session-3');

  assert.equal(history.length, 1);
  assert.equal(history[0]?.role, 'assistant');
  assert.equal(history[0]?.content, '你好，forge');
});
