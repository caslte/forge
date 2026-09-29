/**
 * 消息正文代码块复制按钮 E2E（mock-backend）。
 *
 * 单测只能证明「围栏变成带按钮的 HTML」，证明不了三件真机才看得出的事：
 * - 按钮真的贴在代码块右上角，且 hover 才浮现（不常驻抢视线）；
 * - 按钮没有把代码顶出多余首行（pre 里多一个空白就是空行）；
 * - 点一下剪贴板里真的是围栏原文（含多行缩进），并留下勾选回执。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedHistory, seedSessions, waitForMock } from './helpers/index';

const PROJECT = 'D:/work/aiwork/forge';

const CODE = ['for f in *.tar; do', '  [ -f "$f" ] && docker load -i "$f"', 'done'].join('\n');

async function openWithCode(page: Page, sid: string, alias: string): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [
    { sessionId: sid, projectPath: PROJECT, alias, status: 'idle', lastActiveAt: new Date().toISOString() },
  ]);
  await seedHistory(page, sid, [
    { id: 'm1', role: 'user', content: '怎么批量加载镜像包', ts: '2026-09-28T01:00:00.000Z' },
    {
      id: 'm2',
      role: 'assistant',
      content: `命令已给出：\n\n\`\`\`bash\n${CODE}\n\`\`\`\n\n如果包是 .tar.gz，把 *.tar 换掉即可。`,
      ts: '2026-09-28T01:00:05.000Z',
    },
  ]);
  await page.reload();
  await waitForMock(page);
  await page.locator('.tree-session', { hasText: alias }).first().click();
}

test('E-CC-001 @P0 @mock-backend：按钮贴在代码块右上角，hover 才浮现，点击写入剪贴板并留勾选回执', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await openWithCode(page, 'sess-code-copy-1', '代码块复制');

  const wrap = page.locator('.msg-assistant .md-code-wrap').first();
  const btn = wrap.locator('.md-code-copy');
  await expect(btn).toHaveCount(1);

  // 常态隐藏（不常驻抢视线），hover 代码块才浮现
  await expect(btn).toHaveCSS('opacity', '0');
  await wrap.hover();
  await expect(btn).toHaveCSS('opacity', '1');

  // 几何：按钮贴在代码块右上角内侧（各留 6px）
  const [box, btnBox] = await Promise.all([wrap.boundingBox(), btn.boundingBox()]);
  expect(box && btnBox).toBeTruthy();
  const rightInset = box!.x + box!.width - (btnBox!.x + btnBox!.width);
  const topInset = btnBox!.y - box!.y;
  expect(rightInset).toBeGreaterThanOrEqual(4);
  expect(rightInset).toBeLessThanOrEqual(10);
  expect(topInset).toBeGreaterThanOrEqual(4);
  expect(topInset).toBeLessThanOrEqual(10);

  // 块高必须正好等于「行数 × 行高 + 内边距 + 边框」：pre 里多一个空白就多一行
  const extraRows = await wrap.evaluate((el) => {
    const pre = el.querySelector('pre')!;
    const cs = getComputedStyle(pre);
    const lineH = parseFloat(cs.lineHeight);
    const rows = (pre.textContent ?? '').split('\n').length;
    const expected = rows * lineH + parseFloat(cs.paddingTop) + parseFloat(cs.paddingBottom)
      + parseFloat(cs.borderTopWidth) + parseFloat(cs.borderBottomWidth);
    return (pre.getBoundingClientRect().height - expected) / lineH;
  });
  expect(Math.abs(extraRows)).toBeLessThan(0.5);

  await btn.click();
  await expect(btn).toHaveClass(/is-copied/);
  // Chromium 在 Windows 上写剪贴板会把 \n 归一成 \r\n（OS 行为，非本功能），比对前折回
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  expect(clip.replace(/\r\n/g, '\n')).toBe(CODE);

  // 回执是暂时的：1.4s 后回到常态（按钮仍在，可再次复制）
  await page.waitForTimeout(1600);
  await expect(btn).not.toHaveClass(/is-copied/);

  health.assertHealthy();
});

test('E-CC-002 @P1 @mock-backend：tooltip 跟随语言（复制代码 / Copy code）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await openWithCode(page, 'sess-code-copy-2', '代码块复制 i18n');
  const btn = page.locator('.msg-assistant .md-code-copy').first();
  await expect(btn).toHaveAttribute('data-tooltip', '复制代码');

  await page.evaluate(() => window.localStorage.setItem('forge.locale', 'en'));
  await page.reload();
  await waitForMock(page);
  await page.locator('.tree-session', { hasText: '代码块复制 i18n' }).first().click();
  await expect(page.locator('.msg-assistant .md-code-copy').first()).toHaveAttribute('data-tooltip', 'Copy code');

  health.assertHealthy();
});
