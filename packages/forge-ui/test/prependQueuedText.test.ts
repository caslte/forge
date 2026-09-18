/**
 * 队列文本前置拼接纯函数单测（stop/cancel 回填路径）。
 *
 * 背景（来自 coverage-matrix.md QC-003 反序规则）：
 * - 行为契约——被清空文本按 \n\n 拼接回填输入框（pi TUI ESC 同款，零丢失）；
 * - 修复点——同一份 queued 文本被重复传入必须幂等（不能前缀拼两遍）。
 *
 * 抽取自 InstructionInput.vue 的 `restoreQueuedText`（CV-S09）。
 * 纯 TS 零依赖（Node type stripping 可直跑，先例 utils/pasteText.ts）。
 *
 * 运行：node --test（先例 sessionInputReset.test.ts）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { prependQueuedText } from '../src/utils/prependQueuedText.ts';

test('空队列 + 空输入 → 返回空', () => {
  assert.equal(prependQueuedText('', []), '');
});

test('空队列 + 有输入 → 原样返回当前输入', () => {
  assert.equal(prependQueuedText('当前正在编辑', []), '当前正在编辑');
});

test('单条队列 + 空输入 → 仅返回队列文本', () => {
  assert.equal(prependQueuedText('', ['queued-msg']), 'queued-msg');
});

test('多条队列 + 空输入 → 用 \n\n 拼接', () => {
  assert.equal(prependQueuedText('', ['q1', 'q2', 'q3']), 'q1\n\nq2\n\nq3');
});

test('多条队列 + 有当前输入 → 队列在前、当前在后、\n\n 分隔', () => {
  assert.equal(
    prependQueuedText('当前正在编辑', ['q1', 'q2']),
    'q1\n\nq2\n\n当前正在编辑',
  );
});

test('过滤：空白 / 非字符串项被丢弃', () => {
  assert.equal(
    prependQueuedText('current', ['q1', '   ', '', 'q2', null as unknown as string, 42 as unknown as string]),
    'q1\n\nq2\n\ncurrent',
  );
});

test('过滤：全为空白/非字符串时 → 返回当前输入（不抛错、不产生 NaN）', () => {
  assert.equal(prependQueuedText('current', ['   ', '', null as unknown as string]), 'current');
  assert.equal(prependQueuedText('', ['   ', '', null as unknown as string]), '');
});

test('当前输入首尾空白被 trim 后再拼接（避免拼出多余空行）', () => {
  assert.equal(
    prependQueuedText('  当前正在编辑  ', ['q1']),
    'q1\n\n当前正在编辑',
  );
});

test('修复点：同一份队列文本被传入两次，第二次是幂等的（不会前缀拼两遍）', () => {
  // 模拟"cancel → 又 cancel 同一队列"路径：
  // 第一次停掉已经把 queued-msg 拼到输入框前；
  // 第二次同样的 queued-msg 不应该再前缀拼一遍。
  const afterFirst = prependQueuedText('', ['queued-msg']);
  assert.equal(afterFirst, 'queued-msg');
  const afterSecond = prependQueuedText(afterFirst, ['queued-msg']);
  assert.equal(afterSecond, 'queued-msg'); // 不是 "queued-msg\n\nqueued-msg"
});

test('修复点：重复调用且当前已有编辑内容时也必须幂等', () => {
  const afterFirst = prependQueuedText('current', ['queued-msg']);
  assert.equal(afterFirst, 'queued-msg\n\ncurrent');
  const afterSecond = prependQueuedText(afterFirst, ['queued-msg']);
  assert.equal(afterSecond, 'queued-msg\n\ncurrent');
});

test('边界：多条队列拼接后再次以同一组合传入 → 第二次幂等', () => {
  const afterFirst = prependQueuedText('current', ['q1', 'q2']);
  assert.equal(afterFirst, 'q1\n\nq2\n\ncurrent');
  const afterSecond = prependQueuedText(afterFirst, ['q1', 'q2']);
  assert.equal(afterSecond, 'q1\n\nq2\n\ncurrent');
});