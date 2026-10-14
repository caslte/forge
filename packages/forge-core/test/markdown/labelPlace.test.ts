/**
 * 边标签锚点消歧（2026-10-13 用户截图实测「架构图字遮挡」的修复）。
 *
 * 背景：边标签是带底色药丸（宽 文本+14、高 19），锚点由布局器的几何中心给出。
 * 药丸一旦压到节点盒，渲染层又先画药丸后画节点 ⇒ 被压的半个字直接消失。
 * labelPlace.ts 负责在布局返回前把锚点挪到干净位置。本文件锁住它的四条行为。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  placeLabelAnchor,
  pillRect,
  resolveEdgeLabels,
  type Rect,
} from '../../src/markdown/canvasIr/labelPlace.ts';

/** 造一个节点盒。 */
function box(x: number, y: number, w = 80, h = 46): Rect {
  return { x, y, w, h };
}

test('pillRect：药丸以锚点居中，宽 = 文本宽 + 14，高 = 19', () => {
  // 「渲染」= 2 个全角字 × 11.5 + 14 ≈ 37
  const r = pillRect(100, 50, '渲染');
  assert.ok(r.w > 30 && r.w < 45, '宽度应约为 2 全角字 + 内边距：' + r.w);
  assert.equal(r.h, 19);
  assert.ok(Math.abs(r.x + r.w / 2 - 100) < 0.01, 'x 居中');
  assert.ok(Math.abs(r.y + r.h / 2 - 50) < 0.01, 'y 居中');
});

test('placeLabelAnchor：锚点本来就干净 ⇒ 原样返回（能不挪就不挪）', () => {
  const p = placeLabelAnchor(300, 100, 'RPC', [box(0, 0), box(400, 200)], 600, 400);
  assert.deepEqual(p, { x: 300, y: 100 });
});

test('placeLabelAnchor：锚点压住节点盒 ⇒ 位移到干净候选', () => {
  // 锚点 (100,100) 正压在盒 (80..160, 80..126) 上
  const blockers = [box(80, 80)];
  const p = placeLabelAnchor(100, 100, 'RPC', blockers, 600, 400);
  const moved = pillRect(p.x, p.y, 'RPC');
  for (const b of blockers) {
    const hit = moved.x < b.x + b.w && moved.x + moved.w > b.x
      && moved.y < b.y + b.h && moved.y + moved.h > b.y;
    assert.ok(!hit, `位移后仍压盒：(${p.x},${p.y})`);
  }
});

test('placeLabelAnchor：无干净候选时取相交最少（不抖回原点）', () => {
  // 360×120 的小画布几乎被盒占满：任何位置都至少压一个盒
  const blockers = [box(0, 0, 120, 120), box(120, 0, 120, 120), box(240, 0, 120, 120)];
  const p = placeLabelAnchor(180, 60, '很长的一段标签文字', blockers, 360, 120);
  const moved = pillRect(p.x, p.y, '很长的一段标签文字');
  const hits = blockers.filter((b) =>
    moved.x < b.x + b.w && moved.x + moved.w > b.x && moved.y < b.y + b.h && moved.y + moved.h > b.y).length;
  assert.ok(hits <= 1, '应取相交最少的候选，实际相交 ' + hits + ' 个');
  // 至少要比原点（压 2 个以上）好
  const origin = pillRect(180, 60, '很长的一段标签文字');
  const originHits = blockers.filter((b) =>
    origin.x < b.x + b.w && origin.x + origin.w > b.x && origin.y < b.y + b.h && origin.y + origin.h > b.y).length;
  assert.ok(hits <= originHits, '不得比原点更差');
});

test('placeLabelAnchor：出界候选被跳过（锚点被夹在画布内）', () => {
  // 锚点贴右下角，唯一干净的方向是往左上
  const p = placeLabelAnchor(590, 390, 'x', [box(560, 360, 40, 40)], 600, 400);
  assert.ok(p.x >= 0 && p.y >= 0);
  assert.ok(pillRect(p.x, p.y, 'x').x + pillRect(p.x, p.y, 'x').w <= 600);
});

test('resolveEdgeLabels：先放的药丸进阻挡集，后放的给它让位', () => {
  const edges = [
    { label: ' forge:invoke', lx: 400, ly: 200 },
    { label: '画布挂载', lx: 408, ly: 200 },
  ];
  resolveEdgeLabels(edges, [], 900, 600);
  const a = pillRect(edges[0]!.lx, edges[0]!.ly, edges[0]!.label!);
  const b = pillRect(edges[1]!.lx, edges[1]!.ly, edges[1]!.label!);
  const hit = a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
  assert.ok(!hit, `两个药丸重叠：(${edges[0]!.lx},${edges[0]!.ly}) vs (${edges[1]!.lx},${edges[1]!.ly})`);
  // 无标签的边不动
  const plain = [{ lx: 10, ly: 10 }];
  resolveEdgeLabels(plain, [], 900, 600);
  assert.deepEqual(plain, [{ lx: 10, ly: 10 }]);
});

test('resolveEdgeLabels：同样输入永远同样输出（确定性，无随机遍历）', () => {
  const run = () => {
    const edges = [
      { label: '甲', lx: 200, ly: 150 },
      { label: '乙乙乙', lx: 205, ly: 150 },
      { label: '丙', lx: 210, ly: 150 },
    ];
    resolveEdgeLabels(edges, [box(190, 140)], 800, 500);
    return edges.map((e) => `${e.lx},${e.ly}`).join('|');
  };
  assert.equal(run(), run());
});
