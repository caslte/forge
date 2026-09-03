/**
 * @ 文件补全浮窗 E2E（docs/test/03_conversation/e2e.md E-CV-019，模块 03 CV-S01 扩展 v3.30）。
 * 自动化等级：mock-backend（mock-bridge file.listProjectFiles 返回固定清单）。
 *
 * 覆盖：
 * - E-CV-019（AC-CV-034/035/036）：行内 @ 触发浮窗、按 token 过滤、↑↓+Enter 选中
 *   （@token 移除 + 文件进待发区）、Esc 关闭、无匹配降级不阻塞输入。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  waitForMock,
  seedSessions,
} from './helpers/index';

const SESSION_ID = 'e2e-at-session';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    projectPath: 'D:/work/aiwork/forge',
    alias: '@补全会话',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();
}

/** E-CV-019（AC-CV-034/035/036）：触发/过滤/选中进待发区/关闭/空态 */
test('TSC-E2E-006 @P1 @mock-backend E-CV-019：@ 补全触发、过滤、选中进待发区、Esc 关闭、空态不阻塞', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  const input = page.locator('.compose-input');
  const menu = page.locator('.at-menu');

  // 行内 @ 触发：列出候选（mock 清单 3 条）
  await input.click();
  await input.pressSequentially('看下 @');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.at-item')).toHaveCount(3);

  // 输入过滤串：read 命中 README.md（basename 包含，路径不含 read 的被排除）
  await input.pressSequentially('read');
  await expect(menu.locator('.at-item')).toHaveCount(1);
  await expect(menu.locator('.at-name').first()).toContainText('README.md');

  // ↑↓ 导航 + Enter 选中：@token 移除、待发区 chip 出现
  await input.press('ArrowDown');
  await input.press('Enter');
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue('看下 ');
  await expect(page.locator('.attach-chip').first()).toBeVisible();

  // 空态降级：无匹配提示 + Esc 关闭，输入不被阻塞
  await input.pressSequentially('@zzz');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.slash-empty')).toHaveText('无匹配文件');
  await input.press('Escape');
  await expect(menu).toBeHidden();
  await expect(input).toHaveValue('看下 @zzz');
  guard.assertHealthy();
});
