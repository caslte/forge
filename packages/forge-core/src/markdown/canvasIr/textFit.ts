/**
 * 文本度量与折行 —— 布局层的第一块共享原语。
 *
 * ## 为什么要有「可注入的度量器」
 *
 * forge-core 是纯 Node 引擎，**不能碰 DOM**（这是它能在 node:test 下回归的前提）。
 * 但排版要算文字宽度：用固定系数估算，中英混排会明显偏差（真机上表现为
 * 「刚好略长」的标签溢出节点框）。UI 侧本来就有真实字形表（canvas measureText），
 * 白白不用很浪费。
 *
 * 折中：度量器做成**可注入**的纯函数。
 * - 引擎默认用无 DOM 的系数估算 ⇒ 单测、CLI、探针都能跑
 * - UI 侧启动时注入真实测量 ⇒ 真机上尺寸准确
 *
 * 两者不改变算法，只改变「一个字有多宽」。这比在引擎里塞一个可选 DOM 分支干净：
 * 引擎不知道 DOM 存在，UI 也不需要知道排版算法。
 */

/** 度量一个字符串在给定字号下的像素宽度。 */
export type TextMeasurer = (text: string, size: number, weight?: number) => number;

/** 节点标签字号（px）。 */
export const FONT_NODE = 12.5;
/** 边标签 / 小字号（px）。 */
export const FONT_EDGE = 11.5;
/** 标签折行行高（px）。 */
export const LINE_H = 17;
/** 节点左右内边距（px），两侧各一。 */
export const PAD_X = 14;
/** 节点内文本区最大宽度（px），超过即折行。 */
export const NODE_MAX_TEXT = 148;
/** 节点最小宽度（px）。低于此值中文标签会被压扁。 */
export const NODE_MIN_W = 80;
/** 单行节点高度（px）。 */
export const NODE_H1 = 46;

/**
 * 无 DOM 的默认估算：中文/全角按 1 字宽，其余按 0.55。
 *
 * 这是**估算不是测量**。UI 侧应注入真实度量器覆盖它（见 setIrTextMeasurer）。
 */
export function estimateTextWidth(text: string, size: number): number {
  return measureTextUnits(text) * size;
}

/**
 * 文本宽度（单位：字符宽）。
 *
 * 中文/全角按 1，其余按 0.55。保留此函数（而非只留 estimateTextWidth）
 * 是因为它被既有单测与 UI 直接引用，语义是「几个字宽」而不是「几像素」。
 */
export function measureTextUnits(text: string): number {
  let units = 0;
  for (const ch of String(text ?? '')) {
    units += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.55;
  }
  return units;
}

/**
 * 当前生效的度量器。
 *
 * 模块级单例是有意的取舍：把度量器一路透传进每个布局函数会污染它们的签名
 * （每个函数都多一个与算法无关的参数），而「同一进程内度量口径一致」正是
 * 我们想要的。确定性仍然成立——给定度量器与输入，输出完全可复现。
 */
let activeMeasurer: TextMeasurer = estimateTextWidth;

/**
 * 注入真实度量器（UI 侧启动时调用一次）。
 *
 * 传 null 复位为内置估算。单测之间必须复位，否则会互相污染。
 */
export function setIrTextMeasurer(measure: TextMeasurer | null): void {
  activeMeasurer = measure ?? estimateTextWidth;
}

/** 读当前度量器（探针/诊断用）。 */
export function getIrTextMeasurer(): TextMeasurer {
  return activeMeasurer;
}

/** 按当前度量器量宽。 */
export function textWidth(text: string, size: number, weight?: number): number {
  return activeMeasurer(String(text ?? ''), size, weight);
}

/** 折行结果：最多两行，第二行超出时截断加省略号。 */
export interface FittedLabel {
  lines: string[];
  /** 文本区实际宽度（不含内边距）。 */
  textW: number;
  /** 盒子宽度（含内边距，已满足最小宽）。 */
  bw: number;
  /** 盒子高度。 */
  bh: number;
}

/**
 * 折行：最多两行。
 *
 * 两行是刻意的上限——节点是概览不是段落，三行以上会把图拉得很高、可读性反而下降。
 * 溢出部分由模型侧的上限（IR_MAX_LABEL_CHARS=24）兜住；真超了就在第二行截断加省略号，
 * 而不是让文字溢出节点框（溢出会让用户以为渲染坏了）。
 */
export function wrapLabel(label: string, maxW: number): string[] {
  const s = String(label ?? '');
  if (textWidth(s, FONT_NODE) <= maxW) return [s];
  let lines: string[] = [];
  let cur = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (textWidth(cur + ch, FONT_NODE) > maxW && cur !== '') {
      lines.push(cur);
      cur = ch;
      // 已经满两行：把剩下的全塞进第二行，交给下面截断
      if (lines.length === 2) {
        cur += s.slice(i + 1);
        break;
      }
    } else {
      cur += ch;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > 2) lines = lines.slice(0, 2);
  if (lines.length === 2 && textWidth(lines[1]!, FONT_NODE) > maxW) {
    let t = lines[1]!;
    while (t.length > 1 && textWidth(t + '…', FONT_NODE) > maxW) t = t.slice(0, -1);
    lines[1] = t + '…';
  }
  return lines;
}

/**
 * 按标签与形状算盒子尺寸。
 *
 * 形状会改变外接盒：菱形要放大外接矩形（文字要落在菱形内切区），
 * 圆柱要加椭圆端盖的高度，平行四边形要留斜边余量。放在这里统一算，
 * 避免每个布局器各算一套导致同一标签在不同图里大小不一致。
 */
export function fitNode(
  label: string,
  shape: string,
  measure: (t: string, s: number) => number = textWidth,
): FittedLabel {
  const lines = wrapLabel(label, NODE_MAX_TEXT);
  const widest = Math.max(...lines.map((l) => measure(l, FONT_NODE)));
  const textW = Math.ceil(widest);
  const bw = Math.max(NODE_MIN_W, textW + PAD_X * 2);
  const h = lines.length === 1 ? NODE_H1 : NODE_H1 + LINE_H;
  if (shape === 'diamond') return { lines, textW, bw: Math.ceil(bw * 1.75), bh: Math.ceil(h * 1.7) };
  if (shape === 'cylinder') return { lines, textW, bw, bh: h + 14 };
  if (shape === 'parallelogram') return { lines, textW, bw: bw + 16, bh: h };
  return { lines, textW, bw, bh: h };
}
