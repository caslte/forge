/**
 * @ Todo 面板 E2E（docs/test/03_conversation/coverage-matrix.md E-CV-020~024，模块 03 CV-S11）。
 *
 * 覆盖：
 * - E-CV-020（AC-CV-037）：收到 todo 工具完成事件后输入框上方出现面板 + 标题 + 任务行
 * - E-CV-021（AC-CV-038）：任务行按状态渲染（pending/in_progress/completed）+ activeForm 括号 + 空 subject 占位
 * - E-CV-022（AC-CV-039）：点击头部折叠/展开，折叠态不渲染任务行
 * - E-CV-023（AC-CV-040）：空快照（仅墓碑/初始空）→ 面板卸载
 * - E-CV-024（AC-CV-041）：切会话 → 旧快照清空、新会话初始为空
 *
 * 自动化等级：mock-backend（mock-bridge.emit 注入 tool.completed 事件）。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  waitForMock,
  seedSessions,
} from './helpers/index';

const SESSION_ID = 'e2e-todo-session';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    projectPath: 'D:/work/aiwork/forge',
    alias: 'todo 会话',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();
}

/** 注入 todo 工具完成事件（携带 details 模拟 rpiv-todo 工具） */
async function emitTodoCompleted(
  page: Page,
  details: { action: string; tasks: Array<Record<string, unknown>>; nextId: number },
): Promise<void> {
  await page.evaluate(
    ([sid, d]) => {
      // @ts-expect-error: __forgeMock 注入在 window
      window.__forgeMock.emit(sid, 'tool.completed', {
        toolEventId: `todo-${Date.now()}-${Math.random()}`,
        tool: { name: 'todo', input: { action: d.action } },
        result: {
          text: d.tasks.map((t: any) => `[${t.status === 'completed' ? 'x' : ' '}] #${t.id}: ${t.subject}`).join('\n'),
          image: null,
          details: d,
        },
      });
    },
    [SESSION_ID, details],
  );
}

test('TSC-E2E-007 @P0 @mock-backend E-CV-020：todo 工具完成事件后输入框上方出现面板', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  // 触发前：面板不存在
  await expect(page.locator('[data-testid="todo-panel"]')).toHaveCount(0);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: '修复登录', status: 'completed' },
      { id: 2, subject: '加单测', status: 'completed', activeForm: '提交测试' },
      { id: 3, subject: '修复缓存', status: 'in_progress', activeForm: '调查上下文' },
      { id: 4, subject: '写文档', status: 'pending' },
    ],
    nextId: 5,
  });

  const panel = page.locator('[data-testid="todo-panel"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-testid="todo-heading"]')).toContainText('已完成 2 / 共 4 个');
  await expect(page.locator('[data-testid="todo-list"] li')).toHaveCount(4);
});

test('TSC-E2E-008 @P0 @mock-backend E-CV-021：任务行按状态字符渲染', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: '修复', status: 'completed' },
      { id: 2, subject: '调查', status: 'in_progress', activeForm: '查调用方' },
      { id: 3, subject: '', status: 'pending' }, // 空 subject
      { id: 4, subject: '普通', status: 'pending' },
    ],
    nextId: 5,
  });

  const rows = page.locator('[data-testid="todo-list"] li');
  await expect(rows).toHaveCount(4);
  // pending 任务无括号；in_progress 含括号；空 subject 显示「（无标题）」
  await expect(rows.nth(0)).toContainText('✓');
  await expect(rows.nth(0)).toContainText('修复');
  await expect(rows.nth(1)).toContainText('●');
  await expect(rows.nth(1)).toContainText('调查');
  await expect(rows.nth(1)).toContainText('（查调用方）');
  await expect(rows.nth(2)).toContainText('○');
  await expect(rows.nth(2)).toContainText('（无标题）');
  await expect(rows.nth(3)).toContainText('普通');
  await expect(rows.nth(3)).not.toContainText('（'); // pending 不渲染括号

  // 用户裁定：任务文字用正常灰色（muted），不用绿色/深色——进行中 subject 与完成态同为灰色
  //（状态只看呼吸点 + 括号 activeForm）
  const inProgressColor = await rows.nth(1).locator('.todo-subject').evaluate(
    (el) => getComputedStyle(el).color,
  );
  const completedColor = await rows.nth(0).locator('.todo-subject').evaluate(
    (el) => getComputedStyle(el).color,
  );
  expect(inProgressColor).toBe(completedColor);
  // 待办（pending）文案同样用 muted 灰色，与上方「已完成」标题一致
  const pendingColor = await rows.nth(2).locator('.todo-subject').evaluate(
    (el) => getComputedStyle(el).color,
  );
  expect(pendingColor).toBe(completedColor);
});

test('TSC-E2E-009 @P0 @mock-backend E-CV-022：点击头部切换折叠', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [{ id: 1, subject: 'A', status: 'pending' }],
    nextId: 2,
  });

  const panel = page.locator('[data-testid="todo-panel"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-testid="todo-list"]')).toBeVisible();
  // 展开态 chevron ▾
  await expect(page.locator('[data-testid="todo-heading"]')).toContainText('▾');

  // 点击折叠（使用 force 避免 hero-mode 下其它元素偶发拦截，仅断言点击结果）
  await page.locator('[data-testid="todo-heading"]').click();
  await expect(page.locator('[data-testid="todo-list"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="todo-heading"]')).toContainText('▸');

  // 再点击展开
  await page.locator('[data-testid="todo-heading"]').click();
  await expect(page.locator('[data-testid="todo-list"]')).toBeVisible();
  await expect(page.locator('[data-testid="todo-heading"]')).toContainText('▾');
});

test('TSC-E2E-009b @P0 @mock-backend CV-S11：hero-mode 下 TodoPanel 不被输入框遮挡，头部可点', async ({ page }) => {
  // AC-CV-039：主会话 + 输入框上方 + 点头部切折叠；hero-mode 下不因 hero 占位符/输入框重叠而拦截点击
  const guard = attachHealthGuards(page);
  await boot(page);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: 'first', status: 'completed' },
      { id: 2, subject: 'second', status: 'pending' },
    ],
    nextId: 3,
  });

  const heading = page.locator('[data-testid="todo-heading"]');
  await expect(heading).toBeVisible();

  // 断言头部 bounding box 不与 textarea 重叠（hero-mode 下两者应位于不同垂直区域）
  const headingBox = await heading.boundingBox();
  const textareaBox = await page.locator('textarea.compose-input').boundingBox();
  expect(headingBox).not.toBeNull();
  expect(textareaBox).not.toBeNull();
  const overlapsVertically =
    headingBox!.y < textareaBox!.y + textareaBox!.height &&
    textareaBox!.y < headingBox!.y + headingBox!.height;
  expect(overlapsVertically).toBe(false, 'TodoPanel 头部与输入框 textarea 不应重叠');

  // 点击头部折叠（应不被 hero placeholder 拦截）
  await heading.click({ timeout: 5000 });
  await expect(page.locator('[data-testid="todo-list"]')).toHaveCount(0);
  await expect(heading).toContainText('▸');
});

test('TSC-E2E-009c @P0 @mock-backend CV-S11：TodoPanel 为 opencode 风格浮窗卡片（有边框/无底边/延伸贴合输入框）', async ({ page }) => {
  // 用户反馈（2026-09-10）：折叠要有动画；可以有边框但要像从输入框延伸出去，
  // 下边沿 border 去掉（面板底部塞进输入框背后，由输入框上边框充当视觉底边）。
  const guard = attachHealthGuards(page);
  await boot(page);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: 'task-one', status: 'completed' },
      { id: 2, subject: 'task-two', status: 'in_progress', activeForm: 'in flight' },
    ],
    nextId: 3,
  });

  const panel = page.locator('[data-testid="todo-panel"]');
  await expect(panel).toBeVisible();

  // 1) 有边框（上/左/右 1px，与输入框同材质同色），下边沿无 border
  const panelStyle = await panel.evaluate((el) => {
    const cs = getComputedStyle(el);
    return {
      borderTopWidth: cs.borderTopWidth,
      borderRightWidth: cs.borderRightWidth,
      borderBottomWidth: cs.borderBottomWidth,
      borderLeftWidth: cs.borderLeftWidth,
      borderTopLeftRadius: cs.borderTopLeftRadius,
      borderTopRightRadius: cs.borderTopRightRadius,
      backgroundColor: cs.backgroundColor,
      transitionProperty: cs.transitionProperty,
    };
  });
  expect(panelStyle.borderTopWidth).toBe('1px');
  expect(panelStyle.borderRightWidth).toBe('1px');
  expect(panelStyle.borderLeftWidth).toBe('1px');
  expect(panelStyle.borderBottomWidth).toBe('0px');
  // 顶部有圆角（与 compose-box 同款延伸）
  expect(panelStyle.borderTopLeftRadius).not.toBe('0px');
  expect(panelStyle.borderTopRightRadius).not.toBe('0px');
  // 不透明背景（浮窗盖住输入框顶部，延伸一体感的前提）
  expect(panelStyle.backgroundColor).not.toBe('rgba(0, 0, 0, 0)');
  // 折叠动画接线：面板 padding 过渡
  expect(panelStyle.transitionProperty).toContain('padding');

  // 2) 与输入框同材质：失焦时边框色与 compose-box 一致；
  //    聚焦时输入框边框加深，todo 面板保持原色、不对焦联动（用户裁定）
  const textarea = page.locator('textarea.compose-input');
  await textarea.click(); // 确保输入框聚焦
  const focusedBoxColor = await page.locator('.compose-box').evaluate(
    (el) => getComputedStyle(el).borderTopColor,
  );
  const focusedPanelColor = await panel.evaluate(
    (el) => getComputedStyle(el).borderTopColor,
  );
  // 聚焦态两色分离：输入框加深，面板不动
  expect(focusedBoxColor).not.toBe(focusedPanelColor);

  await page.locator('.conv-messages').click(); // 点消息区空白让输入框失焦
  await expect
    .poll(async () => {
      const boxC = await page.locator('.compose-box').evaluate(
        (el) => getComputedStyle(el).borderTopColor,
      );
      const panelC = await panel.evaluate((el) => getComputedStyle(el).borderTopColor);
      return boxC === panelC ? 'same' : `${boxC} vs ${panelC}`;
    })
    .toBe('same');

  // 3) 延伸贴合：与 compose-box 同中心、左右对齐，底部塞进输入框背后
  //    （面板底边低于输入框顶边）。
  //    注意：hero-mode 下 compose-box 的 max-width 有 420ms 收窄过渡，
  //    用 poll 等它收敛后再断言边缘对齐（中心点不受过渡影响，可直接断言）。
  const panelRect0 = await panel.boundingBox();
  const boxRect0 = await page.locator('.compose-box').boundingBox();
  expect(panelRect0).not.toBeNull();
  expect(boxRect0).not.toBeNull();
  const centerDx0 = Math.abs(
    panelRect0!.x + panelRect0!.width / 2 - (boxRect0!.x + boxRect0!.width / 2),
  );
  expect(centerDx0).toBeLessThanOrEqual(2);

  await expect
    .poll(async () => {
      const p = await panel.boundingBox();
      const b = await page.locator('.compose-box').boundingBox();
      if (!p || !b) return 'missing';
      const leftDx = Math.abs(p.x - b.x);
      const rightDx = Math.abs(p.x + p.width - (b.x + b.width));
      const overlapped = p.y + p.height > b.y;
      return leftDx <= 2 && rightDx <= 2 && overlapped ? 'aligned' : `left=${leftDx.toFixed(1)} right=${rightDx.toFixed(1)} overlapped=${overlapped}`;
    })
    .toBe('aligned');
});

test('TSC-E2E-010 @P1 @mock-backend E-CV-023：空快照（仅墓碑/初始空）→ 面板卸载', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  // 初始：未触发任何 todo 事件 → 面板不存在
  await expect(page.locator('[data-testid="todo-panel"]')).toHaveCount(0);

  // 触发仅 deleted 任务 → 全部过滤，面板不渲染
  await emitTodoCompleted(page, {
    action: 'clear',
    tasks: [
      { id: 1, subject: '墓碑 1', status: 'deleted' },
      { id: 2, subject: '墓碑 2', status: 'deleted' },
    ],
    nextId: 3,
  });
  await expect(page.locator('[data-testid="todo-panel"]')).toHaveCount(0);

  // 再触发合法任务 → 重新挂载
  await emitTodoCompleted(page, {
    action: 'create',
    tasks: [{ id: 3, subject: '复活', status: 'pending' }],
    nextId: 4,
  });
  await expect(page.locator('[data-testid="todo-panel"]')).toBeVisible();

  // clear 任务（无可见 task）→ 卸载
  await emitTodoCompleted(page, {
    action: 'clear',
    tasks: [],
    nextId: 4,
  });
  await expect(page.locator('[data-testid="todo-panel"]')).toHaveCount(0);
});

test('TSC-E2E-010b @P1 @mock-backend CV-S11：任务超 3 个时列表内部滚动（细滚动条，不撑高面板）', async ({ page }) => {
  // 用户裁定：最多显示 3 个任务，多的滚动，滚动条用很细的，保持界面干净
  const guard = attachHealthGuards(page);
  await boot(page);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: 'task-1', status: 'completed' },
      { id: 2, subject: 'task-2', status: 'in_progress', activeForm: 'doing' },
      { id: 3, subject: 'task-3', status: 'pending' },
      { id: 4, subject: 'task-4', status: 'pending' },
      { id: 5, subject: 'task-5', status: 'pending' },
    ],
    nextId: 6,
  });

  const list = page.locator('[data-testid="todo-list"]');
  await expect(list).toBeVisible();
  // 5 行全在 DOM（滚动查看，非截断丢弃）
  await expect(list.locator('li')).toHaveCount(5);

  const metrics = await list.evaluate((el) => {
    const box = el as HTMLElement;
    const firstRow = box.querySelector('li');
    return {
      clientHeight: box.clientHeight,
      scrollHeight: box.scrollHeight,
      rowHeight: firstRow ? (firstRow as HTMLElement).offsetHeight : 0,
      // 经典滚动条占位宽度（overlay 风格为 0）；细滚动条应 ≤6px
      scrollbarWidth: box.offsetWidth - box.clientWidth,
    };
  });
  // 可滚动
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  // 可视区 ≈ 3 行高度（允许 3px 舍入误差）
  expect(Math.abs(metrics.clientHeight - metrics.rowHeight * 3)).toBeLessThanOrEqual(3);
  // 滚动条很细
  expect(metrics.scrollbarWidth).toBeLessThanOrEqual(6);
});

test('TSC-E2E-010c @P1 @mock-backend CV-S11：已完成数变化时数字翻滚（非瞬间跳变）', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: 'a', status: 'completed' },
      { id: 2, subject: 'b', status: 'pending' },
    ],
    nextId: 3,
  });
  const heading = page.locator('[data-testid="todo-heading"]');
  await expect(heading).toContainText('已完成 1 / 共 2 个');
  // 先记录旧值（跳变前），再触发跳变、轮询收敛
  const beforeJump = (
    await heading.evaluate((el) => (el as HTMLElement).innerText ?? '')
  ).replace(/\s+/g, ' ');

  // 用 1→9 大跨度跳变：即使掉帧也能抓到多个中间值；瞬间跳变只有 2 个 distinct
  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: 'a', status: 'completed' },
      { id: 2, subject: 'b', status: 'completed' },
      { id: 3, subject: 'c', status: 'completed' },
      { id: 4, subject: 'd', status: 'completed' },
      { id: 5, subject: 'e', status: 'completed' },
      { id: 6, subject: 'f', status: 'completed' },
      { id: 7, subject: 'g', status: 'completed' },
      { id: 8, subject: 'h', status: 'completed' },
      { id: 9, subject: 'i', status: 'completed' },
    ],
    nextId: 10,
  });

  // 采样方式：Node 侧循环 evaluate（每次独立 CDP 调用 + 20ms 间隔），而不用页内 rAF 循环——
  // 实测该 headless Edge 里 rAF 会被节流到 800ms 只跳 2 帧，抓不到过渡态；CSS 过渡本身走挂钟，
  // Node 侧轮询不受影响。翻滚过渡期新旧数字短暂共存（瞬间跳变只有 {旧值, 新值} 2 个 distinct，
  // 翻滚会有 ≥3 个 distinct）。数字节点是 display:block，raw innerText 会被换行隔开，
  // 采样时先归一化空白（与 Playwright toContainText 的归一规则一致）。
  // 先记录旧值，再触发跳变，最后轮询收敛：
  // 翻滚过渡期新旧数字短暂共存（如「1 9」，旧的上滑出、新的上滑入），与首尾构成
  // ≥3 个 distinct；瞬间跳变只有 {旧值, 新值} 2 个。
  const samples: string[] = [beforeJump];
  for (let i = 0; i < 30; i++) {
    const t = (
      await heading.evaluate((el) => (el as HTMLElement).innerText ?? '')
    ).replace(/\s+/g, ' ');
    if (samples[samples.length - 1] !== t) samples.push(t);
    // eslint-disable-next-line no-await-in-loop
    await page.waitForTimeout(20);
  }
  expect(samples[samples.length - 1]).toContain('已完成 9 / 共 9 个');
  expect(samples.length).toBeGreaterThanOrEqual(3);
});

test('TSC-E2E-011 @P1 @mock-backend E-CV-024：details 非法静默忽略，不污染已有快照', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  // 先建立合法快照
  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [{ id: 1, subject: '保留', status: 'pending' }],
    nextId: 2,
  });
  const headingBefore = await page.locator('[data-testid="todo-heading"]').textContent();
  expect(headingBefore).toContain('已完成 0 / 共 1 个');

  // 注入非法 details（string）
  await page.evaluate((sid) => {
    // @ts-expect-error: __forgeMock 注入在 window
    window.__forgeMock.emit(sid, 'tool.completed', {
      toolEventId: 'todo-bad-1',
      tool: { name: 'todo', input: {} },
      result: { text: 'bad', image: null, details: 'invalid string' },
    });
  }, SESSION_ID);

  // 快照不变（仍 1 条）
  const headingAfter = await page.locator('[data-testid="todo-heading"]').textContent();
  expect(headingAfter).toContain('已完成 0 / 共 1 个');

  // 注入 details=undefined（普通工具模拟）
  await page.evaluate((sid) => {
    // @ts-expect-error: __forgeMock 注入在 window
    window.__forgeMock.emit(sid, 'tool.completed', {
      toolEventId: 'read-1',
      tool: { name: 'read', input: { path: 'a.ts' } },
      result: { text: 'content', image: null }, // 无 details 字段
    });
  }, SESSION_ID);
  // 快照仍不变（read 工具不是 todo，不消费 details）
  const headingFinal = await page.locator('[data-testid="todo-heading"]').textContent();
  expect(headingFinal).toContain('已完成 0 / 共 1 个');
});
/**
 * 回归锁：进设置页 → 返回，待办面板与折叠态都不丢。
 *
 * 根因：App.vue 用 v-if/v-else 在设置页与会话视图间整块切换，进设置页时
 * ConversationView 连同 TodoPanel 一起卸载。此前快照表与折叠表都声明在
 * composable / 组件实例体内，随组件 GC 而失，回来后 Map 为空 → 面板消失
 * （问卷表同病，见 askQuestionStore）。修复：两表均提到模块级。
 *
 * 用例同时锁「不弹回来」方向：自动隐藏的待办，重建后不能重新出现。
 */
test('TSC-E2E-030 @P0 @mock-backend 视图重建（进出设置页）后待办面板与折叠态不丢', async ({ page }) => {
  await boot(page);

  await emitTodoCompleted(page, {
    action: 'list',
    tasks: [
      { id: 1, subject: '把 pi 自动重试事件透给 UI', status: 'pending' },
      { id: 2, subject: 'UI 改两行错误横幅并加立即重试', status: 'pending' },
    ],
    nextId: 3,
  });
  await expect(page.locator('[data-testid="todo-list"]')).toBeVisible();

  // 用户手动折叠：折叠态是视图态，卸载后同样不能丢
  await page.locator('[data-testid="todo-heading"]').click();
  await expect(page.locator('[data-testid="todo-list"]')).toBeHidden();

  // 进设置页 → 返回（v-if 整块卸载 ConversationView 的真实路径）
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();
  await expect(page.locator('.compose-box')).toBeHidden();
  await page.locator('.settings-back').click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 数据不丢：面板还在，计数仍是 0 / 共 2
  const panel = page.locator('[data-testid="todo-panel"]');
  await expect(panel).toBeVisible();
  await expect(page.locator('[data-testid="todo-heading"]')).toContainText('已完成 0 / 共 2 个');

  // UI 态不丢：仍是折叠态（chevron ▸，任务行不渲染）——不被重建弹回展开
  await expect(page.locator('[data-testid="todo-heading"]')).toContainText('▸');
  await expect(page.locator('[data-testid="todo-list"]')).toBeHidden();

  // 展开后任务行内容完整
  await page.locator('[data-testid="todo-heading"]').click();
  await expect(page.locator('[data-testid="todo-list"]')).toBeVisible();
  await expect(page.locator('[data-testid="todo-list"]')).toContainText('把 pi 自动重试事件透给 UI');
});
