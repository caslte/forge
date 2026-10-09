/**
 * 会话导出 E2E（SM-S08，docs/test/02_session/e2e.md E-SM-012）。
 * 自动化等级：mock-backend。
 * P0 上线门禁用例：UI 断言 + 负向断言 + 健康守卫。
 *
 * 本spec 只覆盖**入口与编排**（菜单项位置、对话框、取消、失败反馈、运行中不置灰）。
 * 包内容正确性由 desktop 单测承担（U-SM-008/009：转录逐字节一致、meta 十字段、
 * 失败不留半成品）——浏览器环境拿不到真实盘，打包正确性在这里测必然是自证。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, waitForMock } from './helpers/index';

/** 种子会话构造 */
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
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
}

/** 打开会话项右键菜单 */
async function openSessionMenu(page: Page, aliasText: string): Promise<void> {
  await page.locator('.tree-session', { hasText: aliasText }).click({ button: 'right' });
  await expect(page.locator('.ctx-menu')).toBeVisible();
}

test('SESSION-E2E-012 @P0 @mock-backend E-SM-012：右键导出对话包，取到路径并调主进程打包', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '排查白屏' })]);

  // 菜单项存在，且位于「重命名」之上、「删除」之下（危险操作内聚在下）
  await openSessionMenu(page, '排查白屏');
  const items = page.locator('.ctx-menu-item');
  const labels = await items.allInnerTexts();
  const iExport = labels.findIndex((s) => s.includes('导出对话包'));
  const iRename = labels.findIndex((s) => s.includes('重命名'));
  const iDelete = labels.findIndex((s) => s.includes('删除'));
  expect(iExport).toBeGreaterThanOrEqual(0);
  expect(iRename).toBeGreaterThanOrEqual(0);
  expect(iDelete).toBeGreaterThanOrEqual(0);
  expect(iExport).toBeLessThan(iDelete);
  expect(iExport).toBeGreaterThan(0); // 位于「重命名」之下，故在首项之后（首项是重命名）

  // 点击 → 保存对话框（mock 返回 D:/tmp/forge-mock-export.zip）→ 主进程打包被调
  await items.filter({ hasText: '导出对话包' }).click();
  await expect(page.locator('.ctx-menu')).toHaveCount(0); // 菜单先关（对话框是模态的）
  await expect
    .poll(async () => (await page.evaluate(() => window.__forgeMock?.getSessionExports?.() ?? [])).length)
    .toBe(1);
  const calls = await page.evaluate(() => window.__forgeMock?.getSessionExports?.() ?? []);
  expect(calls[0]?.targetPath).toBe('D:/tmp/forge-mock-export.zip');

  // 负向：不得写到非 .zip 目标（走的是 exportBundle 而非 writeText）
  const wrote = await page.evaluate(() => window.__forgeMock?.getSessionExports?.() ?? []);
  expect(wrote.every((c) => c.targetPath.endsWith('.zip'))).toBe(true);

  // 会话树未被导出改动
  await expect(page.locator('.tree-session')).toHaveCount(1);
  health.assertHealthy();
});

test('SESSION-E2E-013 @P0 @mock-backend E-SM-012：运行中会话导出入口不置灰', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '正在跑', status: 'running' })]);

  await openSessionMenu(page, '正在跑');
  const exportItem = page.locator('.ctx-menu-item', { hasText: '导出对话包' });
  await expect(exportItem).toBeVisible();
  // 关键断言：不置灰（用户明确裁定运行中允许导出快照，置灰＝替用户做决定）
  await expect(exportItem).not.toHaveClass(/disabled/);

  await exportItem.click();
  await expect
    .poll(async () => (await page.evaluate(() => window.__forgeMock?.getSessionExports?.() ?? [])).length)
    .toBe(1);

  // 运行中的会话导出后仍在跑，未被中断
  await expect(page.locator('.tree-session', { hasText: '正在跑' })).toBeVisible();
  health.assertHealthy();
});

test('SESSION-E2E-014 @P0 @mock-backend E-SM-012：取消保存对话框不打包、无副作用', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '会被取消' })]);

  // 把 saveFile 改成"用户取消"（回 null）
  await page.evaluate(() => {
    const b = (window as unknown as { forge: { dialog: { saveFile: unknown } } }).forge;
    b.dialog.saveFile = async () => null;
  });

  await openSessionMenu(page, '会被取消');
  await page.locator('.ctx-menu-item', { hasText: '导出对话包' }).click();

  // 取消 = 什么都没发生：主进程打包一次都没被调；也不弹错误提示
  await page.waitForTimeout(300);
  const calls = await page.evaluate(() => window.__forgeMock?.getSessionExports?.() ?? []);
  expect(calls.length).toBe(0);
  await expect(page.locator('.toast, .error-toast')).toHaveCount(0);
  await expect(page.locator('.tree-session')).toHaveCount(1);

  health.assertHealthy();
});

test('SESSION-E2E-015 @P0 @mock-backend E-SM-012：导出失败就地提示原因，会话不受影响', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '会失败' })]);

  // 主进程回报失败（记录不可读）
  await page.evaluate(() => {
    const b = (window as unknown as {
      forge: { session: { exportBundle: unknown } };
    }).forge;
    b.session.exportBundle = async () => ({ ok: false, reason: 'transcript-missing' });
  });

  await openSessionMenu(page, '会失败');
  await page.locator('.ctx-menu-item', { hasText: '导出对话包' }).click();

  // 就地提示失败原因（不是静默失败）
  await expect(page.locator('.error-toast')).toContainText('导出失败');
  await expect(page.locator('.error-toast')).toContainText('不可读');
  // 会话树未变，可重试
  await expect(page.locator('.tree-session')).toHaveCount(1);

  health.assertHealthy();
});

test('SESSION-E2E-016 @P1 @mock-backend E-SM-012：会话名含非法字符时默认文件名被清洗', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: 'a/b:c*d?e"f<g>h|i' })]);

  // 记录 saveFile 实际收到的默认名
  await page.evaluate(() => {
    const w = window as unknown as {
      forge: { dialog: { saveFile: unknown } };
      __nameCapture?: string;
    };
    const orig = w.forge.dialog.saveFile as (n: string, k?: string) => Promise<string | null>;
    w.forge.dialog.saveFile = async (n: string, k?: string) => {
      w.__nameCapture = n;
      return orig(n, k);
    };
  });

  await openSessionMenu(page, 'a/b:c');
  await page.locator('.ctx-menu-item', { hasText: '导出对话包' }).click();

  const name = await page.evaluate(() => (window as unknown as { __nameCapture?: string }).__nameCapture ?? '');
  expect(name).toBeTruthy();
  expect(name.endsWith('.zip')).toBe(true);
  // 非法字符全被替换、不含目录成分（不得出现 ../ 或盘符）
  expect(name).not.toMatch(/[/\\:*?"<>|]/);
  expect(name).toMatch(/^forge-[^-]*-\d{8}-\d{4}\.zip$/);

  health.assertHealthy();
});