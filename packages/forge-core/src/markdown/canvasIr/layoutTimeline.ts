/**
 * 时序布局编译器。
 *
 * 时序图没有拓扑坐标——布局只有一维：**时间**。
 * `messages` 数组的顺序就是时间顺序（模型最容易给对的形态），序号由宿主生成。
 *
 * ## 线头对齐（用户第二轮反馈的修正）
 *
 * 首版把箭头从 `cx[from]` 画到 `cx[to]`，也就是**生命线中心**——
 * 而中心在激活条内部，箭头看起来「插进了块里」。
 * 用户原话：「时序还行，但是线头再对准一点，是不是线段到边就行了，还是要插到块里面去？」
 *
 * 答案是**到边**（UML 约定）：激活条宽 9px，线从 `cx ± 4.5` 起止，
 * 正好落在条的边缘而不是插进去。这也是本文件把 ACT_HALF 单独提出来注释的原因——
 * 这个 4.5 不是随手写的常数，是「线头对齐」这条要求的全部实现。
 *
 * ## 为什么单独一个布局类型
 *
 * 时序图的构成件（生命线、激活条、序号圆标）与「节点 + 边」模型对不上，
 * 硬塞进 IrLayout 只会让渲染器到处判类型。这里如实给出它自己的结构。
 */

import { FONT_EDGE, textWidth } from './textFit.ts';
import type { IrDocument } from '../canvasIr.ts';

/** 参与者框高 / 顶部留白 / 框与首条消息的间距 / 消息行距 / 左右留白 / 参与者间距。 */
const P_H = 40;
const TOP = 10;
const HEAD_GAP = 30;
const MSG_GAP = 48;
const SIDE = 20;
const PGAP = 30;
/** 参与者框最小宽度。 */
const P_MIN_W = 112;
/** 激活条宽与半宽 —— 线头就落在 ±ACT_HALF 上（见文件头）。 */
const ACT_W = 9;
const ACT_HALF = ACT_W / 2;
/** 激活条相对消息行的上下溢出（让条把消息「包住」而不是刚好切齐）。 */
const ACT_PAD_TOP = 9;
const ACT_PAD_BOTTOM = 11;

export interface SeqParticipant {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  cx: number;
}

export interface SeqLifeline {
  x: number;
  y1: number;
  y2: number;
}

export interface SeqActivation {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SeqMessage {
  /** 序号（1 起），渲染进圆标。 */
  index: number;
  y: number;
  /** 起止点 x（已按激活条边缘对齐）。 */
  x1: number;
  x2: number;
  self: boolean;
  /** 返回消息：虚线 + 空心箭头。 */
  isReturn: boolean;
  label?: string;
  labelX: number;
  labelY: number;
  /** 序号圆标圆心。 */
  badgeX: number;
  badgeY: number;
  /** 回环路径（仅自消息有值）。 */
  loop?: string;
}

export interface SeqLayout {
  kind: 'sequence';
  width: number;
  height: number;
  issues: string[];
  participants: SeqParticipant[];
  lifelines: SeqLifeline[];
  activations: SeqActivation[];
  messages: SeqMessage[];
}

/**
 * 时序图布局。
 *
 * 自消息（from === to）画成右侧回环：时序图里「自己调自己」很常见
 * （重试、内部方法调用），直接画成零长箭头会看不见。
 */
export function layoutTimeline(ir: IrDocument): SeqLayout {
  const issues: string[] = [];
  const participants = (ir.participants ?? []).filter(
    (p) => typeof p.id === 'string' && typeof p.label === 'string',
  );
  const messages = (ir.messages ?? []).filter(
    (m) => typeof m.from === 'string' && typeof m.to === 'string',
  );

  const n = Math.max(participants.length, 1);
  const widest = participants.length
    ? Math.max(...participants.map((p) => textWidth(p.label, 12.5, 500) + 40))
    : P_MIN_W;
  const P_W = Math.max(P_MIN_W, Math.ceil(widest));
  const width = SIDE * 2 + n * P_W + (n - 1) * PGAP;

  const cx: number[] = [];
  const cxById: Record<string, number> = {};
  participants.forEach((p, i) => {
    cx.push(SIDE + i * (P_W + PGAP) + P_W / 2);
    cxById[String(p.id)] = cx[i]!;
  });

  const baseY = TOP + P_H + HEAD_GAP;
  const height = baseY + Math.max(messages.length - 1, 0) * MSG_GAP + 30;
  const yOf = (i: number): number => baseY + i * MSG_GAP;

  const out: SeqParticipant[] = participants.map((p, i) => ({
    id: String(p.id),
    label: String(p.label),
    x: SIDE + i * (P_W + PGAP),
    y: TOP,
    w: P_W,
    h: P_H,
    cx: cx[i]!,
  }));

  const lifelines: SeqLifeline[] = cx.map((x) => ({ x, y1: TOP + P_H, y2: height - 12 }));

  // 激活条：每个参与者从它最早的消息到最晚的消息
  const activations: SeqActivation[] = [];
  participants.forEach((p) => {
    const ys: number[] = [];
    messages.forEach((m, i) => {
      if (m.from === p.id || m.to === p.id) ys.push(yOf(i));
    });
    if (!ys.length) return;
    const y0 = Math.min(...ys) - ACT_PAD_TOP;
    const y1 = Math.max(...ys) + ACT_PAD_BOTTOM;
    activations.push({ x: cxById[String(p.id)]! - ACT_HALF, y: y0, w: ACT_W, h: y1 - y0 });
  });

  const outMsgs: SeqMessage[] = [];
  messages.forEach((m, i) => {
    const y = yOf(i);
    const fx = cxById[String(m.from)];
    const tx = cxById[String(m.to)];
    if (fx === undefined || tx === undefined) {
      issues.push('第 ' + (i + 1) + ' 条消息的端点不在参与者中，已跳过');
      return;
    }
    const self = m.from === m.to;
    const isReturn = m.kind === 'return';
    const dir = self ? 1 : tx > fx ? 1 : -1;

    let x1: number;
    let x2: number;
    let loop: string | undefined;
    if (self) {
      x1 = fx + ACT_HALF;
      x2 = x1;
      loop = 'M' + x1 + ' ' + (y - 11) + ' h28 v22 h-28';
    } else if (tx > fx) {
      // 从源激活条右缘出发，落到目标激活条左缘
      x1 = fx + ACT_HALF;
      x2 = tx - ACT_HALF;
    } else {
      x1 = fx - ACT_HALF;
      x2 = tx + ACT_HALF;
    }

    const label = m.label;
    const labelX = self ? fx + 60 : (fx + tx) / 2;
    const labelY = self ? y - 16 : y - 8;

    outMsgs.push({
      index: i + 1,
      y,
      x1,
      x2,
      self,
      isReturn,
      label,
      labelX,
      labelY,
      badgeX: fx + dir * (self ? 22 : 15),
      badgeY: y,
      loop,
    });
  });

  return { kind: 'sequence', width, height, issues, participants: out, lifelines, activations, messages: outMsgs };
}

/** 时序图不需要折行度量，但导出常量便于渲染器对齐字号。 */
export const SEQ_FONT_LABEL = 12.5;
export const SEQ_FONT_EDGE = FONT_EDGE;
