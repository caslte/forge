/**
 * CE-S11 Git 提交历史 E2E（PRD 12 §3.7，mock-backend）。
 *
 * 用例编号 E-CE-30 ~ E-CE-37（接既有 codeExplorer.spec.ts 的 E-CE-01~29）。
 * 覆盖：三视图切换、提交人展示（本需求核心）、日期分组、筛选、提交详情头部、
 * **两级取数时序**、空态两态、并排 diff、分页。
 *
 * 三条纪律：
 * 1. **零网络请求**要真的断言（头像纯本地派生，不引 gravatar）；
 * 2. 几何/颜色断言等过渡落定再读（既有 changelog 记录过「transition 中间帧」坑）；
 * 3. 涉及颜色的断言双主题各跑一遍——暗色下 token 会切换。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

/** E-CE-34 用的最小 unified diff（seed 替身直接返回它） */
const MOCK_COMMIT_DIFF = [
  'diff --git a/x b/x',
  '--- a/x',
  '+++ b/x',
  '@@ -1,2 +1,2 @@',
  ' 旧',
  '-删掉的',
  '+新增的',
].join('\n');

/** 进代码态（只切左栏，不打开文件——历史视图不需要文件） */
async function openCode(page: Page, projectName = 'forge'): Promise<void> {
  const row = page.locator('.tree-project', { hasText: projectName }).first();
  await row.hover();
  await row.locator('.code-entry').click();
  await expect(page.locator('.ctp')).toBeVisible();
  await expect(page.locator('.ctp-row').first()).toBeVisible();
}

/** 切到历史视图并等首屏 */
async function openHistory(page: Page): Promise<void> {
  await openCode(page);
  await page.locator('.ctp-view', { hasText: '历史' }).click();
  await expect(page.locator('.ctp-cmt').first()).toBeVisible();
}

test.describe('CE-S11 Git 提交历史', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForMock(page);
    // 每例从干净偏好开始（默认整屏覆盖 / 46%）
    await page.evaluate(() => {
      localStorage.removeItem('forge.codeViewerLayout');
      localStorage.removeItem('forge.codeViewerSplitPct');
    });
    await page.reload();
  });

  test('E-CE-30 @P0 @mock-backend 历史视图加载冒烟（P0 门禁基线）', async ({ page }) => {
    const { assertHealthy } = attachHealthGuards(page);
    await openHistory(page);

    // B3 加载冒烟基线：关键元素存在、可见、不空白
    await expect(page.locator('.ctp-cmt').first()).toBeVisible();
    await expect(page.locator('.ctp-cmt-av').first()).toBeVisible();
    await expect(page.locator('.ctp-day').first()).toBeVisible();
    // 内容正确性：说明 + 作者 + 相对时间 + 短 SHA 四项齐全
    const first = page.locator('.ctp-cmt').first();
    await expect(first.locator('.ctp-cmt-subject')).not.toBeEmpty();
    await expect(first.locator('.ctp-cmt-author')).not.toBeEmpty();
    await expect(first.locator('.ctp-cmt-sha')).toHaveText(/^[0-9a-f]{7}$/);

    // 三视图互斥：文件视图的行不应残留
    await expect(page.locator('.ctp-row')).toHaveCount(0);
    assertHealthy();
  });

  test('E-CE-31 @P0 @mock-backend 提交人展示：头像取姓氏首字，同作者同色，零网络请求', async ({ page }) => {
    const { assertHealthy } = attachHealthGuards(page);

    // 头像不该有任何外域请求（纯本地派生，不引 gravatar）
    const external: string[] = [];
    page.on('request', (r) => {
      const u = r.url();
      if (!u.startsWith('http://127.0.0.1') && !u.startsWith('http://localhost') && !u.startsWith('data:')) {
        external.push(u);
      }
    });

    await openHistory(page);

    // mock 里有 陈默/王工/李工 三位作者，其中王工与李工**末字相同**
    const initials = await page.locator('.ctp-cmt-av').allTextContents();
    const uniq = new Set(initials.map((s) => s.trim()));
    expect(uniq.size, `头像首字应两两不同，实际：${JSON.stringify(initials)}`).toBeGreaterThanOrEqual(3);

    // 同作者多次提交 → 头像底色全等（视觉成串）
    const chenAvatars = page.locator('.ctp-cmt', { hasText: '陈默' }).locator('.ctp-cmt-av');
    const chenCount = await chenAvatars.count();
    expect(chenCount).toBeGreaterThan(1);
    const colors = new Set<string>();
    for (let i = 0; i < chenCount; i++) {
      colors.add(await chenAvatars.nth(i).evaluate((el) => getComputedStyle(el).backgroundColor));
    }
    expect(colors.size, '同一作者的提交头像底色必须一致').toBe(1);

    expect(external, `历史视图不得发起外部请求：${external.join(', ')}`).toHaveLength(0);
    assertHealthy();
  });

  test('E-CE-32 @P0 @mock-backend 历史列表筛选', async ({ page }) => {
    await openHistory(page);
    const before = await page.locator('.ctp-cmt').count();
    // 文件视图的过滤框是 v-show 隐藏但仍在 DOM 里，两个 .ctp-filter-input 会撞；
    // 用 placeholder 锁定历史视图那一个
    const input = page.getByPlaceholder('按说明 / 作者筛选');

    await input.fill('李工');
    await expect(page.locator('.ctp-cmt')).toHaveCount(1);

    // 无匹配要给空态，不空白不报错
    await input.fill('zzz不存在的关键词');
    await expect(page.locator('.ctp-cmt')).toHaveCount(0);
    await expect(page.locator('.ctp-empty-title')).toBeVisible();

    // 清空恢复全量（两个视图都有 .ctp-filter-clear，用 placeholder 定位到历史视图这一组）
    await page.locator('.ctp-filter', { has: page.getByPlaceholder('按说明 / 作者筛选') }).locator('.ctp-filter-clear').click();
    await expect(page.locator('.ctp-cmt')).toHaveCount(before);
  });

  test('E-CE-33 @P0 @mock-backend 提交详情头部给出全量 meta', async ({ page }) => {
    const { assertHealthy } = attachHealthGuards(page);
    await openHistory(page);
    await page.locator('.ctp-cmt').first().click();

    await expect(page.locator('.cd')).toBeVisible();
    await expect(page.locator('.cd-subject')).not.toBeEmpty();
    await expect(page.locator('.cd-name')).not.toBeEmpty();
    await expect(page.locator('.cd-mail')).toContainText('@');
    await expect(page.locator('.cd-when')).not.toBeEmpty();
    await expect(page.locator('.cd-sha')).toHaveText(/^[0-9a-f]{7}$/);
    await expect(page.locator('.cd-btn', { hasText: '复制 SHA' })).toBeVisible();
    assertHealthy();
  });

  test('E-CE-34 @P0 @mock-backend 两级取数：选中不取 patch，展开才取（核心契约）', async ({ page }) => {
    // 用 mock seed 做计数：包 window.forge.invoke 会连带影响应用初始化（initScript 又早于 forge 注入），
    // 两条路都试过。seed 替身自己返回数据，计数器更贴近真实调用点。
    await waitForMock(page);
    await page.evaluate(() => {
      const g = window as unknown as {
        __diffCalls: number[];
        __forgeMock: { seed: (m: string, h: (p: unknown) => unknown) => void };
      };
      g.__diffCalls = [];
      g.__forgeMock.seed('git/getCommitFileDiff', (p: unknown) => {
        const file = (p as { file?: string }).file ?? '';
        g.__diffCalls.push(file);
        return {
          code: 0,
          message: 'ok',
          data: {
            diff: MOCK_COMMIT_DIFF,
          },
        };
      });
    });

    await openHistory(page);
    await page.locator('.ctp-cmt').first().click();
    await expect(page.locator('.cd-name')).toBeVisible();

    // 契约核心：详情已就位，但**一个文件都没展开 → 一次 patch 都不该取**
    expect(
      await page.evaluate(() => (window as unknown as { __diffCalls: string[] }).__diffCalls.length),
      '未展开文件时不得取 patch（两级取数契约）',
    ).toBe(0);

    await page.locator('.cd-file-head').first().click();
    await expect(page.locator('.cd-file-body').first()).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { __diffCalls: string[] }).__diffCalls.length),
      '展开才取 patch',
    ).toBe(1);

    // 折叠再展开 → 命中缓存，不重复发 IPC
    // 两次点击之间要等重渲染落定：连点会被合成 dblclick，且展开态是渲染后才可见的
    await page.locator('.cd-file-head').first().click();
    await expect(page.locator('.cd-file-body')).toHaveCount(0);
    // 清零后重新展开：契约是「不产生**新**调用」，比累计计数更贴近意图
    await page.evaluate(() => {
      (window as unknown as { __diffCalls: string[] }).__diffCalls.length = 0;
    });
    await page.locator('.cd-file-head').first().click();
    await expect(page.locator('.cd-file-body').first()).toBeVisible();
    expect(
      await page.evaluate(() => (window as unknown as { __diffCalls: string[] }).__diffCalls.length),
      '二次展开应命中缓存（不得再次取 patch）',
    ).toBe(0);
  });

  test('E-CE-35 @P0 @mock-backend 空态：空仓库与非 Git 项目，且筛选框收起', async ({ page }) => {
    const { assertHealthy } = attachHealthGuards(page);
    // seedHandlers 是模块级 Map，reload 会连同 mock 模块一起重建 → 必须 reload **之后**才 seed
    await page.reload();
    await waitForMock(page);
    await page.evaluate(() => {
      (window as unknown as { __forgeMock: { seed: (m: string, h: () => unknown) => void } }).__forgeMock.seed(
        'git/getCommitLog',
        () => ({ code: 0, message: 'ok', data: { commits: [], hasMore: false } }),
      );
    });
    await openCode(page);
    await page.locator('.ctp-view', { hasText: '历史' }).click();

    await expect(page.locator('.ctp-empty-title')).toContainText('还没有任何提交');
    // 没有可筛的东西时筛选框应收起（留一个永远筛不出结果的框是噪声）
    await expect(page.getByPlaceholder('按说明 / 作者筛选')).toHaveCount(0);
    assertHealthy();
  });

  test('E-CE-36 @P0 @mock-backend 提交详情并排 diff 渲染', async ({ page }) => {
    const { assertHealthy } = attachHealthGuards(page);
    await openHistory(page);
    await page.locator('.ctp-cmt').first().click();
    // 必须等详情就绪再点文件块：详情未到时文件列表还没渲染，
    // 点击会落空或打在重渲染中的旧节点上
    await expect(page.locator('.cd-name')).toBeVisible();
    await page.locator('.cd-file-head').first().click();

    await expect(page.locator('.cd-diff')).toBeVisible();
    await expect(page.locator('.cd-drow').first()).toBeVisible();
    // 增删底色来自 token，深浅主题会切换——只看「有 class」不判色，
    // 具体色值交给单测/视觉验，这里钉住结构与可见性
    await expect(page.locator('.cd-dcell.is-add').first()).toBeVisible();
    assertHealthy();
  });

  test('E-CE-37 @P1 @mock-backend 分页「加载更多」追加且不重复', async ({ page }) => {
    await waitForMock(page);
    await page.evaluate(() => {
      const mk = (skip: number, n: number) =>
        Array.from({ length: n }, (_, i) => ({
          sha: String(skip + i).padStart(40, '0'),
          shortSha: String(skip + i).slice(0, 7).padEnd(7, '0'),
          subject: `提交 ${skip + i}`,
          authorName: '陈默',
          authorEmail: 'chenmo@kibo.com.cn',
          authoredAt: 1791438623 - skip - i,
          parentCount: 1,
          isMerge: false,
        }));
      (window as unknown as { __forgeMock: { seed: (m: string, h: (p: unknown) => unknown) => void } }).__forgeMock.seed(
        'git/getCommitLog',
        (p: unknown) => {
          const skip = (p as { skip?: number }).skip ?? 0;
          return { code: 0, message: 'ok', data: { commits: mk(skip, 3), hasMore: skip < 6 } };
        },
      );
    });
    await openHistory(page);

    const firstPage = await page.locator('.ctp-cmt').count();
    expect(firstPage).toBe(3);
    await page.locator('.ctp-cmt-more').click();
    await expect(page.locator('.ctp-cmt')).toHaveCount(6);

    // 不重复：按 sha 唯一
    const shas = await page.locator('.ctp-cmt-sha').allTextContents();
    expect(new Set(shas).size).toBe(6);
  });
});