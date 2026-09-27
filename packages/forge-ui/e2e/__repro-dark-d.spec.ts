/**
 * 一次性验证：暗色全局主题 D 档（设计稿复刻，不加磨砂）迁移到生产代码后的整窗效果。
 * 截图（会话视图 + hero）+ 关键元素计算背景采样，供与原型 D 档对照。
 */
import { test, expect } from '@playwright/test';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: 'sess-d',
    projectPath: 'D:/work/aiwork/forge',
    alias: 'D档底色验证',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

test('repro: dark theme D 档截图与采样', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  // main.ts 经动态 import 注入 mock-bridge，goto 返回时可能尚未挂上，先等
  await page.waitForFunction(() => Boolean((window as unknown as { __forgeMock?: unknown }).__forgeMock), undefined, { timeout: 15_000 });
  await page.evaluate((list) => window.__forgeMock!.setSessions(list), [mkSession()]);
  await page.reload();
  await expect(page.locator('.tree-session')).toBeVisible({ timeout: 15_000 });

  // hero 态截图（未进会话）
  await page.waitForTimeout(600);
  await page.screenshot({ path: '../../.workbuddy/tmp/bgtone/prod-dark-d-hero.png' });

  // 会话态截图
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await page.waitForTimeout(600);
  await page.screenshot({ path: '../../.workbuddy/tmp/bgtone/prod-dark-d-conv.png' });

  // 关键元素计算样式采样
  const data = await page.evaluate(() => {
    const pick = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const cs = getComputedStyle(el);
      return { bg: cs.backgroundColor, bgImage: cs.backgroundImage.slice(0, 90) };
    };
    return {
      theme: document.documentElement.getAttribute('data-theme'),
      appContainer: pick('.app-container'),
      shellSheen: pick('.shell-sheen'),
      sidebar: pick('.sidebar'),
      appToolbar: pick('.app-toolbar'),
      content: pick('.content'),
      body: pick('body'),
    };
  });
  console.log('DARK-D-SAMPLE:', JSON.stringify(data, null, 1));
  expect(data.theme).toBe('dark');
  expect(data.shellSheen?.bgImage).toContain('213.4deg');
  expect(data.sidebar?.bgImage).toContain('180deg');
});
