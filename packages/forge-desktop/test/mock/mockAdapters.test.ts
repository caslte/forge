/**
 * Mock pi 适配器单元测试。
 *
 * 覆盖 forge-desktop 冒烟所需的 mock 行为契约：
 * - MockPiSessionAdapter.createSession 返回唯一递增 sessionId；stop/delete 记录调用且幂等
 * - MockPiConversationAdapter.sendMessage 追加 user 消息后异步产生 assistant 回复并触发 onReply
 * - MockPiConversationAdapter.loadHistory 返回 per-session 历史；cancelStream 记录调用无副作用
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；不引入新依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockPiSessionAdapter, MockPiConversationAdapter } from '../../src/mock/mockAdapters.ts';

/** 等待 mock 的 setTimeout(0) 回复回调执行（Node 会把 setTimeout(0) clamp 到 1ms） */
function waitForReply(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 50));
}

test('MockPiSessionAdapter.createSession 多次调用返回唯一递增 sessionId', async () => {
  const adapter = new MockPiSessionAdapter();
  const a = await adapter.createSession('/proj/a');
  const b = await adapter.createSession('/proj/b');
  assert.notEqual(a, b, '两次 createSession 不应返回相同 id');
  assert.ok(a.startsWith('mock-session-'), `id 应以 mock-session- 开头，实际: ${a}`);
  assert.ok(b.startsWith('mock-session-'), `id 应以 mock-session- 开头，实际: ${b}`);
});

test('MockPiSessionAdapter.stopSession/deleteSession 记录调用且重复调用不抛错', async () => {
  const adapter = new MockPiSessionAdapter();
  const id = await adapter.createSession('/proj/a');
  await adapter.stopSession(id);
  await adapter.stopSession(id); // 重复停止幂等
  await adapter.deleteSession(id);
  await adapter.deleteSession(id); // 重复删除幂等
  assert.equal(adapter.stopCalls.length, 2);
  assert.equal(adapter.deleteCalls.length, 2);
});

test('MockPiConversationAdapter.sendMessage 立即追加 user 消息，异步产生 assistant 回复并触发 onReply', async () => {
  const replies: { sessionId: string; message: { role: string; content: string } }[] = [];
  const adapter = new MockPiConversationAdapter({
    replyDelayMs: 0,
    onReply: (sessionId, message) => replies.push({ sessionId, message }),
  });
  await adapter.sendMessage('sess-1', '你好');
  // 立即查询：只有 user 消息
  const immediate = await adapter.loadHistory('sess-1');
  assert.equal(immediate.length, 1);
  assert.equal(immediate[0]?.role, 'user');
  assert.equal(immediate[0]?.content, '你好');
  // 等待异步回复
  await waitForReply();
  const after = await adapter.loadHistory('sess-1');
  assert.equal(after.length, 2, '回复后应有 user + assistant 两条消息');
  assert.equal(after[1]?.role, 'assistant');
  assert.equal(replies.length, 1, 'onReply 应被触发一次');
  assert.equal(replies[0]?.sessionId, 'sess-1');
  assert.equal(replies[0]?.message.role, 'assistant');
});

test('MockPiConversationAdapter 历史按会话隔离，loadHistory 返回副本不暴露内部', async () => {
  const adapter = new MockPiConversationAdapter({ replyDelayMs: 0 });
  await adapter.sendMessage('sess-a', 'A 消息');
  await adapter.sendMessage('sess-b', 'B 消息');
  await waitForReply();
  const a = await adapter.loadHistory('sess-a');
  const b = await adapter.loadHistory('sess-b');
  assert.equal(a.length, 2, 'sess-a 应有 user+assistant');
  assert.equal(b.length, 2, 'sess-b 应有 user+assistant');
  assert.equal(a[0]?.content, 'A 消息');
  assert.equal(b[0]?.content, 'B 消息');
  // 副本：修改返回值不影响内部
  a.push({ role: 'user', content: '篡改', ts: new Date().toISOString() });
  const aAgain = await adapter.loadHistory('sess-a');
  assert.equal(aAgain.length, 2, '修改副本不应影响内部历史');
});

test('MockPiConversationAdapter.cancelStream 记录调用且不抛错', async () => {
  const adapter = new MockPiConversationAdapter({ replyDelayMs: 0 });
  await adapter.cancelStream('sess-1');
  await adapter.cancelStream('sess-1');
  assert.equal(adapter.cancelCalls.length, 2);
});
