import { test, expect } from '@playwright/test';
import { waitForMock, expandProject } from './helpers/index';

test('smoke：应用可加载，mock-bridge 注入，会话树渲染', async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  // 品牌位现为官方 logo 图（757f328 替换内联 SVG/文字后），断言图形在场即可
  await expect(page.locator('.tb-logo')).toBeVisible();
  await expect(page.locator('.tree-panel')).toBeVisible();
  // v6.26 默认折叠：项目文件夹默认全收起，展开后才能看到默认种子的 4 个会话
  // （代码审查 / 修 SSE 断流 / 跑在途分析 / 数据清洗已完成）
  // 注意：折叠是 grid 0fr 裁剪，会话行 bbox 仍在文档流里（Playwright 判定其"可见"），
  // 折叠态的可观测标志是按钮/箭头的 aria-label，而非 :visible 计数
  await expect(page.locator('.tree-project')).toHaveCount(1);
  await expect(page.locator('.fold-all-btn')).toHaveAttribute('aria-label', '展开全部项目');
  await expect(page.locator('.tree-project .tree-arrow')).toHaveAttribute('aria-label', '展开项目');
  await expandProject(page, 'D:/work/aiwork/forge');
  await expect(page.locator('.tree-project .tree-arrow')).toHaveAttribute('aria-label', '折叠项目');
  await expect(page.locator('.fold-all-btn')).toHaveAttribute('aria-label', '收起全部项目');
  await expect(page.locator('.tree-session')).toHaveCount(4);
});