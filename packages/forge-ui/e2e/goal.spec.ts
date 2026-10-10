/**
 * pi-goal 宿主接入 E2E（goal 接入，2026-10-10）。
 *
 * 覆盖三条真实故障的回归（接入前 forge 全都中招）：
 * - E-GOAL-001：状态徽标不渲染。pi-goal 每次状态变化调
 *   `ctx.ui.setStatus("goal", …)`，forge 未传 uiContext ⇒ 落入
 *   `noOpUIContext.setStatus` 空实现 ⇒ 目标在跑但界面毫无迹象。
 * - E-GOAL-002：confirm 弹窗不出现 / 点了没反应。pi-goal 替换未完成目标时
 *   `await ctx.ui.confirm(...)`，no-op 实现恒返回 false ⇒ 静默拒绝。
 *   本条断言「弹窗出现 + 点确定能回填 value:true」。
 * - E-GOAL-003：清除状态行后徽标必须消失。**不能保留旧值** ——
 *   目标已清空却还显示「进行中 12/25」，用户会以为它还在烧 token。
 *
 * 另覆盖运行期健康（参照 askUserQuestion.spec.ts 的 E-CV-028）：
 * 首屏对话区必须渲染 —— GoalDialog/GoalBadge 引入的 TDZ 或模板错误
 * 会连累整个 ConversationView，真机表现为右侧对话区整块空白。
 *
 * 自动化等级：mock-backend（mock-bridge.emit 注入 goal.statusChanged / goal.uiRequested）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSessions } from './helpers/index';

const SESSION_ID = 'e2e-goal-session';
/** 非本会话 id：用于「只认领自己会话的状态与弹窗」的负向断言 */
const OTHER_SESSION_ID = 'e2e-goal-other';

/** 会话种子（字段名与既有 spec 一致：sessionId 而非 id） */
function mkSession(id: string, alias: string): Record<string, unknown> {
  return {
    sessionId: id,
    projectPath: 'D:/work/aiwork/forge',
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/**
 * 打开会话并等首屏稳定。
 *
 * `page.goto` → seedSessions → **reload** → 等树面板：与既有 spec（branchBadge /
 * askUserQuestion）同一范式。reload 不可省 —— seedSessions 只写 mock DB，
 * 不 reload 时会话树不会重建，点不到目标会话。
 */
async function openSession(page: Page): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [
    mkSession(SESSION_ID, 'goal 会话'),
    mkSession(OTHER_SESSION_ID, '其它会话'),
  ]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.getByText('goal 会话', { exact: true }).click();
  await waitForMock(page);
}

/** 注入 pi-goal 的状态行（`setStatus("goal", …)` 的等价载荷） */
async function emitStatus(page: Page, text: string | null, sessionId = SESSION_ID): Promise<void> {
  await page.evaluate(
    ({ sessionId: sid, text: t }) => {
      window.__forgeMock!.emit('goal.statusChanged', { sessionId: sid, text: t });
    },
    { sessionId, text },
  );
}

/** 注入一个用户裁决请求（confirm / input / editor / select） */
async function emitRequest(
  page: Page,
  kind: 'confirm' | 'input' | 'editor' | 'select',
  extra: { message?: string; options?: string[]; timeoutMs?: number } = {},
  sessionId = SESSION_ID,
): Promise<void> {
  await page.evaluate(
    ({ sessionId: sid, kind: k, message, options, timeoutMs }) => {
      window.__forgeMock!.emit('goal.uiRequested', {
        sessionId: sid,
        requestId: `req-${k}-${Date.now()}`,
        kind: k,
        title: 'Replace goal?',
        message: message ?? '当前目标：A\n新目标：B',
        ...(options ? { options } : {}),
        timeoutMs: timeoutMs ?? 600_000,
      });
    },
    { sessionId, kind, message: extra.message, options: extra.options, timeoutMs: extra.timeoutMs },
  );
}

test.describe('goal 状态徽标', () => {
  test.beforeEach(async ({ page }) => {
    await attachHealthGuards(page);
    await openSession(page);
  });

  test('E-GOAL-001：状态行到达即渲染徽标，并带轮次用量', async ({ page }) => {
    await emitStatus(page, 'active 3m · automatic 12/25');

    const badge = page.locator('.goal-badge');
    await expect(badge).toBeVisible();
    await expect(badge).toContainText('进行中');
    // 轮次用量是「烧了多少」的实质信息，必须露出
    await expect(badge).toContainText('12/25');
  });

  test('无目标时不渲染徽标（不占底栏空间）', async ({ page }) => {
    await expect(page.locator('.goal-badge')).toHaveCount(0);
  });

  test('E-GOAL-003：清除状态行后徽标消失（不能保留旧值）', async ({ page }) => {
    await emitStatus(page, 'active 3m · automatic 12/25');
    await expect(page.locator('.goal-badge')).toBeVisible();

    // pi-goal 在目标清空时调 setStatus("goal", undefined) ⇒ 载荷 text 为 null
    await emitStatus(page, null);
    await expect(page.locator('.goal-badge')).toHaveCount(0);
  });

  test('需用户介入的终局用警示样式（受阻 / 额度用尽 / 预算用尽）', async ({ page }) => {
    await emitStatus(page, 'blocked · automatic 12/25');
    await expect(page.locator('.goal-badge')).toHaveClass(/needs-user/);
    await expect(page.locator('.goal-badge')).toContainText('受阻');

    await emitStatus(page, 'budget 100k/100k · automatic 12/25');
    await expect(page.locator('.goal-badge')).toContainText('预算用尽');
    await expect(page.locator('.goal-badge')).toContainText('100k/100k');
  });

  test('已完成：灰态且不显示轮次', async ({ page }) => {
    await emitStatus(page, 'complete');
    const badge = page.locator('.goal-badge');
    await expect(badge).toContainText('已完成');
    await expect(badge).not.toContainText('/');
  });

  test('非本会话的状态不被认领（多窗格隔离）', async ({ page }) => {
    await emitStatus(page, 'active 3m · automatic 1/25', OTHER_SESSION_ID);
    await expect(page.locator('.goal-badge')).toHaveCount(0);
  });
});

test.describe('goal 用户裁决弹窗', () => {
  test.beforeEach(async ({ page }) => {
    await attachHealthGuards(page);
    await openSession(page);
  });

  test('E-GOAL-002a：confirm 请求渲染弹窗并带对照正文', async ({ page }) => {
    await emitRequest(page, 'confirm');

    const dialog = page.locator('.goal-dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('Replace goal?');
    await expect(dialog).toContainText('新目标');
    await expect(dialog.locator('button', { hasText: '确定' })).toBeVisible();
    await expect(dialog.locator('button', { hasText: '取消' })).toBeVisible();
  });

  test('E-GOAL-002b：点「确定」回填 value=true（不再是恒 false 的静默拒绝）', async ({ page }) => {
    await emitRequest(page, 'confirm');
    await page.locator('.goal-dialog button', { hasText: '确定' }).click();

    // 回填经 mock-bridge 记录（真实端投回宿主 uiContext 的 Promise）
    const reply = await page.evaluate(() => window.__forgeMock!.getLastGoalUiReply());
    expect(reply).not.toBeNull();
    expect(reply!.value).toBe(true);
    expect(reply!.cancelled).toBe(false);
  });

  test('点「取消」回填 cancelled=true 且弹窗关闭', async ({ page }) => {
    await emitRequest(page, 'confirm');
    await page.locator('.goal-dialog button', { hasText: '取消' }).click();

    const reply = await page.evaluate(() => window.__forgeMock!.getLastGoalUiReply());
    expect(reply!.cancelled).toBe(true);
    await expect(page.locator('.goal-dialog')).toHaveCount(0);
  });

  test('input：空内容禁用提交，有内容后回填文本', async ({ page }) => {
    await emitRequest(page, 'input', { message: 'Goal objective' });
    const dialog = page.locator('.goal-dialog');
    await expect(dialog.locator('input')).toBeVisible();

    const submit = dialog.locator('button', { hasText: '确定' });
    await expect(submit).toBeDisabled();

    await dialog.locator('input').fill('把登录页修好');
    await expect(submit).toBeEnabled();
    await submit.click();

    const reply = await page.evaluate(() => window.__forgeMock!.getLastGoalUiReply());
    expect(reply!.value).toBe('把登录页修好');
  });

  test('editor：多行输入形态（pi-goal 用它取目标全文）', async ({ page }) => {
    await emitRequest(page, 'editor', { message: 'Edit goal objective' });
    await expect(page.locator('.goal-dialog textarea')).toBeVisible();
  });

  test('select：点候选项回填该项原文', async ({ page }) => {
    await emitRequest(page, 'select', { options: ['Unlimited', '25', '100'] });
    const dialog = page.locator('.goal-dialog');
    await expect(dialog.locator('.option')).toHaveCount(3);

    await dialog.locator('.option', { hasText: '25' }).click();
    const reply = await page.evaluate(() => window.__forgeMock!.getLastGoalUiReply());
    expect(reply!.value).toBe('25');
  });

  test('倒计时：<60s 时显示剩余秒数', async ({ page }) => {
    await emitRequest(page, 'confirm', { timeoutMs: 45_000 });
    await expect(page.locator('.goal-dialog .countdown')).toBeVisible();
    await expect(page.locator('.goal-dialog .countdown')).toContainText('s');
  });

  test('非本会话的请求不被认领（多窗格隔离）', async ({ page }) => {
    await emitRequest(page, 'confirm', {}, OTHER_SESSION_ID);
    await expect(page.locator('.goal-dialog')).toHaveCount(0);
  });
});

test('E-GOAL-004 运行期健康：goal 接入后首屏对话区必须渲染', async ({ page }) => {
  await attachHealthGuards(page);
  await openSession(page);

  // 参照 askUserQuestion.spec.ts 的 E-CV-028：组件层没有单测设施，
  // 声明顺序 / 模板引用类错误只能靠浏览器级用例兜住 ——
  // 它们的表现是「左右分栏正常、右侧对话区整块空白」。
  await expect(page.locator('.conversation-view, [class*="conversation"]').first()).toBeVisible();
  // 输入框必须可用（goal 接入动了 InstructionInput 的徽标区）
  await expect(page.locator('textarea, input').first()).toBeVisible();
});
