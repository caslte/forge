/**
 * CV-S06 点击定位与回看模式 E2E（docs/test/03_conversation/e2e.md E-CV-009，AC-CV-016）。
 *
 * - 定位：长会话（12 轮）点击中部条目 → 目标 user 消息进入消息区可视区 + 短暂高亮 class
 *   （msg-locate-highlight）出现后 1.5s 消失；
 * - 回看模式：mock 注入持续 delta（emit conversation.delta，受控时序）→ scrollTop 不被强制
 *   改写（无自动滚底）+ 底部"回到底部"提示条（review-backdown）可见；期间无布局跳动
 *   （输入框位置不变）、无 console error / pageerror；
 * - 恢复：点击提示条 → 退出回看 + 滚到底 + 提示条消失；对照组再进 review 后手动滚到底
 *   （触底信号）→ 提示条消失恢复跟随；
 * - 跟随：恢复后后续 delta 跟随到底（scrollTop 增长、距底 ≤2px）。
 *
 * 自动化等级：mock-backend（window.__forgeMock 种子 + emit 受控 delta）。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  assertNoResidualStreaming,
  seedSessions,
  seedHistory,
} from './helpers/index';

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

/** 进入应用：加载种子会话并等待首屏就绪 */
async function boot(page: Page, sessions: Array<Record<string, unknown>>): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
}

/** 距消息区底部距离（px） */
async function distanceToBottom(page: Page): Promise<number> {
  return page.locator('.conv-messages').evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight);
}

/** 目标 user 消息是否完整落在消息区可视区内 */
async function isMessageInView(page: Page, target: ReturnType<Page['locator']>): Promise<boolean> {
  const msgBox = await target.boundingBox();
  const view = await page.locator('.conv-messages').boundingBox();
  if (!msgBox || !view) return false;
  return msgBox.y >= view.y - 1 && msgBox.y + msgBox.height <= view.y + view.height + 1;
}

test('E-CV-009 @P0 @mock-backend：点击定位+短暂高亮+回看模式抑制滚底+点击/触底恢复跟随', async ({ page }) => {
  const health = attachHealthGuards(page);
  const s = mkSession({ alias: '定位回看长会话' });
  const sid = s.sessionId as string;

  // 12 轮长会话种子：user → tool → assistant；assistant 正文足够长保证会话可滚动回看
  const history: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 12; i += 1) {
    const t = Date.now() - 200000 + i * 1000;
    history.push({ role: 'user', content: `第${i}轮提问：定位回看验证`, ts: new Date(t).toISOString() });
    history.push({ role: 'tool', content: `工具输出${i}`, toolEventId: `lc-${i}`, toolName: 'file.read', status: 'completed', ts: new Date(t + 100).toISOString() });
    history.push({ role: 'assistant', content: `第${i}轮回复。\n${'这是用于撑高消息流的回复正文，确保长会话可滚动回看。'.repeat(6)}`, ts: new Date(t + 200).toISOString() });
  }

  await boot(page, [s]);
  await seedHistory(page, sid, history);

  // 打开会话（加载历史后自动滚到底）
  await page.locator('.tree-session', { hasText: '定位回看长会话' }).click();
  await expect(page.locator('.msg-assistant', { hasText: '第12轮回复' })).toBeVisible({ timeout: 8_000 });

  const railItems = page.locator('[data-testid="history-rail-item"]');
  const backdown = page.locator('[data-testid="review-backdown"]');
  const scroller = page.locator('.conv-messages');
  await expect(page.locator('[data-testid="history-rail"]')).toBeVisible();
  await expect(railItems).toHaveCount(12);

  // ===== 1. 点击中部条目（第 5 轮）→ 定位 + 短暂高亮 + 进入回看模式 =====
  await railItems.nth(4).click();
  await page.mouse.move(600, 300); // 移开指针，避免 hover 浮窗干扰后续断言
  const target = page.locator('.msg-user', { hasText: '第5轮提问' });
  // 定位：目标用户消息进入消息区可视区
  await expect.poll(() => isMessageInView(page, target)).toBe(true);
  // 短暂高亮：msg-locate-highlight 出现后 1.5s 移除
  await expect(target).toHaveClass(/msg-locate-highlight/, { timeout: 2_000 });
  await expect(target).not.toHaveClass(/msg-locate-highlight/, { timeout: 4_000 });
  // 回看模式：底部"回到底部"提示条出现
  await expect(backdown).toBeVisible();

  // ===== 2. 回看模式：注入持续 mock delta → scrollTop 不被强制改写 =====
  const before = await scroller.evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }));
  const inputBoxBefore = await page.locator('.conv-input-wrap').boundingBox();
  await page.evaluate(([sessionKey]) => {
    for (let i = 1; i <= 8; i += 1) {
      setTimeout(() => {
        window.__forgeMock!.emit(sessionKey, 'conversation.delta', {
          delta: { text: `回看期间增量段落${i}，用于验证不强制滚底。`, kind: 'text' },
        });
      }, i * 250);
    }
  }, [sid] as const);
  // delta 已渲染进最后一条 assistant（内容确实增长）但 scrollTop 不变（无自动滚底）
  await expect(page.locator('.msg-assistant').last()).toContainText('回看期间增量段落8，', { timeout: 8_000 });
  const after = await scroller.evaluate((el) => ({ scrollTop: el.scrollTop, scrollHeight: el.scrollHeight }));
  expect(after.scrollHeight, 'delta 期间消息流内容应增长').toBeGreaterThan(before.scrollHeight);
  expect(Math.abs(after.scrollTop - before.scrollTop), '回看模式 delta 不得强制改写 scrollTop').toBeLessThanOrEqual(2);
  await expect(backdown).toBeVisible();
  // 负向：回看模式期间无布局跳动（输入框位置不变；提示条为 absolute 悬浮不参与布局）
  const inputBoxAfter = await page.locator('.conv-input-wrap').boundingBox();
  expect(Math.abs((inputBoxAfter?.y ?? 0) - (inputBoxBefore?.y ?? 0)), '输入框不得因回看/增量位移').toBeLessThan(1);

  // 证据：screenshot（E-CV-009 回看模式态）
  await page.screenshot({ path: 'e2e-report/E-CV-009-review-mode.png' });

  // ===== 3. 点击"回到底部" → 退出回看 + 滚到底 + 提示条消失 =====
  await backdown.click();
  await expect(backdown).toBeHidden();
  await expect.poll(distanceToBottom.bind(null, page), { message: '点击提示后应滚到底部' }).toBeLessThanOrEqual(2);

  // ===== 4. 对照组：再进 review → 手动滚到底（触底信号）→ 提示条消失恢复跟随 =====
  await railItems.nth(1).click();
  const target2 = page.locator('.msg-user', { hasText: '第2轮提问' });
  // 等定位 smooth scroll 停稳（目标消息进入可视区），避免与后续手动滚动动画互相打断
  await expect.poll(() => isMessageInView(page, target2)).toBe(true);
  await page.waitForTimeout(300);
  await scroller.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(backdown).toBeHidden({ timeout: 5_000 }); // 触底去抖判定后退出回看

  // ===== 5. 恢复自动滚底：后续 delta 跟随到底（scrollTop 增长） =====
  const followBefore = await scroller.evaluate((el) => el.scrollTop);
  await page.evaluate(([sessionKey]) => {
    for (let i = 1; i <= 5; i += 1) {
      setTimeout(() => {
        window.__forgeMock!.emit(sessionKey, 'conversation.delta', {
          delta: { text: `恢复跟随增量段落${i}。`, kind: 'text' },
        });
      }, i * 250);
    }
  }, [sid] as const);
  await expect(page.locator('.msg-assistant').last()).toContainText('恢复跟随增量段落5。', { timeout: 8_000 });
  await expect.poll(distanceToBottom.bind(null, page), { message: '恢复后 delta 应跟随到底' }).toBeLessThanOrEqual(2);
  const followAfter = await scroller.evaluate((el) => el.scrollTop);
  expect(followAfter, '恢复后 scrollTop 应随内容增长而前进').toBeGreaterThan(followBefore);

  // 证据：screenshot（E-CV-009 恢复跟随态）
  await page.screenshot({ path: 'e2e-report/E-CV-009-recovered.png' });

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});
