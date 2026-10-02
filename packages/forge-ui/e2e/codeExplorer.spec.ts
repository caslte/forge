/**
 * 内置代码浏览器 E2E（CE-S01 ~ CE-S08，mock-backend）。
 *
 * 覆盖：<> 入口与左栏整栏互斥、目录懒加载与排序、文件只读查看与降级态、
 * 文件名过滤、多标签、A 整屏「对话宽度零变化」硬指标、B 分割 5px 沟与 320px 保底、
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
  // 每个用例从干净的偏好开始：默认左右分割 / 46%
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
  // 默认是分割，先切到整屏覆盖再验证「宽度零变化」
  await page.locator('.ctp-icon').click();
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

test('E-CE-06 @P0 @mock-backend：布局 B 分割——5px 沟、两侧贴合、320px 保底', async ({ page }) => {
  const health = attachHealthGuards(page);
  // 默认即分割，打开文件后代码纸出现在右缘
  await openCodeWithFile(page);
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');

  const gutter = page.locator('.csp');
  await expect(gutter).toBeVisible();
  const g = await gutter.boundingBox();
  // 视觉沟宽 5px；负 margin 把命中区扩到两侧各 3px，故实测应是 5
  expect(g!.width).toBeCloseTo(5, 0);

  // 拖到最左：代码区变宽并顶到上限，对话区被钳在 320px 保底线（含 5px 沟）
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
  // 偏好没被改写（默认即 split，键可能压根没写过；只要不是被降级偷换成 cover 就行）
  expect(await page.evaluate(() => localStorage.getItem('forge.codeViewerLayout'))).not.toBe('cover');

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

test('E-CE-11 @P1 @mock-backend：设置页可改布局与分割宽度，回工作台立即生效', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.locator('.sidebar-link').click();
  await expect(page.locator('.settings-panel, .settings-body')).toBeVisible();
  await page.locator('.settings-tab', { hasText: '个性化' }).click();

  // 默认 split：滑杆可用
  const slider = page.locator('.split-range');
  await expect(slider).toBeEnabled();

  // 切到整屏覆盖：滑杆禁用而非隐藏
  await page.locator('.code-layout-option', { hasText: '整屏覆盖' }).click();
  await expect(slider).toBeDisabled();

  await page.locator('.code-layout-option', { hasText: '左右分割' }).click();
  await expect(slider).toBeEnabled();
  // range 控件不能用 fill（Playwright 对它报 Malformed value），直接设值 + 派发 input
  await slider.evaluate((el) => {
    const input = el as HTMLInputElement;
    input.value = '60';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await expect(page.locator('.split-value')).toContainText('60%');

  await page.locator('.settings-back, .settings-close').first().click();
  await openCodeWithFile(page);
  await expect(page.locator('.cex')).toHaveAttribute('data-layout', 'split');
  const host = (await page.locator('.cex').boundingBox())!.width;
  const w = (await page.locator('.cex-split').boundingBox())!.width;
  expect(Math.abs(w / host - 0.6)).toBeLessThan(0.03);
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

test('E-CE-13 @P1 @mock-backend：tab 中键关闭、溢出横滚 + 激活签滚进视野、最近打开上限 5 个', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCode(page);
  await expandAll(page);

  // 逐个打开 7 个文件：最近打开的「最新在最前」和 tab 顺序都由此确定
  const names = [
    'README.md',
    'package.json',
    'App.vue',
    'bridge.ts',
    'fileService.ts',
    'fileService.test.ts',
    '12_code_explorer.md',
  ];
  for (const n of names) await openTreeFile(page, n);
  await expect(page.locator('.cv')).toBeVisible();
  await expect(page.locator('.cv-tab')).toHaveCount(names.length);

  // 最近打开只列 5 个，最新的在最前，最旧的被挤出去
  const recent = page.locator('.ctp-row.is-recent');
  await expect(recent).toHaveCount(5);
  await expect(recent.first().locator('.ctp-name')).toHaveText('12_code_explorer.md');
  await expect(recent.nth(1).locator('.ctp-name')).toHaveText('fileService.test.ts');
  // 被挤出去的两个最旧项不在分组里
  await expect(recentName(page, 'README.md')).toHaveCount(0);
  await expect(recentName(page, 'package.json')).toHaveCount(0);
  // 上限只作用于这个导航分组：代码纸上的签一个都不该少
  await expect(page.locator('.cv-tab')).toHaveCount(names.length);

  // 溢出：签数超过纸宽时 tab 条要能横向滚
  const strip = page.locator('.cv-tabs');
  const box = await strip.evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
  expect(box.sw).toBeGreaterThan(box.cw);
  await strip.evaluate((el) => { el.scrollLeft = 0; });

  // 从树/最近打开切到最右边的签（不经 tab 条，避免 Playwright 自己先滚过去）时，
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
  // 中键不该当切签用：再关一个不相关的签，激活项仍然不变
  await page.locator('.cv-tab').nth(3).click({ button: 'middle' });
  await expect(page.locator('.cv-tab')).toHaveCount(names.length - 2);
  await expect(page.locator('.cv-tab.active .cv-tab-name')).toHaveText(activeBefore);
});

test('E-CE-15 @P1 @mock-backend：tab 条悬停时竖向滚轮可横滚；代码正文真的是 JetBrains Mono；选中底色无绿', async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openCode(page);
  await expandAll(page);
  const names = [
    'README.md',
    'package.json',
    'App.vue',
    'bridge.ts',
    'fileService.ts',
    'fileService.test.ts',
    '12_code_explorer.md',
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
  const bg = await page.locator('.ctp-row.is-recent.is-active').evaluate((el) => {
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

test('E-CE-18 @P0 @mock-backend：历史与标签页解耦——关掉签仍在最近打开里，点它能重开', async ({ page }) => {
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

test('E-CE-19 @P1 @mock-backend：历史顺序只跟“打开”动作走，切换签不重排', async ({ page }) => {
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
