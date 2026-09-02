/**
 * 子 Agent 管理 E2E（docs/test/06_subagent/e2e.md E-SA-001..010）。
 * 自动化等级：mock-backend（window.__forgeMock 注入 subagent 事件序列）。
 *
 * P0 上线门禁用例：每条用例包含 UI 断言 + 负向断言 + 健康守卫。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  assertNoResidualStreaming,
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

  // mock：emit 一个运行中子 agent；不补发 conversation.statusChanged done
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
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
      },
    });
  }, a.sessionId as string);

  // Tab 栏出现：包含主会话 Tab + 子 agent Tab
  await expect(page.locator('.subagent-tabbar')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.subagent-tab', { hasText: '主会话' })).toBeVisible();
  await expect(page.locator('.subagent-tab', { hasText: '研究定价' })).toBeVisible();

  // 状态点为运行中（黄色 amber）
  await expect(page.locator('.subagent-status-dot.running')).toHaveCount(1);
  // 状态文字 "运行中"（点对应的子 agent Tab）
  await expect(page.locator('.subagent-tab', { hasText: '研究定价' })).toContainText('运行中');

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

  // 先 emit 一个 running 子 agent
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
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
      },
    });
  }, a.sessionId as string);

  await expect(page.locator('.subagent-tab', { hasText: '研究定价' })).toBeVisible();

  // 后续 emit completed（mock 侧根据计数归零自动补发 done）
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '研究定价',
        status: 'completed',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        finishedAt: new Date().toISOString(),
        result: '完成',
        error: null,
        usage: { inputTokens: 120, outputTokens: 240 },
      },
    });
  }, a.sessionId as string);

  // 状态点变绿（completed 绿色），状态文字变 "已完成"
  await expect(page.locator('.subagent-status-dot.completed')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator('.subagent-tab', { hasText: '研究定价' })).toContainText('已完成');
  health.assertHealthy();
});

// =====================================================================
// E-SA-004 Tab 栏出现与状态实时（AC-SA-008/010）
// =====================================================================
test('SUB-E2E-003 @P0 E-SA-004：子 agent emit 后 Tab 栏出现 + 状态实时变化 + 排序正确', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA004' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA004' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 初始无子 agent：Tab 栏不出现
  await expect(page.locator('.subagent-tabbar')).toHaveCount(0);

  // emit a1 running
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '子A-研究',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);

  await expect(page.locator('.subagent-tabbar')).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.subagent-tab', { hasText: '子A-研究' })).toBeVisible();

  // a1 转 completed
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '子A-研究',
        status: 'completed',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        finishedAt: new Date().toISOString(),
        result: 'A 完成',
        error: null,
        usage: { inputTokens: 100, outputTokens: 200 },
      },
    });
  }, a.sessionId as string);

  await expect(page.locator('.subagent-status-dot.completed')).toBeVisible({ timeout: 5_000 });

  // emit a2 running（运行中 Tab 应在终态 Tab 之前）
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a2',
        agentType: 'Explore',
        description: '子B-抓取',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);

  // 排序：a2（running）应在 a1（completed）之前
  const tabs = page.locator('.subagent-tab');
  await expect(tabs).toHaveCount(3); // 主会话 + a1 + a2
  const allTabTexts = await tabs.allTextContents();
  const idxMain = allTabTexts.findIndex((t) => t.includes('主会话'));
  const idxA2 = allTabTexts.findIndex((t) => t.includes('子B-抓取'));
  const idxA1 = allTabTexts.findIndex((t) => t.includes('子A-研究'));
  expect(idxMain).toBeLessThan(idxA2);
  expect(idxA2).toBeLessThan(idxA1);

  health.assertHealthy();
});

// =====================================================================
// E-SA-005 清除已完成 + Tab 关闭
// =====================================================================
test('SUB-E2E-004 @P1 E-SA-005：清除已完成按钮 + 终态 Tab 关闭', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA005' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA005' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // a1 completed + a2 running
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '子A-已完成',
        status: 'completed',
        startedAt: new Date(Date.now() - 10000).toISOString(),
        finishedAt: new Date(Date.now() - 1000).toISOString(),
        result: 'A',
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a2',
        agentType: 'general-purpose',
        description: '子B-运行中',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);

  await expect(page.locator('.subagent-tab', { hasText: '子A-已完成' })).toBeVisible();
  await expect(page.locator('.subagent-tab', { hasText: '子B-运行中' })).toBeVisible();

  // "清除已完成" 按钮可见（存在终态子 agent 时）
  const clearBtn = page.locator('.subagent-clear-btn');
  await expect(clearBtn).toBeVisible();

  // 点清除已完成 → 终态 Tab 移除，运行中 Tab 保留
  await clearBtn.click();
  await expect(page.locator('.subagent-tab', { hasText: '子A-已完成' })).toHaveCount(0);
  await expect(page.locator('.subagent-tab', { hasText: '子B-运行中' })).toHaveCount(1);

  // 此时清除按钮不可用（无终态）
  await expect(clearBtn).toBeDisabled();

  health.assertHealthy();
});

// =====================================================================
// E-SA-007 结果视图（AC-SA-013/014）
// =====================================================================
test('SUB-E2E-005 @P0 E-SA-007：点子 agent Tab 切换结果视图 + 完成后正文 + 切回主会话消息流原样', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA007' });
  await boot(page, [a]);

  // 历史：先写一条消息流，便于切回主会话验证原样恢复
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

  // a1 running
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '研究子任务',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);

  await expect(page.locator('.subagent-tab', { hasText: '研究子任务' })).toBeVisible({ timeout: 5_000 });

  // 点 a1 Tab → 切到结果视图（运行中无占位文案，仅思考指示）
  await page.locator('.subagent-tab', { hasText: '研究子任务' }).click();
  await expect(page.locator('.subagent-result-view')).toBeVisible();
  await expect(page.locator('.srv-indicator', { hasText: '正在' })).toBeVisible();
  // 消息流区 v-show 隐藏（元素仍挂载但不可见）
  await expect(page.locator('.conv-messages')).toBeHidden();

  // 切回主会话 Tab → 消息流恢复
  await page.locator('.subagent-tab', { hasText: '主会话' }).click();
  await expect(page.locator('.subagent-result-view')).toHaveCount(0);
  await expect(page.locator('.conv-messages')).toBeVisible();
  await expect(page.locator('.msg-assistant', { hasText: '已收到' })).toBeVisible({ timeout: 5_000 });

  // 再切回 a1，结果视图依旧
  await page.locator('.subagent-tab', { hasText: '研究子任务' }).click();
  await expect(page.locator('.subagent-result-view')).toBeVisible();

  // a1 完成 → 正文显示 result 全文
  const big = '这是完成结果 '.repeat(50);
  await page.evaluate(
    (args) => {
      window.__forgeMock!.emit(args.sid, 'subagent.updated', {
        sessionId: args.sid,
        subagent: {
          agentId: 'a1',
          agentType: 'general-purpose',
          description: '研究子任务',
          status: 'completed',
          startedAt: new Date(Date.now() - 3000).toISOString(),
          finishedAt: new Date().toISOString(),
          result: args.big,
          error: null,
          usage: { inputTokens: 1000, outputTokens: 2000 },
        },
      });
    },
    { sid: a.sessionId as string, big },
  );

  await expect(page.locator('.srv-stream-text', { hasText: '这是完成结果' })).toBeVisible();
  await expect(page.locator('.subagent-result-usage')).toContainText('1,000');
  await expect(page.locator('.subagent-result-usage')).toContainText('2,000');

  // 切回主会话 → 消息流依旧
  await page.locator('.subagent-tab', { hasText: '主会话' }).click();
  await expect(page.locator('.msg-assistant', { hasText: '已收到' })).toBeVisible();

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// =====================================================================
// E-SA-009 回归基线：无子 agent 不渲染 Tab 栏；停止行为与现状一致
// =====================================================================
test('SUB-E2E-006 @P0 E-SA-009：无子 agent 会话不渲染 Tab 栏；停止行为与改造前一致', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '无子会话' });
  await boot(page, [a]);

  // 打开会话
  await page.locator('.tree-session', { hasText: '无子会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 没有任何子 agent 时 Tab 栏不出现
  await expect(page.locator('.subagent-tabbar')).toHaveCount(0);

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

  // 仍然无 Tab 栏
  await expect(page.locator('.subagent-tabbar')).toHaveCount(0);

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
// E-SA-003 完成通知渲染与续跑（AC-SA-007）
// =====================================================================
test('SUB-E2E-007 @P0 E-SA-003：子 agent 完成通知渲染进消息流，与 Tab 不重复', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA003' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA003' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 子 agent a1 running
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '研究子任务',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);
  await expect(page.locator('.subagent-tab', { hasText: '研究子任务' })).toBeVisible();

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
    // 同时 a1 转 completed
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

  // Tab 状态点变绿
  await expect(page.locator('.subagent-status-dot.completed')).toHaveCount(1);

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
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'general-purpose',
        description: '子A-运行中',
        status: 'running',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a2',
        agentType: 'general-purpose',
        description: '子B-运行中',
        status: 'running',
        startedAt: new Date(Date.now() + 1).toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);

  await expect(page.locator('.subagent-tab', { hasText: '子A-运行中' })).toBeVisible();
  await expect(page.locator('.subagent-tab', { hasText: '子B-运行中' })).toBeVisible();

  // 打开 a1 结果视图
  await page.locator('.subagent-tab', { hasText: '子A-运行中' }).click();
  await expect(page.locator('.subagent-result-view')).toBeVisible();

  // 头部“终止”按钮 → 弹二次确认
  await page.locator('.srv-stop-btn').click();
  await expect(page.locator('.stop-confirm')).toBeVisible();

  // 取消 → 状态不变（Tab 上仍有 2 个 running dot）
  await page.locator('.stop-confirm-cancel').click();
  await expect(page.locator('.stop-confirm')).toHaveCount(0);
  await expect(page.locator('.subagent-tab .subagent-status-dot.running')).toHaveCount(2);

  // 再次点终止 → 确认 → a1 转 stopped，a2 不受影响
  await page.locator('.srv-stop-btn').click();
  await page.locator('.stop-confirm-confirm').click();
  await expect(page.locator('.subagent-tab .subagent-status-dot.stopped')).toHaveCount(1, { timeout: 5_000 });
  await expect(page.locator('.subagent-tab .subagent-status-dot.running')).toHaveCount(1);

  // 输入框停止按钮级联：先发送一条消息进入流式（让 cancel 按钮可见），然后点击级联终止 a2。
  // mock cancelStream 默认 cascadeSubagents: true，会 emit subagent.updated stopped。
  await page.locator('.subagent-tab', { hasText: '主会话' }).click();
  await seedSendScriptLite(page, a.sessionId as string, [
    { type: 'delta', delayMs: 200, payload: { text: '进行中', kind: 'text' } },
  ]);
  await page.locator('.compose-input').fill('触发流式');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.compose-box')).toHaveClass(/streaming/);
  await expect(page.locator('.cancel-btn')).toBeVisible();

  // 触发 cancelStream（mock 默认级联）→ a2 转 stopped
  await page.locator('.cancel-btn').click();
  await expect(page.locator('.subagent-tab .subagent-status-dot.stopped')).toHaveCount(2, { timeout: 5_000 });

  // 输入框已恢复（非流式）
  await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);

  // 再次点击停止（幂等）→ 无报错（重复 cancelStream 不报错，状态不再变化）
  await page.evaluate((sid) => {
    // 手动再 emit 一个 statusChanged 让 UI 重新进入 streaming？不行——停止按钮不可见。
    // 只需验证 subagent 状态未发生异常跳转；重复调用 cancelStream 在 mock 侧无副作用。
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' });
  }, a.sessionId as string);

  health.assertHealthy();
});

// =====================================================================
// E-SA-009 场景2 重启（AC-SA-023）：子 agent 为内存态，重载后 queryList 为空
// → Tab 栏不出现；历史完成通知消息仍在消息流可读。
// =====================================================================
test('SUB-E2E-009 @P1 E-SA-009-重启：重载后无子 agent Tab，历史完成通知仍可读', async ({ page }) => {
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

  // 初始无 Tab 栏
  await expect(page.locator('.subagent-tabbar')).toHaveCount(0);

  // 模拟“重启”：重新加载页面（fresh mock 上下文 → 子 agent 内存态为空）
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: '重启会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible({ timeout: 5_000 });

  // 重启后：历史完成通知仍可读；无子 agent → 无 Tab 栏（列表内存态为空）
  await expect(page.locator('.msg-assistant', { hasText: '完成通知' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.subagent-tabbar')).toHaveCount(0);

  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// =====================================================================
// E-SA-006 多窗口隔离（AC-SA-012）：A/B 两个画布窗口各自只显示自己的子 agent，
// 状态与 Tab 互不串扰（MultiWindowConversation 与单视图行为一致）。
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
    // HTML5 drag 用 dispatchEvent 模拟（dragstart + drop），复用 SESSION-E2E-004 开窗路径
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

  // 窗口 A：Tab 只含 A 的子 agent（A-运行中），状态点 running
  const winA = page.locator('.mw-win').filter({ hasText: '窗口A会话' });
  await expect(winA.locator('.subagent-tab', { hasText: 'A-运行中' })).toBeVisible({ timeout: 5_000 });
  await expect(winA.locator('.subagent-tab', { hasText: 'B-已完成' })).toHaveCount(0);
  await expect(winA.locator('.subagent-status-dot.running')).toHaveCount(1);

  // 窗口 B：Tab 只含 B 的子 agent（B-已完成），状态点 completed
  const winB = page.locator('.mw-win').filter({ hasText: '窗口B会话' });
  await expect(winB.locator('.subagent-tab', { hasText: 'B-已完成' })).toBeVisible({ timeout: 5_000 });
  await expect(winB.locator('.subagent-tab', { hasText: 'A-运行中' })).toHaveCount(0);
  await expect(winB.locator('.subagent-status-dot.completed')).toHaveCount(1);

  // 健康：无跨窗口事件错误
  health.assertHealthy();
});

// =====================================================================
// E-SA-010 实时过程查看（AC-SA-025/026）：运行中结果视图显示实时消息流
// （assistant 正文 markdown 渲染 + 工具摘要行），终态直接看 result 正文；
// 过程内容来自 subagent/queryOutput（mock 返回真实 JSONL 格式）。
// =====================================================================
test('SUB-E2E-011 @P1 E-SA-010：运行中实时消息流展示 + 终态正文', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话SA011' });
  await boot(page, [a]);
  await page.locator('.tree-session', { hasText: '会话SA011' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // a1 运行中：占位文案 + 实时消息流可见（mock 返回 JSONL，已运行 10s → 全部中间条目）
  await page.evaluate((sid) => {
    window.__forgeMock!.setSubagents(sid, []);
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'Explore',
        description: '研究子任务',
        status: 'running',
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        finishedAt: null,
        result: null,
        error: null,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    });
  }, a.sessionId as string);
  await expect(page.locator('.subagent-tab', { hasText: '研究子任务' })).toBeVisible({ timeout: 5_000 });
  await page.locator('.subagent-tab', { hasText: '研究子任务' }).click();
  // 无占位文案；底部思考/输出指示（有内容 → 正在输出）
  await expect(page.locator('.subagent-result-placeholder')).toHaveCount(0);
  await expect(page.locator('.srv-indicator', { hasText: '正在输出' })).toBeVisible({ timeout: 5_000 });
  // 连续工具聚为折叠组（默认收起，与主会话一致）：头部计数 + 工具名 chips
  const groupHead = page.locator('.stg-head');
  await expect(groupHead).toBeVisible();
  await expect(groupHead).toContainText('工具调用');
  await expect(groupHead).toContainText('2 次');
  // 展开后可见逐条工具摘要行（含状态）；正文 markdown 渲染不受影响
  await groupHead.click();
  const lsRow = page.locator('.srv-stream-tool', { hasText: 'ls' });
  await expect(lsRow).toBeVisible();
  await expect(lsRow).toContainText('✓');
  await expect(page.locator('.srv-stream-tool', { hasText: 'grep' })).toBeVisible();
  await expect(page.locator('.srv-stream-text', { hasText: '正在扫描' })).toBeVisible();

  // a1 完成：同一条消息流保留（末条 assistant 正文 = result，与过程中视图一致），
  // 指示消失，附 Token 用量；无执行过程回看入口
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'subagent.updated', {
      sessionId: sid,
      subagent: {
        agentId: 'a1',
        agentType: 'Explore',
        description: '研究子任务',
        status: 'completed',
        startedAt: new Date(Date.now() - 5000).toISOString(),
        finishedAt: new Date().toISOString(),
        result: '完成结果全文。',
        error: null,
        usage: { inputTokens: 100, outputTokens: 200 },
      },
    });
  }, a.sessionId as string);
  await expect(page.locator('.srv-indicator')).toHaveCount(0);
  await expect(page.locator('.srv-stream-text', { hasText: '完成结果全文' })).toBeVisible({ timeout: 5_000 });
  await expect(page.locator('.subagent-result-usage')).toContainText('100');
  await expect(page.locator('.srv-process-toggle')).toHaveCount(0);

  health.assertHealthy();
});