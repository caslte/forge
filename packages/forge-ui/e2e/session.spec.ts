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
  listMockSessions,
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

// ===== E-SM-001 新建会话发送首条消息后进入会话池 =====
test('SESSION-E2E-001 @P0 @mock-backend E-SM-001：草稿态不建标签，首条消息后才创建会话并入树', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '已有会话' })]);
  await expect(page.locator('.tree-session')).toHaveCount(1);

  // + 号下方是新建会话入口（app-toolbar 新建会话按钮需在会话视图）
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();

  // 草稿输入态：右侧进入输入区，左侧会话树不新增标签（未发首条消息不创建会话）
  await expect(page.locator('.compose-box')).toBeVisible();
  await expect(page.locator('.tree-session')).toHaveCount(1);
  // 草稿态即可预览当前生效模型（全局默认），而非「选择模型」占位
  await expect(page.locator('.model-wrap .meta-link')).toContainText('deepseek-v4-flash');

  // 发送首条消息：此刻才真正创建会话，树标签出现且标题为首条问题截取
  await page.locator('.compose-input').fill('修复登录鉴权流程中的 BUG');
  await page.locator('.compose-input').press('Enter');

  await expect(page.locator('.tree-session')).toHaveCount(2);
  await expect(page.locator('.tree-session').last()).toContainText('修复登录鉴权');

  // 从 mock 侧确认新增会话别名 = 首条消息截取；注入脚本让流式完整结束
  const sessions = await listMockSessions(page);
  const created = sessions.find((s) => s.sessionId !== undefined && s.alias === '修复登录鉴权流程中的 BUG');
  expect(created).toBeTruthy();

  if (created?.sessionId) {
    await seedSendScript(page, created.sessionId, [
      { type: 'message', delayMs: 30, payload: { role: 'assistant', content: '收到', ts: new Date().toISOString() } },
    ]);
    await expect(page.locator('.msg-assistant', { hasText: '收到' })).toBeVisible({ timeout: 5_000 });
    await page.evaluate(
      ([sid]) => window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' }),
      [created.sessionId] as const,
    );
    await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);
  }

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
  // B 也发一条，与 A 并行流式（验证不串扰）
  await page.locator('.compose-input').fill('B 的问题');
  await page.locator('.compose-input').press('Enter');
  // B 视图显示 B 的流式输出，不出现 A 的内容
  await expect(page.locator('.msg-assistant').first()).toBeVisible({ timeout: 10_000 });
  // 会话 B 的答非所问：B 视图不应含 A 的 token
  await expect(page.locator('.conv-messages')).not.toContainText('A1');

  await page.locator('.tree-session', { hasText: '会话A' }).click();
  await expect(page.locator('.msg-assistant', { hasText: 'A 的完整回答' })).toBeVisible({ timeout: 10_000 });
  await assertNoResidualStreaming(page);
  health.assertHealthy();
});

// ===== 运行中状态点选中态一致性（bugfix 回归） =====
// 复现：选中运行中会话不应隐藏状态点——选中与否状态点始终可见，
// 会话高亮与运行状态点正交，丢任一都会丢信息。
test('SESSION-E2E-002b @P0 @mock-backend：运行中会话选中后状态点仍可见', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话A', status: 'streaming' });
  const b = mkSession({ alias: '会话B' });
  await boot(page, [a, b]);

  const rowA = page.locator('.tree-session', { hasText: '会话A' });
  // 未选中：A 圆点存在（运行中提示）
  await expect(rowA.locator('.tree-session-status-dot.tone-streaming')).toHaveCount(1);

  // 选中 A：会话高亮 + 状态点同时可见（修复前选中会隐藏）
  await rowA.click();
  await expect(rowA).toHaveClass(/active/);
  await expect(rowA.locator('.tree-session-status-dot.tone-streaming')).toHaveCount(1);

  // 切到 B：A 仍 running，A 的状态点同样可见（与选中态解耦）
  await page.locator('.tree-session', { hasText: '会话B' }).click();
  await expect(rowA.locator('.tree-session-status-dot.tone-streaming')).toHaveCount(1);

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

// ===== E-SM-007（回归 v3.48）：新建项目自动选中为草稿归属，草稿保留 =====
test('SESSION-E2E-007 @P0 @mock-backend E-SM-007 回归：新建项目置顶并自动选中为草稿归属', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '已有会话' })]);

  // 草稿态：当前归属 = 首个项目 forge，预填草稿文本验证保留
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await expect(page.locator('.proj-pill')).toContainText('forge');
  await page.locator('.compose-input').fill('留给新项目的草稿');

  // 下拉「打开项目…」→ mock 目录选择器返回 D:/work/aiwork → 注册新项目
  await page.locator('.proj-pill').click();
  await expect(page.locator('.proj-menu')).toBeVisible();
  await page.locator('.proj-item', { hasText: '打开项目…' }).click();

  // 归属自动切到新项目（basename=aiwork），草稿文本保留
  await expect(page.locator('.proj-pill')).toContainText('aiwork');
  await expect(page.locator('.compose-input')).toHaveValue('留给新项目的草稿');
  // 项目树：新项目出现且为选中态（active）
  await expect(page.locator('.tree-project.active')).toContainText('aiwork');
  // 下拉排序：新项目置顶第一
  await page.locator('.proj-pill').click();
  await expect(page.locator('.proj-menu .proj-item-name').first()).toHaveText('aiwork');
  health.assertHealthy();
});

// ===== E-SM-008（回归 v3.66）：冷启动会话树不等待 openProject =====
/** 人为拖慢 openProject 的时长：须远大于 TREE_TIMEOUT_MS，保证 RED/GREEN 可分 */
const SLOW_OPEN_MS = 6_000;
/** 会话树必须在此超时内出现（修复前需等满 SLOW_OPEN_MS） */
const TREE_TIMEOUT_MS = 2_000;
/** mock 默认项目路径（DB.projects[0]），会话种子须归属同一项目才会渲染进树 */
const PROJECT_PATH = 'D:/work/aiwork/forge';

test('SESSION-E2E-008 @P0 @mock-backend E-SM-008 回归：openProject 被拖慢时会话树仍并行渲染', async ({ page }) => {
  const health = attachHealthGuards(page);

  // seed() 与 setSessions 的持久化语义不同：setSessions 落 localStorage（跨 reload 存活），
  // 而 seed() 只活在当前 JS 上下文。mock 句柄由 mock-bridge 在模块初始化时挂到 window，
  // 故用 init script 抢在赋值瞬间注入「慢 openProject + 会话种子」，保证 App.mounted 前就位。
  await page.addInitScript(
    ([slowMs, projectPath]: [number, string]) => {
      const sessions = [
        {
          sessionId: 'sess-startup',
          projectPath,
          alias: '启动即有',
          status: 'idle',
          lastActiveAt: new Date().toISOString(),
        },
      ];
      let real: unknown;
      Object.defineProperty(window, '__forgeMock', {
        configurable: true,
        get: () => real,
        set: (v: {
          seed: (method: string, handler: () => unknown) => void;
          setSessions: (list: unknown[]) => void;
        }) => {
          real = v;
          v.setSessions(sessions);
          // 复刻真实端：openProject 触发 pi 扩展冷编译（jiti 3~9s）占满主进程事件循环时，
          // 该请求自身的 IPC 响应也回不来（修复前前端 loadSessions 就串在它之后）。
          v.seed('project/openProject', () =>
            new Promise((resolve) =>
              setTimeout(
                () => resolve({ code: 0, message: 'ok', data: { path: projectPath } }),
                slowMs,
              ),
            ),
          );
        },
      });
    },
    [SLOW_OPEN_MS, PROJECT_PATH] as [number, string],
  );

  await page.goto('/');
  await expect(page.locator('.tree-panel')).toBeVisible();
  // 项目行先到（queryProjectList 未被拖慢）——复刻用户看到的「项目显示了」
  await expect(page.locator('.tree-project')).toHaveCount(1);

  // 关键断言：会话树必须已随并行查询到位。修复前 loadSessions 串在 openProject 之后，
  // 此处需等满 SLOW_OPEN_MS 才命中 → 用例在 TREE_TIMEOUT_MS 内失败。
  await expect(page.locator('.tree-session')).toHaveCount(1, { timeout: TREE_TIMEOUT_MS });

  health.assertHealthy();
});

void waitForMock;