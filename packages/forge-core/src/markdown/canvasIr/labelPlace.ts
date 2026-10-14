/**
 * 边标签锚点消歧（2026-10-13 用户截图实测：「架构图字遮挡、流程箭头看不懂」）。
 *
 * ## 问题
 *
 * 边标签是带底色药丸（pillSvg：宽 = 文本宽 + 14，高 19），而**节点画在药丸之后**
 * （renderLayout 的顺序：泳道 → 边 → 药丸 → 节点）。于是药丸只要压到节点盒，
 * 被压的部分就被节点盖掉——用户看到「标签缺了一块」「字和盒子叠在一起」。
 * 实测 43 节点架构图：4 处药丸压节点（最长一条 206px 的药丸压住两个盒子），
 * 另有 2 处药丸互压（双向层对共享同一锚点、右侧通道标签只隔 12px）。
 *
 * ## 解法
 *
 * 布局器算出的锚点是「几何正确但可能撞盒」的初值；本模块在返回前做一轮消歧：
 * 锚点药丸盒与任何阻挡盒（节点盒 + 已放置的药丸）相交时，沿环形候选位移
 * （先近后远、八向）找第一个干净位置；全都不干净就取相交最少的（至少不抖回原点）。
 *
 * 为什么放在布局层而不是渲染层：渲染层只认 LaidOutEdge 的 lx/ly，没有任何
 * 「别的节点在哪」的信息；而布局层手里就有全部 pos[]。药丸几何常量与 svg.ts
 * 的 pillSvg 一一对应（改那边必须同步这边）。
 */

import { FONT_EDGE, textWidth } from './textFit.ts';

/** 药丸左右内边距（与 svg.ts 的 pillSvg 一致）。 */
const PILL_PAD = 14;
/** 药丸高度（与 svg.ts 的 pillSvg 一致）。 */
const PILL_H = 19;

/** 轴对齐矩形（节点盒 / 药丸盒通用）。 */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 药丸盒：以 (cx, cy) 为中心的居中矩形。多行标签按整串宽度（与 pillSvg 同口径）。 */
export function pillRect(cx: number, cy: number, text: string): Rect {
  const w = textWidth(text, FONT_EDGE) + PILL_PAD;
  return { x: cx - w / 2, y: cy - PILL_H / 2, w, h: PILL_H };
}

function intersects(a: Rect, b: Rect): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/**
 * 候选位移：距离环 × 八向。先近后远——能不挪就不挪。
 *
 * 环放到 72 是实测逼出来的：43 节点架构图的折行带里，标签挤在子行间的 12px
 * 间隙中，近处全部候选都撞盒，只能往远处逃。
 */
const RINGS = [10, 18, 28, 40, 54, 72];
const DIRS: Array<[number, number]> = [
  [0, -1], [0, 1], [-1, 0], [1, 0], [-1, -1], [1, -1], [-1, 1], [1, 1],
];

/**
 * 求一个不撞阻挡盒的标签锚点。
 *
 * @param cx 几何锚点 x（布局器初值）
 * @param cy 几何锚点 y
 * @param text 标签原文（决定药丸宽度）
 * @param blockers 节点盒 + 已放置的药丸盒
 * @param W 画布宽（锚点不得出界）
 * @param H 画布高
 * @returns 修正后的锚点；初值就干净时原样返回
 */
export function placeLabelAnchor(
  cx: number,
  cy: number,
  text: string,
  blockers: Rect[],
  W: number,
  H: number,
): { x: number; y: number } {
  if (!blockers.some((b) => intersects(pillRect(cx, cy, text), b))) {
    return { x: cx, y: cy };
  }
  let best: { x: number; y: number; score: number } | null = null;
  for (const r of RINGS) {
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx * r;
      const ny = cy + dy * r;
      const rect = pillRect(nx, ny, text);
      // 出界的候选直接跳过（clampPill 只会夹回边缘，仍会压盒）
      if (rect.x < 4 || rect.y < 4 || rect.x + rect.w > W - 4 || rect.y + rect.h > H - 4) continue;
      const score = blockers.filter((b) => intersects(rect, b)).length;
      if (score === 0) return { x: nx, y: ny };
      if (best === null || score < best.score) best = { x: nx, y: ny, score };
    }
  }
  // 全候选都脏（极端拥挤）：取相交最少的，总比原点强
  return best !== null ? { x: best.x, y: best.y } : { x: cx, y: cy };
}

/**
 * 批量消歧一组边的标签锚点（**原地修改** lx/ly）。
 *
 * 顺序敏感：先放的药丸进 blockers，后放的给先放的让位。按边的原始顺序处理，
 * 保证同一输入永远同一输出（无随机、无 Map 序遍历依赖）。
 *
 * @param edges 布局器产出的边（只动带 label 的）
 * @param nodeRects 全部节点盒
 * @param W 画布宽
 * @param H 画布高
 */
export function resolveEdgeLabels(
  edges: Array<{ label?: string; lx: number; ly: number }>,
  nodeRects: Rect[],
  W: number,
  H: number,
): void {
  const placed: Rect[] = [];
  for (const e of edges) {
    if (!e.label) continue;
    const p = placeLabelAnchor(e.lx, e.ly, e.label, [...nodeRects, ...placed], W, H);
    e.lx = p.x;
    e.ly = p.y;
    placed.push(pillRect(p.x, p.y, e.label));
  }
}
