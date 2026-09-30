/**
 * 消息队列 E2E（CV-S09，方案 C5 + pi TUI ESC 语义停止）。
 *
 * 覆盖：
 * - QC-001：忙时发送 → 入队（徽标），忙完自动派发为 user 气泡并继续回复
 * - QC-002：队列上限 5 条，第 6 条拒绝并 toast 提示，输入框内容保留
 * - QC-003：停止 = 清空队列 + 文本回填输入框（pi TUI ESC 同款，\n\n 拼接）
 * - QC-005：面板重设计（2026-09-29）：宽度对齐输入框文字列、每条一行不换行 +
 *   超出用省略号 + 原生 title 提示全文、序号、动作常驻不靠 hover、「✏ 取回编辑」
 * - QC-006：5 条超长代码仍是一行紧凑列表，面板不顶出窗口
 *
 * 注：面板 DOM 断言一律配 SLOW_SCRIPT（8s 回复）。旧脚本 900ms 下队列会在断言
 * 途中被自动派发、条目消失，QC-001/QC-003 长期红就是这个原因（已确认非产品缺陷）。
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
function script(delayMs: number): { type: 'message'; delayMs: number; payload: Record<string, unknown> }[] {
  return [
    { type: 'message' as const, delayMs, payload: { role: 'assistant', content: 'ok', ts: new Date().toISOString() } },
  ];
}

const SCRIPT = script(900);
/** 面板 / 回填断言专用：8s 够断言跑完，队列不会被自动派发掉 */
const SLOW_SCRIPT = script(8000);

async function boot(page: Page, s: typeof SCRIPT = SCRIPT): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, s);
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, s);
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

test('QC-001 @P0 忙时入队 → 徽标 → 忙完自动派发为 user 气泡', async ({ page }) => {
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
  // 8s 脚本：旧脚本下「排队一」在断言途中就被自动派发出去了，回填只剩一条
  await boot(page, SLOW_SCRIPT);
  await startTurn(page, '首条消息');

  await queueMessage(page, '被撤回甲');
  await queueMessage(page, '被撤回乙');
  await expect(page.locator('.queue-badge')).toHaveText('待发送 2');

  // 停止：队列清空，文本按 \n\n 拼接回填输入框
  await page.locator('.cancel-btn').click();
  await expect(page.locator('.queue-badge')).toHaveCount(0);
  await expect(page.locator('.compose-input')).toHaveValue('被撤回甲\n\n被撤回乙');
});

test('QC-004 @P1 切走再切回：待发送徽标不丢失（队列镜像按会话维护）', async ({ page }) => {
  const guard = attachHealthGuards(page);
  const slowScript = SLOW_SCRIPT;
  await page.goto('/');
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, slowScript);
  await seedSessions(page, [
    mkSession(),
    {
      sessionId: 'e2e-queue-other',
      projectPath: 'D:/work/aiwork/forge',
      alias: '其他会话',
      status: 'idle',
      lastActiveAt: new Date().toISOString(),
    },
  ]);
  await page.reload();
  await waitForMock(page);
  await seedSendScript(page, SESSION_ID, slowScript);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: ALIAS }).click();

  await startTurn(page, '首条消息');
  await queueMessage(page, '排队一');
  const badge = page.locator('.queue-badge');
  await expect(badge).toHaveText('待发送 1');

  // 切走：其他会话无队列，无徽标
  await page.locator('.tree-session', { hasText: '其他会话' }).click();
  await expect(page.locator('.compose-input')).toBeVisible();
  await expect(badge).toHaveCount(0);

  // 切回：徽标仍在（旧缺陷：resetForSession 清空 + 非当前会话事件被丢，徽标永久丢失）
  await page.locator('.tree-session', { hasText: ALIAS }).click();
  await expect(page.locator('.compose-input')).toBeVisible();
  await expect(badge).toHaveText('待发送 1');

  // 收尾：停止流式，避免残留
  await page.locator('.cancel-btn').click();
  guard.assertHealthy();
});

/** QC-005：面板重设计（2026-09-29）。断言的是「宽度/截断/顺序语义」——
 *  这几样是旧面板真正坏掉的地方（旧：min/max 220–340 死宽 + 逐字符折行 + 无序号）。 */
const LONG_PATH =
  'C:\\Users\\chenmo\\AppData\\Local\\Temp\\forge-paste-194849.png';
/** 混排中文的条目：等宽下中文更难扫，不切（utils/queueText.ts 口径） */
const CJK_MIXED = '看下 main.go 里 401 分支的处理';
const CODE_PURE = [
  'async function withRetry(fn, times = 3) {',
  '  let lastErr;',
  '  for (let i = 0; i < times; i += 1) {',
  '    try {',
  '      return await withTimeout(fn(), 5000);',
  '    } catch (e) {',
  '      lastErr = e;',
  '    }',
  '  }',
  '  throw lastErr;',
  '}',
].join('\n');
/** 代码 + 一句中文说明：含 CJK 就不切等宽（但仍然会因超长而出现「展开」——
 *  「切不等宽」与「要不要截断」是两件独立的事，测试要分开钉） */
const CODE_WITH_CJK = `把这个函数改一下，超时也重试：\n${CODE_PURE}`;

test('QC-005 @P0 面板宽度对齐输入框 + 每条一行 + 超出用省略号与 title', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page, SLOW_SCRIPT);
  await startTurn(page, '首条消息');
  await queueMessage(page, LONG_PATH);
  await queueMessage(page, CODE_PURE);
  await queueMessage(page, CJK_MIXED);
  await queueMessage(page, 'ok');
  await queueMessage(page, CODE_WITH_CJK);
  await expect(page.locator('.queue-badge')).toHaveText('待发送 5');

  await page.locator('.queue-badge').click();
  const panel = page.locator('.queue-panel');
  await expect(panel).toBeVisible();

  // 宽度：面板左/右各内缩 15px（1px 边框×2 + 14px 内边距×2），故等于输入框文字列宽。
  // 旧面板挂在徽标上（right:0 + max-width 340），窄窗下宽度与输入框完全无关
  const geom = await page.evaluate(() => {
    const box = document.querySelector('.compose-box') as HTMLElement;
    const panel = document.querySelector('.queue-panel') as HTMLElement;
    return { col: box.clientWidth - 30, panel: panel.getBoundingClientRect().width };
  });
  expect(Math.abs(geom.panel - geom.col)).toBeLessThanOrEqual(1);

  // 序号：派发顺序是队列的核心语义，旧面板完全没有。字数/「下一条」按反馈去掉了
  await expect(panel.locator('.queue-idx')).toHaveText(['1', '2', '3', '4', '5']);
  await expect(panel.locator('.queue-next')).toHaveCount(0);
  await expect(panel.locator('.queue-count')).toHaveCount(0);

  // 路径 / 纯代码切等宽（启发式 utils/queueText.ts）；含 CJK 与普通短句不切
  await expect(panel.locator('.queue-item').nth(0).locator('.queue-item-text')).toHaveClass(/\bmono\b/);
  await expect(panel.locator('.queue-item').nth(1).locator('.queue-item-text')).toHaveClass(/\bmono\b/);
  await expect(panel.locator('.queue-item').nth(2).locator('.queue-item-text')).not.toHaveClass(/\bmono\b/);
  await expect(panel.locator('.queue-item').nth(3).locator('.queue-item-text')).not.toHaveClass(/\bmono\b/);
  await expect(panel.locator('.queue-item').nth(4).locator('.queue-item-text')).not.toHaveClass(/\bmono\b/);

  // 没有「展开/收起」按钮（2026-09-29 反馈去掉），超出的内容改用原生 title 提示全文。
  // 只有真溢出的条目才有 title：能一行读完的不该再悬停出一模一样的全文
  await expect(panel.locator('.queue-more')).toHaveCount(0);
  await expect(panel.locator('.queue-item-text[title]')).toHaveCount(2);
  await expect(panel.locator('.queue-item').nth(1).locator('.queue-item-text')).toHaveAttribute(
    'title',
    CODE_PURE,
  );
  await expect(panel.locator('.queue-item').nth(4).locator('.queue-item-text')).toHaveAttribute(
    'title',
    CODE_WITH_CJK,
  );
  await expect(panel.locator('.queue-item').nth(0).locator('.queue-item-text')).not.toHaveAttribute(
    'title',
    /.*/,
  );

  // 收趟态不换行：nowrap + 横向省略，高度恒为 1 行
  const single = await panel.locator('.queue-item').nth(1).locator('.queue-item-text').evaluate((el) => {
    const cs = getComputedStyle(el);
    const lh = parseFloat(cs.lineHeight);
    return {
      lines: Math.round(el.clientHeight / lh),
      whiteSpace: cs.whiteSpace,
      textOverflow: cs.textOverflow,
      overflowsX: el.scrollWidth > el.clientWidth,
    };
  });
  expect(single.whiteSpace).toBe('nowrap');
  expect(single.textOverflow).toBe('ellipsis');
  expect(single.lines).toBe(1);
  expect(single.overflowsX).toBe(true);

  // 5 条一律单行：面板高度不会因为长粘贴而被撑开
  const rows = await panel.locator('.queue-item-text').evaluateAll((els) =>
    els.map((el) => Math.round(el.getBoundingClientRect().height)),
  );
  for (const h of rows) expect(h).toBeLessThanOrEqual(24);

  // 动作常驻：静止态 0 < opacity < 1（旧的 display:none + hover 浮现）
  const restingOpacity = await panel.locator('.queue-item').nth(0).locator('.queue-item-actions').evaluate(
    (el) => Number(getComputedStyle(el).opacity),
  );
  expect(restingOpacity).toBeGreaterThan(0);
  expect(restingOpacity).toBeLessThan(1);

  // 取回编辑：移出队列 + 回填输入框（与 Esc 停止回填同一套语义）
  await panel.locator('.queue-item').nth(3).locator('.queue-act[aria-label="取回输入框编辑"]').click();
  await expect(page.locator('.compose-input')).toHaveValue('ok');
  await expect(page.locator('.queue-badge')).toHaveText('待发送 4');
  // 回填后面板自动收起（restoreQueuedText 关面板），聚焦回输入框
  await expect(panel).toHaveCount(0);
  await expect(page.locator('.compose-input')).toBeFocused();

  guard.assertHealthy();
});

test('QC-006 @P1 5 条超长代码不撑开面板：仍是一行列表，且不出视口', async ({ page }) => {
  await boot(page, SLOW_SCRIPT);
  await startTurn(page, '首条消息');
  for (let i = 0; i < 5; i += 1) await queueMessage(page, `${CODE_PURE}\n// 第 ${i} 段`);
  await expect(page.locator('.queue-badge')).toHaveText('待发送 5');

  await page.locator('.queue-badge').click();
  const panel = page.locator('.queue-panel');
  await expect(panel).toBeVisible();

  // 封顶：min(52vh, 380px)；且面板底边在输入框顶边之上、顶边不出视口
  const box = await panel.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const input = (document.querySelector('.compose-box') as HTMLElement).getBoundingClientRect();
    return { h: r.height, top: r.top, bottom: r.bottom, inputTop: input.top, vh: window.innerHeight };
  });
  expect(box.h).toBeLessThanOrEqual(Math.min(box.vh * 0.52, 380) + 1);
  expect(box.bottom).toBeLessThanOrEqual(box.inputTop + 1);
  expect(box.top).toBeGreaterThanOrEqual(0);

  // 5 条超长代码：面板仍是 5 行紧凑列表（封顶内），每行都挂了 title
  expect(box.h).toBeLessThan(220);
  const titles = await panel.locator('.queue-item-text[title]').evaluateAll((els) =>
    els.map((el) => el.getAttribute('title') ?? ''),
  );
  expect(titles).toHaveLength(5);
  for (const t of titles) expect(t).toContain('withRetry');
});
