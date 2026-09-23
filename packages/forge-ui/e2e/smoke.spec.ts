import { test, expect } from '@playwright/test';
import { waitForMock } from './helpers/index';

test('smoke：应用可加载，mock-bridge 注入，会话树渲染', async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  // 品牌位现为官方 logo 图（757f328 替换内联 SVG/文字后），断言图形在场即可
  await expect(page.locator('.tb-logo')).toBeVisible();
  await expect(page.locator('.tree-panel')).toBeVisible();
  // 默认种子提供 4 个会话（代码审查 / 修 SSE 断流 / 跑在途分析 / 数据清洗已完成）
  await expect(page.locator('.tree-session')).toHaveCount(4);
});