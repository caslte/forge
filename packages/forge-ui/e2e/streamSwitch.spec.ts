/**
 * 会话切换稳定性回归（E-CV 流式中切换会话）。
 * 覆盖：AI 回复进行中往返切换会话 + 工具消息聚合边界变化（单条 ↔ 组），
 * 不得触发 Vue patch 崩溃（emitsOptions null）亦不得残留 streaming。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  assertNoResidualStreaming,
  seedSessions,
  seedSendScript,
  waitForMock,
} from './helpers/index';

function mkSession(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    projectPath: 'D:/work/aiwork/forge',
    alias: null,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
    ...over,
  };
}

async function boot(page: Page, sessions: Array<Record<string, unknown>>): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
}

test('E-CV-SWITCH-001 @P0 @mock-backend：流式中会话往返切换 + 工具聚组变化，无 Vue patch 崩溃', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话A-工具流' });
  const b = mkSession({ alias: '会话B' });
  await boot(page, [a, b]);

  // A 历史：user + assistant（无 tool），便于观察流式中 tool 到达时形态切换
  await page.evaluate(
    ([sid, msgs]) => window.__forgeMock!.setHistory(sid, msgs),
    [
      a.sessionId,
      [
        { role: 'user', content: '改造这段代码', ts: new Date(Date.now() - 100000).toISOString() },
        { role: 'assistant', content: '我先看一下结构。', ts: new Date(Date.now() - 99000).toISOString() },
      ],
    ] as const,
  );

  // 流式脚本：tool 1条（单条形态）→ delta → tool 第2条（聚组成 group）→ delta → 结束
  const script = [
    { type: 'tool', delayMs: 40, payload: { toolEventId: 'ta-1', toolName: 'file.read', tool: { name: 'file.read', input: {} } } },
    { type: 'delta', delayMs: 40, payload: { text: '定位到', kind: 'text' } },
    { type: 'delta', delayMs: 40, payload: { text: '问题区域', kind: 'text' } },
    { type: 'tool', delayMs: 40, payload: { toolEventId: 'ta-2', toolName: 'Edit', tool: { name: 'Edit', input: {} } } },
    { type: 'delta', delayMs: 40, payload: { text: '，开始修改。', kind: 'text' } },
    { type: 'message', delayMs: 60, payload: { role: 'assistant', content: '完成修改，附上 diff。', ts: new Date().toISOString() } },
  ];
  await seedSendScript(page, a.sessionId as string, script);

  await page.locator('.tree-session', { hasText: '会话A-工具流' }).click();
  await page.locator('.compose-input').fill('帮我改代码');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.compose-box')).toHaveClass(/streaming/);

  // 流式/工具变化进行中：往返切换会话 3 次（触发 reset + reload + patch 结构突变）
  for (let i = 0; i < 3; i++) {
    await page.locator('.tree-session', { hasText: '会话B' }).click();
    await page.locator('.tree-session', { hasText: '会话A-工具流' }).click();
  }

  // 等待流结束并确认无残留 streaming（mock 的 message 事件同时写入历史与推送，
  // 切换回显后可能同文本出现两条，用 first 判定即可）
  await expect(page.locator('.msg-assistant', { hasText: '完成修改' }).first()).toBeVisible({ timeout: 8_000 });
  await page.evaluate(
    ([sid]) => window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' }),
    [a.sessionId] as const,
  );
  await assertNoResidualStreaming(page);

  // 关键：全程无 pageerror / console error（Vue patch 崩溃会在此暴露）
  health.assertHealthy();
  void waitForMock;
});