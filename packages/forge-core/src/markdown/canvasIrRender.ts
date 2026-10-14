/**
 * IR 编译器：IR → SVG。**四个渲染器的分派层**。
 *
 * ## 结构（v2 重写）
 *
 * ```
 * canvasIr/textFit.ts       文本度量与折行（度量器可注入：UI 用真实字形表）
 * canvasIr/shapes.ts        kind → 形状 + 配色（八种语义）
 * canvasIr/svg.ts           转义 / 箭头 / 节点外形 / 边标签药丸 / 正交路由
 * canvasIr/layoutLayered.ts 分层布局：流程图 + 架构图
 * canvasIr/layoutTimeline.ts时序布局：时序图（自带一套结构，不是节点+边）
 * canvasIr/layoutTree.ts    树 / 思维导图布局
 * canvasIrRender.ts         ← 本文件：分派 + 组装 SVG
 * ```
 *
 * 拆开的理由：布局的难点是「坐标算得对不对」，渲染的难点是「形状画得清不清楚」。
 * v1 把两者揉在一个 558 行的文件里，改任一边都要通读全文，也没法分别回归。
 *
 * ## 硬约束
 *
 * - 纯函数、无 DOM ⇒ 可在 node:test 回归（度量器默认用系数估算，UI 可注入真测量）
 * - 颜色一律走 `--c-*` 变量 ⇒ 深浅色自动适配，不硬编码
 * - 输出尺寸由 viewBox 决定，不写死 width/height ⇒ 卡片内自适应
 * - **不做校验**：调用前必须已通过 judgeIr。校验与编译混在一起会两头难测。
 */

import { FONT_EDGE, measureTextUnits, textWidth } from './canvasIr/textFit.ts';
import { esc, marker, nodeSvg, clampPill, frame } from './canvasIr/svg.ts';
import { IR_MAX_CANVAS_W, layoutLayered } from './canvasIr/layoutLayered.ts';
import { layoutTimeline, type SeqLayout } from './canvasIr/layoutTimeline.ts';
import { layoutTree } from './canvasIr/layoutTree.ts';
import type { IrLayout, LaidOutNode } from './canvasIr/layoutTypes.ts';
import type { IrDocument } from './canvasIr.ts';

/**
 * 卡片高度常量。
 *
 * 与 canvasSandbox 的 CANVAS_DEFAULT_HEIGHT 相同是**硬要求**：
 * 流式骨架与终态必须同高，否则闭合瞬间会跳变（canvas-card.md 不变式之一）。
 */
export const IR_CARD_HEIGHT = 320;

export { IR_MAX_CANVAS_W, measureTextUnits };
export type { IrLayout, LaidOutNode };
export type { SeqLayout } from './canvasIr/layoutTimeline.ts';

/* ============================================================ 分派 ============================================================ */

/**
 * 按图类型选布局编译器。
 *
 * 三类编译器覆盖四类图：流程图与架构图共用分层布局（层次来源不同，见 layoutLayered）。
 */
export function layoutIr(ir: IrDocument): IrLayout {
  if (ir.diagram_type === 'tree') return layoutTree(ir);
  return layoutLayered(ir);
}

/**
 * 编译成 SVG 字符串。
 *
 * 调用前必须已通过 judgeIr（verdict==='ok'）——本函数**不做校验**。
 */
export function compileIrToSvg(ir: IrDocument): string {
  return compileIrWithMeta(ir).svg;
}

/**
 * 编译结果（含布局与问题），供 UI 层决定是否提示用户。
 *
 * 与 compileIrToSvg 的区别：这里把 layout 一并带出，让前端能显示
 * 「已自动折行」这类提示，而不是静默调整。
 *
 * 时序图的 layout 是 SeqLayout（自带生命线/激活条，不是节点+边），
 * 故返回类型是联合——调用方若只需 SVG（当前 UI 就是）不受影响。
 */
export function compileIrWithMeta(ir: IrDocument): { svg: string; layout: IrLayout | SeqLayout } {
  if (ir.diagram_type === 'sequence') {
    const lay = layoutTimeline(ir);
    return { svg: renderSequence(lay), layout: lay };
  }
  const lay = layoutIr(ir);
  return { svg: renderLayout(lay), layout: lay };
}

/* ============================================================ 渲染：节点 + 边 ============================================================ */

/** 渲染分层/树布局：泳道 → 边 → 节点 → 边标签（标签在最上，锚点消歧兜底可读性）。 */
function renderLayout(lay: IrLayout): string {
  const id = 'ir-a';
  const parts: string[] = [];

  // 泳道最底（架构图的视觉语言：淡底区块 + 层名，节点嵌在带内）
  for (const t of lay.tiers ?? []) {
    parts.push(
      '<rect class="ir-tier" x="' + t.x + '" y="' + t.y + '" width="' + t.w + '" height="' + t.h
      + '" rx="10" fill="var(--c-surface)" fill-opacity="0.45" stroke="var(--c-border)" stroke-dasharray="3 3"/>',
    );
    if (t.name) {
      parts.push(
        '<text x="' + (t.x + 12) + '" y="' + (t.y + 17) + '" font-size="11.5"'
        + ' fill="var(--c-muted-fg)">' + esc(t.name) + '</text>',
      );
    }
  }

  // 边先画（保证连线在节点之下）
  const arrow = lay.arrows === false ? '' : ' marker-end="url(#' + id + ')"';
  // 双向箭头：marker 定义用了 orient="auto-start-reverse"，所以 marker-start 会
  // 自动反向（箭头朝外指）——一条线两个头，用于「相邻两层互相依赖」。
  const arrowStart = lay.arrows === false ? '' : ' marker-start="url(#' + id + ')"';
  for (const e of lay.edges) {
    parts.push(
      '<path d="' + e.d + '" fill="none" stroke="var(--c-muted-fg)" stroke-width="1.5"'
      + ' stroke-linejoin="round" stroke-linecap="round" stroke-opacity="0.9"'
      + (e.dash ? ' stroke-dasharray="5 4"' : '')
      + (e.bidir ? arrowStart : '') + arrow + '/>',
    );
  }

  for (const n of lay.nodes) parts.push(nodeSvg(n.x, n.y, { lines: n.lines, textW: 0, bw: n.w, bh: n.h }, n.style));

  // 边标签最后画：**画在节点之上**。
  //
  // 2026-10-13 用户截图实测「字遮挡」：首版药丸画在节点之前，锚点只要压到节点盒，
  // 被压的部分就被节点盖掉——用户看到「标签缺了一块」。锚点消歧（labelPlace.ts）
  // 已经把绝大多数碰撞绕开了，但拥挤图里总有逃不掉的残留；那种情况下
  // 「标签药丸带底色压在盒边上」远好于「标签被裁掉半个字」。药丸自带背景色与
  // 描边，压线不糊、压盒也只是盖住盒边一圈，可读性有保证。
  for (const e of lay.edges) {
    if (e.label) parts.push(clampPill(e.lx, e.ly, e.label, lay.width, lay.height));
  }

  return frame(lay.width, lay.height, lay.arrows === false ? '' : marker(id, true), parts.join(''));
}

/* ============================================================ 渲染：时序图 ============================================================ */

/**
 * 渲染时序图。
 *
 * 与分层图的关键差别：序号圆标、激活条、生命线这三样没有对应物，
 * 所以它不走 renderLayout 而自己组装（布局部分已在 layoutTimeline 算完）。
 */
function renderSequence(lay: SeqLayout): string {
  const id = 'ir-s';
  const defs = marker(id, true) + marker(id + 'o', false);
  const parts: string[] = [];

  // 生命线（最底）
  for (const l of lay.lifelines) {
    parts.push(
      '<line class="ir-seq-lifeline" x1="' + l.x + '" y1="' + l.y1 + '" x2="' + l.x + '" y2="' + l.y2
      + '" stroke="var(--c-border)" stroke-width="1" stroke-dasharray="4 4"/>',
    );
  }

  // 激活条
  for (const a of lay.activations) {
    parts.push(
      '<rect class="ir-seq-activation" x="' + a.x + '" y="' + a.y + '" width="' + a.w + '" height="' + a.h
      + '" rx="3" fill="var(--c-accent-bg)" stroke="var(--c-accent)" stroke-width="0.8"/>',
    );
  }

  // 参与者框
  for (const p of lay.participants) {
    parts.push(
      '<g class="ir-seq-participant">'
      + '<rect x="' + p.x + '" y="' + p.y + '" width="' + p.w + '" height="' + p.h
      + '" rx="9" fill="var(--c-surface)" stroke="var(--c-border)"/>'
      + '<text x="' + p.cx + '" y="' + (p.y + p.h / 2 + 4.5) + '" text-anchor="middle"'
      + ' font-size="12.5" font-weight="500" fill="var(--c-fg)">' + esc(p.label) + '</text></g>',
    );
  }

  // 消息
  for (const m of lay.messages) {
    const d = m.self ? m.loop! : 'M' + m.x1 + ' ' + m.y + ' H' + m.x2;
    const inner: string[] = [];
    inner.push(
      '<path class="ir-seq-msg-line" d="' + d + '" fill="none" stroke="var(--c-muted-fg)" stroke-width="1.5"'
      + ' stroke-linecap="round"' + (m.isReturn ? ' stroke-dasharray="5 4"' : '')
      + ' marker-end="url(#' + id + (m.isReturn ? 'o' : '') + ')"/>',
    );
    // 序号圆标：贴着源生命线，读消息时不用回看顶部找序号
    inner.push(
      '<circle cx="' + m.badgeX + '" cy="' + m.badgeY + '" r="8.5"'
      + ' fill="var(--c-surface)" stroke="var(--c-muted-fg)" stroke-width="1"/>',
    );
    inner.push(
      '<text x="' + m.badgeX + '" y="' + (m.badgeY + 3.6) + '" text-anchor="middle"'
      + ' font-size="10.5" fill="var(--c-fg)">' + m.index + '</text>',
    );
    if (m.label) {
      // 标签带一层与底同色的遮罩，压在生命线上也不糊
      const lw = textWidth(m.label, FONT_EDGE) + 10;
      inner.push(
        '<rect x="' + (m.labelX - lw / 2) + '" y="' + (m.labelY - 12) + '" width="' + lw
        + '" height="17" rx="4" fill="var(--c-bg)" opacity="0.92"/>',
      );
      inner.push(
        '<text x="' + m.labelX + '" y="' + (m.labelY + 1) + '" text-anchor="middle"'
        + ' font-size="' + FONT_EDGE + '" fill="var(--c-muted-fg)">' + esc(m.label) + '</text>',
      );
    }
    parts.push('<g class="ir-seq-msg">' + inner.join('') + '</g>');
  }

  return frame(lay.width, lay.height, defs, parts.join(''));
}

/* ============================================================ 兼容：单边路由 ============================================================ */

/**
 * 连线路由（分层正交式）。
 *
 * 保留此函数是为了让「路由规则」本身可被单测直接断言（不依赖完整布局）。
 * 生产路径上，路由已内联进 layoutLayered（那里需要知道层关系与通道分配，
 * 从外面喂不进足够信息）。
 *
 * 三态：
 * - 同行正向：短贝塞尔（短弧柔和，保留）
 * - 跨行下行：源底出 → 竖 → 横 → 目标顶入，正交直角，水平段按通道错开
 * - 回折：绕行 + 虚线（视觉标记逆向依赖）
 *
 * 为什么跨行不用曲线：分层图里跨行边占多数，长贝塞尔大弧交叉横穿 =
 * 无法追踪（真机用户原话「鬼画符」）。正交折线只有两次 90° 转向，视线可跟。
 */
export function edgePath(
  a: LaidOutNode,
  b: LaidOutNode,
  options?: { channel?: number },
): { d: string; dash: boolean } {
  const sameRow = a.y === b.y;
  const forward = b.x > a.x;
  const ch = options?.channel ?? 0;

  if (sameRow && forward) {
    const x1 = a.x + a.w;
    const y1 = a.y + a.h / 2;
    const x2 = b.x;
    const y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    return {
      d: 'M' + x1 + ' ' + y1 + ' C' + (mx + 16) + ' ' + y1 + ' ' + (mx - 16) + ' ' + y2 + ' ' + x2 + ' ' + y2,
      dash: false,
    };
  }

  if (!sameRow && b.y > a.y) {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const gap = y2 - y1;
    const raw = ch === 0 ? 0 : (ch % 2 === 1 ? Math.ceil(ch / 2) : -ch / 2) * 8;
    const midY = y1 + gap / 2 + Math.max(-(gap / 2 - 4), Math.min(gap / 2 - 4, raw));
    return {
      d: 'M' + x1 + ' ' + y1 + ' L' + x1 + ' ' + midY + ' L' + x2 + ' ' + midY + ' L' + x2 + ' ' + y2,
      dash: false,
    };
  }

  const goingDown = b.y >= a.y;
  const x1 = a.x + a.w;
  const y1 = a.y + a.h / 2;
  const x2 = b.x;
  const y2 = b.y + b.h / 2;
  const chX = Math.max(a.x + a.w, b.x + b.w) + 18 + ch * 8;
  const chY = goingDown
    ? Math.max(a.y + a.h, b.y + b.h) + 18 + ch * 8
    : Math.min(a.y, b.y) - 18 - ch * 8;
  return {
    d: 'M' + x1 + ' ' + y1 + ' L' + chX + ' ' + y1 + ' L' + chX + ' ' + chY
      + ' L' + (b.x + b.w / 2) + ' ' + chY + ' L' + (b.x + b.w / 2) + ' ' + (b.y + b.h)
      + ' L' + (b.x + b.w / 2) + ' ' + y2 + ' L' + x2 + ' ' + y2,
    dash: true,
  };
}

/* ============================================================ 另存自含 HTML ============================================================ */

/**
 * 另存为自含 HTML（工具栏「另存」用，对齐 canvas 卡片的独立文件能力）。
 *
 * ## 变量必须齐全（这是踩过的坑）
 *
 * 独立文件没有宿主主题可跟随，只能跟随系统 prefers-color-scheme。
 * 更关键的是：**SVG 里用到的每一个 `--c-*` 都必须在这里定义**。
 * 少一个，那条 fill 就解析失败回落成 SVG 默认黑 —— 真机表现为「黑块吞字」。
 * 所以这里逐个列出，与 `canvasIr/shapes.ts` 的 IR_REQUIRED_CSS_VARS 对齐
 * （那边有单测守着两者一致）。
 *
 * 变量取值沿用宿主映射口径（基础色由卡片变量层映射），不写死单一浅色——
 * 那是现状链路「写死浅色底」的老坑，这里不能重犯。
 * 无脚本：图是静态 SVG，沙箱外的独立文件也不需要任何 JS。
 */
/**
 * 任何「自己拼页面来装 IR SVG」的宿主都必须注入的变量块。
 *
 * 为什么必须是常量、而不是各写各的：SVG 里所有颜色都写成 `fill="var(--c-*)"`。
 * 宿主页面若没定义这些变量，`var()` 求值失败 ⇒ 该属性变成非法值：
 *   - `fill` 非法 ⇒ SVG 回落到默认值 **黑色**（节点变成实心黑块，字被吞掉）；
 *   - `stroke` 非法 ⇒ SVG 回落到默认值 **none**（连线整条凭空消失）。
 * 产物 SVG 本身完全正确，所以从源码上看不出任何异常——2026-10-12 探针画廊就是这么翻车的：
 * 画廊只定义了 `--bg/--fg/--muted/--line` 这几个排版变量，四类图全部渲染成黑块。
 * 抽成常量后由 `buildIrStandaloneFile` 与画廊共用，并由 `IR_REQUIRED_CSS_VARS` 反向校验，
 * 任何一边漏变量都会在单测里炸掉。
 */
export const IR_HOST_CSS_VARS = `:root{
  --c-bg:#ffffff;--c-fg:#1f2124;--c-muted:#f4f5f7;--c-muted-fg:#5f6368;
  --c-surface:#f7f8fa;--c-border:#e1e3e8;
  --c-ok:#2e8b57;--c-ok-bg:#eaf6ef;--c-warn:#c98a1e;--c-warn-bg:#faf3e0;
  --c-bad:#cc4b4b;--c-bad-bg:#fbecec;
  --c-accent:#3b6fd4;--c-accent-bg:#eef3fd;
}
@media (prefers-color-scheme: dark){
  :root{
    --c-bg:#242427;--c-fg:#e6e6e6;--c-muted:#33343a;--c-muted-fg:#a5a8b0;
    --c-surface:#2c2d33;--c-border:#43454c;
    --c-ok:#6fce9d;--c-ok-bg:#243529;--c-warn:#e2b45f;--c-warn-bg:#37301f;
    --c-bad:#ee8888;--c-bad-bg:#3a2424;
    --c-accent:#7ba7f0;--c-accent-bg:#252c3b;
  }
}`;

export function buildIrStandaloneFile(svg: string, title: string): string {
  const t = String(title)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${t}</title>
<style>
${IR_HOST_CSS_VARS}
body{margin:0;padding:24px;background:var(--c-bg);color:var(--c-fg);
  font-family:system-ui,-apple-system,"Segoe UI",sans-serif;
  display:flex;align-items:center;justify-content:center;min-height:100vh;}
figure{margin:0;max-width:1100px;width:100%;}
figcaption{font-size:12px;color:var(--c-muted-fg);padding-bottom:10px;
  border-bottom:1px dashed var(--c-border);margin-bottom:14px;}
svg{max-width:100%;height:auto;display:block;margin:0 auto;}
</style>
</head>
<body>
<figure>
<figcaption>${t} · forge IR 编译产物</figcaption>
${svg}
</figure>
</body>
</html>`;
}
