/**
 * 全局 tooltip（data-tooltip）E2E 回归：滚动容器内锚点定位。
 *
 * 历史 bug：旧实现 [data-tooltip]:hover::after 用 position: fixed 且未设 top/left，
 * 依赖"静态位置"落位。项目列表（.project-tree，overflow-y: auto）滚动后，
 * 静态位置按滚动内容坐标系计算，而 fixed 定位不随祖先滚动修正
 * → tooltip 屏幕位置向下偏移恰好等于 scrollTop，黑框飘到侧边栏底部
 * （用户实测：hover 项目组「更多操作」按钮时出现）。
 * 现实现：src/tooltip.ts 单例元素 + getBoundingClientRect 视口定位，免疫滚动偏移。
 *
 * 注：
 * - 树内操作按钮默认 opacity:0 + pointer-events:none（hover 行才显示），
 *   locator.hover() 的 hit-target 前置检查会死循环，故用两段式 page.mouse.move
 *   （先入行激活 :hover，等样式生效后再移到按钮中心，模拟真实鼠标轨迹）。
 * - 多项目种子经「重命名项目 → onRenameProject → loadProjects()」这一真实 UI
 *   路径生效：seed 处理器不跨 reload 持久化，而 onMounted 首查早于任何可注册
 *   时机（竞态），重命名后的 re-query 则发生在注册之后，确定性通过。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

/** 种子项目路径 */
const PROJ_PATHS = Array.from({ length: 12 }, (_, i) => `D:/work/demo-proj-${i}`);

/** 两段式鼠标移入：先移到元素所在行左侧空白（激活行 :hover → 按钮 pointer-events 恢复），
 * 等样式生效后再移到元素中心。locator.hover() 对 reveal-on-hover 按钮会死循环。 */
async function mouseTo(page: Page, selector: string, nth = 0): Promise<void> {
  const box = await page.locator(selector).nth(nth).boundingBox();
  expect(box, `locator ${selector}[${nth}] 应有几何`).not.toBeNull();
  await page.mouse.move(box!.x - 40, box!.y + box!.height / 2, { steps: 2 });
  await page.waitForTimeout(80);
  await page.mouse.move(box!.x + box!.width / 2, box!.y + box!.height / 2, { steps: 3 });
  // 等待输入队列 flush + hover 样式生效：Runtime.evaluate 可能插队在未处理的
  // mousemove 之前，导致量到滞留锚点（人类操作不可能快过一帧，无此问题）
  await page.waitForTimeout(150);
}

/** tooltip 相对锚点的几何数据 */
interface TipGeo {
  shown: boolean;
  gapAbove: number;
  centerXOffset: number;
}

/** 读取 tooltip 与锚点的相对几何（单次 evaluate 原子取，规避滚动漂移） */
function readTipGeo(page: Page, anchorSelector: string, nth = 0): Promise<TipGeo | null> {
  return page.evaluate(
    ([sel, i]) => {
      const tip = document.querySelector('.global-tooltip');
      const btn = document.querySelectorAll(sel)[i] as HTMLElement | null;
      if (!tip || !btn) return null;
      const t = tip.getBoundingClientRect();
      const b = btn.getBoundingClientRect();
      return {
        shown: tip.classList.contains('is-visible'),
        gapAbove: b.top - t.bottom,
        centerXOffset: t.x + t.width / 2 - (b.x + b.width / 2),
      };
    },
    [anchorSelector, nth] as const,
  );
}

/** 进入应用：种子 12 个项目 × 8 条会话（经「重命名」UI 触发 re-query 生效），
 * 选中首个项目并展开其全部会话，使 .project-tree 显著溢出可滚 */
async function bootWithOverflowTree(page: Page): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await page.evaluate((paths) => {
    window.__forgeMock!.seed('project/queryProjectList', () => ({
      code: 0,
      message: 'ok',
      data: {
        projects: paths.map((p, i) => ({
          path: p,
          alias: `演示项目${i}`,
          lastOpenedAt: new Date().toISOString(),
          trust: 'trusted',
        })),
      },
    }));
    const sessions = paths.flatMap((p, i) =>
      Array.from({ length: 8 }, (_, j) => ({
        sessionId: `sess-p${i}-${j}`,
        projectPath: p,
        alias: `项目${i}会话${j}`,
        status: 'idle',
        lastActiveAt: new Date().toISOString(),
        doneReadAt: null,
      })),
    );
    window.__forgeMock!.setSessions(sessions);
  }, PROJ_PATHS);

  // 真实 UI 路径触发 loadProjects()：右键项目 → 菜单「重命名」→ 提交
  // （updateProjectAlias 走 mock 默认成功；rename 提交后 onRenameProject 重新查询项目列表）
  await page.locator('.tree-project').first().click({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '重命名' }).click();
  const rename = page.locator('.tree-rename-input');
  await expect(rename).toBeVisible();
  await rename.fill('演示项目0');
  await rename.press('Enter');

  // 12 个项目组渲染后，选中首个项目加载其会话（点击行右侧空白，避开标题的折叠热区）
  await expect(page.locator('.tree-node-title:not(.free-title)')).toHaveCount(PROJ_PATHS.length);
  const row = page.locator('.tree-project').first();
  const rowBox = (await row.boundingBox())!;
  await row.click({ position: { x: rowBox.width - 110, y: rowBox.height / 2 } });
  // loadSessions 为全量加载：12 个项目组各显示前 5 条（VISIBLE_SESSION_LIMIT）→ 60 行
  await expect(page.locator('.tree-session')).toHaveCount(60);
}

// TOOLTIP-E2E-001：用户上报场景——滚动后 hover「更多操作」，tooltip 贴按钮上方
// （旧实现此场景下 tooltip 向下偏移 scrollTop，黑框飘到侧边栏底部）
test('TOOLTIP-E2E-001 @P0 @mock-backend：滚动后 tooltip 贴「更多操作」上方，不随 scrollTop 偏移', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithOverflowTree(page);

  // 把第 3 个项目的 header 滚到视口 y≈220（树列表可视区中部，远离 sidebar-top 遮挡）
  const scrolled = await page.evaluate(() => {
    const scroller = document.querySelector('.project-tree') as HTMLElement | null;
    const headers = document.querySelectorAll('.project-more-trigger');
    const header = headers[2] as HTMLElement | null;
    if (!scroller || !header) return -1;
    const target = Math.max(1, Math.round(header.getBoundingClientRect().top - 220));
    scroller.scrollTop = target;
    return scroller.scrollTop;
  });
  // 断言真实发生了滚动：旧实现的 tooltip 偏移量 = scrollTop（>12px ≫ 2px 断言容差）
  expect(scrolled).toBeGreaterThan(12);

  await mouseTo(page, '.project-more-trigger', 2);

  const geo = await readTipGeo(page, '.project-more-trigger', 2);
  expect(geo).not.toBeNull();
  expect(geo!.shown).toBe(true);
  // tooltip 底缘在按钮上方 8px、水平中心与按钮对齐
  expect(Math.abs(geo!.gapAbove - 8)).toBeLessThanOrEqual(2);
  expect(Math.abs(geo!.centerXOffset)).toBeLessThanOrEqual(2);

  // 鼠标移出后隐藏
  await page.mouse.move(600, 400);
  await expect(page.locator('.global-tooltip')).not.toHaveClass(/is-visible/);

  health.assertHealthy();
});

// TOOLTIP-E2E-002：大幅滚动下 hover 会话行「删除会话」按钮，同一回归面
test('TOOLTIP-E2E-002 @P1 @mock-backend：大幅滚动后 tooltip 贴会话行按钮上方', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithOverflowTree(page);

  // 自适应滚动：取视口下缘外的第一个会话行按钮，滚动让它落到 y≈300（可视区中部）
  // （固定 scrollTop=200 会把早期行推进 sidebar-top 工具栏的遮挡区，选点不可靠）
  const scrolled = await page.evaluate(() => {
    const scroller = document.querySelector('.project-tree') as HTMLElement | null;
    if (!scroller) return -1;
    const target = Array.from(
      document.querySelectorAll<HTMLElement>('.tree-session [data-tooltip]'),
    ).find((b) => b.getBoundingClientRect().top >= 480);
    if (!target) return -1;
    const delta = Math.round(target.getBoundingClientRect().top - 300);
    scroller.scrollTop += delta;
    return scroller.scrollTop;
  });
  // 断言真实发生了滚动：旧实现的 tooltip 偏移量 = scrollTop（>12px ≫ 2px 断言容差）
  expect(scrolled).toBeGreaterThan(12);

  // 选一个视口内、上方有 tooltip 空间、且未被遮挡的会话行按钮
  // 注：按钮默认 pointer-events:none，elementFromPoint 不会返回它自身，
  // 因此「未被遮挡」的判据 = 命中点落在本行（.tree-session）内部
  const idx = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('.tree-session [data-tooltip]'));
    return buttons.findIndex((b) => {
      const r = b.getBoundingClientRect();
      if (r.top < 150 || r.top > 420) return false;
      const row = b.closest('.tree-session');
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return hit !== null && row !== null && row.contains(hit) && row.contains(b);
    });
  });
  expect(idx).toBeGreaterThanOrEqual(0);

  await mouseTo(page, '.tree-session [data-tooltip]', idx);

  const geo = await readTipGeo(page, '.tree-session [data-tooltip]', idx);
  expect(geo).not.toBeNull();
  expect(geo!.shown).toBe(true);
  expect(Math.abs(geo!.gapAbove - 8)).toBeLessThanOrEqual(2);
  expect(Math.abs(geo!.centerXOffset)).toBeLessThanOrEqual(2);

  health.assertHealthy();
});
