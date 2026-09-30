/**
 * 选区复制浮窗 E2E（mock-backend）。
 *
 * 覆盖 CV-S13 的复制闭环 + 一条**可读性**守卫：
 * - 助手正文里真实拖选 → 选区上方弹出反色浮窗（锚点必须落在 .msg 内）；
 * - 浮窗在常态与「已复制」反馈态、以及鼠标停在按钮上（:hover）时，字与底的
 *   对比度都要 ≥ 4.5:1（WCAG AA 正文），深浅两套主题都跑。这条是被真机 bug 逼出来的：
 *   全局 `button:hover { color: var(--brand) }` 特异性 (0,1,1) 压过组件的 (0,1,0)，
 *   鼠标一停上去就变成「--brand 压在 --foreground 底上」——深色主题实测
 *   rgb(197,198,203) / rgb(179,180,184)，对比度 1.22:1，点完「复制」只剩一个灰药丸
 *   （浅色主题同样是亮字压暗底，1.3:1）。回退 CSS 改动复跑必红，见 changelog v6.8。
 * - 点一下剪贴板里真的是选区原文，1.4s 后浮窗自动收起。
 *
 * 对比度不靠正则解析 `rgb()/oklch()/color()`：直接在页面里用 1×1 canvas
 * 把 computed 颜色画出来读像素（canvas 的颜色解析覆盖 oklch / color-mix），
 * 顺带把半透明底合成到 --background 令牌上。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedHistory, seedSessions, waitForMock } from './helpers/index';

const PROJECT = 'D:/work/aiwork/forge';
const TEXT = '注册流程一共五步：填手机号、收验证码、设密码、绑定邮箱、进入工作台。';
type Theme = 'light' | 'dark';

/**
 * 等浮窗上所有 CSS 过渡/动画跑完再读颜色。
 * button 有 `transition: color var(--transition-fast)`（120ms，且 color 在 oklab 里插值），
 * 刚 hover 完 / 刚点完就去 getComputedStyle 拿到的是**中间帧**——同一份代码时绿时红。
 * 不用固定 sleep，直接 await Element.getAnimations()。
 */
async function settleTransitions(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const pop = document.querySelector('.selection-pop');
    if (!pop) return;
    await Promise.all(pop.getAnimations({ subtree: true }).map((a) => a.finished.catch(() => {})));
  });
}

/** 计算浮窗按钮「字 vs 底」的对比度（页面内跑，canvas 取真实像素） */
async function popoverContrast(page: Page): Promise<number> {
  return page.evaluate(() => {
    type RGB = [number, number, number];
    const btn = document.querySelector<HTMLElement>('.selection-pop-btn');
    if (!btn) throw new Error('.selection-pop-btn 不存在');
    const cv = document.createElement('canvas');
    cv.width = 1;
    cv.height = 1;
    const ctx = cv.getContext('2d')!;
    /** 把任意 CSS 颜色画到 1×1 上读回 sRGB；under 非空时先铺底再叠色（合成半透明） */
    const paint = (value: string, under?: RGB): RGB => {
      ctx.fillStyle = '#123456'; // 哨兵：解析失败时 fillStyle 会留在它身上
      ctx.fillStyle = value;
      if (ctx.fillStyle === '#123456') throw new Error(`canvas 无法解析颜色：${value}`);
      if (under) {
        ctx.globalCompositeOperation = 'copy';
        ctx.fillStyle = `rgb(${under[0]}, ${under[1]}, ${under[2]})`;
        ctx.fillRect(0, 0, 1, 1);
        ctx.globalCompositeOperation = 'source-over';
      }
      ctx.fillStyle = value;
      ctx.fillRect(0, 0, 1, 1);
      const d = ctx.getImageData(0, 0, 1, 1).data;
      return [d[0], d[1], d[2]];
    };
    const token = getComputedStyle(document.documentElement).getPropertyValue('--background');
    const backdrop = paint(token); // 浮窗是 fixed 叠在 body 渐变上，用令牌当底
    const cs = getComputedStyle(btn);
    const fg = paint(cs.color, backdrop);
    const bg = paint(cs.backgroundColor, backdrop);
    const lum = ([r, g, b]: RGB): number => {
      const f = (v: number): number => {
        const s = v / 255;
        return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
      };
      return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
    };
    const a = lum(fg);
    const b = lum(bg);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  });
}

async function openWithText(page: Page, sid: string, alias: string, theme: Theme): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [
    { sessionId: sid, projectPath: PROJECT, alias, status: 'idle', lastActiveAt: new Date().toISOString() },
  ]);
  await seedHistory(page, sid, [
    { id: 'm1', role: 'user', content: '注册流程是怎样的', ts: '2026-09-30T01:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: TEXT, ts: '2026-09-30T01:00:05.000Z' },
  ]);
  await page.reload();
  await waitForMock(page);
  await page.evaluate((t) => document.documentElement.setAttribute('data-theme', t), theme);
  await page.locator('.tree-session', { hasText: alias }).first().click();
  await expect(page.locator('.msg-assistant .msg-content p').first()).toBeVisible();
}

/** 在助手正文里真实拖选一段文字（真 mouse 事件，selection 与 mouseup 都是真的） */
async function dragSelect(page: Page): Promise<string> {
  const box = (await page.locator('.msg-assistant .msg-content p').first().boundingBox())!;
  const y = box.y + Math.min(12, box.height / 2); // 首行，避免跨行把选区拉散
  await page.mouse.move(box.x + 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width - 2, y, { steps: 12 });
  await page.mouse.up();
  return page.evaluate(() => window.getSelection()?.toString() ?? '');
}

/** 拖选 → 浮窗三态（常态 / hover / 已复制）对比度守卫 + 剪贴板 + 1.4s 自动收起 */
async function runCopyFlow(page: Page, theme: Theme): Promise<void> {
  const selected = await dragSelect(page);
  expect(selected.length).toBeGreaterThan(0);

  const pop = page.locator('.selection-pop');
  const btn = page.locator('.selection-pop-btn');
  await expect(pop).toHaveClass(/is-visible/);
  await expect(btn).toHaveText('复制文本');

  // 常态：字与底已经分得开
  await settleTransitions(page);
  expect(await popoverContrast(page), `${theme} 常态对比度`).toBeGreaterThanOrEqual(4.5);

  // 鼠标停在按钮上（真实 hover，正是全局 button:hover 打架的那一态）
  await btn.hover();
  await settleTransitions(page);
  expect(await popoverContrast(page), `${theme} hover 对比度`).toBeGreaterThanOrEqual(4.5);

  await btn.click();
  await expect(btn).toHaveText('已复制');
  await settleTransitions(page);
  expect(await popoverContrast(page), `${theme} 已复制态对比度`).toBeGreaterThanOrEqual(4.5);

  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip).toBe(selected);

  // 反馈 1.4s 后收起，选区同时清空
  await expect(pop).not.toHaveClass(/is-visible/, { timeout: 4_000 });
  expect(await page.evaluate(() => window.getSelection()?.toString() ?? '')).toBe('');
}

test('E-SC-001 @P0 @mock-backend：深色主题拖选正文弹出浮窗，hover 与「已复制」态文字都可读，点击写入剪贴板后 1.4s 自动收起', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWithText(page, 'sess-sel-copy-1', '选区复制 深色', 'dark');
  await runCopyFlow(page, 'dark');
  health.assertHealthy();
});

test('E-SC-002 @P1 @mock-backend：浅色主题同样守住对比度（浮窗反色，坏在 hover 上是另一种亮暗倒挂）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWithText(page, 'sess-sel-copy-2', '选区复制 浅色', 'light');
  await runCopyFlow(page, 'light');
  health.assertHealthy();
});

test('E-SC-003 @P1 @mock-backend：非消息区（会话树）选择文字不弹浮窗', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openWithText(page, 'sess-sel-copy-3', '选区复制 边界', 'dark');

  await page.evaluate(() => {
    const el = document.querySelector('.tree-session');
    if (!el) throw new Error('.tree-session 不存在');
    const range = document.createRange();
    range.selectNodeContents(el);
    const sel = window.getSelection()!;
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.mouse.up();
  await expect(page.locator('.selection-pop')).not.toHaveClass(/is-visible/);

  health.assertHealthy();
});
