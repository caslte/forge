/**
 * 插件市场 E2E（07 扩展）：设置页「插件」Tab + 插件库弹窗。
 *
 * 交互契约（用户 2026-10-25 定稿）：
 * - Tab 顺序：通用 / 个性化 / Skills / 快捷键 / **插件** / 关于（插件在关于之前）
 * - 主面：已安装清单。内置行只有「内置」标记、无卸载按钮；用户自装行有卸载按钮
 * - 「浏览插件库 →」打开大弹窗：搜索框 + 结果卡片 + 右侧详情/手动安装
 * - 点卡片 → 右侧出现该包真实信息（版本/体积/许可/更新时间/关键词）
 * - 点安装 → 成功提示「重启后生效」；已装的显示「已安装」不再给安装按钮
 * - 卸载 → 二次确认弹窗；内置项后端也拒（E2E 覆盖按钮不出现即可）
 * - 搜索无结果 → 空态文案；安装失败 → 错误内联 + 输出尾部折叠
 *
 * mock 数据在 src/mock-bridge.ts（mockPlugins / MOCK_REGISTRY）。
 */
import { test, expect } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

/** 进入 设置 → 插件 Tab */
async function openPluginsTab(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();
  await page.locator('.settings-tab', { hasText: '插件' }).click();
  await expect(page.locator('.plugins-section')).toBeVisible();
}

/** 打开插件库弹窗 */
async function openMarket(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.plugins-browse .plugins-btn.primary').click();
  await expect(page.locator('.market-dialog')).toBeVisible();
}

test('PL-MKT-01 @mock-backend Tab 顺序：插件在关于之前', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);

  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();

  const labels = await page.locator('.settings-tab').allTextContents();
  const pluginsIdx = labels.findIndex((l) => l.includes('插件'));
  const aboutIdx = labels.findIndex((l) => l.includes('关于'));
  expect(pluginsIdx).toBeGreaterThan(-1);
  expect(aboutIdx).toBeGreaterThan(-1);
  // 核心断言：插件必须排在关于之前（用户明确要求的顺序）
  expect(pluginsIdx).toBeLessThan(aboutIdx);
  // 且紧邻（中间不夹别的 Tab）
  expect(aboutIdx - pluginsIdx).toBe(1);

  health.assertHealthy();
});

test('PL-MKT-02 @mock-backend 已安装清单：内置无卸载按钮，自装有卸载按钮', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openPluginsTab(page);

  const rows = page.locator('.plugin-row');
  await expect(rows).toHaveCount(3);

  // 内置 2 条：有「内置」标记、无卸载按钮
  const builtinRows = page.locator('.plugin-row').filter({ has: page.locator('.plugin-tag.builtin') });
  await expect(builtinRows).toHaveCount(2);
  for (const row of await builtinRows.all()) {
    await expect(row.locator('.plugins-btn.danger')).toHaveCount(0);
  }

  // 用户自装 1 条（pi-tool-display）：有卸载按钮、无内置标记
  const userRow = page.locator('.plugin-row').filter({ hasText: 'pi-tool-display' });
  await expect(userRow).toHaveCount(1);
  await expect(userRow.locator('.plugins-btn.danger')).toBeVisible();
  await expect(userRow.locator('.plugin-tag.builtin')).toHaveCount(0);

  health.assertHealthy();
});

test('PL-MKT-03 @mock-backend 打开插件库：默认列出推荐集合，搜索可过滤', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openPluginsTab(page);
  await openMarket(page);

  // 默认（无关键词）列出 mock registry 全部 4 条
  await expect(page.locator('.market-card')).toHaveCount(4);
  await expect(page.locator('.market-count')).toContainText('4');

  // 搜 usage → 只剩 pi-usage
  await page.locator('.market-search .market-input').fill('usage');
  await page.locator('.market-search .plugins-btn').click();
  await expect(page.locator('.market-card')).toHaveCount(1);
  await expect(page.locator('.market-card-name')).toContainText('pi-usage');

  // 搜不存在的词 → 空态
  await page.locator('.market-search .market-input').fill('zzz-not-exist');
  await page.locator('.market-search .plugins-btn').click();
  await expect(page.locator('.market-card')).toHaveCount(0);
  await expect(page.locator('.market-list .plugins-empty')).toBeVisible();

  health.assertHealthy();
});

test('PL-MKT-04 @mock-backend 点卡片出详情：版本/体积/许可/关键词齐全', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openPluginsTab(page);
  await openMarket(page);

  await page.locator('.market-card').filter({ hasText: '@narumitw/pi-goal' }).click();

  const side = page.locator('.market-side');
  await expect(side.locator('.market-side-name')).toContainText('@narumitw/pi-goal');
  // 版本
  await expect(side.locator('.market-kv')).toContainText('0.54.12');
  // 体积换算（836087 B ≈ 816 KB）
  await expect(side.locator('.market-kv')).toContainText('KB');
  // 许可
  await expect(side.locator('.market-kv')).toContainText('MIT');
  // 关键词标签
  await expect(side.locator('.market-kw span').first()).toBeVisible();
  // 未安装 → 有安装按钮 + 重启提示
  await expect(side.locator('.plugins-btn.primary')).toBeVisible();
  await expect(side.locator('.market-hint')).toContainText('重启');

  health.assertHealthy();
});

test('PL-MKT-05 @mock-backend 安装成功：toast 提示重启生效，按钮变已安装', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openPluginsTab(page);
  await openMarket(page);

  await page.locator('.market-card').filter({ hasText: '@narumitw/pi-goal' }).click();
  await page.locator('.market-side .plugins-btn.primary').click();

  // 成功 toast 必须点明「重启后生效」——引擎不会热加载，不说这句用户会以为装坏了
  await expect(page.locator('.toast .toast-message')).toContainText('重启后生效');

  // 详情面板转为已安装态：安装按钮消失、提示已安装
  await expect(page.locator('.market-side .plugins-btn.primary')).toHaveCount(0);
  await expect(page.locator('.market-side .market-hint.ok')).toContainText('已安装');

  // 关弹窗回主面：清单里出现新装的那条
  await page.locator('.market-close').click();
  await expect(page.locator('.market-dialog')).toHaveCount(0);
  await expect(page.locator('.plugin-row').filter({ hasText: '@narumitw/pi-goal' })).toHaveCount(1);

  health.assertHealthy();
});

test('PL-MKT-06 @mock-backend 卸载：二次确认后行消失', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openPluginsTab(page);

  const userRow = page.locator('.plugin-row').filter({ hasText: 'pi-tool-display' });
  await expect(userRow).toHaveCount(1);

  await userRow.locator('.plugins-btn.danger').click();

  // 确认弹窗（卸载会真删文件，必须二次确认）
  const dialog = page.locator('.plugins-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.plugins-dialog-title')).toContainText('pi-tool-display');
  await expect(dialog.locator('.plugins-dialog-desc')).toContainText('重启后');

  // 取消 → 行还在
  await dialog.locator('.ghost').click();
  await expect(page.locator('.plugins-dialog')).toHaveCount(0);
  await expect(userRow).toHaveCount(1);

  // 确认卸载 → 行消失 + toast
  await userRow.locator('.plugins-btn.danger').click();
  await page.locator('.plugins-dialog .danger-solid').click();
  await expect(page.locator('.toast .toast-message')).toContainText('已卸载');
  await expect(page.locator('.plugin-row').filter({ hasText: 'pi-tool-display' })).toHaveCount(0);

  health.assertHealthy();
});

test('PL-MKT-07 @mock-backend 安装失败：错误内联展示 + 输出尾部可见', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openPluginsTab(page);
  await openMarket(page);

  // 手动安装走失败分支（mock 对 pi-broken-pkg 回 6002）
  await page.locator('.market-manual .market-input').fill('pi-broken-pkg');
  await page.locator('.market-manual .plugins-btn').click();

  // 错误 toast + 右侧输出尾部（引擎原生 Path does not exist 被翻成人话）。
  // 注意：toast 组件会把「标签：内容」按全角冒号拆成 .toast-label + .toast-value，
  // 所以断言要落在整个 .toast 上，不能只查 .toast-message（那里只剩冒号后的部分）。
  await expect(page.locator('.toast')).toContainText('安装失败');
  await expect(page.locator('.toast')).toContainText('包名格式不对');
  const output = page.locator('.market-output');
  await expect(output).toBeVisible();
  await expect(output).toHaveClass(/failed/);
  await expect(output).toContainText('Path does not exist');

  health.assertHealthy();
});

test('PL-MKT-08 @mock-backend 弹窗可关闭：遮罩与关闭按钮均生效', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openPluginsTab(page);

  // 关闭按钮
  await openMarket(page);
  await page.locator('.market-close').click();
  await expect(page.locator('.market-dialog')).toHaveCount(0);

  // 遮罩点击（点击弹窗外的遮罩区域）
  await openMarket(page);
  await page.locator('.plugins-overlay').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.market-dialog')).toHaveCount(0);

  health.assertHealthy();
});
