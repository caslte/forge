/**
 * ask_user_question 内嵌问卷 E2E（docs/test/03_conversation/e2e.md E-CV-026/027/028，
 * 模块 03 CV-S12）。
 *
 * 覆盖：
 * - E-CV-026（AC-CV-043/044/045/046/050）：面板渲染 / 标题行操作条（底部无操作条）/
 *   向导式步骤导航（末步才渲染「提交答案」）/ 单选自动前进 / 多选不前进 /
 *   「自己答」折叠为选项末位一行（单选互斥、多选并列）/ preview 固定高度不跳动 /
 *   分栏 1.4:1 / 预览列表黑点在框内 / 0 答禁用提交 / 回填原始 label / 答完即收
 * - E-CV-027（AC-CV-047/048）：倒计时 >0 且递减（首屏挂载的响应式回归）/ 归零回填
 *   「已答部分 + cancelled」/ 非本会话的问卷不认领
 * - E-CV-028（AC-CV-043 运行期健康）：**首屏对话区必须渲染**。
 *   这一条是本文件存在的主因 —— v3.71 引入的「`showAnswered` 声明在 watch 之后」
 *   让组件 setup 撞 TDZ（`Cannot access 'showAnswered' before initialization`），
 *   组件渲染中断并**连累整个 ConversationView 更新失败**，真机表现为「左侧项目/会话树
 *   正常、右侧对话区整块空白」。组件层没有单测设施（forge-ui 只测纯函数），
 *   若没有浏览器级用例，这类「声明顺序」崩溃只能靠真机试出来。
 *
 * 自动化等级：mock-backend（mock-bridge.emit 注入 conversation.askUserQuestionRequested）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSessions } from './helpers/index';

const SESSION_ID = 'e2e-ask-session';
/** 非本会话 id：用于「问卷只在发起会话的窗格弹出」的负向断言 */
const OTHER_SESSION_ID = 'e2e-ask-other';

/** 带列表的 preview（黑点/序号必须在框内，且标记间换行不得渲染成空行） */
const PREVIEW_A = '- 优点：改动一行，风险最小\n- 缺点：依赖声明顺序\n1. 先复现\n2. 再补锁\n   - 嵌套项';
const PREVIEW_B = '- 优点：不依赖顺序\n- 缺点：多一个 computed';

interface AskOption {
  label: string;
  description: string;
  preview?: string;
  recommended?: boolean;
}
interface AskQuestion {
  question: string;
  header: string;
  options: AskOption[];
  multiSelect?: boolean;
}

/** 2 题问卷：第 1 题单选带 preview（含推荐项），第 2 题多选 */
const Q1: AskQuestion = {
  question: '用哪种方案修复右侧对话区空白？',
  header: '方案选择',
  options: [
    { label: 'A 方案：调整声明顺序', description: '一行改动', preview: PREVIEW_A, recommended: true },
    { label: 'B 方案：换 watch 源 (Recommended)', description: '不动顺序', preview: PREVIEW_B },
  ],
};
const Q2: AskQuestion = {
  question: '还要补哪些回归锁？',
  header: '回归项',
  multiSelect: true,
  // 多选不提供预览（契约 §1.1）：这里故意带上 preview，断言不得出现分栏
  options: [
    { label: '单元测试', description: '纯函数', preview: PREVIEW_A },
    { label: 'E2E', description: '浏览器级', preview: PREVIEW_B },
  ],
};

function mkSession(sessionId = SESSION_ID, alias = '问卷会话'): Record<string, unknown> {
  return {
    sessionId,
    projectPath: 'D:/work/aiwork/forge',
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 启动并选中会话（面板挂载在会话作用域，需 compose-box 在场） */
async function boot(page: Page, sessions: Array<Record<string, unknown>> = [mkSession()]): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();
}

/** 注入一份问卷请求（载荷带必需 sessionId，与真机 conversation.askUserQuestionRequested 同形） */
async function emitAsk(
  page: Page,
  payload: { sessionId?: string; requestId: string; questions: AskQuestion[]; timeoutMs: number },
): Promise<void> {
  await page.evaluate(
    ([sid, p]) => {
      // @ts-expect-error: __forgeMock 注入在 window
      window.__forgeMock.emit(sid, 'conversation.askUserQuestionRequested', p);
    },
    [payload.sessionId ?? SESSION_ID, payload] as const,
  );
}

/** 注入问卷工具完成事件（权威 details 覆盖乐观摘要） */
async function emitAskCompleted(
  page: Page,
  details: Record<string, unknown>,
): Promise<void> {
  await page.evaluate(
    ([sid, d]) => {
      // @ts-expect-error: __forgeMock 注入在 window
      window.__forgeMock.emit(sid, 'tool.completed', {
        toolEventId: `ask-${Date.now()}-${Math.random()}`,
        tool: { name: 'ask_user_question', input: {} },
        result: { text: 'answered', image: null, details: d },
      });
    },
    [SESSION_ID, details] as const,
  );
}

/** 读取 mock 侧最近一次回填载荷 */
async function lastReply(page: Page): Promise<Record<string, unknown> | null> {
  return page.evaluate(() => window.__forgeMock!.getLastAskUserReply());
}

const panel = (page: Page) => page.locator('[data-testid="ask-panel"]');

/** 一次 evaluate 内取全部几何（避免两次测量之间消息区自动滚动造成基准漂移） */
interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
function geom(
  page: Page,
): Promise<{ head: Rect | null; next: Rect | null; preview: Rect | null; panel: Rect | null }> {
  return page.evaluate(() => {
    const rect = (sel: string): Rect | null => {
      const el = document.querySelector(sel) as HTMLElement | null;
      if (el === null) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, width: r.width, height: r.height };
    };
    return {
      head: rect('[data-testid="ask-heading"]'),
      next: rect('[data-testid="ask-next"]'),
      preview: rect('[data-testid="ask-preview"]'),
      panel: rect('[data-testid="ask-panel"]'),
    };
  });
}

// ===== E-CV-026 渲染 / 操作条位置 / 步骤导航 / 自动前进 / 推荐标记 / preview 尺寸 =====
test('ASK-E2E-001 @P0 @mock-backend E-CV-026：面板渲染在输入框上方 + 操作条在标题行 + 末步才可提交', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await boot(page);

  // 触发前：面板不存在（无问卷时不占位）
  await expect(panel(page)).toHaveCount(0);
  await emitAsk(page, { requestId: 'r1', questions: [Q1, Q2], timeoutMs: 60_000 });

  await expect(panel(page)).toBeVisible();
  // 面板在输入框 wrap 内（与 TodoPanel 同款「从输入框延伸出去」的浮窗）
  await expect(page.locator('.conv-input-wrap [data-testid="ask-panel"]')).toHaveCount(1);
  await expect(page.locator('[data-testid="ask-heading-text"]')).toHaveText(Q1.question);

  // N+1 tab（2 题 + 备注）
  await expect(page.locator('.ask-tab')).toHaveCount(3);

  // 首步：无「上一题」、有「下一题」、**无「提交答案」**（中间步不得提交 → 规避 0 答提交 ≡ 取消）
  await expect(page.locator('[data-testid="ask-prev"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ask-next"]')).toBeVisible();
  await expect(page.locator('[data-testid="ask-submit"]')).toHaveCount(0);

  // 操作条在标题行内（与标题、状态徽标同一行）；面板底部无操作条
  const gHead = await geom(page);
  expect(gHead.head).not.toBeNull();
  expect(gHead.next).not.toBeNull();
  expect(
    gHead.next!.y >= gHead.head!.y && gHead.next!.y <= gHead.head!.y + gHead.head!.height,
  ).toBe(true);
  await expect(panel(page).locator('> .ask-foot, .ask-footer')).toHaveCount(0);
  await expect(page.locator('[data-testid="ask-progress"]')).toHaveText('已答 0/2');

  // 推荐标记（双通道：显式 recommended 与 label 尾部后缀）——标签显示层剥离后缀
  await expect(page.locator('[data-testid="ask-recommended-tag"]')).toHaveCount(2);
  await expect(page.locator('[data-testid="ask-option-1"] .ask-option-name')).toHaveText('B 方案：换 watch 源');

  // 单选 + 带 preview → 左右分栏，预览列窄于选项列（约 1.4:1）
  await expect(page.locator('[data-testid="ask-preview"]')).toHaveCount(1);
  // 等首屏自适应滚动/进入动画落地，再取基准几何（否则测到的是动画中间态）
  await page.waitForTimeout(400);
  const g0 = await geom(page);
  const optList = await page.locator('[data-testid="ask-option-list"]').boundingBox();
  expect(optList && g0.preview && optList.width > g0.preview.width).toBe(true);
  // 固定 240px（不要改回 height:auto，否则 hover 不同选项时整块面板上下跳）
  expect(Math.round(g0.preview!.height)).toBe(240);

  // hover 另一选项：面板自身高度与「预览相对面板」的位置都不得变化
  //（只比面板高度与相对偏移，不比绝对 y —— 消息区自身滚动/动画也会让绝对坐标漂移）
  await page.locator('[data-testid="ask-option-1"]').hover();
  const g1 = await geom(page);
  expect(Math.round(g1.preview!.height)).toBe(240);
  expect(Math.round(g1.panel!.height)).toBe(Math.round(g0.panel!.height));
  expect(Math.abs(g1.preview!.y - g1.panel!.y - (g0.preview!.y - g0.panel!.y))).toBeLessThanOrEqual(1);

  // 单选点中普通选项 → 自动前进到第 2 题（tab 选中态与标题同步）
  await page.locator('[data-testid="ask-option-0"]').click();
  await expect(page.locator('[data-testid="ask-heading-text"]')).toHaveText(Q2.question);
  await expect(page.locator('[data-testid="ask-progress"]')).toHaveText('已答 1/2');
  await expect(page.locator('[data-testid="ask-prev"]')).toBeVisible();

  // 多选：无分栏（多选不给预览）、勾选不自动前进
  await expect(page.locator('[data-testid="ask-preview"]')).toHaveCount(0);
  await expect(page.locator('.ask-multi-hint')).toBeVisible();
  await page.locator('[data-testid="ask-option-0"]').click();
  await expect(page.locator('[data-testid="ask-heading-text"]')).toHaveText(Q2.question);
  await page.locator('[data-testid="ask-option-1"]').click();
  await expect(page.locator('[data-testid="ask-heading-text"]')).toHaveText(Q2.question);

  // 走到末步（备注 tab）才出现「提交答案」
  await page.locator('[data-testid="ask-next"]').click();
  await expect(page.locator('[data-testid="ask-global-note"]')).toBeVisible();
  await expect(page.locator('[data-testid="ask-submit"]')).toBeVisible();
  await expect(page.locator('[data-testid="ask-next"]')).toHaveCount(0);

  // 「上一题」回到第 2 题 → 提交按钮又消失（顺序不强制但按钮严格随步骤）
  await page.locator('[data-testid="ask-prev"]').click();
  await expect(page.locator('[data-testid="ask-submit"]')).toHaveCount(0);

  health.assertHealthy();
});

// ===== E-CV-026 「自己答」形态（单选互斥 / 多选并列）+ 预览列表排版 =====
test('ASK-E2E-002 @P0 @mock-backend E-CV-026：「自己答」是选项末位一行，多选下与已勾选项并列', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await boot(page);
  await emitAsk(page, { requestId: 'r2', questions: [Q1, Q2], timeoutMs: 60_000 });

  // 未选中时不渲染输入框（无占位高度）
  await expect(page.locator('[data-testid="ask-custom-input"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ask-option-custom"]')).toBeVisible();

  // 单选：点普通选项 → 自动前进；回退后点「自己答」→ 展开输入框且**不前进**
  await page.locator('[data-testid="ask-option-0"]').click();
  await expect(page.locator('[data-testid="ask-heading-text"]')).toHaveText(Q2.question);
  await page.locator('[data-testid="ask-prev"]').click();
  await page.locator('[data-testid="ask-option-custom"]').click();
  await expect(page.locator('[data-testid="ask-custom-input"]')).toBeVisible();
  await expect(page.locator('[data-testid="ask-option-custom"]')).toHaveClass(/selected/);
  // 单选互斥：普通选项已取消勾选
  await expect(page.locator('[data-testid="ask-option-0"]')).not.toHaveClass(/selected/);

  // 单选下点普通选项 → 自动前进（断言改在回退后做：自动前进会把「ask-option-0」指到第 2 题）
  await page.locator('[data-testid="ask-custom-input"]').fill('残留文本');
  await page.locator('[data-testid="ask-option-0"]').click();
  await expect(page.locator('[data-testid="ask-heading-text"]')).toHaveText(Q2.question);
  await page.locator('[data-testid="ask-prev"]').click(); // 回到第 1 题
  await expect(page.locator('[data-testid="ask-option-0"]')).toHaveClass(/selected/);
  // 「自己答」行取消并清空文本（避免残留 custom 静默覆盖刚选的 option）
  await expect(page.locator('[data-testid="ask-option-custom"]')).not.toHaveClass(/selected/);
  await page.locator('[data-testid="ask-option-custom"]').click();
  await expect(page.locator('[data-testid="ask-custom-input"]')).toHaveValue('');

  // 多选并列：勾 2 个选项后点「自己答」，已勾选项保持勾选；收起输入框文本不丢、行仍高亮
  await page.locator('[data-testid="ask-option-0"]').click(); // 单选自动前进到第 2 题
  await expect(page.locator('[data-testid="ask-heading-text"]')).toHaveText(Q2.question);
  await page.locator('[data-testid="ask-option-0"]').click();
  await page.locator('[data-testid="ask-option-1"]').click();
  await page.locator('[data-testid="ask-option-custom"]').click();
  await page.locator('[data-testid="ask-custom-input"]').fill('自定义补充');
  await expect(page.locator('[data-testid="ask-option-0"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-testid="ask-option-1"]')).toHaveClass(/selected/);
  await page.locator('[data-testid="ask-option-custom"]').click(); // 收起
  await expect(page.locator('[data-testid="ask-custom-input"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="ask-option-custom"]')).toHaveClass(/selected/);
  await expect(page.locator('[data-testid="ask-progress"]')).toHaveText('已答 2/2');

  // 预览列表排版：黑点在框内（padding-left 不得被 global.css 的 * 重置吃掉为 0）
  await page.locator('[data-testid="ask-tab-0"]').click();
  await expect(page.locator('[data-testid="ask-preview"]')).toHaveCount(1);
  const listMetrics = await page.evaluate(() => {
    const body = document.querySelector('[data-testid="ask-preview"] .ask-preview-body') as HTMLElement;
    const ul = body.querySelector('ul') as HTMLElement;
    return {
      paddingLeft: getComputedStyle(ul).paddingLeft,
      listStylePosition: getComputedStyle(ul).listStylePosition,
      ulLeft: ul.getBoundingClientRect().left,
      bodyLeft: body.getBoundingClientRect().left,
      whiteSpace: getComputedStyle(ul).whiteSpace,
    };
  });
  expect(listMetrics.paddingLeft).not.toBe('0px');
  expect(listMetrics.listStylePosition).toBe('outside');
  // 列表内容盒不越过预览框左边界（黑点由 1.3em 内边距托在框内）
  expect(listMetrics.ulLeft).toBeGreaterThanOrEqual(listMetrics.bodyLeft);
  // pre-wrap 不得把标记间换行渲染成空行
  expect(listMetrics.whiteSpace).toBe('normal');

  health.assertHealthy();
});

// ===== E-CV-026 0 答禁用提交 + 回填载荷 + 答完即收（AC-CV-050） =====
test('ASK-E2E-003 @P0 @mock-backend E-CV-026/050：0 答禁用提交；提交后摘要亮 1.5s 即收起且不复活', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await boot(page);
  await emitAsk(page, { requestId: 'r3', questions: [Q1, Q2], timeoutMs: 60_000 });

  // 0 答走到末步：提交按钮存在但禁用（点它不得产生任何回填）
  await page.locator('[data-testid="ask-tab-note"]').click();
  const submit = page.locator('[data-testid="ask-submit"]');
  await expect(submit).toBeVisible();
  await expect(submit).toBeDisabled();
  await submit.click({ force: true });
  await page.waitForTimeout(200);
  await expect(panel(page)).toBeVisible();
  expect(await lastReply(page)).toBeNull();

  // 只填备注、一题未选 → 仍禁用
  await page.locator('[data-testid="ask-global-note"]').fill('仅备注');
  await expect(submit).toBeDisabled();

  // 作答 2 题（第 1 题单选、第 2 题多选 + 自定义并入末位）→ 按钮可用
  await page.locator('[data-testid="ask-tab-0"]').click();
  await page.locator('[data-testid="ask-option-0"]').click(); // 自动前进到第 2 题
  await page.locator('[data-testid="ask-option-0"]').click();
  await page.locator('[data-testid="ask-option-1"]').click();
  await page.locator('[data-testid="ask-option-custom"]').click();
  await page.locator('[data-testid="ask-custom-input"]').fill('自定义补充');
  await page.locator('[data-testid="ask-tab-note"]').click();
  await expect(submit).toBeEnabled();
  await submit.click();

  // 回填载荷：单选 → kind='option' + 原始 label（显示层剥离后缀，回填不得剥离）；
  // 多选 → kind='multi' + selected 保持勾选顺序 + 自定义文本并入末位（不另起 custom 条目）
  await expect
    .poll(async () => (await lastReply(page)) !== null, { timeout: 3_000 })
    .toBe(true);
  const reply = (await lastReply(page))! as {
    sessionId: string;
    requestId: string;
    cancelled: boolean;
    answers: Array<{ kind: string; answer: string | null; selected?: string[] }>;
    globalNote?: string;
  };
  expect(reply.sessionId).toBe(SESSION_ID);
  expect(reply.requestId).toBe('r3');
  expect(reply.cancelled).toBe(false);
  expect(reply.globalNote).toBe('仅备注');
  expect(reply.answers).toHaveLength(2);
  expect(reply.answers[0]).toMatchObject({ kind: 'option', answer: 'A 方案：调整声明顺序' });
  expect(reply.answers[1]).toMatchObject({
    kind: 'multi',
    answer: null,
    selected: ['单元测试', 'E2E', '自定义补充'],
  });

  // 已答摘要先出现（让「已答 2/2」能被看到），约 1.5s 后整体卸载（答完即收）
  await expect(page.locator('[data-testid="ask-answered-summary"]')).toBeVisible();
  await expect(panel(page)).toHaveCount(0, { timeout: 5_000 });
  await expect(page.locator('[data-testid="ask-answered-summary"]')).toHaveCount(0);

  // 迟到的权威 tool.completed 不得把摘要/面板顶回来（suppressed 抑制集）
  await emitAskCompleted(page, {
    answers: reply.answers,
    cancelled: false,
    globalNote: '仅备注',
  });
  await page.waitForTimeout(2_000);
  await expect(panel(page)).toHaveCount(0);

  // 切走再切回：该轮摘要也不得复活
  await page.locator('.tree-session').first().click();
  await page.waitForTimeout(300);
  await expect(panel(page)).toHaveCount(0);

  // 同一会话再来一轮 → 新面板正常出现（新一轮问卷解除抑制）
  await emitAsk(page, { requestId: 'r4', questions: [Q1], timeoutMs: 60_000 });
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('[data-testid="ask-progress"]')).toHaveText('已答 0/1');

  health.assertHealthy();
});

// ===== E-CV-027 倒计时 / 归零回填 / 会话隔离 =====
test('ASK-E2E-004 @P0 @mock-backend E-CV-027：读秒 >0 且递减；归零回填已答部分（cancelled）', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await boot(page);
  // timeoutMs 取 5s：足够断言「首屏即有读数且递减」，又不至于让用例等太久
  await emitAsk(page, { requestId: 'r5', questions: [Q1, Q2], timeoutMs: 5_000 });

  const live = page.locator('[data-testid="ask-meta-live"]');
  await expect(live).toBeVisible();

  /** 读当前剩余秒数 */
  const readSeconds = async (): Promise<number> => {
    const text = (await live.textContent()) ?? '';
    const m = /(\d+)\s*s/.exec(text);
    return m === null ? -1 : Number(m[1]);
  };

  // 首屏读数必须 > 0（真机曾因 deadline 表非响应式 → computed 缓存首屏 null → 恒 0）
  const first = await readSeconds();
  expect(first).toBeGreaterThan(0);
  await page.waitForTimeout(1_200);
  const second = await readSeconds();
  expect(second).toBeGreaterThan(0);
  expect(second).toBeLessThan(first);

  // 先答一题（第 1 题单选）→ 第 2 题不动：归零时应只回填已答部分
  await page.locator('[data-testid="ask-option-0"]').click();
  await expect(page.locator('[data-testid="ask-progress"]')).toHaveText('已答 1/2');

  // 归零：主动回填「已答部分 + cancelled:true」（不干等主进程超时）
  await expect
    .poll(async () => (await lastReply(page)) !== null, { timeout: 12_000 })
    .toBe(true);
  const reply = (await lastReply(page))! as {
    requestId: string;
    cancelled: boolean;
    answers: Array<{ kind: string; answer: string | null }>;
  };
  expect(reply.requestId).toBe('r5');
  expect(reply.cancelled).toBe(true);
  expect(reply.answers).toHaveLength(1);
  expect(reply.answers[0]).toMatchObject({ kind: 'option', answer: 'A 方案：调整声明顺序' });

  // 超时也走「答完即收」（不得因 cancelled 且 answers 非空被误判为送达失败而留下过期卡片）
  await expect(panel(page)).toHaveCount(0, { timeout: 5_000 });

  health.assertHealthy();
});

test('ASK-E2E-005 @P0 @mock-backend E-CV-027：非本会话的问卷不认领（多窗格隔离）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession(SESSION_ID), mkSession(OTHER_SESSION_ID, '另一会话')]);
  await page.locator('.tree-session').filter({ hasText: '问卷会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 别的会话的问卷不得在当前窗格弹出
  await emitAsk(page, {
    sessionId: OTHER_SESSION_ID,
    requestId: 'other-1',
    questions: [Q1],
    timeoutMs: 60_000,
  });
  await page.waitForTimeout(500);
  await expect(panel(page)).toHaveCount(0);

  // 切到该会话才认领
  await page.locator('.tree-session').filter({ hasText: '另一会话' }).click();
  await emitAsk(page, {
    sessionId: OTHER_SESSION_ID,
    requestId: 'other-2',
    questions: [Q1],
    timeoutMs: 60_000,
  });
  await expect(panel(page)).toBeVisible();

  health.assertHealthy();
});

// ===== E-CV-028 首屏健康：对话区必须渲染（v3.71 空白 bug 的回归锁） =====
test('ASK-E2E-006 @P0 @mock-backend E-CV-028：首屏右侧对话区渲染且无未捕获错误', async ({ page }) => {
  const health = attachHealthGuards(page);

  await page.goto('/');
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();

  // 对话区三件套：视图容器 / 输入区 wrap / 输入框本体
  // （AskUserQuestionPanel 常驻挂载在 wrap 内，setup 抛错会把这三者一起打空）
  await expect(page.locator('.conv-view')).toHaveCount(1);
  await expect(page.locator('.conv-input-wrap')).toBeVisible();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 无问卷时面板不占位
  await expect(panel(page)).toHaveCount(0);

  // 输入框可用（能聚焦并输入 —— 渲染中断时 DOM 可能存在但事件系统已死）
  const editor = page.locator('.compose-box textarea');
  await editor.click();
  await editor.type('渲染健康自检');
  await expect(editor).toHaveValue(/渲染健康自检/);

  health.assertHealthy();
});
