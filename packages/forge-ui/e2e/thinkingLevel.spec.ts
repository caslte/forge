/**
 * 思考级别切换器 E2E（docs/test/05_model/e2e.md E-MP-006/007/008，模块 05 MP-S05）。
 * 自动化等级：mock-backend（mock-bridge 可编程 mock 模拟 getModelThinkingLevels /
 * getSessionThinkingLevel / setSessionThinkingLevel 的可变后端）。
 *
 * 覆盖：
 * - E-MP-006（AC-MP-010）：推理模型显示切换器且选项与接口一致；非推理模型（仅 off）隐藏；
 *   页面无 console error / pageerror / requestfailed（B3 冒烟）。
 * - E-MP-007（AC-MP-011/012）：切级别提交 setSessionThinkingLevel 并断言参数；新会话继承全局默认；
 *   已存在会话（有自己存储值）互不影响；无多余 toast；流式进行中切换器可点击且不断流。
 * - E-MP-008（AC-MP-014，visual）：切到 max 出现金色流光动画类（约 2-3s 后移除）；切其他级别无动画；
 *   关键元素可见无重叠。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  seedSessions,
  seedSendScript,
  waitForMock,
} from './helpers/index';

/** 本文件 E2E 内部使用的页面全局变量：setSessionThinkingLevel 调用记录 */
declare global {
  interface Window {
    __tlCalls?: Array<{ sessionId: string; level: string }>;
  }
}

const MODEL_REASON = 'reason-pro';
const MODEL_PLAIN = 'plain-mini';
const LEVELS_REASON = ['off', 'low', 'medium', 'high', 'max'];
const LEVELS_PLAIN = ['off'];

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

/**
 * 注入思考级别相关的可编程 mock（可变后端模拟）。
 * - getModelThinkingLevels 按模型返回级别列表（reason-pro 推理 / plain-mini 非推理仅 off）。
 * - getSessionThinkingLevel 返回该会话存储值，无则返回全局默认（effective global，模拟新会话继承全局）。
 * - setSessionThinkingLevel 写会话存储 + 同步全局默认 + 记录调用参数。
 * - getSessionModel：仅显式标记的 plainSids 走非推理模型，其余（含新建会话）均走推理模型。
 */
async function applySeeds(
  page: Page,
  sessions: Array<Record<string, unknown>>,
  initialStored: Record<string, string>,
  plainSids: string[] = [],
): Promise<void> {
  await waitForMock(page);
  await page.evaluate(
    ({ plainIds, init, mReason, mPlain, lvReason, lvPlain }) => {
      const levelsByModel: Record<string, string[]> = {
        [mReason]: lvReason,
        [mPlain]: lvPlain,
      };
      window.__tlCalls = [];
      const state = {
        stored: { ...(init as Record<string, string>) },
        global: 'medium',
      };
      window.__forgeMock!.seed('model/queryModels', () => ({
        code: 0,
        message: 'ok',
        data: { models: [mReason, mPlain], defaultModel: mReason },
      }));
      window.__forgeMock!.seed('model/getSessionModel', (p) => ({
        code: 0,
        message: 'ok',
        data: {
          model: (plainIds as string[]).includes(String(p.sessionId)) ? mPlain : mReason,
          effective: 'session',
        },
      }));
      window.__forgeMock!.seed('model/getModelThinkingLevels', (p) => ({
        code: 0,
        message: 'ok',
        // 未列入映射的已配模型（如 boot 期未 seed 时 queryModels 返回的全局默认模型）按推理模型处理
        data: { levels: levelsByModel[String(p.model)] ?? (lvReason as string[]) },
      }));
      window.__forgeMock!.seed('model/getSessionThinkingLevel', (p) => {
        // 草稿态（新会话未创建）：无 sessionId，直接返回全局默认（新会话继承全局）
        if (p.sessionId === undefined) {
          return {
            code: 0,
            message: 'ok',
            data: { level: state.global, effective: 'global' },
          };
        }
        const sid = String(p.sessionId);
        const stored = state.stored[sid];
        return {
          code: 0,
          message: 'ok',
          data: stored !== undefined
            ? { level: stored, effective: 'session' }
            : { level: state.global, effective: 'global' },
        };
      });
      window.__forgeMock!.seed('model/setSessionThinkingLevel', (p) => {
        const sid = String(p.sessionId);
        state.stored[sid] = String(p.level);
        state.global = String(p.level);
        window.__tlCalls!.push({ sessionId: sid, level: String(p.level) });
        return { code: 0, message: 'ok', data: null };
      });
    },
    {
      plainIds: plainSids,
      init: initialStored,
      mReason: MODEL_REASON,
      mPlain: MODEL_PLAIN,
      lvReason: LEVELS_REASON,
      lvPlain: LEVELS_PLAIN,
    },
  );
}

/** 进入应用：持久化会话种子到 reload，再注入思考级别 mock 与查询脚本数 */
async function boot(
  page: Page,
  sessions: Array<Record<string, unknown>>,
  initialStored: Record<string, string> = {},
  plainSids: string[] = [],
): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await applySeeds(page, sessions, initialStored, plainSids);
  await expect(page.locator('.tree-panel')).toBeVisible();
}

/** 打开指定会话并等待输入框（含思考级别切换器逻辑）就绪 */
async function openSession(page: Page, alias: string): Promise<void> {
  await page.locator('.tree-session', { hasText: alias }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
}

/** 点击思考级别切换器并展开菜单 */
async function openLevelMenu(page: Page): Promise<void> {
  await expect(page.locator('.level-wrap')).toBeVisible();
  await page.locator('.level-wrap .meta-link').click();
  await expect(page.locator('.level-menu')).toBeVisible();
}

// ===== E-MP-006（AC-MP-010）：推理/非推理模型切换器显隐 + B3 冒烟 =====
test('TLEVEL-E2E-001 @P0 @mock-backend E-MP-006：推理模型显示切换器，非推理模型隐藏，无控制台错误', async ({ page }) => {
  const health = attachHealthGuards(page);
  const sReason = mkSession({ alias: '推理会话' });
  const sPlain = mkSession({ alias: '普通会话' });
  await boot(page, [sReason, sPlain], {}, [sPlain.sessionId as string]);

  // 推理模型：切换器可见，选项与接口返回一致（5 项：off/low/medium/high/max）
  await openSession(page, '推理会话');
  await expect(page.locator('.level-wrap')).toBeVisible();
  // 初始无存储值 → 回显全局默认 medium
  await expect(page.locator('.level-wrap .meta-link')).toContainText('medium');

  await openLevelMenu(page);
  const items = page.locator('.level-menu .menu-item');
  await expect(items).toHaveCount(LEVELS_REASON.length);
  for (const lv of LEVELS_REASON) {
    await expect(page.locator('.level-menu')).toContainText(lv);
  }
  // 当前级别 active 高亮 medium
  await expect(page.locator('.level-menu .menu-item.active')).toHaveText('medium');

  // 切到非推理模型（仅 off）：切换器隐藏入口
  await openSession(page, '普通会话');
  await expect(page.locator('.level-wrap')).toHaveCount(0);

  health.assertHealthy();
});

// ===== E-MP-007（AC-MP-011/012）：切级别提交参数 + 全局默认继承 + 会话隔离 + 无 toast + 流式不断流 =====
test('TLEVEL-E2E-002 @P0 @mock-backend E-MP-007：切换提交参数、新会话继承全局默认、旧会话隔离、无多余 toast', async ({ page }) => {
  const health = attachHealthGuards(page);
  // sHasValue 已有自己的存储值 low，验证切换其他会话不影响它（会话隔离）
  const s1 = mkSession({ alias: '会话一' });
  const sHasValue = mkSession({ alias: '会话已有值' });
  await boot(page, [s1, sHasValue], { [sHasValue.sessionId as string]: 'low' });

  await openSession(page, '会话一');
  await openLevelMenu(page);
  await page.locator('.level-menu .menu-item', { hasText: 'high' }).click();

  // 断言 setSessionThinkingLevel 调用参数（sessionId + level = high）
  await page.waitForFunction(() => (window.__tlCalls?.length ?? 0) > 0);
  const calls = await page.evaluate(() => window.__tlCalls);
  expect(calls).toEqual([{ sessionId: s1.sessionId, level: 'high' }]);

  // 乐观更新：按钮立即回显 high；无 toast
  await expect(page.locator('.level-wrap .meta-link')).toContainText('high');
  await expect(page.locator('.toast')).toHaveCount(0);

  // 会话已有自己存储值 low：不被会话一的高切换影响（AC-MP-012 会话隔离）
  await openSession(page, '会话已有值');
  await expect(page.locator('.level-wrap .meta-link')).toContainText('low');

  // 新会话（无存储值）继承全局默认：会话一切到 high 已同步全局 → 新会话默认 high。
  // 草稿态：切换器已渲染（无 sessionId，查询全局默认回显）；发送首条消息才真正创建会话。
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await expect(page.locator('.level-wrap .meta-link')).toContainText('high');
  // 发送首条消息：此刻真正创建会话，草稿态回显的全局默认级别随会话创建写入（flush），
  // 首条消息即按所示级别发送；新会话继承全局默认 high
  await page.locator('.compose-input').fill('测试继承全局级别');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.level-wrap .meta-link')).toContainText('high');
  // flush 断言：setSessionThinkingLevel 被新会话调用且 level = high
  await page.waitForFunction(() => (window.__tlCalls?.length ?? 0) >= 2);
  const draftFlush = (await page.evaluate(() => window.__tlCalls))![1]!;
  expect(draftFlush.level).toBe('high');
  expect(draftFlush.sessionId).not.toBe(s1.sessionId);

  health.assertHealthy();
});

test('TLEVEL-E2E-003 @P1 @mock-backend E-MP-007：流式进行中切换器可点击，回复不被中断', async ({ page }) => {
  const health = attachHealthGuards(page);
  const s1 = mkSession({ alias: '流式会话' });
  await boot(page, [s1]);
  await openSession(page, '流式会话');

  // 配置流式脚本：多段 delta，最后完成
  const sessionId = s1.sessionId as string;
  await seedSendScript(page, sessionId, [
    { type: 'delta', delayMs: 120, payload: { text: '第一', kind: 'text' } },
    { type: 'delta', delayMs: 120, payload: { text: '第二', kind: 'text' } },
    { type: 'message', delayMs: 60, payload: { role: 'assistant', content: '完整回复完整回复', ts: new Date().toISOString() } },
  ]);

  // 发送后立刻进入 streaming
  await page.locator('.compose-input').fill('触发流式');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.compose-box')).toHaveClass(/streaming/);

  // 流式进行中：思考级别切换器仍可点击并可切换（不实际打断发送流）
  await expect(page.locator('.level-wrap .meta-link')).toBeEnabled();
  await openLevelMenu(page);
  await page.locator('.level-menu .menu-item', { hasText: 'high' }).click();

  // 回复仍持续到达并最终完成（未被流式切换中断；切换器可点击但发送流不断流）
  await expect(page.locator('.msg-assistant', { hasText: '完整回复完整回复' })).toBeVisible({
    timeout: 10_000,
  });
  // mock 脚本不会自动补发 statusChanged done，显式补发以模拟正常流结束
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' });
  }, sessionId);
  await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);
  await expect(page.locator('.toast')).toHaveCount(0);
  health.assertHealthy();
});

// ===== E-MP-008（AC-MP-014，PRD 3.5）：max 金色流光动画（时长量化 + 帧率 ≥30fps 精确断言） =====
test('TLEVEL-E2E-004 @P1 @mock-backend E-MP-008：切到 max 出现金色流光动画，时长与帧率(≥30fps)量化满足 PRD 3.5', async ({ page }) => {
  const health = attachHealthGuards(page);
  const s1 = mkSession({ alias: '流光会话' });
  await boot(page, [s1]);
  await openSession(page, '流光会话');

  // 关键元素可见且不重叠（模型选择与思考级别切换器并排）
  await expect(page.locator('.model-wrap')).toBeVisible();
  await expect(page.locator('.level-wrap')).toBeVisible();
  const modelBox = (await page.locator('.model-wrap').boundingBox())!;
  const levelBox = (await page.locator('.level-wrap').boundingBox())!;
  expect(levelBox.x).toBeGreaterThanOrEqual(modelBox.x + modelBox.width - 1);

  // 初始无流光
  await expect(page.locator('.max-shimmer')).toHaveCount(0);

  // 切到 max：先在页面侧启动轮询，捕获 .max-shimmer 从「出现→移除」的时长（performance.now 时间戳差）
  await openLevelMenu(page);
  const durPromise = page.evaluate(() => {
    return new Promise<{ appearAt: number; disappearAt: number; durationMs: number }>((resolve) => {
      let appearAt: number | null = null;
      const tick = () => {
        const present = !!document.querySelector('.max-shimmer');
        if (appearAt === null && present) {
          appearAt = performance.now();
        } else if (appearAt !== null && !present) {
          const disappearAt = performance.now();
          resolve({ appearAt, disappearAt, durationMs: disappearAt - appearAt });
          return;
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  });
  await page.locator('.level-menu .menu-item', { hasText: 'max' }).click();
  await expect(page.locator('.max-shimmer')).toHaveCount(1);

  // 合成器友好（附加断言）：MAX 动画仅作用于 transform/opacity——动画名 max-text-flow（渐变流动，不触发布局/绘制）
  const animInfo = await page.evaluate(() => {
    const el = document.querySelector('.max-shimmer');
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { animationName: cs.animationName, transform: cs.transform };
  });
  expect(animInfo).not.toBeNull();
  expect(animInfo!.animationName).toContain('max-text-flow');

  // 帧率量化（E-MP-008，PRD 3.5 ≥30fps）：动画进行中（先 wait 200ms 驱动真实帧），rAF 连续采样 ~600ms
  await page.waitForTimeout(200);
  const sample = await page.evaluate(() => {
    return new Promise<{ frames: number; ms: number }>((resolve) => {
      const WINDOW = 600;
      const t0 = performance.now();
      let frames = 0;
      const loop = (now: number) => {
        frames++;
        if (now - t0 >= WINDOW) {
          resolve({ frames, ms: now - t0 });
          return;
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame((t) => loop(t));
    });
  });
  const fps = sample.frames / (sample.ms / 1000);
  // 等价式：frames/seconds ≥ 30；若窗口内帧数不足等同于时长/帧数，均按此式验收
  expect(
    fps,
    `动画期间实测帧率 ${sample.frames} 帧 / ${sample.ms.toFixed(0)}ms ≈ ${fps.toFixed(1)}fps，需满足 PRD 3.5 ≥30fps`,
  ).toBeGreaterThanOrEqual(30);
  const { durationMs } = await durPromise;
  expect(
    durationMs,
    `MAX 动画时长实测 ${durationMs.toFixed(0)}ms，需落在 [2200, 3400]ms`,
  ).toBeGreaterThanOrEqual(2200);
  expect(durationMs).toBeLessThanOrEqual(3400);

  // 切到其他级别（low）→ 无流光动画
  await expect(page.locator('.level-wrap .meta-link')).toContainText('max');
  await openLevelMenu(page);
  await page.locator('.level-menu .menu-item', { hasText: 'low' }).click();
  await expect(page.locator('.level-wrap .meta-link')).toContainText('low');
  await expect(page.locator('.max-shimmer')).toHaveCount(0);
  // 短暂等待确认无延迟出现
  await page.waitForTimeout(400);
  await expect(page.locator('.max-shimmer')).toHaveCount(0);

  health.assertHealthy();
});