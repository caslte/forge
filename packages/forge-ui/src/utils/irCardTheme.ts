/**
 * IR 卡片的语义色映射表（数据基准）。
 *
 * ## 用途与边界（2026-10-10 两轮真机 bug 后的定位）
 *
 * 这份映射表是 `IrCanvasBlock.vue` scoped style 里那组 `--c-*` 定义的**单一事实来源**：
 * 组件为了守「全 var() 无硬编码」，变量定义直接写在组件 scoped style 里（静态、无 JS）。
 * 本文件把同一份映射抽出来给单测断言——**组件 CSS 没法单测，映射表可以**。
 * 两处必须保持一致；若漂移，以本表的测试为准。
 *
 * ## 为什么组件不能直接用本文件（第一版踩的坑）
 *
 * 第一版让组件 `:style="irCardRootStyle()"`，而本函数返回的是**完整 CSS 规则串**
 * （`.ir-card{...}`）。Vue 的 `:style` 期望**内联声明串**，带选择器的规则串会被整段
 * 忽略——变量根本没注入，真机整卡白板。更糟的是当时的单测断言也按「规则串」写的
 * （断言"以 .ir-card { 开头"），绿灯是假象，直到真机才暴露。
 *
 * 教训：**给 :style 的必须是声明串；带选择器的规则只能进 <style>**。
 * 如今 irCardRootStyle 已删除，防再误用。
 */

/**
 * 语义色别名 → 基础令牌。
 *
 * 取值口径对齐 canvasSandbox 的 preflight（同一套语义命名），
 * 但落到 forge-ui 自己的 design-tokens 基础令牌上。
 */
export const IR_CARD_CSS_VARS: Readonly<Record<string, string>> = {
  '--c-bg': 'var(--background)',
  '--c-fg': 'var(--foreground)',
  '--c-muted': 'var(--muted)',
  '--c-muted-fg': 'var(--muted-foreground)',
  '--c-surface': 'color-mix(in oklab, var(--muted) 55%, var(--background))',
  '--c-border': 'var(--border)',
  '--c-ok': 'var(--success)',
  '--c-warn': 'var(--warning)',
  '--c-bad': 'var(--destructive)',
  '--c-accent': 'var(--brand-accent)',
  // 语义色的浅底：与 canvas preflight 同构，用 color-mix 从基础色派生，
  // 不引入新的绝对色值 ⇒ 深浅色各自正确。
  '--c-ok-bg': 'color-mix(in oklab, var(--success) 12%, var(--background))',
  '--c-warn-bg': 'color-mix(in oklab, var(--warning) 14%, var(--background))',
  '--c-bad-bg': 'color-mix(in oklab, var(--destructive) 12%, var(--background))',
};

/**
 * 生成**内联声明串**（可给 :style / style 属性用的形态）。
 *
 * ⚠ 与已删除的 irCardRootStyle 的区别：返回的是 `--c-bg:...;--c-fg:...`，
 * **没有选择器、没有花括号**。这是 Vue `:style` 绑定唯一能接受的字符串形态。
 * 当前组件用 scoped style 静态定义，本函数暂无调用方，保留供未来动态主题切换用。
 */
export function irCardVarsDeclaration(): string {
  return Object.entries(IR_CARD_CSS_VARS)
    .map(([k, v]) => `${k}:${v}`)
    .join(';');
}
