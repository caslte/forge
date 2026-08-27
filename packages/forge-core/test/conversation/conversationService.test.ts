/**
 * 对话与消息服务（conversationService）单元测试。
 *
 * 覆盖 docs/test/03_conversation/coverage-matrix.md 本 WU 用例：
 * - U-CV-001：sendMessage 空/空白消息校验失败，不触发 adapter（AC-CV-002）
 * - A-CV-001：发送成功进入 streaming，adapter.sendMessage 调用一次（AC-CV-001）
 * - A-CV-002：provider 未配置返回 1004，不崩溃（AC-CV-003）
 * - A-CV-005：取消保留已生成内容、重复取消幂等（AC-CV-009/010）
 * - A-CV-006：历史全量加载、角色区分、顺序正确（AC-CV-011/012）
 * 以及本 WU 契约：会话不存在 1002、adapter 异常 5000 错误联合、多会话状态隔离。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；pi 会话操作经 MockPiConversationAdapter
 * 注入（服务不 import pi）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../../src/conversation/conversationService.ts';
import type {
  ConversationMessage,
  ConversationServiceOptions,
  ConversationStatus,
  PiConversationAdapter,
} from '../../src/conversation/conversationService.ts';

/** 可注入的 pi 会话适配器 mock：记录调用、可配置历史与抛错 */
class MockPiConversationAdapter implements PiConversationAdapter {
  sendCalls: Array<{ sessionId: string; content: string }> = [];
  cancelCalls: string[] = [];
  /** 会话历史（sessionId -> 消息列表），未设置返回空 */
  history: Map<string, ConversationMessage[]> = new Map();
  /** 置为非 null 时 loadHistory 抛出该异常（模拟历史加载失败） */
  loadError: Error | null = null;

  async sendMessage(sessionId: string, content: string): Promise<void> {
    this.sendCalls.push({ sessionId, content });
  }

  async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    if (this.loadError !== null) {
      throw this.loadError;
    }
    return this.history.get(sessionId) ?? [];
  }

  async cancelStream(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
  }
}

/** 构造服务 + mock adapter（可选注入构造选项） */
function makeService(
  options?: ConversationServiceOptions,
): { service: ConversationService; adapter: MockPiConversationAdapter } {
  const adapter = new MockPiConversationAdapter();
  return { service: new ConversationService(adapter, options), adapter };
}

test('sendMessage：空/纯空白消息返回 1001，adapter 不被调用（U-CV-001/AC-CV-002）', async () => {
  const { service, adapter } = makeService();
  for (const content of ['', '   ', '\t\n']) {
    const result = await service.sendMessage('sess-1', content);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
      assert.equal(result.message, '消息不能为空');
    }
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('sendMessage：会话不存在返回 1002，adapter 不被调用', async () => {
  const { service, adapter } = makeService({ sessionExists: (id) => id === 'sess-known' });
  const result = await service.sendMessage('sess-unknown', 'hi');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1002);
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('sendMessage：provider 未配置返回 1004，adapter 不被调用（A-CV-002/AC-CV-003）', async () => {
  const { service, adapter } = makeService({ providerReady: () => false });
  const result = await service.sendMessage('sess-1', 'hi');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1004);
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('sendMessage：未注入 sessionExists/providerReady 时跳过校验', async () => {
  const { service, adapter } = makeService();
  const result = await service.sendMessage('sess-any', 'hi');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-any'), 'streaming');
  assert.equal(adapter.sendCalls.length, 1);
});

test('sendMessage：成功进入 streaming，adapter.sendMessage 调用一次（A-CV-001/AC-CV-001）', async () => {
  const { service, adapter } = makeService({ sessionExists: () => true, providerReady: () => true });
  const result = await service.sendMessage('sess-1', 'hi');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-1'), 'streaming');
  assert.deepEqual(adapter.sendCalls, [{ sessionId: 'sess-1', content: 'hi' }]);
});

test('sendMessage：streaming 中重复发送返回 1001，adapter 不被调用', async () => {
  const { service, adapter } = makeService();
  service.setStatus('sess-1', 'streaming', { lastDeltaText: 'partial' });

  const result = await service.sendMessage('sess-1', 'again');

  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1001);
    assert.match(result.message, /正在流式响应/);
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('cancelStream：streaming 中取消 -> canceled，adapter 调用，已生成内容保留（A-CV-005/AC-CV-009）', async () => {
  const { service, adapter } = makeService();
  service.setStatus('sess-1', 'streaming', { lastDeltaText: 'partial reply' });
  const result = await service.cancelStream('sess-1');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-1'), 'canceled');
  assert.deepEqual(adapter.cancelCalls, ['sess-1']);
  assert.equal(service.getStreamState('sess-1').lastDeltaText, 'partial reply');
});

test('cancelStream：重复取消幂等，adapter 只调用一次（AC-CV-009 幂等）', async () => {
  const { service, adapter } = makeService();
  service.setStatus('sess-1', 'streaming');
  await service.cancelStream('sess-1');
  await service.cancelStream('sess-1');
  await service.cancelStream('sess-1');
  assert.equal(service.getStatus('sess-1'), 'canceled');
  assert.deepEqual(adapter.cancelCalls, ['sess-1']);
});

test('cancelStream：idle 状态取消为无副作用成功', async () => {
  const { service, adapter } = makeService();
  const result = await service.cancelStream('sess-1');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-1'), 'idle');
  assert.equal(adapter.cancelCalls.length, 0);
});

test('queryHistory：全量加载并按 ts 升序，角色保留（A-CV-006/AC-CV-011/012）', async () => {
  const { service, adapter } = makeService();
  adapter.history.set('sess-1', [
    { role: 'assistant', content: 'b', ts: '2026-01-01T00:00:02.000Z' },
    { role: 'user', content: 'a', ts: '2026-01-01T00:00:01.000Z' },
    { role: 'tool', content: 'c', ts: '2026-01-01T00:00:03.000Z' },
  ]);
  const result = await service.queryHistory('sess-1');
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(
      result.data.messages.map((m) => m.role),
      ['user', 'assistant', 'tool'],
    );
    assert.deepEqual(
      result.data.messages.map((m) => m.content),
      ['a', 'b', 'c'],
    );
  }
});

test('queryHistory：adapter 抛错返回 5000 错误联合，不崩溃', async () => {
  const { service, adapter } = makeService();
  adapter.loadError = new Error('jsonl read failed');
  const result = await service.queryHistory('sess-1');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 5000);
  }
});

test('onStatusChange：状态流转触发注入回调（rpc 接线注入点）', async () => {
  const changes: Array<{ sessionId: string; status: ConversationStatus }> = [];
  const { service } = makeService({
    onStatusChange: (sessionId, status) => {
      changes.push({ sessionId, status });
    },
  });
  await service.sendMessage('sess-1', 'hi');
  await service.cancelStream('sess-1');
  assert.deepEqual(changes, [
    { sessionId: 'sess-1', status: 'streaming' },
    { sessionId: 'sess-1', status: 'canceled' },
  ]);
});

test('多会话独立：10 会话交错状态流转互不干扰（状态隔离）', async () => {
  const { service, adapter } = makeService();
  const ids = Array.from({ length: 10 }, (_, i) => `sess-${i}`);
  for (const id of ids) {
    service.setStatus(id, 'streaming', { lastDeltaText: `partial-${id}` });
  }
  const toCancel = ids.filter((_, i) => i % 2 === 0);
  for (const id of toCancel) {
    await service.cancelStream(id);
  }
  for (const [i, id] of ids.entries()) {
    assert.equal(service.getStatus(id), i % 2 === 0 ? 'canceled' : 'streaming');
  }
  // 已取消会话保留各自累积内容，未取消会话内容不受影响
  assert.equal(service.getStreamState('sess-0').lastDeltaText, 'partial-sess-0');
  assert.equal(service.getStreamState('sess-1').lastDeltaText, 'partial-sess-1');
  assert.equal(service.getStreamState('sess-9').lastDeltaText, 'partial-sess-9');
  assert.deepEqual(adapter.cancelCalls, ['sess-0', 'sess-2', 'sess-4', 'sess-6', 'sess-8']);
});

// ===== P3-A：上下文用量与压缩 =====

test('getContextUsage：adapter 支持时返回用量，未支持时返回 null 数据（P3-A）', async () => {
  // 未实现 getContextUsage 的 adapter → null（UI 显示未知，不算错误）
  const { service } = makeService({ sessionExists: () => true });
  const none = await service.getContextUsage('sess-x');
  assert.ok(none.ok);
  assert.equal(none.data?.usage, null);

  // 实现 getContextUsage 的 adapter → 透传用量
  const usageAdapter = new MockPiConversationAdapter();
  usageAdapter.getContextUsage = () => ({ tokens: 4200, contextWindow: 128000, percent: 3.3 });
  const svc = new ConversationService(usageAdapter, { sessionExists: () => true });
  const res = await svc.getContextUsage('sess-x');
  assert.ok(res.ok);
  assert.equal(res.data?.usage?.tokens, 4200);
  assert.equal(res.data?.usage?.percent, 3.3);
});

test('getContextUsage：空参数 1001 / 会话不存在 1002', async () => {
  const { service } = makeService({ sessionExists: (id) => id === 'sess-known' });
  const empty = await service.getContextUsage('');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 1001);
  const unknown = await service.getContextUsage('ghost');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, 1002);
});

test('compact：adapter 支持时返回结果，不支持时明确失败不破坏历史（P3-A）', async () => {
  const { service } = makeService({ sessionExists: () => true });
  const unsupported = await service.compact('sess-x');
  assert.ok(unsupported.ok);
  assert.equal(unsupported.data?.result.ok, false);

  const compactAdapter = new MockPiConversationAdapter();
  compactAdapter.compact = async () => ({ ok: true, message: '压缩完成' });
  const svc = new ConversationService(compactAdapter, { sessionExists: () => true });
  const res = await svc.compact('sess-x');
  assert.ok(res.ok);
  assert.equal(res.data?.result.ok, true);
  assert.equal(res.data?.result.message, '压缩完成');
});

test('compact：压缩异常返回失败信息且不抛出（P3-A 手动压缩失败不破坏历史）', async () => {
  const failAdapter = new MockPiConversationAdapter();
  failAdapter.compact = async () => {
    throw new Error('provider 超时');
  };
  const svc = new ConversationService(failAdapter, { sessionExists: () => true });
  const res = await svc.compact('sess-x');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 5000);
    assert.match(res.message, /压缩失败/);
  }
});
