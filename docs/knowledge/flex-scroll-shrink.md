# flex column 滚动容器会压缩 overflow:hidden 子项而不是滚动

**反直觉点**：`display:flex; flex-direction:column; overflow-y:auto` 的滚动容器里，子项默认 `flex-shrink:1`。内容总高超过容器时，flexbox **先收缩子项适配容器，而不是溢出滚动**。视觉症状是"某些元素凭空消失/变形"，而不是出现滚动条。

**收缩量分配规则**（诊断关键）：
- 文本块的 `min-height:auto` 地板 = min-content 高度（中文整段几乎压不动）→ 文本消息看起来"正常"
- `overflow:hidden` 的子项（工具组、卡片头、徽标行）min-height 地板 = **0** → 吸收全部收缩量 → 高度归零/竖排变形

所以典型表现是：**文本都在、唯独某类条状元素不见/变形**，且间歇性（仅内容总高跨过容器高度才触发）。本项目两次踩坑均为该规则：
- v3.41：`.srv-header`（子agent条）无 nowrap/flex-shrink:0，被压折行变形
- v3.42：`.wc-messages` 直接子项被压，`.tool-group` 高度归零"消失"

**修复模式**（二选一）：
1. 滚动容器直接子元素一律 `flex-shrink: 0`（或子项按需 nowrap + flex-shrink:0）
2. 结构性免疫：滚动容器内套唯一包装层（块级流），如单视图 `.conv-messages > .conv-messages-inner`——多窗口 `.wc-messages` 缺这层才中招

**排查路径**：怀疑此类问题时不要猜，直接无头浏览器量测几何：`el.getBoundingClientRect().height` + `getComputedStyle(el).flexShrink/minHeight`。DOM 存在 + 高度 0 + 祖先 overflow:hidden = 本坑。回归锁法：矮视口 + 种子内容，断言目标元素 `offsetHeight > 0`（见 `packages/forge-ui/e2e/mwToolGroupVisible.spec.ts`）。
