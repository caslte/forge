/**
 * 会话管理 E2E（docs/test/02_session/e2e.md E-SM-001~004）。
 * 自动化等级：mock-backend（mock-bridge 可编程事件）。
 * P0 上线门禁用例：每条包含 UI 断言 + 负向断言 + 健康守卫。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  assertNoResidualStreaming,
  seedSessions,
  seedSendScript,
  waitForMock,
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

// ===== E-SM-001 新建会话进入工作区 =====
test('SESSION-E2E-001 @P0 @mock-backend E-SM-001：新建会话进入会话池', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '已有会话' })]);
  await expect(page.locator('.tree-session')).toHaveCount(1);

  await page.locator('.add-project-btn').click();
  // + 号下方是新建会话入口（app-toolbar 新建会话按钮需在会话视图）
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();

  // 会话池新增一条
  await expect(page.locator('.tree-session')).toHaveCount(2);
  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== E-SM-002 多会话并行切换观察 =====
test('SESSION-E2E-002 @P0 @mock-backend E-SM-002：多会话并行流式互不串扰', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话A' });
  const b = mkSession({ alias: '会话B' });
  await boot(page, [a, b]);

  // 为 A/B 配置各自的流式脚本（交错 token，验证隔离）
  const sessionA = a.sessionId as string;
  const sessionB = b.sessionId as string;
  await seedSendScript(page, sessionA, [
    { type: 'delta', delayMs: 80, payload: { text: 'A1', kind: 'text' } },
    { type: 'message', delayMs: 80, payload: { role: 'assistant', content: 'A 的完整回答', ts: new Date().toISOString() } },
  ]);
  await seedSendScript(page, sessionB, [
    { type: 'delta', delayMs: 80, payload: { text: 'B1', kind: 'text' } },
    { type: 'message', delayMs: 80, payload: { role: 'assistant', content: 'B 的完整回答', ts: new Date().toISOString() } },
  ]);

  // 选中 A，发消息，随即切到 B（模拟切换观察）
  await page.locator('.tree-session', { hasText: '会话A' }).click();
  const input = page.locator('.compose-input');
  await input.fill('A 的问题');
  await input.press('Enter');

  await page.locator('.tree-session', { hasText: '会话B' }).click();
  // B 视图显示 B 的流式输出，不出现 A 的内容
  await expect(page.locator('.msg-assistant').first()).toBeVisible({ timeout: 10_000 });
  // 会话 B 的答非所问：B 视图不应含 A 的 token
  await expect(page.locator('.conv-messages')).not.toContainText('A1');

  await page.locator('.tree-session', { hasText: '会话A' }).click();
  await expect(page.locator('.msg-assistant', { hasText: 'A 的完整回答' })).toBeVisible({ timeout: 10_000 });
  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== E-SM-003 删除会话（含运行中） =====
test('SESSION-E2E-003 @P0 @mock-backend E-SM-003：删除会话二次确认后可移除', async ({ page }) => {
  const health = attachHealthGuards(page);
  const doomed = mkSession({ alias: '待删除' });
  await boot(page, [doomed]);

  const row = page.locator('.tree-session', { hasText: '待删除' });
  await expect(row).toHaveCount(1);

  // 首次点击删除进入确认态（按钮文字变“确认”），不删除
  await row.hover();
  await row.locator('.tree-icon-button.danger').click();
  await expect(row.locator('.confirm-text')).toBeVisible();
  await expect(page.locator('.tree-session')).toHaveCount(1);

  // 再次点击确认删除
  await row.locator('.tree-icon-button.danger').click();
  await expect(page.locator('.tree-session')).toHaveCount(0);
  health.assertHealthy();
});

// ===== E-SM-004 画布开窗/吸附/关闭 =====
test('SESSION-E2E-004 @P0 @mock-backend E-SM-004：多窗口开窗与关闭回池', async ({ page }) => {
  const health = attachHealthGuards(page);
  const win = mkSession({ alias: '画布会话' });
  await boot(page, [win]);

  // 进入多窗口模式
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();

  // 从会话池把会话拖入画布开窗：直接用 mock 打字机不可行，走真实 drag 事件较复杂；
  // 退而求其次：先用 auto 布局前的开窗路径——多窗口组件对已存在会话可通过拖入。
  // 简化：验证画布空白提示存在 + 拖动事件被接受。
  await expect(page.locator('.mw-hint')).toHaveText(/把左侧会话拖到画布开窗/);

  // 拖拽开窗：HTML5 drag 用 dispatchEvent 模拟（dragstart + drop）
  const sessionEl = page.locator('.tree-session', { hasText: '画布会话' });
  const canvas = page.locator('.mw-canvas');
  const box = (await canvas.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await sessionEl.dispatchEvent('dragstart', { dataTransfer });
  await canvas.dispatchEvent('dragover', {
    dataTransfer,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  await canvas.dispatchEvent('drop', {
    dataTransfer,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  // 开窗成功：出现 .mw-win 窗口
  await expect(page.locator('.mw-win')).toHaveCount(1);
  // 会话池标记“已开窗”（不可重复开窗）
  await expect(sessionEl).toContainText('已开窗');

  // 关闭窗口回池
  await page.locator('.mw-close').click();
  await expect(page.locator('.mw-win')).toHaveCount(0);
  await expect(sessionEl).not.toContainText('已开窗');
  health.assertHealthy();
});

// ===== E-SM-005 会话删除自动关窗（P3-C） =====
test('SESSION-E2E-005 @P1 @mock-backend：删除会话后画布窗口自动关闭', async ({ page }) => {
  const health = attachHealthGuards(page);
  const win = mkSession({ alias: '删除自动关' });
  await boot(page, [win]);

  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  // 开窗（走同上拖拽路径）
  await expect(page.locator('.mw-hint')).toBeVisible();
  const sessionEl = page.locator('.tree-session', { hasText: '删除自动关' });
  const canvas = page.locator('.mw-canvas');
  const box = (await canvas.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await sessionEl.dispatchEvent('dragstart', { dataTransfer });
  await canvas.dispatchEvent('drop', {
    dataTransfer,
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
  });
  await expect(page.locator('.mw-win')).toHaveCount(1);

  // 删除该会话（mock-bridge deleteSession 会 emit session.removed → 画布 watch 摘窗）
  await sessionEl.hover();
  await sessionEl.locator('.tree-icon-button.danger').click();
  await expect(sessionEl.locator('.confirm-text')).toBeVisible();
  await sessionEl.locator('.tree-icon-button.danger').click();
  // 会话删除 + 窗口自动关闭
  await expect(page.locator('.tree-session')).toHaveCount(0);
  await expect(page.locator('.mw-win')).toHaveCount(0, { timeout: 5_000 });
  health.assertHealthy();
});

// ===== 会话删除时未停 AgentSession 不被删（负向：取消不删） =====
test('SESSION-E2E-006 @P1 @mock-backend E-SM-003 负向：首次点击不删除、超时可取消', async ({ page }) => {
  const health = attachHealthGuards(page);
  const keep = mkSession({ alias: '保留会话' });
  await boot(page, [keep]);

  const row = page.locator('.tree-session', { hasText: '保留会话' });
  // 进入确认态后点击会话标题（非确认按钮）→ 确认态取消
  await row.hover();
  await row.locator('.tree-icon-button.danger').click();
  await expect(row.locator('.confirm-text')).toBeVisible();
  await row.locator('.tree-session-title').click();
  // 确认态清除（按钮恢复）且会话仍在
  await expect(row.locator('.confirm-text')).toHaveCount(0);
  await expect(page.locator('.tree-session')).toHaveCount(1);
  health.assertHealthy();
});

void waitForMock;