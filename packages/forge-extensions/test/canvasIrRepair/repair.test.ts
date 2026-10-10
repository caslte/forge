/**
 * 修复回路的决策测试（decideIrRepair 纯函数）。
 *
 * 修复回路的全部风险都在决策分支：误触发（正常轮发回执打扰用户）、
 * 漏触发（失败但不修）、无限循环（重试轮再失败还修）。这里锁死。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IR_RETRY_TAG,
  decideIrRepair,
  messageText,
  type MinimalMessage,
} from '../../src/canvasIrRepair/extension.ts';

const OK_IR = '```canvas-ir\n{"schema_version":"forge-ir/1","diagram_type":"architecture","meta":{},'
  + '"nodes":[{"id":"a","label":"A","kind":"process","col":0,"row":0}],"edges":[]}\n```';
const BAD_IR = '```canvas-ir\n{"nodes":[{"id":"a","label":"A","kind":"process","col":0,"row":0}],"edges":[]}\n```';

function msgs(...m: MinimalMessage[]): MinimalMessage[] {
  return m;
}

test('合规 IR：不回灌（绝大多数轮次零开销）', () => {
  const d = decideIrRepair(msgs(
    { role: 'user', content: '画个架构图' },
    { role: 'assistant', content: '图如下\n' + OK_IR },
  ));
  assert.equal(d, null);
});

test('无围栏：不回灌', () => {
  const d = decideIrRepair(msgs(
    { role: 'user', content: '你好' },
    { role: 'assistant', content: '纯文字回答' },
  ));
  assert.equal(d, null);
});

test('失败 IR：回灌，文本含回执标记、缺陷码、原始 IR 与重写指令', () => {
  const d = decideIrRepair(msgs(
    { role: 'user', content: '画个架构图' },
    { role: 'assistant', content: BAD_IR },
  ));
  assert.ok(d);
  assert.equal(d.retry, true);
  assert.ok(d.text.startsWith(IR_RETRY_TAG));
  assert.ok(d.text.includes('IR001'), '应含缺失版本号的缺陷码');
  assert.ok(d.text.includes('```canvas-ir'), '应附原始 IR 供重写');
  assert.ok(d.text.includes('重新输出完整的'));
});

test('失败后的重试轮（最后 user 消息已是回执）：不再回灌（预算上限 1 次）', () => {
  const d = decideIrRepair(msgs(
    { role: 'user', content: '画个架构图' },
    { role: 'assistant', content: BAD_IR },
    { role: 'user', content: IR_RETRY_TAG + '\nIR 校验未通过…' },
    { role: 'assistant', content: BAD_IR },
  ));
  assert.equal(d, null, '重试轮再失败应交还用户，不得无限循环');
});

test('重试轮修复成功：不回灌（静默收尾）', () => {
  const d = decideIrRepair(msgs(
    { role: 'user', content: IR_RETRY_TAG + '\n…' },
    { role: 'assistant', content: OK_IR },
  ));
  assert.equal(d, null);
});

test('同轮多个围栏只取第一个失败（一条回执一个任务，避免上下文爆炸）', () => {
  const d = decideIrRepair(msgs(
    { role: 'assistant', content: BAD_IR + '\n' + BAD_IR },
  ));
  assert.ok(d);
  // 只包含一次原始 IR 附加（第一个失败的）
  assert.equal(d.text.split('```canvas-ir').length - 1, 2, '回执标记文本里应只有一处 IR 引用对');
});

test('content 为 text 块数组形态时同样提取（pi 消息两种形态）', () => {
  const d = decideIrRepair(msgs(
    { role: 'assistant', content: [{ type: 'text', text: BAD_IR }] },
  ));
  assert.ok(d, '数组形态的 content 也应被提取');
});

test('messageText：string 直通、数组拼接、其他类型空串', () => {
  assert.equal(messageText('abc'), 'abc');
  assert.equal(messageText([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }]), 'ab');
  assert.equal(messageText(42), '');
});