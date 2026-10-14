/**
 * 树 / 思维导图布局编译器。
 *
 * ## 两个 variant 的差别（以及为什么这次就做）
 *
 * - `tree`：水平树。根在最左，子节点向右展开，父节点纵向居中于子节点。
 *   适合目录结构、分类体系这类「从根往下读」的内容。
 * - `mindmap`：根在**中间**，一级分支向左右两侧展开。适合「要点拆解」——
 *   中心是主题，两侧是维度。这是思维导图与树的实质差别，不是配色差别。
 *
 * 两者共用同一套「后序遍历定 y、按深度定列」的骨架，只在**列怎么算 x** 处分叉：
 * tree 所有列向右累加；mindmap 把根放中间，左半子树镜像到左侧。
 *
 * ## 为什么用后序遍历定 y
 *
 * 叶子按出现顺序依次往下排，父节点取「首子与末子的中点」。
 * 这样得到的树**天然不重叠**且父节点视觉居中，不需要迭代调整。
 * 用前序遍历（先定父再定子）会得到「父节点居中于整棵子树」的近似值，
 * 深树会出现明显的偏斜。
 */

import { fitNode, FONT_NODE, LINE_H } from './textFit.ts';
import { styleOf } from './shapes.ts';
import type { IrLayout, LaidOutEdge, LaidOutNode } from './layoutTypes.ts';
import type { IrDocument } from '../canvasIr.ts';

/** 同层纵向间隙（px）。 */
const V_GAP = 10;
/** 层间横向间隙（px）。 */
const H_GAP = 44;
/** 画布左右留白。 */
const SIDE = 14;
/** 根节点最小列宽。 */
const MIN_COL_W = 80;

/**
 * 树 / 思维导图布局。
 *
 * 前置条件：校验器已保证「恰好一个根」。这里仍做防御——若拿不到根
 * （例如调用方绕过校验器），退化为「第一个没有入边的节点」，
 * 再不行就用第 0 个节点，绝不抛异常。
 */
export function layoutTree(ir: IrDocument): IrLayout {
  const issues: string[] = [];
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const N = nodes.length;
  if (N === 0) return { nodes: [], edges: [], width: 240, height: 120, issues };

  const meta = nodes.map((n) => {
    const st = styleOf(n.kind);
    return { st, sz: fitNode(n.label, st.shape) };
  });

  const idx: Record<string, number> = {};
  nodes.forEach((n, i) => { idx[String(n.id)] = i; });

  const kids: number[][] = Array.from({ length: N }, () => []);
  const hasParent = new Array<boolean>(N).fill(false);
  const parentOf = new Array<number>(N).fill(-1);
  for (const e of ir.edges ?? []) {
    const a = idx[String(e.from)];
    const b = idx[String(e.to)];
    if (a === undefined || b === undefined || a === b) continue;
    kids[a]!.push(b);
    hasParent[b] = true;
    parentOf[b] = a;
  }

  let root = -1;
  for (let i = 0; i < N; i++) if (!hasParent[i]) { root = i; break; }
  if (root < 0) {
    issues.push('没有找到根节点（可能成环），已用第 1 个节点当根');
    root = 0;
  }

  // 后序遍历：叶子依次往下排，父节点取首末子中点
  const depth = new Array<number>(N).fill(0);
  const cy = new Array<number>(N).fill(0);
  let cursor = 10;
  let maxDepth = 0;
  const walk = (v: number, d: number): void => {
    depth[v] = d;
    if (d > maxDepth) maxDepth = d;
    const ch = kids[v]!;
    if (!ch.length) {
      cy[v] = cursor + meta[v]!.sz.bh / 2;
      cursor += meta[v]!.sz.bh + V_GAP;
      return;
    }
    for (const k of ch) walk(k, d + 1);
    cy[v] = (cy[ch[0]!]! + cy[ch[ch.length - 1]!]!) / 2;
  };
  walk(root, 0);

  // 未连到根的子图（校验器拦下，这里兜住）：各自当作独立子树挂在末尾
  for (let i = 0; i < N; i++) {
    if (depth[i] === 0 && i !== root) {
      walk(i, 1);
      issues.push('节点 ' + nodes[i]!.id + ' 不在根的子树上，已单独摆放');
    }
  }

  // 每列宽度
  const colW: number[] = Array.from({ length: maxDepth + 1 }, () => MIN_COL_W);
  for (let i = 0; i < N; i++) colW[depth[i]!] = Math.max(colW[depth[i]!]!, meta[i]!.sz.bw);

  const mindmap = ir.tree?.variant === 'mindmap';

  // 每个节点属于根的哪个一级分支（决定 mindmap 的左/右）
  const side = new Array<number>(N).fill(1);
  if (mindmap) {
    const firstKids = kids[root]!;
    firstKids.forEach((k, ki) => {
      const s = ki % 2 === 0 ? 1 : -1; // 交替左右，视觉更均衡
      const stack = [k];
      while (stack.length) {
        const v = stack.pop()!;
        side[v] = s;
        for (const c of kids[v]!) stack.push(c);
      }
    });
  }

  // 列 x 偏移：从根向外累加（不含根）
  const stepOf = (d: number): number => (d <= 0 ? 0 : colW[d - 1]! + H_GAP);
  const offsetTo = (d: number): number => {
    let s = 0;
    for (let k = 1; k <= d; k++) s += stepOf(k);
    return s;
  };

  const rootW = colW[0]!;
  const maxRight = Math.max(0, ...nodes.map((_, i) => (side[i]! > 0 ? depth[i]! : 0)));
  const maxLeft = Math.max(0, ...nodes.map((_, i) => (side[i]! < 0 ? depth[i]! : 0)));

  let rootCx: number;
  let width: number;
  if (mindmap) {
    const rightExtent = offsetTo(maxRight) + (maxRight > 0 ? colW[maxRight]! : rootW / 2);
    const leftExtent = offsetTo(maxLeft) + (maxLeft > 0 ? colW[maxLeft]! : rootW / 2);
    rootCx = SIDE + leftExtent;
    width = SIDE * 2 + leftExtent + rightExtent;
  } else {
    let acc = SIDE;
    for (let d = 0; d <= maxDepth; d++) acc += colW[d]! + H_GAP;
    width = acc - H_GAP + SIDE;
    rootCx = SIDE + rootW / 2;
  }

  const pos = nodes.map((_, i) => {
    const d = depth[i]!;
    let x: number;
    if (!mindmap || i === root) {
      if (!mindmap) {
        let off = SIDE;
        for (let k = 0; k < d; k++) off += colW[k]! + H_GAP;
        x = off + (colW[d]! - meta[i]!.sz.bw) / 2;
      } else {
        x = rootCx - meta[i]!.sz.bw / 2;
      }
    } else if (side[i]! > 0) {
      x = rootCx + offsetTo(d) + (colW[d]! - meta[i]!.sz.bw) / 2;
    } else {
      x = rootCx - offsetTo(d) - colW[d]! + (colW[d]! - meta[i]!.sz.bw) / 2;
    }
    return {
      x,
      y: cy[i]! - meta[i]!.sz.bh / 2,
      bw: meta[i]!.sz.bw,
      bh: meta[i]!.sz.bh,
    };
  });

  // 最小 x 可能为负（mindmap 左侧列宽不齐时），整体右移
  const minX = Math.min(...pos.map((p) => p.x));
  if (minX < 0) {
    for (const p of pos) p.x -= minX;
    width -= minX;
  }

  const height = Math.max(1, cursor - V_GAP + 10);

  const outNodes: LaidOutNode[] = nodes.map((n, i) => ({
    id: String(n.id),
    label: String(n.label ?? ''),
    kind: n.kind,
    row: n.row,
    col: n.col,
    x: pos[i]!.x,
    y: pos[i]!.y,
    w: pos[i]!.bw,
    h: pos[i]!.bh,
    lines: meta[i]!.sz.lines,
    shape: meta[i]!.st.shape,
    style: meta[i]!.st,
  }));

  // 边：三次贝塞尔，横向出入。mindmap 的左侧分支方向相反。
  const outEdges: LaidOutEdge[] = [];
  for (const e of ir.edges ?? []) {
    const a = idx[String(e.from)];
    const b = idx[String(e.to)];
    if (a === undefined || b === undefined || a === b) continue;
    const A = pos[a]!;
    const B = pos[b]!;
    const toRight = B.x >= A.x;
    const sx = toRight ? A.x + A.bw : A.x;
    const dx = toRight ? B.x : B.x + B.bw;
    const sy = A.y + A.bh / 2;
    const dy = B.y + B.bh / 2;
    const mx = (sx + dx) / 2;
    outEdges.push({
      d: 'M' + sx + ' ' + sy + ' C' + mx + ' ' + sy + ' ' + mx + ' ' + dy + ' ' + dx + ' ' + dy,
      dash: false,
      lx: mx,
      ly: (sy + dy) / 2,
    });
  }

  if (width > 560) issues.push('树较宽（' + Math.round(width) + 'px），卡片内会被缩小');

  // arrows:false —— 树/思维导图的父子是归属关系，不是流向。
  return { nodes: outNodes, edges: outEdges, width, height, issues, arrows: false };
}

/** 供渲染器对齐字号。 */
export const TREE_FONT_NODE = FONT_NODE;
export const TREE_LINE_H = LINE_H;
