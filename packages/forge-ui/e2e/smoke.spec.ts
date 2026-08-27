import { test, expect } from '@playwright/test';
import { waitForMock } from './helpers/index';

test('smoke：应用可加载，mock-bridge 注入，会话树渲染', async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  await expect(page.locator('.workspace-brand')).toHaveText('FORGE');
  await expect(page.locator('.tree-panel')).toBeVisible();
  // 默认种子提供 2 个会话
  await expect(page.locator('.tree-session')).toHaveCount(2);
});