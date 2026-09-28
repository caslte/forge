/** 临时：真机 vs demo 密集胶片（0~1000ms 每 125ms 一帧），跑完即删 */
import { test, expect } from '@playwright/test';
import { seedSessions, waitForMock } from './helpers/index';

const OUT = 'D:/work/aiwork/forge/prototypes';

const STAMPS = [0, 125, 250, 375, 500, 625, 750, 875, 1000];

async function filmstrip(page: import('@playwright/test').Page, sel: string, prefix: string) {
  const box = (await page.locator(sel).boundingBox())!;
  const clip = { x: box.x - 4, y: box.y - 4, width: box.width + 8, height: box.height + 40 };
  let prev = 0;
  for (const t of STAMPS) {
    await page.waitForTimeout(t - prev);
    prev = t;
    await page.screenshot({ path: `${OUT}/${prefix}-${String(t).padStart(4, '0')}.png`, clip });
  }
}

test('SHOT filmstrip', async ({ page }) => {
  // 真机
  await page.goto('/');
  await seedSessions(page, [{
    sessionId: 'sess-shot', projectPath: 'D:/work/aiwork/forge', alias: null,
    status: 'idle', lastActiveAt: new Date().toISOString(),
  }]);
  await page.reload();
  await waitForMock(page);
  await page.evaluate(() => {
    const m = (window as unknown as { __forgeMock: any }).__forgeMock;
    m.seed('model/queryModels', () => ({ code: 0, message: 'ok', data: { models: ['reason-pro'], defaultModel: 'reason-pro' } }));
    m.seed('model/getSessionModel', () => ({ code: 0, message: 'ok', data: { model: 'reason-pro', effective: 'session' } }));
    m.seed('model/getModelThinkingLevels', () => ({ code: 0, message: 'ok', data: { levels: ['off', 'low', 'medium', 'high', 'max'] } }));
    m.seed('model/getSessionThinkingLevel', () => ({ code: 0, message: 'ok', data: { level: 'high', effective: 'session' } }));
    m.seed('model/setSessionThinkingLevel', () => ({ code: 0, message: 'ok', data: null }));
  });
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await page.locator('.level-wrap .meta-link').click();
  await expect(page.locator('.level-seg')).toBeVisible();
  await page.locator('.level-seg .level-item', { hasText: 'max' }).click();
  // 量化：动画是否真在跑（读 background-position 随时间变化）+ 文字盒/按钮盒尺寸
  const probe = await page.evaluate(async () => {
    const out: any = { samples: [], textW: 0, btnW: 0, anim: '' };
    const t0 = performance.now();
    return await new Promise((resolve) => {
      const tick = () => {
        const el = document.querySelector('.level-item.sweep .level-t') as HTMLElement | null;
        const btn = document.querySelector('.level-item.sweep') as HTMLElement | null;
        if (el) {
          const cs = getComputedStyle(el);
          out.anim = cs.animationName + ' | ' + cs.animationDuration;
          out.textW = el.getBoundingClientRect().width;
          out.btnW = btn ? btn.getBoundingClientRect().width : 0;
          out.samples.push({
            t: Math.round(performance.now() - t0),
            bgPos: cs.backgroundPosition,
            fill: cs.webkitTextFillColor,
          });
        } else {
          out.samples.push({ t: Math.round(performance.now() - t0), gone: true });
        }
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else resolve(out);
      };
      requestAnimationFrame(tick);
    });
  });
  console.log('PROBE', JSON.stringify({ anim: probe.anim, textW: probe.textW, btnW: probe.btnW }));
  console.log('SAMPLES', JSON.stringify(probe.samples.filter((_, i) => i % 5 === 0)));
  await filmstrip(page, '.compose-box', 'fs-real');

  // demo（方案 A）
  await page.goto('file:///D:/work/aiwork/forge/prototypes/thinking-level-max-shimmer-demo.html');
  await page.locator('.schemes button', { hasText: 'A 就地扫光' }).click();
  await page.locator('#levelTrigger').click();
  await page.locator('.level-item', { hasText: 'max' }).click();
  const probe2 = await page.evaluate(async () => {
    const out: any = { samples: [], textW: 0, btnW: 0, anim: '' };
    const t0 = performance.now();
    return await new Promise((resolve) => {
      const tick = () => {
        const el = document.querySelector('.level-item.sweep .lv-t') as HTMLElement | null;
        const btn = document.querySelector('.level-item.sweep') as HTMLElement | null;
        if (el) {
          const cs = getComputedStyle(el);
          out.anim = cs.animationName + ' | ' + cs.animationDuration;
          out.textW = el.getBoundingClientRect().width;
          out.btnW = btn ? btn.getBoundingClientRect().width : 0;
          out.samples.push({ t: Math.round(performance.now() - t0), bgPos: cs.backgroundPosition });
        } else out.samples.push({ t: Math.round(performance.now() - t0), gone: true });
        if (performance.now() - t0 < 1000) requestAnimationFrame(tick);
        else resolve(out);
      };
      requestAnimationFrame(tick);
    });
  });
  console.log('PROBE2', JSON.stringify({ anim: probe2.anim, textW: probe2.textW, btnW: probe2.btnW }));
  console.log('SAMPLES2', JSON.stringify(probe2.samples.filter((_, i) => i % 5 === 0)));
  await filmstrip(page, '.composer', 'fs-demo');
});
