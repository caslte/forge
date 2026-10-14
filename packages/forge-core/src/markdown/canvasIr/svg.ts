/**
 * SVG 基础件：转义、箭头标记、节点外形、边标签、画框。
 *
 * 这些是四个渲染器共用的「笔画」，与布局算法无关。分开的理由：
 * 布局的难点是「坐标算得对不对」，渲染的难点是「形状画得清不清楚」，
 * 混在一个文件里改任何一边都要通读全文。
 *
 * 一条贯穿全文件的纪律：**方向必须可读**。
 * 用户对首版的原话是「重叠的线看不清方向」，所以：
 * - 箭头一律用**实心**三角（空心箭头在细线上几乎看不出朝向）
 * - 边标签带底色药丸，压在线上也不糊
 */

import { FONT_EDGE, FONT_NODE, LINE_H, textWidth } from './textFit.ts';
import type { FittedLabel } from './textFit.ts';
import type { KindStyle } from './shapes.ts';

/** HTML/SVG 文本转义。模型写 `<script>` 必须变成实体，否则注入成真实标签。 */
export function esc(s: unknown): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 箭头标记。
 *
 * `orient="auto-start-reverse"` 让同一枚 marker 同时可用于起点与终点；
 * `context-stroke` 让箭头自动跟随连线颜色，不必为每条线配一枚 marker。
 *
 * filled=true 是默认：实心三角在小尺寸下仍能读出方向，空心则不能。
 * 时序图的返回消息用空心（UML 约定：返回是虚线 + 空心箭头）。
 */
export function marker(id: string, filled: boolean): string {
  return '<marker id="' + id + '" viewBox="0 0 10 10" refX="8.5" refY="5"'
    + ' markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M1.5 1L8.5 5L1.5 9' + (filled ? 'Z' : '') + '"'
    + ' fill="' + (filled ? 'context-stroke' : 'none') + '" stroke="context-stroke"'
    + ' stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></marker>';
}

/**
 * 画一个节点（外形 + 居中标签）。
 *
 * 形状由 kind 决定（见 shapes.ts）。菱形/平行四边形这类「外接盒大于内容盒」的形状，
 * 文字仍按外接盒居中——因为 fitNode 已经把外接盒放大到能容纳内切文字，
 * 再按内切区居中会让文字偏上/偏左。
 */
export function nodeSvg(x: number, y: number, sz: FittedLabel, st: KindStyle): string {
  const cx = x + sz.bw / 2;
  const cy = y + sz.bh / 2;
  const attrs = 'fill="' + st.fill + '" stroke="' + st.stroke + '" stroke-width="1"'
    + (st.dash ? ' stroke-dasharray="5 4"' : '');

  let shape: string;
  if (st.shape === 'diamond') {
    shape = '<polygon points="' + cx + ',' + y + ' ' + (x + sz.bw) + ',' + cy + ' '
      + cx + ',' + (y + sz.bh) + ' ' + x + ',' + cy + '" ' + attrs + '/>';
  } else if (st.shape === 'cylinder') {
    // 圆柱：上下两个椭圆 + 中间的矩形筒身（只画左右两条侧边，避免内部出现横线）
    const ry = 7;
    shape = '<ellipse cx="' + cx + '" cy="' + (y + sz.bh - ry) + '" rx="' + (sz.bw / 2) + '" ry="' + ry + '" ' + attrs + '/>'
      + '<rect x="' + x + '" y="' + (y + ry) + '" width="' + sz.bw + '" height="' + (sz.bh - ry * 2) + '"'
      + ' fill="' + st.fill + '" stroke="none"/>'
      + '<line x1="' + x + '" y1="' + (y + ry) + '" x2="' + x + '" y2="' + (y + sz.bh - ry) + '" stroke="' + st.stroke + '" stroke-width="1"/>'
      + '<line x1="' + (x + sz.bw) + '" y1="' + (y + ry) + '" x2="' + (x + sz.bw) + '" y2="' + (y + sz.bh - ry) + '" stroke="' + st.stroke + '" stroke-width="1"/>'
      + '<ellipse cx="' + cx + '" cy="' + (y + ry) + '" rx="' + (sz.bw / 2) + '" ry="' + ry + '" ' + attrs + '/>';
  } else if (st.shape === 'parallelogram') {
    const sk = 10;
    shape = '<polygon points="' + (x + sk) + ',' + y + ' ' + (x + sz.bw) + ',' + y + ' '
      + (x + sz.bw - sk) + ',' + (y + sz.bh) + ' ' + x + ',' + (y + sz.bh) + '" ' + attrs + '/>';
  } else if (st.shape === 'capsule') {
    shape = '<rect x="' + x + '" y="' + y + '" width="' + sz.bw + '" height="' + sz.bh
      + '" rx="' + (sz.bh / 2) + '" ' + attrs + '/>';
  } else if (st.shape === 'round') {
    shape = '<rect x="' + x + '" y="' + y + '" width="' + sz.bw + '" height="' + sz.bh
      + '" rx="10" ' + attrs + '/>';
  } else {
    shape = '<rect x="' + x + '" y="' + y + '" width="' + sz.bw + '" height="' + sz.bh
      + '" rx="8" ' + attrs + '/>';
  }

  const textColor = st.text ?? 'var(--c-fg)';
  const ty = cy - ((sz.lines.length - 1) * LINE_H) / 2 + 4.5;
  const texts = sz.lines.map((l, i) =>
    '<text x="' + cx + '" y="' + (ty + i * LINE_H) + '" text-anchor="middle" font-size="' + FONT_NODE
    + '" fill="' + textColor + '">' + esc(l) + '</text>').join('');

  return '<g>' + shape + texts + '</g>';
}

/**
 * 边标签药丸：给文字加一块与背景同色的底。
 *
 * 为什么必须有底色：分层图里边的水平段常常正好压在其他边上，
 * 裸文字会被穿过的线割断、读不出来。药丸是「标签盖住线」而不是「线穿过标签」。
 */
export function pillSvg(x: number, y: number, text: string): string {
  const w = textWidth(text, FONT_EDGE) + 14;
  const h = 19;
  return '<rect x="' + (x - w / 2) + '" y="' + (y - h / 2) + '" width="' + w + '" height="' + h
    + '" rx="5" fill="var(--c-surface)" stroke="var(--c-border)" stroke-width="0.8"/>'
    + '<text x="' + x + '" y="' + (y + 4) + '" text-anchor="middle" font-size="' + FONT_EDGE
    + '" fill="var(--c-muted-fg)">' + esc(text) + '</text>';
}

/** 边标签药丸，自动夹在画布内（边缘节点的标签否则会被裁掉）。 */
export function clampPill(x: number, y: number, text: string, W: number, H: number): string {
  const w = textWidth(text, FONT_EDGE) + 14;
  const px = Math.min(Math.max(x, w / 2 + 6), Math.max(w / 2 + 6, W - w / 2 - 6));
  const py = Math.min(Math.max(y, 16), Math.max(16, H - 14));
  return pillSvg(px, py, text);
}

/**
 * 组装 `<svg>` 外壳。
 *
 * ## 为什么同时给 viewBox 和 width/height
 *
 * 只给 viewBox（无 width/height）时，SVG 没有**固有尺寸**：在容器里会被拉满可用宽度。
 * 后果是**窄而高的图会被放大**——真机实测 `arch-forge` 是 383×572 的图，
 * 放进 536px 宽的卡片后被拉到 536 宽、高度跟着涨到约 800px，整张图占了半个屏幕，
 * 字号也被放大到失真。
 *
 * 给上 width/height 就有了固有尺寸，配合卡片侧的 `max-width:100%; height:auto`：
 * - 图比卡片窄 → 按固有尺寸原样显示（不放大）
 * - 图比卡片宽 → 等比缩到卡片宽（不裁切）
 * 这正是响应式 SVG 的标准做法。这里的 width/height **不是**在写死像素排版，
 * 只是声明「这张图的自然尺寸」。
 */
export function frame(w: number, h: number, defs: string, body: string): string {
  return '<svg viewBox="0 0 ' + w + ' ' + h + '" width="' + w + '" height="' + h + '"'
    + ' preserveAspectRatio="xMidYMid meet" role="img"'
    + ' xmlns="http://www.w3.org/2000/svg">'
    + (defs ? '<defs>' + defs + '</defs>' : '') + body + '</svg>';
}

/**
 * 通用正交路由（同层 / 树以外的兜底走法）。
 *
 * 三态：
 * - 目标在下方：底出 → 竖 → 横 → 顶入，水平段按通道错开
 * - 目标在上方：绕左侧通道（虚线标记「逆向」）
 * - 同层：水平直连
 *
 * 为什么坚持正交而不是曲线：分层图里跨行边占多数，长贝塞尔大弧交叉横穿 =
 * 无法追踪（真机用户原话「鬼画符」）。正交折线只有两次 90° 转向，视线可跟。
 */
export function routeOrtho(
  A: { x: number; y: number; bw: number; bh: number },
  B: { x: number; y: number; bw: number; bh: number },
  ch: number,
): { d: string; lp: { x: number; y: number }; dash: boolean } {
  const acy = A.y + A.bh / 2;
  const bcy = B.y + B.bh / 2;

  if (B.y > A.y + A.bh + 1) {
    const sx = A.x + A.bw / 2;
    const sy = A.y + A.bh;
    const dx = B.x + B.bw / 2;
    const dy = B.y;
    const gap = dy - sy;
    const raw = ch === 0 ? 0 : (ch % 2 === 1 ? Math.ceil(ch / 2) : -ch / 2) * 10;
    const lim = Math.max(0, gap / 2 - 6);
    const midY = sy + gap / 2 + Math.max(-lim, Math.min(lim, raw));
    return { d: 'M' + sx + ' ' + sy + ' V' + midY + ' H' + dx + ' V' + dy, lp: { x: (sx + dx) / 2, y: midY }, dash: false };
  }

  if (B.y + B.bh < A.y - 1) {
    const laneX = Math.max(10, Math.min(A.x, B.x) - 18 - ch * 12);
    return {
      d: 'M' + A.x + ' ' + acy + ' H' + laneX + ' V' + bcy + ' H' + B.x,
      lp: { x: laneX, y: (acy + bcy) / 2 },
      dash: true,
    };
  }

  const right = B.x > A.x;
  const sxx = right ? A.x + A.bw : A.x;
  const dxx = right ? B.x : B.x + B.bw;
  return { d: 'M' + sxx + ' ' + acy + ' H' + dxx, lp: { x: (sxx + dxx) / 2, y: acy - 13 }, dash: false };
}
