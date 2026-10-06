/**
 * 内置代码浏览器 E2E（CE-S01 ~ CE-S08，mock-backend）。
 *
 * 覆盖：<> 入口与左栏整栏互斥、目录懒加载与排序、文件只读查看与降级态、
 * 文件名过滤、多标签、A 整屏「对话宽度零变化」硬指标、B 分割 4px 沟与 320px 保底、
 * 双击复位、←/→ 步进、窄窗临时降级、Esc 逐级退出、偏好持久化、设置页。
 *
 * 进入语义（demo 定稿）：点 `<>` 只切左栏，**打开第一个文件才出代码纸**；
 * 布局类断言在 openCode 之后都必须先点一个文件。
 *
 * 布局类断言一律量真实几何（getBoundingClientRect），不靠 class 名——
 * 需求是「A 不许改变对话宽度」，只有像素能证伪。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

/** 打开代码浏览器并等根目录加载完。
 *  必须先 hover 项目行：<> 与 +/⋯ 一样是 hover 显形，父容器在非 hover 态是
 *  pointer-events:none，直接 click 会被 .tree-project 吃掉。 */
async function openCode(page: Page, projectName = 'forge'): Promise<void> {
  const row = page.locator('.tree-project', { hasText: projectName }).first();
  await row.hover();
  await row.locator('.code-entry').click();
  await expect(page.locator('.ctp')).toBeVisible();
  await expect(page.locator('.ctp-row').first()).toBeVisible();
  // 进入语义：只切左栏，右列还没有代码纸（对话页原样在场）
  await expect(page.locator('.cv')).toHaveCount(0);
}

/** 进代码态并打开 README.md——代码纸真正出现的标准前置 */
async function openCodeWithFile(page: Page): Promise<void> {
  await openCode(page);
  await page.locator('.ctp-row', { hasText: 'README.md' }).first().click();
  await expect(page.locator('.cv')).toBeVisible();
}

/** 展开代码树里某个目录 */
async function expandDir(page: Page, name: string): Promise<void> {
  const row = page.locator('.ctp-row.is-dir', { hasText: name }).first();
  await expect(row).toHaveAttribute('aria-expanded', 'false');
  await row.click();
  await expect(row).toHaveAttribute('aria-expanded', 'true');
}

/** 对话纸的渲染宽度（A 布局的硬指标就看这个数） */
function convWidth(page: Page): Promise<number> {
  return page
    .locator('.conv-messages, .session-stage')
    .first()
    .evaluate((el) => el.getBoundingClientRect().width);
}

/** 按文件名精确定位一行（文件或目录皆可）。与 openTreeFile 同一套定位口径，
 *  区别是这个不点击、只返回 Locator，供角标断言复用。
 *  排除 is-recent：最近打开分组里同名项也会出现在 DOM 里。 */
function rowOf(page: Page, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .locator('.ctp-scroll .ctp-row:not(.is-recent)')
    .filter({ has: page.locator('.ctp-name', { hasText: new RegExp(`^${esc}$`) }) })
    .first();
}

/** 展开代码树里剩余的未展开目录（mock 树只有 4 层，逐层展开到没有为止）。
 *
 *  用 ElementHandle 锁住具体那个节点：按名字重解析会在 src/file 与 test/file 上
 *  互相命中（hasText 是子串匹配），于是断言打在另一个已展开的目录上。 */
async function expandAll(page: Page): Promise<void> {
  for (let i = 0; i < 12; i++) {
    const row = page.locator('.ctp-row.is-dir[aria-expanded="false"]');
    if ((await row.count()) === 0) return;
    const handle = await row.first().elementHandle();
    if (!handle) return;
    await handle.click();
    await expect.poll(() => handle.getAttribute('aria-expanded')).toBe('true');
    await handle.dispose();
  }
}

/** 按文件名打开树里的文件（精确匹配，避免 fileService.ts 命中 fileService.test.ts）。
 *  排除 is-recent：最近打开分组里同名项也能点，但那是「切回去」而不是「打开新签」，
 *  测最近打开上限时两者必须能区分开。 */
async function openTreeFile(page: Page, name: string): Promise<void> {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  await page
    .locator('.ctp-scroll .ctp-row:not(.is-dir):not(.is-recent)')
    .filter({ has: page.locator('.ctp-name', { hasText: new RegExp(`^${esc}$`) }) })
    .first()
    .click();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  // 每个用例从干净的偏好开始：默认整屏覆盖 / 46%
  await page.evaluate(() => {
    localStorage.removeItem('forge.codeViewerLayout');
    localStorage.removeItem('forge.codeViewerSplitPct');
  });
  await page.reload();
});

test('E-CE-01 @P0 @mock-backend：<> 入口出现，左栏与项目树整栏互斥，切回后项目树原样恢复', async ({ page }) => {
  const health = attachHealthGuards(page);
  // 项目树在场
  await expect(page.locator('.ctp')).toHaveCount(0);
  await expect(page.locator('.tree-project').first()).toBeVisible();

  // 先把项目展开并记下会话数——退出代码态后必须原样还在（CE-S01）。
  // 初始可能是展开的（默认项目带会话），所以要先探测再决定要不要点箭头：
  // 无脑点一次反而会把展开的项目折叠掉，断言就会「测一个自己造出来的状态」。
  const proj = page.locator('.tree-project').first();
  await proj.hover();
  if ((await page.locator('.tree-session').count()) === 0) {
    await proj.locator('.tree-arrow').click();
  }
  const sessionsBefore = await page.locator('.tree-session').count();
  expect(sessionsBefore).toBeGreaterThan(0);

  // hover 才显形的入口（隐藏态也要能被 E2E 命中，Playwright 会自动 hover）
  await openCode(page);

  // 整栏互斥。断言用「不可见」而不是「不在 DOM」：项目树是 display:none 让位的，
  // 组件始终活着（v-if 卸载会把展开态、会话列表、滚动位置一并带走）。
  await expect(page.locator('.ctp')).toHaveCount(1);
  await expect(page.locator('.tree-project').first()).toBeHidden();
  // 顶部有返回入口
  await expect(page.locator('.ctp-back').last()).toBeVisible();

  // 返回 → 项目树回来了，且展开态 / 会话列表一点没丢
  await page.locator('.ctp-back').last().click();
  await expect(page.locator('.tree-project').first()).toBeVisible();
  await expect(page.locator('.ctp')).toHaveCount(0);
  await expect(page.locator('.tree-session')).toHaveCount(sessionsBefore);
  health.assertHealthy();
});

test('E-CE-02 @P0 @mock-backend：根目录单层加载 + 目录优先排序 + 懒加载展开', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openCode(page);

  // 根层：docs / packages / src 是目录，README.md / package.json 是文件；
  // 目录必须全部排在文件之前
  const rows = page.locator('.ctp-scroll > .ctp-row');
  const names: string[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    names.push((await rows.nth(i).locator('.ctp-name').innerText()).trim());
  }
  const firstFile = names.findIndex((n) => !n.includes('/') && names.indexOf(n) > 0);
  const lastDir = names.reduce((acc, n, i) => {
    const isDir = n === 'docs' || n === 'packages' || n === 'src';
    return isDir ? i : acc;
  }, -1);
  expect(lastDir).toBeGreaterThanOrEqual(0);
  // 目录索引都小于文件索引（用真实 DOM 的 class 判断更稳）
  const isDirs: boolean[] = [];
  for (let i = 0; i < (await rows.count()); i++) {
    isDirs.push((await rows.nth(i).getAttribute('class'))?.includes('is-dir') ?? false);
  }
  const lastDirIdx = isDirs.lastIndexOf(true);
  const firstFileIdx = isDirs.indexOf(false);
  if (firstFileIdx >= 0) expect(lastDirIdx).toBeLessThan(firstFileIdx);
  expect(firstFile).toBeGreaterThan(-1);

  // 懒加载：子项在展开前不存在
  await expect(page.locator('.ctp-row', { hasText: 'forge-ui' })).toHaveCount(0);
  await expandDir(page, 'packages');
  await expect(page.locator('.ctp-row', { hasText: 'forge-ui' })).toHaveCount(1);

  health.assertHealthy();
});

test('E-CE-03 @P0 @mock-backend：点击文件只读查看——行号、语法高亮、多标签、无编辑入口', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openCode(page);
  await page.locator('.ctp-row', { hasText: 'README.md' }).first().click();

  const viewer = page.locator('.cv');
  await expect(viewer).toBeVisible();
  // 行号列渲染
  await expect(viewer.locator('.cv-ln').first()).toBeVisible();
  // 代码行渲染
  await expect(viewer.locator('.cv-line').first()).toBeVisible();
  // 面包屑
  await expect(viewer.locator('.cv-crumbs')).toContainText('README.md');

  // 多标签：再开一个文件，两签并存，点签切回
  await page.locator('.ctp-row', { hasText: 'package.json' }).first().click();
  await expect(viewer.locator('.cv-tab')).toHaveCount(2);
  await viewer.locator('.cv-tab', { hasText: 'README.md' }).click();
  await expect(viewer.locator('.cv-crumbs')).toContainText('README.md');
  // 关一个签只剩一个
  await viewer.locator('.cv-tab', { hasText: 'package.json' }).locator('.cv-tab-x').click({ force: true });
  await expect(viewer.locator('.cv-tab')).toHaveCount(1);

  // 行序：面包屑行在 tab 条**之上**（2026-10 用户定稿）。量真实几何而不是断言
  // DOM 顺序：两行都是 flex 子项，谁在上是布局结果，写死顺序会漏掉
  // 「有人给 .cv 加了 column-reverse」这类改法。
  const [headBox, tabsBox] = await Promise.all([
    viewer.locator('.cv-head').boundingBox(),
    viewer.locator('.cv-tabs').boundingBox(),
  ]);
  expect(headBox!.y + headBox!.height).toBeLessThanOrEqual(tabsBox!.y + 1);

  // 只读：整块没有 textarea / input / contenteditable
  await expect(viewer.locator('textarea, input, [contenteditable="true"]')).toHaveCount(0);
  // 源码被转义注入而不是当作 HTML 执行
  const html = await viewer.locator('.cv-code').innerHTML();
  expect(html).not.toContain('<script');

  health.assertHealthy();
});

test('E-CE-04 @P1 @mock-backend：文件名过滤只匹配 basename，清空后回到树', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openCode(page);
  const input = page.locator('.ctp-filter-input');
  await input.fill('fileService');
  // 命中 2 个：fileService.ts 与 fileService.test.ts —— 都是**文件名**里含 fileService
  await expect(page.locator('.ctp-row')).toHaveCount(2, { timeout: 5000 });

  // 基名规则的真检查：拿一个**只出现在目录名里**的词去搜，必须 0 命中。
  // （forge-core 是目录名；若实现偷偷匹配了整条路径，这里会漏出几十条）
  await input.fill('forge-core');
  await expect(page.locator('.ctp-row')).toHaveCount(0, { timeout: 5000 });
  await expect(page.locator('.ctp-note').first()).toBeVisible();

  await input.fill('');
  await expect(page.locator('.ctp-row.is-dir').first()).toBeVisible();
  health.assertHealthy();
});

test('E-CE-05 @P0 @mock-backend：布局 A 整屏覆盖——对话区宽度零变化（硬指标）', async ({ page }) => {
  const health = attachHealthGuards(page);
  const before = await convWidth(page);
  await openCode(page);
  // 默认即整屏覆盖（2026-10 用户定稿），打开文件直接验证「宽度零变化」
  await page.locator('.ctp-row', { hasText: 'README.md' }).first().click();
  await expect(page.locator('.cv')).toBeVisible();
  const after = await convWidth(page);

  // 浮层压上去了，对话纸一点没窄
  expect(Math.abs(after - before)).toBeLessThan(0.5);
  // 且代码纸确实盖在对话纸上（同一父级、绝对定位覆盖）
  const mode = await page.locator('.cex').getAttribute('data-layout');
  expect(mode).toBe('cover');
  health.assertHealthy();
});

test('E-CE-06 @P0 @mock-backend：布局 B 分割——4px 沟、沟内无线、两侧贴合、320px 保底', async ({ page }) => {
  const health = attachHealthGuards(page);
  // 默认是整屏覆盖；本用例测分割布局，先点顶栏切换键切到 split
  await openCode(page);
  await page.locator('.ctp-icon').click();
  await page.locator('.ctp-row', { hasText: 'README.md' }).first().click();
  await expect(page.locator('.cv')).toBeVisible();
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');

  const gutter = page.locator('.csp');
  await expect(gutter).toBeVisible();
  const g = await gutter.boundingBox();
  // 沟宽 = CODE_SPLITTER_PX（4），既是缝也是命中区；无负 margin 补偿，实测即 4
  expect(g!.width).toBeCloseTo(4, 0);
  // 沟里不再有可见分隔线：代码态下终端是覆盖全宽的底部抽屉（z-30），而沟 z-60 恒在其上，
  // 画线就等于「分割线伸进终端」（用户 2026-10-03 报）。边界只由两纸的 4px 缝表达。
  await expect(page.locator('.csp-line')).toHaveCount(0);

  // 拖到最左：代码区变宽并顶到上限，对话区被钳在 320px 保底线（含 4px 沟）
  const host = await page.locator('.cex').boundingBox();
  await page.mouse.move(g!.x + 2, g!.y + g!.height / 2);
  await page.mouse.down();
  await page.mouse.move(g!.x - 5000, g!.y + g!.height / 2, { steps: 12 });
  await page.mouse.up();

  const split = await page.locator('.cex-split').boundingBox();
  expect(Math.abs(host!.width - split!.width - 320)).toBeLessThan(3);
  health.assertHealthy();
});

test('E-CE-07 @P1 @mock-backend：双击沟复位 46%，←/→ 每次 2 个百分点', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openCodeWithFile(page);
  // 默认是整屏覆盖，先切到 split 才有沟可拖
  await page.locator('.ctp-icon').click();
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');

  const gutter = page.locator('.csp');
  const g = (await gutter.boundingBox())!;
  // 先拖走（向左 = 代码纸变宽）
  await page.mouse.move(g.x + 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x - 300, g.y + g.height / 2, { steps: 8 });
  await page.mouse.up();
  const moved = (await page.locator('.cex-split').boundingBox())!.width;

  // 双击复位
  await gutter.dblclick();
  await page.waitForTimeout(120);
  const reset = (await page.locator('.cex-split').boundingBox())!.width;
  expect(reset).toBeLessThan(moved);
  const host = (await page.locator('.cex').boundingBox())!.width;
  expect(reset / host).toBeCloseTo(0.46, 1);

  // 键盘：← 一次 2%（方向与拖拽一致：左 = 代码纸变宽）
  await gutter.focus();
  const p0 = (await page.locator('.cex-split').boundingBox())!.width;
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(80);
  const p1 = (await page.locator('.cex-split').boundingBox())!.width;
  expect(Math.abs((p1 - p0) / host - 0.02)).toBeLessThan(0.005);
  health.assertHealthy();
});

test('E-CE-08 @P0 @mock-backend：窄窗临时降级为 cover，且不写坏 split 偏好；拉宽自动恢复', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCodeWithFile(page);
  // 默认是整屏覆盖；本用例测「偏好 split 的窄窗降级」，先显式切到 split（会落盘）
  await page.locator('.ctp-icon').click();
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');
  // 顶栏切换键的“当前是分割”态：品牌色选中 + aria-pressed（不只靠颜色传达，
  // 读屏/键盘用户拿到的是同一个信息）
  await expect(page.locator('.ctp-icon.is-split')).toHaveCount(1);
  await expect(page.locator('.ctp-icon')).toHaveAttribute('aria-pressed', 'true');

  // 缩到 800 < 820 → 临时 cover
  await page.setViewportSize({ width: 800, height: 900 });
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'cover');
  // 提示用户这是临时降级：代码树顶栏出警标，代码纸底部给整句
  await expect(page.locator('.ctp-warn')).toBeVisible();
  await expect(page.locator('.ctp-warn')).toHaveAttribute('title', /窗口过窄/);
  await expect(page.locator('.cex-note')).toBeVisible();
  // 偏好没被降级偷换：仍是上面显式选择的 split
  expect(await page.evaluate(() => localStorage.getItem('forge.codeViewerLayout'))).toBe('split');

  // 拉宽 → 自动恢复 split，提示消失
  await page.setViewportSize({ width: 1400, height: 900 });
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');
  await expect(page.locator('.cex-note')).toHaveCount(0);
  await expect(page.locator('.ctp-warn')).toHaveCount(0);

  // 点顶栏切回 cover：偏好真改了，图标选中态跟着灭
  // （“窗口窄被动降级”与“主动选了整屏”必须一眼可分，否则用户会以为按钮坏了）
  await page.locator('.ctp-icon').click();
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'cover');
  await expect(page.locator('.ctp-icon.is-split')).toHaveCount(0);
  await expect(page.locator('.ctp-icon')).toHaveAttribute('aria-pressed', 'false');
  health.assertHealthy();
});

test('E-CE-09 @P1 @mock-backend：Esc 逐级退出——先收代码纸，再退出代码态', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openCodeWithFile(page);
  await expect(page.locator('.cv-state')).toHaveCount(0); // 有内容，不在空态

  // 第一级 Esc：关掉最后一个标签 → 代码纸整体收回，但仍在代码态（对话回到全宽）
  await page.keyboard.press('Escape');
  await expect(page.locator('.cv')).toHaveCount(0);
  await expect(page.locator('.ctp')).toHaveCount(1);

  // 第二级 Esc：退出代码浏览器，回到项目树
  await page.keyboard.press('Escape');
  await expect(page.locator('.ctp')).toHaveCount(0);
  await expect(page.locator('.cex-split')).toHaveCount(0);
  await expect(page.locator('.cex-cover')).toHaveCount(0);
  await expect(page.locator('.tree-project').first()).toBeVisible();
  health.assertHealthy();
});

test('E-CE-10 @P1 @mock-backend：布局偏好与分割宽度刷新后仍在', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openCodeWithFile(page);
  // 默认是整屏覆盖，先显式切到 split 并落盘，再验证「布局 + 宽度」跨刷新恢复
  await page.locator('.ctp-icon').click();
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');

  // 拖宽代码纸（向左拖沟）→ 百分比落盘
  const g = (await page.locator('.csp').boundingBox())!;
  await page.mouse.move(g.x + 2, g.y + g.height / 2);
  await page.mouse.down();
  await page.mouse.move(g.x - 150, g.y + g.height / 2, { steps: 8 });
  await page.mouse.up();
  const w1 = (await page.locator('.cex-split').boundingBox())!.width;
  expect(await page.evaluate(() => localStorage.getItem('forge.codeViewerSplitPct'))).not.toBeNull();

  await page.reload();
  await waitForMock(page);
  await openCodeWithFile(page);
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');
  const w2 = (await page.locator('.cex-split').boundingBox())!.width;
  expect(Math.abs(w1 - w2)).toBeLessThan(2);
  health.assertHealthy();
});

test('E-CE-11 @P1 @mock-backend：设置页切代码查看器布局，回工作台立即生效且落盘', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 1500, height: 900 });
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-panel, .settings-body')).toBeVisible();
  await page.locator('.settings-tab', { hasText: '个性化' }).click();

  // 默认整屏覆盖（2026-10-02 用户定稿）：单选组选中「整屏覆盖」
  const cover = page.locator('.code-layout-option', { hasText: '整屏覆盖' });
  const split = page.locator('.code-layout-option', { hasText: '左右分割' });
  await expect(cover).toHaveAttribute('aria-checked', 'true');
  await expect(split).toHaveAttribute('aria-checked', 'false');

  // 分割比例的**手动设置项已删**（2026-10 用户定稿）：宽度只由沟拖拽 / 双击 / ←→ 决定。
  // 这条断言是给它的墓碑——谁想把它加回来，先看看用户已经说过不要。
  await expect(page.locator('.split-range')).toHaveCount(0);
  await expect(page.locator('.split-value')).toHaveCount(0);

  // 切到左右分割：单选态当场翻转
  await split.click();
  await expect(split).toHaveAttribute('aria-checked', 'true');
  await expect(cover).toHaveAttribute('aria-checked', 'false');

  // 落盘：刷新后仍是 split
  await page.reload();
  await expect(page.locator('.sidebar-link', { hasText: '设置' })).toBeVisible();
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '个性化' }).click();
  await expect(page.locator('.code-layout-option', { hasText: '左右分割' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await page.locator('.settings-back, .settings-close').first().click();

  // 回工作台：开文件即出代码纸，且真的并排（不是又盖上去）
  await openCodeWithFile(page);
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');
  // 没有手动比例了 → 走默认值 46%（拖沟改宽度由 E-CE-07 覆盖）
  const host = (await page.locator('.cex').boundingBox())!.width;
  const w = (await page.locator('.cex-split').boundingBox())!.width;
  expect(Math.abs(w / host - 0.46)).toBeLessThan(0.03);

  // 反向再切回 cover：代码纸盖上去，沟消失
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '个性化' }).click();
  await page.locator('.code-layout-option', { hasText: '整屏覆盖' }).click();
  await page.locator('.settings-back, .settings-close').first().click();
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'cover');
  await expect(page.locator('.csp')).toHaveCount(0);
  health.assertHealthy();
});

test('E-CE-12 @P1 @mock-backend：降级态——超大文件提示截断、二进制不白屏', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openCode(page);
  await expandDir(page, 'src');
  await expandDir(page, '__demo__');

  // 超大文件：分页渲染 + 明确提示
  await page.locator('.ctp-row', { hasText: 'huge.log' }).click();
  await expect(page.locator('.cv')).toBeVisible();
  // 不一次性铺 60000 行 DOM
  const rendered = await page.locator('.cv-line').count();
  expect(rendered).toBeLessThanOrEqual(2000);
  await expect(page.locator('.cv')).toContainText(/行|line/i);

  // 二进制：明确状态而不是空白
  await page.locator('.ctp-row', { hasText: 'binary.png' }).click();
  await expect(page.locator('.cv')).toBeVisible();
  await expect(page.locator('.cv')).toContainText(/二进制|binary/i);
  health.assertHealthy();
});

/** 「最近打开」分组里按文件名精确定位的行 */
function recentName(page: Page, name: string) {
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .locator('.ctp-row.is-recent')
    .filter({ has: page.locator('.ctp-name', { hasText: new RegExp(`^${esc}$`) }) });
}

test('E-CE-13 @P1 @mock-backend：tab 中键关闭、溢出横滚 + 激活签滚进视野', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCode(page);
  // 默认整屏覆盖纸太宽，7 个签放得下就不溢出；显式切到 split 恢复本用例的窄纸前提。
  // 未开文件时 .cex 的 data-layout 恒为 cover（代码纸还没出来），按钮 pressed 态直接反映偏好
  await page.locator('.ctp-icon').click();
  await expect(page.locator('.ctp-icon')).toHaveAttribute('aria-pressed', 'true');
  await expandAll(page);

  // 逐个打开 7 个文件：tab 顺序由此确定
  const names = [
    // 有变更的文件放前面（新默认「有修改就展示 diff」，2026-10-03）：
    // 需要文件正文断言（.cv-lc 字体 / 选中复制等）的用例，激活签必须以
    // 未变更文件收尾——最后打开的文件决定右侧的视图形态
    'App.vue',
    'bridge.ts',
    'fileService.ts',
    '12_code_explorer.md',
    'README.md',
    'package.json',
    'fileService.test.ts',
  ];
  for (const n of names) await openTreeFile(page, n);
  await expect(page.locator('.cv')).toBeVisible();
  await expect(page.locator('.cv-tab')).toHaveCount(names.length);

  // 「最近打开」分组暂时隐藏（CodeTreePanel 的 SHOW_RECENT_GROUP = false），
  // 上限 5 个的分组断言随 E-CE-18/19 一起挂起，恢复分组时一并恢复。

  // 溢出：签数超过纸宽时 tab 条要能横向滚
  const strip = page.locator('.cv-tabs');
  const box = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(box.sw).toBeGreaterThan(box.cw);
  await strip.evaluate((el) => { el.scrollLeft = 0; });

  // 从树切到最右边的签（不经 tab 条，避免 Playwright 自己先滚过去）时，
  // 激活签必须自动滚进视野——否则签在纸外，眼睛要自己找
  await openTreeFile(page, 'fileService.ts');
  await expect(page.locator('.cv-tab.active .cv-tab-name')).toHaveText('fileService.ts');
  const inView = await page.locator('.cv-tab.active').evaluate((el) => {
    const stripEl = el.parentElement!;
    const a = el.getBoundingClientRect();
    const b = stripEl.getBoundingClientRect();
    return a.left >= b.left - 1 && a.right <= b.right + 1;
  });
  expect(inView).toBe(true);
  // 滚动条被藏着，得有别的提示，否则没人知道右边还有签
  await expect(page.locator('.cv-tabs-fade')).toHaveCount(1);

  // 中键关闭：数量 -1，且**不**顺手把被点的签切成激活签
  const activeBefore = (await page.locator('.cv-tab.active .cv-tab-name').textContent())!.trim();
  const victim = (await page.locator('.cv-tab').nth(1).locator('.cv-tab-name').textContent())!.trim();
  await page.locator('.cv-tab').nth(1).click({ button: 'middle' });
  await expect(page.locator('.cv-tab')).toHaveCount(names.length - 1);
  await expect(page.locator('.cv-tab.active .cv-tab-name')).toHaveText(activeBefore);
  await expect(page.locator('.cv-tab', { hasText: victim })).toHaveCount(0);
  // 中键不该当切签用：再关一个**非激活**的签，激活项仍然不变。
  // 第二个目标不能写死下标 3：签条顺序是「最后打开的在最左」，激活签（fileService.ts，
  // 从树里点开）正好落在 nth(3)，关它就会落相邻签、激活项必变——用列表另一端的
  // nth(-2)（App.vue）保证与激活签无关。
  await page.locator('.cv-tab').nth(-2).click({ button: 'middle' });
  await expect(page.locator('.cv-tab')).toHaveCount(names.length - 2);
  await expect(page.locator('.cv-tab.active .cv-tab-name')).toHaveText(activeBefore);
});

test('E-CE-15 @P1 @mock-backend：tab 条悬停时竖向滚轮可横滚；代码正文真的是 JetBrains Mono；选中底色无绿', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCode(page);
  // 默认整屏覆盖纸太宽，签条不溢出就滚不动；显式切到 split 恢复溢出前提。
  // 未开文件时 .cex 的 data-layout 恒为 cover（代码纸还没出来），按钮 pressed 态直接反映偏好
  await page.locator('.ctp-icon').click();
  await expect(page.locator('.ctp-icon')).toHaveAttribute('aria-pressed', 'true');
  await expandAll(page);
  const names = [
    // 有变更的文件放前面（新默认「有修改就展示 diff」，2026-10-03）：
    // 需要文件正文断言（.cv-lc 字体 / 选中复制等）的用例，激活签必须以
    // 未变更文件收尾——最后打开的文件决定右侧的视图形态
    'App.vue',
    'bridge.ts',
    'fileService.ts',
    '12_code_explorer.md',
    'README.md',
    'package.json',
    'fileService.test.ts',
  ];
  for (const n of names) await openTreeFile(page, n);
  await expect(page.locator('.cv-tab')).toHaveCount(names.length);

  // 竖向滚轮要能滚 tab 条。Chromium 不会把 deltaY 自动折给「只有横向溢出」的容器，
  // 不自己接 wheel 的话鼠标停在签上滚就是没反应（实测 scrollLeft 恒为 0）。
  const strip = page.locator('.cv-tabs');
  await strip.evaluate((el) => { el.scrollLeft = 0; });
  const tabBox = (await page.locator('.cv-tab').first().boundingBox())!;
  await page.mouse.move(tabBox.x + tabBox.width / 2, tabBox.y + tabBox.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(() => strip.evaluate((el) => el.scrollLeft)).toBeGreaterThan(0);

  // 代码正文与行号列：UA 给 <code> 写了 font-family:monospace，而 <code> 是 .cv-pre
  // 的子元素（不继承），于是整块代码其实掉到浏览器通用等宽（Consolas）上。
  // 与原型（没有 <code>，直接 .code 用 var(--font-mono)）对不上。
  const codeFont = await page.locator('.cv-lc').first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(codeFont).toContain('JetBrains Mono');
  const lnFont = await page.locator('.cv-ln').first().evaluate((el) => getComputedStyle(el).fontFamily);
  expect(lnFont).toContain('JetBrains Mono');

  // 选中行底色不能是品牌绿：项目树用 --surface-active（近乎中性），
  // 代码树曾经硬调 color-mix(--brand-accent 16%)，于是两个列表选中态颜色不同。
  // （「最近打开」分组隐藏期间，改用树里激活的普通文件行验证同一套选中态样式。）
  const bg = await page.locator('.ctp-scroll .ctp-row.is-active').evaluate((el) => {
    const m = getComputedStyle(el).backgroundColor.match(/[\d.]+/g)!;
    return { r: +m[0], g: +m[1], b: +m[2] };
  });
  // 中性色 = 三通道近似相等；青绿底会 g >> b
  expect(Math.abs(bg.g - bg.b)).toBeLessThan(12);

  // 分组标签与返回按钮同族同号（之前标签是 mono 10.5，按钮是 sans 12）
  const label = await page.locator('.ctp-group').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fam: cs.fontFamily.split(',')[0], size: cs.fontSize };
  });
  const back = await page.locator('.ctp-back').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { fam: cs.fontFamily.split(',')[0], size: cs.fontSize };
  });
  expect(label).toEqual(back);
});

test('E-CE-16 @P1 @mock-backend：目录行是文件夹图标而不是字母色块', async ({ page }) => {
  await openCode(page);
  await expect(page.locator('.ctp-dir-icon').first()).toBeVisible();
  // 目录不再用 DIR_BADGE 方块（8.5px 的 D 在 16px 方块里是一团糊，还和品牌绿撞色）
  await expect(page.locator('.ctp-row.is-dir .ctp-badge')).toHaveCount(0);
  // 槽宽不变 → 目录行与文件行的文件名左缘仍然对齐
  const align = await page.evaluate(() => {
    const dir = document.querySelector<HTMLElement>('.ctp-row.is-dir .ctp-name')!;
    const file = document.querySelector<HTMLElement>('.ctp-row:not(.is-dir) .ctp-name')!;
    const d = dir.getBoundingClientRect().left;
    const f = file.getBoundingClientRect().left;
    return { d: Math.round(d), f: Math.round(f) };
  });
  expect(align.d).toBe(align.f);
});

test('E-CE-14 @P1 @mock-backend：布局图标不被挤压、返回按钮无边框、行号列成栏', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCodeWithFile(page);

  // 24px 圆按钮 + 15px 图标。global.css 的 `button { padding: 6px 14px }` 曾漏进这里，
  // 24px 宽被 28px 横向 padding 挤成内容盒 0，图标溢出裁切——肉眼即「变形」。
  const icon = await page.locator('.ctp-icon').evaluate((el) => {
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const s = el.querySelector('svg')!.getBoundingClientRect();
    return { w: +r.width.toFixed(1), h: +r.height.toFixed(1), pad: cs.padding, sw: +s.width.toFixed(1) };
  });
  expect(icon).toMatchObject({ w: 24, h: 24, pad: '0px', sw: 15 });

  // 返回按钮：只留 hover 浅底，不再是带框药丸（这一行挤的是「框」不是控件）
  const back = await page.locator('.ctp-back').evaluate((el) => {
    const cs = getComputedStyle(el);
    return { bw: cs.borderTopWidth, bg: cs.backgroundColor };
  });
  expect(back.bw).toBe('0px');
  expect(back.bg).toBe('rgba(0, 0, 0, 0)');

  // 行号列：竖线 + 左侧留白 + 代码左侧留白，数字与代码不能贴在一起
  const ln = await page.locator('.cv-ln').first().evaluate((el) => {
    const cs = getComputedStyle(el);
    return { pl: cs.paddingLeft, br: parseFloat(cs.borderRightWidth), w: el.getBoundingClientRect().width };
  });
  expect(ln.br).toBeGreaterThanOrEqual(1);
  expect(ln.pl).not.toBe('0px');
  expect(ln.w).toBeGreaterThanOrEqual(52);
  const lcPad = await page.locator('.cv-lc').first().evaluate((el) => getComputedStyle(el).paddingLeft);
  expect(parseFloat(lcPad)).toBeGreaterThanOrEqual(12);
});

test('E-CE-17 @P1 @mock-backend：JetBrains Mono 随应用分发，离线可用，可变字重轴生效', async ({ page }) => {
  const cdn: string[] = [];
  page.on('request', (r) => {
    if (/fonts\.(gstatic|googleapis)\.com/.test(r.url())) cdn.push(r.url());
  });

  await openCodeWithFile(page);
  await expect(page.locator('.cv-lc').first()).toBeVisible();
  // font-display: swap 是异步换字体，等 document.fonts 真正就绪
  await page.evaluate(() => document.fonts.ready);

  // 1) 页面注册并加载了 JetBrains Mono 的 CSS font face。
  //    应用不打包字体时这一项恒为 false —— 它才是「字体真的打进产物」的证据
  //    （本机也装了 JetBrains Mono，靠族名分辨不出来，只有 FontFace 能分辨）。
  const faces = await page.evaluate(() =>
    [...document.fonts]
      .filter((f) => f.family === 'JetBrains Mono')
      .map((f) => ({ weight: f.weight, status: f.status })),
  );
  expect(faces.length).toBeGreaterThan(0);
  expect(faces.some((f) => f.status === 'loaded')).toBe(true);

  // 2) 字体来自本地产物。刻意用与 token 无关的族名直接引产物里的 woff2：
  //    能解析到它就只可能是打包的文件（族名不同，系统装的那份匹配不上）。
  const probe = await page.evaluate(async () => {
    const url = performance
      .getEntriesByType('resource')
      .map((e) => e.name)
      .find((n) => /jetbrains-mono-latin[^/]*\.woff2$/.test(n));
    if (!url) return { err: '产物里没找到 latin 切片' };
    const face = new FontFace('JB Bundled Probe', `url(${url}) format('woff2')`, { weight: '100 900' });
    await face.load();
    document.fonts.add(face);
    const w = (f: string) => {
      const c = document.createElement('canvas').getContext('2d')!;
      c.font = f;
      return +c.measureText('mmmwwwiiiiil{[]}0O').width.toFixed(2);
    };
    return { bundled: w('14px "JB Bundled Probe"'), generic: w('14px monospace') };
  });
  expect(probe.err).toBeUndefined();
  expect(probe.bundled).toBeCloseTo(151.2, 1); // JetBrains Mono 特征字宽
  expect(probe.bundled).not.toBeCloseTo(probe.generic, 1); // 通用等宽是 138.55

  // 3) 可变字重轴生效：同一份可变字体在 400/600/700 下墨色总量必须递增。
  //    若把切片当静态字体声明，600/700 会静默渲成 400（面包屑/签名/项目名都用
  //    500/600，肉眼就是「都不粗」）。等宽字体字宽恒定，所以只能比墨量；
  //    用「墨色总量」而不是「深色像素数」——后者在 28px 下只有 145→156(+7.6%)，
  //    阈值很难定，前者稳定在 +18%~32%（实测 M: 1.20 / l: 1.32 / W: 1.18）。
  const ink = await page.evaluate(() => {
    const darkness = (weight: number) => {
      const c = document.createElement('canvas');
      c.width = 80;
      c.height = 60;
      const x = c.getContext('2d')!;
      x.fillStyle = '#fff';
      x.fillRect(0, 0, 80, 60);
      x.fillStyle = '#000';
      x.font = `${weight} 40px "JetBrains Mono"`;
      x.textBaseline = 'top';
      x.fillText('M', 6, 6);
      const d = x.getImageData(0, 0, 80, 60).data;
      let sum = 0;
      for (let i = 0; i < d.length; i += 4) sum += 255 - d[i];
      return sum;
    };
    return { w400: darkness(400), w600: darkness(600), w700: darkness(700) };
  });
  expect(ink.w600 / ink.w400).toBeGreaterThan(1.1);
  expect(ink.w700).toBeGreaterThan(ink.w600);

  // 4) 零 CDN 依赖：加载全程不该碰 Google Fonts
  expect(cdn).toEqual([]);
});

// 「最近打开」分组暂时隐藏（CodeTreePanel 的 SHOW_RECENT_GROUP = false），
// 下面两条历史解耦用例依赖该分组的 DOM，恢复分组时把 fixme 去掉即可。
test.fixme('E-CE-18 @P0 @mock-backend：历史与标签页解耦——关掉签仍在最近打开里，点它能重开', async ({ page }) => {
  await openCode(page);
  await expandAll(page);
  await openTreeFile(page, 'README.md');
  await openTreeFile(page, 'package.json');
  await openTreeFile(page, 'bridge.ts');
  await expect(page.locator('.cv-tab')).toHaveCount(3);
  await expect(page.locator('.ctp-row.is-recent')).toHaveCount(3);

  // 关掉中间那个签：package.json
  // 注意关的是**它自己的** ×（`.cv-tab` 的激活类名是 `active`，不是 `is-active`），
  // 点 `.is-active .cv-tab-x` 会去关当前激活签，测的就不是这个文件了
  const tab = page.locator('.cv-tab', { hasText: 'package.json' }).first();
  await tab.hover();
  await tab.locator('.cv-tab-x').click();

  // 签没了，但历史里必须还在——这正是「最近打开」不再是标签页影子的意义
  await expect(page.locator('.cv-tab')).toHaveCount(2);
  await expect(page.locator('.cv-tab', { hasText: 'package.json' })).toHaveCount(0);
  await expect(recentName(page, 'package.json')).toHaveCount(1);

  // 从历史点回去 → 重新打开成签（不依赖它在树里是否展开可见）
  await recentName(page, 'package.json').click();
  await expect(page.locator('.cv-tab', { hasText: 'package.json' })).toHaveCount(1);
  await expect(page.locator('.cv-tab.active')).toContainText('package.json');

  // 顺序按“打开时间”而不是“首次打开时间”：重新点 package.json 应升到最前
  await recentName(page, 'package.json').click();
  await expect(page.locator('.ctp-row.is-recent').first().locator('.ctp-name')).toHaveText('package.json');
});

test.fixme('E-CE-19 @P1 @mock-backend：历史顺序只跟“打开”动作走，切换签不重排', async ({ page }) => {
  await openCode(page);
  await expandAll(page);
  await openTreeFile(page, 'README.md');
  await openTreeFile(page, 'package.json');
  await openTreeFile(page, 'bridge.ts');
  await expect(page.locator('.ctp-row.is-recent').first().locator('.ctp-name')).toHaveText('bridge.ts');

  // 点已打开的 tab = 切换，不是重新打开。历史不重排（与 VSCode Open Recent 同语义：
  // “打开时间”指 openFile 的发生时刻，否则只是看一眼就把历史搅乱了）。
  await page.locator('.cv-tab', { hasText: 'README.md' }).first().click();
  await expect(page.locator('.cv-tab.active')).toContainText('README.md');
  await expect(page.locator('.ctp-row.is-recent').first().locator('.ctp-name')).toHaveText('bridge.ts');
  await expect(page.locator('.cv-tab')).toHaveCount(3);

  // 但从左栏历史点它 = 重新打开（走 openFile），即使签还开着也要把时间刷到最前
  await recentName(page, 'README.md').click();
  await expect(page.locator('.ctp-row.is-recent').first().locator('.ctp-name')).toHaveText('README.md');
  await expect(page.locator('.cv-tab')).toHaveCount(3);
});

test('E-CE-20 @P0 @mock-backend：代码树行右键菜单——目录开自己、文件开父目录、HTML 多一项、编辑器分项、复制路径', async ({ page }) => {
  // 复制路径要走剪贴板断言（与 E-CE-24 同款授权）
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  // 记录真正提交给 shell 的绝对路径（必须在 goto 之后挂，reload 会清掉注入）
  await page.evaluate(() => {
    const w = window as unknown as {
      __ceOpenPath: string[];
      __ceOpenBrowser: string[];
      __ceOpenEditor: string[];
      __ceOpenEditorId: string[];
    };
    w.__ceOpenPath = [];
    w.__ceOpenBrowser = [];
    w.__ceOpenEditor = [];
    w.__ceOpenEditorId = [];
    const shell = window.forge.shell;
    const p0 = shell.openPath.bind(shell);
    shell.openPath = (p: string) => {
      w.__ceOpenPath.push(p);
      return p0(p);
    };
    const b0 = shell.openInBrowser.bind(shell);
    shell.openInBrowser = (p: string) => {
      w.__ceOpenBrowser.push(p);
      return b0(p);
    };
    const e0 = shell.openInEditor.bind(shell);
    shell.openInEditor = (p: string, editorId: string) => {
      w.__ceOpenEditor.push(p);
      w.__ceOpenEditorId.push(editorId);
      return e0(p, editorId);
    };
  });
  await openCode(page);
  await expandAll(page);

  const menu = page.locator('.ctx-menu');
  /** 最后一次调用（数组是累加的，逐步断言时只看新增的那一条） */
  const lastCall = (
    k: '__ceOpenPath' | '__ceOpenBrowser' | '__ceOpenEditor' | '__ceOpenEditorId',
  ) =>
    page.evaluate((key) => {
      const arr = (window as unknown as Record<string, string[]>)[key];
      return arr[arr.length - 1] ?? null;
    }, k);

  // 目录行：复制路径 + 打开此目录，且开的是**它自己**（不是父目录）
  // 精确匹配**行名**而不是整行文本：① mock 树里 src/file、test/file、forge-core/src
  // 等重名，子串匹配会命中另一个（之前就因此选中了项目根的 src）；
  // ② 目录行尾的 Git 角标也是行文本的一部分（docs 有未跟踪文件 → 文本是 `docs?`），
  // 对整行做 /^docs$/ 会随角标上线而失配。文件行下面已经用的是 .ctp-name 口径。
  const dirRow = page
    .locator('.ctp-scroll .ctp-row.is-dir')
    .filter({ has: page.locator('.ctp-name', { hasText: /^docs$/ }) })
    .first();
  await dirRow.click({ button: 'right' });
  await expect(menu.locator('.ctx-menu-item')).toHaveText(['复制路径', '打开此目录']);
  await menu.locator('.ctx-menu-item', { hasText: '复制路径' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/forge\/docs$/);

  await dirRow.click({ button: 'right' });
  await menu.locator('.ctx-menu-item', { hasText: '打开此目录' }).click();
  expect(await lastCall('__ceOpenPath')).toMatch(/forge\/docs$/);

  // 普通文件行：编辑器分项（mock 扫描结果 = VS Code + Cursor）+ 复制路径 + 打开所在目录，没有浏览器项
  const fileRow = page.locator('.ctp-scroll .ctp-row:not(.is-dir):not(.is-recent)').filter({
    has: page.locator('.ctp-name', { hasText: /^fileService\.ts$/ }),
  }).first();
  await fileRow.click({ button: 'right' });
  await expect(menu.locator('.ctx-menu-item')).toHaveText([
    '用 VS Code 打开',
    '用 Cursor 打开',
    '复制路径',
    '打开所在目录',
  ]);
  await menu.locator('.ctx-menu-item', { hasText: '复制路径' }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(
    /forge\/packages\/forge-core\/src\/file\/fileService\.ts$/,
  );
  await fileRow.click({ button: 'right' });
  await menu.locator('.ctx-menu-item', { hasText: '打开所在目录' }).click();
  expect(await lastCall('__ceOpenPath')).toMatch(/forge\/packages\/forge-core\/src\/file$/);

  // 外部编辑器：拿到的是**文件本体**的绝对路径 + 对应的编辑器 id
  await fileRow.click({ button: 'right' });
  await menu.locator('.ctx-menu-item', { hasText: '用 Cursor 打开' }).click();
  expect(await lastCall('__ceOpenEditor')).toMatch(
    /forge\/packages\/forge-core\/src\/file\/fileService\.ts$/,
  );
  expect(await lastCall('__ceOpenEditorId')).toBe('cursor');

  // 菜单关掉后不留残影
  await expect(menu).toHaveCount(0);
});

/** 签条当前顺序（按可见顺序取文件名） */
function tabNames(page: Page): Promise<string[]> {
  return page.locator('.cv-tab .cv-tab-name').allTextContents();
}

test('E-CE-26 @P1 @mock-backend：代码区右上角按钮唤醒终端（原关闭当前文件位，功能与签条 × 重复）', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await openCode(page);
  await page.locator('.ctp-row', { hasText: 'README.md' }).first().click();
  await expect(page.locator('.cv')).toBeVisible();

  // 显式切到 **cover** 布局再验证：split 下纸是普通流内元素盖不住终端，
  // cover 下纸是 absolute inset:0 z-20 整张盖——遮挡 bug 只在这条路径上复现
  const layoutBtn = page.locator('.ctp-icon');
  if ((await layoutBtn.getAttribute('aria-pressed')) === 'false') {
    await layoutBtn.click(); // 当前是 cover → 切到 split
    await layoutBtn.click(); // 再切回 cover
  } else {
    await layoutBtn.click(); // 当前是 split → 切到 cover
  }
  await expect(layoutBtn).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.cv')).toBeVisible();

  // 默认终端收起（面板常驻 DOM，.open 才展开）；点右上角终端按钮 → 展开；再点 → 收起
  const termBtn = page.locator('.cv-term');
  await expect(page.locator('.term.open')).toHaveCount(0);
  await termBtn.click();
  await expect(page.locator('.term.open')).toBeVisible();
  // 关键回归：cover 布局的代码纸是 absolute z-20 整张盖上去的，终端必须浮在纸**上面**
  // （用 elementFromPoint 验证：终端中心点命中的必须是终端自身/其后代，而不是代码纸）
  const covered = await page.evaluate(() => {
    const term = document.querySelector('.term.open');
    if (!term) return true;
    const r = term.getBoundingClientRect();
    const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    return !(hit instanceof Node && term.contains(hit));
  });
  expect(covered).toBe(false);
  await termBtn.click();
  await expect(page.locator('.term.open')).toHaveCount(0);
});

test('E-CE-27 @P1 @mock-backend：终端展开时，两处终端开关的激活底色一致（用户 2026-10-03 报）', async ({ page }) => {
  await page.setViewportSize({ width: 1500, height: 900 });
  await openCodeWithFile(page);
  // 必须切到 split：cover 下代码纸整张盖住对话区，顶栏开关点不到（真实用户也点不到）
  const layoutBtn = page.locator('.ctp-icon');
  if ((await layoutBtn.getAttribute('aria-pressed')) === 'false') await layoutBtn.click();
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');

  // 同一 terminalOpen 偏好驱动两个按钮：对话区顶栏 .term-toggle 与代码纸右上 .cv-term。
  // 展开后两者的计算底色/字色必须逐值相同，否则同一状态两张脸。
  const readState = () =>
    page.evaluate(() => {
      const pick = (sel: string) => {
        const el = document.querySelector(sel);
        if (!el) return null;
        const cs = getComputedStyle(el);
        return { bg: cs.backgroundColor, fg: cs.color, pressed: el.getAttribute('aria-pressed') };
      };
      const tb = document.querySelector('.app-toolbar .term-toggle');
      return {
        // 顶栏开关没有 aria-pressed，激活态走 .is-active class（App.vue 既有约定）
        toolbar: pick('.app-toolbar .term-toggle'),
        toolbarActive: tb?.classList.contains('is-active') ?? false,
        viewer: pick('.cv-term'),
        open: document.querySelectorAll('.term.open').length,
      };
    });

  const before = await readState();
  expect(before.open).toBe(0);
  expect(before.viewer?.pressed).toBe('false');
  expect(before.toolbarActive).toBe(false);

  await page.locator('.app-toolbar .term-toggle').click();
  await expect(page.locator('.term.open')).toBeVisible();

  const after = await readState();
  expect(after.open).toBe(1);
  // 两个按钮都进入激活态
  expect(after.toolbarActive).toBe(true);
  expect(after.viewer?.pressed).toBe('true');
  // 底色/字色一致。**必须轮询到相等**：两边都有 120ms 的 background/color transition，
  // 点击后立刻读会读到过渡中间值（oklab 插值带 alpha，肉眼是「差一档灰」）。
  await expect
    .poll(
      async () => {
        const s = await readState();
        return s.viewer?.bg === s.toolbar?.bg && s.viewer?.fg === s.toolbar?.fg;
      },
      { timeout: 3000 },
    )
    .toBe(true);
  const active = await readState();
  // 激活底色不能是透明——相等但都透明等于没上激活态
  expect(active.viewer?.bg).not.toBe('rgba(0, 0, 0, 0)');

  // 收起后代码纸那个按钮回落到透明底（顶栏按钮静息底是 --card，本来就不透明，
  // 两种静息态不必一致——用户要的是「展开时两张脸一致」）
  await page.locator('.app-toolbar .term-toggle').click();
  await expect(page.locator('.term.open')).toHaveCount(0);
  await expect
    .poll(async () => (await readState()).viewer?.bg, { timeout: 3000 })
    .toBe('rgba(0, 0, 0, 0)');
});

test('E-CE-21 @P1 @mock-backend：tab 可拖拽排序，拖动不切激活签，拖后不误触发点击', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCode(page);
  await expandAll(page);
  for (const n of ['README.md', 'package.json', 'App.vue']) await openTreeFile(page, n);
  // 打开顺序即签序（新的在前）
  expect(await tabNames(page)).toEqual(['App.vue', 'package.json', 'README.md']);
  const active = await page.locator('.cv-tab.active .cv-tab-name').textContent();
  expect(active).toBe('App.vue');

  // 把第 3 个签（README.md）拖到最左：按住 → 越过阈值 → 一路拖过第 1、2 个
  const last = page.locator('.cv-tab').nth(2);
  const first = page.locator('.cv-tab').nth(0);
  const a = (await last.boundingBox())!;
  const b = (await first.boundingBox())!;
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  // 分步移动：超过 4px 阈值才会进入拖拽；一步跳到位也能过，但分步更像真实手势
  await page.mouse.move(a.x + a.width / 2 - 10, a.y + a.height / 2, { steps: 2 });
  await page.mouse.move(b.x + 6, b.y + b.height / 2, { steps: 12 });
  await page.mouse.up();

  expect(await tabNames(page)).toEqual(['README.md', 'App.vue', 'package.json']);
  // 拖动**不附带**切激活：激活的仍是 App.vue
  expect(await page.locator('.cv-tab.active .cv-tab-name').textContent()).toBe('App.vue');

  // 顺序变化后仍能正常关闭（拖拽没有破坏中键/× 关闭）
  await page.locator('.cv-tab', { hasText: 'App.vue' }).first().hover();
  await page.locator('.cv-tab', { hasText: 'App.vue' }).first().locator('.cv-tab-x').click();
  expect(await tabNames(page)).toEqual(['README.md', 'package.json']);
});

test('E-CE-22 @P1 @mock-backend：拖到签条边缘会自动横向滚动（否则后面的签拖不到）', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCode(page);
  // 默认整屏覆盖纸太宽，签条不溢出就没有「拖到边缘自动滚」；显式切到 split 恢复前提。
  // 未开文件时 .cex 的 data-layout 恒为 cover（代码纸还没出来），按钮 pressed 态直接反映偏好
  await page.locator('.ctp-icon').click();
  await expect(page.locator('.ctp-icon')).toHaveAttribute('aria-pressed', 'true');
  await expandAll(page);
  const names = [
    // 有变更的文件放前面（新默认「有修改就展示 diff」，2026-10-03）：
    // 需要文件正文断言（.cv-lc 字体 / 选中复制等）的用例，激活签必须以
    // 未变更文件收尾——最后打开的文件决定右侧的视图形态
    'App.vue',
    'bridge.ts',
    'fileService.ts',
    '12_code_explorer.md',
    'README.md',
    'package.json',
    'fileService.test.ts',
  ];
  for (const n of names) await openTreeFile(page, n);
  const strip = page.locator('.cv-tabs');
  await strip.evaluate((el) => { el.scrollLeft = 0; });
  const before = await strip.evaluate((el) => el.scrollLeft);
  expect(before).toBe(0);

  // 抓住第 1 个签，按到签条**右边缘**（落在自动滚动区内）
  const tab = page.locator('.cv-tab').first();
  const t = (await tab.boundingBox())!;
  const s = (await strip.boundingBox())!;
  await page.mouse.move(t.x + t.width / 2, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 20, t.y + t.height / 2, { steps: 2 });
  // 多给几帧：自动滚动是按每次 pointermove 推进的，单帧只能滚 18px
  for (let i = 0; i < 6; i += 1) {
    await page.mouse.move(s.x + s.width - 10, t.y + t.height / 2);
  }
  const during = await strip.evaluate((el) => el.scrollLeft);
  await page.mouse.up();
  expect(during).toBeGreaterThan(before);
});

test('E-CE-23 @P1 @mock-backend：签右键菜单可左移/右移/关闭，到边界置 disabled', async ({ page }) => {
  await openCode(page);
  await expandAll(page);
  for (const n of ['README.md', 'package.json', 'App.vue']) await openTreeFile(page, n);
  expect(await tabNames(page)).toEqual(['App.vue', 'package.json', 'README.md']);

  // 签右键菜单：到边界的项 disabled 而不是消失
  await page.locator('.cv-tab', { hasText: 'App.vue' }).first().click({ button: 'right' });
  const menu = page.locator('.ctx-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.ctx-menu-item')).toHaveText(['标签页左移', '标签页右移', '关闭标签页']);
  await expect(menu.locator('.ctx-menu-item').first()).toBeDisabled();

  await menu.locator('.ctx-menu-item', { hasText: '标签页右移' }).click();
  expect(await tabNames(page)).toEqual(['package.json', 'App.vue', 'README.md']);

  // 菜单里的关闭
  await page.locator('.cv-tab', { hasText: 'App.vue' }).first().click({ button: 'right' });
  await page.locator('.ctx-menu-item', { hasText: '关闭标签页' }).click();
  expect(await tabNames(page)).toEqual(['package.json', 'README.md']);
});

test('E-CE-24 @P0 @mock-backend：代码可选中复制，浮窗与对话区同款；行号不混入剪贴板', async ({ page }) => {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openCodeWithFile(page);
  await expect(page.locator('.cv-lc').first()).toBeVisible();

  // 跨 3 行拖选（真 mouse 事件：selection 与 mouseup 都是真的）
  const a = (await page.locator('.cv-line').nth(0).locator('.cv-lc').boundingBox())!;
  const b = (await page.locator('.cv-line').nth(2).locator('.cv-lc').boundingBox())!;
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();

  const pop = page.locator('.selection-pop');
  const btn = page.locator('.selection-pop-btn');
  await expect(pop).toHaveClass(/is-visible/);
  await expect(btn).toHaveText('复制文本');

  const selected = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(selected.length).toBeGreaterThan(0);
  // 跨行选区必须带换行，且**不能**以行号数字开头——
  // .cv-ln 是 user-select:none，浏览器会把不可选内容从选区里剔掉。
  // 这两条断言就是钉住「别哪天为了「能选行号」把 user-select 去掉」的那个回归。
  expect(selected).toContain('\n');
  expect(selected.split('\n')[0]?.trim()).toBe('# forge');
  // 选区内不应出现「光秃秃的一串数字」独占一行（那就是漏进来的行号）
  expect(selected).not.toMatch(/^\s*\d+\s*$/m);

  await btn.click();
  await expect(btn).toHaveText('已复制');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  // Windows 剪贴板是 CRLF 文本格式，writeText 会把 \n 转成 \r\n（对话区复制同款，
  // VSCode 粘贴时会按文件 EOL 归一）。所以比对前先归一行尾，别去「修」它。
  expect(clip.replace(/\r\n/g, '\n')).toBe(selected);

  // 反馈 1.4s 后收起并清空选区（与对话区同一套契约）
  await expect(pop).not.toHaveClass(/is-visible/, { timeout: 4000 });
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
});

test('E-CE-25 @P1 @mock-backend：签条等外壳不弹复制浮窗（选区区域是清单，不是全页面）', async ({ page }) => {
  await openCode(page);
  await expandAll(page);
  // 签条只在 ≥2 个文件时渲染
  await openTreeFile(page, 'README.md');
  await openTreeFile(page, 'package.json');
  await expect(page.locator('.cv-tab')).toHaveCount(2);
  await expect(page.locator('.cv-lc').first()).toBeVisible();
  // 代码正文选了会弹
  const a = (await page.locator('.cv-line').nth(0).locator('.cv-lc').boundingBox())!;
  await page.mouse.move(a.x + 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 60, a.y + a.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.selection-pop')).toHaveClass(/is-visible/);

  // 换到签条上选：必须不弹（外壳没有 user-select:text，且不在登记区域内）
  await page.keyboard.press('Escape');
  const tab = (await page.locator('.cv-tab').first().boundingBox())!;
  await page.mouse.move(tab.x + 6, tab.y + tab.height / 2);
  await page.mouse.down();
  await page.mouse.move(tab.x + 90, tab.y + tab.height / 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator('.selection-pop')).not.toHaveClass(/is-visible/);
});

// ===== CE-S07 Git 状态角标 =====

/** 用 __forgeMock.seed 接管 git/getStatus，让本组用例的变更集由测试自己定。
 *
 *  不依赖 mock-bridge 共享种子的理由：那份 seed 列了 mock-bridge.ts，
 *  但文件树 fixture 里**没有这个文件**（seed 注释自称「与 fileMock 对齐」，
 *  实际没对齐）。用例若硬编码种子名单，以后 fixture 一动就假红/假绿。
 *  改为自己 seed：既不碰共享 fixture（会打破 2 处 .ctp-row 计数断言），
 *  也只挑**树里确实存在**的文件。
 *  seed 里仍然镜像 core 的 requireString(params,'path')——参数名错了照样被拒。 */
async function seedGitStatus(
  page: Page,
  files: { path: string; status: string; staged?: boolean; added?: number; removed?: number }[],
): Promise<void> {
  await page.evaluate((fs) => {
    window.__forgeMock!.seed('git/getStatus', (params) => {
      const path = params['path'];
      if (typeof path !== 'string' || path.trim() === '') {
        return { code: 1001, message: '参数错误：path 必须为非空字符串', data: null };
      }
      return {
        code: 0,
        message: 'ok',
        data: {
          isGitRepo: true,
          branch: 'main',
          detached: false,
          fileCount: fs.length,
          // 汇总口径：**不含**未跟踪（与 core `diff HEAD --numstat` 一致）
          added: fs.filter((f) => f.status !== '?').reduce((n, f) => n + (f.added ?? 0), 0),
          removed: fs.filter((f) => f.status !== '?').reduce((n, f) => n + (f.removed ?? 0), 0),
          stagedEmpty: fs.every((f) => !f.staged),
          stagedCount: fs.filter((f) => f.staged).length,
          unpushedCount: 0,
          hasHead: true,
          files: fs,
        },
      };
    });
  }, files);
}

/** 非 git 项目的 seed（与 core 的 NOT_A_STATUS 同形） */
async function seedNotGit(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__forgeMock!.seed('git/getStatus', () => ({
      code: 0,
      message: 'ok',
      data: {
        isGitRepo: false,
        branch: null,
        detached: false,
        fileCount: 0,
        added: 0,
        removed: 0,
        stagedEmpty: true,
        stagedCount: 0,
        unpushedCount: null,
        hasHead: false,
        files: [],
      },
    }));
  });
}

test('Git 角标：改动过的文件行尾出现 M/A/? 徽标', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, [
    { path: 'packages/forge-ui/src/App.vue', status: 'M' },
    { path: 'packages/forge-core/src/file/fileService.ts', status: 'A' },
    { path: 'docs/prd/12_code_explorer.md', status: '?' },
  ]);
  await openCode(page);
  await expandAll(page);

  // 这条断言就是「loadGitStatus 真的把 path 发对了」的回归：
  // 参数名写错时它静默返回 []，下面三个徽标一个都不会出现，
  // 且不报任何错——不写这条断言，这个缺陷可以无限期潜伏。
  await expect(rowOf(page, 'App.vue').locator('.ctp-git')).toHaveAttribute('data-git', 'M');
  await expect(rowOf(page, 'fileService.ts').locator('.ctp-git')).toHaveAttribute('data-git', 'A');
  await expect(rowOf(page, '12_code_explorer.md').locator('.ctp-git')).toHaveAttribute('data-git', '?');

  // 未改动的文件不能有徽标（否则就是「见树有徽标」，信息量为零）
  await expect(rowOf(page, 'README.md').locator('.ctp-git')).toHaveCount(0);
  await expect(rowOf(page, 'package.json').locator('.ctp-git')).toHaveCount(0);
});

test('Git 角标：非 git 项目 → 整棵树不出现任何徽标', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedNotGit(page);
  await openCode(page);
  await expandAll(page);

  await expect(page.locator('.ctp-git')).toHaveCount(0);
});

test('Git 角标：目录行沿祖先链聚合出徽标（子树里有改动就标）', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  // 刻意用 docs/prd 这条路径：fixture 里 src 与 file 各有两份
  // （forge-ui/src、forge-core/src），按名字定位会命中另一个分支。
  // prd / docs 在整棵树里唯一，断言才落在确定的节点上。
  await seedGitStatus(page, [{ path: 'docs/prd/12_code_explorer.md', status: 'M' }]);
  await openCode(page);
  await expandAll(page);

  // 有改动 → 它自己与各级祖先目录都应聚合出徽标
  await expect(rowOf(page, 'prd').locator('.ctp-git')).toHaveAttribute('data-git', 'M');
  await expect(rowOf(page, 'docs').locator('.ctp-git')).toHaveAttribute('data-git', 'M');
  // 另一条分支无改动 → 不该有
  await expect(rowOf(page, 'README.md').locator('.ctp-git')).toHaveCount(0);
});

test('Git 角标：打开改动文件后代码纸面包屑旁显示状态', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, [
    { path: 'packages/forge-ui/src/App.vue', status: 'M' },
    { path: 'docs/prd/12_code_explorer.md', status: '?' },
  ]);
  await openCode(page);
  await expandAll(page);
  await openTreeFile(page, 'App.vue');

  await expect(page.locator('.cv-badge')).toHaveAttribute('data-git', 'M');
  await expect(page.locator('.cv-badge')).toHaveText('M');

  // 用户 2026-10-03 报的回归：头部徽标要走和文件树同一张映射表，
  // 未跟踪（porcelain 的 ?）在树里印绿 U，这里若直接印原始字符就分叉了
  await openTreeFile(page, '12_code_explorer.md');
  await expect(page.locator('.cv-badge')).toHaveAttribute('data-git', '?');
  await expect(page.locator('.cv-badge')).toHaveText('U');
});

test('Git 角标：打开未改动文件 → 面包屑旁不出现徽标', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, [{ path: 'packages/forge-ui/src/App.vue', status: 'M' }]);
  await openCode(page);
  await expandAll(page);
  await openTreeFile(page, 'README.md');

  await expect(page.locator('.cv-badge')).toHaveCount(0);
});

// ===== CE-S09 Git 变更视图 + 底栏提交条 =====

/** 切到「变更」视图（默认是「文件」） */
async function toChanges(page: Page): Promise<void> {
  await page.locator('.ctp-view', { hasText: '变更' }).click();
  await expect(page.locator('.ctp-views .ctp-view.is-on')).toHaveText(/变更/);
}

const CHANGES = [
  { path: 'packages/forge-ui/src/App.vue', status: 'M', added: 12, removed: 3 },
  { path: 'packages/forge-core/src/file/fileService.ts', status: 'A', staged: true, added: 340, removed: 0 },
  { path: 'docs/prd/12_code_explorer.md', status: '?', added: 24, removed: 0 },
];

test('变更视图：清单列出全部变更文件，带状态角标与逐文件 +N −M', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await openCode(page);
  await toChanges(page);

  const rows = page.locator('.ctp-changed');
  await expect(rows).toHaveCount(3);
  // 状态角标：porcelain 的 ? 映射成 U（未跟踪），不是直接印问号
  await expect(rows.nth(0).locator('.ctp-git')).toHaveAttribute('data-git', 'M');
  await expect(rows.nth(0).locator('.ctp-git')).toHaveText('M');
  await expect(rows.nth(1).locator('.ctp-git')).toHaveText('A');
  await expect(rows.nth(2).locator('.ctp-git')).toHaveText('U');
  // 逐文件行数
  await expect(rows.nth(0).locator('.ctp-add')).toHaveText('+12');
  await expect(rows.nth(0).locator('.ctp-del')).toHaveText('−3');
  await expect(rows.nth(1).locator('.ctp-add')).toHaveText('+340');
  // 文件名完整不截断（目录尾巴必须让位给文件名）
  const nameEl = rows.nth(0).locator('.ctp-name');
  expect(await nameEl.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
});

test('变更视图：文件视图与变更视图互斥，且都保留已打开的签', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await openCodeWithFile(page);
  await toChanges(page);
  // 变更视图里不渲染树
  await expect(page.locator('.ctp-changed')).toHaveCount(3);
  // 切回文件视图，已开的签还在（两个视图共用同一份 useCodeExplorer 状态）
  await page.locator('.ctp-view', { hasText: '文件' }).first().click();
  await expect(page.locator('.cv-tab.active .cv-tab-name')).toHaveText('README.md');
});

test('变更视图：点清单行 → 打开该文件', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await openCode(page);
  await toChanges(page);
  await page.locator('.ctp-changed').nth(0).click();

  await expect(page.locator('.cv')).toBeVisible();
  await expect(page.locator('.cv-tab.active .cv-tab-name')).toHaveText('App.vue');
  await expect(page.locator('.cv-badge')).toHaveAttribute('data-git', 'M');
});

test('变更视图：没有变更时给明确空态，且不出现提交按钮', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, []);
  await openCode(page);
  await toChanges(page);

  await expect(page.locator('.ctp-empty-title')).toHaveText('没有未提交的变更');
  await expect(page.locator('.ctp-commit-btn')).toHaveCount(0);
  // 切换器上的变更数角标也不该出现
  await expect(page.locator('.ctp-count')).toHaveCount(0);
});

test('变更视图：非 git 项目 → 明确提示，不显示清单', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedNotGit(page);
  await openCode(page);
  await toChanges(page);

  await expect(page.locator('.ctp-empty-title')).toHaveText('此项目不是 Git 仓库');
  await expect(page.locator('.ctp-changed')).toHaveCount(0);
  await expect(page.locator('.ctp-commit-btn')).toHaveCount(0);
});

test('变更视图：切换器上的变更数角标反映未提交文件数', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await openCode(page);

  await expect(page.locator('.ctp-count')).toHaveText('3');
});

/** 用 __forgeMock.seed 接管 git/getFileDiff（并排 diff 数据源）。
 *  与 seedGitStatus 同一策略：参数名漂移（path/relPath）在这里被真实拒绝。 */
async function seedFileDiff(page: Page, diffs: Record<string, string | null>): Promise<void> {
  await page.evaluate((m) => {
    window.__forgeMock!.seed('git/getFileDiff', (params) => {
      const path = params['path'];
      const relPath = params['relPath'];
      if (typeof path !== 'string' || path.trim() === '') {
        return { code: 1001, message: '参数错误：path 必须为非空字符串', data: null };
      }
      if (typeof relPath !== 'string' || relPath.trim() === '') {
        return { code: 1001, message: '参数错误：relPath 必须为非空字符串', data: null };
      }
      return { code: 0, message: 'ok', data: { diff: relPath in m ? (m as Record<string, string | null>)[relPath] ?? null : '' } };
    });
  }, diffs);
}

/** App.vue 的演示 diff：1 个 hunk = 上下文×2 + 修改对 + 纯新增×1 + 上下文×1，
 *  解析后 5 行并排（2 equal、1 removed/added 对、1 纯 added、1 equal）。 */
const APP_DIFF = [
  'diff --git a/packages/forge-ui/src/App.vue b/packages/forge-ui/src/App.vue',
  '--- a/packages/forge-ui/src/App.vue',
  '+++ b/packages/forge-ui/src/App.vue',
  '@@ -2,4 +2,5 @@',
  ' import { ref } from "vue";',
  '',
  '-const activeView = ref("sessions");',
  '+import { useCodeExplorer } from "./composables/useCodeExplorer";',
  '+const activeView = ref("sessions");',
  ' </script>',
].join('\n');

// ===== CE-S09b 并排 diff（模块 12 P2，用户 2026-10-03 报「变更tab右侧没有对比」）=====

test('对比：变更清单点文件 → 右侧直接落到并排 diff（增删底色 + 两侧行号）', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await seedFileDiff(page, { 'packages/forge-ui/src/App.vue': APP_DIFF });
  await openCode(page);
  await toChanges(page);
  await page.locator('.ctp-changed').nth(0).click();

  // 切换器在 diff 态：右侧不再是文件正文，而是并排网格
  await expect(page.locator('.cv-mode', { hasText: '并排' })).toHaveClass(/is-on/);
  await expect(page.locator('.cv-diff-row')).toHaveCount(5);
  // hunk 之间/首尾的未变更区域显式交代（行号跳变不再是哑巴）：
  // hunk 从新第 2 行起 → 头段 1 行；文件 10+ 行、hunk 止于第 6 行 → 尾段
  await expect(page.locator('.cv-diff-omit')).toHaveCount(2);
  await expect(page.locator('.cv-diff-omit').first()).toHaveText(/未变更 1 行/);
  // 增删格与文本（git 对齐的结果照搬，不重排）
  await expect(page.locator('.cv-diff-cell.is-removed')).toHaveText('const activeView = ref("sessions");');
  await expect(page.locator('.cv-diff-cell.is-added').first()).toHaveText(
    'import { useCodeExplorer } from "./composables/useCodeExplorer";',
  );
  // 两侧行号来自 hunk 头：删除行旧号 4 / 新增行新号 4
  await expect(page.locator('.cv-diff-row').nth(2).locator('.cv-diff-num').first()).toHaveText('4');
  // 底栏报逐文件 ±行数与基线（不再报文件行数/体积）
  await expect(page.locator('.cv-foot .cv-add')).toHaveText('+12');
  await expect(page.locator('.cv-foot .cv-del')).toHaveText('−3');
  await expect(page.locator('.cv-foot')).toContainText('相对 HEAD');
});

test('对比：树里打开有变更的文件 → 直接并排 diff（不先闪文件正文），点「文件」可看原文', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await seedFileDiff(page, { 'packages/forge-ui/src/App.vue': APP_DIFF });
  await openCode(page);
  await expandAll(page);
  await openTreeFile(page, 'App.vue');

  // 默认规则「有修改就展示 diff」（用户 2026-10-03 定稿）：树里点开也直接是 diff
  await expect(page.locator('.cv-mode', { hasText: '并排' })).toHaveClass(/is-on/);
  await expect(page.locator('.cv-diff-row')).toHaveCount(5);
  // 「文件」按钮保留：想看原始文件仍可手动切
  await page.locator('.cv-mode', { hasText: '文件' }).click();
  await expect(page.locator('.cv-code')).toBeVisible();
  // 切走再切回来，默认重新生效（文件形态不跨文件记忆）
  await openTreeFile(page, 'package.json');
  await expect(page.locator('.cv-code')).toBeVisible();
  await openTreeFile(page, 'App.vue');
  await expect(page.locator('.cv-diff-row')).toHaveCount(5);
});

test('对比：未变更文件直接是文件正文，永不出现「没有未提交改动」空态页', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await seedFileDiff(page, { 'packages/forge-ui/src/App.vue': APP_DIFF });
  await openCode(page);
  await expandAll(page);
  // 先把右侧带进 diff 语境（打开有变更的文件）
  await openTreeFile(page, 'App.vue');
  await expect(page.locator('.cv-diff-row')).toHaveCount(5);

  // 切到未变更文件：直接文件正文 + diff 按钮置灰；「没有未提交改动」空态页不该出现
  await openTreeFile(page, 'package.json');
  await expect(page.locator('.cv-code')).toBeVisible();
  await expect(page.locator('.cv-mode', { hasText: '并排' })).toBeDisabled();
  await expect(page.locator('.cv-mode', { hasText: '行内' })).toBeDisabled();
  await expect(page.locator('.cv-state-title', { hasText: '此文件没有未提交的改动' })).toHaveCount(0);
});

test('对比：个性化里把默认视图切到「行内」→ 变更文件直接进行内高亮，删除块可展开', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await seedFileDiff(page, { 'packages/forge-ui/src/App.vue': APP_DIFF });
  // 设置 → 个性化 → 代码对比默认视图 = 行内（2026-10-03 新增的个性化项）
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-panel, .settings-body')).toBeVisible();
  await page.locator('.settings-tab', { hasText: '个性化' }).click();
  await page.locator('.code-layout-option', { hasText: '行内' }).click();
  await page.locator('.settings-back, .settings-close').first().click();

  await openCode(page);
  await expandAll(page);
  await openTreeFile(page, 'App.vue');

  // 行内形态：文件正文 + 新增行标记 + 删除占位条（-旧 +新 的替换也算一条占位条）
  await expect(page.locator('.cv-mode', { hasText: '行内' })).toHaveClass(/is-on/);
  await expect(page.locator('.cv-line.is-add')).toHaveCount(2);
  await expect(page.locator('.cv-delblock')).toHaveCount(1);
  // 右缘滚动位置色块（Zed 同款）：新增连续段 1 条绿 + 删除占位条 1 条红
  await expect(page.locator('.cv-minimap-mark.is-add')).toHaveCount(1);
  await expect(page.locator('.cv-minimap-mark.is-del')).toHaveCount(1);
  // 占位条默认收起，点开看到被删的旧行
  await expect(page.locator('.cv-delblock-gone')).toBeHidden();
  await page.locator('.cv-delblock-bar').click();
  await expect(page.locator('.cv-delblock-gone')).toBeVisible();
  await expect(page.locator('.cv-delblock-text')).toHaveText('const activeView = ref("sessions");');
  // 切换器三档都在：可临时切回并排（偏好不被改写）
  await page.locator('.cv-mode', { hasText: '并排' }).click();
  await expect(page.locator('.cv-diff-row')).toHaveCount(5);
  await page.locator('.cv-mode', { hasText: '行内' }).click();
  await expect(page.locator('.cv-line.is-add')).toHaveCount(2);
});

test('变更视图：级联模式按目录分层（默认平铺），目录可折叠、点文件打开', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await openCode(page);
  await toChanges(page);

  // 默认平铺（2026-10-03 用户定稿）
  await expect(page.locator('.ctp-changed')).toHaveCount(3);
  await expect(page.locator('.ctp-changed-dir')).toHaveCount(0);

  // 切级联：目录节点全部默认展开；文件行仍可点开
  await page.locator('.ctp-changed-mode', { hasText: '级联' }).click();
  await expect(page.locator('.ctp-changed-dir')).toHaveCount(8);
  await expect(page.locator('.ctp-changed')).toHaveCount(3);
  // 目录聚合状态与文件树同口径：docs 子树唯一变更项是 ? → 透传；packages 下两个文件 → M
  await expect(rowOf(page, 'docs').locator('.ctp-git')).toHaveAttribute('data-git', '?');
  await expect(rowOf(page, 'packages').locator('.ctp-git')).toHaveAttribute('data-git', 'M');
  // 折叠 docs：docs 行还在（它是折叠开关），其子目录 prd 一并隐藏
  await rowOf(page, 'docs').click();
  await expect(page.locator('.ctp-changed-dir')).toHaveCount(7);
  await expect(page.locator('.ctp-changed')).toHaveCount(2);
  // 再展开，点文件行 → 打开（与平铺同一条 openFile 路径）
  await rowOf(page, 'docs').click();
  await expect(page.locator('.ctp-changed-dir')).toHaveCount(8);
  await page.locator('.ctp-changed', { hasText: 'App.vue' }).click();
  await expect(page.locator('.cv')).toBeVisible();
  await expect(page.locator('.cv-tab.active .cv-tab-name')).toHaveText('App.vue');
  // 切回平铺：树行消失，清单回到一列
  await page.locator('.ctp-changed-mode', { hasText: '平铺' }).click();
  await expect(page.locator('.ctp-changed')).toHaveCount(3);
  await expect(page.locator('.ctp-changed-dir')).toHaveCount(0);
});

test('对比：未跟踪文件 → git 不给 diff，用已加载正文合成「全新增」视角', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await openCode(page);
  await toChanges(page);
  await page.locator('.ctp-changed').nth(2).click(); // docs/prd/12_code_explorer.md（?）

  // 所有行右=added、左=空底（左侧无内容可对照，行号也不该出现）
  const rows = page.locator('.cv-diff-row');
  expect(await rows.count()).toBeGreaterThan(0);
  await expect(page.locator('.cv-diff-cell.is-added')).toHaveCount(await rows.count());
  await expect(page.locator('.cv-diff-cell.is-removed')).toHaveCount(0);
  await expect(rows.first().locator('.cv-diff-num').first()).toHaveText('');
});

test('对比：git/getFileDiff 失败（6001）→ 明确失败态而不是空白纸', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  // composable 把一切非 0 信封归一成 null；这里用 6001 模拟 git diff 真失败
  await page.evaluate(() => {
    window.__forgeMock!.seed('git/getFileDiff', () => ({ code: 6001, message: 'git diff 失败', data: null }));
  });
  await openCode(page);
  await toChanges(page);
  await page.locator('.ctp-changed').nth(0).click();

  await expect(page.locator('.cv-state-title')).toHaveText('对比加载失败');
});

test('提交条：汇总数 = 逐文件之和（含未跟踪），点开走模块 11 现有弹窗', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, CHANGES);
  await openCode(page);
  await toChanges(page);

  // 3 个文件 +12+340+24 = +376，−3。注意这**不等于** GitStatusInfo.added
  // （那个是 numstat 汇总，不含未跟踪的 24）——底栏要的是「这次一共改了多少」。
  await expect(page.locator('.ctp-commit-l1')).toHaveText('3 个文件待提交');
  await expect(page.locator('.ctp-commit-l2 .ctp-add')).toHaveText('+376');
  await expect(page.locator('.ctp-commit-l2 .ctp-del')).toHaveText('−3');

  await page.locator('.ctp-commit-btn').click();
  // 类名是 GitCommitDialog.vue 的真类名（.dialog-*），不是原型里的 .dlg-*
  await expect(page.locator('.dialog-title')).toHaveText('提交或推送');
  await expect(page.locator('.dlg-counts')).toContainText('待提交 3');
});

// ===== 目录行聚合状态 + 父级染色（用户 2026-10-03 报「父级节点也要颜色标记」）=====

test('Git 角标：单文件目录透传子文件状态，目录名随状态染色', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, [{ path: 'docs/prd/12_code_explorer.md', status: 'A' }]);
  await openCode(page);
  await expandAll(page);

  // 唯一变更项是 A → 目录角标透传 A（旧实现一律 M，「目录里新增了文件」就读不出来了）
  await expect(rowOf(page, 'prd').locator('.ctp-git')).toHaveAttribute('data-git', 'A');
  await expect(rowOf(page, 'docs').locator('.ctp-git')).toHaveAttribute('data-git', 'A');
  // 父级染色：目录名与角标同色（同一张 STATUS_UI 表驱动，否则名字灰、角标彩）
  await expect(rowOf(page, 'prd').locator('.ctp-name')).toHaveClass(/is-add/);
  await expect(rowOf(page, 'docs').locator('.ctp-name')).toHaveClass(/is-add/);
  // 没有改动的分支不染色
  await expect(rowOf(page, 'README.md').locator('.ctp-name')).not.toHaveClass(/is-/);
});

test('Git 角标：多文件目录聚合为 M，目录名染 M 色', async ({ page }) => {
  await attachHealthGuards(page);
  await waitForMock(page);
  await seedGitStatus(page, [
    { path: 'packages/forge-ui/src/App.vue', status: 'M' },
    { path: 'packages/forge-ui/src/bridge.ts', status: 'M' },
  ]);
  await openCode(page);
  await expandAll(page);

  await expect(rowOf(page, 'forge-ui').locator('.ctp-git')).toHaveAttribute('data-git', 'M');
  await expect(rowOf(page, 'forge-ui').locator('.ctp-name')).toHaveClass(/is-mod/);
  // M 徽标必须挂上 is-m（warning 橙）——漏掉这条规则 M 就落默认灰，等于没标
  await expect(rowOf(page, 'App.vue').locator('.ctp-git')).toHaveClass(/is-m/);
});

