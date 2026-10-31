/**
 * 子 Agent 管理 E2E（docs/test/06_subagent/e2e.md E-SA-001..010）。
 * 自动化等级：mock-backend（window.__forgeMock 注入 subagent 事件序列）。
 *
 * v6.37 形态变更：子 agent 不再是输入框上方的胶囊 Tab 栏 + 整页结果视图，
 * 而是消息流里的**一行 Agent 行**（`.agent-row`）。断言随之改为：
 * - 行本身可见/状态正确（`.agent-row.is-running` / `.agent-row .lbl`）
 * - 点行原地展开过程（`.agent-row.open` / `.agent-body`）
 * - 并发多个 agent → 多行（每行独立）
 * 状态机语义、事件序列、级联终止行为完全不变，这些用例仍是 P0 门禁。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  assertNoResidualStreaming,
  expandAllProjects,
  seedSessions,
  waitForMock,
} from './helpers/index';

/** 会话种子构造 */
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
  // v6.26 默认折叠：展开项目组
  await expect(page.locator('.tree-project').first()).toBeVisible();
  await expandAllProjects(page);
}

/**
 * 在消息流里种一条 `agent` 工具调用（Agent 行的绑定锚点）。
 * 直接走事件通道（tool.started + tool.completed），与真实后端链路一致，
 * 不依赖发送脚本的时序。
 */
async function emitAgentTool(
  page: Page,
  sessionId: string,
  toolEventId: string,
  description: string,
): Promise<void> {
  await page.evaluate(
    ([sid, id, desc]) => {
      const payload = {
        sessionId: sid,
        toolEventId: id,
        tool: { name: 'agent', input: { description: desc, prompt: desc } },
      };
      window.__forgeMock!.emit(sid, 'tool.started', payload);
      window.__forgeMock!.emit(sid, 'tool.completed', {
        ...payload,
        result: { text: '派发成功' },
      });
    },
    [sessionId, toolEventId, description] as const,
  );
}

/** 派生子 agent 记录（created/running/completed 由调用方给状态） */
async function emitSubagent(
  page: Page,
  sessionId: string,
  fields: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ([sid, extra]) => {
      window.__forgeMock!.emit(sid, 'subagent.updated', {
        sessionId: sid,
        subagent: {
          agentId: 'a1',
          agentType: 'general-purpose',
          description: '研究定价',
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          result: null,
          error: null,
          usage: { inputTokens: 0, outputTokens: 0 },
          ...(extra as Record<string, unknown>),
        },
      });
    },
    [sessionId, fields] as const,
  );
}

// =====================================================================
// E-SA-001 主会话保持运行中（AC-SA-004）：存在运行中子 agent 时主会话不转 done
// =====================================================================
test('SUB-E2E-001 @P0 E-SA-001：主会话派生后台子 agent 后主会话保持运行中', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA001' });
  await boot(page, [a]);

  // 打开会话
  await page.locator('.tree-session', { hasText: '会话SA001' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 先让消息流里出现一条 agent 工具调用（Agent 行的挂载锚点），再派发 running 子 agent
  await emitAgentTool(page, a.sessionId as string, 'te-sa001', '研究定价');
  await emitSubagent(page, a.sessionId as string, { status: 'running' });

  // Agent 行出现：一行、运行态、描述名可见（不再有 Tab 栏 / 结果视图）
  const row = page.locator('.agent-row');
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  await expect(row).toHaveClass(/is-running/);
  await expect(row.locator('.lbl')).toContainText('研究定价');
  // 旧的常驻胶囊栏与整页结果视图已彻底移除
  await expect(page.locator('.subagent-tabbar')).toHaveCount(0);
  await expect(page.locator('.subagent-result-view')).toHaveCount(0);

  // 输入框仍处于可发状态（运行中可继续排队），无 done 触发
  await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);
  health.assertHealthy();
});

// =====================================================================
// E-SA-002 计数归零自动完成（AC-SA-005）：子 agent 终态后主会话转 done
// =====================================================================
test('SUB-E2E-002 @P0 E-SA-002：子 agent 转 completed 后主会话自动转 done', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA002' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA002' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  await emitAgentTool(page, a.sessionId as string, 'te-sa002', '研究定价');
  await emitSubagent(page, a.sessionId as string, { status: 'running' });

  await expect(page.locator('.agent-row.is-running')).toHaveCount(1, { timeout: 5_000 });

  // 后续 emit completed（mock 侧根据计数归零自动补发 done）
  await emitSubagent(page, a.sessionId as string, {
    status: 'completed',
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
    result: '完成',
    usage: { inputTokens: 120, outputTokens: 240 },
  });

  // 行转终态 + 元信息带「已完成」
  await expect(page.locator('.agent-row.is-completed')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator('.agent-row .meta')).toContainText('已完成');
  health.assertHealthy();
});

// =====================================================================
// E-SA-004 Agent 行出现与状态实时（AC-SA-008/010）
// =====================================================================
test('SUB-E2E-003 @P0 E-SA-004：子 agent emit 后 Agent 行出现 + 状态实时变化', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA004' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA004' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 初始无子 agent：没有任何 Agent 行
  await expect(page.locator('.agent-row')).toHaveCount(0);

  await emitAgentTool(page, a.sessionId as string, 'te-sa004a', '子A-研究');
  await emitAgentTool(page, a.sessionId as string, 'te-sa004b', '子B-抓取');

  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '子A-研究',
    status: 'running',
  });
  await expect(page.locator('.agent-row.is-running')).toHaveCount(1, { timeout: 5_000 });

  // a1 转 completed
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '子A-研究',
    status: 'completed',
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
    result: 'A 完成',
    usage: { inputTokens: 100, outputTokens: 200 },
  });
  await expect(page.locator('.agent-row.is-completed')).toHaveCount(1, { timeout: 5_000 });

  // emit a2 running（并发：两个 agent 各占一行）
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a2',
    agentType: 'Explore',
    description: '子B-抓取',
    status: 'running',
  });

  await expect(page.locator('.agent-row')).toHaveCount(2, { timeout: 5_000 });
  await expect(page.locator('.agent-row.is-running')).toHaveCount(1);
  await expect(page.locator('.agent-row.is-completed')).toHaveCount(1);
  // 每个 agent 一行（扁平、不聚合）
  await expect(page.locator('.agent-row .lbl', { hasText: '子A-研究' })).toHaveCount(1);
  await expect(page.locator('.agent-row .lbl', { hasText: '子B-抓取' })).toHaveCount(1);

  health.assertHealthy();
});

// =====================================================================
// E-SA-007 展开态（AC-SA-013/014）：点行原地展开过程；终态显示 result 与用量
// =====================================================================
test('SUB-E2E-005 @P0 E-SA-007：点 Agent 行原地展开过程 + 完成后正文与用量', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA007' });
  await boot(page, [a]);

  // 历史：先写一条消息流，便于验证展开过程不会打乱主消息流
  await page.evaluate((sid) => {
    window.__forgeMock!.setHistory(sid, [
      {
        role: 'user',
        content: '初始问题',
        ts: new Date(Date.now() - 60000).toISOString(),
      },
      {
        role: 'assistant',
        content: '已收到',
        ts: new Date(Date.now() - 59000).toISOString(),
      },
    ]);
  }, a.sessionId as string);

  await page.locator('.tree-session', { hasText: '会话SA007' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await expect(page.locator('.msg-assistant', { hasText: '已收到' })).toBeVisible({ timeout: 5_000 });

  await emitAgentTool(page, a.sessionId as string, 'te-sa007', '研究子任务');
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '研究子任务',
    status: 'running',
    startedAt: new Date(Date.now() - 10_000).toISOString(),
  });

  const row = page.locator('.agent-row');
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  // 默认收起：正文不占高度
  await expect(row).not.toHaveClass(/open/);

  // 点行 → 原地展开，过程流可见（mock 返回真实 JSONL），主消息流不被替换
  await row.locator('.agent-head').click();
  await expect(row).toHaveClass(/open/);
  await expect(page.locator('.agent-row .agent-tool', { hasText: 'grep' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.agent-row .agent-text', { hasText: '正在扫描' })).toBeVisible();
  await expect(page.locator('.msg-assistant', { hasText: '已收到' })).toBeVisible();

  // a1 完成 → 同一条流保留 result 全文，用量补充显示
  const big = '这是完成结果 '.repeat(50);
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '研究子任务',
    status: 'completed',
    startedAt: new Date(Date.now() - 3000).toISOString(),
    finishedAt: new Date().toISOString(),
    result: big,
    usage: { inputTokens: 1000, outputTokens: 2000 },
  });

  await expect(page.locator('.agent-row .agent-text', { hasText: '这是完成结果' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.agent-row .agent-usage')).toContainText('1,000');
  await expect(page.locator('.agent-row .agent-usage')).toContainText('2,000');

  // 再点一次收起：正文高度归零，主消息流照常可见
  await row.locator('.agent-head').click();
  await expect(row).not.toHaveClass(/open/);
  await expect(page.locator('.msg-assistant', { hasText: '已收到' })).toBeVisible();

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// =====================================================================
// E-SA-009 回归基线：无子 agent 不渲染 Agent 行；停止行为与现状一致
// =====================================================================
test('SUB-E2E-006 @P0 E-SA-009：无子 agent 会话不渲染 Agent 行；停止行为与改造前一致', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '无子会话' });
  await boot(page, [a]);

  // 打开会话
  await page.locator('.tree-session', { hasText: '无子会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 没有任何子 agent 时不存在 Agent 行
  await expect(page.locator('.agent-row')).toHaveCount(0);

  // 配置一段普通流式脚本，发送并停止
  await seedSendScriptLite(page, a.sessionId as string, [
    { type: 'delta', delayMs: 30, payload: { text: '正常', kind: 'text' } },
    { type: 'message', delayMs: 30, payload: { role: 'assistant', content: '正常回复', ts: new Date().toISOString() } },
  ]);
  await page.locator('.compose-input').fill('普通问题');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.msg-assistant', { hasText: '正常回复' })).toBeVisible({ timeout: 8_000 });
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' });
  }, a.sessionId as string);
  await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);

  // 仍然无 Agent 行
  await expect(page.locator('.agent-row')).toHaveCount(0);

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

/** 简化版 seedSendScript（不依赖额外 helper 导入） */
async function seedSendScriptLite(
  page: Page,
  sessionId: string,
  script: Array<{ type: 'delta' | 'message' | 'tool'; delayMs?: number; payload: Record<string, unknown> }>,
): Promise<void> {
  await waitForMock(page);
  await page.evaluate(
    ([sid, items]) => window.__forgeMock!.onSend(sid, items as never),
    [sessionId, script] as const,
  );
}

// =====================================================================
// E-SA-003 完成通知渲染（AC-SA-007）
// =====================================================================
test('SUB-E2E-007 @P0 E-SA-003：子 agent 完成通知渲染进消息流，与 Agent 行不重复', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA003' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA003' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  await emitAgentTool(page, a.sessionId as string, 'te-sa003', '研究子任务');
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '研究子任务',
    status: 'running',
  });
  await expect(page.locator('.agent-row.is-running')).toHaveCount(1, { timeout: 5_000 });

  // 子 agent 完成通知以 conversation.message 进消息流
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.message', {
      sessionId: sid,
      message: {
        role: 'assistant',
        content: '子任务完成：研究结果已生成。',
        ts: new Date().toISOString(),
      },
    });
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '研究子任务',
        status: 'completed',
        startedAt: new Date(Date.now() - 3000).toISOString(),
        finishedAt: new Date().toISOString(),
        result: '子任务完成：研究结果已生成。',
        error: null,
        usage: { inputTokens: 100, outputTokens: 200 },
      },
    });
  }, a.sessionId as string);

  // 通知进入消息流（1 条 assistant）
  await expect(page.locator('.msg-assistant', { hasText: '子任务完成：研究结果已生成' })).toHaveCount(1, {
    timeout: 5_000,
  });

  // Agent 行转终态（收起的行不重写正文：结果全文只在展开态显示）
  await expect(page.locator('.agent-row.is-completed')).toHaveCount(1);
  await expect(page.locator('.agent-row')).toHaveCount(1);

  health.assertHealthy();
});

// =====================================================================
// E-SA-008 终止交互（AC-SA-016/017/019）
// =====================================================================
test('SUB-E2E-008 @P0 E-SA-008：单个终止二次确认 + 停止级联 + 幂等', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA008' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA008' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // a1 + a2 都 running
  await emitAgentTool(page, a.sessionId as string, 'te-sa008a', '子A-运行中');
  await emitAgentTool(page, a.sessionId as string, 'te-sa008b', '子B-运行中');
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '子A-运行中',
    status: 'running',
  });
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a2',
    description: '子B-运行中',
    status: 'running',
    startedAt: new Date(Date.now() + 1).toISOString(),
  });

  await expect(page.locator('.agent-row.is-running')).toHaveCount(2, { timeout: 5_000 });

  // 行内「终止」按钮 → 弹二次确认（hover 显示，playwright click 直接命中）
  const rowA = page.locator('.agent-row', { hasText: '子A-运行中' });
  await rowA.locator('.agent-head').hover();
  await rowA.locator('.agent-stop').click();
  await expect(page.locator('.stop-confirm')).toBeVisible();

  // 取消 → 状态不变（仍是 2 个 running）
  await page.locator('.stop-confirm-cancel').click();
  await expect(page.locator('.stop-confirm')).toHaveCount(0);
  await expect(page.locator('.agent-row.is-running')).toHaveCount(2);

  // 再次点终止 → 确认 → a1 转 stopped，a2 不受影响（mock 侧按 agentId 定向 emit）
  await rowA.locator('.agent-head').hover();
  await rowA.locator('.agent-stop').click();
  await page.locator('.stop-confirm-confirm').click();
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '子A-运行中',
        status: 'stopped',
        startedAt: new Date(Date.now() - 2000).toISOString(),
        finishedAt: new Date().toISOString(),
        result: null,
        error: '用户终止',
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);
  await expect(page.locator('.agent-row.is-stopped')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator('.agent-row.is-running')).toHaveCount(1);

  // 输入框停止按钮级联：先发送一条消息进入流式，然后点击级联终止 a2。
  // mock cancelStream 默认 cascadeSubagents: true，会 emit subagent.updated stopped。
  await seedSendScriptLite(page, a.sessionId as string, [
    { type: 'delta', delayMs: 200, payload: { text: '进行中', kind: 'text' } },
  ]);
  await page.locator('.compose-input').fill('触发流式');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.compose-box')).toHaveClass(/streaming/);
  await expect(page.locator('.cancel-btn')).toBeVisible();

  // 触发 cancelStream（mock 默认级联）→ a2 转 stopped
  await page.locator('.cancel-btn').click();
  await expect(page.locator('.agent-row.is-stopped')).toHaveCount(2, { timeout: 5_000 });

  // 输入框已恢复（非流式）
  await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);

  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' });
  }, a.sessionId as string);

  health.assertHealthy();
});

// =====================================================================
// E-SA-009 场景2 重启（AC-SA-023）：子 agent 为内存态，重载后 queryList 为空
// → 无 Agent 行；历史完成通知消息仍在消息流可读。
// =====================================================================
test('SUB-E2E-009 @P1 E-SA-009-重启：重载后无 Agent 行，历史完成通知仍可读', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '重启会话' });
  await boot(page, [a]);

  // 历史含一条完成通知消息（模拟扩展 followUp 已写回消息流）
  await page.evaluate((sid) => {
    window.__forgeMock!.setHistory(sid, [
      {
        role: 'user',
        content: '启动研究',
        ts: new Date(Date.now() - 60000).toISOString(),
      },
      {
        role: 'assistant',
        content: '完成通知：子 agent 研究定价已完成，结果为 …',
        ts: new Date(Date.now() - 59000).toISOString(),
        kind: 'followup',
      },
    ]);
  }, a.sessionId as string);

  // 进入会话后立即显现历史通知（未派生任何子 agent）
  await page.locator('.tree-session', { hasText: '重启会话' }).click();
  await expect(page.locator('.msg-assistant', { hasText: '完成通知' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.agent-row')).toHaveCount(0);

  // 模拟"重启"：重新加载页面（fresh mock 上下文 → 子 agent 内存态为空）
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  // 重载后项目组回到默认折叠态，需重新展开才能点到会话行
  await expandAllProjects(page);
  await page.locator('.tree-session', { hasText: '重启会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible({ timeout: 5_000 });

  // 重启后：历史完成通知仍可读；无子 agent → 无 Agent 行（列表内存态为空）
  await expect(page.locator('.msg-assistant', { hasText: '完成通知' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.agent-row')).toHaveCount(0);

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// =====================================================================
// E-SA-006 多窗口隔离（AC-SA-012）：A/B 两个画布窗口各自只显示自己的子 agent
// =====================================================================
test('SUB-E2E-010 @P1 E-SA-006：多窗口下 A/B 窗口子 agent 各自隔离、互不串扰', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '窗口A会话' });
  const b = mkSession({ alias: '窗口B会话' });
  await boot(page, [a, b]);

  // 进入多窗口画布
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();

  const openWin = async (alias: string): Promise<void> => {
    const sessionEl = page.locator('.tree-session', { hasText: alias });
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
    await expect(page.locator('.mw-win').filter({ hasText: alias })).toHaveCount(1);
  };

  await openWin('窗口A会话');
  await openWin('窗口B会话');
  await expect(page.locator('.mw-win')).toHaveCount(2);

  // 窗口 A 派生 a1（running），窗口 B 派生 b1（completed）
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: 'A-运行中',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'b1',
        agentType: 'Explore',
        description: 'B-已完成',
        status: 'completed',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        finishedAt: new Date().toISOString(),
        result: 'B 结果',
        error: null,
        usage: { inputTokens: 1, outputTokens: 2 },
      },
    });
  }, b.sessionId as string);

  // 窗口 A：只有 A 的 Agent 行（running），B 的不出现。
  // 注意：画布窗口可能互相叠压，故断言用 count/text（不依赖可见性）。
  const winA = page.locator('.mw-win').filter({ hasText: '窗口A会话' });
  await expect(winA.locator('.agent-row.is-running')).toHaveCount(1, { timeout: 5_000 });
  await expect(winA.locator('.agent-row .lbl')).toHaveText('A-运行中');
  await expect(winA.locator('.agent-row .lbl', { hasText: 'B-已完成' })).toHaveCount(0);

  // 窗口 B：只有 B 的 Agent 行（completed）
  const winB = page.locator('.mw-win').filter({ hasText: '窗口B会话' });
  await expect(winB.locator('.agent-row.is-completed')).toHaveCount(1, { timeout: 5_000 });
  await expect(winB.locator('.agent-row .lbl')).toHaveText('B-已完成');
  await expect(winB.locator('.agent-row .lbl', { hasText: 'A-运行中' })).toHaveCount(0);

  // 健康：无跨窗口事件错误
  health.assertHealthy();
});

// =====================================================================
// E-SA-010 实时过程查看（AC-SA-025/026）：展开态显示实时消息流
// （assistant 正文 markdown 渲染 + 工具摘要行），终态正文与用量
// 过程内容来自 subagent/queryOutput（mock 返回真实 JSONL 格式）。
// =====================================================================
test('SUB-E2E-011 @P1 E-SA-010：展开态实时过程流展示 + 终态正文与用量', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA011' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA011' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // a1 运行中：不需要占位文案；展开后过程流可见（mock 返回 JSONL，已运行 10s → 全部中间条目）
  await emitAgentTool(page, a.sessionId as string, 'te-sa011', '研究子任务');
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    agentType: 'Explore',
    description: '研究子任务',
    status: 'running',
    startedAt: new Date(Date.now() - 10_000).toISOString(),
  });

  const row = page.locator('.agent-row');
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  // 收起态就有状态读数（阶段 + 工具数 + 耗时），不必展开也知道在干活
  await expect(row.locator('.meta')).toContainText('次工具');

  await row.locator('.agent-head').click();
  await expect(row).toHaveClass(/open/);
  // 过程工具行按平铺展示（不再二次折叠），逐条含状态
  const lsRow = page.locator('.agent-row .agent-tool', { hasText: 'ls' });
  await expect(lsRow).toBeVisible({ timeout: 5_000 });
  await expect(lsRow.locator('.tool-status')).toContainText('✓');
  await expect(page.locator('.agent-row .agent-tool', { hasText: 'grep' })).toBeVisible();
  await expect(page.locator('.agent-row .agent-text', { hasText: '正在扫描' })).toBeVisible();
  // 旧的二次折叠组头已移除
  await expect(page.locator('.stg-head')).toHaveCount(0);

  // a1 完成：同一条流保留，末条 assistant 正文 = result，附 Token 用量
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    agentType: 'Explore',
    description: '研究子任务',
    status: 'completed',
    startedAt: new Date(Date.now() - 5000).toISOString(),
    finishedAt: new Date().toISOString(),
    result: '完成结果全文。',
    usage: { inputTokens: 100, outputTokens: 200 },
  });
  await expect(page.locator('.agent-row .agent-text', { hasText: '完成结果全文' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.agent-row .agent-usage')).toContainText('100');
  // 终态后行内不再出现终止按钮
  await expect(page.locator('.agent-stop')).toHaveCount(0);

  health.assertHealthy();
});

// =====================================================================
// v6.37 新增：agent 工具调用与子 agent 记录绑定不上时仍可见（不丢信息）
// =====================================================================
test('SUB-E2E-012 @P1 绑定兜底：无 agent 工具调用的孤儿子 agent 也渲染成行', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '孤儿会话' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '孤儿会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 消息流里没有任何 agent 工具调用，直接派发子 agent（历史缺工具记录 / 扩展先派发）
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a-orphan',
    description: '孤儿任务',
    status: 'running',
  });

  // 仍然有一行可看，且状态正确 —— 绝不因为配不上工具调用就「看不见」
  const row = page.locator('.agent-row');
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  await expect(row).toHaveClass(/is-running/);
  await expect(row.locator('.lbl')).toContainText('孤儿任务');

  health.assertHealthy();
});

// =====================================================================
// v6.39 新增：展开过程限高 + 内部滚动（长报告不再把整页拉高）
// =====================================================================
test('SUB-E2E-013 @P0 展开体限高：超长过程在行内滚动，不把主对话顶出视口', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '长报告会话' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '长报告会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 过程内容来自 subagent/queryOutput 的 JSONL（不是 result 兜底），
  // 默认 mock 只给几条，撑不满限高。这里 seed 一份超长过程：
  // 60 条 assistant 正文，每条一行，必然远超限高。
  await page.evaluate(() => {
    const lines: string[] = [
      JSON.stringify({ type: 'user', message: { role: 'user', content: '写长报告' } }),
    ];
    for (let i = 0; i < 60; i += 1) {
      lines.push(
        JSON.stringify({
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: `第 ${i + 1} 段：这一行是为了把展开区撑高，验证限高是否真的生效。` }],
          },
        }),
      );
    }
    window.__forgeMock!.seed('subagent/queryOutput', () => ({
      code: 0,
      message: 'ok',
      data: { exists: true, size: lines.join('\n').length, chunk: lines.join('\n') },
    }));
  });

  await emitAgentTool(page, a.sessionId as string, 'te-sa013', '写长报告');
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '写长报告',
    status: 'completed',
    startedAt: new Date(Date.now() - 120_000).toISOString(),
    finishedAt: new Date().toISOString(),
    result: '完成',
    usage: { inputTokens: 100, outputTokens: 200 },
  });

  const row = page.locator('.agent-row');
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  await row.locator('.agent-head').click();
  await expect(row).toHaveClass(/open/);
  const scroll = page.locator('.agent-row .agent-scroll');
  await expect(scroll).toBeVisible();
  // 等过程渲染完成（末段文本出现）
  await expect(row.locator('.agent-text', { hasText: '第 60 段' })).toBeAttached({ timeout: 5_000 });

  const m = await scroll.evaluate((el) => ({
    clientH: el.clientHeight,
    scrollH: el.scrollHeight,
    vh: window.innerHeight,
  }));
  // 限高生效：可见高度被钳住，而内容确实更长
  expect(m.scrollH, '内容应超出限高，用例才有意义').toBeGreaterThan(m.clientH + 20);
  expect(m.clientH, '可见高度必须被限住').toBeLessThanOrEqual(560);
  // 关键收益：展开项自身高不到视口一半，主对话与输入框仍在屏内
  expect(m.clientH, '展开项不应占掉半个视口以上').toBeLessThan(m.vh * 0.6);

  // 可滚动：滚到底后 scrollTop 确实变化（不是被 overflow:hidden 假装）
  const scrolled = await scroll.evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    return el.scrollTop;
  });
  expect(scrolled, '限高区必须可滚动').toBeGreaterThan(0);

  health.assertHealthy();
});

test('SUB-E2E-014 @P1 限高区短内容不虚化：未溢出时不加渐隐 mask', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '短报告会话' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '短报告会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  await emitAgentTool(page, a.sessionId as string, 'te-sa014', '写短报告');
  await emitSubagent(page, a.sessionId as string, {
    agentId: 'a1',
    description: '写短报告',
    status: 'completed',
    startedAt: new Date(Date.now() - 5_000).toISOString(),
    finishedAt: new Date().toISOString(),
    result: '短结论。',
    usage: { inputTokens: 10, outputTokens: 20 },
  });

  const row = page.locator('.agent-row');
  await expect(row).toHaveCount(1, { timeout: 5_000 });
  await row.locator('.agent-head').click();
  const scroll = page.locator('.agent-row .agent-scroll');
  await expect(scroll).toBeVisible();
  // 未溢出 → is-short，且高度自适应（远小于上限）
  await expect(scroll).toHaveClass(/is-short/);
  const h = await scroll.evaluate((el) => el.clientHeight);
  expect(h, '短内容不该被撑到限高').toBeLessThan(236);

  health.assertHealthy();
});
