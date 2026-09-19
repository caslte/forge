/**
 * 重构冒烟（think-1788488643459）：多窗口会话窗口直接渲染 ConversationView。
 *
 * 合并前：窗口内是 MultiWindowConversation（.wc-view）——本用例 failed；
 * 合并后：薄壳渲染 ConversationView（.conv-view），单/多窗口同一组件——passed。
 * 同时锁定薄壳契约：模型状态仍在薄壳（currentModel 经 model/getSessionModel 加载）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, seedHistory } from './helpers/index';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: 'sess-mw-convview',
    projectPath: 'D:/work/aiwork/forge',
    alias: '合并冒烟',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

async function dragIn(page: Page): Promise<void> {
  const sessionEl = page.locator('.tree-session', { hasText: '合并冒烟' }).first();
  const canvas = page.locator('.mw-canvas');
  const box = (await canvas.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await sessionEl.dispatchEvent('dragstart', { dataTransfer });
  await canvas.dispatchEvent('dragover', {
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    dataTransfer,
  });
  await canvas.dispatchEvent('drop', {
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    dataTransfer,
  });
  await expect(page.locator('.mw-win')).toBeVisible();
}

test('多窗口窗口内渲染 ConversationView（单/多窗口同组件） @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();

  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();
  await dragIn(page);

  // 合并的核心断言：窗口内是单视图同一组件根
  await expect(page.locator('.mw-win .conv-view')).toBeVisible();
  // 输入框同源（单视图同款 compose-box）
  await expect(page.locator('.mw-win .compose-box')).toBeVisible();

  health.assertHealthy();
});

test('多窗口窄窗格长行不撑宽窗口，发送按钮不被裁 @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  const sid = 'sess-mw-wide';
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await seedHistory(page, sid, [
    { id: 'w1', role: 'user', content: '执行这个请求', ts: '2026-09-04T01:00:00.000Z' },
    // 无空格长 token：min-content 远超窄窗格宽
    { id: 'w2', role: 'assistant', content: 'curl -X POST http://example-service.internal.cluster.svc.local:8080/api/v2/legacy/endpoint/very/long/path?token=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ts: '2026-09-04T01:00:10.000Z' },
  ]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();

  // 矮宽视口 → 自动布局后窗格很矮，长行内容 + 输入区共存
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();
  await dragIn(page);
  await page.locator('.app-toolbar-btn', { hasText: '自动布局' }).click();
  await expect(page.locator('.mw-win .compose-box')).toBeVisible();

  // 窗口不得被内容撑宽：视图根宽度 ≤ 窗口宽度
  const overflow = await page.evaluate(() => {
    const win = (document.querySelector('.mw-win') as HTMLElement).getBoundingClientRect();
    const view = (document.querySelector('.mw-win .conv-view') as HTMLElement).getBoundingClientRect();
    const send = document.querySelector('.mw-win .send-btn, .mw-win .cancel-btn') as HTMLElement | null;
    const sr = send?.getBoundingClientRect();
    return {
      viewOver: Math.round(view.width - win.width),
      sendVisible: !!sr && sr.width > 0 && sr.right <= win.right && sr.left >= win.left,
    };
  });
  expect(overflow.viewOver, `会话视图被撑宽 ${overflow.viewOver}px`).toBeLessThanOrEqual(1);
  expect(overflow.sendVisible, '发送按钮被裁剪不可见').toBe(true);

  health.assertHealthy();
});
