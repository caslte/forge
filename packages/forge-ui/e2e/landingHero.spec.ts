/**
 * 零项目落地 hero（v3.77）回归。
 *
 * 旧落地页是「水印卡片 + 打开项目按钮」；改版后与会话内空态 hero 同一视觉
 * 语言：forge 字标 + 居中输入框（LandingHero），项目区仅「打开项目…」入口。
 *
 * 草稿直通链路：落地输入 → Enter（无项目，发送=先选目录）→ mock selectDirectory
 * 返回目录 → 项目自动注册并打开 → LandingHero 卸载；输入文本经模块级草稿仓库
 * （utils/composerDrafts，草稿态统一 key）在项目视图的输入框挂载时自动回填。
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

test('E-PM-LANDING-001 @mock-backend 零项目落地 hero：水印 + 居中输入框 + 打开项目入口', async ({ page }) => {
  const health = attachHealthGuards(page);
  await gotoLanding(page);

  await expect(page.locator('.landing-hero')).toBeVisible();
  await expect(page.locator('.landing-wordmark.wm-dark')).toBeVisible();
  const input = page.locator('.landing-hero .compose-input');
  await expect(input).toBeVisible();
  await expect(input).toBeEnabled();

  // 项目区仅「打开项目…」入口，无项目条目（零项目）
  await page.locator('.landing-hero .proj-pill').click();
  await expect(
    page.locator('.landing-hero .proj-item', { hasText: '打开项目…' }),
  ).toBeVisible();
  await expect(page.locator('.landing-hero .proj-item')).toHaveCount(1);

  // 旧「选择项目」卡片不复活
  await expect(page.locator('.no-session-card')).toHaveCount(0);

  health.assertHealthy();
});

test('E-PM-LANDING-002 @mock-backend 落地发送 → 选目录开项目 → 文本直通草稿输入框', async ({ page }) => {
  const health = attachHealthGuards(page);
  await gotoLanding(page);

  const input = page.locator('.landing-hero .compose-input');
  await expect(input).toBeVisible();
  await input.fill('帮我审查这个仓库的构建脚本');
  await input.press('Enter');

  // mock selectDirectory 返回 D:/work/aiwork → 项目注册并打开 → 落地 hero 卸载
  await expect(page.locator('.landing-hero')).toHaveCount(0);
  await expect(page.locator('.conv-hero')).toBeVisible();

  // 已输入文本回填项目视图草稿输入框（draft 直通，用户无感衔接）
  const convInput = page.locator('.conv-input-wrap .compose-input');
  await expect(convInput).toHaveValue('帮我审查这个仓库的构建脚本');

  health.assertHealthy();
});

test('E-PM-LANDING-003 @mock-backend 目录选择取消：文本保留在落地输入框', async ({ page }) => {
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
  await input.press('Enter');

  // 仍在落地页，发送时暂存的文本已回填
  await expect(page.locator('.landing-hero')).toBeVisible();
  await expect(input).toHaveValue('取消后不应丢字');

  health.assertHealthy();
});
