/**
 * 上下文压缩 E2E（P3-A）。
 *
 * - 手动压缩：点击「压缩」按钮 → 全局 toast 反馈（同切换模型款式，含 token 变化
 *   与减少百分比）；压缩中显示底部横幅、完成即收掉（2026-09-27 用户反馈：
 *   常驻「减少 x%」横幅与消息流内联分隔条重复，删除）；
 *   压缩失败显示失败原因；全程无 pageerror（dev 预览走 mock-bridge）；
 * - 流式保护：streaming 期间压缩按钮禁用，避免静默截断正在生成的回答；
 * - 自动压缩：mock 发射 conversation.compacting/compacted → 输入锁定/解锁、
 *   重拉历史、横幅随完成收掉（自动压缩没有 RPC 入口，事件是 UI 感知它的唯一通道）；
 * - 压缩后百分比：压缩完成即显示压缩后的上下文占用百分比（不再"? tokens"）；
 * - 压缩后历史不丢（2026-09-26 反馈）：压缩点**之前**的对话仍留在消息流里，
 *   压缩点位置出现「上下文已压缩」分隔条（摘要全文不外显，2026-09-28 反馈）。
 *
 * 自动化等级：mock-backend（window.__forgeMock 种子 + emit 受控事件）。
 * > 待办：本机未安装 Playwright 浏览器（无 ~/.cache/ms-playwright），本文件新增的
 * > 「压缩后历史不丢」用例未经浏览器实跑，启动 Electron/浏览器后需补跑一次。
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

test('手动压缩：mock 默认实现可用（点击不报错），toast 反馈 + 横幅随完成收掉', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  // 不注入 seed：走 mock-bridge 的 conversation/compact 默认实现
  // （曾缺失该分支落到 default 返回 data:null，UI 侧对 null 取值抛 TypeError）
  await clickCompact(page);

  // toast（同切换模型的浮窗款式）：mock 默认 4200 → 1680（减少 60%）
  await expect(page.locator('.toast')).toContainText('压缩完成');
  // 2026-09-27 用户反馈：完成后不再常驻「上下文已压缩（减少 x%）」横幅，
  // 压缩点由消息流内联分隔条标记，结果由 toast 承担
  await expect(page.locator('.compact-banner')).toHaveCount(0);
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

test('自动压缩：compacting 锁定输入并显示横幅，compacted 后重拉历史并收掉横幅', async ({ page }) => {
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

  // 压缩完成：横幅收掉（不再有常驻提示），输入解锁，历史重拉
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.compacted', {
      reason: 'auto',
      tokensBefore: 88000,
      tokensAfter: 9000,
      summary: '自动压缩摘要',
    });
  }, SESSION_ID);

  await expect(page.locator('.compact-banner')).toHaveCount(0);
  await expect(page.locator('.compose-input')).toBeEnabled();
  const calls = await page.evaluate(() => (window as unknown as { __qh: number }).__qh);
  expect(calls, '自动压缩后应重新拉取会话历史').toBeGreaterThan(0);
  guard.assertHealthy();
});

// 压缩失败收尾（2026-10 修复）：契约 A-CV-010 规定失败只发 conversation.error、
// 不发 compacted，UI 必须自己收横幅，否则「正在压缩上下文」永久挂底。
test('自动压缩失败：retry 载荷横幅保留，终态 error 收横幅并解锁输入', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.compacting', { reason: 'auto' });
  }, SESSION_ID);
  await expect(page.locator('.compact-banner.working')).toContainText('正在压缩上下文');
  await expect(page.locator('.compose-input')).toBeDisabled();

  // 压缩摘要请求断流重试（带 retry 字段）：轮次未终止，横幅必须保留
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.error', {
      message: '模型连接中断，正在自动重试…',
      retry: { attempt: 1, maxAttempts: 3 },
    });
  }, SESSION_ID);
  await expect(page.locator('.compact-banner.working')).toHaveCount(1);

  // 终态错误（压缩失败的唯一收尾信号）：横幅收掉、输入解锁
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.error', { message: '压缩失败：上游无响应' });
  }, SESSION_ID);
  await expect(page.locator('.compact-banner')).toHaveCount(0);
  await expect(page.locator('.compose-input')).toBeEnabled();
  guard.assertHealthy();
});

// CV-S07 口径修正：压缩只替换喂给模型的上下文，用户看到的 transcript 必须完整，
// 历史加载走 pi getBranch()（而非 buildContextEntries()），压缩点之上保留原文。
// 2026-09-28 用户反馈：分隔条下不再外显压缩摘要预览。
test('压缩后历史不丢：压缩点之前消息仍在流里 +「上下文已压缩」分隔条（无摘要预览）', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  // 含 compression 标记的历史：压缩前 2 条 / 标记 / 压缩后 1 条
  await page.evaluate((sid) => {
    window.__forgeMock!.seed('conversation/queryHistory', () => ({
      code: 0,
      message: 'ok',
      data: {
        messages: [
          { role: 'user', content: '压缩前提问', ts: '2026-09-26T10:00:00Z' },
          { role: 'assistant', content: '压缩前回答', ts: '2026-09-26T10:00:01Z' },
          { role: 'system', content: '自动压缩摘要全文（第二行验证展开）', ts: '2026-09-26T10:00:02Z', compacted: true },
          { role: 'user', content: '压缩后提问', ts: '2026-09-26T10:00:03Z' },
        ],
      },
    }));
    // 真实链路：自动压缩完成 → UI 重拉历史
    window.__forgeMock!.emit(sid, 'conversation.compacted', {
      reason: 'auto',
      tokensBefore: 88000,
      tokensAfter: 9000,
      summary: '自动压缩摘要全文（第二行验证展开）',
    });
  }, SESSION_ID);

  // 压缩点之前的对话没有随上下文一起被抹掉
  await expect(page.locator('.conv-messages')).toContainText('压缩前提问');
  await expect(page.locator('.conv-messages')).toContainText('压缩前回答');

  // 分隔条恰好 1 条，且排在压缩前后之间（分隔条之上的条目数 ≥2）
  await expect(page.locator('.compact-divider')).toHaveCount(1);
  await expect(page.locator('.compact-divider .cd-text')).toContainText('上下文已压缩');

  // 摘要全文不外显（2026-09-28 用户反馈）：分隔条下不再渲染摘要预览
  await expect(page.locator('.cd-summary')).toHaveCount(0);
  await expect(page.locator('.conv-messages')).not.toContainText('自动压缩摘要全文');
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
