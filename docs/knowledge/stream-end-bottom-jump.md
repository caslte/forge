# 「流式收尾帧底部跳一下」到底跳在哪（实测结论）

**现象**：用户反馈「AI 输出完了之后对话框底部会跳一下」。

**结论（本机实测，非推理）**：
1. **滚动钉底机制本身没有问题**——`ConversationView.onConvResize` → `scrollToBottom()` 挂在
   ResizeObserver 回调上，而 RO 回调运行在「当帧布局之后、绘制之前」。用 RO 回调采样可见
   `dScrollH == dScrollTop` 恒成立（内容涨多少、滚动补多少，同帧完成），`gapBottom` 恒为 17~18px
   （即底部内边距），**不存在"底部内容被裁到视口外"的绘制帧**。
2. **唯一真实存在的一帧位移来自收尾帧底部区块的构成变化**：
   - 摘除：`.conv-thinking` 思考指示行（实测 39px + `gap: 16px`）
   - 挂载：`.msg-footer` 消息底栏（实测 17px，`v-if="!streaming"`）
   → 净高度变化约 **−30px**，滚动同步跟随 → **整段对话内容在一帧内下沉约 30px**。若此时
   `SuggestionChips` / `compactBanner` 也挂载，位移会叠加放大。
3. **排除了两个看似可疑的机制**（改前改后各跑 6 次，结论稳定）：
   - `scrollbar-gutter: stable`：全部采样中 `dClientWidth` 恒为 0，没有滚动条出现/消失引起的宽度突变；
   - 流式终态补「落位稳定期」：因为收尾帧之前 `autoFollow` 已为 true，`onConvResize` 本来就会钉底；
     补稳定期对所有采样帧零影响。
   - 输入区（用户说的「对话框底部」）`.conv-input-wrap` / `.compose-box` 的 top 与高度**全程不动**。

**方法论（关键，避免把中间态当跳）**：`requestAnimationFrame` → `setTimeout(0)` 采样看到的是
**帧内未修正的中间态**（本次会把 0px 的真实位移误报成 429px）——一帧里 `scrollToBottom()` 可能被
调用两次（`nextTick` 一次、RO 回调一次），第一次用的是尚未包含终态重渲染的旧 `scrollHeight`。
判定"是否真的被画出来"必须用 **ResizeObserver 回调采样**（布局后、绘制前），并且把
`dScrollH` 与 `dScrollTop` 成对比较：只有二者不等且 gap 明显为负，才是真跳。

**复现/验证脚本**：`packages/forge-ui/e2e/__repro-stream-end-jump.spec.ts`
（三路采样：绘制后 / RO 布局后 / 输入区几何；`--grep "repro L"` 只看权威的布局后采样）。

**修复（v3.85.0，方案 A：~160ms 高度过渡）**：把收尾帧硬切改成同步过渡——
- `.conv-thinking` 摘除：`Transition :css="false" @leave` + **rAF 逐帧显式赋值**（height/padding/opacity
  同比例收拢 + 负外边距抵消将消失的 flex gap），末帧零尺寸后才 `done()` 卸载；
- `.msg-footer` 挂载：`Transition :css="false" @enter`（height/margin-top/opacity 从 0 展开）。
实测：原来一帧 −30px，现在摊到 ~15 帧、单帧最大 ≈11px（easeOutCubic 起步），卸载帧位移归零。

**本方案踩到的两个布局坑（都是探针实测发现，值得复用）**：
1. **border-box 渲染高度不能低于 padding 之和**：`.conv-thinking` 上下 padding 各 10px，只动 `height`
   会卡死在 20px（内容盒钳到 0 为下限），残余在卸载帧一次性跳出。第一版 CSS transition 与第二版
   rAF 逐帧赋值都冻在同一个 20px——**冻结值 = padding 和，说明是布局钳制而非动画引擎问题**。
   修法：padding 与 height 用同一比例同步收到 0。
2. **flex gap 随卸载一起消失**：column flex + gap 容器里卸载一个子项，其上/下侧 gap 同帧消失；
   需按有无相邻兄弟（`previousElementSibling`/`nextElementSibling`）用负 margin 等量抵消，
   否则收拢完还剩一次 gap 跳变。
