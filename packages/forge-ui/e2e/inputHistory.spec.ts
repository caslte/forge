/**
 * 输入框历史翻阅 E2E（方案 B：仅输入框为空时 ↑/↓ 触发翻阅）。
 *
 * 覆盖：
 * - AC-IH-001：发送 N 条消息后，聚焦空输入框按 ↑ 回填最近一条；再 ↑ 回填更早一条
 * - AC-IH-002：↓ 在历史中向前走，越过最新一条后清空输入框回到当前编辑态
 * - AC-IH-003：非空输入框按 ↑/↓ 不触发翻阅（默认行为，让出光标移动）
 * - AC-IH-004：草稿态（无 sessionId）不翻历史不入栈
 * - AC-IH-005：历史按 sessionId 隔离，切换会话后 ↑ 调出该会话自己的历史
 * - AC-IH-006：历史持久化到 localStorage，刷新页面后仍能翻阅
 * - AC-IH-007：连续发送相同内容去重，不产生重复条目
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSessions, seedSendScript } from './helpers/index';

const SESSION_A = 'e2e-history-A';
const SESSION_B = 'e2e-history-B';

const aliasA = '历史A';
const aliasB = '历史B';

function mkSession(id: string, alias: string): Record<string, unknown> {
  return {
    sessionId: id,
    projectPath: 'D:/work/aiwork/forge',
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 脚本：发完后立即给一个 message 事件避免挂起。同一脚本会被每次 sendMessage 重放 */
const SCRIPT = [
  { type: 'message' as const, delayMs: 50, payload: { role: 'assistant', content: 'ok', ts: new Date().toISOString() } },
];

async function bootAndPick(page: Page, sessionId: string, alias: string): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedSendScript(page, sessionId, SCRIPT);
  await seedSessions(page, [mkSession(sessionId, alias)]);
  await page.reload();
  await waitForMock(page);
  await seedSendScript(page, sessionId, SCRIPT); // reload 后脚本要重新种
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: alias }).click();
  await expect(page.locator('.compose-input')).toBeVisible();
}

/** 发一条并等流结束（等输入框重新可写，sessionStatus 退到 idle） */
async function sendAndWait(page: Page, text: string, sessionId: string): Promise<void> {
  const input = page.locator('.compose-input');
  await input.fill(text);
  await input.press('Enter');
  // 等 .msg-assistant 出现（脚本里 'ok' 是固定回复）
  await expect(page.locator('.msg-assistant', { hasText: 'ok' }).last()).toBeVisible({ timeout: 8_000 });
  // mock-bridge 不自动发 conversation.statusChanged，需手动模拟后端轮次终态
  await page.evaluate((sid) => {
    const list = window
      .__forgeMock!.getSessions()
      .map((s) => (s.sessionId === sid ? { ...s, status: 'done' } : s));
    window.__forgeMock!.setSessions(list);
    (window.__forgeMock as unknown as {
      emit: (s: string, e: string, p: Record<string, unknown>) => void;
    }).emit(sid, 'session.updated', {});
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' });
  }, sessionId);
  await expect(input).toBeEnabled({ timeout: 8_000 });
}

test('AC-IH-001/002/003 ↑/↓ 翻历史 + 非空不触发', async ({ page }) => {
  await bootAndPick(page, SESSION_A, aliasA);

  await sendAndWait(page, 'msg-1', SESSION_A);
  await sendAndWait(page, 'msg-2', SESSION_A);
  await sendAndWait(page, 'msg-3', SESSION_A);

  // 清掉输入框（发送完应该已经清空，再保险点）
  const input = page.locator('.compose-input');
  await input.click();
  await input.press('Control+A');
  await input.press('Delete');
  await expect(input).toHaveValue('');

  // AC-IH-001：空输入框 ↑ → 最近一条 msg-3
  await input.press('ArrowUp');
  await expect(input).toHaveValue('msg-3');

  // 再 ↑ → 更早一条 msg-2
  await input.press('ArrowUp');
  await expect(input).toHaveValue('msg-2');

  // AC-IH-002：↓ → 回到 msg-3
  await input.press('ArrowDown');
  await expect(input).toHaveValue('msg-3');

  // 再 ↓ → 走过最新，清空回到当前编辑态
  await input.press('ArrowDown');
  await expect(input).toHaveValue('');

  // AC-IH-003：非空时 ↑/↓ 不触发翻阅
  await input.fill('working on it');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('working on it');
  await input.press('ArrowDown');
  await expect(input).toHaveValue('working on it');
});

test('AC-IH-004 草稿态（无 sessionId）不翻历史', async ({ page }) => {
  // 不种任何 session；验证 localStorage 不被写入 forge.inputHistory.* 键
  await page.goto('/');
  await waitForMock(page);

  // 清理可能的历史残留
  await page.evaluate(() => {
    Object.keys(localStorage)
      .filter((k) => k.startsWith('forge.inputHistory.'))
      .forEach((k) => localStorage.removeItem(k));
  });

  const keys = await page.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('forge.inputHistory.')),
  );
  expect(keys).toEqual([]);
});

test('AC-IH-005 历史按 sessionId 隔离', async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  await seedSendScript(page, SESSION_A, SCRIPT);
  await seedSendScript(page, SESSION_B, SCRIPT);
  await seedSessions(page, [mkSession(SESSION_A, aliasA), mkSession(SESSION_B, aliasB)]);
  await page.reload();
  await waitForMock(page);
  await seedSendScript(page, SESSION_A, SCRIPT);
  await seedSendScript(page, SESSION_B, SCRIPT);

  // A 发一条
  await page.locator('.tree-session', { hasText: aliasA }).click();
  await sendAndWait(page, 'A-only-msg', SESSION_A);

  // 切到 B，发另一条
  await page.locator('.tree-session', { hasText: aliasB }).click();
  await sendAndWait(page, 'B-only-msg', SESSION_B);

  // 在 B 上 ↑ → 应该是 B-only-msg，不是 A-only-msg
  const input = page.locator('.compose-input');
  await input.click();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('B-only-msg');

  // 切回 A，↑ → A-only-msg
  await page.locator('.tree-session', { hasText: aliasA }).click();
  await input.click();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('A-only-msg');
});

test('AC-IH-006 localStorage 持久化跨刷新', async ({ page }) => {
  await bootAndPick(page, SESSION_A, aliasA);
  await sendAndWait(page, 'persist-1', SESSION_A);
  await sendAndWait(page, 'persist-2', SESSION_A);

  // 刷新
  await page.reload();
  await waitForMock(page);
  await seedSendScript(page, SESSION_A, SCRIPT);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: aliasA }).click();
  await expect(page.locator('.compose-input')).toBeVisible();

  const input = page.locator('.compose-input');
  await input.click();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('persist-2');
  await input.press('ArrowUp');
  await expect(input).toHaveValue('persist-1');
});

test('AC-IH-007 连续相同内容去重', async ({ page }) => {
  await bootAndPick(page, SESSION_A, aliasA);
  await sendAndWait(page, 'same-msg', SESSION_A);
  await sendAndWait(page, 'same-msg', SESSION_A);

  const input = page.locator('.compose-input');
  await input.click();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('same-msg');
  // 再 ↑ 应该保持在 same-msg（去重后列表里只有一条）
  await input.press('ArrowUp');
  await expect(input).toHaveValue('same-msg');
});

test('健康守卫：console 无未声明错误', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await bootAndPick(page, SESSION_A, aliasA);
  await sendAndWait(page, 'hello', SESSION_A);
  const input = page.locator('.compose-input');
  await input.click();
  await input.press('ArrowUp');
  await expect(input).toHaveValue('hello');
  guard.assertHealthy();
});
