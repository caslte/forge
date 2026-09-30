/**
 * 输入框抬升契约 E2E（v6.4 悬浮感 / v6.5 流式改投影呼吸）。
 *
 * 覆盖（两条都已按文件粒度 git stash 回退改动确认过「改动前必红」）：
 * - ELEV-E2E-001：边框色三态恒定——静息 / 聚焦 / 流式下 borderTopColor 必须一致。
 *   旧实现（v6.5 之前）.compose-box.streaming 会把 borderTopColor 换成 --foreground 并按
 *   35%↔85% 呼吸（深色主题实测 rgb(89,91,94) ↔ rgb(163,166,169)，亮度摆幅 1.9 倍），
 *   这条用例在旧实现下第 3 步必失败。
 * - ELEV-E2E-002：抬升档位——静息 --elev-1、聚焦 --elev-2、流式在 --elev-2 上呼吸。
 *   旧实现流式时只有扩散半径为 0 的透明环，断言 boxShadow 含 '16px'（--elev-2 的环境段）必失败。
 *
 * 自动化等级：mock-backend（window.__forgeMock.onSend 注入慢回复，留出流式窗口）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSendScript, seedSessions } from './helpers/index';

const SESSION_ID = 'e2e-elevation-session';
const ALIAS = '抬升验收';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    projectPath: 'D:/work/aiwork/forge',
    alias: ALIAS,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 慢回复：留出流式窗口给断言 */
const SLOW_SCRIPT = [
  {
    type: 'message' as const,
    delayMs: 8000,
    payload: { role: 'assistant', content: 'ok', ts: new Date().toISOString() },
  },
];

async function boot(page: Page, theme: 'light' | 'dark' = 'light'): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, SLOW_SCRIPT);
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, SLOW_SCRIPT);
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: ALIAS }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  // 让抬升令牌在主题切换后落位
  await page.waitForTimeout(200);
}

const boxStyle = (page: Page) =>
  page.locator('.compose-box').evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      border: cs.borderTopColor,
      shadow: cs.boxShadow,
      animation: cs.animationName,
    };
  });

/**
 * 取「环境阴影」那一层的最大模糊半径（px）。
 *
 * 不能对 boxShadow 字符串做子串断言（首版就栽在这）：流式期间 animation 正在跑，
 * getComputedStyle 返回的是**插值中的中间帧**（实测读到 `0px 6.25903px 16.5181px`），
 * 写死 '16px' 必然随机失败。改成解析每层的第三个长度值取最大值，
 * 再按「静息 < 14px、聚焦/流式 ≥ 14px」判定档位——与动画相位无关。
 */
function maxBlurPx(shadow: string): number {
  const layers = shadow.split(/,(?![^(]*\))/);
  let max = 0;
  for (const layer of layers) {
    // 每层形如 "<color> <x> <y> <blur> [spread] [inset]"；取前三个长度值里的第三个
    const lengths = layer.match(/-?\d+(?:\.\d+)?px/g) ?? [];
    if (lengths.length >= 3) {
      max = Math.max(max, parseFloat(lengths[2]!));
    }
  }
  return max;
}

for (const theme of ['light', 'dark'] as const) {
  test(`ELEV-E2E-001 @P1 @mock-backend [${theme}] 边框色三态恒定：焦点与流式都不再换边框色`, async ({ page }) => {
    const guard = attachHealthGuards(page);
    await boot(page, theme);

    // 1) 静息（点消息区空白确保失焦）
    await page.locator('.conv-messages').click({ position: { x: 20, y: 20 } }).catch(() => {});
    await page.waitForTimeout(250);
    const idle = await boxStyle(page);

    // 2) 聚焦
    await page.locator('textarea.compose-input').click();
    await page.waitForTimeout(250);
    const focused = await boxStyle(page);

    // 3) 流式
    await page.locator('textarea.compose-input').fill('抬升契约用例');
    await page.locator('textarea.compose-input').press('Enter');
    await expect(page.locator('.compose-box.streaming')).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(250);
    const streaming = await boxStyle(page);

    expect(focused.border, '聚焦不应改边框色').toBe(idle.border);
    expect(streaming.border, '流式不应改边框色（v6.5 起「进行中」由投影呼吸表达）').toBe(idle.border);
    guard.assertHealthy();
  });

  test(`ELEV-E2E-002 @P1 @mock-backend [${theme}] 抬升档位：静息 → 聚焦 → 流式呼吸`, async ({ page }) => {
    const guard = attachHealthGuards(page);
    await boot(page, theme);

    await page.locator('.conv-messages').click({ position: { x: 20, y: 20 } }).catch(() => {});
    await page.waitForTimeout(250);
    const idle = await boxStyle(page);
    // 静息必须已有抬升（v6.4 之前是 box-shadow: none，这条同样能拦回归）
    expect(idle.shadow, '静息态必须有抬升投影').not.toBe('none');
    const idleBlur = maxBlurPx(idle.shadow);
    expect(idleBlur, `静息态应停在 --elev-1（环境段 10px），实读 ${idleBlur}px`).toBeLessThan(14);

    await page.locator('textarea.compose-input').click();
    await page.waitForTimeout(250);
    const focused = await boxStyle(page);
    const focusedBlur = maxBlurPx(focused.shadow);
    expect(focusedBlur, `聚焦应升到 --elev-2（环境段 34px），实读 ${focusedBlur}px`).toBeGreaterThanOrEqual(14);
    expect(focused.shadow).not.toBe(idle.shadow);

    await page.locator('textarea.compose-input').fill('抬升契约用例');
    await page.locator('textarea.compose-input').press('Enter');
    await expect(page.locator('.compose-box.streaming')).toBeVisible({ timeout: 8_000 });
    await page.waitForTimeout(250);
    const streaming = await boxStyle(page);

    // 流式：起始档就是 --elev-2（不回落到 --elev-1），且挂着呼吸动画
    expect(streaming.animation, '流式应有呼吸动画').toContain('stream-breathe');
    const streamingBlur = maxBlurPx(streaming.shadow);
    expect(
      streamingBlur,
      `流式呼吸必须在 --elev-2（34px）↔ 峰值（浅色 48px / 深色 46px）之间，实读 ${streamingBlur}px`,
    ).toBeGreaterThanOrEqual(33);
    guard.assertHealthy();
  });
}
