/**
 * 应用自更新 E2E（IN-S03，docs/test/07_pi/e2e.md E-IN-001~004）。
 * mock-backend：seed updater/* + emit updater.stateChanged；不触真实 feed。
 * 明面只有 forge 产品更新语义；断言全程不出现「组件/插件」字样的自更新文案。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

declare global {
  interface Window {
    __upInstallCalled?: boolean;
  }
}

async function openAboutTab(page: Page): Promise<void> {
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '关于' }).click();
}

// 注意：seed 处理器运行在页面上下文，快照对象必须内联字面量（不能引用本模块常量）
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('pi/getInfo', () => ({
      code: 0,
      message: 'ok',
      data: { forgeVersion: '0.1.0' },
    }));
  });
});

// E-IN-001（AC-IN-008）：发现新版 → toast 一次 + 分区常驻；无新版无提示
test('E-IN-001 @P0 发现新版本：toast 一次 + 分区常驻「更新」按钮', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('updater/getState', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 0, message: 'ok',
      data: { status: 'found', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: null, error: null },
    }));
  });
  await openAboutTab(page);

  // 常驻：版本行内「0.1.0 → 0.2.0」+ 更新按钮
  await expect(page.locator('.version-row .version-next')).toHaveText('0.2.0');
  await expect(page.locator('.up-btn')).toHaveText(/更新/);
  // toast 提示一次
  await expect(page.locator('.toast .toast-message').filter({ hasText: '发现新版本' })).toHaveCount(1);

  // 重开设置面板：同版本不再重复 toast
  await page.locator('.settings-close').click();
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '关于' }).click();
  await expect(page.locator('.version-row .version-next')).toHaveText('0.2.0');
  await expect(page.locator('.toast .toast-message').filter({ hasText: '发现新版本' })).toHaveCount(0);

  // 全程无「组件/插件」自更新文案（明面只有 forge 产品更新）
  await expect(page.locator('.update-section')).not.toContainText(/组件|插件/);
  health.assertHealthy();
});

// E-IN-002（AC-IN-009 UI 部分）：检查→发现新版→下载进度→重启安装→确认弹窗→quitAndInstall 调用
test('E-IN-002 @P0 下载进度→重启安装→确认弹窗→捕获 quitAndInstall 调用', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__upInstallCalled = false;
    window.__forgeMock!.seed('updater/getState', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 0, message: 'ok',
      data: { status: 'found', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: null, error: null },
    }));
    window.__forgeMock!.seed('updater/downloadUpdate', () => ({
      code: 0, message: 'ok',
      data: { status: 'downloading', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: 0, error: null },
    }));
    window.__forgeMock!.seed('updater/quitAndInstall', () => {
      window.__upInstallCalled = true;
      return { code: 0, message: 'ok', data: null };
    });
  });
  await openAboutTab(page);

  // 进入关于 Tab 自动检查 → 发现新版（版本行内「0.1.0 → 0.2.0」）
  await expect(page.locator('.version-row .version-next')).toHaveText('0.2.0');

  // 点「更新」→ 下载中（按钮 busy，进度走进度条；mock emit 首参为 sessionId，无会话事件传 ''）
  await page.locator('.up-btn').click();
  await expect(page.locator('.up-btn')).toHaveText('更新');
  await expect(page.locator('.up-btn')).toBeDisabled();
  await expect(page.locator('.up-progress')).toBeVisible();
  await page.evaluate(() => {
    window.__forgeMock!.emit('', 'updater.stateChanged', {
      status: 'downloading', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: 60, error: null,
    });
  });
  await expect(page.locator('.up-progress-meta b')).toHaveText('60%');
  await page.evaluate(() => {
    window.__forgeMock!.emit('', 'updater.stateChanged', {
      status: 'downloaded', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: 100, error: null,
    });
  });

  // downloaded → 「重启安装」→ 确认弹窗 → 取消停留 → 再确认 → 调用 quitAndInstall
  await expect(page.locator('.up-progress')).toHaveCount(0);
  await expect(page.locator('.up-btn')).toHaveText('重启安装');
  await page.locator('.up-btn').click();
  await expect(page.locator('.up-confirm-title')).toContainText('安装 forge 0.2.0');
  await expect(page.locator('.up-confirm-desc')).toContainText('自动重启');
  await page.locator('.up-confirm-actions').getByText('取消').click();
  await expect(page.locator('.up-confirm')).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { __upInstallCalled: boolean }).__upInstallCalled)).toBe(false);
  await page.locator('.up-btn').click();
  await page.locator('.up-confirm-actions').getByText('确认安装').click();
  await page.waitForFunction(() => (window as unknown as { __upInstallCalled: boolean }).__upInstallCalled === true);
  health.assertHealthy();
});

// E-IN-003（AC-IN-011）：检查失败（6003）静默——无 toast、无打断弹窗
test('E-IN-003 @P0 检查失败静默：无提示可重试', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('updater/getState', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 6003, message: '应用更新检查失败', data: null,
    }));
  });
  await openAboutTab(page);
  await expect(page.locator('.toast .toast-message')).toHaveCount(0);
  await expect(page.locator('.up-confirm')).toHaveCount(0);
  await expect(page.locator('.up-btn')).toBeEnabled();
  health.assertHealthy();
});

// E-IN-004（AC-IN-008 反向 + AC-IN-004/012 后台预装/联动无 UI 反向，对齐冻结 e2e.md E-IN-004）
// 无新版 → 无提示、无「更新」按钮；后台更新（预装/联动）对用户不可见——全程无 toast、自更新行无「组件/插件」字样
test('E-IN-004 @P1 无新版/后台更新：无提示、无组件插件字样', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('updater/getState', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
  });
  await openAboutTab(page);
  // 无新版反向（AC-IN-008）：无 toast、无「发现新版本」、无「更新」按钮；
  // 检查完成显示「✓ 已是最新」徽标，按钮仍保留「检查更新」可再查
  await expect(page.locator('.toast .toast-message')).toHaveCount(0);
  await expect(page.locator('.version-row .version-next')).toHaveCount(0);
  await expect(page.locator('.up-uptodate')).toHaveText('已是最新');
  await expect(page.locator('.up-btn')).toHaveText(/检查更新/);
  // 后台预装/联动全程无 UI（AC-IN-004/012 反向，mock 端主进程编排不可达，渲染侧可观测面=无提示）：
  // 无确认弹窗、版本更新分区全程无「组件/插件」字样（明面只有 forge 产品更新语义，无组件更新入口）
  await expect(page.locator('.up-confirm')).toHaveCount(0);
  await expect(page.locator('.update-section')).not.toContainText(/组件|插件/);
  health.assertHealthy();
});

// E-IN-005：调试控制台（本地配置文件开启后可见）——记录状态迁移与失败原因，排查更新链路
test('E-IN-005 @P2 调试控制台：配置开启后展开可见并记录 6003 失败原因', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('app/getUpdateDebug', () => ({
      code: 0, message: 'ok', data: { enabled: true },
    }));
    window.__forgeMock!.seed('updater/getState', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 6003, message: '更新源未配置', data: null,
    }));
  });
  await openAboutTab(page);
  // 配置开启：调试区可见但控制台默认收起；展开后含版本/快照信息与失败原因（6003 静默但有日志可查）
  await expect(page.locator('.up-debug')).toBeVisible();
  await expect(page.locator('.up-debug-console')).toHaveCount(0);
  await page.locator('.up-debug-toggle').click();
  await expect(page.locator('.up-debug-console')).toBeVisible();
  await expect(page.locator('.up-debug-ver')).toContainText('当前 0.1.0');
  await expect(page.locator('.up-debug-ver')).toContainText('快照 idle');
  await expect(page.locator('.up-debug-scroll')).toContainText('更新源未配置');
  await expect(page.locator('.up-debug-scroll')).toContainText('checkForUpdates');
  health.assertHealthy();
});

// E-IN-006：调试控制台默认不可见（未配置 updater-debug.json → enabled=false，普通用户无调试入口）
test('E-IN-006 @P2 调试控制台：默认隐藏（普通用户不可见）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('app/getUpdateDebug', () => ({
      code: 0, message: 'ok', data: { enabled: false },
    }));
    window.__forgeMock!.seed('updater/getState', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
  });
  await openAboutTab(page);
  await expect(page.locator('.up-debug')).toHaveCount(0);
  await expect(page.locator('.up-debug-toggle')).toHaveCount(0);
  health.assertHealthy();
});
