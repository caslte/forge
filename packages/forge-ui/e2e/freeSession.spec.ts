/**
 * 自由对话（无项目会话）E2E（v0.3，docs/test/02_session coverage-matrix 增补）。
 * 自动化等级：mock-backend（mock-bridge 可编程事件 + 真实 UI 交互）。
 *
 * 覆盖：
 * - FREE-01：零项目落地 hero 发送 → 直接创建自由会话，落侧栏「自由对话」分组
 * - FREE-02：右键「移入项目」→ 会话迁移到项目分组，自由分组清空
 * - FREE-03：任务视角自由会话带「自由」徽章
 * - FREE-04：拖自由会话进多窗口画布 → 开窗标题带「自由对话」tag
 *
 * 每条含健康守卫（无未声明 console error / pageerror）与负向断言。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  assertNoResidualStreaming,
  seedSessions,
  seedProjects,
  listMockSessions,
} from './helpers/index';

const PROJ = 'D:/work/aiwork/forge';

/** 种子会话构造（projectPath 显式传 null 即自由会话） */
function mkSession(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    projectPath: PROJ,
    alias: null,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
    ...over,
  };
}

/** 进入应用：加载种子并等待首屏就绪 */
async function boot(page: Page, sessions: Array<Record<string, unknown>>): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
}

// ===== FREE-01 零项目 hero 发送即创建自由会话 =====
test('FREE-E2E-001 @P0 @mock-backend 零项目 hero 发送 → 自由会话落「自由对话」分组', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await seedProjects(page, []);
  await page.reload();

  // 落地 hero：居中输入框；归属 chip 显示「自由对话」
  await expect(page.locator('.landing-hero')).toBeVisible();
  await expect(page.locator('.proj-pill')).toContainText('自由对话');

  // 发送：不再弹目录选择器，直接创建自由会话（autoSendText 直发链路）
  await page.locator('.compose-input').fill('不选项目直接问一个问题');
  await page.locator('.compose-input').press('Enter');

  // 会话视图接管；侧栏「自由对话」分组出现该会话
  await expect(page.locator('.free-head')).toBeVisible();
  await expect(page.locator('.free-section .tree-session')).toHaveCount(1);
  await expect(page.locator('.free-section .tree-session').first()).toContainText('不选项目直接问');

  // mock 侧确认归属为 null（自由会话），且没有被兜底到任何项目
  const sessions = await listMockSessions(page);
  const created = sessions.find((s) => s.alias === '不选项目直接问一个问题');
  expect(created, '自由会话已在 mock 落库').toBeTruthy();
  expect(created?.projectPath ?? null).toBeNull();

  // 负向：不存在任何「绑定项目…」入口（用户裁定：不做会话内绑定）
  await expect(page.locator('.bind-btn')).toHaveCount(0);
  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== FREE-02 右键移入项目 =====
test('FREE-E2E-002 @P1 @mock-backend 右键「移入项目」→ 会话迁移到项目分组', async ({ page }) => {
  const health = attachHealthGuards(page);
  const free = mkSession({ projectPath: null, alias: '自由会话甲' });
  await boot(page, [free, mkSession({ alias: '项目会话乙' })]);

  await expect(page.locator('.free-section .tree-session')).toHaveCount(1);
  // 项目分组当前 1 条（项目视角第一个项目节点下的会话行）
  const projectSessions = page.locator('.tree-node:not(.free-node) .tree-session');
  await expect(projectSessions).toHaveCount(1);

  // 右键自由会话 → 菜单 → 移入「forge」
  await page.locator('.free-section .tree-session').first().click({ button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await menu.locator('.ctx-menu-item', { hasText: '移入' }).click();

  // 自由分组整体隐藏（空分组不占位），项目分组 2 条；toast 确认
  await expect(page.locator('.free-section')).toHaveCount(0);
  await expect(projectSessions).toHaveCount(2);
  await expect(page.locator('.toast')).toContainText('已移入');

  // mock 侧归属已变更
  const sessions = await listMockSessions(page);
  expect(sessions.find((s) => s.sessionId === free.sessionId)?.projectPath).toBe(PROJ);

  // 负向：移入后自由分组不再有该会话的行
  await expect(page.locator('.free-section .tree-session', { hasText: '自由会话甲' })).toHaveCount(0);
  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== FREE-03 任务视角「自由」徽章 =====
test('FREE-E2E-003 @P1 @mock-backend 任务视角自由会话带「自由」徽章', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [
    mkSession({ projectPath: null, alias: '自由会话丙' }),
    mkSession({ alias: '项目会话丁' }),
  ]);

  // 切任务视角（分段按钮「任务」）
  await page.locator('.view-seg-btn', { hasText: '任务' }).click();
  const rows = page.locator('.tree-section.task .tree-session');
  await expect(rows).toHaveCount(2);

  // 自由会话行：青瓷绿「自由」徽章；项目会话行：普通项目 tag
  const freeRow = rows.filter({ hasText: '自由会话丙' });
  await expect(freeRow.locator('.tree-session-free-tag')).toHaveText('自由');
  const projRow = rows.filter({ hasText: '项目会话丁' });
  await expect(projRow.locator('.tree-session-free-tag')).toHaveCount(0);
  await expect(projRow.locator('.tree-session-proj-tag')).toBeVisible();

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== FREE-05 回归：项目视图下切自由归属发消息，不得落回原项目（用户实测 bug） =====
test('FREE-E2E-005 @P0 @mock-backend 项目视图草稿切「自由对话」→ 发送落自由分组而非原项目', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '已有项目会话' })]);
  const projectSessions = page.locator('.tree-node:not(.free-node) .tree-session');
  await expect(projectSessions).toHaveCount(1);

  // 新会话（默认归属第一项目）→ 归属选择器切「自由对话」
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.proj-pill')).toContainText('forge');
  await page.locator('.proj-pill').click();
  await page.locator('.proj-menu .proj-item', { hasText: '自由对话' }).click();

  // 切换后 chip = 自由对话；项目分支徽标随之隐藏（cwd 无来源，v0.3 降级）
  await expect(page.locator('.proj-pill')).toContainText('自由对话');
  await expect(page.locator('.compose-status .branch-badge')).toHaveCount(0);

  // 发送：必须创建自由会话（此前 bug：currentProject 泄漏，会话落到 forge）
  await page.locator('.compose-input').fill('hi');
  await page.locator('.compose-input').press('Enter');

  // 用户气泡必须上屏（回归：归属切换曾导致对话视图在「会话入列表前」的窗口期
  // 整体卸载重挂，乐观气泡丢失——注意断言用 first，排队派发可能补第二条）
  await expect(page.locator('.conv-messages .msg-user').first()).toContainText('hi', { timeout: 5_000 });
  await expect(page.locator('.landing-hero')).toHaveCount(0);

  await expect(page.locator('.free-section .tree-session')).toHaveCount(1);
  await expect(page.locator('.free-section .tree-session').first()).toContainText('hi');
  // 项目分组不变（仍是原有 1 条，新会话没有被塞进去）
  await expect(projectSessions).toHaveCount(1);

  // mock 侧归属 = null
  const sessions = await listMockSessions(page);
  const created = sessions.find((s) => s.alias === 'hi');
  expect(created, '自由会话已落库').toBeTruthy();
  expect(created?.projectPath ?? null).toBeNull();

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});
// ===== FREE-06 分组头「+」：hover 显形，点击直达自由对话草稿 =====
test('FREE-E2E-006 @P2 @mock-backend 自由分组头「+」→ 新建自由对话草稿', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ projectPath: null, alias: '已有自由会话' })]);

  await expect(page.locator('.free-head')).toBeVisible();
  await page.locator('.free-head').hover();
  await page.locator('.free-head .tree-icon-button[aria-label="新建会话"]').click();

  // 进入草稿态且归属即「自由对话」（不走选择器）
  await expect(page.locator('.compose-box')).toBeVisible();
  await expect(page.locator('.proj-pill')).toContainText('自由对话');

  health.assertHealthy();
});

// ===== FREE-07 分组头「⋯ 更多操作」：两阶段确认清理全部自由会话 =====
test('FREE-E2E-007 @P1 @mock-backend 自由分组「清理所有会话」两阶段确认后生效', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [
    mkSession({ projectPath: null, alias: '自由会话一' }),
    mkSession({ projectPath: null, alias: '自由会话二' }),
    mkSession({ alias: '项目会话三' }),
  ]);
  await expect(page.locator('.free-section .tree-session')).toHaveCount(2);

  // hover 分组头 → ⋯ → 菜单仅「清理所有会话」一项
  await page.locator('.free-head').hover();
  await page.locator('.free-head .project-more-trigger').click();
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.ctx-menu-item')).toHaveCount(1);

  // 两阶段确认：首点变「确认清理」，再点才真清
  await menu.locator('.ctx-menu-item', { hasText: '清理所有会话' }).click();
  await expect(menu.locator('.ctx-menu-item', { hasText: '确认清理' })).toBeVisible();
  await menu.locator('.ctx-menu-item', { hasText: '确认清理' }).click();

  // 自由分组整体隐藏（空分组不占位），项目会话不受影响
  await expect(page.locator('.free-section')).toHaveCount(0);
  await expect(page.locator('.tree-node:not(.free-node) .tree-session')).toHaveCount(1);
  await expect(page.locator('.toast')).toContainText('已清理');

  // mock 侧自由会话已删光
  const sessions = await listMockSessions(page);
  expect(sessions.filter((s) => s.projectPath === null ?? false)).toHaveLength(0);
  expect(sessions).toHaveLength(1);

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== FREE-08 回归：清掉最后一个自由会话后落点回收（项目选择器不能消失） =====
test('FREE-E2E-008 @P0 @mock-backend 清空自由会话（当前正选中）→ 落回项目视图且归属选择器在', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [
    mkSession({ projectPath: null, alias: '自由会话唯一' }),
    mkSession({ alias: '项目会话保留' }),
  ]);

  // 先点进自由会话：currentProjectPath 被置空（自由会话无归属），输入框 chip = 自由对话
  await page.locator('.free-section .tree-session').first().click();
  await expect(page.locator('.proj-pill')).toContainText('自由对话');
  await expect(page.locator('.landing-hero')).toHaveCount(0);

  // 分组头 ⋯ → 两阶段确认清理全部自由会话
  await page.locator('.free-head').hover();
  await page.locator('.free-head .project-more-trigger').click();
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await menu.locator('.ctx-menu-item', { hasText: '清理所有会话' }).click();
  await menu.locator('.ctx-menu-item', { hasText: '确认清理' }).click();
  await expect(page.locator('.free-section')).toHaveCount(0);

  // 回归点：不得停在「hero + 无归属 chip」的三空态——落回最近项目会话视图，
  // 输入框下的项目选择器仍在（显示 forge）
  await expect(page.locator('.landing-hero')).toHaveCount(0);
  await expect(page.locator('.compose-box')).toBeVisible();
  await expect(page.locator('.proj-pill')).toBeVisible();
  await expect(page.locator('.proj-pill')).toContainText('forge');

  // 侧栏项目会话仍在、自由分组已消失
  await expect(page.locator('.tree-node:not(.free-node) .tree-session')).toHaveCount(1);

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== FREE-04 多窗口拖入自由会话 =====
test('FREE-E2E-004 @P1 @mock-backend 拖自由会话进多窗口画布 → 窗口标题「自由对话」tag', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ projectPath: null, alias: '自由会话戊' })]);

  // 切多窗口画布
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();
  await expect(page.locator('.mw-win')).toHaveCount(0);

  // 拖自由会话行到画布 → 开窗
  await page.locator('.free-section .tree-session').first().dragTo(page.locator('.mw-canvas'));
  await expect(page.locator('.mw-win')).toHaveCount(1);

  // 窗口标题归属 tag = 「自由对话」，且是青瓷绿变体（mw-proj-free）
  const tag = page.locator('.mw-win .mw-proj');
  await expect(tag).toHaveText('自由对话');
  await expect(tag).toHaveClass(/mw-proj-free/);

  // 窗口内是纯对话：无分支徽标、无 git 提交入口
  await expect(page.locator('.mw-win .branch-badge')).toHaveCount(0);

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});
