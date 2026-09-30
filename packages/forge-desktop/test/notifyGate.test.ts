/**
 * 系统通知弹窗决策（notifyGate.ts）单测。
 *
 * 核心不变量（2026-09-30 用户反馈驱动）：**自动重试期间的 error 不是终态，不弹通知**。
 * pi 的事件顺序是 message_end(stopReason=error) →（可重试时）auto_retry_start，
 * status=error 先于「要不要重试」的判定到达；旧逻辑一见 error 就弹「回复出错」，
 * 于是用户在「正在自动重试（第 1/3 次）」时先看到了失败通知。gate 用宽限期复问修掉。
 *
 * 另覆盖原有三条规则不回归：前台不打扰 / 3s 冷却 / done 紧随中断出错不覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createNotifyGate, type NotifyGateContext } from '../src/notifyGate.ts';

/** 构造固定 now/focused 的上下文 */
function ctx(now: number, focused = false): NotifyGateContext {
  return { now, focused };
}

test('自动重试期间：error 先到 → 挂起（defer），状态回 streaming 后复问不弹', () => {
  const gate = createNotifyGate();
  const s = 'sess-retry';

  // ① 第 1 次尝试失败：错误先到，pi 尚未决定是否重试
  const first = gate.observe(s, 'error', ctx(1000));
  assert.equal(first.type, 'defer', '出错瞬间无法判定是否重试，应挂起而非直接弹');

  // ② pi 判定可重试 → 恢复 streaming（createForgeCore 的 onAutoRetryStart）
  gate.observe(s, 'streaming', ctx(1020));
  // ③ 宽限期到期复问：状态已不是 error → 不打扰用户
  const settled = gate.settle(s, ctx(2000));
  assert.equal(settled.type, 'skip');
  if (settled.type === 'skip') assert.equal(settled.reason, 'retry-resumed');
});

test('重试耗尽：最后一次 error 挂起后无人接管 → 宽限期结束才弹「回复出错」', () => {
  const gate = createNotifyGate();
  const s = 'sess-exhausted';

  // 三次尝试均失败：每次 error 都被随后的 streaming 接管（节流写省略，只验末次）
  gate.observe(s, 'error', ctx(1000));
  gate.observe(s, 'streaming', ctx(1010));
  const last = gate.observe(s, 'error', ctx(5000));
  assert.equal(last.type, 'defer', '末次出错同样先挂起（不预设重试结果）');

  // 无人接管（无 auto_retry_start）→ 复问时仍是 error = 真终态
  const settled = gate.settle(s, ctx(5000 + gate.errorGraceMs));
  assert.equal(settled.type, 'notify');
  if (settled.type === 'notify') assert.equal(settled.kind, 'error');
});

test('不可重试错误（无重试事件）：仍会弹，只是晚一个宽限期', () => {
  const gate = createNotifyGate({ errorGraceMs: 50 });
  const s = 'sess-fatal';
  assert.equal(gate.observe(s, 'error', ctx(10)).type, 'defer');
  const settled = gate.settle(s, ctx(60));
  assert.equal(settled.type, 'notify');
});

test('宽限期内窗口切到前台 → 不弹（复问时重新判定前台）', () => {
  const gate = createNotifyGate();
  const s = 'sess-focus';
  assert.equal(gate.observe(s, 'error', ctx(1000, false)).type, 'defer');
  const settled = gate.settle(s, ctx(1500, true));
  assert.equal(settled.type, 'skip');
  if (settled.type === 'skip') assert.equal(settled.reason, 'focused');
});

test('error 之后到达 done：挂起的出错通知作废（settle 需显式复问才作废）', () => {
  const gate = createNotifyGate();
  const s = 'sess-done';
  gate.observe(s, 'error', ctx(1000));
  gate.observe(s, 'done', ctx(1100));
  const settled = gate.settle(s, ctx(2000));
  assert.equal(settled.type, 'skip');
  if (settled.type === 'skip') assert.equal(settled.reason, 'retry-resumed');
});

test('settle 幂等：挂起只结算一次，重复复问不重复弹', () => {
  const gate = createNotifyGate();
  const s = 'sess-once';
  gate.observe(s, 'error', ctx(1000));
  assert.equal(gate.settle(s, ctx(2000)).type, 'notify');
  assert.equal(gate.settle(s, ctx(2100)).type, 'skip');
});

test('主窗口前台时不弹（done / canceled / error 一致）', () => {
  const gate = createNotifyGate();
  for (const status of ['done', 'canceled', 'error']) {
    const out = gate.observe(`s-${status}`, status, ctx(1000, true));
    assert.equal(out.type, 'skip', `${status} 前台应不弹`);
    if (out.type === 'skip') assert.equal(out.reason, 'focused');
  }
});

test('3s 冷却：同会话重复终态只弹第一条', () => {
  const gate = createNotifyGate();
  const s = 'sess-cool';
  assert.equal(gate.observe(s, 'done', ctx(10_000)).type, 'notify');
  const again = gate.observe(s, 'done', ctx(12_000));
  assert.equal(again.type, 'skip');
  if (again.type === 'skip') assert.equal(again.reason, 'cooldown');
  // 冷却窗口外恢复
  assert.equal(gate.observe(s, 'done', ctx(13_500)).type, 'notify');
});

test('done 紧随中断/出错：不覆盖原通知（5s 内）', () => {
  const gate = createNotifyGate();
  const s = 'sess-cancel';
  const interrupted = gate.observe(s, 'canceled', ctx(10_000));
  assert.equal(interrupted.type, 'notify');
  if (interrupted.type === 'notify') assert.equal(interrupted.kind, 'interrupt');
  // cancel 编排会补发一次 done（createForgeCore 的 done 门控）。取 3.5s 后：
  // 已越过 3s 冷却，才轮到 5s 的「done 紧随中断」门控生效。
  const done = gate.observe(s, 'done', ctx(13_500));
  assert.equal(done.type, 'skip');
  if (done.type === 'skip') assert.equal(done.reason, 'done-after-interrupt');
});

test('非终态状态不弹且不污染决策（streaming/idle）', () => {
  const gate = createNotifyGate();
  for (const status of ['streaming', 'idle', 'compacting']) {
    const out = gate.observe(`s2-${status}`, status, ctx(1000));
    assert.equal(out.type, 'skip');
    if (out.type === 'skip') assert.equal(out.reason, 'not-terminal');
  }
  // 没有挂起也没有通知记录：settle 无事可做
  assert.equal(gate.settle('s2-streaming', ctx(2000)).type, 'skip');
});

test('多会话互不干扰：甲会话重试中，乙会话终态照常弹', () => {
  const gate = createNotifyGate();
  gate.observe('A', 'error', ctx(1000));
  gate.observe('A', 'streaming', ctx(1010));
  const b = gate.observe('B', 'done', ctx(1020));
  assert.equal(b.type, 'notify');
  assert.equal(gate.settle('A', ctx(2000)).type, 'skip');
});
