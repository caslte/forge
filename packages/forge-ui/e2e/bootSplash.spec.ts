/**
 * @ 启动 splash 布局与主题 E2E（v3.78.4 布局 / v3.78.5 暗色）。
 *
 * 背景（两个 bug 同一个根）：v3.78.1 把启动 splash 内联进 index.html，靠「HTML 一解析即
 * 渲染」抢在模块链之前上屏。代价是**它上屏时全站样式与脚本都还不存在**：
 *   - Dev（npm run dev，Electron loadURL 51731）：global.css / design-tokens.css 由 main.ts
 *     的 import 在模块执行期注入；Prod 的 dist/index.html 是 head 里 render-blocking 的
 *     <link>，无此窗口。
 *   于是（1）body 默认 margin 8px 把 100vh 的 splash 撑出 16px 溢出：右侧滚动条 + 四周
 *   8px 白边（BOOT-SPLASH-001）；（2）data-theme 还没被 useTheme.ts 设上 → 暗色主题下
 *   splash 仍是亮色（BOOT-SPLASH-002/003）。
 *
 * 覆盖：
 * - BOOT-SPLASH-001 @P0：全站 CSS 未注入时 splash 自带最小 reset（零外边距、不溢出、铺满视口）。
 * - BOOT-SPLASH-002 @P0：持久化主题为 dark 时，模块链未执行即已切到暗色（同步引导脚本生效）。
 * - BOOT-SPLASH-003 @P0：门闩期间接管者 BootWelcome 同为暗色（splash → BootWelcome 不闪亮）。
 *
 * 覆写方式（防假绿）：page.route 把 /src/main.ts 换成等价空模块（200 正常响应，不产生
 * console error / requestfailed），把页面冻结在「splash 已上屏、模块链未执行」状态——
 * 这正是 Dev 冷编译窗口期的真实状态，不是人为造景。
 *
 * 自动化等级：mock-backend。003 的 bootState 拦截手法与 bootGate.spec.ts 同源
 * （必须拦 window.forge 的赋值瞬间——轮询覆写会晚于 onMounted，首轮实测假绿）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards } from './helpers/index';

const THEME_KEY = 'forge:theme';

/** 冻结模块链：/src/main.ts → 等价空模块（200 正常响应，无 console error） */
async function freezeBeforeModuleChain(page: Page): Promise<void> {
  await page.route('**/src/main.ts*', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/javascript',
      body: '/* e2e: 冻结模块链，保持 splash 上场时全站 CSS/JS 均未生效的状态 */',
    }),
  );
}

/** 预设持久化主题（与 useTheme.ts 同一个 key；addInitScript 每次导航都会先跑） */
async function presetTheme(page: Page, mode: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ([key, value]) => {
      try {
        localStorage.setItem(key, value);
      } catch {
        /* ignore */
      }
    },
    [THEME_KEY, mode] as const,
  );
}

/**
 * 冻结启动门闩：把 window.forge 的赋值瞬间替换成 bootState 恒 ready:false 的包裹对象。
 * 门闩放行依赖「推」与「拉」，另有 10s 超时逃生，这里只求把 BootWelcome 稳定留在屏上。
 */
async function freezeBootGate(page: Page): Promise<void> {
  await page.addInitScript(`(() => {
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

/**
 * 一次性原子读取「主题属性 + 几何 + 配色」。
 * 颜色经 canvas 归一化为 sRGB：getComputedStyle 对 oklch() 的序列化形式不稳定
 * （可能原样回 oklch(…)，也可能转 rgb(…)），canvas 是唯一与序列化无关的取色口径。
 * alpha 必查：变量解析失败时背景是透明的（rgba(0,0,0,0)），只看亮度会把「无色」误判成「暗色」。
 * 前景色取自 titleSelector（标题元素）而非容器：容器自身没声明 color，读到的是继承值，
 * 拿它断言等于空转（首轮实测：容器 color 恒为 rgb(0,0,0)）。
 */
async function readWelcomeState(page: Page, selector: string, titleSelector: string) {
  return page.evaluate(
    ([sel, titleSel]) => {
      const de = document.documentElement;
      const el = document.querySelector(sel);
      const title = document.querySelector(titleSel);
      if (el === null) throw new Error(`未找到 ${sel}`);
      if (title === null) throw new Error(`未找到 ${titleSel}`);
      const ctx = document.createElement('canvas').getContext('2d')!;
      ctx.canvas.width = 1;
      ctx.canvas.height = 1;
      const srgb = (css: string) => {
        ctx.clearRect(0, 0, 1, 1);
        ctx.fillStyle = '#000';
        ctx.fillStyle = css;
        ctx.fillRect(0, 0, 1, 1);
        const d = ctx.getImageData(0, 0, 1, 1).data;
        return {
          raw: css,
          alpha: d[3],
          luma: (0.2126 * d[0] + 0.7152 * d[1] + 0.0722 * d[2]) / 255,
        };
      };
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const bodyCs = getComputedStyle(document.body);
      return {
        themeAttr: de.getAttribute('data-theme'),
        bg: srgb(cs.backgroundColor),
        fg: srgb(getComputedStyle(title).color),
        marginTop: bodyCs.marginTop,
        marginLeft: bodyCs.marginLeft,
        vOverflow: de.scrollHeight - de.clientHeight,
        hOverflow: de.scrollWidth - de.clientWidth,
        top: r.top,
        left: r.left,
        width: r.width,
        height: r.height,
        viewportW: window.innerWidth,
        viewportH: window.innerHeight,
      };
    },
    [selector, titleSelector] as const,
  );
}

test('BOOT-SPLASH-001 @P0 @mock-backend splash 无全站样式时不得溢出（无滚动条 / 无白边），且为默认暗色', async ({
  page,
}) => {
  await freezeBeforeModuleChain(page);
  await page.goto('/');
  await expect(page.locator('#app-boot-splash')).toBeVisible();

  const s = await readWelcomeState(page, '#app-boot-splash', '#app-boot-splash .splash-name');

  // 1) 全站 reset 尚未生效时，splash 必须自带最小 reset
  expect(s.marginTop, `body margin-top=${s.marginTop}`).toBe('0px');
  expect(s.marginLeft, `body margin-left=${s.marginLeft}`).toBe('0px');

  // 2) 文档内容不得超出可视区（超出即产生滚动条，即使 overflow:hidden 把它藏起来）
  expect(s.vOverflow, `垂直溢出 ${s.vOverflow}px`).toBeLessThanOrEqual(1);
  expect(s.hOverflow, `水平溢出 ${s.hOverflow}px`).toBeLessThanOrEqual(1);

  // 3) splash 四边贴合视口（无滚动条时 innerWidth/Height 即可视区尺寸）
  expect(Math.abs(s.top), `top=${s.top}`).toBeLessThanOrEqual(1);
  expect(Math.abs(s.left), `left=${s.left}`).toBeLessThanOrEqual(1);
  expect(Math.abs(s.width - s.viewportW), `width=${s.width} vs ${s.viewportW}`).toBeLessThanOrEqual(1);
  expect(Math.abs(s.height - s.viewportH), `height=${s.height} vs ${s.viewportH}`).toBeLessThanOrEqual(1);

  // 4) 默认（无持久化主题）= 暗色，且引导脚本直接设上 data-theme（与 useTheme 默认值一致）
  expect(s.themeAttr, `data-theme=${s.themeAttr}`).toBe('dark');
  expect(s.bg.alpha, `底色不透明度（raw=${s.bg.raw}）`).toBe(255);
  expect(s.bg.luma, `暗色底 luma=${s.bg.luma}（raw=${s.bg.raw}）`).toBeLessThan(0.35);
  expect(s.fg.luma, `暗色字 luma=${s.fg.luma}（raw=${s.fg.raw}）`).toBeGreaterThan(0.6);
});

test('BOOT-SPLASH-002 @P0 @mock-backend 持久化为暗色时，模块链未执行即已是暗色欢迎页', async ({
  page,
}) => {
  await presetTheme(page, 'dark');
  await freezeBeforeModuleChain(page);
  await page.goto('/');
  await expect(page.locator('#app-boot-splash')).toBeVisible();

  const s = await readWelcomeState(page, '#app-boot-splash', '#app-boot-splash .splash-name');

  // 机制断言：模块链被冻结（useTheme.ts 根本没跑）时 data-theme 已在 <html> 上
  // —— 证明 index.html 的同步引导脚本生效，而不是事后靠模块链补的
  expect(s.themeAttr, `data-theme=${s.themeAttr}`).toBe('dark');

  // 视觉断言：暗底 + 亮字，底色必须不透明（变量解析失败会是透明）
  expect(s.bg.alpha, `底色不透明度（raw=${s.bg.raw}）`).toBe(255);
  expect(s.bg.luma, `暗色底 luma=${s.bg.luma}（raw=${s.bg.raw}）`).toBeLessThan(0.35);
  expect(s.fg.luma, `暗色字 luma=${s.fg.luma}（raw=${s.fg.raw}）`).toBeGreaterThan(0.6);
});

test('BOOT-SPLASH-003 @P0 @mock-backend 门闩期间的 BootWelcome 同为暗色（接管不闪亮）', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await presetTheme(page, 'dark');
  await freezeBootGate(page);
  await page.goto('/');

  await expect(page.locator('.boot-welcome')).toBeVisible({ timeout: 15_000 });
  const s = await readWelcomeState(page, '.boot-welcome', '.boot-welcome .boot-name');

  expect(s.themeAttr, `data-theme=${s.themeAttr}`).toBe('dark');
  expect(s.bg.alpha, `底色不透明度（raw=${s.bg.raw}）`).toBe(255);
  expect(s.bg.luma, `暗色底 luma=${s.bg.luma}（raw=${s.bg.raw}）`).toBeLessThan(0.35);
  expect(s.fg.luma, `暗色字 luma=${s.fg.luma}（raw=${s.fg.raw}）`).toBeGreaterThan(0.6);
  health.assertHealthy();
});

/**
 * BOOT-SPLASH-004（v3.78.8）：splash 的**字与图标**必须在模块链执行前就在场。
 *
 * 背景：v3.78.7 用户报「一开始没有字，只有白板」。像素统计口径（`bootFrame.ts`）能给出
 * 「这一帧有没有内容」，但它量的是真机窗口；这条用例从 DOM 侧把同一件事锁住——
 * 冻结模块链（= splash 整个展示窗口期的真实状态）后，splash 的文案/图标必须可见、
 * 有非零尺寸、且完整落在视口内。任何「容器高度塌成 0 / 文案被清空 / 元素被推出视口」
 * 都会在这里红，而不是等到用户看到白板。
 * 与 001 的分工：001 管几何与配色（不溢出、不亮暗错档），本用例管**内容在场**。
 */
test('BOOT-SPLASH-004 @P0 @mock-backend 模块链未执行时 splash 的字与图标必须在场（不得只有白板）', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await freezeBeforeModuleChain(page);
  await page.goto('/');
  await expect(page.locator('#app-boot-splash')).toBeVisible();

  // 文案与图标在场：`Forge` 字标 + 阶段文案 + 标志块 SVG
  await expect(page.locator('#app-boot-splash .splash-name')).toHaveText('Forge');
  const phase = (await page.locator('#app-boot-splash .splash-phase').textContent()) ?? '';
  expect(phase.trim().length, `阶段文案="${phase}" 不得为空`).toBeGreaterThan(0);
  await expect(page.locator('#app-boot-splash svg')).toBeVisible();

  // 几何：三者都必须有非零尺寸且完整落在视口内（原 bug 的表现是它们根本没上屏）
  const geo = await page.evaluate(() => {
    const pick = (sel: string) => {
      const el = document.querySelector(sel);
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { top: r.top, left: r.left, width: r.width, height: r.height };
    };
    return {
      name: pick('#app-boot-splash .splash-name'),
      phase: pick('#app-boot-splash .splash-phase'),
      icon: pick('#app-boot-splash svg'),
      viewportW: window.innerWidth,
      viewportH: window.innerHeight,
    };
  });

  const items = [
    { label: 'Forge 字标', rect: geo.name },
    { label: '阶段文案', rect: geo.phase },
    { label: '标志块', rect: geo.icon },
  ];
  for (const { label, rect } of items) {
    if (rect === null) throw new Error(`${label} 不在 DOM 中`);
    expect(rect.width, `${label} 宽度=${rect.width}`).toBeGreaterThan(0);
    expect(rect.height, `${label} 高度=${rect.height}`).toBeGreaterThan(0);
    expect(rect.top, `${label} top=${rect.top}`).toBeGreaterThanOrEqual(0);
    expect(rect.left, `${label} left=${rect.left}`).toBeGreaterThanOrEqual(0);
    expect(rect.top + rect.height, `${label} 下边界`).toBeLessThanOrEqual(geo.viewportH + 1);
    expect(rect.left + rect.width, `${label} 右边界`).toBeLessThanOrEqual(geo.viewportW + 1);
  }
  health.assertHealthy();
});
