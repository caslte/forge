/**
 * IR 契约注入扩展的测试。
 *
 * 核心要守的是**开关语义**：
 * - 关（默认）⇒ 一行 IR 契约都不注入 ⇒ 现有用户行为零变化
 * - 开⇒ 注入 IR 契约，且**不注入** canvas 契约（否则模型收到两套互斥指令，
 *   会同时产出 HTML 和 IR，卡片重复）
 *
 * 这两条任一破掉，都是「用户看到莫名多出来的图」或「新功能没生效」，
 * 且都不会有明显报错，所以必须有测试。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IR_EXTENSION_ENV,
  isIrExtensionEnabled,
  applyIrHint,
} from '../../src/canvasIrHint/extension.ts';

test('默认关闭：环境变量未设置时不启用（2026-10-10 回退裁定）', () => {
  // 完整轨迹：默认关 → 用户裁定默认开（真机验证）→ 真机结论「不可用，不如 html 直出」
  // → 回退默认关。调优达标后再考虑默认开。
  const env: Record<string, string | undefined> = {};
  assert.equal(isIrExtensionEnabled(env), false);
});

test('开关取值：FORGE_IR_CANVAS=1 / on / true 视为开启', () => {
  for (const v of ['1', 'on', 'true', 'TRUE', 'On']) {
    assert.equal(isIrExtensionEnabled({ [IR_EXTENSION_ENV]: v }), true, '应视为开启：' + v);
  }
});

test('开关取值：1/on/true 之外的任何值均视为关闭（拼写错误倾向关闭而非误开）', () => {
  for (const v of ['0', 'off', 'false', 'no', 'yes', '', '乱填', 'OFF']) {
    assert.equal(isIrExtensionEnabled({ [IR_EXTENSION_ENV]: v }), false, '应视为关闭：' + v);
  }
});

test('默认（未设变量）不注入任何 IR 内容', () => {
  const out = applyIrHint('BASE', '画个架构图', {});
  assert.equal(out, 'BASE', '默认关闭时应原样返回，不改动提示词');
});

test('显式关闭时不注入任何 IR 内容（回退路径）', () => {
  const out = applyIrHint('BASE', '画个架构图', { [IR_EXTENSION_ENV]: '0' });
  assert.equal(out, 'BASE', '显式关闭时应原样返回，不改动提示词');
});

test('开启时注入 IR_STANZA 常驻段', () => {
  const out = applyIrHint('BASE', '继续聊', { [IR_EXTENSION_ENV]: '1' });
  assert.ok(out.startsWith('BASE'), '应保留原提示词');
  assert.ok(out.includes('canvas-ir'), '应提到 IR 围栏名');
});

test('开启且命中出图意图时追加完整 IR_SPEC', () => {
  const out = applyIrHint('BASE', '帮我画一下系统架构图', { [IR_EXTENSION_ENV]: '1' });
  assert.ok(out.includes('schema_version'), '命中出图意图时应含完整契约');
});

test('开启但不命中出图意图时只含常驻段，不含完整契约', () => {
  const out = applyIrHint('BASE', '今天天气怎么样', { [IR_EXTENSION_ENV]: '1' });
  assert.ok(out.includes('canvas-ir'), '应含常驻段');
  assert.ok(!out.includes('schema_version'), '未命中出图意图不该塞完整契约');
});

test('幂等：同一段提示词注入两次结果一致（防无声膨胀）', () => {
  const env = { [IR_EXTENSION_ENV]: '1' };
  const once = applyIrHint('BASE', '画个架构图', env);
  const twice = applyIrHint(once, '画个架构图', env);
  assert.equal(twice, once, '第二次注入必须是无操作');
});

test('与 canvas 契约互斥：开启 IR 时不注入 canvas 的 9 条排版规则', () => {
  const out = applyIrHint('BASE', '画个架构图', { [IR_EXTENSION_ENV]: '1' });
  // canvas 契约的标志性内容。IR 链路里模型不碰排版，出现即说明两套契约串了
  assert.ok(!out.includes('position: fixed'), 'IR 契约不应教position');
  assert.ok(!out.includes('--c-ok-bg'), 'IR 契约不应教取色（那是 canvas 链路的职责）');
  assert.ok(!out.includes('320px'), 'IR 契约不应提卡片像素高度');
});