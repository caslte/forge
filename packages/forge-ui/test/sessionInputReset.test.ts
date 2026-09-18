/**
 * 切会话输入重置策略纯函数单测。
 *
 * 背景（来自 e2e/inputHistory.spec.ts AC-IH-005 的反向场景）：
 * 现有 watcher 只在 `historyCursor.value >= 0`（用户用 ↑↓ 翻历史）时才清输入框；
 * 普通"输入但未发送就切会话"路径会留下残留文本，导致跨会话串味 + 用户体感"重复"。
 * 草稿态（无 sessionId）不应被切会话影响。
 *
 * 行为契约（覆盖原 InstructionInput.vue 会话 watcher 的判定 + 状态收尾）：
 * - 草稿态（isDraft=true）：text、pendingDraft、historyCursor 全部不动；
 * - 已激活会话 + 非翻历史态（historyCursor=-1）→ 必须清空 text 与 pendingDraft（修复点）；
 * - 已激活会话 + 翻历史态（historyCursor>=0）→ 保持现行行为：清空 text 与 pendingDraft；
 * - 不论哪种已激活场景，historyCursor 一律重置回 -1（loadHistory 行为）。
 *
 * 运行：node --test（Node type stripping 直跑 .ts，先例 slashCommand.test.ts）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  computeSessionInputReset,
  type SessionInputReset,
} from '../src/utils/sessionInputReset.ts';

test('草稿态（isDraft=true）：text/pendingDraft/historyCursor 全部保留', () => {
  const out = computeSessionInputReset({
    currentText: '草稿中未发送',
    pendingDraft: '历史模式草稿',
    historyCursor: 2,
    isDraft: true,
  });
  assert.deepEqual(out, {
    text: '草稿中未发送',
    pendingDraft: '历史模式草稿',
    historyCursor: 2,
  });
});

test('已激活会话 + 翻历史态（historyCursor>=0）：清空 text/pendingDraft，重置 cursor', () => {
  const out = computeSessionInputReset({
    currentText: '历史中翻出的旧消息',
    pendingDraft: '进历史前的草稿',
    historyCursor: 1,
    isDraft: false,
  });
  assert.deepEqual(out, {
    text: '',
    pendingDraft: '',
    historyCursor: -1,
  });
});

test('已激活会话 + 普通态（historyCursor=-1）：必须清空 text 与 pendingDraft（修复点）', () => {
  const out = computeSessionInputReset({
    currentText: '可以编辑 jpg 等',
    pendingDraft: '',
    historyCursor: -1,
    isDraft: false,
  });
  assert.deepEqual(out, {
    text: '',
    pendingDraft: '',
    historyCursor: -1,
  });
});

test('已激活会话 + 普通态，pendingDraft 有内容也要清（防御性）', () => {
  const out = computeSessionInputReset({
    currentText: 'A 会话未发送',
    pendingDraft: 'A 会话进历史前保存的草稿',
    historyCursor: -1,
    isDraft: false,
  });
  assert.equal(out.text, '');
  assert.equal(out.pendingDraft, '');
  assert.equal(out.historyCursor, -1);
});

test('返回结构稳定：仅含 text/pendingDraft/historyCursor 三个字段', () => {
  const out: SessionInputReset = computeSessionInputReset({
    currentText: 'x',
    pendingDraft: '',
    historyCursor: -1,
    isDraft: false,
  });
  assert.deepEqual(Object.keys(out).sort(), ['historyCursor', 'pendingDraft', 'text']);
});