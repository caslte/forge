/**
 * 分层布局编译器：**流程图** 与 **架构图** 共用。
 *
 * ## 两类图为什么共用一个编译器
 *
 * 它们要解决的是同一个问题：「把节点按某种纵向层次排开，再连起来」。
 * 差别只在**层次从哪来**：
 * - 流程图：层次由边的方向推导（拓扑分层），模型不该给 col/row
 * - 架构图：层次由模型显式声明（tier + row），且层名本身是表达的一部分
 *
 * 所以共用一套「分层 → 定序 → 定位 → 路由」，只在「层次来源」处分叉。
 * 拆成两个编译器会复制那四步里 80% 的代码。
 *
 * ## 首版踩过的坑（都写进了实现，别再改回去）
 *
 * 1. **同格不重叠**：模型可能给两个节点同一个 col/row。编译器兜住（挪到下一个空列），
 *    而不是画出两个叠在一起的方块让用户以为渲染坏了。
 * 2. **折行必须重映射列号**：首版折了行却仍按原列号累加 x，结果「折了行但宽度没变」
 *    （12 列折 3 行后 width 仍 1268px）。
 * 3. **跨多层边要绕右侧留白**：只做「下→横→下」会让竖段从中间层的节点底下穿过，
 *    被节点遮住 ⇒ 线看起来断了。真机用户原话「重叠的线看不清方向」。
 * 4. **同源边的通道号只按源编号**：首版把方向也编进 key，导致同源的两条边拿到同一个
 *    通道号、水平段完全重叠。现在通道号只按源分配，且间距拉到 14px。
 * 5. **汇聚到同一节点的边要错开**：三条边全扎到目标节点正上方会糊成一团，
 *    按 ±16px 摊开落点。
 * 6. **边标签要绕开节点盒**：节点画在药丸之后，药丸压盒即被盖半个（2026-10-13
 *    用户截图实测「字遮挡」）。布局器只给几何初值，返回前统一过 resolveEdgeLabels。
 * 7. **架构图同层边不画**（2026-10-13 用户裁定）：曾为「同层边怎么画才不难看」连修两轮
 *    （2026-10-12 夹块穿越 → 加挡路检测；2026-10-13 挡路检测补 y 分量 → 修折行带误判），
 *    用户看修复后的 43 节点图仍判「完全看不懂」，并给出规则本身：「层内不画线，层和层
 *    之间可以划线……本身就是架构，画大方向的内容」。方向错了，不再修画法——同层边
 *    直接不画（校验仍合法，只记 issue）。**流程图的同层边照画**，该规则只约束架构图。
 * 8. **跨层箭头按「相邻层缝隙」归并，每道缝隙最多一条**（2026-10-13 用户第二轮裁定）：
 *    首版按「层对」画（8 个层对 ⇒ 8 条），跨多层的只能挤到右侧留白绕行，用户看截图问
 *    「你这个箭头是什么意思，这么乱，层和层之间需要这么多箭头吗」。现在一道缝隙一条
 *    短箭头，方向按依赖方向（上下都有则画双向箭头），箭头数 ≤ 层数−1，右侧通道消失。
 *    附带：上一版为「双向层对不重合」做的 ±7px 主轴偏置随之作废（两条合成一条双向线）。
 */

import { fitNode } from './textFit.ts';
import { styleOf } from './shapes.ts';
import { resolveEdgeLabels } from './labelPlace.ts';
import type { Box, IrLayout, LaidOutEdge, LaidOutNode, LaidOutTier } from './layoutTypes.ts';
import type { IrDocument, IrNode } from '../canvasIr.ts';

/** 画布宽度目标（px）。超出即触发折行/提示——卡片宽度固定，太宽会被缩到不可读。 */
export const IR_MAX_CANVAS_W = 560;

/** 单层最多几列，超过即折行。5 列 × 最小宽 + 间距正好落在 IR_MAX_CANVAS_W 内。 */
const MAX_COLS = 5;

/** 流程图：层间距 / 同层节点间距。 */
const FLOW_H_GAP = 36;
const FLOW_V_GAP = 50;

/**
 * 折行带的子行间距（px）。
 *
 * 首版 12px：省垂直空间，但边标签药丸高 19px **永远塞不进子行间隙**——Z 折线的
 * 标签锚点在间隙中点，药丸必然同时压住上下两个盒子（实测 43 节点架构图，
 * 引擎层「渲染」边的标签骑在 ConversationService 与 renderMarkdown 两个盒子上）。
 * 22px = 药丸高 19 + 两侧各 1.5px 余量：标签能干净落在间隙里，折行带的层次感
 * 也更好。代价是最多 3 子行 × 10px = 30px 垂直空间，可接受。
 */
const ARCH_SUB_GAP = 22;

/** 架构图：列间距 / 画布左右留白 / 层名带高 / 层内下边距 / 层间距。 */
const ARCH_GAP = 28;
const ARCH_SIDE = 16;
const ARCH_TIER_LABEL = 26;
const ARCH_TIER_PAD = 14;
const ARCH_TIER_GAP = 28;
/** 无层名时的层内边距（不需要给层名留位置）。 */
const ARCH_BAND_PAD = 8;

interface Meta {
  sz: ReturnType<typeof fitNode>;
  st: ReturnType<typeof styleOf>;
}

function metaOf(nodes: IrNode[]): Meta[] {
  return nodes.map((n) => {
    const st = styleOf(n.kind);
    return { st, sz: fitNode(n.label, st.shape) };
  });
}

function toLaidOut(n: IrNode, i: number, p: Box, meta: Meta[]): LaidOutNode {
  const m = meta[i]!;
  return {
    id: String(n.id),
    label: String(n.label ?? ''),
    kind: n.kind,
    row: n.row,
    col: n.col,
    x: p.x,
    y: p.y,
    w: p.bw,
    h: p.bh,
    lines: m.sz.lines,
    shape: m.st.shape,
    style: m.st,
  };
}

/* ============================================================ 流程图 ============================================================ */

interface FlowCfg {
  hGap: number;
  vGap: number;
}

/**
 * 流程图布局：层次完全由边的方向推导。
 *
 * 算法（Sugiyama 的最小版）：
 * 1. DFS 找出回边（回边不参与分层，否则有环就分不出层）
 * 2. 拓扑序 + 最长路径定层
 * 3. 层号归一（去掉空层）
 * 4. 重心法排序 4 轮（上→下、下→上各两轮），减少交叉
 * 5. 逐层居中摆放
 * 6. 按「层关系」分四种走法路由
 */
export function layoutFlow(ir: IrDocument, cfg: FlowCfg = { hGap: FLOW_H_GAP, vGap: FLOW_V_GAP }): IrLayout {
  const issues: string[] = [];
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const N = nodes.length;
  const meta = metaOf(nodes);

  if (N === 0) return { nodes: [], edges: [], width: 240, height: 120, issues };

  const idx: Record<string, number> = {};
  for (let i = 0; i < N; i++) idx[String(nodes[i]!.id)] = i;

  const inn: number[][] = Array.from({ length: N }, () => []);
  const out: number[][] = Array.from({ length: N }, () => []);
  const edges: { a: number; b: number; label?: string }[] = [];
  for (const e of ir.edges ?? []) {
    const a = idx[String(e.from)];
    const b = idx[String(e.to)];
    if (a === undefined || b === undefined || a === b) continue;
    out[a]!.push(b);
    inn[b]!.push(a);
    edges.push({ a, b, label: e.label });
  }

  // 1) DFS 找回边
  const back: Record<string, boolean> = {};
  const mark = new Array<number>(N).fill(0);
  const dfsBreak = (v: number): void => {
    mark[v] = 1;
    for (const w of out[v]!) {
      if (mark[w] === 1) back[v + '>' + w] = true;
      else if (mark[w] === 0) dfsBreak(w);
    }
    mark[v] = 2;
  };
  for (let i = 0; i < N; i++) if (mark[i] === 0) dfsBreak(i);

  // 2) 拓扑序 + 最长路径分层
  let layer = new Array<number>(N).fill(0);
  const indeg = new Array<number>(N).fill(0);
  for (const e of edges) if (!back[e.a + '>' + e.b]) indeg[e.b]!++;
  const queue: number[] = [];
  for (let i = 0; i < N; i++) if (indeg[i] === 0) queue.push(i);
  const topo: number[] = [];
  while (queue.length) {
    const v = queue.shift()!;
    topo.push(v);
    for (const w of out[v]!) {
      if (back[v + '>' + w]) continue;
      indeg[w]!--;
      if (indeg[w] === 0) queue.push(w);
    }
  }
  for (const v of topo) {
    for (const w of out[v]!) {
      if (back[v + '>' + w]) continue;
      if (layer[w]! < layer[v]! + 1) layer[w] = layer[v]! + 1;
    }
  }
  // 成环导致某些节点进不了拓扑序：归到第 0 层（回边会绕左侧通道，仍可读）
  const inTopo = new Set(topo);
  for (let i = 0; i < N; i++) if (!inTopo.has(i)) layer[i] = 0;

  // 3) 层号归一
  const uniq = [...new Set(layer)].sort((a, b) => a - b);
  const lmap: Record<number, number> = {};
  uniq.forEach((v, j) => { lmap[v] = j; });
  layer = layer.map((v) => lmap[v]!);

  const maxL = Math.max(...layer);
  const byLayer: number[][] = Array.from({ length: maxL + 1 }, () => []);
  for (let i = 0; i < N; i++) byLayer[layer[i]!]!.push(i);
  const ord = new Array<number>(N).fill(0);
  for (const arr of byLayer) arr.forEach((v, k) => { ord[v] = k; });

  // 4) 重心法排序
  const bary = (v: number, l: number): number => {
    const nb = (l < layer[v]! ? inn[v]! : out[v]!).filter((u) => layer[u] === l);
    if (!nb.length) return ord[v]!;
    let s = 0;
    for (const u of nb) s += ord[u]!;
    return s / nb.length;
  };
  for (let pass = 0; pass < 4; pass++) {
    for (let l = 1; l < byLayer.length; l++) {
      byLayer[l]!.sort((a, b) => (bary(a, l - 1) || 0) - (bary(b, l - 1) || 0));
      byLayer[l]!.forEach((v, k) => { ord[v] = k; });
    }
    for (let l = byLayer.length - 2; l >= 0; l--) {
      byLayer[l]!.sort((a, b) => (bary(a, l + 1) || 0) - (bary(b, l + 1) || 0));
      byLayer[l]!.forEach((v, k) => { ord[v] = k; });
    }
  }

  // 5) 逐层居中摆放
  const layerH = byLayer.map((arr) => (arr.length ? Math.max(...arr.map((v) => meta[v]!.sz.bh)) : 0));
  /**
   * 回边要绕到**目标层上方**的留白里再折下来、从目标节点顶部进入（理由见「6) 路由」）。
   * 第 0 层上方没有留白，所以只要存在「回到第 0 层」的回边，就给画布顶部预留一条通道。
   * 与下面为左侧回边通道预留的 LEFT 是同一套路。
   */
  const backToTop = edges.some((e) => layer[e.b]! === 0 && layer[e.a]! > 0);
  const TOP_PAD = backToTop ? 24 : 0;
  const layerY: number[] = [];
  let accY = TOP_PAD;
  byLayer.forEach((_, li) => { layerY.push(accY); accY += layerH[li]! + cfg.vGap; });
  const height = accY - cfg.vGap;

  const layerW = byLayer.map((arr) => {
    let s = 0;
    for (const v of arr) s += meta[v]!.sz.bw;
    return s + Math.max(0, arr.length - 1) * cfg.hGap;
  });
  let width = Math.max(...layerW, 1);
  const widest = Math.max(...byLayer.map((a) => a.length));
  if (widest > MAX_COLS) {
    issues.push('有一层放了 ' + widest + ' 个节点（超过 ' + MAX_COLS + ' 个），图会偏宽');
  }

  const pos: Box[] = new Array(N);
  byLayer.forEach((arr, li) => {
    let x = (width - layerW[li]!) / 2;
    for (const v of arr) {
      const m = meta[v]!;
      pos[v] = { x, y: layerY[li]! + (layerH[li]! - m.sz.bh) / 2, bw: m.sz.bw, bh: m.sz.bh };
      x += m.sz.bw + cfg.hGap;
    }
  });

  const hasBack = edges.some((e) => layer[e.b]! < layer[e.a]!);
  const LEFT = hasBack ? 30 : 0;
  if (LEFT) {
    for (let i = 0; i < N; i++) pos[i]!.x += LEFT;
    width += LEFT;
  }

  // 6) 路由
  const layerTop = layerY.slice();
  const layerBot = layerY.map((y, li) => y + layerH[li]!);
  const inCount: Record<number, number> = {};
  const outCount: Record<number, number> = {};
  const inSeen: Record<number, number> = {};
  const outSeen: Record<number, number> = {};
  for (const e of edges) {
    inCount[e.b] = (inCount[e.b] ?? 0) + 1;
    outCount[e.a] = (outCount[e.a] ?? 0) + 1;
  }
  const take = (m: Record<number, number>, k: number): number => {
    const v = m[k] ?? 0;
    m[k] = v + 1;
    return v;
  };
  const spread = (i: number, n: number, halfW: number): number => {
    if (n <= 1) return 0;
    return Math.max(-halfW, Math.min(halfW, (i - (n - 1) / 2) * 16));
  };

  let gutters = 0;
  const routed: LaidOutEdge[] = edges.map((e) => {
    const A = pos[e.a]!;
    const B = pos[e.b]!;
    const la = layer[e.a]!;
    const lb = layer[e.b]!;
    const Acy = A.y + A.bh / 2;
    const Bcy = B.y + B.bh / 2;
    const outIdx = take(outSeen, e.a);
    const inIdx = take(inSeen, e.b);
    const ex = B.x + B.bw / 2 + spread(inIdx, inCount[e.b] ?? 1, B.bw / 2 - 10);

    // 同层：水平直连
    if (la === lb) {
      const right = B.x > A.x;
      const s1 = right ? A.x + A.bw : A.x;
      const d1 = right ? B.x : B.x + B.bw;
      return { d: 'M' + s1 + ' ' + Acy + ' H' + d1, label: e.label, dash: false, lx: (s1 + d1) / 2, ly: Acy - 13 };
    }

    // 回边：绕左侧通道（虚线标记逆向）
    //
    // 2026-10-12 修正 —— 用户反馈「重叠的线看不清方向」的真实成因就在这里。
    //
    // 原写法是 `M A.x Acy H laneX V Bcy H B.x`：第一段水平线正好走在 A 所在层的
    // **节点中线**上，于是它会横穿同层里位于 A 左侧的其它节点。而渲染顺序是
    // 「先连线、后节点」，节点把线盖住了——读者看到的是「线从那个被穿过的节点出发」，
    // 真实起点彻底丢失。实测 flow-branch：`重新处理 → 接收数据` 的这段横穿了 `写入存储`，
    // 于是那条重试回边看起来像从 `写入存储` 出发的。
    //
    // 修法：离开 A 后**先竖直退到层间留白**（层与层之间的空隙按构造一定没有节点），
    // 再水平走进左侧通道；回来时同样走目标层上方的留白，最后从目标节点**顶部**进入
    // ——落点与正向边共用同一套 `ex` 展开，箭头不会叠在一起。
    // 代价是多两个折点，收益是这条线永远不可能被任何节点吃掉。
    if (lb < la) {
      const laneX = Math.max(8, LEFT - 12 - outIdx * 11);
      // lb < la ⇒ la ≥ 1 ⇒ la-1 存在，A 层上方的留白一定存在。
      const gapY = (layerBot[la - 1]! + layerTop[la]!) / 2;
      // 目标层上方的留白。lb === 0 时靠 TOP_PAD 预留出来的顶部通道。
      const yTop = layerTop[lb]! - 10;
      return {
        d: 'M' + A.x + ' ' + Acy + ' V' + gapY + ' H' + laneX
          + ' V' + yTop + ' H' + ex + ' V' + B.y,
        label: e.label, dash: true, lx: laneX, ly: (gapY + yTop) / 2,
      };
    }

    // 跨多层：绕右侧留白通道，绝不穿过中间层的节点
    if (lb > la + 1) {
      const gx = width + 16 + gutters * 12;
      gutters++;
      // 与回边同源的问题：原来第一段是 `H gx`（在 A 的中线上横穿同层右侧的节点）。
      // 同样改成先下沉到 A 层下方的留白再横走。
      const gapY = (layerBot[la]! + layerTop[la + 1]!) / 2;
      const y2 = layerTop[lb]! - 10;
      return {
        d: 'M' + (A.x + A.bw) + ' ' + Acy + ' V' + gapY + ' H' + gx + ' V' + y2 + ' H' + ex + ' V' + B.y,
        label: e.label, dash: false, lx: gx, ly: (gapY + y2) / 2,
      };
    }

    // 相邻层：正交折线，同源的水平段按通道错开
    const sx = A.x + A.bw / 2;
    const sy = A.y + A.bh;
    const dy = B.y;
    const gap = dy - sy;
    const raw = outIdx === 0 ? 0 : (outIdx % 2 === 1 ? Math.ceil(outIdx / 2) : -outIdx / 2) * 14;
    const lim = Math.max(0, gap / 2 - 6);
    const midY = sy + gap / 2 + Math.max(-lim, Math.min(lim, raw));
    return {
      d: 'M' + sx + ' ' + sy + ' V' + midY + ' H' + ex + ' V' + dy,
      label: e.label, dash: false, lx: (sx + ex) / 2, ly: midY,
    };
  });

  if (gutters) width += 16 + gutters * 12 + 34;

  // 边标签锚点消歧（2026-10-13 用户截图实测「字遮挡」）：药丸压到节点盒会被
  // 后画的节点盖掉一半，压到别的药丸则两个标签糊成一团。布局器只给几何初值，
  // 这里在返回前统一绕开节点盒与已放药丸（理由见 labelPlace.ts 文件头）。
  const flowW = width + 8;
  const flowH = height + 8;
  resolveEdgeLabels(routed, pos.map((p) => ({ x: p.x, y: p.y, w: p.bw, h: p.bh })), flowW, flowH);

  return {
    nodes: nodes.map((n, i) => toLaidOut(n, i, pos[i]!, meta)),
    edges: routed,
    width: flowW,
    height: flowH,
    issues,
  };
}

/* ============================================================ 架构图 ============================================================ */

/**
 * 架构图布局：层次由模型显式声明（tier/row），列由 col 决定。
 *
 * 与流程图的关键差别：**层名是表达的一部分**，所以泳道带必须画出来，
 * 且节点嵌在带内而不是均匀铺开。
 *
 * col 是**可选**的：给了就用，没给就排进本层第一个空列。
 * 首版这里有个灾难性 bug——`n.col || 0` 把缺省全当 0，于是同层节点全部叠在
 * 同一个坐标上，看起来「这一层只有一个节点」。真机表现是整层静默消失。
 */
export function layoutArchitecture(ir: IrDocument): IrLayout {
  const issues: string[] = [];
  const nodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const meta = metaOf(nodes);

  if (nodes.length === 0) return { nodes: [], edges: [], width: 240, height: 120, issues };

  // 既没有 tiers、也没有任何节点声明 row ⇒ 模型其实画的是流程图（最常见的错），
  // 此时退回分层布局而不是把 12 个节点摊成一行。降级但不出错：
  // 提示词负责要 tiers，编译器负责别把缺 tiers 变成一张废图。
  const anyRow = nodes.some((n) => typeof n.row === 'number' && n.row >= 0);
  const hasTiers = Array.isArray(ir.tiers) && ir.tiers.length > 0;
  if (!hasTiers && !anyRow) {
    issues.push('架构图没有给出分层（tiers/row），已按流程图的方式推导层次');
    return layoutFlow(ir, { hGap: FLOW_H_GAP, vGap: FLOW_V_GAP });
  }

  // 层来源：显式 tiers 优先；没有 tiers 就按出现过的 row 值合成匿名层
  const declaredTiers = (Array.isArray(ir.tiers) ? ir.tiers : [])
    .filter((t) => Number.isInteger(t.row) && (t.row as number) >= 0 && typeof t.name === 'string' && t.name.trim() !== '')
    .slice()
    .sort((a, b) => a.row - b.row);
  const rowOf = nodes.map((n) => (typeof n.row === 'number' && n.row >= 0 ? n.row : 0));
  const bands: { row: number; name: string }[] = declaredTiers.length
    ? declaredTiers.map((t) => ({ row: t.row, name: t.name.trim() }))
    : [...new Set(rowOf)].sort((a, b) => a - b).map((r) => ({ row: r, name: '' }));

  // 模型声明的 row 若不在任何 band 里（校验器会拦，这里防御）：并入最后一个 band
  for (let i = 0; i < nodes.length; i++) {
    if (!bands.some((b) => b.row === rowOf[i])) {
      issues.push('节点 ' + nodes[i]!.id + ' 的 row=' + rowOf[i] + ' 不在任何层里，已并入首层');
      rowOf[i] = bands[0]!.row;
    }
  }

  // 列号：显式 col 优先，缺省补进本层第一个空列；同列冲突挪到下一个空列
  const colOf = new Array<number>(nodes.length);
  for (const band of bands) {
    const used: Record<number, boolean> = {};
    let next = 0;
    nodes.forEach((n, i) => {
      if (rowOf[i] !== band.row) return;
      const declared = typeof n.col === 'number' && Number.isInteger(n.col) && n.col >= 0 ? n.col : null;
      if (declared === null) {
        while (used[next]) next++;
        used[next] = true;
        colOf[i] = next;
        return;
      }
      if (used[declared]) {
        // 同格冲突：挪到下一个空列。首版这里是 `n.col || 0` ⇒ 整层叠成一个点。
        let k = declared;
        while (used[k]) k++;
        used[k] = true;
        colOf[i] = k;
        issues.push('节点 ' + n.id + ' 与同层节点同列，已移到第 ' + k + ' 列');
        return;
      }
      used[declared] = true;
      colOf[i] = declared;
    });
  }

  // 列号折行：把「本层第 k 个不同列」压到 MAX_COLS 以内
  // （必须同时改列号，否则折了行 x 仍按原列累加、宽度不变——首版就栽在这）
  const rankOfCol: Record<number, number> = {};
  for (const band of bands) {
    const cols = [...new Set(nodes.map((_, i) => i).filter((i) => rowOf[i] === band.row).map((i) => colOf[i]!))]
      .sort((a, b) => a - b);
    cols.forEach((c, r) => { rankOfCol[c] = r; });
  }
  let folded = false;
  const subOf = new Array<number>(nodes.length);
  const subColOf = new Array<number>(nodes.length);
  for (let i = 0; i < nodes.length; i++) {
    const rank = rankOfCol[colOf[i]!] ?? colOf[i]!;
    const sub = Math.floor(rank / MAX_COLS);
    subOf[i] = sub;
    subColOf[i] = rank % MAX_COLS;
    if (sub > 0) folded = true;
  }
  if (folded) {
    const rowsNeeded = Math.max(...subOf) + 1;
    issues.push('图过宽（超过 ' + MAX_COLS + ' 列），已自动折为 ' + rowsNeeded + ' 行');
  }

  // 列宽与列 x
  const maxSubCol = Math.max(0, ...subColOf);
  const colW: number[] = Array.from({ length: maxSubCol + 1 }, () => 80);
  nodes.forEach((_, i) => { colW[subColOf[i]!] = Math.max(colW[subColOf[i]!]!, meta[i]!.sz.bw); });
  const colX: number[] = [];
  let acc = ARCH_SIDE;
  for (const w of colW) {
    colX.push(acc);
    acc += w + ARCH_GAP;
  }
  let width = acc - ARCH_GAP + ARCH_SIDE;

  // 每层的子行数与高度
  const bandLabelH = bands.map((b) => (b.name ? ARCH_TIER_LABEL : 0));
  const bandSubRows = bands.map((b) => {
    const subs = nodes.map((_, i) => i).filter((i) => rowOf[i] === b.row).map((i) => subOf[i]!);
    return subs.length ? Math.max(...subs) + 1 : 1;
  });
  const subRowH = bands.map((b, k) => {
    const hs: number[] = [];
    nodes.forEach((_, i) => {
      if (rowOf[i] !== b.row) return;
      hs.push(meta[i]!.sz.bh);
    });
    return hs.length ? Math.max(...hs) : 40;
  });
const bandContentH = bands.map((_, k) => bandSubRows[k]! * subRowH[k]! + (bandSubRows[k]! - 1) * ARCH_SUB_GAP);

  const bandY: number[] = [];
  let y = 8;
  bands.forEach((b, k) => {
    bandY.push(y);
    const pad = b.name ? ARCH_TIER_PAD : ARCH_BAND_PAD;
    y += bandLabelH[k]! + bandContentH[k]! + pad + ARCH_TIER_GAP;
  });
  // 画布高度只由泳道带堆叠决定：同层边不再绘制 ⇒ 不再需要「为绕行临时加高」的 archBottomPad。
  const height = y - ARCH_TIER_GAP + 8;

  const pos: Box[] = new Array(nodes.length);
  nodes.forEach((_, i) => {
    const k = bands.findIndex((b) => b.row === rowOf[i]);
    const m = meta[i]!;
    const sub = subOf[i]!;
    const rowTop = bandY[k]! + bandLabelH[k]! + sub * (subRowH[k]! + ARCH_SUB_GAP);
    pos[i] = {
      x: colX[subColOf[i]!]! + (colW[subColOf[i]!]! - m.sz.bw) / 2,
      y: rowTop + (subRowH[k]! - m.sz.bh) / 2,
      bw: m.sz.bw,
      bh: m.sz.bh,
    };
  });

  const tiersOut: LaidOutTier[] = bands.map((b, k) => ({
    row: b.row,
    name: b.name,
    x: 2,
    y: bandY[k]!,
    w: width - 4,
    h: bandLabelH[k]! + bandContentH[k]! + (b.name ? ARCH_TIER_PAD : ARCH_BAND_PAD),
  }));

  /* ---- 边：只画跨层（归并成「层到层」）；同层边不画 ---- */
  const idx: Record<string, number> = {};
  nodes.forEach((n, i) => { idx[String(n.id)] = i; });

  const routed: LaidOutEdge[] = [];

  /**
   * 同层依赖**不画线**（2026-10-13 用户裁定）。
   *
   * 用户原话：「架构图，我们层内不画线，层和层之间可以划线，不然完全看不懂，
   * 本身就是架构，画大方向的内容。」
   *
   * 这不是「同层边没画好」——而是同层边与架构图的语义本身冲突。架构图要回答的是
   * 「谁在哪一层、层与层之间怎么走」；块到块的横向箭头把读者的注意力从「层」拉回
   * 「块」，而块级连线一多（真实文档 43 节点有 15 条同层边）整张图就退化成一张没有
   * 层次的流程图——这正是「完全看不懂」的成因。前两轮（2026-10-12 夹块穿越、
   * 2026-10-13 挡路检测补 y 分量）都在修「同层边怎么画才不难看」，方向本身就错了。
   *
   * 校验器仍认为同层边**合法**（verdict 不变——IR 只卡结构，不卡表达取舍），
   * 这里只是不画，并记一条 issue 让它能被测试与门禁看见。
   */
  let sameLayerEdges = 0;
  for (const e of ir.edges ?? []) {
    const a = idx[String(e.from)];
    const b = idx[String(e.to)];
    if (a === undefined || b === undefined || a === b) continue;
    if (rowOf[a] === rowOf[b]) sameLayerEdges++;
  }
  if (sameLayerEdges) {
    issues.push(
      '模型给了 ' + sameLayerEdges + ' 条同层依赖——架构图只画跨层方向（层到层），这些同层边已略去',
    );
  }

  /**
   * 跨层依赖：**按「相邻层缝隙」归并，每道缝隙最多一条箭头**（2026-10-13 用户第二轮裁定）。
   *
   * 用户原话：「你这个箭头是什么意思，这么乱，层和层之间需要这么多箭头吗」。
   *
   * 上一版按**层对**画：每一对 (层 a → 层 b) 一条箭头。那份 43 节点文档有 8 个不同层对
   * ⇒ 8 条箭头，其中 5 条跨越了中间层、只能挤到右侧留白里绕行（长横段 + 一捆平行竖线），
   * 既乱，又让「这条箭头到底表示什么」变得难猜。
   *
   * 现在改成按**相邻层缝隙**归并：第 k 道缝隙（第 k 层与第 k+1 层之间）只要有依赖穿过
   * ——不管它跨几层、由哪个块发起——就画且只画**一条**短箭头，落在两道泳道之间的留白里。
   * 方向：只有下向依赖 ⇒ 向下；只有上向 ⇒ 向上；两者都有 ⇒ 双向箭头（一条线两个头）。
   * 结果：箭头数 ≤ 层数−1，全部是短线，右侧绕行通道彻底消失。
   *
   * 标签：**只有这道缝隙上恰好一条依赖时才显示它的 label**。多条依赖汇总成一个箭头时，
   * 任何一个标签都只代表其中一部分——那种「汇总标签」正是「这箭头是什么意思」的来源，
   * 所以不显示（跨层折算了多少条记进 issues）。
   */
  const gapCount = Math.max(0, bands.length - 1);
  const gapDown = new Array<boolean>(gapCount).fill(false);
  const gapUp = new Array<boolean>(gapCount).fill(false);
  const gapEdges = new Array<number>(gapCount).fill(0);
  /** 本缝隙「唯一一条依赖」的标签；一旦出现第二条就作废（汇总标签必然有歧义）。 */
  const gapSoleLabel = new Array<string | undefined>(gapCount).fill(undefined);
  let multiLayerEdges = 0;

  for (const e of ir.edges ?? []) {
    const a = idx[String(e.from)];
    const b = idx[String(e.to)];
    if (a === undefined || b === undefined || a === b) continue;
    const ka = bands.findIndex((bb) => bb.row === rowOf[a]);
    const kb = bands.findIndex((bb) => bb.row === rowOf[b]);
    if (ka < 0 || kb < 0 || ka === kb) continue;
    const lo = Math.min(ka, kb);
    const hi = Math.max(ka, kb);
    const down = ka < kb;
    if (hi - lo > 1) multiLayerEdges++;
    for (let k = lo; k < hi; k++) {
      gapEdges[k]!++;
      if (down) gapDown[k] = true;
      else gapUp[k] = true;
      gapSoleLabel[k] = gapEdges[k] === 1 ? e.label : undefined;
    }
  }

  const spineX = width / 2;
  for (let k = 0; k < gapCount; k++) {
    if (gapEdges[k] === 0) continue;
    const yTop = bandY[k]! + tiersOut[k]!.h; // 本层带底部
    const yBot = bandY[k + 1]!; // 下一层带顶部
    if (yBot <= yTop) continue;
    const down = gapDown[k]!;
    const up = gapUp[k]!;
    // 只有上向依赖 ⇒ 由下往上画（箭头自然朝上）；其余（含双向）由上往下画
    const d = !down && up
      ? 'M' + spineX + ' ' + yBot + ' V' + yTop
      : 'M' + spineX + ' ' + yTop + ' V' + yBot;
    routed.push({
      d,
      dash: false,
      label: gapSoleLabel[k],
      lx: spineX,
      ly: (yTop + yBot) / 2,
      bidir: down && up,
    });
  }

  if (multiLayerEdges) {
    issues.push(
      '有 ' + multiLayerEdges + ' 条跨层依赖跨越了中间层，已折算到相邻层之间的箭头上'
      + '（每道缝隙最多一条，不再单独绕行）',
    );
  }

  // 边标签锚点消歧：同 layoutFlow——药丸压节点盒会被节点盖掉半个。
  // 按缝隙归并后每道缝隙最多一个标签、且锚点在层间留白里，碰撞已极少；
  // 保留这一步是防御性的（比如模型给了超长标签、或未来层间距变小）。
  const archW = width;
  const archH = height;
  resolveEdgeLabels(routed, pos.map((p) => ({ x: p.x, y: p.y, w: p.bw, h: p.bh })), archW, archH);

  return {
    nodes: nodes.map((n, i) => toLaidOut(n, i, pos[i]!, meta)),
    edges: routed,
    width: archW,
    height: archH,
    issues,
    // 无显式 tiers 时不暴露泳道：匿名层只是为了定位，不是「层」这个视觉实体。
    // 暴露出去会让「没声明分层的架构图」也画出泳道带，与「无 tiers = 现状网格」的
    // 既有约定冲突（单测守着这条）。
    tiers: declaredTiers.length ? tiersOut : undefined,
  };
}

/** 分层编译器入口：架构图走 tier/row，其余走拓扑分层。 */
export function layoutLayered(ir: IrDocument): IrLayout {
  return ir.diagram_type === 'architecture'
    ? layoutArchitecture(ir)
    : layoutFlow(ir, { hGap: FLOW_H_GAP, vGap: FLOW_V_GAP });
}
