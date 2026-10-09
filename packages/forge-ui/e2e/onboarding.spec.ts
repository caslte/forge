/**
 * 首次使用指引蒙层 E2E（模块 07 之外的新首次体验，2026-10-09）。
 *
 * 为什么要有这份用例：OnboardingTour 的全部风险都在几何与真实 DOM 锚点上——
 * 单测/typecheck 只能证明它能编译，证明不了「洞圈住了东西」「卡片没盖住洞」。
 * 所以这里逐步骤量 rect，并把两条实测出来的硬约束钉死：
 * - ONB-E2E-001 几何：洞必须包住锚点且不越窗；卡片必须完整在窗内且不压自己的洞。
 *   卡片落位走的是「右→左→下→上」四级候选 + 兜底，没有用例的话改一次常量就得手点一遍。
 * - ONB-E2E-002 锚点契约：六个主锚点里，带项目的 mock 场景只有 5 个在位
 *   （更新入口 UpdateEntry 的 v-if 不成立），清单必须自动缩成 5 步而不是留个空洞。
 *   同时钉住「蒙层期间被高亮控件必须可见」：<>（codeentry）在 .tree-node-actions 里，
 *   基类是 opacity:0 只在 hover 显形，而蒙层吃掉了 hover——不挂 ob-tour-active 就是洞圈住透明。
 * - ONB-E2E-003 退出与重看：Esc 能跳出且落盘 seen；「关于」页按钮先关设置再开蒙层
 *   （工具条是 v-if="activeView !== 'settings'"，不先关就会少两步）。
 * - ONB-E2E-004 零项目新装：全新装首启必然还没有项目，「<>」挂在项目行上根本不存在。
 *   早期版本这一步被剪掉（实测只剩 4 步），用户点名要讲的功能反而不讲；现在它退到
 *   「暂无项目」空态行（codeentry-empty）并换一套文案，用例钉住这个退路。
 *
 * 自动化等级：mock-backend（forge-mock-fresh-install=1 让 startupFlags 报新装）。
 * 视口钉 1280×800：与真机窗口同量级，531px 那种窄窗会触发兜底落位，量不出正常路径。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

const SEEN_KEY = 'forge:onboarding:seen:v1';
const FRESH_KEY = 'forge-mock-fresh-install';
const TREE_VIEW_KEY = 'forge:sidebar:view';
/** 只在本次 context 的第一次导航清 seen：否则 reload 也被清，就测不出「seen 之后不再自动开」 */
const INIT_KEY = 'e2e-onboarding-inited';

test.use({ viewport: { width: 1280, height: 800 } });

/** 新装首启：先清 seen 再放行蒙层；emptyProjects=true 再抹掉项目，复刻真实全新装的零项目侧栏 */
async function bootFresh(page: Page, emptyProjects = false): Promise<void> {
  await page.addInitScript(
    ([seenKey, freshKey, viewKey, initKey, projectsKey, sessionsKey, empty]) => {
      localStorage.setItem(freshKey, '1');
      if (!localStorage.getItem(initKey)) {
        localStorage.setItem(initKey, '1');
        localStorage.removeItem(seenKey);
      }
      // 项目视角才有行尾「<>」；任务视角是平摊会话，没有这个锚点
      localStorage.setItem(viewKey, 'project');
      if (empty) {
        localStorage.setItem(projectsKey, '[]');
        localStorage.setItem(sessionsKey, '[]');
      }
    },
    [
      SEEN_KEY,
      FRESH_KEY,
      TREE_VIEW_KEY,
      INIT_KEY,
      'forge-mock-projects',
      'forge-mock-sessions',
      emptyProjects,
    ] as const,
  );
  await page.goto('/');
  await waitForMock(page);
}

interface Geo {
  hole: { x: number; y: number; w: number; h: number };
  card: { x: number; y: number; w: number; h: number };
  anchor: string | null;
  anchorRect: { x: number; y: number; w: number; h: number } | null;
  anchorVisible: boolean;
  title: string;
  count: string;
}

/**
 * 量当前这一步：洞读内联 style（落位目标值），卡片读 rect（真几何）。
 * anchorVisible 沿祖先链查 opacity/display/visibility——只看锚点自己会漏掉 hover 显形那类隐藏。
 */
async function measure(page: Page): Promise<Geo> {
  return page.evaluate(() => {
    const spot = document.querySelector<HTMLElement>('.ob-spot');
    const card = document.querySelector<HTMLElement>('.ob-card');
    if (!spot || !card) throw new Error('蒙层未就位');
    const px = (v: string | null): number => Math.round(parseFloat(v || '0'));
    const st = spot.style;
    const hole = { x: px(st.left), y: px(st.top), w: px(st.width), h: px(st.height) };
    const cb = card.getBoundingClientRect();
    const cardRect = {
      x: Math.round(cb.left),
      y: Math.round(cb.top),
      w: Math.round(cb.width),
      h: Math.round(cb.height),
    };
    // 洞的中心对上哪个锚点，就认为这一步在讲它（同一步多个候选时取第一个）
    let hit: HTMLElement | null = null;
    let hitRect: Geo['anchorRect'] = null;
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[data-onboarding]'))) {
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) continue;
      const cx = r.left + r.width / 2;
      const cy = r.top + r.height / 2;
      if (cx >= hole.x && cx <= hole.x + hole.w && cy >= hole.y && cy <= hole.y + hole.h) {
        hit = el;
        hitRect = {
          x: Math.round(r.left),
          y: Math.round(r.top),
          w: Math.round(r.width),
          h: Math.round(r.height),
        };
        break;
      }
    }
    let visible = false;
    if (hit) {
      visible = true;
      let n: HTMLElement | null = hit;
      while (n && n !== document.documentElement) {
        const cs = getComputedStyle(n);
        if (parseFloat(cs.opacity) < 0.9 || cs.display === 'none' || cs.visibility === 'hidden') {
          visible = false;
          break;
        }
        n = n.parentElement;
      }
    }
    return {
      hole,
      card: cardRect,
      anchor: hit ? hit.getAttribute('data-onboarding') : null,
      anchorRect: hitRect,
      anchorVisible: visible,
      title: document.querySelector('.ob-title')?.textContent ?? '',
      count: document.querySelector('.ob-count')?.textContent ?? '',
    };
  });
}

const inWindow = (r: { x: number; y: number; w: number; h: number }): boolean =>
  r.x >= 0 && r.y >= 0 && r.x + r.w <= 1280 && r.y + r.h <= 800;

const overlaps = (
  a: { x: number; y: number; w: number; h: number },
  b: { x: number; y: number; w: number; h: number },
): boolean => !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

test('ONB-E2E-001/002：新装首启自动开蒙层，逐步量洞与卡片的真实几何', async ({ page }) => {
  const { assertHealthy } = attachHealthGuards(page);
  await bootFresh(page);

  await expect(page.locator('.ob-root')).toBeVisible({ timeout: 5_000 });
  // 落位过渡 420ms，等它停稳再量
  await page.waitForTimeout(600);

  const dots = await page.locator('.ob-dot').count();
  expect(dots, 'mock 场景没有更新入口，六步应自动缩成五步').toBe(5);

  const seen: Array<Geo> = [];
  for (let i = 0; i < dots; i += 1) {
    const g = await measure(page);
    seen.push(g);

    expect(g.anchor, `第 ${i + 1} 步的洞没圈住任何 data-onboarding 锚点`).not.toBeNull();
    expect(g.anchorVisible, `第 ${i + 1} 步（${g.anchor}）被高亮控件在蒙层下不可见`).toBe(true);
    expect(inWindow(g.hole), `第 ${i + 1} 步的洞越窗：${JSON.stringify(g.hole)}`).toBe(true);
    expect(inWindow(g.card), `第 ${i + 1} 步的卡片越窗：${JSON.stringify(g.card)}`).toBe(true);
    expect(
      overlaps(g.card, g.hole),
      `第 ${i + 1} 步（${g.anchor}）卡片压住了自己的洞：card=${JSON.stringify(g.card)} hole=${JSON.stringify(g.hole)}`,
    ).toBe(false);
    // 洞是锚点外扩 6px 再兜最小尺寸，所以锚点必须整个被包住
    const a = g.anchorRect!;
    expect(
      a.x >= g.hole.x && a.y >= g.hole.y && a.x + a.w <= g.hole.x + g.hole.w && a.y + a.h <= g.hole.y + g.hole.h,
      `第 ${i + 1} 步锚点没被洞包住 anchor=${JSON.stringify(a)} hole=${JSON.stringify(g.hole)}`,
    ).toBe(true);
    expect(g.hole.w).toBeGreaterThanOrEqual(76);
    expect(g.hole.h).toBeGreaterThanOrEqual(30);

    if (i < dots - 1) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(560);
    }
  }

  // 教学顺序与锚点契约：树 → 目录视图 → 新会话 → 终端 → 设置
  expect(seen.map((s) => s.anchor)).toEqual([
    'treelist',
    'codeentry',
    'newsession',
    'terminal',
    'settings',
  ]);

  // 收尾：最后一步的按钮是「开始使用」，点它蒙层散场且 seen 落盘
  await expect(page.locator('.ob-btn.primary')).toHaveText('开始使用');
  await page.locator('.ob-btn.primary').click();
  await expect(page.locator('.ob-root')).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), SEEN_KEY)).toBe('1');
  assertHealthy();
});

test('ONB-E2E-003：Esc 跳过即落盘， reload 不再自动开；关于页按钮能重看', async ({ page }) => {
  const { assertHealthy } = attachHealthGuards(page);
  await bootFresh(page);
  await expect(page.locator('.ob-root')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(300);

  // Esc 归指引，且不许再冒给 App 的分层退出
  await page.keyboard.press('Escape');
  await expect(page.locator('.ob-root')).toHaveCount(0);
  expect(await page.evaluate((k) => localStorage.getItem(k), SEEN_KEY)).toBe('1');
  // 蒙层散了就要把强制显形的那一档摘掉
  await expect
    .poll(() => page.evaluate(() => document.documentElement.classList.contains('ob-tour-active')))
    .toBe(false);

  // seen 之后不再自动开
  await page.reload();
  await waitForMock(page);
  await page.waitForTimeout(1_200);
  await expect(page.locator('.ob-root')).toHaveCount(0);

  // 从「关于」页重看：先关设置（工具条是 v-if，不关会少两步），再开蒙层
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();
  await page.locator('.settings-tab', { hasText: '关于' }).click();
  await page.locator('.tour-btn', { hasText: '开始指引' }).click();
  await expect(page.locator('.ob-root')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.ob-dot')).toHaveCount(5);
  await expect(page.locator('.ob-count')).toHaveText('1/5');
  assertHealthy();
});

test('ONB-E2E-004：零项目新装，第 2 步退到「暂无项目」空态并换配套文案', async ({ page }) => {
  const { assertHealthy } = attachHealthGuards(page);
  await bootFresh(page, true);

  await expect(page.locator('.ob-root')).toBeVisible({ timeout: 5_000 });
  await page.waitForTimeout(600);

  // 主锚点确实不在位（没有项目行就没有 <>），退路才成立
  expect(await page.locator('[data-onboarding="codeentry"]').count()).toBe(0);
  await expect(page.locator('.tree-empty')).toHaveText('暂无项目');

  const dots = await page.locator('.ob-dot').count();
  expect(dots, '零项目时更新入口同样缺席，应仍是五步而不是掉成四步').toBe(5);

  const seen: Array<Geo> = [];
  for (let i = 0; i < dots; i += 1) {
    const g = await measure(page);
    seen.push(g);
    expect(g.anchor, `第 ${i + 1} 步的洞没圈住任何锚点`).not.toBeNull();
    expect(g.anchorVisible, `第 ${i + 1} 步（${g.anchor}）被高亮内容不可见`).toBe(true);
    expect(inWindow(g.hole), `第 ${i + 1} 步的洞越窗`).toBe(true);
    expect(inWindow(g.card), `第 ${i + 1} 步的卡片越窗`).toBe(true);
    expect(overlaps(g.card, g.hole), `第 ${i + 1} 步卡片压住了自己的洞`).toBe(false);
    if (i < dots - 1) {
      await page.keyboard.press('Enter');
      await page.waitForTimeout(560);
    }
  }

  expect(seen.map((s) => s.anchor)).toEqual([
    'treelist',
    'codeentry-empty',
    'newsession',
    'terminal',
    'settings',
  ]);
  // 文案必须跟着锚点换：对着还没有的图标讲「点这个 <> 图标」是假话
  expect(seen[1]?.title).toBe('浏览目录要先有项目');
  expect(seen[0]?.title).not.toBe(seen[1]?.title);
  assertHealthy();
});
