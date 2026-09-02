/**
 * 对话与消息 RPC 方法层（conversationMethods）单元测试。
 *
 * 覆盖 docs/test/03_conversation/coverage-matrix.md api 层用例：
 * - A-CV-001：sendMessage → code 0，adapter 调用正确，成功后发射 conversation.statusChanged
 * - A-CV-002：cancelStream → code 0，streaming 状态调用 adapter.cancelStream
 * - A-CV-003：queryHistory → 按 ts 升序返回消息列表
 * 以及本 WU 契约：参数校验 1001、provider 未配置 1004、会话不存在 1002、
 * 异常隔离 5000（不泄漏异常细节）、事件 conversation.statusChanged / conversation.delta /
 * conversation.message / conversation.error 发射、信封恒为 { code, message, data }。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；pi 会话操作经 MockConversationAdapter
 * 注入，事件经 EventEmitter 汇捕获。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConversationService } from '../../src/conversation/conversationService.ts';
import { ConversationApi } from '../../src/rpc/conversationMethods.ts';
import { TEXT_ATTACHMENT_PREAMBLE } from '../../src/conversation/conversationService.ts';
import type { PiConversationAdapter, ConversationMessage } from '../../src/conversation/conversationService.ts';
import type { RpcResult } from '../../src/rpc/projectMethods.ts';

/** 可注入的 pi 会话适配器 mock：记录调用、可配置抛错 */
class MockConversationAdapter implements PiConversationAdapter {
  sendCalls: Array<{ sessionId: string; content: string }> = [];
  cancelCalls: string[] = [];
  history: ConversationMessage[] = [];
  /** 置为非 null 时 sendMessage 抛出该错误（模拟 pi 发送失败 → 5000） */
  sendError: Error | null = null;
  /** 置为非 null 时 cancelStream 抛出该错误（模拟取消失败 → 5000） */
  cancelError: Error | null = null;
  /** 置为非 null 时 loadHistory 抛出该错误（模拟历史加载失败 → 5000） */
  loadError: Error | null = null;

  async sendMessage(sessionId: string, content: string): Promise<void> {
    this.sendCalls.push({ sessionId, content });
    if (this.sendError !== null) {
      throw this.sendError;
    }
  }

  async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    if (this.loadError !== null) {
      throw this.loadError;
    }
    return this.history;
  }

  async cancelStream(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
    if (this.cancelError !== null) {
      throw this.cancelError;
    }
  }
}

/** 构造 api + 事件汇 + 服务 + mock adapter */
function makeApi(options: {
  sessionExists?: (sessionId: string) => boolean;
  providerReady?: () => boolean;
} = {}): {
  api: ConversationApi;
  events: EventEmitter;
  service: ConversationService;
  adapter: MockConversationAdapter;
} {
  const adapter = new MockConversationAdapter();
  const service = new ConversationService(adapter, options);
  const events = new EventEmitter();
  const api = new ConversationApi(service, events);
  return { api, events, service, adapter };
}

test('A-CV-01：sendMessage 返回 0 + data null，adapter 调用正确', async () => {
  const { api, adapter } = makeApi();
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: '你好' });
  assert.equal(result.code, 0);
  assert.equal(result.data, null);
  assert.deepEqual(adapter.sendCalls, [{ sessionId: 'sess-1', content: '你好' }]);
});

test('conversation/sendMessage：成功后发射 conversation.statusChanged（streaming）', async () => {
  const { api, events } = makeApi();
  const changed: unknown[] = [];
  events.on('conversation.statusChanged', (payload) => changed.push(payload));
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' });
  assert.equal(result.code, 0);
  assert.equal(changed.length, 1, 'conversation.statusChanged 应发射一次');
  assert.deepEqual(changed[0], { sessionId: 'sess-1', status: 'streaming' });
});

test('conversation/sendMessage：content 为空/空白返回 1001，adapter 不被调用', async () => {
  const { api, adapter } = makeApi();
  assert.equal((await api.methods['conversation/sendMessage']({ sessionId: 'sess-1' })).code, 1001);
  assert.equal((await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: '   ' })).code, 1001);
  assert.equal((await api.methods['conversation/sendMessage']({ content: 'hi' })).code, 1001);
  assert.equal((await api.methods['conversation/sendMessage'](null)).code, 1001);
  assert.equal(adapter.sendCalls.length, 0);
});

test('conversation/sendMessage：provider 未配置返回 1004，adapter 不被调用', async () => {
  const { api, adapter } = makeApi({ providerReady: () => false });
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' });
  assert.equal(result.code, 1004);
  assert.equal(result.data, null);
  assert.equal(adapter.sendCalls.length, 0);
});

test('conversation/sendMessage：streaming 中重复发送返回 1001 并保留 streaming', async () => {
  const { api, service, adapter, events } = makeApi();
  service.setStatus('sess-1', 'streaming', { lastDeltaText: 'partial' });
  const changed: unknown[] = [];
  events.on('conversation.statusChanged', (payload) => changed.push(payload));

  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'again' });

  assert.equal(result.code, 1001);
  assert.equal(adapter.sendCalls.length, 0);
  assert.equal(changed.length, 0);
  assert.equal(service.getStatus('sess-1'), 'streaming');
});

test('conversation/sendMessage：会话不存在返回 1002，adapter 不被调用', async () => {
  const { api, adapter } = makeApi({ sessionExists: () => false });
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-ghost', content: 'hi' });
  assert.equal(result.code, 1002);
  assert.equal(result.data, null);
  assert.equal(adapter.sendCalls.length, 0);
});

test('A-CV-003：conversation/queryHistory 返回按 ts 升序的消息列表', async () => {
  const { api, adapter } = makeApi();
  adapter.history = [
    { role: 'assistant', content: 'b', ts: '2026-01-01T00:00:02Z' },
    { role: 'user', content: 'a', ts: '2026-01-01T00:00:01Z' },
  ];
  const result = await api.methods['conversation/queryHistory']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const messages = (result.data as { messages: ConversationMessage[] }).messages;
    assert.deepEqual(messages.map((m) => m.content), ['a', 'b'], '按 ts 升序');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'], '角色保留');
  }
});

test('conversation/queryHistory：sessionId 缺失返回 1001', async () => {
  const { api } = makeApi();
  assert.equal((await api.methods['conversation/queryHistory']({})).code, 1001);
});

test('A-CV-002：conversation/cancelStream（streaming）返回 0 + data null，adapter 调用正确', async () => {
  const { api, service, adapter } = makeApi();
  service.setStatus('sess-1', 'streaming');
  const result = await api.methods['conversation/cancelStream']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.equal(result.data, null);
  assert.deepEqual(adapter.cancelCalls, ['sess-1']);
});

test('conversation/cancelStream：非 streaming 幂等成功，adapter 不被调用', async () => {
  const { api, adapter } = makeApi();
  const result = await api.methods['conversation/cancelStream']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0, '幂等：空闲取消无副作用');
  assert.equal(adapter.cancelCalls.length, 0);
});

test('conversation/cancelStream：sessionId 缺失返回 1001', async () => {
  const { api } = makeApi();
  assert.equal((await api.methods['conversation/cancelStream']({})).code, 1001);
});

test('异常隔离：adapter 抛错返回 5000，透传实际错误信息（便于定位 key/模型配置问题）', async () => {
  const { api, adapter } = makeApi();
  adapter.sendError = new Error('pi send failed');
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' });
  assert.equal(result.code, 5000);
  assert.equal(result.data, null);
  assert.equal(result.message, 'pi send failed');
  assert.ok(result.message.includes('pi send failed'));
});

test('异常隔离：queryHistory adapter 抛错返回 5000，data null', async () => {
  const { api, adapter } = makeApi();
  adapter.loadError = new Error('load failed');
  const result = await api.methods['conversation/queryHistory']({ sessionId: 'sess-1' });
  assert.equal(result.code, 5000);
  assert.equal(result.data, null);
});

test('事件：pushStatus 发射 conversation.statusChanged（sessionId/status）', async () => {
  const { api, events } = makeApi();
  const changed: unknown[] = [];
  events.on('conversation.statusChanged', (payload) => changed.push(payload));
  api.pushStatus('sess-1', 'streaming');
  assert.equal(changed.length, 1, 'conversation.statusChanged 应发射一次');
  assert.deepEqual(changed[0], { sessionId: 'sess-1', status: 'streaming' });
});

test('事件：pushDelta 发射 conversation.delta（sessionId/delta）', async () => {
  const { api, events } = makeApi();
  const deltas: unknown[] = [];
  events.on('conversation.delta', (payload) => deltas.push(payload));
  api.pushDelta('sess-1', '修');
  assert.equal(deltas.length, 1, 'conversation.delta 应发射一次');
  assert.deepEqual(deltas[0], { sessionId: 'sess-1', delta: { text: '修', kind: 'text' } });
});

test('事件：emitMessage 发射 conversation.message（sessionId/message）', async () => {
  const { api, events } = makeApi();
  const messages: unknown[] = [];
  events.on('conversation.message', (payload) => messages.push(payload));
  api.emitMessage('sess-1', { role: 'assistant', content: 'hi', ts: '2026-01-01T00:00:00Z' });
  assert.equal(messages.length, 1, 'conversation.message 应发射一次');
  assert.deepEqual(messages[0], {
    sessionId: 'sess-1',
    message: { role: 'assistant', content: 'hi', ts: '2026-01-01T00:00:00Z' },
  });
});

test('事件：emitError 发射 conversation.error（sessionId/code/message）', async () => {
  const { api, events } = makeApi();
  const errors: unknown[] = [];
  events.on('conversation.error', (payload) => errors.push(payload));
  api.emitError('sess-1', 5000, 'stream interrupted');
  assert.equal(errors.length, 1, 'conversation.error 应发射一次');
  assert.deepEqual(errors[0], { sessionId: 'sess-1', code: 5000, message: 'stream interrupted' });
});

test('信封：所有方法返回 { code, message, data }', async () => {
  const { api } = makeApi();
  const results: RpcResult[] = [];
  results.push(await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' }));
  results.push(await api.methods['conversation/cancelStream']({ sessionId: 'sess-1' }));
  results.push(await api.methods['conversation/queryHistory']({ sessionId: 'sess-1' }));
  results.push(await api.methods['conversation/sendMessage']({}));
  results.push(await api.methods['conversation/queryHistory']({}));
  for (const r of results) {
    assert.deepEqual(Object.keys(r).sort(), ['code', 'data', 'message'], '信封恒为 { code, message, data }');
  }
});

test('conversation/sendMessage：文本附件拼入受控 prompt 片段，图片附件透传（P3-B）', async () => {
  const { api, adapter } = makeApi();
  const result = await api.methods['conversation/sendMessage']({
    sessionId: 'sess-1',
    content: '读一下',
    attachments: [
      { kind: 'text', name: 'readme.md', content: '项目说明' },
      { kind: 'image', name: 'pic.png', mimeType: 'image/png', data: 'YWJj' },
    ],
  });
  assert.equal(result.code, 0);
  assert.equal(adapter.sendCalls.length, 1);
  const call0 = adapter.sendCalls[0]!;
  // 文本附件以「不可信数据声明 + [附件：name] 片段」拼入 content；图片附件仅在 options 透传
  assert.match(call0.content, new RegExp(`^读一下\\n\\n${TEXT_ATTACHMENT_PREAMBLE}\\n\\n\\[附件：readme\\.md\\]\\n项目说明$`));
});
