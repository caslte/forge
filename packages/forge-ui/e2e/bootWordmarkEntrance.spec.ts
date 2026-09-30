/**
 * @ 启动页字标氛围动效 E2E（v3.87，G 档「心跳 · 循环」：双搏脉冲 + 歇拍）。
 *
 * v3.87 终版形态：字标**直接在场、零入场动画**——入场路线（A 柔边擦除 / B 逐字升起 /
 * C 锻打）全部废弃：逐字动画必须动 SVG 内部，拿不到合成器加速，真机预热期 CPU 被
 * 吃满时必卡（家族对照与取舍记录见 prototypes/boot-wordmark-entrance.html）。
 *
 * 心跳循环挂在专用包裹层 **.boot-wordmark-breath**（HTML 元素）上：opacity 可走
 * 合成器线程，主线程被预热挤满也照常 60fps。循环相位无关——没有发令、没有最少
 * 停留、没有兜底，也无所谓「窗口亮起时播掉开头」；交接帧安全由 0% 关键帧 = 满实
 * （= index.html splash 的静态终态）保证。
 *
 * 两条纪律（历代版本踩出来的，写在这里防止重犯）：
 *  1) 字标元素本身（.boot-wordmark）必须**无动画**——bootHandoff-002 锁定的
 *     v3.85.2 铁律；氛围动效只准挂包裹层，入场重放 bug 类在结构上不可能复发。
 *  2) prefers-reduced-motion 下循环必须整体消失，字标静态满实在场。
 */
import { test, expect, type Page } from '@playwright/test';

const THEME_KEY = 'forge:theme';
const BREATH = '.boot-welcome .boot-wordmark-breath';
const WORD = '.boot-welcome .boot-wordmark.wm-dark';
const WORD_LIGHT = '.boot-welcome .boot-wordmark.wm-light';

/** 冻结启动门闩（App 拉到的 bootState 恒未就绪 → BootWelcome 常驻屏上） */
async function installBoot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    let real: unknown;
    Object.defineProperty(window, 'forge', {
      configurable: true,
      set(v) {
        real = v;
        const base = (v ?? {}) as Record<string, unknown>;
        const wrapped = Object.create(base as object) as Record<string, unknown>;
        wrapped.bootState = () =>
          Promise.resolve({ ready: false, startedAt: 0, durationMs: null });
        Object.defineProperty(window, 'forge', { value: wrapped, configurable: true, writable: true });
      },
      get() {
        return real;
      },
    });
  });
}

/** 把页面全部动画钉在某一时刻；不 sleep，断言不 flaky（可重复钉，逐次推进相位） */
async function pinTime(page: Page, ms: number): Promise<void> {
  await page.evaluate((t) => {
    for (const a of document.getAnimations({ subtree: true })) {
      a.pause();
      a.currentTime = t;
    }
  }, ms);
}

async function breathState(page: Page) {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) throw new Error(`未找到 ${sel}`);
    const anims = el.getAnimations({ subtree: true }) as CSSAnimation[];
    return {
      anims: anims.map((a) => a.animationName),
      /** 无限循环 = Infinity，经 JSON 序列化会丢，转成布尔断言 */
      infinite: anims.map((a) => !Number.isFinite(Number(a.effect?.getTiming().iterations))),
      opacity: Number(getComputedStyle(el).opacity),
    };
  }, BREATH);
}

async function waitForWordmark(page: Page, selector: string): Promise<void> {
  await page.waitForFunction((sel) => {
    const w = document.querySelector(sel) as HTMLImageElement | null;
    return w !== null && w.complete && w.naturalWidth > 0;
  }, selector);
}

test('BOOT-SPLASH-006 @P0 @mock-backend 心跳循环常驻包裹层，字标本体零动画', async ({ page }) => {
  await installBoot(page);
  await page.goto('/');
  await expect(page.locator('.boot-welcome')).toBeVisible();
  await waitForWordmark(page, WORD);

  const s = await breathState(page);
  expect(s.anims, `包裹层应有且只有一条动画，实测 ${s.anims.join(',')}`).toHaveLength(1);
  expect(s.anims.join(','), '应为 boot-wm-heartbeat（scoped 名带哈希后缀）').toContain(
    'boot-wm-heartbeat',
  );
  expect(s.infinite.every(Boolean), '心跳必须是无限循环').toBe(true);

  // 字标本体（img）不得挂任何动画——v3.85.2 铁律，入场重放 bug 类不得复发
  const wordAnims = await page.evaluate(
    (sel) => document.querySelector(sel)!.getAnimations().length,
    WORD,
  );
  expect(wordAnims, '字标 img 本体不得挂任何动画（纪律 1）').toBe(0);
});

test('BOOT-SPLASH-007 @P0 @mock-backend 双搏形状与交接帧：关键帧相位抽查', async ({ page }) => {
  await installBoot(page);
  await page.goto('/');
  await expect(page.locator('.boot-welcome')).toBeVisible();
  await waitForWordmark(page, WORD);

  // 关键帧停靠点：0%=满实（交接帧必须与 splash 静态终态一致）、6/12/20% 双搏、32% 收口
  const stops: Array<[number, number]> = [
    [0, 1],
    [180, 0.72],
    [360, 0.88],
    [600, 0.55],
    [960, 1],
  ];
  for (const [t, want] of stops) {
    await pinTime(page, t);
    const s = await breathState(page);
    expect(
      Math.abs(s.opacity - want),
      `pin ${t}ms opacity=${s.opacity}，期望 ${want}`,
    ).toBeLessThan(0.005);
  }
});

test('BOOT-SPLASH-008 @P1 @mock-backend prefers-reduced-motion 下循环整体消失、字标满实', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await installBoot(page);
  await page.goto('/');
  await expect(page.locator('.boot-welcome')).toBeVisible();
  await waitForWordmark(page, WORD);
  await page.waitForTimeout(200);

  const s = await breathState(page);
  expect(s.anims, '减动效偏好下包裹层不得有动画（纪律 2）').toHaveLength(0);
  expect(s.opacity, '减动效时字标层必须满实（否则字是暗的）').toBe(1);
  const wordOpacity = await page.evaluate(
    (sel) => Number(getComputedStyle(document.querySelector(sel)!).opacity),
    WORD,
  );
  expect(wordOpacity, '字标本体必须满实').toBe(1);
});

test('BOOT-SPLASH-009 @P1 @mock-backend 浅色主题同一套循环（父层脉冲与主题无关）', async ({
  page,
}) => {
  await page.addInitScript(
    ([key, value]: [string, string]) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    [THEME_KEY, 'light'] as const,
  );
  await installBoot(page);
  await page.goto('/');
  await expect(page.locator('.boot-welcome')).toBeVisible();
  await waitForWordmark(page, WORD_LIGHT);

  const s = await breathState(page);
  expect(s.anims.join(','), '浅色主题应同样挂心跳循环').toContain('boot-wm-heartbeat');

  await pinTime(page, 600);
  const trough = await breathState(page);
  expect(
    Math.abs(trough.opacity - 0.55),
    `浅色主题父层谷值 opacity=${trough.opacity}，期望 0.55（字标本体的 0.8 与父层相乘）`,
  ).toBeLessThan(0.005);

  const lightBase = await page.evaluate(
    (sel) => Number(getComputedStyle(document.querySelector(sel)!).opacity),
    WORD_LIGHT,
  );
  expect(lightBase, '浅色字标本体静态透明度应为 0.8（v3.85.2 同参数）').toBe(0.8);
});
