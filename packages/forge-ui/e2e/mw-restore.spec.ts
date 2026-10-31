/**
 * 临时复现：贴边吸附 → 退出多窗口 → 重进，验证布局是否保留。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, expandAllProjects, seedSessions } from './helpers/index';

function mkSession(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    projectPath: 'D:/work/aiwork/forge',
    alias: null,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
    ...over,
  };
}

async function boot(page: Page, sessions: Array<Record<string, unknown>>): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  // v6.26 默认折叠：展开项目组
  await expect(page.locator('.tree-project').first()).toBeVisible();
  await expandAllProjects(page);
}

interface Rect { x: number; y: number; w: number; h: number }

async function winRect(page: Page): Promise<Rect> {
  return page.evaluate(() => {
    const el = document.querySelector('.mw-win') as HTMLElement;
    return {
      x: parseFloat(el.style.left),
      y: parseFloat(el.style.top),
      w: parseFloat(el.style.width),
      h: parseFloat(el.style.height),
    };
  });
}

async function canvasSize(page: Page): Promise<{ cw: number; ch: number }> {
  return page.evaluate(() => {
    const el = document.querySelector('.mw-canvas') as HTMLElement;
    return { cw: el.clientWidth, ch: el.clientHeight };
  });
}

test('贴边吸附布局在退出/重进多窗口后保留', async ({ page }) => {
  const health = attachHealthGuards(page);
  const win = mkSession({ alias: '贴边会话' });
  await boot(page, [win]);

  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();

  // 拖入并贴左边缘吸附
  const sessionEl = page.locator('.tree-session', { hasText: '贴边会话' });
  const canvas = page.locator('.mw-canvas');
  const box = (await canvas.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await sessionEl.dispatchEvent('dragstart', { dataTransfer });
  await canvas.dispatchEvent('dragover', {
    dataTransfer,
    clientX: box.x + 5,
    clientY: box.y + box.height / 2,
  });
  await canvas.dispatchEvent('drop', {
    dataTransfer,
    clientX: box.x + 5,
    clientY: box.y + box.height / 2,
  });
  await expect(page.locator('.mw-win')).toHaveCount(1);

  const { cw, ch } = await canvasSize(page);
  // 贴边几何以 forge-core 的 snapRectFor 为准（windowLayout.ts）：
  //   left = { x: 0, y: 0, w: round((cw - MW_GAP) / 2), h: ch }，MW_GAP = 4。
  // 旧断言写的是 x/y=4、w=(cw-12)/2、h=ch-8 —— 那是「窗口四周留 4px 内边距」的
  // 早期方案，现行实现是「窗口贴满边缘，只在**窗口之间**留 MW_GAP」，
  // 于是左边窗口必然 x=0/y=0、高度=画布高。改公式不改实现（实现有 forge-core 单测锁）。
  const snapped: Rect = {
    x: 0,
    y: 0,
    w: Math.round((cw - 4) / 2),
    h: ch,
  };
  const afterSnap = await winRect(page);
  expect(afterSnap).toEqual(snapped);

  // 退出多窗口 → 重进
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toHaveCount(0);
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();
  await expect(page.locator('.mw-win')).toHaveCount(1);

  const afterRestore = await winRect(page);
  console.log('snap:', JSON.stringify(afterSnap), 'restore:', JSON.stringify(afterRestore), `canvas: ${cw}x${ch}`);
  expect(afterRestore).toEqual(afterSnap);
  health.assertHealthy();
});

test('画布尺寸变化后恢复贴边布局：等比缩放保持贴边关系', async ({ page }) => {
  const health = attachHealthGuards(page);
  const win = mkSession({ alias: '缩放会话' });
  await boot(page, [win]);

  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();

  // 拖入并贴左边缘吸附
  const sessionEl = page.locator('.tree-session', { hasText: '缩放会话' });
  const canvas = page.locator('.mw-canvas');
  const box = (await canvas.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await sessionEl.dispatchEvent('dragstart', { dataTransfer });
  await canvas.dispatchEvent('dragover', {
    dataTransfer,
    clientX: box.x + 5,
    clientY: box.y + box.height / 2,
  });
  await canvas.dispatchEvent('drop', {
    dataTransfer,
    clientX: box.x + 5,
    clientY: box.y + box.height / 2,
  });
  await expect(page.locator('.mw-win')).toHaveCount(1);

  const before = await canvasSize(page);
  // 同上方用例：现行贴边几何是 x/y=0、宽=(cw-MW_GAP)/2、高=ch（MW_GAP=4）
  const snap: Rect = { x: 0, y: 0, w: Math.round((before.cw - 4) / 2), h: before.ch };
  expect(await winRect(page)).toEqual(snap);

  // 退出 → 改变主窗口尺寸（画布随之变大）→ 重进
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toHaveCount(0);
  await page.setViewportSize({ width: 1700, height: 1000 });
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();
  await expect(page.locator('.mw-win')).toHaveCount(1);

  const after = await canvasSize(page);
  const sx = after.cw / before.cw;
  const sy = after.ch / before.ch;
  // 等比缩放 + clamp 到画布边界。上限不再减 8：现行贴边窗口是「贴满边缘」，
  // 高度等于画布高（见上），旧公式的 -8 是早期「四周留 4px」方案留下的。
  const expected: Rect = {
    x: Math.max(0, Math.min(Math.round(snap.x * sx), after.cw - Math.min(Math.round(snap.w * sx), after.cw))),
    y: Math.max(0, Math.min(Math.round(snap.y * sy), after.ch - Math.min(Math.round(snap.h * sy), after.ch))),
    w: Math.min(Math.round(snap.w * sx), after.cw),
    h: Math.min(Math.round(snap.h * sy), after.ch),
  };
  const restored = await winRect(page);
  console.log('before:', JSON.stringify(snap), `(${before.cw}x${before.ch})`, 'restored:', JSON.stringify(restored), `(${after.cw}x${after.ch})`);
  expect(restored).toEqual(expected);
  // 贴边关系保持：左边缘仍带 4px 设计间距，而非漂移到画布中部
  expect(restored.x).toBeLessThanOrEqual(8);
  health.assertHealthy();
});
