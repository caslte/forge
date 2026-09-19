/**
 * 上下文压缩 E2E（P3-A）。
 *
 * - 手动压缩：点击「压缩」按钮 → 全局 toast 反馈（同切换模型款式，含 token 变化
 *   与减少百分比）+ 对话流底部持久横幅（压缩中 → 已压缩，App 关闭前保持）；
 *   压缩失败显示失败原因；全程无 pageerror（dev 预览走 mock-bridge）；
 * - 流式保护：streaming 期间压缩按钮禁用，避免静默截断正在生成的回答；
 * - 自动压缩：mock 发射 conversation.compacting/compacted → 输入锁定/解锁、
 *   重拉历史并显示持久横幅（自动压缩没有 RPC 入口，事件是 UI 感知它的唯一通道）；
 * - 压缩后百分比：压缩完成即显示压缩后的上下文占用百分比（不再"? tokens"）。
 *
 * 自动化等级：mock-backend（window.__forgeMock 种子 + emit 受控事件）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSessions } from './helpers/index';

const SESSION_ID = 'sess-compact';

function mkSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    projectPath: 'D:/work/aiwork/forge',
    alias: '压缩测试会话',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
    ...over,
  };
}

/** 进入应用：注入单个会话并选中它，等压缩入口就绪 */
async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.ctx-cmp')).toHaveCount(1);
}

/**
 * 触发手动压缩：「压缩」按钮当前暂时隐藏（display:none，低使用率），
 * 逻辑保留，故用程序化 click 直接驱动处理器。
 */
async function clickCompact(page: Page): Promise<void> {
  await page.locator('.ctx-cmp').evaluate((el) => (el as HTMLElement).click());
}

test('手动压缩：mock 默认实现可用（点击不报错），toast + 持久横幅反馈', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  // 不注入 seed：走 mock-bridge 的 conversation/compact 默认实现
  // （曾缺失该分支落到 default 返回 data:null，UI 侧对 null 取值抛 TypeError）
  await clickCompact(page);

  // toast（同切换模型的浮窗款式）：mock 默认 4200 → 1680（减少 60%）
  await expect(page.locator('.toast')).toContainText('压缩完成');
  // 持久横幅：完成后常驻（不自动消失）
  await expect(page.locator('.compact-banner')).toContainText('已压缩');
  await expect(page.locator('.compact-banner')).toContainText('60%');
  guard.assertHealthy();
});

test('手动压缩成功：toast 显示 token 变化与减少百分比', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('conversation/compact', () => ({
      code: 0,
      message: 'ok',
      data: { result: { ok: true, tokensBefore: 90000, tokensAfter: 12000, summary: '摘要' } },
    }));
  });

  await clickCompact(page);

  await expect(page.locator('.toast')).toContainText('压缩完成');
  await expect(page.locator('.toast')).toContainText('12000');
  await expect(page.locator('.toast')).toContainText('87%');
  guard.assertHealthy();
});

test('手动压缩失败：toast 显示失败原因，横幅回退清除，不静默', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('conversation/compact', () => ({
      code: 0,
      message: 'ok',
      data: { result: { ok: false, message: 'Nothing to compact (session too small)' } },
    }));
  });

  await clickCompact(page);

  await expect(page.locator('.toast')).toContainText('Nothing to compact');
  await expect(page.locator('.toast')).toHaveClass(/error/);
  await expect(page.locator('.compact-banner')).toHaveCount(0);
  guard.assertHealthy();
});

test('流式回答期间压缩按钮禁用（避免静默截断当前轮）', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'streaming' });
  }, SESSION_ID);

  await expect(page.locator('.ctx-cmp')).toHaveClass(/disabled/);
  guard.assertHealthy();
});

test('自动压缩：compacting 锁定输入并显示横幅，compacted 后重拉历史并保持完成横幅', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate(() => {
    (window as unknown as { __qh: number }).__qh = 0;
    window.__forgeMock!.seed('conversation/queryHistory', () => {
      (window as unknown as { __qh: number }).__qh += 1;
      return null; // 走默认历史
    });
  });

  // 压缩中：输入禁用 + 压缩中横幅
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.compacting', { reason: 'auto' });
  }, SESSION_ID);
  await expect(page.locator('.compact-banner.working')).toContainText('正在压缩上下文');
  await expect(page.locator('.compose-input')).toBeDisabled();

  // 压缩完成：横幅替换为已完成（含减少百分比），输入解锁，历史重拉
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.compacted', {
      reason: 'auto',
      tokensBefore: 88000,
      tokensAfter: 9000,
      summary: '自动压缩摘要',
    });
  }, SESSION_ID);

  await expect(page.locator('.compact-banner')).toContainText('已压缩');
  await expect(page.locator('.compact-banner')).toContainText('90%');
  await expect(page.locator('.compact-banner')).not.toHaveClass(/working/);
  await expect(page.locator('.compose-input')).toBeEnabled();
  const calls = await page.evaluate(() => (window as unknown as { __qh: number }).__qh);
  expect(calls, '自动压缩后应重新拉取会话历史').toBeGreaterThan(0);
  guard.assertHealthy();
});

test('压缩后百分比：压缩完成即显示压缩后的上下文占用（非"? tokens"）', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  // 压缩前 mock 默认 4200/128000 = 3.3%
  await expect(page.locator('.ctx-num')).toHaveText('3.3%');

  await clickCompact(page);

  // 压缩后 1680/128000 = 1.3%（mock 压到 40%）；不得退化为 "? tokens"
  await expect(page.locator('.ctx-num')).toHaveText('1.3%');
  guard.assertHealthy();
});
