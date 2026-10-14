/**
 * 节点语义 → 形状与配色。
 *
 * ## 为什么 kind 必须映射到「形状」而不只是「颜色」
 *
 * 只靠颜色区分语义有两个问题：
 * 1. 深浅色切换后相近色会糊在一起（真机上 --c-warn 与 --c-ok 在深色下就很接近）
 * 2. 色觉障碍用户读不出差别
 *
 * 形状是颜色之外的第二条冗余通道：判定=菱形、起止=胶囊、存储=圆柱、数据=平行四边形。
 * 这与流程图/架构图的既有视觉语言一致，不需要用户学新符号。
 *
 * ## 配色纪律
 *
 * 全部走 `--c-*` 变量，**一个硬编码色值都不许有**（单测守着）。理由不是洁癖：
 * SVG 里的颜色若写死，深色主题下会变成「白底白字」或「黑块吞字」——
 * 这个坑在 canvas 卡片上已经踩过一次。
 *
 * 因此本文件列出的每个变量，**必须同时存在于两处**：
 * - 卡片：`IrCanvasBlock.vue` 的 scoped style + `utils/irCardTheme.ts` 映射表
 * - 独立文件：`buildIrStandaloneFile` 的 `:root`
 * 少一处，那条 fill 就解析失败回落成黑色。加变量时两处一起加。
 */

import type { IrNodeKind } from './schemaSpec.ts';

/** 受支持的节点外形。 */
export type IrShape = 'rect' | 'round' | 'capsule' | 'diamond' | 'cylinder' | 'parallelogram';

export interface KindStyle {
  shape: IrShape;
  fill: string;
  stroke: string;
  /** 文字色。省略时用 --c-fg。 */
  text?: string;
  /** 虚线描边（表示「非本系统内」或「容器边界」）。 */
  dash?: boolean;
  /** 中文语义名（回执与诊断用）。 */
  label: string;
}

/**
 * 八种 kind 的形状与配色。
 *
 * 分配依据是「一眼能读出这是流程里的哪一类东西」：
 * - 判定/起止是流程图的两个表意形状，缺了流程图就只剩一堆方框
 * - 存储/外部是架构图里最需要与普通组件区分开的两类
 */
export const KIND_STYLE: Readonly<Record<IrNodeKind, KindStyle>> = {
  component: { shape: 'rect', fill: 'var(--c-accent-bg)', stroke: 'var(--c-accent)', label: '组件' },
  // process 用中性面：它是出现最多的一类，着色过多会让整张图花掉
  process: { shape: 'rect', fill: 'var(--c-surface)', stroke: 'var(--c-border)', label: '进程' },
  decision: { shape: 'diamond', fill: 'var(--c-warn-bg)', stroke: 'var(--c-warn)', label: '判定' },
  terminal: { shape: 'capsule', fill: 'var(--c-muted)', stroke: 'var(--c-muted-fg)', label: '起止' },
  // 容器边界：透明底 + 虚线，表达「这里是个范围」而不是「这里有个东西」
  boundary: { shape: 'rect', fill: 'none', stroke: 'var(--c-muted-fg)', dash: true, label: '边界' },
  external: { shape: 'rect', fill: 'var(--c-bad-bg)', stroke: 'var(--c-bad)', dash: true, label: '外部' },
  storage: { shape: 'cylinder', fill: 'var(--c-ok-bg)', stroke: 'var(--c-ok)', label: '存储' },
  dataflow: { shape: 'parallelogram', fill: 'var(--c-accent-bg)', stroke: 'var(--c-accent)', label: '数据' },
};

/** 取 kind 的样式；未知 kind 回落 process（校验器已拦，这里只做防御）。 */
export function styleOf(kind: unknown): KindStyle {
  return KIND_STYLE[kind as IrNodeKind] ?? KIND_STYLE.process;
}

/**
 * 渲染器用到的全部 `--c-*` 变量名。
 *
 * 独立文件与卡片都必须定义这些；单测拿它与 UI 的映射表比对，
 * 防止「渲染器新用一个变量、UI 没跟上 ⇒ 静默变黑」。
 */
export const IR_REQUIRED_CSS_VARS: readonly string[] = [
  '--c-bg',
  '--c-fg',
  '--c-muted',
  '--c-muted-fg',
  '--c-surface',
  '--c-border',
  '--c-ok',
  '--c-ok-bg',
  '--c-warn',
  '--c-warn-bg',
  '--c-bad',
  '--c-bad-bg',
  '--c-accent',
  '--c-accent-bg',
];
