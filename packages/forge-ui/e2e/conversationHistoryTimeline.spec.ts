/**
 * CV-S06 会话历史时间线 E2E（docs/test/03_conversation/e2e.md）。
 *
 * - E-CV-007 时间线展示与实时新增（AC-CV-014，P0）：
 *   左缘时间线以简化短横条标记正序列出全部用户消息（不展示文本，title 提示截断文本）、
 *   条目数=用户消息数、无分隔竖线（不与消息区切割）、流式进行中发送新消息后条目实时出现、
 *   子 agent 结果视图激活时不渲染（切回恢复）。
 * - E-CV-010 空态不渲染（AC-CV-017，P1）：
 *   草稿态新建会话无时间线无占位；仅 assistant/tool 消息的会话无时间线。
 *
 * 自动化等级：mock-backend（window.__forgeMock 种子 + 发送脚本）。
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

// =====================================================================
// E-CV-007 时间线展示与实时新增（AC-CV-014）
// =====================================================================
test('E-CV-007 @P0 @mock-backend：时间线横条标记正序展示、条目数=用户消息数、无分隔竖线、流式实时新增', async ({ page }) => {
  const health = attachHealthGuards(page);
  const s = mkSession({ alias: '时间线长会话' });
  const sid = s.sessionId as string;

  // 5+ 轮对话种子：user → tool → assistant × 5；首轮提问超长（>40 码点）
  const longQuestion = `第1轮提问：${'这是一段很长的提问内容用于验证截断'.repeat(5)}`;
  const history: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 5; i += 1) {
    history.push({ role: 'user', content: i === 1 ? longQuestion : `第${i}轮提问`, ts: new Date(Date.now() - 100000 + i * 1000).toISOString() });
    history.push({ role: 'tool', content: `工具输出${i}`, toolEventId: `tl-${i}`, toolName: 'file.read', status: 'completed', ts: new Date(Date.now() - 100000 + i * 1000 + 100).toISOString() });
    history.push({ role: 'assistant', content: `第${i}轮回复。`, ts: new Date(Date.now() - 100000 + i * 1000 + 200).toISOString() });
  }

  await boot(page, [s]);
  await seedHistory(page, sid, history);

  // 打开会话
  await page.locator('.tree-session', { hasText: '时间线长会话' }).click();
  await expect(page.locator('.msg-assistant', { hasText: '第5轮回复' })).toBeVisible({ timeout: 8_000 });

  const rail = page.locator('[data-testid="history-rail"]');
  const items = page.locator('[data-testid="history-rail-item"]');

  // 时间线出现，条目数 = 用户消息数（5）；tool/assistant 不进条目
  await expect(rail).toBeVisible();
  await expect(items).toHaveCount(5);

  // 简化横条标记：条目不展示文本（textContent 为空）；截断文本进原生 title（首轮 40 码点 + 省略号）
  const expectedFirstTitle = Array.from(longQuestion).slice(0, 40).join('') + '…';
  for (let i = 0; i < 5; i += 1) {
    await expect(items.nth(i)).toHaveAttribute('title', i === 0 ? expectedFirstTitle : `第${i + 1}轮提问`);
  }
  const firstTextContent = ((await items.nth(0).textContent()) ?? '').trim();
  expect(firstTextContent).toBe('');

  // 横条几何：每条目内可见横条宽 >8px、高 ≤6px（区别于文本行）
  for (let i = 0; i < 5; i += 1) {
    const barBox = await items.nth(i).locator('.history-rail-bar').boundingBox();
    expect(barBox).not.toBeNull();
    expect(barBox!.width).toBeGreaterThan(8);
    expect(barBox!.height).toBeLessThanOrEqual(6);
  }

  // 正序：条目纵向自上而下排列（y 单调递增）
  let lastY = -Infinity;
  for (let i = 0; i < 5; i += 1) {
    const box = await items.nth(i).boundingBox();
    expect(box).not.toBeNull();
    expect(box!.y).toBeGreaterThan(lastY);
    lastY = box!.y;
  }

  // 无分隔竖线：Rail 不带右边框（融入消息区背景，无切割感）
  const railStyle = await rail.evaluate((el) => {
    const cs = getComputedStyle(el);
    return { borderRightWidth: cs.borderRightWidth, borderRightStyle: cs.borderRightStyle };
  });
  expect(railStyle.borderRightWidth).toBe('0px');

  // 布局位置：时间线位于消息区左缘
  const railBox = await rail.boundingBox();
  const msgBox = await page.locator('.conv-messages').boundingBox();
  expect(railBox).not.toBeNull();
  expect(msgBox).not.toBeNull();
  expect(railBox!.x).toBeLessThan(msgBox!.x);

  // ===== 流式进行中发送新消息：条目实时新增（无手动刷新） =====
  await seedSendScript(page, sid, [
    { type: 'delta', delayMs: 3000, payload: { text: '流式回复中', kind: 'text' } },
    { type: 'message', delayMs: 200, payload: { role: 'assistant', content: '流式回复完成', ts: new Date().toISOString() } },
  ]);
  await page.locator('.compose-input').fill('流式中新增的一条提问');
  await page.locator('.compose-input').press('Enter');

  // 流式进行中（compose 处于 streaming）新条目已出现：5 → 6（横条标记，截断文本在 title）
  await expect(page.locator('.compose-box')).toHaveClass(/streaming/);
  await expect(items).toHaveCount(6);
  await expect(items.last()).toHaveAttribute('title', '流式中新增的一条提问');

  // 等待流式结束（mock 脚本结束只广播 session.updated，需按 mock-backend 约定补发
  // conversation.statusChanged done —— 同 streamSwitch.spec / session.spec 的模式）
  await expect(page.locator('.msg-assistant', { hasText: '流式回复完成' })).toBeVisible({ timeout: 15_000 });
  await page.evaluate(
    ([sessionKey]) => window.__forgeMock!.emit(sessionKey, 'conversation.statusChanged', { status: 'done' }),
    [sid] as const,
  );
  await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);

  // ===== 子 agent 结果视图激活：时间线隐藏；切回主会话恢复 =====
  await page.evaluate((sessionKey) => {
    window.__forgeMock!.setSubagents(sessionKey, []);
    window.__forgeMock!.emit(sessionKey, 'subagent.updated', {
      sessionId: sessionKey,
      subagent: {
        agentId: 'ag-tl-1',
        agentType: 'general-purpose',
        description: '研究定价',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, sid);
  const agentTab = page.locator('.subagent-tab', { hasText: '研究定价' });
  await expect(agentTab).toBeVisible();
  await agentTab.click();
  await expect(rail).toBeHidden();
  await page.locator('.subagent-tab', { hasText: '主会话' }).click();
  await expect(rail).toBeVisible();
  await expect(items).toHaveCount(6);

  // 证据：screenshot（docs/test/03_conversation/e2e.md E-CV-007）
  await page.screenshot({ path: 'e2e-report/E-CV-007-timeline.png' });

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// =====================================================================
// E-CV-007b 横条纵向居中 + 悬停波浪衰减（ZCode 风格，AC-CV-014/016 视觉细化）
// =====================================================================
test('E-CV-007b @P1 @mock-backend：横条纵向居中、悬停波浪衰减、选中保持突出', async ({ page }) => {
  const health = attachHealthGuards(page);
  const s = mkSession({ alias: '居中与指示条会话' });
  const sid = s.sessionId as string;

  const history: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 8; i += 1) {
    history.push({ role: 'user', content: `提问${i}`, ts: new Date(Date.now() - 100000 + i * 1000).toISOString() });
    history.push({ role: 'assistant', content: `回复${i}。`, ts: new Date(Date.now() - 100000 + i * 1000 + 200).toISOString() });
  }

  await boot(page, [s]);
  await seedHistory(page, sid, history);
  await page.locator('.tree-session', { hasText: '居中与指示条会话' }).click();
  await expect(page.locator('.msg-assistant', { hasText: '回复8' })).toBeVisible({ timeout: 8_000 });

  const rail = page.locator('[data-testid="history-rail"]');
  const items = page.locator('[data-testid="history-rail-item"]');
  await expect(rail).toBeVisible();
  await expect(items).toHaveCount(8);

  // 垂直居中：条目块的中点与 Rail 可视区中点基本重合（少量条目时不在顶部堆叠）
  const railBox = (await rail.boundingBox())!;
  const firstBox = (await items.nth(0).boundingBox())!;
  const lastBox = (await items.nth(7).boundingBox())!;
  const blockCenter = (firstBox.y + lastBox.y + lastBox.height) / 2;
  const railCenter = railBox.y + railBox.height / 2;
  expect(Math.abs(blockCenter - railCenter)).toBeLessThanOrEqual(30);

  // 波浪衰减（ZCode 风格）：hover 某条时，该条最长，相邻条按距离递减伸长（波包），
  // 全程 width 过渡平滑；移开后全部收缩复位；无独立指示条元素
  const barOf = (i: number) => items.nth(i).locator('.history-rail-bar');
  const widthOf = async (i: number) => (await barOf(i).boundingBox())!.width;
  const defaultWidth = await widthOf(3);
  expect(defaultWidth).toBeGreaterThanOrEqual(8);
  expect(defaultWidth).toBeLessThanOrEqual(16);

  const hoverTransition = await barOf(3).evaluate((el) => getComputedStyle(el).transitionProperty);
  expect(hoverTransition).toContain('width');

  await items.nth(3).hover();
  await page.waitForTimeout(350); // 等 width 过渡收尾
  const w2 = await widthOf(2);
  const w3 = await widthOf(3);
  const w4 = await widthOf(4);
  const w1 = await widthOf(1);
  const w5 = await widthOf(5);
  const w0 = await widthOf(0);
  // 波峰：悬停条最长
  expect(w3).toBeGreaterThan(20);
  // 一阶邻居：明显伸长（衰减但不低于默认太多）
  expect(w2).toBeGreaterThan(defaultWidth + 2);
  expect(w4).toBeGreaterThan(defaultWidth + 2);
  // 衰减单调：波峰 > 一阶 > 二阶 > 远端
  expect(w3).toBeGreaterThan(w2);
  expect(w2).toBeGreaterThan(w1);
  expect(w1).toBeGreaterThanOrEqual(w0 - 0.5);
  expect(Math.abs(w4 - w2)).toBeLessThanOrEqual(1);
  expect(Math.abs(w5 - w1)).toBeLessThanOrEqual(1);

  // 移开：全部收缩复位
  await page.locator('.conv-messages').hover({ position: { x: 200, y: 60 } });
  await page.waitForTimeout(350);
  expect(await widthOf(3)).toBeLessThanOrEqual(16);

  // 点击选中（进入回看）+ 指针移开：选中条保持突出（brand 色、加长），
  // 且选中波包带动邻居轻微伸长（非选中条也参与波浪）
  await items.nth(5).click();
  await page.locator('.conv-messages').hover({ position: { x: 200, y: 60 } });
  await page.waitForTimeout(350);
  const aWidth = await widthOf(5);
  expect(aWidth).toBeGreaterThan(14);
  const aColor = await barOf(5).evaluate((el) => getComputedStyle(el).backgroundColor);
  expect(aColor).not.toBe(await barOf(0).evaluate((el) => getComputedStyle(el).backgroundColor));
  const aPrev = await widthOf(4);
  expect(aPrev).toBeGreaterThan(defaultWidth + 1);
  await expect(page.locator('[data-testid="history-thumb"]')).toHaveCount(0);

  health.assertHealthy();
});

// =====================================================================
// E-CV-010 空态不渲染（AC-CV-017）
// =====================================================================
test('E-CV-010 @P1 @mock-backend：草稿态新建会话无时间线无占位', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '已有会话' })]);

  // 新建会话进入草稿态：输入区出现、会话树不新增标签
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 无时间线、无占位元素（Rail 根节点 v-if 不渲染，无空壳）
  await expect(page.locator('[data-testid="history-rail"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="history-rail-item"]')).toHaveCount(0);

  // 证据：screenshot（E-CV-010）
  await page.screenshot({ path: 'e2e-report/E-CV-010-draft.png' });

  health.assertHealthy();
});

test('E-CV-010 @P1 @mock-backend：仅 assistant/tool 消息的会话无时间线', async ({ page }) => {
  const health = attachHealthGuards(page);
  const s = mkSession({ alias: '无提问会话' });
  await boot(page, [s]);
  await seedHistory(page, s.sessionId as string, [
    { role: 'assistant', content: '只有助手回复，没有用户提问。', ts: new Date(Date.now() - 60000).toISOString() },
    { role: 'tool', content: '工具输出', toolEventId: 'tx-1', toolName: 'file.read', status: 'completed', ts: new Date(Date.now() - 59000).toISOString() },
  ]);

  await page.locator('.tree-session', { hasText: '无提问会话' }).click();
  await expect(page.locator('.msg-assistant', { hasText: '只有助手回复' })).toBeVisible({ timeout: 8_000 });

  // 会话已打开但无任何 user 消息：不渲染时间线、不留占位
  await expect(page.locator('[data-testid="history-rail"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="history-rail-item"]')).toHaveCount(0);

  health.assertHealthy();
});
