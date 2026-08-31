/**
 * 上下文压缩 E2E（P3-A）。
 *
 * - 手动压缩：点击「压缩」按钮 → 显示压缩结果（含 token 变化）；压缩失败显示失败
 *   原因；全程无 pageerror（dev 预览走 mock-bridge，曾因缺失该方法而抛 TypeError）；
 * - 流式保护：streaming 期间压缩按钮禁用，避免静默截断正在生成的回答；
 * - 自动压缩：mock 发射 conversation.compacted → UI 重拉历史并提示（自动压缩没有
 *   RPC 入口，事件是 UI 感知它的唯一通道）。
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

/** 进入应用：注入单个会话并选中它，等压缩按钮就绪 */
async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.ctx-cmp')).toBeVisible();
}

test('手动压缩：mock 默认实现可用（点击不报错）并显示压缩结果', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  // 不注入 seed：走 mock-bridge 的 conversation/compact 默认实现
  // （曾缺失该分支落到 default 返回 data:null，UI 侧对 null 取值抛 TypeError）
  await page.locator('.ctx-cmp').click();

  await expect(page.locator('.compact-result')).toContainText('压缩完成');
  guard.assertHealthy();
});

test('手动压缩成功：显示压缩详情（压缩前后 token）', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('conversation/compact', () => ({
      code: 0,
      message: 'ok',
      data: { result: { ok: true, tokensBefore: 90000, tokensAfter: 12000, summary: '摘要' } },
    }));
  });

  await page.locator('.ctx-cmp').click();

  await expect(page.locator('.compact-result')).toContainText('压缩完成');
  await expect(page.locator('.compact-result')).toContainText('12000');
  guard.assertHealthy();
});

test('手动压缩失败：显示失败原因，不静默', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate(() => {
    window.__forgeMock!.seed('conversation/compact', () => ({
      code: 0,
      message: 'ok',
      data: { result: { ok: false, message: 'Nothing to compact (session too small)' } },
    }));
  });

  await page.locator('.ctx-cmp').click();

  await expect(page.locator('.compact-result')).toContainText('Nothing to compact');
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

test('自动压缩：收到 conversation.compacted 后重拉历史并提示', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate(() => {
    (window as unknown as { __qh: number }).__qh = 0;
    window.__forgeMock!.seed('conversation/queryHistory', () => {
      (window as unknown as { __qh: number }).__qh += 1;
      return null; // 走默认历史
    });
  });

  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.compacted', {
      reason: 'auto',
      tokensBefore: 88000,
      tokensAfter: 9000,
      summary: '自动压缩摘要',
    });
  }, SESSION_ID);

  await expect(page.locator('.compact-banner')).toContainText('自动压缩');
  const calls = await page.evaluate(() => (window as unknown as { __qh: number }).__qh);
  expect(calls, '自动压缩后应重新拉取会话历史').toBeGreaterThan(0);
  guard.assertHealthy();
});
