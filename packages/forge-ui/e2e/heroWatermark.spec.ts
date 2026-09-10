/**
 * 空会话 hero 水印与加载态互斥回归。
 *
 * 约束：加载历史期间不展示任何水印。hero 的 260ms 离场淡出不得与
 * 「加载历史消息」同屏（此前从空会话切走时出现 forge 虚影残留）。
 * 实现：ConversationView 在 loadingHistory 期间给 Transition 置 :css=false，
 * hero 随加载开始同一 tick 直接移除。
 */
import { test, expect } from '@playwright/test';
import { attachHealthGuards, seedSessions, seedHistory, waitForMock } from './helpers/index';

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

test('E-CV-HERO-001 @mock-backend 从空会话切走加载历史时 hero 无虚影残留', async ({ page }) => {
  const health = attachHealthGuards(page);
  const empty = mkSession({ alias: '空会话HERO' });
  const full = mkSession({ alias: '满会话HERO' });
  await page.goto('/');
  await seedSessions(page, [empty, full]);
  await seedHistory(page, full.sessionId as string, [
    { role: 'user', content: 'hi', ts: new Date().toISOString() },
    { role: 'assistant', content: 'hello', ts: new Date().toISOString() },
  ]);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();

  // 空会话：hero 水印可见（前置条件）
  await page.locator('.tree-session', { hasText: '空会话HERO' }).click();
  await expect(page.locator('.conv-hero')).toBeVisible();

  // 给 queryHistory 加 1s 延迟，制造稳定的加载窗口
  await page.evaluate(() => {
    const b = (window as unknown as { forge: { invoke: (...a: never[]) => Promise<unknown> } }).forge;
    const orig = b.invoke.bind(b);
    b.invoke = (async (m: unknown, p: unknown) => {
      if (m === 'conversation/queryHistory') {
        await new Promise((r) => setTimeout(r, 1000));
      }
      return orig(m as never, p as never);
    }) as typeof b.invoke;
  });

  // 切到满会话：进入加载态
  await page.locator('.tree-session', { hasText: '满会话HERO' }).click();
  await expect(page.locator('.conv-loading')).toBeVisible();

  // 加载中段（150ms，落在原来 260ms 离场过渡窗口内）：不得有 hero 虚影
  await page.waitForTimeout(150);
  await expect(page.locator('.conv-loading')).toBeVisible();
  await expect(page.locator('.conv-hero')).toHaveCount(0);

  // 加载完成后：消息正常渲染，仍无 hero
  await expect(page.locator('.conv-loading')).toHaveCount(0);
  await expect(page.locator('.conv-hero')).toHaveCount(0);

  health.assertHealthy();
});
