/**
 * 布局层的公共类型。
 *
 * 三个布局编译器（分层 / 时序 / 树）都产出同一个 `IrLayout`，
 * 渲染器只认这个结构 ⇒ 加一类图 = 加一个布局器，渲染代码零改动。
 */

import type { IrNodeKind } from './schemaSpec.ts';
import type { IrShape, KindStyle } from './shapes.ts';

/** 布局后的节点：绝对像素坐标 + 已算好的外形与配色。 */
export interface LaidOutNode {
  id: string;
  label: string;
  kind: IrNodeKind;
  /**
   * 模型声明的层号 / 列号，原样带出。
   *
   * 布局算完之后它们对渲染没用（x/y 已经是最终答案），但**必须留着**：
   * 一是「这个节点落在哪条泳道」这类断言要能对得上，
   * 二是排查「模型给的 row 和实际画出来的位置对不上」时没有别的线索。
   */
  row?: number;
  col?: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** 折行后的标签（1~2 行）。 */
  lines: string[];
  shape: IrShape;
  style: KindStyle;
}

/** 布局后的边：已经算好的路径，渲染器不再做任何几何判断。 */
export interface LaidOutEdge {
  d: string;
  dash: boolean;
  label?: string;
  /** 标签锚点。 */
  lx: number;
  ly: number;
  /**
   * 双向箭头：**两端都画箭头**。
   * 目前只有架构图「相邻两层互相依赖」用——归并成一条线，两个头表示两个方向都有依赖。
   */
  bidir?: boolean;
}

/** 布局后的泳道（仅架构图）：y/h 为该层带的纵向位置与高度。 */
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
  edges: LaidOutEdge[];
  width: number;
  height: number;
  /** 布局阶段的机械问题（暴露给门禁，不抛异常）。 */
  issues: string[];
  /** 有泳道时才有：泳道几何（无泳道 = undefined）。 */
  tiers?: LaidOutTier[];
  /**
   * 连线是否带箭头。缺省 true。
   *
   * 树要设 false：父子是**归属**关系不是流向，带箭头会让人以为「根指向子」是一次
   * 动作。流程图/架构图则必须带箭头——方向就是信息本身。
   */
  arrows?: boolean;
}

/** 节点的外接盒（布局内部传递用，不含语义）。 */
export interface Box {
  x: number;
  y: number;
  bw: number;
  bh: number;
}
