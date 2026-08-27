import { test } from 'node:test';
import assert from 'node:assert/strict';

import { PiSessionAdapter } from '../../src/pi/piSessionAdapter.ts';

test('PiSessionAdapter 生成稳定合法且非 mock 的 forge session ID', async () => {
  const adapter = new PiSessionAdapter();
  const first = await adapter.createSession('C:\\tmp\\project');
  const second = await adapter.createSession('C:\\tmp\\project');

  assert.notEqual(first, second);
  assert.doesNotMatch(first, /^mock-session-/);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});

test('PiSessionAdapter 停止与删除幂等成功', async () => {
  const adapter = new PiSessionAdapter();
  const sessionId = await adapter.createSession('C:\\tmp\\project');

  await assert.doesNotReject(adapter.stopSession(sessionId));
  await assert.doesNotReject(adapter.deleteSession(sessionId));
});
