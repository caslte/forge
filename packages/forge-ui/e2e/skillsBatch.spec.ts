/**
 * Skills 管理 E2E：批量管理开关（批量删除）+ 多选导入。
 *
 * 交互契约（用户 2026-10-10 定稿）：
 * - 头部「批量管理 Skill」按钮 → 进入批量模式：按钮变「退出批量管理」+「批量删除 Skill (N)」
 *   出现、每行出现复选框、行内单个删除图标隐藏；退出后全部还原（页面整洁优先）。
 * - 勾选 ≥1 项 → 「批量删除 Skill (N)」可点 → 确认弹窗列出全部目录 → 确认后逐条移入
 *   回收站，全部成功自动退出批量模式。
 * - 「导入 Skill 目录」可一次多选（dialog.selectDirectories）：选完后先弹**导入预览**
 *   （skill/checkImport 逐个校验，与单个导入同源口径）——无效目录置灰且复选框禁用
 *   不可勾选；同名冲突标记可选；确认「导入所选 (N)」后仅导入勾选项，冲突项逐个弹
 *   4090 确认（跳过/覆盖）；结束 toast 汇总。预览取消 = 什么都不导入。
 */
import { test, expect } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

/** 进入 设置 → Skills Tab */
async function openSkillsTab(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();
  await page.locator('.settings-tab', { hasText: 'Skills' }).click();
  await expect(page.locator('.skill-row').first()).toBeVisible();
}

test('SK-BATCH-01 @mock-backend 批量管理开关：进入显示复选框与批量删除按钮，退出还原', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  // 默认（未进入批量管理）：无复选框、无批量删除按钮
  await expect(page.locator('.skill-check')).toHaveCount(0);
  await expect(page.locator('.skills-batch-delete-btn')).toHaveCount(0);

  // 进入批量管理：按钮文案切换、复选框与批量删除按钮出现
  await page.locator('.skills-batch-manage-btn').click();
  await expect(page.locator('.skills-batch-manage-btn')).toHaveText(/退出批量管理/);
  // mock 种子 3 条，db-migrate 为 project 作用域不在 UI 分组展示（模块 09 只管全局）→ 可见 2 条
  await expect(page.locator('.skill-check')).toHaveCount(2);
  await expect(page.locator('.skills-batch-delete-btn')).toBeVisible();
  // 0 选中时批量删除禁用
  await expect(page.locator('.skills-batch-delete-btn')).toBeDisabled();

  // 退出：复选框与批量删除按钮隐藏、按钮文案还原
  await page.locator('.skills-batch-manage-btn').click();
  await expect(page.locator('.skills-batch-manage-btn')).toHaveText(/批量管理/);
  await expect(page.locator('.skill-check')).toHaveCount(0);
  await expect(page.locator('.skills-batch-delete-btn')).toHaveCount(0);

  health.assertHealthy();
});

test('SK-BATCH-02 @mock-backend 勾选两项批量删除：确认弹窗列目录，成功后自动退出批量模式', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  await page.locator('.skills-batch-manage-btn').click();
  // 勾选全局组两条（pdf-report / changelog）
  const rows = page.locator('.skills-group').first().locator('.skill-row');
  await rows.nth(0).locator('.skill-check').check();
  await rows.nth(1).locator('.skill-check').check();
  await expect(page.locator('.skills-batch-delete-btn')).toHaveText(/批量删除 Skill \(2\)/);
  await expect(page.locator('.skills-batch-delete-btn')).toBeEnabled();

  // 确认弹窗列出 2 个目录
  await page.locator('.skills-batch-delete-btn').click();
  await expect(page.locator('.skills-batch-overlay .skills-dialog-title')).toContainText('批量删除 skill');
  await expect(page.locator('.skills-batch-overlay .skills-batch-item')).toHaveCount(2);

  // 确认删除：行消失 + toast + 自动退出批量模式
  await page.locator('.skills-batch-overlay .danger').click();
  await expect(page.locator('.skill-row')).toHaveCount(0); // 可见两条全删（project 项本就不展示）
  await expect(page.locator('.toast .toast-message')).toContainText('已删除 2 个');
  await expect(page.locator('.skills-batch-manage-btn')).toHaveText(/批量管理/); // 已退出
  await expect(page.locator('.skill-check')).toHaveCount(0);

  health.assertHealthy();
});

test('SK-BATCH-03 @mock-backend 批量模式行布局：信息列占满复选框右侧全部宽度（回归 space-between 挤右变形）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  await page.locator('.skills-batch-manage-btn').click();
  await expect(page.locator('.skill-check').first()).toBeVisible();

  // 几何断言（单次 evaluate 原子取，比相对偏移）：每行 info 左缘 == 复选框右缘 + 间距，
  // 右缘贴行内容右缘——短描述行不得被 space-between 推到右侧
  const rows = await page.evaluate(() => {
    return [...document.querySelectorAll('.skill-row')].map((row) => {
      const r = row.getBoundingClientRect();
      const check = row.querySelector('.skill-check')?.getBoundingClientRect();
      const info = row.querySelector('.skill-info')?.getBoundingClientRect();
      if (!check || !info) return null;
      return {
        checkRight: check.right - r.left,
        infoLeft: info.left - r.left,
        infoRight: info.right - r.left,
        rowRight: r.right - r.left - 10 /* padding-right */,
      };
    });
  });
  assertOk(rows);
  for (const row of rows) {
    if (row === null) throw new Error('批量模式行缺少 .skill-check 或 .skill-info');
    const gap = row.infoLeft - row.checkRight;
    if (gap < 8 || gap > 24) throw new Error(`信息列左缘偏移异常：gap=${gap}px（期望 ≈12px，space-between 挤右变形）`);
    if (Math.abs(row.infoRight - row.rowRight) > 2) {
      throw new Error(`信息列未占满行宽：infoRight=${row.infoRight} rowRight=${row.rowRight}`);
    }
  }

  health.assertHealthy();
});

function assertOk(rows: unknown[]): void {
  if (rows.length === 0) throw new Error('未取到任何 skill-row');
}

test('SK-BATCH-04 @mock-backend 批量模式全选：一键全选/全不选，计数联动', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  await page.locator('.skills-batch-manage-btn').click();
  await expect(page.locator('.skill-check')).toHaveCount(2);

  // 全选：全部复选框勾选，批量删除计数联动
  await page.locator('.skills-select-all-btn').click();
  await expect(page.locator('.skills-select-all-btn')).toHaveText(/全不选/);
  const boxes = page.locator('.skill-check');
  const count = await boxes.count();
  for (let i = 0; i < count; i++) await expect(boxes.nth(i)).toBeChecked();
  await expect(page.locator('.skills-batch-delete-btn')).toHaveText(new RegExp(`批量删除 Skill \\(${count}\\)`));

  // 再点：全不选还原
  await page.locator('.skills-select-all-btn').click();
  await expect(page.locator('.skills-select-all-btn')).toHaveText(/全选/);
  for (let i = 0; i < count; i++) await expect(boxes.nth(i)).not.toBeChecked();
  await expect(page.locator('.skills-batch-delete-btn')).toBeDisabled();

  health.assertHealthy();
});

test('SK-IMPORT-MULTI @mock-backend 多选导入：冲突项弹确认可覆盖，结束 toast 汇总', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  // 模拟原生多选对话框：1 个全新目录 + 1 个与 mock 种子同名冲突目录（pdf-report）
  await page.evaluate(() => {
    const f = (window as unknown as {
      forge: { dialog: { selectDirectories: () => Promise<string[] | null> } };
    }).forge;
    f.dialog.selectDirectories = async () => [
      'D:/skills/code-review',
      'C:/Users/dev/.pi/agent/skills/pdf-report',
    ];
  });

  await page.locator('.skills-import-btn').click();

  // 预览：2 项默认全选，pdf-report 标记同名冲突（可选，确认后再走 4090）
  const previewItems = page.locator('.skills-preview-overlay .skills-preview-item');
  await expect(previewItems).toHaveCount(2);
  await expect(page.locator('.skills-preview-overlay .skills-preview-badge.conflict')).toContainText('同名冲突');
  await expect(page.locator('.skills-import-confirm')).toBeEnabled();
  await expect(page.locator('.skills-import-confirm')).toContainText('(2)');

  // 确认导入 → 第一项 code-review 无冲突直接导入；第二项冲突弹 4090 确认
  await page.locator('.skills-import-confirm').click();
  await expect(page.locator('.skills-conflict-overlay .skills-dialog-path')).toContainText('pdf-report');

  // 覆盖：旧目录移入回收站后导入新的
  await page.locator('.skills-conflict-overlay .skills-conflict-overwrite').click();

  // 汇总 toast + 列表更新（code-review 出现，pdf-report 描述更新为导入语义）
  await expect(page.locator('.toast .toast-message')).toContainText('导入完成');
  await expect(page.locator('.skill-name', { hasText: 'code-review' })).toBeVisible();

  health.assertHealthy();
});

test('SK-IMPORT-MIXED @mock-backend 混合多选：预览中无效项禁选，仅导入有效项', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  // 无效项走 mock-bridge 真实校验口径（invalid- 前缀 = 无 SKILL.md，与单个导入同一套判断逻辑）
  await page.evaluate(() => {
    const f = (window as unknown as {
      forge: { dialog: { selectDirectories: () => Promise<string[] | null> } };
    }).forge;
    f.dialog.selectDirectories = async () => ['D:/skills/code-review', 'D:/downloads/invalid-not-a-skill'];
  });

  await page.locator('.skills-import-btn').click();

  // 预览：无效项置灰 + 复选框禁用且不勾选（用户诉求：错误的不可选择）
  const items = page.locator('.skills-preview-overlay .skills-preview-item');
  await expect(items).toHaveCount(2);
  const invalidItem = items.filter({ hasText: 'invalid-not-a-skill' });
  await expect(invalidItem.locator('.skills-preview-badge.invalid')).toContainText('无法导入');
  await expect(invalidItem.locator('.skill-check')).toBeDisabled();
  await expect(invalidItem.locator('.skill-check')).not.toBeChecked();
  const validItem = items.filter({ hasText: 'code-review' });
  await expect(validItem.locator('.skill-check')).toBeChecked();

  // 确认导入：仅勾选的有效项入队；无效项不出现在列表、不计入汇总
  await page.locator('.skills-import-confirm').click();
  await expect(page.locator('.skill-name', { hasText: 'code-review' })).toBeVisible();
  await expect(page.locator('.skill-name', { hasText: 'invalid-not-a-skill' })).toHaveCount(0);
  await expect(page.locator('.toast .toast-message')).toContainText('导入完成');
  await expect(page.locator('.toast .toast-message')).toContainText('成功 1 个');

  health.assertHealthy();
});

test('SK-IMPORT-PREVIEW-CANCEL @mock-backend 预览取消：不导入任何目录', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  await page.evaluate(() => {
    const f = (window as unknown as {
      forge: { dialog: { selectDirectories: () => Promise<string[] | null> } };
    }).forge;
    f.dialog.selectDirectories = async () => ['D:/skills/code-review'];
  });

  await page.locator('.skills-import-btn').click();
  await expect(page.locator('.skills-preview-overlay .skills-preview-item')).toHaveCount(1);

  // 取消：预览关闭、列表不变、无任何 toast
  await page.locator('.skills-preview-overlay .ghost').click();
  await expect(page.locator('.skills-preview-overlay')).toHaveCount(0);
  await expect(page.locator('.skill-row')).toHaveCount(2);
  await expect(page.locator('.toast')).toHaveCount(0);

  health.assertHealthy();
});

test('SK-IMPORT-MULTI-CANCEL @mock-backend 多选导入取消：无任何反馈', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await openSkillsTab(page);

  await page.evaluate(() => {
    const f = (window as unknown as {
      forge: { dialog: { selectDirectories: () => Promise<string[] | null> } };
    }).forge;
    f.dialog.selectDirectories = async () => null;
  });

  await page.locator('.skills-import-btn').click();
  await expect(page.locator('.toast')).toHaveCount(0);
  await expect(page.locator('.skill-row')).toHaveCount(2);

  health.assertHealthy();
});
