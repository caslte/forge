/**
 * IR 围栏接入渲染层（阶段 1 收尾）的契约测试。
 *
 * 与既有 canvasSandbox.test.ts 的分工：
 * - canvasSandbox.test：模型直出 HTML 的链路（现状）
 * - 本文件：模型产出 IR 的链路（新），重点是**围栏分派 + 校验期行为**
 *
 * 与 canvasFenceContract.test.ts 的分工：
 * 那份守「围栏名与提示词一致」；本份守「围栏进渲染层后行为正确」。
 *
 * 核心设计约束（决定了下面全部断言）：
 * IR 围栏**不能像 canvas 围栏那样先渲染再判**。IR 是数据，宿主必须在渲染前
 * 就校验——因为校验失败要产出的是**修复回执**（给模型），不是一张画面。
 * 故IR 围栏有三种终态：
 *   1. 校验通过 → 占位待编译（data-md-canvas-ir）
 *   2. 校验失败 → 仍出占位，但带上修复回执（data-md-canvas-ir-receipt）
 *   3. 围栏未闭合（流式）→ 骨架占位，不校验（数据可能还没写完）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_LANGUAGE,
  IR_FENCE_LANGUAGE,
  judgeIrFence,
  renderMarkdown,
} from '../../src/markdown/renderMarkdown.ts';

const IR_OK = JSON.stringify({
  schema_version: 'forge-ir/1',
  diagram_type: 'architecture',
  meta: { title: 't' },
  nodes: [{ id: 'a', label: '节点A', kind: 'process', col: 0, row: 0 }],
  edges: [],
});

const IR_BAD = JSON.stringify({
  schema_version: 'forge-ir/9',
  diagram_type: 'orgchart',
  meta: {},
  nodes: [{ id: 'a', label: 'A', kind: 'process', col: 0, row: 0 }],
  edges: [{ from: 'a', to: 'ghost' }],
});

// ---------------------------------------------------------------- 围栏名

test('IR 围栏名是 canvas-ir，不与既有 canvas 围栏混用', () => {
  assert.equal(IR_FENCE_LANGUAGE, 'canvas-ir');
  assert.notEqual(IR_FENCE_LANGUAGE, CANVAS_LANGUAGE);
});

// ---------------------------------------------------------------- 合规 IR → 占位

test('合规 IR 输出 data-md-canvas-ir 占位', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_OK + '\n```');
  assert.ok(html.includes('data-md-canvas-ir='), '缺少 IR 占位标记');
  // 原文以转义形式留在 <code> 文本里（与 canvas 围栏同款设计）：
  // 前端尚未编译时至少可读，而不是只剩一个空白框。
  assert.ok(html.includes('&#123;') || html.includes('{'), '应保留可读的转义原文');
});

test('合规 IR 的占位源码是 base64 承载（绕开 sanitize 与属性转义）', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_OK + '\n```');
  // 真正给编译器用的载荷必须是 base64 属性，不能是明文文本
  const m = html.match(/data-md-canvas-ir="([^"]+)"/);
  assert.ok(m, '应带 base64 载荷属性');
  assert.ok(!/data-md-canvas-ir="[^{]/.test(m[1]!), '载荷应是 base64 而非明文 JSON');
});

test('合规 IR 不带修复回执标记', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_OK + '\n```');
  assert.ok(!html.includes('data-md-canvas-ir-receipt'),
    '合规 IR 不应带回执标记');
});

test('占位里的 base64 能还原回原始 IR（中文不乱码）', () => {
  const ir = JSON.stringify({
    schema_version: 'forge-ir/1', diagram_type: 'architecture', meta: {},
    nodes: [{ id: 'x', label: '中文节点', kind: 'process', col: 0, row: 0 }],
    edges: [],
  });
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + ir + '\n```');
  const m = html.match(/data-md-canvas-ir="([^"]+)"/);
  assert.ok(m, '未抓到占位');
  const decoded = Buffer.from(m[1]!, 'base64').toString('utf-8');
  assert.equal(decoded, ir);
});

// ---------------------------------------------------------------- 违规 IR → 回执

test('违规 IR 仍出占位（便于前端显示修复回执而非空白）', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_BAD + '\n```');
  assert.ok(html.includes('data-md-canvas-ir-receipt='), '违规 IR 应带回执占位');
});

test('违规 IR 的回执里含缺陷码 IR001（版本不符）', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_BAD + '\n```');
  const m = html.match(/data-md-canvas-ir-receipt="([^"]+)"/);
  assert.ok(m);
  const receipt = Buffer.from(m[1]!, 'base64').toString('utf-8');
  assert.ok(receipt.includes('IR001'), '回执应含 IR001：' + receipt.slice(0, 120));
});

test('违规 IR 的回执含可执行修复控件 supportedFixes', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_BAD + '\n```');
  const m = html.match(/data-md-canvas-ir-receipt="([^"]+)"/);
  assert.ok(m);
  const receipt = Buffer.from(m[1]!, 'base64').toString('utf-8');
  assert.ok(receipt.includes('补写 schema_version'), '回执应给具体修复动作');
});

test('违规 IR 的回执含全部缺陷，不是只报第一个', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_BAD + '\n```');
  const m = html.match(/data-md-canvas-ir-receipt="([^"]+)"/);
  const receipt = Buffer.from(m[1]!, 'base64').toString('utf-8');
  assert.ok(receipt.includes('IR001'), '应含版本问题');
  assert.ok(receipt.includes('IR003'), '应含 diagram_type 问题');
  assert.ok(receipt.includes('IR002'), '应含悬空边问题');
});

test('非 JSON 的 IR 围栏产出 IR000 回执而非抛异常', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n这不是 JSON\n```');
  assert.ok(html.includes('data-md-canvas-ir-receipt='));
  const m = html.match(/data-md-canvas-ir-receipt="([^"]+)"/);
  const receipt = Buffer.from(m[1]!, 'base64').toString('utf-8');
  assert.ok(receipt.includes('IR000'));
});

// ---------------------------------------------------------------- 与既有围栏互不干扰

test('canvas 围栏行为不受 IR 接入影响（现状链路零回归）', () => {
  const html = renderMarkdown('```' + CANVAS_LANGUAGE + '\n<div>hi</div>\n```');
  assert.ok(html.includes('data-md-canvas='), 'canvas 占位应仍在');
  assert.ok(!html.includes('data-md-canvas-ir'), 'canvas 不应被 IR 分支抢走');
});

test('canvas-ir 围栏不被 canvas 分支抢走', () => {
  const html = renderMarkdown('```' + IR_FENCE_LANGUAGE + '\n' + IR_OK + '\n```');
  assert.ok(html.includes('data-md-canvas-ir='), 'IR 占位应存在');
  // 反向：不该只出现 canvas 的占位类名
  assert.ok(!/class="md-canvas"/.test(html), 'IR 不应复用 canvas 的 class');
});

test('html 围栏仍走代码高亮（不被 IR 分支劫持）', () => {
  const html = renderMarkdown('```html\n<div>x</div>\n```');
  assert.ok(html.includes('md-code-block'), 'html 围栏应仍是代码块');
  assert.ok(!html.includes('data-md-canvas-ir'));
});

// ---------------------------------------------------------------- 流式

test('IR 围栏未闭合时不校验（流式期数据不完整，判了必误报）', () => {
  const partial = '```' + IR_FENCE_LANGUAGE + '\n{ "schema_version": "forge-ir/1", "nodes": [';
  const html = renderMarkdown(partial);
  assert.ok(!html.includes('data-md-canvas-ir-receipt="'),
    '流式期不应产出修复回执（模型正在逐字输出，卡片会反复闪错误态）');
  assert.ok(!html.includes('data-md-canvas-ir="'), '流式期不应出合规占位');
});

test('流式期判据不依赖 marked 的行为假设 —— 残缺 JSON 即视为未闭合', () => {
  // 这条锁住一个真实 bug：曾假设「marked 不会把未闭合围栏送进 codeRenderer」，
  // 实测它会（加 sanitize 属性后行为变化），导致流式期产出修复回执、卡片闪错误态。
  // 修法是改用「是否以 { 开头 + 能否解析」作判据，纯函数、无状态。
  for (const src of [
    '{',
    '{ "schema_version"',
    '{ "schema_version": "forge-ir/1", "nodes": [',
  ]) {
    const outcome = judgeIrFence(src);
    assert.equal(outcome.receipt, null, '流式残片不应产出回执：' + src);
    assert.equal(outcome.ok, false, '流式残片不应判 ok');
  }
});

test('压根不是 JSON（模型跑偏）必须出回执，不能被流式判据吞掉', () => {
  // 反向断言：判据过宽 ⇒ 模型跑偏会被当成流式静默吞掉 ⇒ 它永远不知道自己写错了。
  for (const src of ['这不是 JSON', '```json\n{}\n```', '直接写文字', '']) {
    const outcome = judgeIrFence(src);
    assert.equal(outcome.ok, false, '应判 fail');
    assert.ok(outcome.receipt, '跑偏必须出回执：' + JSON.stringify(src));
    assert.ok(outcome.receipt!.includes('IR000'));
  }
});

test('完整但有缺陷的 JSON 仍应出回执（不能被流式判据误吞）', () => {
  const outcome = judgeIrFence(IR_BAD);
  assert.equal(outcome.ok, false);
  assert.ok(outcome.receipt, '完整但违规的 JSON 必须出回执');
  assert.ok(outcome.receipt!.includes('IR001'));
});