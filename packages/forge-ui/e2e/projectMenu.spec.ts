/**
 * 项目「更多操作」菜单 E2E（回归：清理所有会话 / 删除项目两阶段确认）。
 * 自动化等级：mock-backend（mock-bridge 可编程事件）。
 *
 * 回归背景：ContextMenu 组件化（c75dbbb）后 onItemClick 无条件 select→close，
 * 两阶段确认第一次点击就被 close 清掉确认态，危险操作永远无法发出——
 * 本组用例钉住：首次点击后菜单必须保持打开并切到确认文案，第二次点击才生效。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedProjects, seedSessions } from './helpers/index';

const PROJ_A = 'D:/work/demo-alpha';

function mkProject(path: string): Record<string, unknown> {
  return { path, alias: null, lastOpenedAt: new Date().toISOString(), trust: 'trusted' };
}

function mkSession(alias: string, projectPath: string): Record<string, unknown> {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    projectPath,
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 进入应用：种子项目 + 会话，等待项目树就绪 */
async function boot(
  page: Page,
  projects: Array<Record<string, unknown>>,
  sessions: Array<Record<string, unknown>>,
): Promise<void> {
  await page.goto('/');
  await seedProjects(page, projects);
  await seedSessions(page, sessions);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  await expect(page.locator('.tree-project').first()).toBeVisible();
}

/** 打开指定项目的「更多操作」菜单（行尾 ⋯ 按钮，hover 才可见） */
async function openProjectMenu(page: Page, path: string): Promise<void> {
  const row = page.locator('.tree-project', { has: page.locator(`[title="${path}"]`) });
  await row.hover();
  await row.locator('.project-more-trigger').click();
  await expect(page.locator('.ctx-menu')).toBeVisible();
}

// ===== 清理所有会话：两阶段确认后清空项目名下会话，项目本身保留 =====
test('PROJECT-MENU-001 @P0 @mock-backend 清理所有会话两阶段确认后生效', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(
    page,
    [mkProject(PROJ_A)],
    [mkSession('会话一', PROJ_A), mkSession('会话二', PROJ_A)],
  );
  await expect(page.locator('.tree-session')).toHaveCount(2);

  await openProjectMenu(page, PROJ_A);

  // 首次点击：菜单不关闭，文案切「确认清理」，尚未删除
  await page.locator('.ctx-menu-item', { hasText: '清理所有会话' }).click();
  await expect(page.locator('.ctx-menu')).toBeVisible();
  await expect(page.locator('.ctx-menu-item', { hasText: '确认清理' })).toBeVisible();
  await expect(page.locator('.tree-session')).toHaveCount(2);

  // 第二次点击：确认生效——会话清空，项目保留
  await page.locator('.ctx-menu-item', { hasText: '确认清理' }).click();
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await expect(page.locator('.tree-session')).toHaveCount(0);
  await expect(page.locator('.tree-project').first()).toBeVisible();
  await expect(page.locator('.tree-empty-inline', { hasText: '暂无会话' })).toBeVisible();

  // 二次打开菜单：确认态已复位，文案回到初始态（不复位会误触确认）
  await openProjectMenu(page, PROJ_A);
  await expect(page.locator('.ctx-menu-item', { hasText: '清理所有会话' })).toBeVisible();
  health.assertHealthy();
});

// ===== 删除项目：两阶段确认后项目连同会话一起移除 =====
test('PROJECT-MENU-002 @P0 @mock-backend 删除项目两阶段确认后生效', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkProject(PROJ_A)], [mkSession('待删会话', PROJ_A)]);
  await expect(page.locator('.tree-session')).toHaveCount(1);

  await openProjectMenu(page, PROJ_A);

  // 首次点击：菜单不关闭，文案切「确认删除」，项目尚未移除
  await page.locator('.ctx-menu-item', { hasText: '删除项目' }).click();
  await expect(page.locator('.ctx-menu')).toBeVisible();
  await expect(page.locator('.ctx-menu-item', { hasText: '确认删除' })).toBeVisible();
  await expect(page.locator('.tree-project').first()).toBeVisible();

  // 第二次点击：项目连同名下会话一并移除，树进入空态
  await page.locator('.ctx-menu-item', { hasText: '确认删除' }).click();
  await expect(page.locator('.ctx-menu')).toHaveCount(0);
  await expect(page.locator('.tree-project')).toHaveCount(0);
  await expect(page.locator('.tree-session')).toHaveCount(0);
  await expect(page.locator('.tree-empty-centered', { hasText: '暂无项目' })).toBeVisible();
  health.assertHealthy();
});
