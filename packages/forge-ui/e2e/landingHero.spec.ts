/**
 * 零项目落地 hero（v3.77 + v0.3 自由对话）回归。
 *
 * 改版后与会话内空态 hero 同一视觉语言：forge 字标 + 居中输入框（LandingHero）。
 * v0.3 起发送不再弹目录选择器——直接创建自由会话（FREE-E2E-001 覆盖主链路）；
 * 本文件回归 hero 自身的静态结构与「打开项目」入口的文本保留行为。
 *
 * 草稿直通链路：落地输入文本实时落在模块级草稿仓库（utils/composerDrafts，
 * 草稿态统一 key）；打开项目后项目视图的草稿输入框挂载时自动回填。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, seedProjects, waitForMock } from './helpers/index';

/** 零项目种子：清空项目与会话并 reload，让 mock init 从 localStorage 恢复零项目态 */
async function gotoLanding(page: Page): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedProjects(page, []);
  await seedSessions(page, []);
  await page.reload();
  await waitForMock(page);
}

test('E-PM-LANDING-001 @mock-backend 零项目落地 hero：水印 + 居中输入框 + 自由对话/打开项目入口', async ({ page }) => {
  const health = attachHealthGuards(page);
  await gotoLanding(page);

  await expect(page.locator('.landing-hero')).toBeVisible();
  await expect(page.locator('.landing-wordmark.wm-dark')).toBeVisible();
  const input = page.locator('.landing-hero .compose-input');
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();

  // 归属 chip 显示「自由对话」；菜单两项：自由对话（当前归属）+ 打开项目…
  await expect(page.locator('.landing-hero .proj-pill')).toContainText('自由对话');
  await page.locator('.landing-hero .proj-pill').click();
  await expect(
    page.locator('.landing-hero .proj-item', { hasText: '打开项目…' }),
  ).toBeVisible();
  await expect(
    page.locator('.landing-hero .proj-item', { hasText: '自由对话' }),
  ).toBeVisible();
  await expect(page.locator('.landing-hero .proj-item')).toHaveCount(2);

  // 旧「选择项目」卡片不复活
  await expect(page.locator('.no-session-card')).toHaveCount(0);

  health.assertHealthy();
});

test('E-PM-LANDING-002 @mock-backend 落地发送 → 直接创建自由会话（不再弹目录选择器）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await gotoLanding(page);

  const input = page.locator('.landing-hero .compose-input');
  await expect(input).toBeVisible();
  await input.fill('帮我审查这个仓库的构建脚本');
  await input.press('Enter');

  // 发送即创建：落地 hero 卸载，自由会话接管视图（不触发目录选择器）
  await expect(page.locator('.landing-hero')).toHaveCount(0);
  await expect(page.locator('.free-head')).toBeVisible();
  await expect(page.locator('.free-section .tree-session').first()).toContainText('帮我审查这个仓库');

  // 文本已作为首条消息直发：输入框清空、消息流含该条 user 消息
  const convInput = page.locator('.conv-input-wrap .compose-input');
  await expect(convInput).toHaveValue('');
  await expect(page.locator('.msg-user, .message-user, [class*="user"]').first()).toContainText('帮我审查这个仓库的构建脚本');

  health.assertHealthy();
});

test('E-PM-LANDING-003 @mock-backend 打开项目取消：仍在落地页且文本保留', async ({ page }) => {
  const health = attachHealthGuards(page);
  await gotoLanding(page);

  // 覆盖目录选择器为取消（返回空）
  await page.evaluate(() => {
    const f = (window as unknown as {
      forge: { dialog: { selectDirectory: () => Promise<string | null> } };
    }).forge;
    f.dialog.selectDirectory = async () => null;
  });

  const input = page.locator('.landing-hero .compose-input');
  await input.fill('取消后不应丢字');

  // 走「打开项目…」入口并取消：不发送、不建会话，文本保留在落地输入框
  await page.locator('.landing-hero .proj-pill').click();
  await page.locator('.landing-hero .proj-item', { hasText: '打开项目…' }).click();

  await expect(page.locator('.landing-hero')).toBeVisible();
  await expect(input).toHaveValue('取消后不应丢字');

  health.assertHealthy();
});
