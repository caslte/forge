/**
 * 消息队列 E2E（CV-S09，方案 C5 + pi TUI ESC 语义停止）。
 *
 * 覆盖：
 * - QC-001：忙时发送 → 入队（徽标 + 只读浮窗），忙完自动派发为 user 气泡并继续回复
 * - QC-002：队列上限 5 条，第 6 条拒绝并 toast 提示，输入框内容保留
 * - QC-003：停止 = 清空队列 + 文本回填输入框（pi TUI ESC 同款，\n\n 拼接）
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSessions, seedSendScript } from './helpers/index';

const SESSION_ID = 'e2e-queue-session';
const ALIAS = '队列会话';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    projectPath: 'D:/work/aiwork/forge',
    alias: ALIAS,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 脚本：慢回复，留出入队窗口；同一脚本被每次 sendMessage/派发重放 */
const SCRIPT = [
  { type: 'message' as const, delayMs: 900, payload: { role: 'assistant', content: 'ok', ts: new Date().toISOString() } },
];

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, SCRIPT);
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, SCRIPT);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: ALIAS }).click();
  await expect(page.locator('.compose-input')).toBeVisible();
}

/** 发送首条（直发），进入 streaming（CV-S09：流式中输入框保持可写） */
async function startTurn(page: Page, text: string): Promise<void> {
  const input = page.locator('.compose-input');
  await input.fill(text);
  await input.press('Enter');
  // streaming 态标记（compose-box.streaming），确认会话已进入流式
  await expect(page.locator('.compose-box.streaming')).toBeVisible({ timeout: 8_000 });
}

/** 忙时入队一条 */
async function queueMessage(page: Page, text: string): Promise<void> {
  const input = page.locator('.compose-input');
  await input.fill(text);
  await input.press('Enter');
  await expect(input).toHaveValue('');
}

test('QC-001 @P0 忙时入队 → 徽标/浮窗 → 忙完自动派发为 user 气泡', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  await startTurn(page, '首条消息');

  // 忙时入队：徽标出现
  await queueMessage(page, '排队一');
  const badge = page.locator('.queue-badge');
  await expect(badge).toHaveText('待发送 1');

  // 再入一条：计数累加
  await queueMessage(page, '排队二');
  await expect(badge).toHaveText('待发送 2');

  // 浮窗只读展示（无删除/立即发送按钮）
  await badge.click();
  const panel = page.locator('.queue-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.queue-item')).toHaveText(['排队一', '排队二']);
  await expect(panel.locator('button')).toHaveCount(0);
  await badge.click(); // 关浮窗

  // 自动派发：脚本结束后 FIFO 取出，user 气泡依次出现，徽标清空
  await expect(page.locator('.msg-user', { hasText: '排队一' })).toBeVisible({ timeout: 10_000 });
  await expect(page.locator('.msg-user', { hasText: '排队二' })).toBeVisible({ timeout: 10_000 });
  await expect(badge).toHaveCount(0);
  // 派发后的回复也完成（最后一轮 done：输入框可写且无 streaming 占位）
  await expect(page.locator('.compose-input')).toBeEnabled();
  guard.assertHealthy();
});

test('QC-002 @P1 队列上限 5 条：第 6 条拒绝 + toast，输入保留', async ({ page }) => {
  await boot(page);
  await startTurn(page, '首条消息');

  for (const text of ['q1', 'q2', 'q3', 'q4', 'q5']) {
    await queueMessage(page, text);
  }
  await expect(page.locator('.queue-badge')).toHaveText('待发送 5');

  // 第 6 条：拒绝，输入框内容保留
  const input = page.locator('.compose-input');
  await input.fill('q6');
  await input.press('Enter');
  await expect(page.locator('.toast.error')).toBeVisible();
  await expect(page.locator('.toast')).toContainText('队列已满');
  await expect(input).toHaveValue('q6');
  await expect(page.locator('.queue-badge')).toHaveText('待发送 5');
});

test('QC-003 @P0 停止 = 清空队列 + 文本回填输入框（pi TUI ESC 同款）', async ({ page }) => {
  await boot(page);
  await startTurn(page, '首条消息');

  await queueMessage(page, '被撤回甲');
  await queueMessage(page, '被撤回乙');
  await expect(page.locator('.queue-badge')).toHaveText('待发送 2');

  // 停止：队列清空，文本按 \n\n 拼接回填输入框
  await page.locator('.cancel-btn').click();
  await expect(page.locator('.queue-badge')).toHaveCount(0);
  await expect(page.locator('.compose-input')).toHaveValue('被撤回甲\n\n被撤回乙');
});
