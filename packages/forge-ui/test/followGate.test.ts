/**
 * 自动跟随门控单测（Issue1：auto-scroll 打断用户上滚，utils/followGate.ts）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts，先例 reviewMode.test.ts）。
 * 覆盖的回归点（全部对应旧实现 `scrolledUpBy > 2 && 距底 > 40px` 的两个缺陷）：
 * - 假阴性：触控板第一下 1px 上移必须也能脱离跟随（旧 2px 阈值会漏掉，随后被 delta 钉底拽回）；
 * - 假阳性：无输入意图却出现的 scrollTop 减少（布局 clamp / smooth 被打断 / 扩窗锚定）不得 detach；
 * - 意图保鲜期边界：窗口内信任、窗口外不信任；
 * - 距底判定：仍在底部附近不上滚不进回看态；下滚（scrolledUpBy<=0）不脱离。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createFollowGate,
  isScrollIntentKey,
  NEAR_BOTTOM_PX,
  USER_SCROLL_INTENT_MS,
} from '../src/utils/followGate.ts';

const T0 = 1_000_000;

test('1px 上移 + 新鲜意图 → 脱离跟随（旧 2px 阈值会漏掉这一下）', () => {
  const gate = createFollowGate();
  gate.markUserIntent(T0);
  assert.equal(gate.onScroll(T0 + 10, 1, 800), true);
});

test('无意图的 scrollTop 减少 → 不脱离（布局 clamp / smooth 被打断属程序性位移）', () => {
  const gate = createFollowGate();
  // 从未 markUserIntent：即使上移 300px 也不 detach
  assert.equal(gate.onScroll(T0, 300, 900), false);
});

test('意图过期后的惯性 scroll 事件不再被信任', () => {
  const gate = createFollowGate();
  gate.markUserIntent(T0);
  assert.equal(gate.isUserIntentFresh(T0 + USER_SCROLL_INTENT_MS - 1), true);
  assert.equal(gate.isUserIntentFresh(T0 + USER_SCROLL_INTENT_MS), false);
  // 窗口内先脱离一次即可（进入回看态后 autoFollow 恒 false）
  assert.equal(gate.onScroll(T0 + 5, 40, 900), true);
  // 窗口外：同向位移不再重复判定
  assert.equal(gate.onScroll(T0 + USER_SCROLL_INTENT_MS + 5, 40, 900), false);
});

test('连续输入刷新保鲜期（触控板/惯性滚动）', () => {
  const gate = createFollowGate();
  gate.markUserIntent(T0);
  gate.markUserIntent(T0 + 300);
  assert.equal(gate.isUserIntentFresh(T0 + 300 + USER_SCROLL_INTENT_MS - 1), true);
  assert.equal(gate.isUserIntentFresh(T0 + 300 + USER_SCROLL_INTENT_MS), false);
});

test('clearUserIntent 后立即不信任（会话切换作废陈旧输入）', () => {
  const gate = createFollowGate();
  gate.markUserIntent(T0);
  gate.clearUserIntent();
  assert.equal(gate.isUserIntentFresh(T0 + 1), false);
  assert.equal(gate.onScroll(T0 + 1, 120, 900), false);
});

test('仍在底部附近不上滚进回看态；下滚不脱离', () => {
  const gate = createFollowGate();
  gate.markUserIntent(T0);
  // 距底 <= NEAR_BOTTOM_PX：还贴着底部
  assert.equal(gate.onScroll(T0, 5, NEAR_BOTTOM_PX), false);
  assert.equal(gate.onScroll(T0, 5, NEAR_BOTTOM_PX - 1), false);
  // 距底 > 阈值才脱离
  assert.equal(gate.onScroll(T0, 5, NEAR_BOTTOM_PX + 1), true);
  // 视口下移（scrolledUpBy<=0）永不脱离
  assert.equal(gate.onScroll(T0, 0, 900), false);
  assert.equal(gate.onScroll(T0, -200, 900), false);
});

test('自定义阈值生效', () => {
  const gate = createFollowGate({ nearBottomPx: 10, intentWindowMs: 50 });
  gate.markUserIntent(T0);
  assert.equal(gate.onScroll(T0 + 1, 1, 11), true);
  assert.equal(gate.onScroll(T0 + 1, 1, 10), false);
  assert.equal(gate.isUserIntentFresh(T0 + 50), false);
});

test('默认常量与文档口径一致', () => {
  assert.equal(NEAR_BOTTOM_PX, 40);
  assert.equal(USER_SCROLL_INTENT_MS, 400);
});

test('isScrollIntentKey 只认滚动类按键', () => {
  for (const k of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ']) {
    assert.equal(isScrollIntentKey(k), true, `${k} 应算滚动意图`);
  }
  for (const k of ['Enter', 'Escape', 'a', 'Tab']) {
    assert.equal(isScrollIntentKey(k), false, `${k} 不应算滚动意图`);
  }
});

test('门控无外部状态泄漏：实例互不影响', () => {
  const a = createFollowGate();
  const b = createFollowGate();
  a.markUserIntent(T0);
  assert.equal(b.isUserIntentFresh(T0 + 1), false);
  assert.equal(b.onScroll(T0 + 1, 200, 900), false);
});
