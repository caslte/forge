/**
 * CV-S06 会话历史浮窗 E2E（docs/test/03_conversation/e2e.md）。
 *
 * - E-CV-008 浮窗快照（hover/Esc/流式）（AC-CV-015，P0）：
 *   hover <300ms 移开不弹（无 history-popover 节点）；hover ≥300ms 弹出快照——
 *   user 120/assistant 200 码点截断+省略号、Markdown 符号（#/**）原样纯文本、
 *   无 tool 内容无图片；移开/Esc 立即关闭且无残留 DOM；流式中 hover 末条目浮窗内容
 *   不随 delta 变化、关闭重开为更新后快照；仅提问未回复会话显示提问+状态提示。
 * - E-CV-011 浮窗不溢出视口（窄窗口）（AC-CV-018，P2）：
 *   720x480 视口，条目贴上/中/下缘 hover 浮窗 boundingBox 完整在视口内；
 *   超高内容内部滚动（scrollHeight>clientHeight 且 overflow auto）；无 console error。
 *
 * 自动化等级：mock-backend（window.__forgeMock 种子 + seedSendScript 受控 delta）。
 * 每条用例含健康断言（无 console error / pageerror）。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  assertNoResidualStreaming,
  seedSessions,
  seedHistory,
  seedSendScript,
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

/** 码点数（与 conversationTimeline 截断口径一致，非 UTF-16 单元数） */
function cpCount(text: string): number {
  return Array.from(text).length;
}

/** 按码点截断 + 省略号（预期展示文本） */
function truncated(text: string, max: number): string {
  const points = Array.from(text);
  return points.length <= max ? text : points.slice(0, max).join('') + '…';
}

const RAIL_ITEM = '[data-testid="history-rail-item"]';
const POPOVER = '[data-testid="history-popover"]';

// =====================================================================
// E-CV-008 浮窗快照（hover/Esc/流式）（AC-CV-015）
// =====================================================================
test.describe('E-CV-008', () => {
  test('E-CV-008 @P0 @mock-backend：扫过不弹；hover 弹出截断快照（Markdown 原样/无 tool/无图片）；移开与 Esc 即关无残留', async ({ page }) => {
    const health = attachHealthGuards(page);
    const s = mkSession({ alias: '浮窗快照会话' });
    const sid = s.sessionId as string;

    // 第 1 轮：user >120 码点（含 # 与 **，且带图片字段）→ tool（密语标记）→ assistant >200 码点（含 **/`）
    const longUser = '# 修复登录Bug **加粗** ' + '这是用户超长提问内容'.repeat(20);
    const longAssistant = '**结论** `run_tool()` ' + '这是助手超长回复内容'.repeat(30);
    await boot(page, [s]);
    await seedHistory(page, sid, [
      {
        role: 'user',
        content: longUser,
        images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }],
        ts: new Date(Date.now() - 60000).toISOString(),
      },
      { role: 'tool', content: '绝密工具输出标记XYZ', toolEventId: 'tp-1', toolName: 'file.read', status: 'completed', ts: new Date(Date.now() - 59000).toISOString() },
      { role: 'assistant', content: longAssistant, ts: new Date(Date.now() - 58000).toISOString() },
      { role: 'user', content: '第二轮提问', ts: new Date(Date.now() - 50000).toISOString() },
      { role: 'assistant', content: '第二轮回复', ts: new Date(Date.now() - 49000).toISOString() },
      { role: 'user', content: '第三轮提问', ts: new Date(Date.now() - 40000).toISOString() },
      { role: 'assistant', content: '第三轮回复', ts: new Date(Date.now() - 39000).toISOString() },
    ]);

    await page.locator('.tree-session', { hasText: '浮窗快照会话' }).click();
    await expect(page.locator('.msg-assistant', { hasText: '第三轮回复' })).toBeVisible({ timeout: 8_000 });
    const items = page.locator(RAIL_ITEM);
    await expect(items).toHaveCount(3);

    const popover = page.locator(POPOVER);

    // ===== 1. hover <300ms 移开 → 绝不弹出（无残留节点） =====
    await items.nth(0).hover();
    await page.waitForTimeout(100); // 不足 300ms
    await page.locator('.conv-messages').hover(); // 移开
    await page.waitForTimeout(600); // 越过 300ms 阈值：若计时器未被清除此时已误弹
    await expect(popover).toHaveCount(0);

    // ===== 2. hover ≥300ms → 弹出快照：120/200 码点截断 + Markdown 原样 + 无 tool/图片 =====
    await items.nth(0).hover();
    await expect(popover).toBeVisible();
    const expectedUser = truncated(longUser, 120);
    const expectedAssistant = truncated(longAssistant, 200);
    expect(cpCount(expectedUser)).toBe(121);
    expect(cpCount(expectedAssistant)).toBe(201);
    await expect(page.locator('[data-testid="history-popover-user"]')).toHaveText(expectedUser);
    await expect(page.locator('[data-testid="history-popover-assistant"]')).toHaveText(expectedAssistant);
    // Markdown 符号原样纯文本（# 与 ** 未被解析渲染）
    await expect(page.locator('[data-testid="history-popover-user"]')).toContainText('# 修复登录Bug **加粗**');
    await expect(page.locator('[data-testid="history-popover-assistant"]')).toContainText('**结论** `run_tool()`');
    // 无 tool 内容（tool 消息被跳过）、无图片（images 字段忽略、绝无 <img>）
    await expect(popover).not.toContainText('绝密工具输出标记XYZ');
    await expect(popover.locator('img')).toHaveCount(0);
    await page.screenshot({ path: 'e2e-report/E-CV-008-popover-snapshot.png' });

    // ===== 3. 移开条目 → 立即关闭、无残留 DOM =====
    await page.locator('.conv-messages').hover();
    await expect(popover).toHaveCount(0);

    // ===== 4. 再 hover 后按 Esc → 立即关闭、无残留 DOM =====
    await items.nth(0).hover();
    await expect(popover).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    await assertNoResidualStreaming(page);
    health.assertHealthy();
  });

  test('E-CV-008 @P0 @mock-backend：流式中快照不随 delta 刷新；关闭重开为更新后快照', async ({ page }) => {
    const health = attachHealthGuards(page);
    const s = mkSession({ alias: '浮窗流式会话' });
    const sid = s.sessionId as string;

    await boot(page, [s]);
    await seedHistory(page, sid, [
      { role: 'user', content: '历史提问一', ts: new Date(Date.now() - 60000).toISOString() },
      { role: 'assistant', content: '历史回复一', ts: new Date(Date.now() - 59000).toISOString() },
    ]);

    await page.locator('.tree-session', { hasText: '浮窗流式会话' }).click();
    await expect(page.locator('.msg-assistant', { hasText: '历史回复一' })).toBeVisible({ timeout: 8_000 });
    const items = page.locator(RAIL_ITEM);
    await expect(items).toHaveCount(1);

    // 受控流式：首个 delta 延迟 2500ms（留足 hover 弹窗时间），最终 message 收尾
    await seedSendScript(page, sid, [
      { type: 'delta', delayMs: 2500, payload: { text: 'DELTA流式增量', kind: 'text' } },
      { type: 'delta', delayMs: 300, payload: { text: '继续增量', kind: 'text' } },
      { type: 'message', delayMs: 200, payload: { role: 'assistant', content: '流式最终回复 DELTA流式增量 继续增量', ts: new Date().toISOString() } },
    ]);

    await page.locator('.compose-input').fill('流式进行中的提问');
    await page.locator('.compose-input').press('Enter');
    await expect(page.locator('.compose-box')).toHaveClass(/streaming/);
    await expect(items).toHaveCount(2);

    // hover 末条目（尚未有任何回复）≥300ms：浮窗 = 提问 + 运行中状态提示
    await items.last().hover();
    const popover = page.locator(POPOVER);
    await expect(popover).toBeVisible();
    await expect(page.locator('[data-testid="history-popover-user"]')).toHaveText('流式进行中的提问');
    await expect(page.locator('[data-testid="history-popover-assistant"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="history-popover-status"]')).toContainText('运行中');

    // 流式期间注入 delta：浮窗为弹出时刻快照，内容不随 delta 变化
    await page.evaluate(
      ([sessionKey]) => window.__forgeMock!.emit(sessionKey, 'conversation.delta', { delta: { text: 'DELTA流式增量', kind: 'text' } }),
      [sid] as const,
    );
    await page.waitForTimeout(400); // 越过任何响应式更新窗口
    await expect(popover).not.toContainText('DELTA流式增量');
    await expect(page.locator('[data-testid="history-popover-status"]')).toContainText('运行中');
    await page.screenshot({ path: 'e2e-report/E-CV-008-popover-streaming.png' });

    // Esc 关闭；等流式结束（message 到达）后重开 → 为更新后的新快照
    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);
    await expect(page.locator('.msg-assistant', { hasText: '流式最终回复' })).toBeVisible({ timeout: 15_000 });
    await page.evaluate(
      ([sessionKey]) => window.__forgeMock!.emit(sessionKey, 'conversation.statusChanged', { status: 'done' }),
      [sid] as const,
    );
    await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);

    // 关闭重开 = 移开再 hover（指针未离开条目时不重触发，属预期）；重开为新快照
    await page.locator('.conv-messages').hover();
    await expect(popover).toHaveCount(0);
    await items.last().hover();
    await expect(popover).toBeVisible();
    await expect(page.locator('[data-testid="history-popover-user"]')).toHaveText('流式进行中的提问');
    await expect(page.locator('[data-testid="history-popover-assistant"]')).toContainText('DELTA流式增量');

    await assertNoResidualStreaming(page);
    health.assertHealthy();
  });

  test('E-CV-008 @P0 @mock-backend：仅提问未回复会话浮窗显示提问+状态提示（等待回复）', async ({ page }) => {
    const health = attachHealthGuards(page);
    const s = mkSession({ alias: '仅提问会话' });
    await boot(page, [s]);
    await seedHistory(page, s.sessionId as string, [
      { role: 'user', content: '只有提问没有回复', ts: new Date(Date.now() - 60000).toISOString() },
    ]);

    await page.locator('.tree-session', { hasText: '仅提问会话' }).click();
    await expect(page.locator('.msg-user', { hasText: '只有提问没有回复' })).toBeVisible({ timeout: 8_000 });
    const items = page.locator(RAIL_ITEM);
    await expect(items).toHaveCount(1);

    await items.nth(0).hover();
    const popover = page.locator(POPOVER);
    await expect(popover).toBeVisible();
    await expect(page.locator('[data-testid="history-popover-user"]')).toHaveText('只有提问没有回复');
    await expect(page.locator('[data-testid="history-popover-assistant"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="history-popover-status"]')).toContainText('等待回复');
    await page.screenshot({ path: 'e2e-report/E-CV-008-popover-pending.png' });

    await page.keyboard.press('Escape');
    await expect(popover).toHaveCount(0);

    health.assertHealthy();
  });
});

// =====================================================================
// E-CV-011 浮窗不溢出视口（窄窗口）（AC-CV-018）
// =====================================================================
test.describe('E-CV-011', () => {
  test.use({ viewport: { width: 720, height: 480 } });

  /** 断言浮窗完整落在视口内（含 1px 容差；求解器本身保证 8px margin） */
  async function assertPopoverInsideViewport(page: Page): Promise<void> {
    const box = await page.locator(POPOVER).boundingBox();
    expect(box).not.toBeNull();
    const EPS = 1;
    expect(box!.x).toBeGreaterThanOrEqual(0 - EPS);
    expect(box!.y).toBeGreaterThanOrEqual(0 - EPS);
    expect(box!.x + box!.width).toBeLessThanOrEqual(720 + EPS);
    expect(box!.y + box!.height).toBeLessThanOrEqual(480 + EPS);
  }

  test('E-CV-011 @P2 @mock-backend：窄视口条目贴上/中/下缘 hover 浮窗不溢出；超高内容内部滚动', async ({ page }) => {
    const health = attachHealthGuards(page);
    const s = mkSession({ alias: '窄窗口浮窗会话' });
    const sid = s.sessionId as string;

    // 12 轮对话：条目撑满左缘（上/中/下），assistant 内容超长（截断后仍高过 40vh → 内滚）
    const history: Array<Record<string, unknown>> = [];
    for (let i = 1; i <= 12; i += 1) {
      history.push({ role: 'user', content: `第${i}轮提问：窄窗口浮窗定位验证`, ts: new Date(Date.now() - 120000 + i * 1000).toISOString() });
      history.push({ role: 'assistant', content: `**第${i}轮回复** ` + '窄窗口内部滚动验证内容'.repeat(25), ts: new Date(Date.now() - 120000 + i * 1000 + 200).toISOString() });
    }
    await boot(page, [s]);
    await seedHistory(page, sid, history);

    await page.locator('.tree-session', { hasText: '窄窗口浮窗会话' }).click();
    await expect(page.locator('.msg-assistant', { hasText: '第12轮回复' })).toBeVisible({ timeout: 8_000 });
    const items = page.locator(RAIL_ITEM);
    await expect(items).toHaveCount(12);

    const popover = page.locator(POPOVER);
    // 条目分别位于侧缘上/中/下（last 需要 rail 内滚动 → 贴下缘）
    const targets = ['上缘', 0, '中缘', 5, '下缘', 11] as const;
    for (let t = 0; t < targets.length; t += 2) {
      const label = targets[t] as string;
      const idx = targets[t + 1] as number;
      await items.nth(idx).hover();
      await expect(popover).toBeVisible();
      await assertPopoverInsideViewport(page);

      if (label === '上缘') {
        // 超高内容内部滚动：scrollHeight > clientHeight 且 overflow auto（不撑破视口）
        const scroll = await popover.locator('.hp-body').evaluate((el) => ({
          scrollHeight: el.scrollHeight,
          clientHeight: el.clientHeight,
          overflowY: getComputedStyle(el).overflowY,
        }));
        expect(scroll.overflowY).toBe('auto');
        expect(scroll.scrollHeight).toBeGreaterThan(scroll.clientHeight);
        await page.screenshot({ path: 'e2e-report/E-CV-011-popover-narrow-top.png' });
      } else if (label === '中缘') {
        await page.screenshot({ path: 'e2e-report/E-CV-011-popover-narrow-middle.png' });
      } else {
        await page.screenshot({ path: 'e2e-report/E-CV-011-popover-narrow-bottom.png' });
      }

      // 关闭再测下一个位置，避免新旧浮窗过渡期重叠
      await page.keyboard.press('Escape');
      await expect(popover).toHaveCount(0);
    }

    health.assertHealthy();
  });
});
