/**
 * 全局快捷键 E2E（模块 13，docs/prd/13_keyboard_shortcuts.md §6）。
 * 自动化等级：mock-backend（真实 UI 交互 + 内存 mock，无主进程）。
 *
 * 覆盖：
 * - SC-01：主修饰键组合开合终端面板；平台化 tooltip 文案（Ctrl+` 由 formatCaps 注入，非写死）
 * - SC-02：设置键 toggle 语义（会话视图 → 设置 → 再按回会话）
 * - SC-03：侧栏键折叠/展开往返（与标题栏按钮同一状态）
 * - SC-04：新建会话键退出当前会话；Ctrl+N（未按 Shift）不生效
 * - SC-05：误命中防护——Mac 的 ⌘ 通道在非 Mac 平台不响应；Ctrl+Alt+B 不劫持
 * - SC-06：设置页作用域例外——Ctrl+B / Ctrl+Shift+N 不响应，Ctrl+, 仍可退出
 * - SC-07：快捷键 Tab 渲染 3 组 12 行、滑动块落位贴齐当前 Tab、中英各一遍零重叠（含触发符行）
 *
 * 平台说明：mock-bridge 注入 platform:'browser'，isMacPlatform() 因此回落 navigator
 * （Playwright 本机 Win32）→ 判定走 ctrlKey，用例统一按 Ctrl 组合按键。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, waitForMock } from './helpers/index';

const PROJ = 'D:/work/aiwork/forge';

function mkSession(id: string, alias: string): Record<string, unknown> {
  return {
    sessionId: id,
    projectPath: PROJ,
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 进入应用并落到「已选中一个真实会话」的状态（四个全局键都需要有可见工作区） */
async function bootWithSession(page: Page): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [mkSession('sess-sc-1', '快捷键会话一')]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: '快捷键会话一' }).first().click();
  await expect(page.locator('.tree-session.active')).toHaveCount(1);
}

test('SC-E2E-001 @P0 @mock-backend 主修饰键组合开合终端面板，tooltip 键位平台化注入', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithSession(page);

  // 文案回归：键位不再写死在 i18n 里，由 formatCaps 按平台拼出（此环境 = Ctrl+`）
  await expect(page.locator('.term-toggle')).toHaveAttribute('data-tooltip', '终端 (Ctrl+`)');

  await expect(page.locator('.term.open')).toHaveCount(0);
  await page.keyboard.press('Control+Backquote');
  await expect(page.locator('.term.open')).toBeVisible();
  await page.keyboard.press('Control+Backquote');
  await expect(page.locator('.term.open')).toHaveCount(0);

  health.assertHealthy();
});

test('SC-E2E-002 @P0 @mock-backend 设置键是 toggle：进设置页，再按回会话视图', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithSession(page);

  await page.keyboard.press('Control+,');
  await expect(page.locator('.content.settings-mode')).toBeVisible();
  await expect(page.locator('.settings-stage')).toBeVisible();

  await page.keyboard.press('Control+,');
  await expect(page.locator('.content.settings-mode')).toHaveCount(0);
  await expect(page.locator('.tree-session.active')).toHaveCount(1);

  health.assertHealthy();
});

test('SC-E2E-003 @P0 @mock-backend 侧栏键折叠/展开往返，与标题栏按钮同一状态', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithSession(page);

  await page.keyboard.press('Control+B');
  await expect(page.locator('.app-container.sidebar-collapsed')).toBeVisible();
  await expect(page.locator('.sidebar.collapsed')).toBeVisible();

  await page.keyboard.press('Control+B');
  await expect(page.locator('.app-container.sidebar-collapsed')).toHaveCount(0);

  // 标题栏按钮仍是同一开关：点一下折叠后，快捷键再按应展开（状态不分叉）
  await page.locator('.shell-toggle').click();
  await expect(page.locator('.app-container.sidebar-collapsed')).toBeVisible();
  await page.keyboard.press('Control+B');
  await expect(page.locator('.app-container.sidebar-collapsed')).toHaveCount(0);

  health.assertHealthy();
});

test('SC-E2E-004 @P0 @mock-backend 新建会话键退出当前会话；未按 Shift 的 Ctrl+N 不生效', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithSession(page);

  // 预留键：Ctrl+N 单按不得触发（为将来多窗口让位）
  await page.keyboard.press('Control+N');
  await expect(page.locator('.tree-session.active')).toHaveCount(1);

  await page.keyboard.press('Control+Shift+N');
  await expect(page.locator('.tree-session.active')).toHaveCount(0);
  await expect(page.locator('.compose-input')).toBeVisible();

  health.assertHealthy();
});

test('SC-E2E-005 @P1 @mock-backend 误命中防护：⌘ 通道在非 Mac 不响应，Ctrl+Alt+B 不劫持', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithSession(page);

  await page.keyboard.press('Meta+B');
  await expect(page.locator('.app-container.sidebar-collapsed')).toHaveCount(0);
  await page.keyboard.press('Meta+,');
  await expect(page.locator('.content.settings-mode')).toHaveCount(0);
  await page.keyboard.press('Meta+Shift+N');
  await expect(page.locator('.tree-session.active')).toHaveCount(1);

  await page.keyboard.press('Control+Alt+B');
  await expect(page.locator('.app-container.sidebar-collapsed')).toHaveCount(0);

  // 裸键必须原样进输入框，不被全局键吃掉
  await page.locator('.compose-input').click();
  await page.locator('.compose-input').fill('b,n,` 三个裸键都应留下');
  await page.locator('.compose-input').press('End');
  await page.keyboard.type(',');
  await expect(page.locator('.compose-input')).toHaveValue('b,n,` 三个裸键都应留下,');

  health.assertHealthy();
});

test('SC-E2E-006 @P0 @mock-backend 设置页作用域例外：侧栏键与新建会话键不响应，设置键可退出', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithSession(page);

  await page.keyboard.press('Control+,');
  await expect(page.locator('.content.settings-mode')).toBeVisible();

  await page.keyboard.press('Control+B');
  await expect(page.locator('.app-container.sidebar-collapsed')).toHaveCount(0);
  await page.keyboard.press('Control+Shift+N');
  await expect(page.locator('.content.settings-mode')).toBeVisible();

  // 终端键不受作用域限制：状态照旧翻转（面板在设置视图是 v-show 隐藏，故不可见但 .open 已置位）
  await page.keyboard.press('Control+Backquote');
  await expect(page.locator('.term.open')).toHaveCount(1);
  await expect(page.locator('.term.open')).not.toBeVisible();
  await page.keyboard.press('Control+Backquote');
  await expect(page.locator('.term.open')).toHaveCount(0);

  await page.keyboard.press('Control+,');
  await expect(page.locator('.content.settings-mode')).toHaveCount(0);
  await expect(page.locator('.tree-session.active')).toHaveCount(1);

  health.assertHealthy();
});

test('SC-E2E-007 @P0 @mock-backend 快捷键 Tab：3 组 12 行、滑动块落位贴齐、中英零重叠', async ({ page }) => {
  const health = attachHealthGuards(page);
  await bootWithSession(page);

  await page.keyboard.press('Control+,');
  await expect(page.locator('.settings-stage')).toBeVisible();

  // Tab 顺序：通用 / 个性化 / Skills / 快捷键 / 关于
  const tabs = page.locator('.settings-tab');
  await expect(tabs).toHaveCount(5);
  await expect(tabs.nth(3)).toHaveText('快捷键');

  await tabs.nth(3).click();
  await expect(page.locator('.shortcuts-body')).toBeVisible();
  await expect(page.locator('.sc-group')).toHaveCount(3);
  await expect(page.locator('.sc-card .pref-row')).toHaveCount(12);

  // 滑动选中块必须跟到新 Tab。thumb 走的是水滴时序（左右两边错峰启停，途中宽度会过 0），
  // 所以不能点完立刻量，要等落定后比对它是否贴住当前 Tab 的位置与宽度
  const thumbDelta = (): Promise<number> =>
    page.evaluate(() => {
      const t = document.querySelector('.settings-thumb')?.getBoundingClientRect();
      const a = document.querySelector('.settings-tab.active')?.getBoundingClientRect();
      if (!t || !a) return Number.POSITIVE_INFINITY;
      return Math.max(Math.abs(t.left - a.left), Math.abs(t.width - a.width));
    });
  await expect.poll(thumbDelta, { timeout: 4_000 }).toBeLessThanOrEqual(1);
  const thumb = await page.locator('.settings-thumb').boundingBox();
  expect(thumb?.width ?? 0).toBeGreaterThan(0);

  // 清单口径回归：@ 与 / 是触发符（.sc-sym）；「本版新增」徽标与占位行都已按用户要求删掉
  await expect(page.locator('.sc-sym')).toHaveCount(2);
  await expect(page.locator('.sc-none')).toHaveCount(0);
  await expect(page.locator('.sc-badge')).toHaveCount(0);
  await expect(page.locator('.sc-group .section-title')).toHaveText(['全局快捷键', '输入与发送', '打断与关闭']);
  await expect(page.locator('.sc-times')).toHaveText('×2');

  // 卡片边框口径：外框只画一次，行内仅「行与行之间」有一条分割线（行自身不留边框，否则与卡片外框叠成双线）。
  // 扁平 12 行中，各组首行（3 组分别 3/5/4 行 → 下标 0、3、8）四边皆无框，其余行只有 1px 上沿分割线。
  const borders = await page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.sc-card .pref-row')).map((row) => {
      const s = getComputedStyle(row);
      return `${s.borderTopWidth}/${s.borderRightWidth}/${s.borderBottomWidth}/${s.borderLeftWidth}`;
    })
  );
  expect(borders).toEqual(
    Array.from({ length: 12 }, (_, i) => (i === 0 || i === 3 || i === 8 ? '0px/0px/0px/0px' : '1px/0px/0px/0px'))
  );

  /** 逐行量几何：标题右沿与键帽区左沿留 ≥12px，且键帽不溢出卡片 */
  const measure = async (): Promise<{ minGap: number; overflow: number }> => {
    return page.evaluate(() => {
      let minGap = Number.POSITIVE_INFINITY;
      let overflow = 0;
      for (const row of Array.from(document.querySelectorAll('.sc-card .pref-row'))) {
        const title = row.querySelector<HTMLElement>('.pref-title');
        const keys = row.querySelector<HTMLElement>('.sc-keys');
        const card = row.closest<HTMLElement>('.sc-card');
        if (!title || !keys || !card) continue;
        minGap = Math.min(minGap, keys.getBoundingClientRect().left - title.getBoundingClientRect().right);
        const cardRight = card.getBoundingClientRect().right;
        for (const cap of Array.from(row.querySelectorAll<HTMLElement>('.sc-kbd, .sc-sym'))) {
          overflow = Math.max(overflow, cap.getBoundingClientRect().right - cardRight);
        }
      }
      return { minGap, overflow };
    });
  };

  const zh = await measure();
  expect(zh.minGap).toBeGreaterThanOrEqual(12);
  expect(zh.overflow).toBeLessThanOrEqual(0);

  // 英文重排后复查（模块 08 口径：字宽敏感控件中英双查）
  await page.evaluate(() => window.localStorage.setItem('forge.locale', 'en'));
  await page.reload();
  await waitForMock(page);
  await page.locator('.sidebar-link', { hasText: 'Settings' }).click();
  await page.locator('.settings-tab', { hasText: 'Shortcuts' }).click();
  await expect(page.locator('.shortcuts-body')).toBeVisible();
  await expect(page.locator('.sc-card .pref-row')).toHaveCount(12);

  const en = await measure();
  expect(en.minGap).toBeGreaterThanOrEqual(12);
  expect(en.overflow).toBeLessThanOrEqual(0);

  health.assertHealthy();
});
