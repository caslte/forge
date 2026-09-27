/**
 * 启动接管 E2E（v3.85.2）。
 *
 * 背景（两个用户反馈）：
 *   1) 「加载页 FORGE 字样会闪一下」——splash → BootWelcome 交接时，BootWelcome
 *      重放 0.4s 入场动画，且字标是另一份 URL 的新图（解码前盒子高度 0）。
 *   2) 「加载完成跳到新会话时，FORGE 字样调整了一下高度，跳了一下」——门闩放行时
 *      projects 恒为空（loadProjects 是放行后才发的异步 IPC），有项目的用户也会
 *      先闪现 LandingHero（字标几何 A），project 落地后换 ConversationView hero
 *      （字标几何 B）——同一枚字标 ~300ms 内被摆到两个位置。
 *
 * 覆盖：
 * - BOOT-HANDOFF-001：有项目种子启动，从放行到 .conv-hero 出现全程不得闪现 .landing-hero
 * - BOOT-HANDOFF-002：BootWelcome 字标无入场动画重放（animationName=none），宽度 320 与
 *   conv-hero 同尺寸（锁「splash/BootWelcome/hero 三处一致」不变量）
 * - BOOT-HANDOFF-003：conv-hero 字标宽度 320（默认视口下 min(40cqw,320px) 取上限）
 * - BOOT-HANDOFF-004：接管完成后 BootWelcome 覆盖层（淡出 veil）必须卸载，屏上只剩一份字标
 *
 * 自动化等级：mock-backend。002 的 bootState 冻结手法与 bootSplash.spec.ts 同源。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSessions } from './helpers/index';

/** 拦截 window.forge 赋值，把 bootState 钉成 ready:false（把 BootWelcome 稳定留在屏上） */
function freezeBootGate(page: Page): void {
  void page.addInitScript(`(() => {
    let real;
    Object.defineProperty(window, 'forge', {
      configurable: true,
      set(v) {
        real = v;
        const wrapped = Object.create(v);
        wrapped.bootState = () =>
          Promise.resolve({ ready: false, startedAt: 0, durationMs: null });
        Object.defineProperty(window, 'forge', {
          value: wrapped,
          configurable: true,
          writable: true,
        });
      },
      get() {
        return real;
      },
    });
  })()`);
}

test('BOOT-HANDOFF-001 @P0 @mock-backend 有项目启动全程不得闪现 LandingHero（boot 期假落地页）', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  // MutationObserver 常驻页面：任何时刻 .landing-hero 挂进 DOM 都记为闪现
  // （mock 默认就带一个项目，落地页只可能来自 boot 期的空 projects 竞态）
  await page.addInitScript(`(() => {
    window.__landingSeen = false;
    const obs = new MutationObserver(() => {
      if (document.querySelector('.landing-hero')) {
        window.__landingSeen = true;
        obs.disconnect();
      }
    });
    document.addEventListener('DOMContentLoaded', () =>
      obs.observe(document.body, { childList: true, subtree: true }),
    );
  })()`);
  await page.goto('/');
  await seedSessions(page, [
    {
      sessionId: 'e2e-boot-handoff-sess',
      projectPath: 'D:/work/aiwork/forge',
      alias: '接管会话',
      status: 'idle',
      lastActiveAt: new Date().toISOString(),
    },
  ]);
  await page.reload();
  await waitForMock(page);

  // 新会话空态 hero 出现 = 接管完成
  await expect(page.locator('.conv-hero')).toBeVisible({ timeout: 20_000 });
  expect(
    await page.evaluate(() => (window as unknown as { __landingSeen: boolean }).__landingSeen),
    'boot 期闪现了 .landing-hero（假落地页）',
  ).toBe(false);

  health.assertHealthy();
});

test('BOOT-HANDOFF-002 @P0 @mock-backend BootWelcome 字标无入场动画、宽度与 hero 档一致（320）', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await freezeBootGate(page);
  await page.goto('/');
  await waitForMock(page);
  await expect(page.locator('.boot-welcome')).toBeVisible({ timeout: 15_000 });

  const s = await page.evaluate(() => {
    const el = document.querySelector<HTMLElement>('.boot-wordmark.wm-dark');
    if (!el) throw new Error('.boot-wordmark.wm-dark 不在 DOM');
    // v3.85.2 前入场动画挂在祖先 .boot-logo 上（boot-fade-in）；修复后两处都应为 none
    const logo = document.querySelector<HTMLElement>('.boot-logo');
    return {
      width: el.getBoundingClientRect().width,
      selfAnim: getComputedStyle(el).animationName,
      logoAnim: logo ? getComputedStyle(logo).animationName : 'none',
    };
  });
  expect(s.selfAnim, `字标 animationName=${s.selfAnim}`).toBe('none');
  expect(s.logoAnim, `.boot-logo animationName=${s.logoAnim}`).toBe('none');
  expect(s.width, `BootWelcome 字标宽度=${s.width}`).toBeCloseTo(320, 0);

  health.assertHealthy();
});

test('BOOT-HANDOFF-003 @P0 @mock-backend conv-hero 字标宽度 320（与 BootWelcome 同档，接管零尺寸变化）', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await expect(page.locator('.conv-hero')).toBeVisible({ timeout: 20_000 });

  const w = await page.evaluate(
    () =>
      document.querySelector<HTMLElement>('.conv-hero-wordmark.wm-dark')?.getBoundingClientRect()
        .width ?? -1,
  );
  expect(w, `conv-hero 字标宽度=${w}`).toBeCloseTo(320, 0);
  health.assertHealthy();
});

test('BOOT-HANDOFF-004 @P0 @mock-backend 接管完成后 BootWelcome 必卸载，屏上只剩 hero 一份字标', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await expect(page.locator('.conv-hero')).toBeVisible({ timeout: 20_000 });

  // 淡出 veil（opacity 200ms + 400ms 卸载兜底）必须收口，不能常驻挡交互
  await expect(page.locator('.boot-welcome')).toHaveCount(0, { timeout: 3_000 });
  await expect(page.locator('#app-boot-splash')).toHaveCount(0);

  // 屏上可见的 FORGE 字标只剩 hero 那一份（另一份 wm-light 是 display:none 的镜像档）
  const visibleWords = await page.evaluate(() =>
    [...document.querySelectorAll<HTMLImageElement>('img[alt="FORGE"]')].filter(
      (im) => im.getBoundingClientRect().width > 0,
    ).length,
  );
  expect(visibleWords, `可见字标数=${visibleWords}`).toBe(1);

  health.assertHealthy();
});
