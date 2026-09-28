/**
 * 应用自更新 E2E（IN-S03，07 改造后口径）。
 * mock-backend：seed updater/* + emit updater.stateChanged；不触真实 feed。
 * 新口径：发现新版不再弹 toast，提示由侧栏图标入口（UpdateEntry）承担；
 * 进入关于 Tab 不再自动检查，检查仅由「检查更新」按钮手动触发；
 * 关于页为同一全局状态的镜像。明面只有 forge 产品更新语义，
 * 断言全程不出现「组件/插件」字样的自更新文案。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

declare global {
  interface Window {
    __upInstallCalled?: boolean;
    /** 模拟主进程状态机持久快照：getState 读它、check 写它（设置面板重挂载不丢态） */
    __forgeUpSnap?: {
      status: string;
      currentVersion: string;
      latestVersion: string | null;
      downloadProgress: number | null;
      error: string | null;
    };
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
    // 默认态：idle（无已知更新），侧栏入口不出现；getState 读持久快照（同主进程语义）
    window.__forgeUpSnap = {
      status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null,
    };
    window.__forgeMock!.seed('updater/getState', () => ({
      code: 0, message: 'ok', data: window.__forgeUpSnap,
    }));
  });
});

// E-IN-001（改造后 AC-IN-008）：手动检查发现新版 → 侧栏图标入口出现（hover 展开「新版本」）
// + 关于页镜像；全程零 toast；重开设置不重复提示
test('E-IN-001 @P0 发现新版：侧栏图标入口 + 关于页镜像，无 toast', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('updater/checkForUpdates', () => {
      const found = {
        status: 'found', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: null, error: null,
      };
      window.__forgeUpSnap = found;
      return { code: 0, message: 'ok', data: found };
    });
  });
  await openAboutTab(page);

  // 进入关于页不再自动检查：未点按钮前侧栏零变化、无版本提示
  await expect(page.locator('.up-entry')).toHaveCount(0);
  await expect(page.locator('.version-row .version-next')).toHaveCount(0);

  // 手动「检查更新」→ 侧栏入口出现（found 态方块下载图标）+ 关于页镜像
  await page.locator('.up-btn').click();
  await expect(page.locator('.up-entry')).toHaveCount(1);
  await expect(page.locator('.up-entry')).toHaveAttribute('data-mode', 'found');
  await expect(page.locator('.version-row .version-next')).toHaveText('v0.2.0');
  await expect(page.locator('.up-btn')).toHaveText(/更新/);
  // 不再弹 toast（提示职责已移交侧栏图标）
  await expect(page.locator('.toast .toast-message')).toHaveCount(0);

  // hover 动画展开「新版本」文字，移开后收起（默认纯图标）
  await expect(page.locator('.up-entry .up-txt')).toBeHidden();
  await page.locator('.up-entry').hover();
  await expect(page.locator('.up-entry .up-txt')).toBeVisible();
  await expect(page.locator('.up-entry .up-txt')).toHaveText('新版本');
  await page.mouse.move(10, 10);
  await expect(page.locator('.up-entry .up-txt')).toBeHidden();

  // 重开设置：全局状态镜像保持，且无任何重复提示
  await page.locator('.settings-close').click();
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '关于' }).click();
  await expect(page.locator('.version-row .version-next')).toHaveText('v0.2.0');
  await expect(page.locator('.up-entry')).toHaveCount(1);
  await expect(page.locator('.toast .toast-message')).toHaveCount(0);

  // 全程无「组件/插件」自更新文案（明面只有 forge 产品更新）
  await expect(page.locator('.update-section')).not.toContainText(/组件|插件/);
  health.assertHealthy();
});

// E-IN-002（改造后 AC-IN-009 UI 部分）：检查→发现→下载（侧栏进度环）→就绪
// →关于页确认弹窗取消 →侧栏入口确认弹窗→quitAndInstall 调用捕获
test('E-IN-002 @P0 下载进度→侧栏就绪→确认弹窗→捕获 quitAndInstall 调用', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__upInstallCalled = false;
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
  await page.locator('.up-btn').click();
  await expect(page.locator('.up-entry')).toHaveAttribute('data-mode', 'found');

  // 关于页点「更新」→ 下载中：进度条 + 侧栏切为进度环（无文字、禁用）
  await page.locator('.up-btn').click();
  await expect(page.locator('.up-btn')).toHaveText('更新');
  await expect(page.locator('.up-btn')).toBeDisabled();
  await expect(page.locator('.up-progress')).toBeVisible();
  await expect(page.locator('.up-entry')).toHaveAttribute('data-mode', 'downloading');
  await expect(page.locator('.up-entry')).toBeDisabled();
  await page.evaluate(() => {
    window.__forgeMock!.emit('', 'updater.stateChanged', {
      status: 'downloading', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: 60, error: null,
    });
  });
  await expect(page.locator('.up-progress-meta b')).toHaveText('60%');
  // 环即进度：60% → dashoffset ≈ 62.83 × 0.4（不再显示百分比文字于侧栏）
  await expect(page.locator('.up-entry .up-ico-ring circle').nth(1))
    .toHaveAttribute('stroke-dashoffset', /25\.13/);
  await expect(page.locator('.up-entry .up-txt')).toHaveCount(0);
  await page.evaluate(() => {
    window.__forgeMock!.emit('', 'updater.stateChanged', {
      status: 'downloaded', currentVersion: '0.1.0', latestVersion: '0.2.0', downloadProgress: 100, error: null,
    });
  });

  // 就绪：关于页「重启安装」+ 侧栏切圆底环形箭头（hover 展开「更新」）
  await expect(page.locator('.up-progress')).toHaveCount(0);
  await expect(page.locator('.up-btn')).toHaveText('重启安装');
  await expect(page.locator('.up-entry')).toHaveAttribute('data-mode', 'ready');
  await expect(page.locator('.up-entry')).toBeEnabled();
  await page.locator('.up-entry').hover();
  await expect(page.locator('.up-entry .up-txt')).toHaveText('更新');

  // 关于页确认弹窗：弹出 → 取消（不触发安装）
  await page.mouse.move(10, 10);
  await page.locator('.up-btn').click();
  await expect(page.locator('.up-confirm-title')).toContainText('安装 Forge 0.2.0');
  await expect(page.locator('.up-confirm-desc')).toContainText('自动重启');
  await page.locator('.up-confirm-actions').getByText('取消').click();
  await expect(page.locator('.up-confirm')).toHaveCount(0);
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as unknown as { __upInstallCalled: boolean }).__upInstallCalled)).toBe(false);

  // 侧栏入口确认弹窗：点击 ready 图标 → 独立确认框 → 确认安装 → quitAndInstall 被调
  await page.locator('.up-entry').click();
  await expect(page.locator('.up-entry-confirm .uec-title')).toContainText('安装 Forge 0.2.0');
  await page.locator('.uec-actions').getByText('确认安装').click();
  await expect(page.locator('.up-entry-confirm')).toHaveCount(0);
  await page.waitForFunction(() => (window as unknown as { __upInstallCalled: boolean }).__upInstallCalled === true);
  health.assertHealthy();
});

// E-IN-003（AC-IN-011）：检查失败（6003）静默——无 toast、无侧栏入口、可重试
test('E-IN-003 @P0 检查失败静默：无提示可重试', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 6003, message: '应用更新检查失败', data: null,
    }));
  });
  await openAboutTab(page);
  await page.locator('.up-btn').click();
  await expect(page.locator('.toast .toast-message')).toHaveCount(0);
  await expect(page.locator('.up-confirm')).toHaveCount(0);
  await expect(page.locator('.up-entry')).toHaveCount(0);
  await expect(page.locator('.up-btn')).toBeEnabled();
  health.assertHealthy();
});

// E-IN-004（AC-IN-008 反向 + AC-IN-004/012 后台预装/联动无 UI 反向）
// 手动检查无新版 → 「✓ 已是最新」徽标、侧栏无入口、全程无 toast；后台更新对用户不可见
test('E-IN-004 @P1 无新版/后台更新：无提示、无组件插件字样', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 0, message: 'ok',
      data: { status: 'idle', currentVersion: '0.1.0', latestVersion: null, downloadProgress: null, error: null },
    }));
  });
  await openAboutTab(page);
  // 未检查前无「已是最新」徽标（不再自动检查）
  await expect(page.locator('.up-uptodate')).toHaveCount(0);
  await page.locator('.up-btn').click();
  // 无新版反向（AC-IN-008）：无 toast、无「发现新版本」、侧栏无入口；
  // 检查完成显示「✓ 已是最新」徽标，按钮保留「检查更新」可再查
  await expect(page.locator('.toast .toast-message')).toHaveCount(0);
  await expect(page.locator('.version-row .version-next')).toHaveCount(0);
  await expect(page.locator('.up-uptodate')).toHaveText('已是最新');
  await expect(page.locator('.up-btn')).toHaveText(/检查更新/);
  await expect(page.locator('.up-entry')).toHaveCount(0);
  // 后台预装/联动全程无 UI（AC-IN-004/012 反向）：无确认弹窗、无「组件/插件」字样
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
    window.__forgeMock!.seed('updater/checkForUpdates', () => ({
      code: 6003, message: '更新源未配置', data: null,
    }));
  });
  await openAboutTab(page);
  // 不再自动检查：先手动点一次「检查更新」制造 6003 失败日志
  await page.locator('.up-btn').click();
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
  });
  await openAboutTab(page);
  await expect(page.locator('.up-debug')).toHaveCount(0);
  await expect(page.locator('.up-debug-toggle')).toHaveCount(0);
  health.assertHealthy();
});
