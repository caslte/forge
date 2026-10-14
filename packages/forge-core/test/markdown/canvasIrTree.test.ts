/**
 * 树 / 思维导图布局（v2 新增）。
 *
 * ## 两个 variant 的实质差别
 *
 * - `tree`：水平树，根在最左，子节点向右展开。适合目录结构、分类体系。
 * - `mindmap`：根在**中间**，一级分支向左右两侧展开。适合要点拆解——
 *   中心是主题、两侧是维度。这是画法的差别，不是配色或圆角的差别。
 *
 * ## 这个文件锁住什么
 *
 * 1. 深度决定列（父子跨列），父节点纵向居中于子节点
 * 2. 节点互不重叠——后序遍历定 y 的全部意义就在这
 * 3. mindmap 的根在中间，且左右两侧都真的用上了
 * 4. 校验器已保证「恰好一个根」，但布局器仍要防御（不抛异常）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeIr } from '../../src/markdown/canvasIr.ts';
import { compileIrToSvg, layoutIr } from '../../src/markdown/canvasIrRender.ts';

const tree = (nodes: unknown[], edges: unknown[], variant?: string) =>
  JSON.stringify({
    schema_version: 'forge-ir/2',
    diagram_type: 'tree',
    meta: { title: 't' },
    ...(variant ? { tree: { variant } } : {}),
    nodes,
    edges,
  });

/** 三层树：根 → 2 个分支 → 3 个叶子。 */
const TREE3 = tree(
  [
    { id: 'root', label: '仓库' },
    { id: 'src', label: 'src' },
    { id: 'docs', label: 'docs' },
    { id: 'a', label: 'index.ts' },
    { id: 'b', label: 'util.ts' },
    { id: 'c', label: 'guide.md' },
  ],
  [
    { from: 'root', to: 'src' },
    { from: 'root', to: 'docs' },
    { from: 'src', to: 'a' },
    { from: 'src', to: 'b' },
    { from: 'docs', to: 'c' },
  ],
);

const byId = (lay: { nodes: Array<{ id: string; x: number; y: number; w: number; h: number }> }, id: string) =>
  lay.nodes.find((n) => n.id === id)!;

// ---------------------------------------------------------------- 校验

test('树恰好一个根时判 ok', () => {
  const r = judgeIr(TREE3);
  assert.equal(r.verdict, 'ok', JSON.stringify(r.diagnostics));
});

test('两个根（多个无入边节点）报 IR017', () => {
  const twoRoots = tree(
    [{ id: 'r1', label: 'A' }, { id: 'r2', label: 'B' }],
    [],
  );
  // 无边 ⇒ 两个节点都没有入边 ⇒ 两个根
  const r = judgeIr(twoRoots);
  assert.ok(r.diagnostics.some((d) => d.code === 'IR017'), JSON.stringify(r.diagnostics));
});

test('成环导致没有根，报 IR017（并提示可以换 flow / architecture）', () => {
  const cycle = tree(
    [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
    [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }],
  );
  const r = judgeIr(cycle);
  const d = r.diagnostics.find((x) => x.code === 'IR017')!;
  assert.ok(d, '成环应报 IR017');
  assert.ok(d.supportedFixes.join(' ').includes('flow'), '修复建议里应给出替代类型');
});

// ---------------------------------------------------------------- 布局

test('深度决定列：父子不同列，同深度的节点同列', () => {
  const lay = layoutIr(judgeIr(TREE3).ir!);
  const root = byId(lay, 'root');
  const src = byId(lay, 'src');
  const a = byId(lay, 'a');
  assert.ok(root.x < src.x, '根应在子节点左侧');
  assert.ok(src.x < a.x, 'src 应在孙节点左侧');
  // 同列 = 列心对齐。节点在列内**居中**（宽度不同则左边界不同，这是有意的：
  // 原型页就是这么画的，用户确认「思维导图没问题」）。
  const cx = (n: { x: number; w: number }) => n.x + n.w / 2;
  assert.equal(cx(src), cx(byId(lay, 'docs')), '同深度的节点应同列（列心对齐）');
  assert.equal(cx(a), cx(byId(lay, 'b')), '同深度的叶子应同列（列心对齐）');
});

test('父节点纵向居中于它的子节点', () => {
  const lay = layoutIr(judgeIr(TREE3).ir!);
  const src = byId(lay, 'src');
  const a = byId(lay, 'a');
  const b = byId(lay, 'b');
  const mid = (a.y + a.h / 2 + b.y + b.h / 2) / 2;
  assert.ok(Math.abs(src.y + src.h / 2 - mid) < 0.001,
    `src 应居中于 a/b：期望 ${mid}，实际 ${src.y + src.h / 2}`);
});

test('任意两个节点都不重叠', () => {
  const lay = layoutIr(judgeIr(TREE3).ir!);
  for (let i = 0; i < lay.nodes.length; i++) {
    for (let j = i + 1; j < lay.nodes.length; j++) {
      const p = lay.nodes[i]!;
      const q = lay.nodes[j]!;
      const overlap = p.x < q.x + q.w && q.x < p.x + p.w && p.y < q.y + q.h && q.y < p.y + p.h;
      assert.equal(overlap, false, `${p.id} 与 ${q.id} 重叠`);
    }
  }
});

test('画布尺寸容纳全部节点', () => {
  const lay = layoutIr(judgeIr(TREE3).ir!);
  for (const n of lay.nodes) {
    assert.ok(n.x + n.w <= lay.width + 0.001, n.id + ' 右边界超出画布');
    assert.ok(n.y + n.h <= lay.height + 0.001, n.id + ' 下边界超出画布');
    assert.ok(n.x >= -0.001 && n.y >= -0.001, n.id + ' 坐标为负');
  }
});

test('每条边一条连线，且不带箭头（树是归属关系，不是流向）', () => {
  const ir = judgeIr(TREE3).ir!;
  const svg = compileIrToSvg(ir).replace(/<defs>[\s\S]*?<\/defs>/, '');
  assert.equal((svg.match(/<path /g) ?? []).length, ir.edges.length);
  assert.ok(!svg.includes('marker-end'), '树的连线不应带箭头');
});

// ---------------------------------------------------------------- mindmap

test('mindmap：根在中间，一级分支分居左右两侧', () => {
  const mm = tree(
    [
      { id: 'root', label: '主题' },
      { id: 'l1', label: '维度一' },
      { id: 'l2', label: '维度二' },
      { id: 'l3', label: '维度三' },
    ],
    [
      { from: 'root', to: 'l1' },
      { from: 'root', to: 'l2' },
      { from: 'root', to: 'l3' },
    ],
    'mindmap',
  );
  const lay = layoutIr(judgeIr(mm).ir!);
  const root = byId(lay, 'root');
  const rootCx = root.x + root.w / 2;
  // 一级分支**交替**分居两侧（1→右、2→左、3→右），这样两侧的纵向跨度接近、
  // 视觉更均衡；若按「前半右、后半左」切，一侧会全挤在上半部。
  const left = [byId(lay, 'l2')];
  const right = [byId(lay, 'l1'), byId(lay, 'l3')];

  for (const n of left) {
    assert.ok(n.x + n.w <= rootCx, `左侧分支 ${n.id} 应在根中心左侧`);
  }
  for (const n of right) {
    assert.ok(n.x >= rootCx, `右侧分支 ${n.id} 应在根中心右侧`);
  }
});

test('mindmap：子节点的子节点跟随父节点所在的一侧', () => {
  const mm = tree(
    [
      { id: 'root', label: '主题' },
      { id: 'r1', label: '右支' },
      { id: 'l1', label: '左支' },
      { id: 'r1a', label: '右支的子' },
      { id: 'l1a', label: '左支的子' },
    ],
    [
      { from: 'root', to: 'r1' },
      { from: 'root', to: 'l1' },
      { from: 'r1', to: 'r1a' },
      { from: 'l1', to: 'l1a' },
    ],
    'mindmap',
  );
  const lay = layoutIr(judgeIr(mm).ir!);
  const root = byId(lay, 'root');
  const rootCx = root.x + root.w / 2;
  const r1 = byId(lay, 'r1');
  const l1 = byId(lay, 'l1');
  assert.ok(byId(lay, 'r1a').x >= rootCx, '右支的孙节点也应在右侧');
  assert.ok(byId(lay, 'l1a').x + byId(lay, 'l1a').w <= rootCx, '左支的孙节点也应在左侧');
  assert.ok(r1.x < byId(lay, 'r1a').x, '右侧应向外展开');
  assert.ok(byId(lay, 'l1a').x < l1.x, '左侧应向外展开');
});

test('tree 与 mindmap 的产物不同（variant 真的生效，不是同一个画法）', () => {
  const same = [
    { id: 'root', label: '主题' },
    { id: 'l1', label: '一' },
    { id: 'l2', label: '二' },
  ];
  const sameEdges = [{ from: 'root', to: 'l1' }, { from: 'root', to: 'l2' }];
  const t = layoutIr(judgeIr(tree(same, sameEdges)).ir!);
  const mm = layoutIr(judgeIr(tree(same, sameEdges, 'mindmap')).ir!);
  assert.notEqual(JSON.stringify(t.nodes), JSON.stringify(mm.nodes),
    'mindmap 的节点坐标应与 tree 不同');
});

// ---------------------------------------------------------------- 边界

test('单节点树不崩（无边也算合法）', () => {
  const single = tree([{ id: 'only', label: '唯一' }], []);
  const r = judgeIr(single);
  // 单节点无边：既没边也没多个根，应判 ok
  assert.equal(r.verdict, 'ok', JSON.stringify(r.diagnostics));
  const svg = compileIrToSvg(r.ir!);
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>'));
});

test('标签含特殊字符被转义（防标签注入）', () => {
  const evil = tree(
    [
      { id: 'root', label: '根' },
      // 标签长度须在上限（IR_MAX_LABEL_CHARS=24）内，否则先被 IR012 拦下，
      // 就测不到「转义」这条了
      { id: 'x', label: '<script>x</script>' },
    ],
    [{ from: 'root', to: 'x' }],
  );
  const svg = compileIrToSvg(judgeIr(evil).ir!);
  assert.ok(!svg.includes('<script>'), '不得输出未转义的 script');
  assert.ok(svg.includes('&lt;script&gt;'));
});
