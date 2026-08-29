/**
 * U-CV-008 回看模式状态机单测（AC-CV-016，docs/test/03_conversation/coverage-matrix.md）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts，先例 conversationTimeline.test.ts）。
 * 覆盖（docs/prd/03_conversation.md CV-S06 / TD-CV-06 回看模式语义）：
 * - browse enter(index) → review：autoFollow=false、targetIndex=index、提示条可见；
 * - 重复 enter（同/异条目）等价一次定位：仅更新 targetIndex，无额外状态副作用；
 * - review 中 autoFollow 恒 false：状态机无 delta 事件入口，任何查询/重复 enter 不改 autoFollow；
 * - review 触底信号 nearBottom() 或显式 exit() → browse（autoFollow=true）恰好一次，
 *   连续 nearBottom/exit 幂等无副作用；
 * - exit 后再次 enter 重新进入 review；
 * - reset()（会话切换）→ browse 初始态（browse 下幂等）；
 * - 负向：browse 下 nearBottom/exit 无副作用；非法 index（NaN/负数/小数/Infinity）无副作用；
 * - 全状态字段无 NaN/undefined 泄漏。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createReviewModeController,
  createInitialReviewModeState,
  type ReviewModeState,
} from '../src/utils/reviewMode.ts';

/** 状态机公开事件面：不允许出现任何 delta 流入入口（review 期间 delta 不得影响状态） */
const ALLOWED_METHODS = new Set(['getState', 'enter', 'exit', 'nearBottom', 'reset', 'showBackdownHint']);

/** 断言状态字段全部良构：无 NaN/undefined 泄漏（U-CV-008 负向要求） */
function assertWellFormed(s: ReviewModeState, where: string): void {
  assert.ok(s.mode === 'browse' || s.mode === 'review', `${where}: mode 必须是 browse|review，实际 ${String(s.mode)}`);
  assert.ok(
    s.targetIndex === null || (typeof s.targetIndex === 'number' && Number.isInteger(s.targetIndex) && s.targetIndex >= 0),
    `${where}: targetIndex 必须是 null 或非负整数，实际 ${String(s.targetIndex)}`,
  );
  assert.ok(typeof s.autoFollow === 'boolean', `${where}: autoFollow 必须是 boolean，实际 ${String(s.autoFollow)}`);
  assert.ok(
    (s.mode === 'browse') === s.autoFollow,
    `${where}: autoFollow 必须与 mode 一致（browse→true / review→false）`,
  );
}

// ===== 初始态 =====

test('初始态：browse + autoFollow=true + targetIndex=null，提示条不可见', () => {
  const ctrl = createReviewModeController();
  const s = ctrl.getState();
  assert.deepEqual(s, { mode: 'browse', targetIndex: null, autoFollow: true });
  assert.equal(ctrl.showBackdownHint(), false);
  assertWellFormed(s, 'initial');
  assert.deepEqual(createInitialReviewModeState(), { mode: 'browse', targetIndex: null, autoFollow: true });
});

// ===== browse enter → review =====

test('browse enter(3) → review：autoFollow=false、targetIndex=3、提示条可见', () => {
  const ctrl = createReviewModeController();
  const s = ctrl.enter(3);
  assert.deepEqual(s, { mode: 'review', targetIndex: 3, autoFollow: false });
  assert.deepEqual(ctrl.getState(), { mode: 'review', targetIndex: 3, autoFollow: false });
  assert.equal(ctrl.showBackdownHint(), true);
  assertWellFormed(ctrl.getState(), 'enter');
});

// ===== 重复 enter：等价一次定位，仅更新 target =====

test('review 中重复 enter 异条目：仅更新 targetIndex，autoFollow 保持 false（无额外副作用）', () => {
  const ctrl = createReviewModeController();
  ctrl.enter(2);
  const before = ctrl.getState();
  const after = ctrl.enter(7);
  assert.deepEqual(after, { mode: 'review', targetIndex: 7, autoFollow: false });
  assert.equal(ctrl.showBackdownHint(), true);
  // 除 targetIndex 外无其他字段变化
  assert.equal(before.mode, after.mode);
  assert.equal(before.autoFollow, after.autoFollow);
  assert.notEqual(before.targetIndex, after.targetIndex);
});

test('review 中重复 enter 同条目：状态不变（deepEqual，等价一次定位）', () => {
  const ctrl = createReviewModeController();
  ctrl.enter(4);
  const before = ctrl.getState();
  const after = ctrl.enter(4);
  assert.deepEqual(after, before);
});

// ===== review 中 autoFollow 恒 false（无 delta 入口） =====

test('review 中 autoFollow 恒 false：状态机无 delta 事件入口，重复 enter/查询不放开跟随', () => {
  const ctrl = createReviewModeController();
  ctrl.enter(1);
  // 事件面恰好为声明的六个方法：不存在 onDelta/applyDelta/delta 等流入入口
  const methods = new Set(Object.keys(ctrl));
  assert.deepEqual([...methods].sort(), [...ALLOWED_METHODS].sort());
  // 任何后续交互（重复 enter / 查询）都不产生 autoFollow=true
  for (let i = 0; i < 5; i += 1) {
    ctrl.enter(i);
    assert.equal(ctrl.getState().autoFollow, false, `第 ${i} 次 enter 后 autoFollow 必须仍为 false`);
    assert.equal(ctrl.getState().mode, 'review');
    assert.equal(ctrl.showBackdownHint(), true);
  }
});

// ===== 触底 / 显式退出：恰好一次 =====

test('review nearBottom() → browse（autoFollow=true）恰好一次：连续 nearBottom 幂等', () => {
  const ctrl = createReviewModeController();
  ctrl.enter(5);
  const s1 = ctrl.nearBottom();
  assert.deepEqual(s1, { mode: 'browse', targetIndex: null, autoFollow: true });
  assert.equal(ctrl.showBackdownHint(), false);
  const s2 = ctrl.nearBottom();
  const s3 = ctrl.nearBottom();
  assert.deepEqual(s2, s1);
  assert.deepEqual(s3, s1);
});

test('review exit() → browse：autoFollow 恢复 true；重复 exit 幂等', () => {
  const ctrl = createReviewModeController();
  ctrl.enter(0);
  const s1 = ctrl.exit();
  assert.deepEqual(s1, { mode: 'browse', targetIndex: null, autoFollow: true });
  assert.equal(ctrl.getState().autoFollow, true);
  assert.deepEqual(ctrl.exit(), s1);
});

// ===== exit 后再次 enter 重新进入 review =====

test('exit 后再次 enter：重新进入 review 且 targetIndex 为新值', () => {
  const ctrl = createReviewModeController();
  ctrl.enter(2);
  ctrl.exit();
  const s = ctrl.enter(9);
  assert.deepEqual(s, { mode: 'review', targetIndex: 9, autoFollow: false });
  assert.equal(ctrl.showBackdownHint(), true);
});

// ===== reset（会话切换） =====

test('review 中 reset → browse 初始态；browse 中 reset 幂等', () => {
  const initial = createInitialReviewModeState();
  const ctrl = createReviewModeController();
  ctrl.enter(6);
  assert.deepEqual(ctrl.reset(), initial);
  assert.equal(ctrl.showBackdownHint(), false);
  // browse 中 reset 幂等（无副作用）
  assert.deepEqual(ctrl.reset(), initial);
});

// ===== 负向：browse 下信号无副作用 =====

test('负向：browse 下 nearBottom/exit 无副作用', () => {
  const ctrl = createReviewModeController();
  const before = ctrl.getState();
  assert.deepEqual(ctrl.nearBottom(), before);
  assert.deepEqual(ctrl.exit(), before);
  assert.deepEqual(ctrl.getState(), before);
  assert.equal(ctrl.showBackdownHint(), false);
});

test('负向：非法 index（NaN/负数/小数/Infinity）在 browse 与 review 下均无副作用', () => {
  const bad: number[] = [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY, -Number.POSITIVE_INFINITY];
  const ctrl = createReviewModeController();
  const browseState = ctrl.getState();
  for (const idx of bad) {
    assert.deepEqual(ctrl.enter(idx), browseState, `browse 下 enter(${String(idx)}) 必须无副作用`);
  }
  ctrl.enter(3);
  const reviewState = ctrl.getState();
  for (const idx of bad) {
    assert.deepEqual(ctrl.enter(idx), reviewState, `review 下 enter(${String(idx)}) 必须无副作用`);
  }
  assert.deepEqual(ctrl.getState(), { mode: 'review', targetIndex: 3, autoFollow: false });
});

// ===== 状态字段良构（一系列操作后无 NaN/undefined 泄漏） =====

test('全流程状态字段无 NaN/undefined 泄漏', () => {
  const ctrl = createReviewModeController();
  const steps: Array<() => void> = [
    () => ctrl.enter(0),
    () => ctrl.enter(Number.NaN),
    () => ctrl.enter(12),
    () => ctrl.nearBottom(),
    () => ctrl.exit(),
    () => ctrl.enter(Number.NaN),
    () => ctrl.reset(),
    () => ctrl.nearBottom(),
    () => ctrl.enter(1),
    () => ctrl.exit(),
  ];
  steps.forEach((step, i) => {
    step();
    assertWellFormed(ctrl.getState(), `step ${i}`);
    // 派生提示条可见性与 mode 严格一致
    assert.equal(ctrl.showBackdownHint(), ctrl.getState().mode === 'review', `hint step ${i}`);
  });
});
