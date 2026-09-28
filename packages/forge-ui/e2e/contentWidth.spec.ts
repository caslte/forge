/**
 * 个性化「内容宽度」偏好 E2E（standard 收拢居中 / wide 铺满，默认 wide）。
 *
 * 覆盖三件事：
 * 1. 默认（未写偏好）= 宽，行为与改造前一致（老用户零感知）；
 * 2. 切「标准」后正文列 = --content-col-std（920px）且居中，
 *    与输入框、状态行严格同轴（含左缘时间线窄条的对称补偿）；
 * 3. 窗口窄于标准列宽时退化为满宽（min() 兜底），不会被压成窄条。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards } from './helpers/index';

/** 新会话发一条消息 → 真实会话态（有消息流，非首屏 hero 草稿态） */
async function openConversation(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await page.locator('.compose-input').fill('把这个列表页改成虚拟滚动');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.conv-messages-inner .msg').first()).toBeVisible();
  await page.waitForTimeout(400);
}

/** 打开设置面板 → 个性化 Tab，点选内容宽度 */
async function setContentWidth(page: Page, label: '标准' | '宽'): Promise<void> {
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '个性化' }).click();
  await page.locator('.width-option', { hasText: label }).click();
  await expect(page.locator('.width-option.active')).toHaveText(label);
  await page.locator('.settings-close').click();
  // 等宽度过渡（--transition-decelerate 420ms）结束再量
  await page.waitForTimeout(700);
}

/** 量正文列 / 输入框 / 状态行的宽度与位置 */
async function widths(page: Page) {
  return page.evaluate(() => {
    const inner = document.querySelector('.conv-messages-inner') as HTMLElement;
    const box = document.querySelector('.compose-box') as HTMLElement;
    const status = document.querySelector('.compose-status') as HTMLElement | null;
    const view = document.querySelector('.conv-view') as HTMLElement;
    const ir = inner.getBoundingClientRect();
    return {
      inner: Math.round(ir.width),
      box: Math.round(box.getBoundingClientRect().width),
      status: status ? Math.round(status.getBoundingClientRect().width) : null,
      innerLeft: Math.round(ir.left),
      boxLeft: Math.round(box.getBoundingClientRect().left),
      viewLeft: Math.round(view.getBoundingClientRect().left),
      viewRight: Math.round(view.getBoundingClientRect().right),
      vw: window.innerWidth,
    };
  });
}

test('内容宽度：默认宽 = 铺满；切标准 = 收拢居中且与输入框对齐 @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openConversation(page);

  // 默认（未设置偏好）= 宽
  expect(await page.evaluate(() => localStorage.getItem('forge:content-width'))).toBeNull();
  const wide = await widths(page);
  expect(wide.inner, '宽模式正文列应铺满').toBeGreaterThan(wide.vw - 400);

  await setContentWidth(page, '标准');
  expect(await page.evaluate(() => localStorage.getItem('forge:content-width'))).toBe('standard');

  const std = await widths(page);
  expect(std.inner, '标准模式正文列 = 920px（--content-col-std）').toBe(920);
  expect(std.box, '标准模式输入框与正文列同宽').toBe(920);
  expect(Math.abs(std.innerLeft - std.boxLeft), '正文列左缘与输入框左缘对齐').toBeLessThanOrEqual(1);
  if (std.status !== null) {
    expect(Math.abs(std.status - 920), '状态行跟随列宽').toBeLessThanOrEqual(1);
  }
  // 居中：在会话视口（排除侧边栏）内左右留白相等（时间线窄条已对称补偿）
  const leftGap = std.innerLeft - std.viewLeft;
  const rightGap = std.viewRight - (std.innerLeft + std.inner);
  expect(Math.abs(leftGap - rightGap), `左留白 ${leftGap} / 右留白 ${rightGap}`).toBeLessThanOrEqual(2);

  // 切回宽：立即恢复铺满
  await setContentWidth(page, '宽');
  expect(await page.evaluate(() => localStorage.getItem('forge:content-width'))).toBe('wide');
  expect((await widths(page)).inner, '切回宽后恢复铺满').toBeGreaterThan(1000);

  health.assertHealthy();
});

test('内容宽度：标准模式在窄窗格退化为满宽 @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 820, height: 800 });
  await page.addInitScript(() => localStorage.setItem('forge:content-width', 'standard'));
  await openConversation(page);

  const narrow = await widths(page);
  expect(narrow.inner, '窗口窄于标准列宽时退化为满宽').toBeLessThan(920);
  expect(narrow.inner, '不应被压成一条窄条').toBeGreaterThan(300);

  health.assertHealthy();
});
