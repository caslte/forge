/**
 * 会话行尾相对活跃时间 E2E（mock-backend，mock-bridge 可编程 lastActiveAt）。
 *
 * 覆盖三件事：
 * - 文案分档：刚刚 / N分钟 / N小时 / N天 → 跨年退化为 YYYY/M/D（单测见
 *   test/sessionView.test.ts，这里只验「真渲染出来且是中文单位」）；
 * - hover 换位：时间淡出、删除按钮淡入，且行右边界与标题右边界零位移
 *   （两者叠在同一个 grid 格子里，hover 不该把行宽推来推去）；
 * - 任务视角同样带时间，且与项目 tag 共存。
 */
import { test, expect, type Page } from '@playwright/test';
import { seedSessions } from './helpers/index';

const HOUR = 3_600_000;
const iso = (ms: number) => new Date(Date.now() - ms).toISOString();

function mkSession(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    projectPath: 'D:/work/aiwork/forge',
    alias: null,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
    ...over,
  };
}

async function boot(page: Page, sessions: Array<Record<string, unknown>>): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
}

/** 行内时间元素；按别名定位行，避免用序号（项目视角默认只显示前 5 条） */
const timeOf = (page: Page, alias: string) =>
  page.locator('.tree-session', { hasText: alias }).locator('.tree-session-time');

test('SESSION-TIME-001：行尾相对时间分档渲染，title 给绝对时间', async ({ page }) => {
  await boot(page, [
    mkSession({ alias: '刚活跃', lastActiveAt: iso(20_000) }),
    mkSession({ alias: '二十五分', lastActiveAt: iso(25 * 60_000) }),
    mkSession({ alias: '十一小时', lastActiveAt: iso(11 * HOUR) }),
    mkSession({ alias: '三天前', lastActiveAt: iso(3 * 24 * HOUR) }),
    mkSession({ alias: '跨年', lastActiveAt: iso(320 * 24 * HOUR) }),
  ]);

  await expect(timeOf(page, '刚活跃')).toHaveText('刚刚');
  await expect(timeOf(page, '二十五分')).toHaveText('25分钟');
  await expect(timeOf(page, '十一小时')).toHaveText('11小时');
  await expect(timeOf(page, '三天前')).toHaveText('3天');
  // 超远时间退化成日期：跨年补年份，同年只到月日
  await expect(timeOf(page, '跨年')).toHaveText(new RegExp(`^${new Date().getFullYear() - 1}/`));
  await expect(timeOf(page, '十一小时')).toHaveAttribute('title', /^\d{4}\/\d{2}\/\d{2} \d{2}:\d{2}$/);
});

test('SESSION-TIME-002：hover 用删除按钮换掉时间，行宽零抖动', async ({ page }) => {
  await boot(page, [mkSession({ alias: '悬停行', lastActiveAt: iso(11 * HOUR) })]);
  const row = page.locator('.tree-session', { hasText: '悬停行' });
  const time = row.locator('.tree-session-time');
  const btn = row.locator('.tree-icon-button.danger');
  // 删除按钮包一层 .tree-node-actions（常驻 DOM、opacity 切换），量它的透明度
  const actionsOpacity = () =>
    btn.evaluate((el) => getComputedStyle(el.parentElement as Element).opacity);

  const geom = () =>
    row.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const title = el.querySelector('.tree-session-title')!.getBoundingClientRect();
      return {
        rowRight: r.right,
        titleRight: title.right,
        timeWidth: el.querySelector('.tree-session-time')!.getBoundingClientRect().width,
      };
    });

  const before = await geom();
  expect(await time.evaluate((el) => getComputedStyle(el).opacity)).toBe('0.55');
  expect(await actionsOpacity(), '未 hover 时删除按钮不可见').toBe('0');

  await row.hover();
  await expect.poll(() => time.evaluate((el) => getComputedStyle(el).opacity)).toBe('0');
  expect(await actionsOpacity(), 'hover 后删除按钮出现').toBe('1');

  const after = await geom();
  expect(after.rowRight, 'hover 不得改变行宽').toBeCloseTo(before.rowRight, 1);
  expect(after.titleRight, 'hover 不得挤压标题').toBeCloseTo(before.titleRight, 1);
  expect(after.timeWidth, '时间槽宽度不随显隐变化').toBeCloseTo(before.timeWidth, 1);

  // 按钮命中区没有被时间挡住：点击仍能进确认态
  await btn.click();
  await expect(row.locator('.confirm-text')).toBeVisible();
});

test('SESSION-TIME-003：任务视角同样带时间，与项目 tag 共存', async ({ page }) => {
  await boot(page, [mkSession({ alias: '任务行', lastActiveAt: iso(15 * HOUR) })]);
  await page.locator('.view-seg button', { hasText: '任务' }).click();

  const row = page.locator('.tree-session', { hasText: '任务行' });
  await expect(row.locator('.tree-session-time')).toHaveText('15小时');
  await expect(row.locator('.tree-session-proj-tag')).toBeVisible();
});
