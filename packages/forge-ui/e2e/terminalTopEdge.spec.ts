/**
 * 终端面板上沿拖拽 E2E（回归：grip 曾被 .term 的 overflow:hidden 整段裁掉，
 * 热区不可命中 → 上沿实际拖不动）。
 *
 * 覆盖：
 * - AC-TE-001：面板打开后上沿热区跨骑面板顶边（上探出面板外 + 压进面板内），
 *   热区中心 hit-test 命中 grip 本体
 * - AC-TE-002：按住热区上拖，面板高度跟手变高，松手落 localStorage（forge:terminal-height）
 * - AC-TE-003：拖拽被 clamp：下限 120，上限 min(1200, 窗口高−280)（720 视口 = 440）
 * - AC-TE-004：面板收起后上沿热区不残留（不剩悬空热区劫持上方内容点击）
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

/** 打开终端面板并等高度过渡落定（默认 240） */
async function openTerminal(page: Page): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.term-toggle').click();
  await expect(page.locator('.term.open')).toBeVisible();
  await expect
    .poll(async () => (await page.locator('.term.open').boundingBox())?.height ?? 0, { timeout: 3_000 })
    .toBe(240);
}

function gripCenter(box: { x: number; y: number; width: number; height: number }): [number, number] {
  return [Math.round(box.x + box.width / 2), Math.round(box.y + box.height / 2)];
}

async function termHeight(page: Page): Promise<number> {
  return (await page.locator('.term.open').boundingBox())?.height ?? 0;
}

test('AC-TE-001/002：热区跨骑顶边可命中，上拖跟手变高并落盘', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openTerminal(page);

  const termBox = (await page.locator('.term.open').boundingBox())!;
  const gripBox = (await page.locator('.grip').boundingBox())!;

  // 热区上探出面板顶边之外，且至少压进面板内 2px（裁剪 bug 下内收量为 0）
  expect(gripBox.y).toBeLessThan(termBox.y);
  expect(gripBox.y + gripBox.height).toBeGreaterThanOrEqual(termBox.y + 2);

  // 热区中心 hit-test 命中 grip 本体（被裁掉的热区会命中别的元素）
  const [hx, hy] = gripCenter(gripBox);
  const hitIsGrip = await page.evaluate(
    ([cx, cy]) => document.elementFromPoint(cx, cy)?.classList.contains('grip') ?? false,
    [hx, hy],
  );
  expect(hitIsGrip).toBe(true);

  // 上拖 100px：240 → 340，拖拽中逐帧跟手；松手后写 localStorage
  const [cx, cy] = gripCenter(gripBox);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy - 100, { steps: 10 });
  await expect.poll(() => termHeight(page)).toBe(340);
  await page.mouse.up();
  await expect.poll(() => termHeight(page)).toBe(340);
  await expect.poll(() => page.evaluate(() => localStorage.getItem('forge:terminal-height'))).toBe('340');
  health.assertHealthy();
});

test('AC-TE-003：拖拽 clamp（下限 120 / 上限 窗口高−280）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openTerminal(page);

  // 一路下压 → 120 下限
  const [cx, cy] = gripCenter((await page.locator('.grip').boundingBox())!);
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 600, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => termHeight(page)).toBe(120);

  // 一路上拉 → 上限（720 视口：min(1200, 720−280) = 440）；热区随顶边移动，重取坐标
  const [, cy2] = gripCenter((await page.locator('.grip').boundingBox())!);
  await page.mouse.move(cx, cy2);
  await page.mouse.down();
  await page.mouse.move(cx, cy2 - 2000, { steps: 10 });
  await page.mouse.up();
  await expect.poll(() => termHeight(page)).toBe(440);
  health.assertHealthy();
});

test('AC-TE-004：面板收起后上沿热区不残留', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openTerminal(page);

  // 面板右端收起键（term-act 第二颗 = hidePanel）
  await page.locator('.term.open .term-act').last().click();
  await expect(page.locator('.term.open')).toHaveCount(0);
  await expect(page.locator('.grip')).toHaveCount(0);
  health.assertHealthy();
});
