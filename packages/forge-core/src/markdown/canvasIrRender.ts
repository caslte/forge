/**
 * IR 编译器：IR → SVG。
 *
 * 定位（重要）：这是**第 2 层排版算法**的最小可用版，不是终版。
 * 阶段 1 只要求「合规 IR 能变成正确可读的图」，布局质量是阶段 2 的主战场。
 *
 * 与 canvasSandbox.ts 的分工：
 * - canvasSandbox：HTML 字符串 → 沙箱文档（**模型写排版**）
 * - canvasIrRender：IR → SVG（**宿主算排版**，本文件是唯一权威口径）
 * 两者并存期不互相调用；新链路走本文件。
 *
 * 硬约束：
 * - 纯函数、无 DOM ⇒ 可在 node:test 回归
 * - 颜色一律走 --c-* 变量 ⇒ 深浅色自动适配，不硬编码
 * - 输出 size 由 viewBox 决定，不写死 width/height ⇒ 卡片内自适应
 */

import type { IrDocument, IrNode, IrNodeKind, IrParticipant, IrTier } from './canvasIr.ts';

/**
 * 卡片高度常量。
 *
 * 与 canvasSandbox 的 CANVAS_DEFAULT_HEIGHT 相同是**硬要求**：
 * 流式骨架与终态必须同高，否则闭合瞬间会跳变（canvas-card.md 不变式之一）。
 */
export const IR_CARD_HEIGHT = 320;

/** 节点最小宽度（px）。低于此值中文标签会被压扁。 */
const NODE_MIN_W = 80;
/** 节点高度（px）。单行标题 + 单行标签。 */
const NODE_H = 52;
/** 列间距（px）。 */
const COL_GAP = 28;
/** 行间距（px）。 */
const ROW_GAP = 24;
/** 节点内边距（px），左右各一。 */
const PAD_X = 14;
/** 泳道内：层名带高 / 节点下边距 / 泳道间距。 */
const TIER_LABEL_H = 24;
const TIER_PAD_BOTTOM = 12;
const TIER_GAP = 16;
/** 标签字号（px）。 */
const FONT_LABEL = 12.5;
/** 类型字号（px）。 */
const FONT_KIND = 9.5;

/**
 * 画布宽度上限（px）。
 *
 * 超出则自动折行——因为卡片宽度固定（宿主不可自适应，见 canvas-card.md §5），
 * 12 列横排必然横向溢出。折行比缩放更可读。
 */
export const IR_MAX_CANVAS_W = 560;

/** 每行最多放几个节点（超了折行）。 */
const MAX_PER_ROW = 4;

/** 布局后的节点坐标（绝对像素）。 */
export interface LaidOutNode extends IrNode {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 布局后的泳道（有 tiers 时才有）：y/h 为该层带的纵向位置与高度。 */
export interface LaidOutTier {
  row: number;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface IrLayout {
  nodes: LaidOutNode[];
  width: number;
  height: number;
  /** 布局阶段的机械问题（暴露给门禁，不抛异常）。 */
  issues: string[];
  /** 有 tiers 时才有：泳道几何（无 tiers = undefined，纯网格）。 */
  tiers?: LaidOutTier[];
}

/**
 * 文本宽度估算（单位：字符宽）。
 *
 * 中文/全角按 1，其余按 0.55。**这是估算不是测量**——
 * 阶段 2 要换成真实的 DOM 测量或字形表，否则「刚好略长」的标签仍可能溢出。
 */
export function measureTextUnits(text: string): number {
  let units = 0;
  for (const ch of String(text ?? '')) {
    units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  }
  return units;
}

/** 语义类型 → CSS 变量组。集中一处，便于将来加预设（第 1 层）。 */
const KIND_STYLE: Record<IrNodeKind, { fill: string; stroke: string; text: string; label: string }> = {
  component: { fill: 'var(--c-ok-bg)', stroke: 'var(--c-ok)', text: 'var(--c-ok)', label: '组件' },
  boundary: { fill: 'var(--c-warn-bg)', stroke: 'var(--c-warn)', text: 'var(--c-warn)', label: '边界' },
  // fill 不能用 --c-bg：浅色下白底画白卡 = 肉眼不可见（真机 16:27 截图）。
  // --c-surface 是 muted 与 background 的混合，比卡片底深一档，节点能从卡面上浮出来。
  process: { fill: 'var(--c-surface)', stroke: 'var(--c-border)', text: 'var(--c-fg)', label: '进程' },
  external: { fill: 'var(--c-bad-bg)', stroke: 'var(--c-bad)', text: 'var(--c-bad)', label: '外部' },
  storage: { fill: 'var(--c-ok-bg)', stroke: 'var(--c-ok)', text: 'var(--c-ok)', label: '存储' },
  dataflow: { fill: 'var(--c-surface)', stroke: 'var(--c-border)', text: 'var(--c-fg)', label: '数据' },
};

/**
 * 计算布局。
 *
 * 两个刻意的取舍：
 * 1. **同格占用自动错开而不是留重叠**。同 col 同 row 是模型可能犯的错，
 *    编译器兜住（错开成下一行），而不是画出一个视觉上重叠的图让用户以为 bug。
 * 2. **超宽自动折行**，不缩放。缩放会让中文字号变得不可读。
 */
/** 从 doc 提取合法 tiers（校验已过，这里只做形状收敛）。 */
function readTiers(ir: IrDocument): IrTier[] {
  if (!Array.isArray(ir.tiers)) return [];
  return (ir.tiers as Array<{ row?: unknown; name?: unknown }>)
    .filter(t => Number.isInteger(t.row) && (t.row as number) >= 0 && typeof t.name === 'string' && t.name.trim() !== '')
    .map(t => ({ row: t.row as number, name: (t.name as string).trim() }));
}

export function layoutIr(ir: IrDocument): IrLayout {
  const issues: string[] = [];

  const srcNodes = Array.isArray(ir.nodes) ? ir.nodes : [];
  const tiers = readTiers(ir);
  // 泳道布局：row -> 带 y。带高 = 层名 + 节点高 + 下边距；带间距 TIER_GAP。
  const tierY = new Map<number, number>();
  let tiersOut: LaidOutTier[] | undefined;
  if (tiers.length > 0) {
    tiersOut = [];
    let cursor = 0;
    const bandH = TIER_LABEL_H + NODE_H + TIER_PAD_BOTTOM;
    for (const t of tiers) {
      tierY.set(t.row, cursor);
      tiersOut.push({ row: t.row, name: t.name, x: 0, y: cursor, w: 0, h: bandH });
      cursor += bandH + TIER_GAP;
    }
  }

  // 1) 逐列实际宽度
  const colW = new Map<number, number>();
  for (const n of srcNodes) {
    const w = Math.max(NODE_MIN_W, Math.ceil(measureTextUnits(n.label) * FONT_LABEL) + PAD_X * 2);
    colW.set(n.col, Math.max(colW.get(n.col) ?? 0, w));
  }

  // 2) 超宽则重排列号。
  //    ⚠ 关键：折行必须**同时重映射 col**，否则 x 仍按原始 col 累加，
  //    折了行但宽度不变（首版真bug：12 列折 3 行后 width 仍 1268px）。
  const maxCol = Math.max(-1, ...[...colW.keys()]);
  const needFold = maxCol + 1 > MAX_PER_ROW;
  /** 原 col → 新 col（折行后的行内序号）。 */
  const colMap = new Map<number, number>();
  /** 原 col → 行号增量。 */
  const rowShift = new Map<number, number>();
  if (needFold) {
    const rowsNeeded = Math.ceil((maxCol + 1) / MAX_PER_ROW);
    issues.push('图过宽（' + (maxCol + 1) + ' 列），已自动折为 ' + rowsNeeded + ' 行');
    for (let c = 0; c <= maxCol; c++) {
      colMap.set(c, c % MAX_PER_ROW);
      rowShift.set(c, Math.floor(c / MAX_PER_ROW));
    }
  } else {
    for (let c = 0; c <= maxCol; c++) colMap.set(c, c);
  }

  // 3) 按「折行后 col」重新聚类宽度
  const foldedColW = new Map<number, number>();
  for (let c = 0; c <= maxCol; c++) {
    const nc = colMap.get(c)!;
    foldedColW.set(nc, Math.max(foldedColW.get(nc) ?? 0, colW.get(c) ?? NODE_MIN_W));
  }
  const foldedMaxCol = Math.max(-1, ...[...foldedColW.keys()]);

  const colX = new Map<number, number>();
  let acc = 0;
  for (let c = 0; c <= foldedMaxCol; c++) {
    colX.set(c, acc);
    acc += (foldedColW.get(c) ?? NODE_MIN_W) + COL_GAP;
  }

  // 4) 同格错开：同(新col,row) 的第二个节点自动下一行
  const occupied = new Set<string>();
  const nodes: LaidOutNode[] = [];

  for (const n of srcNodes) {
    const nc = colMap.get(n.col) ?? n.col;
    const effRow = (rowShift.get(n.col) ?? 0) + (n.row ?? 0);
    let key = effRow + ':' + nc;
    let bump = 0;
    while (occupied.has(key)) {
      bump += 1;
      key = (effRow + bump) + ':' + nc;
      if (bump === 1) {
        issues.push('节点 ' + n.id + ' 与同行节点同格，已自动下移一行');
      }
    }
    occupied.add(key);
    const w = Math.max(NODE_MIN_W, Math.ceil(measureTextUnits(n.label) * FONT_LABEL) + PAD_X * 2);
    // 有泳道：y = 带 y + 层名高（节点嵌在带内）；无泳道：纯网格 y
    const tierTop = tierY.get(effRow + bump);
    const y = tierTop !== undefined ? tierTop + TIER_LABEL_H : (effRow + bump) * (NODE_H + ROW_GAP);
    nodes.push({
      ...n,
      x: colX.get(nc) ?? 0,
      y,
      w,
      h: NODE_H,
    });
  }

  const width = Math.max(1, Math.max(...nodes.map(n => n.x + n.w), 240));
  let height = Math.max(1, Math.max(...nodes.map(n => n.y + n.h), 120));
  if (tiersOut) {
    for (const t of tiersOut) {
      t.w = width;
      height = Math.max(height, t.y + t.h);
    }
    // 画布底部留一条泳道的下边距
    height += TIER_PAD_BOTTOM;
  }
  return { nodes, width, height, issues, tiers: tiersOut };
}

/** HTML 转义。SVG 内文本必须转义，否则模型写 `<script>` 会变成真实标签。 */
function esc(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 连线路由（分层正交式，2026-10-10 重写）。
 *
 * 三态（通道错开防重叠，横平竖直优先于曲线）：
 * - 同行正向：短贝塞尔（短弧柔和，保留）
 * - 跨行（目标在下方）：源底部出 → 垂直下 → 水平 → 目标顶部入，正交直角。
 *   水平段 y 取两行之间 + 通道偏移：同一源的多条下行边各错开，不叠成粗线。
 * - 回折（目标在源左侧，或同行反向）：正交绕行 + 虚线（视觉标记逆向依赖）。
 *
 * 为什么跨行不用曲线：分层图里跨行边占多数，长贝塞尔大弧交叉横穿 =
 * 无法追踪（真机用户原话「鬼画符」）。正交折线只有两次 90° 转向，视线可跟。
 * channel：同源下行边的序号（0,1,2…），由调用方按源聚合分配。
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
    const x1 = a.x + a.w, y1 = a.y + a.h / 2;
    const x2 = b.x, y2 = b.y + b.h / 2;
    const mx = (x1 + x2) / 2;
    return { d: 'M' + x1 + ' ' + y1 + ' C' + (mx + 16) + ' ' + y1 + ' ' + (mx - 16) + ' ' + y2 + ' ' + x2 + ' ' + y2, dash: false };
  }

  // 跨行下行：正交「底出顶入」。水平段夹在两行之间，通道偏移防重叠。
  if (!sameRow && b.y > a.y) {
    const x1 = a.x + a.w / 2;
    const y1 = a.y + a.h;
    const x2 = b.x + b.w / 2;
    const y2 = b.y;
    const gap = y2 - y1;
    // 通道 0 居中，之后 +8/-8/+16/-16 交错；夹逼在空隙内（留 4px 边距）
    const raw = ch === 0 ? 0 : (ch % 2 === 1 ? Math.ceil(ch / 2) : -ch / 2) * 8;
    const midY = y1 + gap / 2 + Math.max(-(gap / 2 - 4), Math.min(gap / 2 - 4, raw));
    return {
      d: 'M' + x1 + ' ' + y1 + ' L' + x1 + ' ' + midY + ' L' + x2 + ' ' + midY + ' L' + x2 + ' ' + y2,
      dash: false,
    };
  }

  // 回折：正交绕行 + 虚线。上行绕顶部、其余绕底部，通道沿绕行方向递增。
  const goingDown = b.y >= a.y;
  const x1 = a.x + a.w, y1 = a.y + a.h / 2;   // 右侧出
  const x2 = b.x, y2 = b.y + b.h / 2;          // 左侧入
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

/**
 * 编译成 SVG 字符串。
 *
 * 调用前必须已通过 judgeIr（verdict==='ok'）——本函数**不做校验**，
 * 职责单一：只负责把合法 IR 变成画。校验在 judgeIr，混在一起会两头难测。
 */
export function compileIrToSvg(ir: IrDocument): string {
  if (ir.diagram_type === 'sequence') return renderSequence(ir);
  const lay = layoutIr(ir);
  const byId = new Map(lay.nodes.map(n => [n.id, n]));

  const parts: string[] = [];
  parts.push(
    '<svg viewBox="0 0 ' + lay.width + ' ' + lay.height + '" ' +
    'preserveAspectRatio="xMidYMid meet" role="img" ' +
    'xmlns="http://www.w3.org/2000/svg">',
  );
  // defs 放最前（marker 必须先定义再引用）
  parts.push(
    '<defs><marker id="ir-arrow" viewBox="0 0 10 10" refX="9" refY="5" ' +
    'markerWidth="6" markerHeight="6" orient="auto-start-reverse">' +
    '<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" ' +
    'stroke-linecap="round" stroke-linejoin="round"/></marker></defs>',
  );

  // 泳道最底（层的视觉语言：淡底区块 + 层名，节点嵌在带内）。
  // 无 tiers 时完全跳过 —— 现状网格渲染零变化。
  if (lay.tiers) {
    for (const t of lay.tiers) {
      parts.push(
        '<rect class="ir-tier" x="' + t.x + '" y="' + t.y + '" width="' + t.w
        + '" height="' + t.h + '" rx="10" fill="var(--c-surface)" fill-opacity="0.45"'
        + ' stroke="var(--c-border)" stroke-dasharray="3 3"/>',
      );
      parts.push(
        '<text x="' + (t.x + 10) + '" y="' + (t.y + 16) + '" font-size="11"'
        + ' fill="var(--c-muted-fg)" font-family="system-ui, sans-serif">'
        + esc(t.name) + '</text>',
      );
    }
  }

  // 边先画（保证连线在节点之下）。
  // 同一源的下行边按出现序号分配通道（0,1,2…），水平段互相错开不叠成粗线。
  const edgeChannel: number[] = [];
  const perSource = new Map<string, number>();
  for (const e of ir.edges ?? []) {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    const isDownward = a && b && a.y !== b.y && b.y > a.y;
    if (!isDownward) {
      edgeChannel.push(0);
      continue;
    }
    const n = perSource.get(e.from) ?? 0;
    perSource.set(e.from, n + 1);
    edgeChannel.push(n);
  }

  (ir.edges ?? []).forEach((e, idx) => {
    const a = byId.get(e.from);
    const b = byId.get(e.to);
    if (!a || !b) return; // 悬空边由 judgeIr 拦下，这里只做防御
    const { d, dash } = edgePath(a, b, { channel: edgeChannel[idx] ?? 0 });
    // stroke 用 muted-fg（比 border 深）：多条线交叉时仍能分清各自走向
    // （2026-10-10 用户反馈「交叉或重叠的线看不太友好」）
    parts.push(
      '<path d="' + d + '" fill="none" stroke="var(--c-muted-fg)" stroke-width="1.6"' +
      ' stroke-opacity="0.85"' +
      (dash ? ' stroke-dasharray="4 3"' : '') + ' marker-end="url(#ir-arrow)"/>',
    );
  });

  // 节点
  for (const n of lay.nodes) {
    const st = KIND_STYLE[n.kind] ?? KIND_STYLE.process;
    parts.push(
      '<g><rect x="' + n.x + '" y="' + n.y + '" width="' + n.w + '" height="' + n.h +
      '" rx="9" fill="' + st.fill + '" stroke="' + st.stroke + '" stroke-width="1"/>' +
      '<text x="' + (n.x + n.w / 2) + '" y="' + (n.y + 15) + '" text-anchor="middle" ' +
      'font-size="' + FONT_KIND + '" fill="' + st.text + '" opacity="0.9" ' +
      'font-family="system-ui, sans-serif">' + esc(st.label) + '</text>' +
      '<text x="' + (n.x + n.w / 2) + '" y="' + (n.y + 34) + '" text-anchor="middle" ' +
      'font-size="' + FONT_LABEL + '" fill="var(--c-fg)" ' +
      'font-family="system-ui, sans-serif">' + esc(n.label) + '</text></g>',
    );
  }

  parts.push('</svg>');
  return parts.join('');
}

/**
 * 编译结果（含布局问题），供 UI 层决定是否提示用户。
 *
 * 与 compileIrToSvg 的区别：这里把 layout 的 issues 一并带出，
 * 让前端能显示「已自动折行」这类提示，而不是静默调整。
 */
export function compileIrWithMeta(ir: IrDocument): { svg: string; layout: IrLayout } {
  return { svg: compileIrToSvg(ir), layout: layoutIr(ir) };
}

/**
 * 另存为自含 HTML（工具栏「另存」用，对齐 canvas 卡片的独立文件能力）。
 *
 * 双主题：独立文件没有宿主主题可跟随，只能跟随系统 prefers-color-scheme。
 * 变量取值沿用宿主映射口径（基础色由卡片变量层映射），不写死单一浅色——
 * 那是现状链路「写死浅色底」的老坑，这里不能重犯。
 * 无脚本：图是静态 SVG，沙箱外的独立文件也不需要任何 JS。
 */
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
:root{
  --c-bg:#ffffff;--c-fg:#1f2124;--c-muted:#f4f5f7;--c-muted-fg:#5f6368;
  --c-border:#e1e3e8;--c-ok:#2e8b57;--c-warn:#c98a1e;--c-bad:#cc4b4b;
  --c-ok-bg:#eaf6ef;--c-warn-bg:#faf3e0;--c-bad-bg:#fbecec;
}
@media (prefers-color-scheme: dark){
  :root{
    --c-bg:#242427;--c-fg:#e6e6e6;--c-muted:#33343a;--c-muted-fg:#a5a8b0;
    --c-border:#43454c;--c-ok:#6fce9d;--c-warn:#e2b45f;--c-bad:#e88;
    --c-ok-bg:#243529;--c-warn-bg:#37301f;--c-bad-bg:#3a2424;
  }
}
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

/* ============================== 时序图渲染 ============================== */

const SEQ_PART_W = 128;
const SEQ_PART_H = 38;
const SEQ_TOP = 10;
const SEQ_MSG_TOP_GAP = 26;
const SEQ_MSG_GAP = 44;
const SEQ_SIDE = 16;

/**
 * 时序图：生命线 + 按数组顺序自上而下的消息箭头。
 *
 * 与 architecture 的分工：时序图没有拓扑坐标（col/row 无意义），
 * 布局只有一维——时间。messages 数组顺序即时间顺序（模型最容易给对的形态）。
 * 序号由渲染器按数组下标生成（1,2,3…），模型不用自己编号。
 */
function renderSequence(ir: IrDocument): string {
  const parts: string[] = [];
  const participants: IrParticipant[] = (ir.participants ?? []).filter(
    (t): t is IrParticipant => typeof t.id === 'string' && typeof t.label === 'string',
  );
  const messages = (ir.messages ?? []).filter(
    (m): m is { from: string; to: string; label?: string } =>
      typeof m.from === 'string' && typeof m.to === 'string',
  );

  const n = Math.max(participants.length, 2);
  const width = SEQ_SIDE * 2 + n * SEQ_PART_W + (n - 1) * 24;
  const centerX = new Map<string, number>();
  participants.forEach((p, i) => {
    centerX.set(p.id, SEQ_SIDE + i * (SEQ_PART_W + 24) + SEQ_PART_W / 2);
  });

  const height = SEQ_TOP + SEQ_PART_H + SEQ_MSG_TOP_GAP + messages.length * SEQ_MSG_GAP + 18;

  parts.push(
    '<svg viewBox="0 0 ' + width + ' ' + height + '" preserveAspectRatio="xMidYMid meet"'
    + ' role="img" xmlns="http://www.w3.org/2000/svg">',
  );
  parts.push(
    '<defs><marker id="ir-seq-arrow" viewBox="0 0 10 10" refX="9" refY="5"'
    + ' markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
    + '<path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5"'
    + ' stroke-linecap="round" stroke-linejoin="round"/></marker></defs>',
  );

  // 生命线先画（在框与消息之下）：垂直虚线
  for (const p of participants) {
    const cx = centerX.get(p.id)!;
    parts.push(
      '<line class="ir-seq-lifeline" x1="' + cx + '" y1="' + (SEQ_TOP + SEQ_PART_H)
      + '" x2="' + cx + '" y2="' + (height - 8)
      + '" stroke="var(--c-border)" stroke-dasharray="4 4"/>',
    );
  }

  // 参与者框（生命线之上）
  participants.forEach((p, i) => {
    const x = SEQ_SIDE + i * (SEQ_PART_W + 24);
    const cx = centerX.get(p.id)!;
    parts.push(
      '<g class="ir-seq-participant">'
      + '<rect x="' + x + '" y="' + SEQ_TOP + '" width="' + SEQ_PART_W + '" height="' + SEQ_PART_H
      + '" rx="8" fill="var(--c-surface)" stroke="var(--c-border)"/>'
      + '<text x="' + cx + '" y="' + (SEQ_TOP + SEQ_PART_H / 2 + 4) + '" text-anchor="middle"'
      + ' font-size="12" font-weight="500" fill="var(--c-fg)" font-family="system-ui, sans-serif">'
      + esc(p.label) + '</text></g>',
    );
  });

  // 消息：第 i 条 y 递增；箭头从 from 生命线到 to 生命线；序号圆标 + 标签
  messages.forEach((m, i) => {
    const y = SEQ_TOP + SEQ_PART_H + SEQ_MSG_TOP_GAP + i * SEQ_MSG_GAP;
    const fx = centerX.get(m.from);
    const tx = centerX.get(m.to);
    if (fx === undefined || tx === undefined) return; // 悬空消息校验已拦
    const self = m.from === m.to;
    const x1 = fx, x2 = tx;
    // 标签：线的中点上方；自消息放右侧
    const midX = self ? x1 + 14 : (x1 + x2) / 2;
    const label = m.label ?? '';
    let body: string;
    if (self) {
      // 自消息：右侧小 U 回环
      body = 'M' + x1 + ' ' + (y - 6) + ' L' + (x1 + 34) + ' ' + (y - 6)
        + ' L' + (x1 + 34) + ' ' + (y + 6) + ' L' + (x1 + 4) + ' ' + (y + 6);
    } else {
      body = 'M' + x1 + ' ' + y + ' L' + x2 + ' ' + y;
    }
    parts.push(
      '<g class="ir-seq-msg" transform="translate(0,0)">'
      + '<path class="ir-seq-msg-line" d="' + body + '" fill="none"'
      + ' stroke="var(--c-muted-fg)" stroke-width="1.6" marker-end="url(#ir-seq-arrow)"/>'
      + '<circle cx="' + (x1 + (self ? 10 : 0)) + '" cy="' + y + '" r="9"'
      + ' fill="var(--c-surface)" stroke="var(--c-muted-fg)"/>'
      + '<text x="' + (x1 + (self ? 10 : 0)) + '" y="' + (y + 3.5) + '" text-anchor="middle"'
      + ' font-size="9.5" fill="var(--c-fg)" font-family="system-ui, sans-serif">' + (i + 1) + '</text>'
      + '<text x="' + (midX + (self ? 44 : 0)) + '" y="' + (self ? y + 18 : y - 6) + '"'
      + ' text-anchor="middle" font-size="11" fill="var(--c-muted-fg)"'
      + ' font-family="system-ui, sans-serif">' + esc(label) + '</text>'
      + '</g>',
    );
  });

  parts.push('</svg>');
  return parts.join('');
}
