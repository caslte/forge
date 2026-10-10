/**
 * 时序图（sequence）—— 第二种 diagram_type（2026-10-10 用户反馈驱动）。
 *
 * ## 背景
 *
 * 真机会话里模型亲口说「当前 IR 只支持 architecture（无生命线/时间轴），
 * 所以我把调用链画成左→右链路 + 文字步骤表」。用户追问时序图。
 * 时序图的信息结构（参与者 + 按时间排序的消息）与 architecture（节点 + 拓扑边）
 * 完全不同，值得一个专属类型，而不是逼模型用 architecture 硬凑。
 *
 * ## 最小 schema（阶段 2 起步版）
 *
 * ```json
 * {
 *   "diagram_type": "sequence",
 *   "participants": [{ "id": "ui", "label": "UI" }],
 *   "messages": [{ "from": "ui", "to": "main", "label": "call(...)" }]
 * }
 * ```
 * messages 的**数组顺序就是时间顺序**（从上往下），不需要显式 seq 字段——
 * 排序交给数组，模型最不容易出错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeIr } from '../../src/markdown/canvasIr.ts';
import { compileIrToSvg } from '../../src/markdown/canvasIrRender.ts';

const SEQ = (overrides?: Record<string, unknown>) => JSON.stringify({
  schema_version: 'forge-ir/1',
  diagram_type: 'sequence',
  meta: { title: '发消息时序' },
  participants: [
    { id: 'ui', label: 'UI' },
    { id: 'main', label: '主进程' },
    { id: 'pi', label: 'pi' },
  ],
  messages: [
    { from: 'ui', to: 'main', label: 'sendMessage' },
    { from: 'main', to: 'pi', label: 'prompt' },
    { from: 'pi', to: 'main', label: '流式回调' },
  ],
  nodes: [],
  edges: [],
  ...overrides,
});

// ---------------------------------------------------------------- 校验

test('sequence 合法时判 ok（participants + messages，nodes/edges 空数组）', () => {
  const r = judgeIr(SEQ());
  assert.equal(r.verdict, 'ok', JSON.stringify(r.diagnostics));
});

test('sequence 的 participants 少于 2 个报 IR015（生命线至少两条才有时序）', () => {
  const r = judgeIr(SEQ({
    participants: [{ id: 'a', label: 'A' }],
    messages: [],
  }));
  assert.ok(r.diagnostics.some(d => d.code === 'IR015'));
});

test('sequence 的消息端点不在 participants 中报 IR002（复用悬空引用码）', () => {
  const r = judgeIr(SEQ({
    messages: [{ from: 'ui', to: 'ghost', label: 'x' }],
  }));
  assert.ok(r.diagnostics.some(d => d.code === 'IR002' && d.subject === 'ghost'));
});

test('sequence 的 participants 非数组或缺字段报 IR015', () => {
  const bad = judgeIr(SEQ({ participants: 'three' }));
  assert.ok(bad.diagnostics.some(d => d.code === 'IR015'));
  const noLabel = judgeIr(SEQ({
    participants: [{ id: 'a' }, { id: 'b', label: 'B' }],
  }));
  assert.ok(noLabel.diagnostics.some(d => d.code === 'IR015'));
});

test('architecture 类型不受 sequence 规则影响（判据按 diagram_type 分派）', () => {
  const arch = JSON.stringify({
    schema_version: 'forge-ir/1', diagram_type: 'architecture', meta: {},
    nodes: [{ id: 'a', label: 'A', kind: 'process', col: 0, row: 0 }],
    edges: [],
  });
  assert.equal(judgeIr(arch).verdict, 'ok');
});

// ---------------------------------------------------------------- 渲染

test('sequence 渲染：每个参与者一个顶部框 + 一条生命线', () => {
  const svg = compileIrToSvg(judgeIr(SEQ()).ir!);
  assert.equal((svg.match(/class="ir-seq-participant"/g) ?? []).length, 3);
  assert.equal((svg.match(/class="ir-seq-lifeline"/g) ?? []).length, 3);
  for (const label of ['UI', '主进程', 'pi']) {
    assert.ok(svg.includes('>' + label + '<'), '缺参与者文本：' + label);
  }
});

test('sequence 渲染：每条消息一个箭头 + 序号 + 标签文本', () => {
  const svg = compileIrToSvg(judgeIr(SEQ()).ir!);
  assert.equal((svg.match(/class="ir-seq-msg"/g) ?? []).length, 3);
  for (const label of ['sendMessage', 'prompt', '流式回调']) {
    assert.ok(svg.includes('>' + label + '<'), '缺消息标签：' + label);
  }
});

test('消息按数组顺序自上而下（时间轴语义）：第 i 条的 y 严格递增', () => {
  const svg = compileIrToSvg(judgeIr(SEQ()).ir!);
  // y 写在每条消息 path 的 d 里（M x y …），不是 transform
  const ys = [...svg.matchAll(/class="ir-seq-msg-line" d="M[\d.]+ ([\d.]+)/g)]
    .map(m => Number(m[1]));
  assert.equal(ys.length, 3);
  assert.ok(ys[0]! < ys[1]! && ys[1]! < ys[2]!, '消息 y 应递增：' + ys.join(','));
});

test('自消息（from === to）也渲染（标签在生命线旁，不出错）', () => {
  const svg = compileIrToSvg(judgeIr(SEQ({
    messages: [{ from: 'ui', to: 'ui', label: '本地校验' }],
  })).ir!);
  assert.ok(svg.includes('>本地校验<'));
});

test('连线可读性：stroke 用 muted-fg（比 border 深，交叉时能分清走向）', () => {
  // sequence 消息线与 architecture 边统一升级（深化自 --c-border）
  const seqSvg = compileIrToSvg(judgeIr(SEQ()).ir!);
  const msg = seqSvg.match(/class="ir-seq-msg-line"[^>]*/)![0];
  assert.ok(msg.includes('--c-muted-fg'), '消息线应用更深的 muted-fg：' + msg);
  // architecture 边同样加深（回归确认）。⚠ 先剥 defs——marker 的 path 会抢 first match
  const archSvg = compileIrToSvg(judgeIr(JSON.stringify({
    schema_version: 'forge-ir/1', diagram_type: 'architecture', meta: {},
    nodes: [
      { id: 'a', label: 'A', kind: 'process', col: 0, row: 0 },
      { id: 'b', label: 'B', kind: 'process', col: 1, row: 0 },
    ],
    edges: [{ from: 'a', to: 'b' }],
  })).ir!);
  const body = archSvg.replace(/<defs>[\s\S]*?<\/defs>/, '');
  const edge = body.match(/<path d="M[^"]*" fill="none"[^>]*/)![0];
  assert.ok(edge.includes('--c-muted-fg'), 'architecture 边也应加深：' + edge);
});