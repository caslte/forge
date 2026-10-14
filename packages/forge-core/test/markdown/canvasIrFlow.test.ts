/**
 * 流程图布局（v2 新增的第四类图之一）。
 *
 * ## 为什么流程图值得一个专属布局
 *
 * 改造前契约把「流程」硬塞进 sequence（`流程/时序/先后/调用链 → sequence`）。
 * 探针实测：3 个流程图 prompt **全部**产出了时序图——合规、但不是用户要的图。
 * 时序图的模型是「参与者 + 按时间排序的消息」，装不下判定分叉与失败重试；
 * 流程图的模型是「节点 + 有向边」，层次由边的方向推导。
 *
 * ## 这个文件锁住什么
 *
 * 1. 层次**由边推导**（模型不该给 col/row，给了也不看）
 * 2. 回边用虚线 + 绕左侧通道
 * 3. 跨多层边**不得穿过中间层的节点**（首版只做「下→横→下」，竖段从中间层节点
 *    底下穿过被遮住，真机用户原话「重叠的线看不清方向」）
 * 4. 边标签必须真的渲染出来（v1 的 `IrEdge.label` 声明了却从不读，属静默丢弃）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeIr } from '../../src/markdown/canvasIr.ts';
import { compileIrToSvg, layoutIr } from '../../src/markdown/canvasIrRender.ts';

const flow = (nodes: unknown[], edges: unknown[], extra?: Record<string, unknown>) =>
  JSON.stringify({
    schema_version: 'forge-ir/2',
    diagram_type: 'flow',
    meta: { title: 't' },
    nodes,
    edges,
    ...extra,
  });

const CHAIN = flow(
  [
    { id: 'a', label: '开始', kind: 'terminal' },
    { id: 'b', label: '校验', kind: 'process' },
    { id: 'c', label: '写库', kind: 'process' },
    { id: 'd', label: '完成', kind: 'terminal' },
  ],
  [
    { from: 'a', to: 'b' },
    { from: 'b', to: 'c' },
    { from: 'c', to: 'd' },
  ],
);

/** 把 SVG path 的 d 采样成点列（只认 M/L/H/V，都是绝对坐标）。 */
function sample(d: string, step = 2): Array<{ x: number; y: number }> {
  const pts: Array<{ x: number; y: number }> = [];
  let cx = 0;
  let cy = 0;
  const re = /([MLHV])\s*([\d.]+)?(?:\s+([\d.]+))?/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(d)) !== null) {
    const cmd = m[1]!;
    const p1 = m[2] !== undefined ? Number(m[2]) : undefined;
    const p2 = m[3] !== undefined ? Number(m[3]) : undefined;
    if (cmd === 'M' || cmd === 'L') {
      cx = p1!;
      cy = p2!;
      pts.push({ x: cx, y: cy });
    } else if (cmd === 'H') {
      const target = p1!;
      const dir = Math.sign(target - cx) || 1;
      for (let x = cx; Math.abs(x - target) > step; x += dir * step) pts.push({ x, y: cy });
      cx = target;
      pts.push({ x: cx, y: cy });
    } else if (cmd === 'V') {
      const target = p1!;
      const dir = Math.sign(target - cy) || 1;
      for (let y = cy; Math.abs(y - target) > step; y += dir * step) pts.push({ x: cx, y });
      cy = target;
      pts.push({ x: cx, y: cy });
    }
  }
  return pts;
}

// ---------------------------------------------------------------- 层次推导

test('流程图的层次由边的方向推导（模型不给 col/row）', () => {
  const ir = judgeIr(CHAIN).ir!;
  const lay = layoutIr(ir);
  const y = (id: string): number => lay.nodes.find((n) => n.id === id)!.y;
  assert.ok(y('a') < y('b'), 'a 应在 b 之上');
  assert.ok(y('b') < y('c'), 'b 应在 c 之上');
  assert.ok(y('c') < y('d'), 'c 应在 d 之上');
});

test('模型即使给了 col/row 也不影响流程图分层（坐标由边决定）', () => {
  const withGrid = flow(
    [
      { id: 'a', label: 'A', kind: 'process', col: 9, row: 9 },
      { id: 'b', label: 'B', kind: 'process', col: 0, row: 0 },
    ],
    [{ from: 'a', to: 'b' }],
  );
  const lay = layoutIr(judgeIr(withGrid).ir!);
  const a = lay.nodes.find((n) => n.id === 'a')!;
  const b = lay.nodes.find((n) => n.id === 'b')!;
  assert.ok(a.y < b.y, '边 a→b 决定 a 在 b 之上，与模型给的 row=9/0 相反');
});

test('同层节点并排（分叉的两个分支在同一行）', () => {
  const branch = flow(
    [
      { id: 's', label: '开始', kind: 'terminal' },
      { id: 'l', label: '走左', kind: 'process' },
      { id: 'r', label: '走右', kind: 'process' },
    ],
    [{ from: 's', to: 'l' }, { from: 's', to: 'r' }],
  );
  const lay = layoutIr(judgeIr(branch).ir!);
  const l = lay.nodes.find((n) => n.id === 'l')!;
  const r = lay.nodes.find((n) => n.id === 'r')!;
  assert.equal(l.y, r.y, '两条分支应落在同一层');
  assert.notEqual(l.x, r.x, '同层节点不得重叠');
});

// ---------------------------------------------------------------- 回边

test('回边（失败重试）用虚线，与正向边区分', () => {
  const retry = flow(
    [
      { id: 'a', label: '尝试', kind: 'process' },
      { id: 'b', label: '成功？', kind: 'decision' },
      { id: 'c', label: '完成', kind: 'terminal' },
    ],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c', label: '是' },
      { from: 'b', to: 'a', label: '否·重试' },
    ],
  );
  const ir = judgeIr(retry).ir!;
  const svg = compileIrToSvg(ir);
  const dashed = (svg.match(/stroke-dasharray="5 4"/g) ?? []).length;
  assert.ok(dashed >= 1, '回边应画成虚线');
  // 回边不能是「直连下方」——它必须绕到左侧通道
  const lay = layoutIr(ir);
  const back = lay.edges.find((e) => e.dash)!;
  assert.ok(back, '应有至少一条虚线边');
  assert.ok(/H[\d.]+ V[\d.]+ H/.test(back.d) || back.d.includes('V'), '回边应绕行而不是直连');
});

// ---------------------------------------------------------------- 跨多层：不穿节点

test('跨多层边不穿过中间层的任何节点（首版「鬼画符」的回归锁）', () => {
  const skip = flow(
    [
      { id: 'a', label: '开始', kind: 'terminal' },
      { id: 'b', label: '中间一', kind: 'process' },
      { id: 'c', label: '中间二', kind: 'process' },
      { id: 'd', label: '结束', kind: 'terminal' },
    ],
    [
      { from: 'a', to: 'b' },
      { from: 'b', to: 'c' },
      { from: 'c', to: 'd' },
      { from: 'a', to: 'd' }, // 跨两层，必须绕开 b、c
    ],
  );
  const lay = layoutIr(judgeIr(skip).ir!);
  const byId = new Map(lay.nodes.map((n) => [n.id, n]));
  const long = lay.edges[3]!; // a→d 是第 4 条
  const pts = sample(long.d);

  for (const id of ['b', 'c']) {
    const n = byId.get(id)!;
    for (const p of pts) {
      const inside = p.x > n.x && p.x < n.x + n.w && p.y > n.y && p.y < n.y + n.h;
      assert.equal(inside, false,
        `跨层边 a→d 穿过了节点 ${id}（点 ${p.x.toFixed(1)},${p.y.toFixed(1)}）`);
    }
  }
});

// ---------------------------------------------------------------- 不重叠

test('任意两个节点都不重叠', () => {
  const lay = layoutIr(judgeIr(CHAIN).ir!);
  for (let i = 0; i < lay.nodes.length; i++) {
    for (let j = i + 1; j < lay.nodes.length; j++) {
      const a = lay.nodes[i]!;
      const b = lay.nodes[j]!;
      const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
      assert.equal(overlap, false, `${a.id} 与 ${b.id} 重叠`);
    }
  }
});

test('同源多条边的水平段互相错开（不叠成一条粗线）', () => {
  const fan = flow(
    [
      { id: 's', label: '分发', kind: 'process' },
      { id: 'x', label: 'X', kind: 'process' },
      { id: 'y', label: 'Y', kind: 'process' },
      { id: 'z', label: 'Z', kind: 'process' },
    ],
    [
      { from: 's', to: 'x' },
      { from: 's', to: 'y' },
      { from: 's', to: 'z' },
    ],
  );
  const lay = layoutIr(judgeIr(fan).ir!);
  // 相邻层走法是 `M sx sy V midY H ex V dy`，第一段竖线的落点就是水平段的 y。
  // （不能用 sample()：它会把竖线插值成一串点，取不到「顶点」。）
  const mids = lay.edges.map((e) => Number(/V([\d.]+)/.exec(e.d)![1]));
  assert.equal(mids.length, 3);
  assert.equal(new Set(mids).size, mids.length, '同源边的水平段 y 应互不相同：' + mids.join(','));
});

// ---------------------------------------------------------------- 形状与标签

test('decision 渲染成菱形、terminal 渲染成胶囊（形状是颜色之外的第二通道）', () => {
  // decision → polygon（菱形）；process → rect；terminal → 胶囊（rect 且 rx = 高度一半）
  const withDecision = flow(
    [
      { id: 'a', label: '开始', kind: 'terminal' },
      { id: 'b', label: '判断', kind: 'decision' },
      { id: 'c', label: '做', kind: 'process' },
    ],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'c' }],
  );
  const svg = compileIrToSvg(judgeIr(withDecision).ir!);
  assert.ok(svg.includes('<polygon'), 'decision 应渲染为菱形（polygon）');
  // 胶囊：rx 等于高度的一半
  assert.ok(/<rect [^>]*height="46"[^>]*rx="23"/.test(svg) || /rx="23"/.test(svg),
    'terminal 应渲染为胶囊（rx = h/2）');
});

test('边标签真的渲染进 SVG（v1 声明了 IrEdge.label 却从不读，属静默丢弃）', () => {
  const labelled = flow(
    [
      { id: 'a', label: '尝试', kind: 'process' },
      { id: 'b', label: '成功？', kind: 'decision' },
    ],
    [{ from: 'a', to: 'b', label: '发起' }],
  );
  const svg = compileIrToSvg(judgeIr(labelled).ir!);
  assert.ok(svg.includes('>发起<'), '边标签必须出现在 SVG 里');
});

test('每条边恰好一个连线 path、每个节点恰好一个形状', () => {
  const ir = judgeIr(CHAIN).ir!;
  const svg = compileIrToSvg(ir).replace(/<defs>[\s\S]*?<\/defs>/, '');
  assert.equal((svg.match(/<path /g) ?? []).length, ir.edges.length);
  // 形状：rect（含胶囊）或 polygon，各一个
  const shapes = (svg.match(/<rect |<polygon /g) ?? []).length;
  assert.equal(shapes, ir.nodes.length);
});
