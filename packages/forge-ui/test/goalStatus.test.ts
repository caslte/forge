/**
 * goal 状态解析的纯函数单测。
 *
 * 守护的真实回归：pi-goal 改版换状态串格式时，这里红掉 = 徽标会显示错，
 * 而错误的进度提示比没有提示更糟（用户会以为目标还在跑）。
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import { goalStateNeedsUser, parseGoalStatus } from '../src/utils/goalStatus.ts';

test('空串 / null / undefined 返回 null（UI 据此隐藏徽标）', () => {
  assert.equal(parseGoalStatus(null), null);
  assert.equal(parseGoalStatus(undefined), null);
  assert.equal(parseGoalStatus(''), null);
  assert.equal(parseGoalStatus('   '), null);
});

test('active + 耗时 + 轮次：最常见形态', () => {
  const view = parseGoalStatus('active 3m · automatic 12/25');
  assert.ok(view);
  assert.equal(view!.state, 'active');
  assert.equal(view!.label, '进行中');
  assert.equal(view!.usedTurns, 12);
  assert.equal(view!.limitTurns, 25);
  assert.equal(view!.turnLabel, '12/25');
  assert.equal(view!.budgetLabel, null);
  assert.equal(view!.waitingReason, null);
});

test('active + token 预算：budgetLabel 抽出用量', () => {
  const view = parseGoalStatus('active 18k/100k · automatic 12/25');
  assert.ok(view);
  assert.equal(view!.state, 'active');
  assert.equal(view!.budgetLabel, '18k/100k');
  assert.equal(view!.turnLabel, '12/25');
});

test('active + Unlimited：轮次上限为 null，只显示 ∞', () => {
  const view = parseGoalStatus('active 3m · automatic Unlimited');
  assert.ok(view);
  assert.equal(view!.unlimited, true);
  assert.equal(view!.limitTurns, null);
  // pi-goal 的 Unlimited 形态不带已用轮数，故只能给 `∞`（不能是 `null/∞`）
  assert.equal(view!.usedTurns, null);
  assert.equal(view!.turnLabel, '∞');
});

test('waiting：抽出等待原因', () => {
  const view = parseGoalStatus('waiting review monitor · automatic 12/25');
  assert.ok(view);
  assert.equal(view!.state, 'waiting');
  assert.equal(view!.label, '等待中');
  assert.equal(view!.waitingReason, 'review monitor');
  assert.equal(view!.turnLabel, '12/25');
});

test('paused（含续跑上限触发）：解析出轮次', () => {
  const limited = parseGoalStatus('paused · automatic limit 25/25');
  assert.ok(limited);
  assert.equal(limited!.state, 'paused');
  assert.equal(limited!.label, '已暂停');
  assert.equal(limited!.turnLabel, '25/25');

  const plain = parseGoalStatus('paused · automatic 12/25');
  assert.ok(plain);
  assert.equal(plain!.state, 'paused');
  assert.equal(plain!.turnLabel, '12/25');
});

test('blocked / usage / budget：三种「需用户介入」终局', () => {
  const blocked = parseGoalStatus('blocked · automatic 12/25');
  assert.equal(blocked!.state, 'blocked');
  assert.equal(blocked!.label, '受阻');

  const usage = parseGoalStatus('usage · automatic 12/25');
  assert.equal(usage!.state, 'usage');
  assert.equal(usage!.label, '额度用尽');

  const budget = parseGoalStatus('budget 100k/100k · automatic 12/25');
  assert.equal(budget!.state, 'budget');
  assert.equal(budget!.label, '预算用尽');
  assert.equal(budget!.budgetLabel, '100k/100k');
});

test('complete：无分段形态', () => {
  const view = parseGoalStatus('complete');
  assert.ok(view);
  assert.equal(view!.state, 'complete');
  assert.equal(view!.label, '已完成');
  assert.equal(view!.turnLabel, '');
});

test('未知形态：原样展示，不猜测语义', () => {
  const raw = 'some-future-status · automatic 1/2';
  const view = parseGoalStatus(raw);
  assert.ok(view);
  assert.equal(view!.state, 'unknown');
  // label 用整串原文（不只 head）——未知形态下宁可多显示，也不要让用户漏看状态
  assert.equal(view!.label, raw);
  assert.equal(view!.raw, raw);
  // 仍能解析出轮次，即使状态词不认识
  assert.equal(view!.turnLabel, '1/2');
});

test('缺 automatic 段时不报错（turnLabel 为空）', () => {
  const view = parseGoalStatus('paused');
  assert.ok(view);
  assert.equal(view!.state, 'paused');
  assert.equal(view!.turnLabel, '');
  assert.equal(view!.usedTurns, null);
});

test('goalStateNeedsUser：只有三种终局需要用户介入', () => {
  assert.equal(goalStateNeedsUser(parseGoalStatus('blocked · automatic 12/25')), true);
  assert.equal(goalStateNeedsUser(parseGoalStatus('usage · automatic 12/25')), true);
  assert.equal(goalStateNeedsUser(parseGoalStatus('budget 100k/100k · automatic 12/25')), true);

  assert.equal(goalStateNeedsUser(parseGoalStatus('active 3m · automatic 12/25')), false);
  assert.equal(goalStateNeedsUser(parseGoalStatus('waiting x · automatic 12/25')), false);
  assert.equal(goalStateNeedsUser(parseGoalStatus('paused · automatic 12/25')), false);
  assert.equal(goalStateNeedsUser(parseGoalStatus('complete')), false);
  assert.equal(goalStateNeedsUser(null), false);
});

test('耗时与预算不混淆：active 3m 不被当成预算', () => {
  const view = parseGoalStatus('active 3m · automatic 12/25');
  assert.equal(view!.budgetLabel, null, '`3m` 是耗时不是 token 预算');
});
