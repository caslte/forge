/**
 * 分层正交连线路由（2026-10-10 用户反馈「鬼画符」驱动 · 阶段 2 排版算法第一刀）。
 *
 * ## 用户为什么骂
 *
 * 阶段 1 的跨行边是「从源右侧出 → 长贝塞尔大弧 → 目标左侧入」。
 * 分层架构图里跨行边占多数，结果就是若干条大弧线交叉横穿整个画布，
 * 视觉上完全无法追踪哪条线连哪两个节点（真机截图原话：鬼画符）。
 *
 * ## 正确的做法（分层图 / Sugiyama 风格的通用惯例）
 *
 * - **同行正向**：短贝塞尔（现状保留，短弧不丑）
 * - **跨行（目标在下方）**：源**底部出 → 垂直下 → 水平 → 目标顶部入**，
 *   正交折线（直角），横平竖直。视线跟随只有两次 90° 转向，天然可读。
 * - **回折（目标在源左侧）**：绕行通道 + 虚线（保留），但同样改正交，不再用弧。
 * - **通道错开**：同一源的多条跨行边，水平段 y 各偏移，避免重叠成一条粗线。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { edgePath, layoutIr, type LaidOutNode } from '../../src/markdown/canvasIrRender.ts';

function node(p: Partial<LaidOutNode> & { id: string }): LaidOutNode {
  return { x: 0, y: 0, w: 120, h: 52, label: 'n', kind: 'process', col: 0, row: 0, ...p } as LaidOutNode;
}

/** 把 path 的 d 串解析成坐标点序列（M/L/C 的控制点全算上）。 */
function points(d: string): Array<{ x: number; y: number }> {
  const out: Array<{ x: number; y: number }> = [];
  const re = /([MLC])\s*([\d.]+)\s+([\d.]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    out.push({ x: Number(m[2]), y: Number(m[3]) });
  }
  return out;
}

// ---------------------------------------------------------------- 跨行 = 正交

test('跨行边走正交折线：无贝塞尔控制点，全直角段', () => {
  const a = node({ id: 'a', x: 0, y: 0, col: 0, row: 0 });
  const b = node({ id: 'b', x: 300, y: 200, col: 2, row: 2 });
  const { d } = edgePath(a, b);
  assert.ok(!d.includes('C'), '跨行边不得用贝塞尔大弧（鬼画符根源），实际：' + d);
  assert.ok(d.includes('L'), '应为折线段');
});

test('跨行边：源底部出（起点 x=源中心，y=源底边），目标顶部入（终点 x=目标中心，y=目标顶边）', () => {
  const a = node({ id: 'a', x: 0, y: 0, w: 120, h: 52 });
  const b = node({ id: 'b', x: 300, y: 200, w: 120, h: 52 });
  const { d } = edgePath(a, b);
  const pts = points(d);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  assert.equal(first.x, 60, '应从源底部中心出：' + first.x);
  assert.equal(first.y, 52, '起点 y 应是源底边：' + first.y);
  assert.equal(last.x, 360, '应入目标顶部中心：' + last.x);
  assert.equal(last.y, 200, '终点 y 应是目标顶边：' + last.y);
});

test('跨行边：中间水平段 y 严格介于两行之间（不穿过任何节点行）', () => {
  const a = node({ id: 'a', x: 0, y: 0, h: 52 });
  const b = node({ id: 'b', x: 300, y: 200, h: 52 });
  const { d } = edgePath(a, b);
  const pts = points(d);
  const midY = pts[1]!.y;
  assert.ok(midY > 52 && midY < 200, '水平段 y 应在 (52,200) 开区间，实际 ' + midY);
  // 且第一段垂直：x 不变
  assert.equal(pts[1]!.x, pts[0]!.x, '第一段应垂直向下');
});

test('同一源的多条跨行边，水平段 y 互相错开（不重叠成一条粗线）', () => {
  const a = node({ id: 'a', x: 0, y: 0 });
  const b1 = node({ id: 'b1', x: 300, y: 200 });
  const b2 = node({ id: 'b2', x: 300, y: 300 });
  const d1 = edgePath(a, b1, { channel: 0 }).d;
  const d2 = edgePath(a, b2, { channel: 1 }).d;
  const y1 = points(d1)[1]!.y;
  const y2 = points(d2)[1]!.y;
  assert.notEqual(y1, y2, '两条边的水平段应错开');
  assert.ok(Math.abs(y1 - y2) >= 6, '错开量应可辨识（≥6px）');
});

// ---------------------------------------------------------------- 回折 = 正交虚线

test('回折边（目标在源左侧）：正交绕行 + 虚线，不再用贝塞尔弧', () => {
  const a = node({ id: 'a', x: 600, y: 0 });
  const b = node({ id: 'b', x: 0, y: 0 });
  const r = edgePath(a, b);
  assert.ok(!r.d.includes('C'), '回折也不得用弧');
  assert.equal(r.dash, true, '回折应标虚线（视觉上区分逆向依赖）');
});

// ---------------------------------------------------------------- 同行 = 短贝塞尔保留

test('同行正向边保留短贝塞尔（短弧不丑，且比直角更柔和）', () => {
  const a = node({ id: 'a', x: 0, y: 0 });
  const b = node({ id: 'b', x: 300, y: 0 });
  const { d, dash } = edgePath(a, b);
  assert.ok(d.includes('C'), '同行正向应保留贝塞尔');
  assert.equal(dash, false);
});

// ---------------------------------------------------------------- 端到端：连线穿过节点的检查

test('布局后的所有跨行连线，水平段不与中间行的任何节点矩形相交', () => {
  // 模型真实产出的形态：4 列 3 行 + 若干跨行边
  const ir = {
    schema_version: 'forge-ir/1', diagram_type: 'architecture', meta: {},
    nodes: [
      { id: 'ui', label: '渲染层', kind: 'component', col: 0, row: 0 },
      { id: 'desk', label: '主进程', kind: 'process', col: 1, row: 0 },
      { id: 'core', label: '引擎层', kind: 'process', col: 2, row: 0 },
      { id: 'ext', label: '扩展层', kind: 'process', col: 3, row: 0 },
      { id: 'pi', label: 'pi', kind: 'external', col: 3, row: 1 },
      { id: 'st', label: 'store', kind: 'storage', col: 2, row: 1 },
      { id: 'ws', label: 'workspace', kind: 'storage', col: 0, row: 1 },
    ],
    edges: [
      { from: 'ui', to: 'desk' }, { from: 'desk', to: 'core' },
      { from: 'core', to: 'ext' }, { from: 'ext', to: 'pi' },
      { from: 'core', to: 'st' }, { from: 'ui', to: 'ws' },
    ],
  };
  const lay = layoutIr(ir);
  const byId = new Map(lay.nodes.map(n => [n.id, n]));

  for (const e of ir.edges) {
    const a = byId.get(e.from)!;
    const b = byId.get(e.to)!;
    if (a.y === b.y) continue; // 同行边不产生跨行水平段
    const { d } = edgePath(a, b, { channel: 0 });
    const pts = points(d);
    const midY = pts[1]!.y;
    // 水平段从 pts[1] 到 pts[2]，扫描所有「既不是源也不是目标」的节点
    for (const n of lay.nodes) {
      if (n.id === a.id || n.id === b.id) continue;
      const intersects =
        midY > n.y && midY < n.y + n.h &&
        Math.max(pts[1]!.x, pts[2]!.x) > n.x && Math.min(pts[1]!.x, pts[2]!.x) < n.x + n.w;
      assert.equal(intersects, false,
        `边 ${e.from}→${e.to} 的水平段(y=${midY}) 穿过节点 ${n.id}`);
    }
  }
});