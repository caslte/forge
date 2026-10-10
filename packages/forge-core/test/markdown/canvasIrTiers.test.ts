/**
 * 分层泳道（tiers）——架构图的层视觉语言（2026-10-10 用户反馈驱动）。
 *
 * ## 用户为什么说「更像流程图而不是架构图」
 *
 * 架构图与流程图的本质差别不在节点/连线，在**层（tier）的视觉实体**：
 * 架构图 = 分层泳道（每层一个背景区块 + 层名，节点嵌在层内，跨层箭头表达依赖）；
 * 流程图 = 节点 + 箭头的有向网。
 *
 * 旧 schema 的 nodes 只有 col/row（row 只是 y 坐标），渲染器没有「层」的概念，
 * 所以 architecture 类型画出来就是流程图观感。用户判断正确。
 *
 * ## 设计
 *
 * schema 加**可选** `tiers: [{ row, name }]`（向后兼容）：
 * - 给了 → 每个 row 渲染成一条水平泳道（背景区块 + 层名），节点嵌在泳道内
 * - 没给 → 现状网格渲染，行为零变化
 * - 有 tiers 时，所有节点 row 必须在 tiers 中定义（否则 IR013）——
 *   这个约束是**故意的**：强迫模型把「这一层叫什么」想清楚再画，
 *   层名本身就是架构表达的一部分。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeIr } from '../../src/markdown/canvasIr.ts';
import { compileIrToSvg, layoutIr } from '../../src/markdown/canvasIrRender.ts';

const NODES = [
  { id: 'ui', label: '渲染层', kind: 'component', col: 0, row: 0 },
  { id: 'main', label: '主进程', kind: 'process', col: 1, row: 1 },
  { id: 'store', label: '存储', kind: 'storage', col: 0, row: 2 },
];
const EDGES = [{ from: 'ui', to: 'main' }, { from: 'main', to: 'store' }];

const base = (tiers?: unknown) => JSON.stringify({
  schema_version: 'forge-ir/1',
  diagram_type: 'architecture',
  meta: { title: 't' },
  ...(tiers !== undefined ? { tiers } : {}),
  nodes: NODES,
  edges: EDGES,
});

const TIERS_OK = [
  { row: 0, name: '渲染层' },
  { row: 1, name: '主进程层' },
  { row: 2, name: '数据层' },
];

// ---------------------------------------------------------------- 校验

test('tiers 合法时判 ok', () => {
  const r = judgeIr(base(TIERS_OK));
  assert.equal(r.verdict, 'ok', JSON.stringify(r.diagnostics));
});

test('无 tiers 仍判 ok（向后兼容，现状网格渲染）', () => {
  assert.equal(judgeIr(base(undefined)).verdict, 'ok');
});

test('tiers 非数组报 IR013', () => {
  const r = judgeIr(base({ row: 0, name: 'x' }));
  assert.ok(r.diagnostics.some(d => d.code === 'IR013'));
});

test('tier 缺 name 或 row 报 IR014；row 重复也报 IR014', () => {
  const missing = judgeIr(base([{ row: 0 }, { row: 1, name: 'b' }]));
  assert.ok(missing.diagnostics.some(d => d.code === 'IR014' && d.subject === '0'));

  const dup = judgeIr(base([
    { row: 0, name: 'a' }, { row: 0, name: 'b' }, { row: 1, name: 'c' },
  ]));
  assert.ok(dup.diagnostics.some(d => d.code === 'IR014'));
});

test('有 tiers 时节点 row 超出覆盖范围报 IR013（强迫模型想清楚分层）', () => {
  const r = judgeIr(base([{ row: 0, name: '渲染层' }]));
  assert.ok(r.diagnostics.some(d => d.code === 'IR013'), JSON.stringify(r.diagnostics));
});

// ---------------------------------------------------------------- 渲染

test('有 tiers 时：每个 tier 一条泳道背景 rect + 层名 text', () => {
  const svg = compileIrToSvg(judgeIr(base(TIERS_OK)).ir!);
  // 泳道 rect：class 标记，避免与节点 rect 混淆
  const lanes = svg.match(/class="ir-tier"/g) ?? [];
  assert.equal(lanes.length, 3, '应有 3 条泳道');
  for (const name of ['渲染层', '主进程层', '数据层']) {
    assert.ok(svg.includes('>' + name + '<'), '缺层名文本：' + name);
  }
});

test('泳道纵向排布互不重叠，节点 y 落在所属泳道内', () => {
  const ir = judgeIr(base(TIERS_OK)).ir!;
  const lay = layoutIr(ir);
  // 泳道信息进 layout
  assert.ok(lay.tiers && lay.tiers.length === 3);
  const [t0, t1, t2] = lay.tiers;
  assert.ok(t1.y >= t0.y + t0.h, '泳道 1 应在泳道 0 之下');
  assert.ok(t2.y >= t1.y + t1.h, '泳道 2 应在泳道 1 之下');
  // 节点 y 在所属泳道内
  for (const n of lay.nodes) {
    const tier = lay.tiers.find(t => t.row === n.row)!;
    assert.ok(n.y >= tier.y && n.y + n.h <= tier.y + tier.h,
      `节点 ${n.id} 超出所属泳道`);
  }
});

test('无 tiers 时 layout 不产 tiers 字段（现状回归）', () => {
  const lay = layoutIr(judgeIr(base(undefined)).ir!);
  assert.equal(lay.tiers, undefined);
  const svg = compileIrToSvg(judgeIr(base(undefined)).ir!);
  assert.ok(!svg.includes('ir-tier'), '无 tiers 不得画泳道');
});

test('泳道宽度覆盖画布全宽（泳道是横向分带，不是节点框）', () => {
  const ir = judgeIr(base(TIERS_OK)).ir!;
  const svg = compileIrToSvg(ir);
  const vb = Number(svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/)![1]);
  const m = svg.match(/class="ir-tier"[^>]*width="([\d.]+)"/);
  assert.ok(m, '泳道 rect 应带宽度');
  assert.equal(Number(m[1]), vb, '泳道宽应等于画布宽，泳道=' + m[1] + ' 画布=' + vb);
});

test('泳道底色与节点底色可区分（层带是淡底，节点是实底）', () => {
  // 直接断言泳道 fill 用透明度混合，节点 fill 用语义色 —— 视觉层级不同
  const svg = compileIrToSvg(judgeIr(base(TIERS_OK)).ir!);
  const lane = svg.match(/<rect[^>]*class="ir-tier"[^>]*>/)![0];
  assert.ok(/fill="[^"]*transparent\)/.test(lane) || /fill-opacity/.test(lane),
    '泳道应是透明淡底：' + lane);
});