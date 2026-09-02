# 变更日志

# 变更日志

## v3.16 (首条消息自动命名不再包含附件占位)

- 用户反馈：带附件发送首条消息时，会话树标题变成「这个文件能识别吗[附件：build_docker_or…]」——附件拼片段被当作标题的一部分。
- 根因（`createForgeCore.ts` `generateSessionTitle`）：RPC 层把文本附件以「不可信声明 + [附件：<name>] 块」拼在正文末尾后才进 `onFirstUserMessage`，标题生成直接对拼接后全文截首句，附件块（及其文件内容）随入标题。
- 修复：`generateSessionTitle` 先剥离拼接的附件片段（按声明标记截断 + 兼容旧格式裸 `[附件：<name>]` 块）再取首句；纯附件消息（无正文）回退「新会话」。已有会话的脏标题可右键重命名修正。
- 测试：forge-desktop `createForgeCore.test.ts` 新增「generateSessionTitle：附件拼片段不进标题」（现格式/旧格式/纯附件/无附件不变共 4 断言）；forge-desktop 150 全过 + typecheck 通过。
- 文档同步：PRD 02 跨模块影响补附件不进标题规则；docs/test/02_session/e2e.md E-SM-001 断言补充。

## v3.15 (子 agent 视图三处体验修正 + 状态回退 bug)

- 用户实测反馈三问题：1) 运行中顶部占位文案"子 Agent 排队中，开始运行后此处将显示进展"多余，且跑了 11 秒状态仍显示"排队中"；2) 消息流外层套边框容器太丑；3) 完成后正文是原始 markdown 源码（pre 纯文本），与过程中的渲染效果不一致。
- 根因与修复：
  - **状态回退 bug（forge-core）**：pi-subagents 实际事件序为 started（spawn 内部）先于 created（工具处理器后补），`SubagentService.applyEvent` 原本允许活跃态任意互转，迟到的 created(queued) 把 running 拉回 queued → 全程误显"排队中"。修复：活跃态只前进不回退（running→queued 回退忽略），新增 U-SA-010 单测。
  - **占位与外框（forge-ui）**：删除占位文案块与 `.srv-stream` 边框容器；改为底部无边框"正在思考…/正在输出…"指示（与主会话一致），消息流直接排版。
  - **终态一致性（forge-ui）**：终态不再切换视图——同一条消息流保留（末条 assistant 正文即 result），指示消失、附 Token 用量；无过程数据时 completed 兜底用 result 全文同源 markdown 渲染。补终态切换时的 tail 补拉（watch isActive），否则完成瞬间拿不到含 result 的完整尾部。
- **尾部悬挂围栏清理（v3.15 追加，用户实测反馈）**：子 agent 嵌套代码块时常把围栏写不配平，渲染成空代码块框或把收尾语套进代码框。`subagentStream.ts` 新增 `stripDanglingFence`（CommonMark 语义模拟开合；消息以未闭合围栏收尾时丢弃该行围栏，其后内容转普通文本），消息流 flush 与 result 兜底路径共用；配平围栏不受影响。
- **工具折叠分组（v3.15 追加，用户实测反馈）**：子 agent 连续工具摘要行刷屏（截图一长串 grep/bash）观感复杂。对齐主会话 tool-group 交互：`subagentStream.ts` 新增 `groupStreamNodes`（连续 ≥2 工具聚组，纯函数），视图渲染折叠头（"工具调用 N 次"+工具名×次数 chips，默认收起，点击展开），单工具行不分组。
- 测试：forge-core 310（+1）、forge-ui 58（+3）全过；subagent e2e 11/11（SUB-E2E-005/011 断言改为新视图语义，mock 终态末条正文=result、双工具连发触发分组，对齐真实链路）；vue-tsc 通过。
- 文档同步：PRD 06 SA-F04 业务规则/AC-SA-013/025/026 改版；docs/test/06_subagent E-SA-010 重写、U-SA-010 新增、coverage-matrix 同步。

## v3.14 (子 agent 实时过程改为可读消息流)

- 用户反馈：切到子 agent 后"实时过程"区显示原始 JSON 协议流与命令输出（如 grep 结果、{"type":"toolResult",...}），用户看不懂；期望与主会话一致看渲染后的文字，大概了解子 agent 在干什么。
- 根因（`SubagentResultView.vue`）：把 `subagent/queryOutput` 返回的输出文件尾部当纯文本 `<pre>` 渲染。该文件是 pi-subagents 写的 JSONL（type=user/assistant/toolResult 条目），内容是 SDK 协议对象而非给人看的过程；主会话的渲染链路（pushDelta→renderMarkdown）与它完全不相通。
- 修复：
  - forge-ui 新增 `utils/subagentStream.ts`：把输出文件尾部按 JSONL 行解析成时间线——assistant 文本块 → markdown 正文条目；toolCall/toolResult → 工具摘要行（工具名+参数预览+running/ok/error，按 toolCallId 配对，切断时从 result 合成）；thinking/user 条目与解析失败行（尾部切断首行残片）静默跳过。
  - `SubagentResultView.vue`：运行中正文改为消息流渲染（renderMarkdown 与主会话同源 + 工具摘要行 + 自动滚动）；删除终态"执行过程"折叠面板与文件大小显示（终态直接看 result 正文）。
  - `mock-bridge.ts` queryOutput 改返回真实 JSONL 格式（运行中按 startedAt 逐步推进，不含末条终态正文）。
- 测试：新增 `test/subagentStream.test.ts`（6 用例）；E2E SUB-E2E-011 重写为消息流断言，subagent 套件 11 用例全过；vue-tsc 通过。
- 文档同步：PRD 06 SA-F04 业务规则与 AC-SA-025/026 改版；docs/test/06_subagent 补 E-SA-010（e2e.md）、U-SA-009（unit.md）、coverage-matrix 两行。

## v3.13 (运行中会话状态点选中态一致性)

- 用户反馈：会话运行中时选中该会话，会话树的状态点（黄点/脉动）不显示；移开（切到其他会话）后状态点才出现。状态可见性与选中态耦合，同一会话表现不一致。
- 根因（`ProjectTree.vue` `shouldShowDot`）：函数首位写死 `currentId === s.sessionId return false`——把"选中高亮"与"状态点"绑在一起，隐含假设高亮已携带状态信息。实际上高亮只表达选中、不表达状态；运行中/出错的状态点必须独立可见，否则用户看不到会话在跑。
- 修复：删除该特判，`shouldShowDot` 不再依赖 `currentSessionId`。done 状态的「查看后隐藏绿点」语义仍由 `doneReadSessions` + `selectSession` / `streaming→done` watcher 兜底，与选中态无关。
- 验证：UI e2e 新增 SESSION-E2E-002b（选中 running 会话→状态点存在；切走→状态点仍存在），全量 47 用例通过；`vue-tsc` typecheck 通过。
- 文档同步：`docs/test/02_session/coverage-matrix.md` 新增 E-SM-002b（AC-SM-010 正交一致性回归）。

## v3.12 (草稿态思考级别切换器：新建会话即可见可选，级别随会话创建写入)

- 用户反馈：新建会话时输入框模型选择旁无思考级别切换器，发送首条消息后才出现。
- 根因（`InstructionInput.vue`）：`loadThinkingState` 要求 `sessionId` 与 `currentModel` 同时存在，草稿态（新会话未创建）无 sessionId → 切换器隐藏。而级别列表只依赖模型（`model/getModelThinkingLevels` 不需要会话），草稿的生效模型（全局默认）是可用的。
- 修复：
  - `forge-core`：`model/getSessionThinkingLevel` 的 `sessionId` 改为可选（`modelService.getSessionThinkingLevel(sessionId: string | null)`；RPC 层缺省时传 null）——缺省直接查全局默认（`effective: "global"`），供草稿态回显「新会话将继承的级别」；显式空串/非法值仍 1001，未知会话仍 1002。
  - `forge-ui`：`loadThinkingState` 拆分守卫——级别列表仅需 `currentModel`；级别回显草稿态传空参查全局默认，有会话则查会话。
  - 草稿态所选级别不丢失：`selectLevel` 在草稿态仅本地记录（原逻辑），`ConversationView.onSend` 草稿分支创建会话后、`session-created` 事件前先 `setSessionThinkingLevel` 落库（与既有 draftModel 写入对称）——保证首条消息按输入框所示级别发送，且先写后 emit 避免与输入框对 sid 的级别查询竞态。`InstructionInput` 经 `defineExpose` 暴露 `currentLevel`。
- 测试：core 新增 `sessionId=null` 查全局默认（service 层）与 `{}` 缺省 sessionId（RPC 层，含空串 1001）用例；E2E TLEVEL-E2E-002 草稿态断言改为「切换器可见 + 回显全局默认 + flush 调用断言」，种子 `getModelThinkingLevels` 对未列入映射的已配模型回退推理级别（修 boot 期 queryModels 未 seed 的全局默认模型无级别问题）。全量：core 311、desktop 141、UI e2e 46 全过；core/desktop/UI typecheck 通过。
- 文档同步：`docs/api/05_model.md` §9 sessionId 改可选；`docs/test/05_model/coverage-matrix.md` A-MP-013 补草稿态用例、E-MP-007 操作/断言同步。

## v3.11 (消息正文块间距统一：修复 pre-wrap 把 markdown 标签间换行渲染成隐形空行)

- 用户需求：对话正文的行距/块间距忽宽忽窄（截图反馈：段落↔标题、列表项、文字卡↔工具条间隙不一致）。
- 根因（无头 Chromium + 真实 renderMarkdown 实测复现，脚本 `prototypes/spacing-repro/`）：`MessageCard.vue` 的 `.msg-content` 带 `white-space: pre-wrap`（本为用户消息纯文本保留换行），但 assistant 消息走 marked 渲染，输出的 HTML 标签间带 `\n`（`</p>\n<h2>`、`</li>\n<li>`、结尾 `\n`），pre-wrap 把这些排版换行渲染成 ~21px 隐形空行：块间 6px 外边距被撑到 25~27px、列表项间 10px（ul 的 `line-height:10px` 压小了空行）、消息尾部多 27px；文字卡↔工具条视觉间隙 45px vs 18px 不对称。
- 修复（均在 `MessageCard.vue`）：① `pre-wrap` 只作用于纯文本消息（user/system/tool），markdown 消息用 normal（breaks:true 已把段内换行转 `<br>`，段内换行不受影响）；② 删除 ul/ol 的 `line-height:10px` 与 `margin-block-end:4px` 覆盖；③ 标题 `margin-block-start:18px`（首块除外，外边距塌陷后标题上方实际 18px）；④ 首块无顶边距、末块无底边距（消息内部不拖空隙）；⑤ 密度校准：基础块间距 6px→**12px**（修复 bug 后用户反馈历史消息过密：同条消息 1077px→614px，密度近翻倍；用会话 JSONL 里的真实历史消息实测后定 12px 档，代码块/表格 margin 同步 12px）。
- 修复后实测（含代码块/表格全场景）：块间 12px / 标题上 18px / 列表项 0（行距即行高）/ 尾部 0px / 文字卡↔工具条上下均 18px 对称；历史消息总高 1077→714px。
- 验证：forge-ui + forge-core 310 测试全过，`vue-tsc` typecheck 通过；复现/验证脚本在 `prototypes/spacing-repro/`（`repro.mjs` 根因对比、`compare-styles.mjs` 三档密度对比+截图、`verify-final.mjs` 终版全场景）。

## v3.10 (图片展示优化：输入框纯缩略图 + 对话框正方形图 + 弹窗看原图)

- 用户需求：①输入框图片附件不再「缩略图+文件名」胶囊，只留固定缩略图；②消息图片固定正方形；③点击放大改为全屏弹窗看原图（取消原气泡内 zoomed class 放大缩小），弹窗支持滚轮缩放。
- 新增共用组件 `ImageLightbox.vue`：全屏遮罩 + 居中原图（初始 fit 屏幕内），滚轮缩放 1x~8x（以光标位置为中心，缩回 1x 自动复位居中），Esc / 点击遮罩关闭；单窗口/多窗口共用（经 MessageCard）。
- `MessageCard.vue`：消息图片改 120px 正方形缩略图（object-fit: cover，多图横排 wrap），点击开弹窗；删除原 `zoomedImage`/`toggleZoom` 气泡内放大逻辑。
- `InstructionInput.vue`：图片附件改 64px 正方形缩略图卡片（无文件名，hover 右上角浮 × 移除），点击开弹窗预览；文本等其他附件胶囊 chip（icon+文件名）保持不变。
- 验证：forge-ui `vue-tsc` typecheck 通过。

## v3.9 (CV-S07 上下文压缩：自动压缩可感知 + 手动压缩反馈修复)

- 背景：检查上下文压缩功能时发现链路「通但不可用」——单测全绿却未覆盖压缩的真实行为。
- **修复 1（P0，dev 预览直接报错）**：`mock-bridge.ts` 未实现 `conversation/compact`，落 default 返回 `data:null`，UI 侧对 null 取值抛 TypeError。补齐该分支，返回与真实链路同构的 `{result:{ok,tokensBefore,tokensAfter,summary}}`，并让 mock 用量压缩后按 40% 回落。
- **修复 2（P1，自动压缩完全静默）**：`piConversationAdapter.handleEvent` 只处理 message/tool/agent 事件，**不处理 compaction_start/compaction_end**——而运行时自动压缩（阈值/溢出触发）只能靠这两个事件感知。新增 `conversation.compacted` 事件（reason 归一为 manual/auto + 前后 token + 摘要），经 `createForgeCore` 转发到 eventBus；UI 订阅后重拉 `conversation/queryHistory` 并显示提示条（压缩会把 transcript 替换为摘要，不重拉则界面与真实上下文不一致）。自动压缩失败改走 `conversation.error` 上报，绝不静默。
- **修复 3（P2，静默截断当前轮）**：压缩按钮此前仅在「压缩中」禁用，流式期间仍可点，而运行时 `compact()` 会先 `abort` 当前轮。改为 streaming 期间一并禁用并给出「回答生成中，暂不支持压缩」。
- **修复 4（P3，结果与详情丢失）**：`compactResult` 只在 script 赋值、**模板从未渲染**，压缩成功/失败在界面上毫无反馈；且适配层取 `result?.message`，而 pi `CompactionResult` 并无 message 字段，压缩前后 token 变化被丢弃。现渲染结果提示（成功显示「压缩完成：90000 → 12000 tokens」，失败显示原因原文），并从 `tokensBefore/estimatedTokensAfter/summary` 透传详情。
- 契约：新增 `conversation.compacted` 事件（`ipc-contract.ts` / `bridge.ts` 同步）；core 新增 `CompactReason` / `ConversationCompactResult` / `ConversationCompactedPayload` 并从 index 导出；`ConversationApi.emitCompacted`。
- 测试（TDD，先 RED 后 GREEN）：适配器层 6 例（自动/手动/失败/中止/详情/异常），集成层 4 例（自动压缩事件、自动压缩失败上报、compact 详情透传、会话不存在 1002），E2E 5 例（mock 默认实现可用、详情展示、失败不静默、流式禁用、自动压缩重拉历史并提示）。全量：core 305、desktop 139、UI e2e 46 全过；core/desktop/UI typecheck 通过。
- 注意：`npm test` 的裸 `node --test` 匹配不到 `.ts`（实跑 0 用例），需用 `node --experimental-strip-types --test "test/**/*.test.ts"`；desktop 测试依赖 `@forge/core` 的 dist，改 core 后须 `npm run build` 才生效。
- 文档同步：PRD 03 新增 CV-S07 场景与 AC-CV-020~024；API 03 补齐查询历史/上下文用量/手动压缩三节与 `conversation.compacted` 事件；`test/03_conversation` 覆盖矩阵与 e2e 新增 E-CV-012/013、U-CV-009/010、A-CV-008~010。

## v3.8 (真实验收状态更新 + forge v1.1 计划草案)

- 验收状态（2026-08-30 用户确认）：真实 provider 内测基本通过（真实对话可正常进行）；PIC-005（思考级别真实链路 + 1M 上下文运行时）、PIC-006（子 agent 真实事件链路）确认 OK。`pi-integration-status.md` 关键风险 1 标记解除，`overview.md` §8 风险项同步；E-SM-001/002 已修复（全量 e2e 41/41 通过，已实测复核）。
- 新增 `plan/forge-v1.1-plan.md`（草案 v2 待确认）：主线 = forge-desktop 桌面壳补全（D-01 单例锁 / D-02 安装器 / D-03 自动更新 / D-04 托盘 / D-05 系统通知 / D-06 健壮性杂项）+ **SQ 发送队列专项**；质量收尾 Q-01 损坏 session 样本 / Q-02 多会话真实并发 / Q-03 CI。
- **F-04（per-tool 审批扩展）、F-05（嵌入式终端）搁置**（2026-08-30 用户指示）；F-07 维持搁置；F-02 子 agent 逐 token / F-03 多窗口时间线 / F-06 子 agent 左树列为 M3 候选。
- **发送队列对标 ai-coding**（`backend/internal/sendqueue` ~440 行 + SendQueuePanel + 4 e2e）：队列状态机（pending/sending/cancelled + dispatch_failed 回退）、5 类 queue.* 事件、4 个 API、turn 完成尾部 auto-dequeue（forceDirect 防死循环）、异常 CancelAll/超时保留、立即发送 interrupt 路径、前端分流（busy→入队）+ 面板 + sending 才上屏时序。结论：forge 可实现 ~90%（单引擎裁掉 capabilities 探测与 runtime 快照；附件队列化是小增量），无需改 pi。现状：forge streaming 中发送返回 1001 拒绝。
- 建议里程碑 M1 桌面壳可用 → M2 发布链路 + 队列 → M3 收尾。待确认点：安装器方案、签名证书/更新源、SQ 范围裁定（立即发送/error 保留/附件上限）、M3 择项、CI 立项。

## v3.7 (CV-S06 时间线波浪衰减 + 定位贴底不退出回看)

- 用户反馈：不只是选中突出——悬停条**周边**要有平滑的波浪衰减（附 ZCode 截图：波峰周围的横条按距离递减伸长）。
- 实现（TDD，E-CV-007b 扩为波浪断言先 RED 后 GREEN）：悬停时以悬停条为中心输出宽度波包（22/18/15/13→12px，按**条目序数**距离衰减——修复了按消息索引算距离导致相邻条目被隔空压缩的问题）；回看选中条目以较低波包（18/15/13）带动邻居；width 200ms 过渡使指针扫过时波包平滑流动。
- **行为修复（AC-CV-016 接线细化）**：定位滚动结束若贴近滚动底部（目标靠后的条目被钳制在底部附近，实测距底 4px），原有"触底退出回看"会立即把回看态退出、选中突出丢失——新增 800ms 定位触底抑制窗口（`LOCATE_NEAR_BOTTOM_SUPPRESS_MS`）：程序化定位 ≠ 手动滚到底，窗口内触底信号不退出；真实手动触底与"回到底部"点击行为不变。
- 测试：E-CV-007b（波峰/一阶/二阶衰减单调、左右对称、选中保持、贴底不退出）RED→GREEN；全量 e2e 40/40、单测 50/50 通过。
- 文档同步：PRD CV-S06 交互与反馈（波浪衰减）、`test/03_conversation/e2e.md` E-CV-007b。
- 备注：本轮末期 typecheck 出现 3 个错误，均位于用户**并发编辑中**的子 Agent 输出查看 WIP（SubagentResultView 的 `subagent/queryOutput` 未注册进 ForgeMethod 等），与本模块改动无关，未代为修改。

## v3.6 (CV-S06 时间线动画修正为 ZCode 悬停伸长风格)

- 用户反馈：上一版"独立指示条滑动"理解偏了——ZCode 的效果是**悬停时横条自身平滑伸长**（指针扫过时"最长的那根"随之流动），点击选中后该条保持加长。
- 实现（TDD，重写 E-CV-007b 先 RED 后 GREEN）：移除独立指示条元素；横条自身 width 过渡（200ms cubic-bezier）承担动画——默认 12px、hover 22px（颜色同步提亮）、回看选中 18px brand 色常驻、定位闪烁 22px brand。
- **根因修复（隐藏 bug）**：横条是按钮（flex，内容宽 12px）的子项，`flex-shrink:1` 把任何 >12px 的宽度压回 12px——**此前 hover 伸长从未真正生效**；加 `flex:none` 并将 Rail 内容区预留伸长空间（宽 28px、左右 padding 3px，`overflow-x:hidden` 不再裁切伸长段）。
- 测试：E-CV-007b 断言改为悬停伸长（>20px）/移开复位/选中保持（>14px + brand 色）/无 thumb 元素；全量 e2e 40/40、单测 50/50、typecheck 通过；hover 态截图 `e2e-report/E-CV-007b-hover-style.png`（伸长条+浮窗，与 ZCode 参考一致）。
- 文档同步：PRD CV-S06 交互与反馈（悬停伸长描述）、`test/03_conversation/e2e.md` E-CV-007b。

## v3.5 (CV-S06 时间线视觉细化：纵向居中 + 选中滑动指示条)

- 用户反馈：风格已接近 ZCode，但需①横条列垂直居中（少量条目时不堆顶部）②滑动横条动画③选中的更长。
- 实现（TDD，新增 E-CV-007b 先 RED 后 GREEN）：Rail `justify-content: safe center`（溢出回退顶部保持可滚动）；新增 18px brand 色滑动指示条（`v-if` 回看态渲染、`top` 260ms cubic-bezier 平滑滑动、首次出现无动画直接就位后淡入——避免从顶部滑入；普通横条 12px 保持不变）。条目 offsetTop 经 ref 登记测量，指示条随内容滚动。
- 排障记录：E-CV-007 曾因**长期复用的 vite dev server（端口 51731）多轮 HMR 后 scoped 样式注入失效**而整块样式不生效（rail 120px、bar inline），重启 dev server 后恢复——与代码无关，测试基建注意项。
- 测试：全量 e2e 40/40（新增 E-CV-007b：居中偏差 ≤30px、指示条宽度>14px、目标对齐 ≤8px、transitionDuration>0）、单测 50/50、typecheck 通过。
- 文档同步：PRD CV-S06 交互与反馈（居中+滑动指示条）、`test/03_conversation/e2e.md`（新增 E-CV-007b + 汇总行）。

## v3.4 (CV-S06 时间线样式简化：横条标记替代文本行，去除分隔竖线)

- 用户反馈：时间线条目应为简化横条/圆点，而非文本行；Rail 与消息区之间的竖线切割感重。
- 实现（TDD，E-CV-007 断言先行 RED→GREEN）：`ConversationTimelineRail.vue` 条目改为 12×3 圆角短横条（不展示文本，截断文本保留在原生 title 提示；hover 加长变品牌色、定位闪烁/回看目标加宽高亮）；Rail 移除 `border-right` 分隔边框、背景透明、宽度 32→24px，融入消息区。交互语义不变（hover 300ms 浮窗、点击定位、高亮态、testid 不变），纯函数与单测零改动（50/50）。
- 测试：E-CV-007 断言改为横条几何（宽>8px、高≤6px）、textContent 为空 + title 承载截断文本、条目 y 正序、Rail borderRight=0；全量 e2e 39/39、typecheck 通过。
- 文档同步（用户裁定的样式修订）：PRD 03 CV-S06 业务规则与 AC-CV-014、`test/03_conversation/coverage-matrix.md`（AC-CV-014/E-CV-007 行）、`test/03_conversation/e2e.md`（E-CV-007 断言）中"条目文本单行截断"改为"简化短横条标记"。

## v3.3 (CV-S06 会话历史导航开发交付：dev-flow run 20260829155926 COMPLETE)

- 交付范围：模块 03 扩展 CV-S06（AC-CV-014~019），纯前端 forge-ui，forge-core/forge-desktop 零改动。3 个 WU 串行链全部通过 D4 验证 + D5 Fan-in + D6 模块 QA PASS。
- 实现结构：
  - 纯函数（零运行时依赖，node --test 直跑 TS）：`src/utils/conversationTimeline.ts`（buildTimelineEntries 时间线条目 40 码点、buildRoundSnapshot 轮次快照 120/200 码点截断、Array.from 码点截断无半代理对、畸形输入按空处理）、`src/utils/popoverPosition.ts`（solvePopoverPosition 右弹/翻左/垂直夹取/极窄收拢，输出恒在视口内）、`src/utils/reviewMode.ts`（browse↔review 状态机：enter 定位、exit/nearBottom 恰好一次退出、autoFollow 结构性门控、reset 会话重置）。
  - 组件：`ConversationTimelineRail.vue`（32px 左缘时间线、空态不渲染、300ms hover 延迟 emit、点击 select、定位闪烁高亮）、`ConversationHistoryPopover.vue`（320px/40vh/纯文本插值无 v-html/150ms 过渡/等待回复与运行中提示态）、`ConversationView.vue` 集成（Rail+浮窗+定位滚动 scrollIntoView+1.5s 高亮、8 处 scrollToBottom 全部经 autoFollow 门控、底部"回到底部"提示条 review 态渲染、120ms 去抖触底退出、会话切换 reset、loadHistory 数组拷贝隔离 mock 引用污染）。
  - 基建：forge-ui package.json 补 `"test": "node --test"`（先例 forge-core/desktop）。
- 测试证据：单测 50/50（22 快照/16 定位/12 状态机，RED→GREEN 全记录）；Playwright 全量回归 39/39（新增 10 条：E-CV-007/008×3/009/010×2/011）+ vite build 通过；QA Agent 独立复跑证实（50 unit + 8 新 e2e + 39 全量 + typecheck 零错误 + 无 v-html/XSS 面 + write_scope 无越界）。证据：`docs/plan/results/`（任务包/结果/验证）、`docs/plan/review-qa/module-qa-20260829155926.json`、`packages/forge-ui/e2e-report/E-CV-0*.png`（10 张截图）、flow state `docs/plan/dev-20260829155926-flow.json`（D8 COMPLETE）。
- 已知语义（非缺陷）：浮窗 Esc 关闭后指针未移开时需重新 hover 才再现（无新 mouseenter 不触发）；触底判定含 120ms 停稳去抖（smooth 滚动途中路过底部不误退）；定位高亮 class 用 ConversationView 内非 scoped 全局命名空间样式块（目标元素在孙组件 fragment 内，仅限该类名影响面）。

## v3.2 (模块 03 扩展 CV-S06 会话历史导航已确认；独立模块 07 方案撤销)

- 背景：用户需求「增加一个这种左侧的用户会话历史，点击可以定位，然后可以看到历史的对话浮窗」（附 ZCode 客户端参考图）。初稿曾按独立模块 07（左侧跨项目历史列表方案）起草；**用户裁定：不单独设模块，并入主会话（对话区）一侧**，07 的 PRD/测试设计文件与全部登记已撤销（`prd/07_session_history.md`、`test/07_session_history/` 删除，index/overview/artifacts 回退）。
- 扩展设计（并入 PRD 03，已确认）：**会话内提问时间线**——对话区左缘按时间正序列出当前会话全部用户消息（单行截断）；hover ≥300ms 弹浮窗预览该轮对话（用户消息 120 码点 + 助手回复 200 码点纯文本截断快照，流式中为快照不实时刷新，Esc/移开即关）；点击定位到该消息并进入**回看模式**（流式不强制滚底 + 底部"回到底部"提示，触底/点击恢复，TD-CV-06）。数据为已加载消息流纯派生：零新增接口、零新增存储（TD-CV-05）。范围限定主会话消息流（子 agent 结果视图不渲染，画布小窗后续）。
- 登记：`prd/03_conversation.md`（场景 CV-S06、TD-CV-05/06、功能点 CV-S06、AC-CV-014~019、页面承载、自检——扩展 6 项 PASS）；`test/03_conversation/coverage-matrix.md`（扩展基线 6 AC + unit U-CV-006~008 + e2e E-CV-007~011 行）；`test/03_conversation/e2e.md`（E-CV-007~011 详设 + 汇总行）；`prd/index.md`、`overview.md`（03 行扩展标记 + MVP 范围 + 当前状态）、`test/index.md`（03 行）。扩展为纯前端派生视图，无 API/DB 增量文档。
- 确认（2026-08-29）：用户确认扩展章节；PRD 03 与测试设计 03（含扩展 CV-S06）全部转「已确认」，`prd/index.md`、`overview.md`（03 行 + MVP 范围 + 当前状态）、`test/index.md` 同步；artifacts 03 各项维持 approved（verification/api/test-e2e 为既有文件，已覆盖扩展内容，无新增登记）。下一步可调 `dev` 开发（建议拆 WU：时间线组件与派生纯函数 / 浮窗交互 / 定位与回看模式）。

## v3.1 (PRD 06 配套 API 文档与测试设计)

- API（`api/06_subagent.md` 新增，`api/index.md` 登记）：方法 `subagent/queryList` / `subagent/stop` / `subagent/clearFinished`；事件 `subagent.updated`（完整记录幂等 upsert）/ `subagent.removed`；跨模块语义扩展 `conversation/cancelStream`（级联终止全部活跃子 agent）与 `conversation.statusChanged`（done 判据 = 主轮结束且活跃计数为 0，30 分钟兜底）；Subagent 业务对象与状态机定义；扩展缺失走非错误路径（空列表/1002）。
- 测试设计（`test/06_subagent/` 新增 coverage-matrix.md + unit.md + e2e.md）：24 条 AC 全映射（U-SA-001~007 状态机/门控/兜底/级联/隔离清理；E-SA-001~009 mock 事件序列驱动 UI 用例）；`test/integration/pi-core.md` 新增 PIC-006（真实 pi + pi-subagents 事件链路，不得全 mock）；`test/index.md` 登记（模块 06 功能点 8/8、P0/P1 100%，3 项风险维度不适用有据）。

## v3.0 (新增 PRD 06 子 Agent 管理并确认；footer 轮次分组修复)

- PRD 06（`prd/06_subagent_management.md`）从无到有并确认：背景为派生后台子 agent 后主会话误判"已完成"且完全不可见。范围：SA-F01 事件接入（pi.events 共享事件总线，TD-SA-01）、SA-F02 主会话状态联动（done = 主 agent 本轮结束且活跃子 agent 计数为 0，30 分钟超时兜底，TD-SA-02）、SA-F03 Tab 栏（输入框上方，主会话+子 agent Tab，参照 ai-coding 模式，TD-SA-04）、SA-F04 结果视图（状态/实时耗时/result 全文/Token，v-show 切换）、SA-F05 停止按钮级联终止（主 agent 本轮+全部活跃子 agent，TD-SA-03）、SA-F06 单个终止（二次确认）、SA-F07 运行期内存态按会话隔离+重启不恢复（TD-SA-05）、SA-F08 扩展缺失静默降级（TD-SA-06）。24 条 AC（AC-SA-001~024）。明确不做：spawn、左树"子 Agent (N)"分组（用户裁定 v1 不加）、子 agent 逐 token 实时查看。`prd/index.md`、`overview.md`（模块表/MVP 范围）同步更新。
- UI 修复：一次 AI 回复被工具调用拆成多张 assistant 卡片时复制按钮+时间戳重复出现。新增 `forge-ui/src/composables/useTurnFooter.ts` 轮次分组（以 user 消息为界，仅末卡显示 footer，复制内容为整轮文本）；MessageCard 增加 showFooter/copyText；ConversationView 与 MultiWindowConversation 同步接入；新增 e2e `footerTurn.spec.ts`（E-CV-FOOTER-001），全套 21/21 通过。

## v2.9 (桌面应用打包：免安装 forge.exe 手动组装流程)

- 实现范围：新增 `scripts/package.mjs`（一条命令出免安装包）与 `scripts/collect-prod-deps.mjs`（production 依赖扁平收集）。背景：electron-builder 在 npm workspaces + pi 生态大 node_modules 上依赖扫描卡死（"searching for node modules" 无进展），改为确定性手动组装：构建 workspaces → 收集 @forge/core/pi-ai/pi-coding-agent production 依赖（136 包，Dereference 穿透 workspace symlink）→ 组装 `release/`（forge.exe + resources/app）→ 拷贝 Electron 运行时。
- 产物布局：`release/forge.exe` 双击即用；主进程 `resources/app/{package.json,dist/,node_modules/}`；UI 在 `resources/forge-ui/dist/`（对齐 `src/main.ts` 生产路径 `../../forge-ui/dist/index.html`）。
- 生效方式：`node scripts/package.mjs` 重新打包，产物在 `release/`，已 .gitignore；运行用 data 目录不变（forge-store.json 照常落盘）。
- 验证：全链路冒烟通过——主进程稳定（多进程存活）、`forge-store.json` 落盘、CDP 确认 UI 渲染（FORGE/项目树/设置等，58 DOM 节点）。
- 文档同步：`scripts/package.mjs` 头部注释（背景/布局/用法）；changelog 本条。

## v2.8 (项目拖拽排序：会话树项目按优先级钉扎)

- 实现范围：
  - forge-core：`ProjectRecord` 新增 `priority`（number | null，null=未钉扎）；store `listProjects` 排序改为 priority 升序优先、未钉扎按最近打开倒序排其后；新增 `reorderProjects(paths)` 全量重排（按顺序写 priority=0..n-1 一次落盘，含未注册路径返回 1003 不写盘）；`projectService.reorderProjects`（非法 1001 / 未注册 1002）；RPC 新增 `project/reorderProjects`（requireArray 校验 paths 非空字符串数组）。
  - forge-desktop：ipc-contract 新增 `project/reorderProjects`。
  - forge-ui：ProjectTree 项目节点拖拽排序（指针在目标节点上半部插入其前、下半部其后，容器空白处放下排末尾），发射 `reorder-project` 全量新顺序；修复会话拖拽冒泡触发项目拖拽的隐患（onSessionDragStart 阻止传播）；App 接管 `reorder-project` 调 RPC 并刷新列表。
- 生效方式：拖拽项目排序立即持久化（写 forge-store.json priority），刷新/重启保持；首次拖拽后项目全部钉扎，打开项目不再重排列表；之后新增项目保持未钉扎（排钉扎之后）。
- 测试：forge-core 新增 7 例（store 重排/持久化/未注册不写盘/钉扎优先排序、service 校验透传、rpc 参数与合法重排），全套 267 绿；forge-desktop 107 绿；typecheck 全绿。
- 文档同步：`prd/01_project_management.md`（PM-S01 排序规则 + AC-PM-012）、`api/01_project.md`（queryProjectList 排序说明 + 新增 project/reorderProjects 章节）、`db/forge-store/schema.md`（project.priority 字段 + 索引/设计说明）、`test/01_project/coverage-matrix.md`（AC-PM-012、U-PM-004/005、A-PM-008）。

## v2.7 (火山方舟自动兼容：保存 provider 时按地址自动补 compat)

- 实现范围：
  - forge-desktop：piModelsFileAdapter `writeProviders` 按 `baseUrl` 判定火山方舟地址（域名含 `volces.com`），自动为缺 `compat` 的模型记录补默认兼容块（`thinkingFormat: deepseek` / `supportsDeveloperRole: false` / `maxTokensField: max_tokens` / `requiresReasoningContentOnAssistantMessages: true`）；已有手配 `compat` 保留不覆盖，非火山地址不注入。
- 生效方式：保存火山地址 provider 后 models.json 模型记录出现默认 compat，pi 加载即按 DeepSeek 系协议请求；存量无 compat 的火山模型在下一次任何保存时自愈。
- 测试：forge-desktop 新增 2 例（火山注入 + 已有 compat 保留），相关回归 15 例全过，typecheck 全绿。
- 文档同步：`prd/05_model_provider.md`（MP-S01 业务规则 + AC-MP-028）、`api/05_model.md`（saveProvider 落盘附加行为）、`test/05_model/coverage-matrix.md`（AC-MP-028、U-MP-012/013）。

## v2.6 (思考等级配置：模型表单「思考强度」勾选 + 思考等级多选下拉)

- 实现范围：
  - forge-core：`saveProvider` 新增 `reasoning`（布尔校验）与 `thinkingLevels`（THINKING_LEVELS 内去重列表，null 移除）参数；新增导出 `THINKING_LEVELS`/`DEFAULT_THINKING_LEVELS`/`buildThinkingLevelMap`（全量 7 项显式 map：选中=级别名，未选=null，TD-MP-07）；`ProviderConfig` 回显 `reasoning` 与 `thinkingLevels`；RPC 解析层校验去重。
  - forge-desktop：piModelsFileAdapter 首模型 `reasoning` 写/移除、`thinkingLevels` 映射写 `thinkingLevelMap`（数组覆盖/ null 移除/缺省不触碰）；读侧按 pi `getSupportedThinkingLevels` 语义推导白名单回显。
  - forge-ui：设置页模型表单新增「思考强度」勾选 + 下方思考等级多选下拉（off 不参与配置、写 null 隐藏，对话框不出现「关闭思考」挡位；未勾选时禁用置灰、编辑回显按 pi 语义推导、触发器显示已选挡位）。
- 生效方式：保存写 models.json（reasoning/thinkingLevelMap）→ pi 重载 → 对话框思考级别切换器可选挡位按白名单变化。
- 测试：forge-core 259 例、forge-desktop 105 例（新增 buildThinkingLevelMap/service 校验透传/解析层去重/adapter 读写回显 7 例），typecheck 全绿。
- 文档同步：`prd/05_model_provider.md`（新增 MP-S07 场景/TD-MP-07/功能点/AC-MP-023~027）、`api/05_model.md`（provider.reasoning/thinkingLevels、saveProvider.reasoning/thinkingLevels）、`test/05_model/coverage-matrix.md`（AC-MP-023~027、代码后记 U/A/E-MP-009 等）。

## v2.5 (多模态图片支持：模型配置「支持图片输入」勾选 + 发送门控)

- 根因修复：MiniMax-M3 等多模态模型在 models.json 中未声明 `input` 能力时，pi 默认按纯文本处理，图片被降级为占位文本、模型回复"无法识别图片"。本版本提供配置 + 发送侧双保险。
- 实现范围：
  - forge-core：`saveProvider` 新增 `vision` 参数（布尔校验，缺省保留原值），`ProviderConfig` 回显 `vision`；`conversation/sendMessage` 新增多模态门控（注入 `modelSupportsImages` 端口，不支持图片时过滤图片附件、内容追加跳过说明、响应返回 `skippedImages`）。
  - forge-desktop：piModelsFileAdapter 首模型 `input: ["text","image"]` 写/移除/回显（与 contextWindow 同模式，undefined 不覆盖手工 input）；createForgeCore 注入 `modelSupportsImages`（`resolvePiModel(model).input.includes("image")`）。
  - forge-ui：设置页「支持图片输入（多模态）」勾选（编辑回显、列表「多模态」标签）；发送后气泡显示「图片未发送：当前模型不支持图片输入」标记（单/多窗口同步）。
- 生效方式：勾选保存触发模型运行时缓存刷新，立即生效无需重启。
- 测试：forge-core 248 例、forge-desktop 101 例（新增 vision 落盘/回显、能力门控 skippedImages 等），typecheck 全绿。
- 文档同步：`api/05_model.md`（provider.vision / saveProvider.vision）、`api/03_conversation.md`（sendMessage attachments/skippedImages）、05/03 coverage-matrix 新增 AC-MP-020~022、AC-CV-013。

## v2.4 (PRD 05 扩展开发完成：思考级别选择 + 上下文 1M)

- dev-flow run `20260827115957` 交付模块 05 扩展，6 个 WU 全部通过 D3/D4，D5 Fan-in、D6 模块 QA 终审 PASS（含一轮回流：MP-QA-G01 修复 + G03 证据闭合），dev-flow 返回 COMPLETE。
- 实现范围：
  - forge-core：ModelService 新增 `getModelThinkingLevels`/`getSessionThinkingLevel`/`setSessionThinkingLevel`（写会话+同步全局默认、null 清除覆盖、off 兜底），`SaveProviderInput`/`ProviderConfig` 增加 contextWindow 透传与回显；store settings 播种 `thinkingLevel='off'`；RPC 注册三新方法。
  - forge-desktop：piModelsFileAdapter 首模型 contextWindow 写/移除/回显；piModelResolver 消费 `@earendil-works/pi-ai` 官方 `getSupportedThinkingLevels`/`clampThinkingLevel`（TD-MP-04，新增依赖 pi-ai@0.84.3）；AgentSession.setThinkingLevel 应用（创建/发送/去重）；createForgeCore 注入 ThinkLevelsPort、resolveSendOptions 实时读取全局默认（修复 QA-G01 快照不一致）。
  - forge-ui：设置页「上下文窗口 1M」勾选（按勾选覆盖、编辑回显 ===1000000）；输入框模型选择旁思考级别切换器（仅 >1 显示/降级隐藏、会话隔离、无多余 toast）与 **max 金色流光动画**（纯 CSS conic-gradient+mask、rotate 合成器动画，实测 ≈61fps / ≈2.6s）。
- 测试：forge-core 240 例、forge-desktop 90 例、settings.spec 5、thinkingLevel.spec 4（含时长/帧率量化断言），typecheck 全绿。
- 已知待办：AC-MP-019 运行时「上下文按 1000000 计算」与思考级别持久化的真实 pi 集成验证需集成环境执行 PIC-005（docs/test/integration/pi-core.md，QA 接受为 documented limitation）。

## v2.3 (PRD 05 扩展：思考级别选择 + 上下文 1M)

- `prd/05_model_provider.md` 由"PRD 已确认"重新进入草稿并完成扩展确认：新增 MP-S05 思考级别选择（输入框模型选择旁切换器，按 pi `getSupportedThinkingLevels` 渲染可用级别，会话级 + 同步全局默认，非推理模型隐藏入口，切 max 触发金色流光动画）、MP-S06 上下文大小配置（表单「上下文窗口 1M」勾选，写 `contextWindow: 1000000`，取消移除字段）。
- 新增关键技术决策 TD-MP-04（能力来源 = pi SDK）、TD-MP-05（输入框切换 + 会话级 + 全局默认）、TD-MP-06（contextWindow=1000000，取消移除）。
- 新增验收 AC-MP-010~014（思考级别）与 AC-MP-015~019（上下文 1M）。
- 当前生效语义（已确认）：思考级别切换下一轮生效、不打断；正常切换无提示、切 max 输入框金色流光动画约 2-3s；上下文保存一律按勾选覆盖（非 1M 存量未勾选保存会移除字段）。
- 下游文档已同步：`db/forge-store/schema.md`（session.thinkingLevel、settings.thinkingLevel seed）、`api/05_model.md`（saveProvider.contextWindow、getModelThinkingLevels、get/setSessionThinkingLevel，错误码扩充）、`test/05_model/coverage-matrix.md`（AC-MP-010~019 + PIC-005 真实集成）、`test/integration/pi-core.md`（PIC-005）、`test/index.md`（05 覆盖率 6/6、17/17）、forge-core `types/forge-store.ts`（SessionRecord.thinkingLevel、StoreKey thinkingLevel）。
- 思考级别计划文档：`plan/think-20260827102000138-plan.md`。
- 文档状态：PRD/DB/API/测试均保持"已确认"（含扩展），`docs/artifacts.json` 状态不变（approved）。

## v2.2 (DB/API/测试设计三档确认)

- DB schema（`db/forge-store/schema.md` + `db/README.md`）、API 契约（`api/index.md` + 01~05）、测试设计（`test/index.md` + 5 模块 coverage-matrix + 02/03/04 e2e + 05 api + `test/integration/pi-core.md`）状态由"规划中"确认置为"已确认"。
- `docs/artifacts.json` 各模块与 per-artifact 状态同步为 `approved`。
- `overview.md` §5 配套设计文档、§8 当前状态同步：文档全部冻结，可进入 `dev` 开发阶段。

## v2.1 (测试设计改进 F1-F6)

- F1：`test/index.md` 修自洽缺口：必测场景口径定义 + “P0 断言 100% 自动覆盖，manual 仅补充”（纠正误标“P0 无 manual”）。
- F2：PRD 02 补多窗口 AC（AC-SM-017~020：8 区吸附/4 窗格/resize/窗口崩溃恢复），02 覆盖矩阵跟进。
- F3：展开 `test/02_session/e2e.md`（多窗口交互，按新 skill 前置/步骤/断言三要素）。
- F4：展开 `test/03_conversation/e2e.md`（流式 mock 时序/XSS）、`test/04_tool/e2e.md`（Diff fixtures/大文件）、`test/05_model/api.md`（keychain mock/models.json 断言）。
- F5/F6：新增 `test/integration/pi-core.md`——pi 事件→CanonicalEvent 映射完整性（PIC-001）、AgentSession 生命周期（PIC-002）、多 AgentSession 真实并发非 mock（PIC-003）、后端健康+契约（PIC-004）。补各矩阵把 pi 当 mock 之下的真实集成层（最大后端盲区）。
- 同步更新 `test/index.md` 模块展开文档列 + 新增跨模块集成入口。
- 关联：skill 加强（gen-doc-test-cases C1-C7）已落地，本批按新 contract 触发展开。

## v1.9 (下游文档审核修正)

审核其他模型生成的 db/api/test/artifacts，修正 3 处：
- **artifacts.json**：补登 `db`/`api` 产物声明（01/02/05 含 db，全 5 模块含 api）；改为 per-artifact 状态（`prd`=approved、`verification`/`api`/`db`=draft），纠正原 verification 误标 approved。
- **DB schema/README**：存储介质表述由"Electron userData 目录"改为"forge-desktop 传入的路径"（forge-core 纯 Node 不调 Electron API）；补并发选型理由（forge-core 单一写入中心串行化->JSON+原子写安全；SQLite 为后续升级路径，呼应决策 4 消除并发写者）。
- **API 01**：澄清 `openProject` 同步返回 `code=1005` 是 v1 信任询问主路径，`project.trustRequested` 事件为预留不依赖。

审核结论：其他模型文档质量高、正确采纳传输无关决策 4、数据归属正确、AC 覆盖完整，无原则性错误。

## v2.0 (gen-doc-all：DB/API/测试设计生成)

- 新增 `docs/db/forge-store/schema.md`：forge 自有存储设计（本地 JSON 文件，无传统数据库）。3 张表：project / session / settings；明确 forge-pi 数据边界（pi 会话、models.json、keychain 归 pi，forge 不重造）。
- 新增 `docs/db/README.md`：DB 索引。
- 新增 `docs/api/`：forge-core 传输无关接口契约（方法+事件，桌面 IPC v1 / headless v2+），index.md + 01 项目管理 / 02 会话 / 03 对话 / 04 工具 / 05 模型五个模块文档，统一响应格式 `{code,message,data}` 与错误码。
- 新增 `docs/test/`：5 个模块 coverage-matrix.md（unit/api/api/e2e 内嵌设计），功能点/风险维度/必测场景覆盖率见 `docs/test/index.md`。
- 新增 `docs/artifacts.json`：5 个模块 PRD + verification 登记（approved）。
- overview §5 增补配套设计文档导航；§8 状态更新为"DB/API/测试设计待确认"。
- 待确认：DB schema、API 契约、测试设计三者的"规划中 → 已确认"。确认后即可进入 `dev`。

## v1.9 (PRD 残留修正)

- 修正 `docs/overview.md` §7：MVP 范围"多窗口观察"中 **Aero Snap 吸附** -> **窗口吸附**（v1.6 已改术语，此处残留旧词）。
- 修正 `docs/prd/03_conversation.md` CV-S02 业务规则："pi 事件 -> CanonicalEvent -> SSE -> 前端" -> "-> 增量事件推送（桌面 IPC 事件 / headless SSE）"（v1.8 传输架构修正后桌面端走 IPC，此处仍残留 SSE；headless SSE 仅 v2+）。
- 修正 `docs/prd/02_session_management.md` 多窗口状态同步："SSE 流由 forge-core 统一管理" -> "会话输出流经 IPC 事件推送"（同上，对齐 v1.8）。

## v1.8 (架构决策修正 + PRD 次要修正)

**B. 传输架构修正（决策 4）**：forge-core 由"REST/SSE 服务层"改为**传输无关接口**（方法+事件）；桌面端走 **Electron IPC**、headless 走 **HTTP/SSE**（v2+）。原因：HTTP-in-Electron 有本地攻击面（同机其他进程可打端口借 AgentSession 执行任意操作）；IPC 只许自家渲染进程调用，堵死攻击面。功能不变、更安全、接缝更干净。涉及：`forge-v1-plan` 决策4、`overview` 原则6/技术栈/技术分层/风险、`PRD 03` TD-CV-01+1.4、`embedded-agent-discussion` §6。

**A. 三处次要修正**：
- PRD 01：project_trust 拦截注明"以 user/global 扩展形式（project-local 信任前未加载）、SDK 模式不走 ctx.ui、经 forge-core 桥接 Vue"。
- PRD 05：注明 forge 需自带跨 OS keychain 读取命令（`!forge-secret get <provider>`，macOS/Windows/Linux 适配）。
- PRD 02：跨项目会话池由 forge 自行遍历 `~/.pi/agent/sessions/` 解码 cwd 枚举（pi 无此 API）。

**风险项更新**：多 AgentSession 并发由"待 spike"改为"源码分析支持 + demo 已运行时验证 2 并发"。

## v1.7 (会议室概念存档)

- 新增 `plan/meeting-room-concept.md`：会议室（多模型互相审核）概念文档，含架构A（编排器+对等 AgentSession，非子agent）、3轮流程图、分阶段、demo 验证证据。
- demo 佐证：2 并发 AgentSession 运行时跑通（顺带验证 PRD 02 TD-SM-01）；真模型调用（minimax 官方站 + huoshan ARK）有 fetch 拦截 + request-id 证据。
- 会议室定位为 v2+ 候选（非 v1 MVP），待 v1 多会话能力落地后 Phase 1 顺手可做。
- 关联产物：`meeting-room-demo.mjs`（脚本）、`meeting-room-demo.html`（可视化）、`meeting-room-demo-output.md`（纪要）。

## v1.6 (PRD 审核修正)

- 多窗口正式纳入 MVP（用户决策，非常想要）。
- PRD 02 修正：明确视窗形态=**应用内画布**（单 BrowserWindow 模拟多窗口，非真 OS 窗口）；"Aero Snap" 改为 "窗口吸附"（自定义 snap，非 OS）；标注不支持跨屏（跨屏需改真 BrowserWindow，属重写）；标注多窗口为新开发、会话内部组件复用 ai-coding。
- PRD 02 TD-SM-01 补并发纪律（源码分析）：AgentSession 无全局单例、事件总线 per-loader、扩展实例 per-loader；纪律=每会话独立 ResourceLoader + forge 扩展不得用模块级可变状态。新增 SM-S04/SM-S05 解耦说明（多窗口 UI 不依赖并发，仅并行执行依赖）。印证 v1.2 风险降级判断。
- 新增 `plan/spike-multi-session.ts`：pi 多 AgentSession 并发运行时验证脚本（需先构建 pi；此环境缺 tsgo 未能跑，源码分析已支持结论）。
- 修正原型 `window-mode-mockup.html`：去掉方案A 跨屏错误声称；演示文本 `beforeToolCall` 改为正确的 `tool_call` 事件。
- 次要项待修（PRD 01/05）：project_trust 拦截细节（user/global 扩展+forge-core 桥接非 ctx.ui）、PRD 05 注明 forge 需自带跨 OS keychain 读取命令、PRD 02 跨项目会话池由 forge 自行遍历 sessions 目录。

## v1.5

- 模块 05 模型与 Provider 配置 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，14 项 PASS，0 WARN/FAIL）。
- 确认 3 项技术决策：密钥安全引用 !command/env（TD-MP-01）、全局默认+会话覆盖（TD-MP-02）、复用 pi models.json 不用 registerProvider（TD-MP-03）。
- 澄清：v1 forge 是 pi models.json 的可视化编辑器，扩展层 registerProvider 不在 v1 范围。
- 5 个 PRD 模块全部确认完成，进入 gen-doc-all 确认点 2。

## v1.4

- 模块 04 工具执行展示 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，14 项 PASS，0 WARN/FAIL）。
- 确认 3 项技术决策：并排 Diff（TD-TE-01）、长结果折叠（TD-TE-02）、对话流穿插（TD-TE-03）。

## v1.3

- 模块 03 对话与消息 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，17 项 PASS，0 WARN/FAIL）。
- 确认 4 项技术决策：流式增量传输（TD-CV-01）、Markdown 白名单安全渲染（TD-CV-02，防 XSS）、取消+保留已生成（TD-CV-03）、历史全量加载（TD-CV-04）。

## v1.2

- 模块 02 会话管理 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，18 项 PASS，0 WARN/FAIL）。
- 确认 5 项技术决策：多会话并行（TD-SM-01）、多窗口画布+Aero Snap（TD-SM-02）、跨项目会话池（TD-SM-03）、会话输出与窗口解耦+一会话一窗口（TD-SM-04）、硬删+二次确认（TD-SM-05）。
- 多会话并行风险降级：CLI 多进程已证明 pi 支持多 session，进程内多 AgentSession 仅需验证全局状态隔离，风险中低。

## v1.1

- 模块 01 项目管理 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，14 项 PASS，0 WARN/FAIL）。
- 作废 TD-PM-03「工作区模型」：项目仅为会话分类容器，非活动单元；会话执行模型与视窗模型移至模块 02。
- 新增 v1 需求：多窗口观察（多会话跨项目并排，Aero Snap 吸附 + 自由 resize + z-index 置顶），纳入 MVP 范围，归入模块 02 会话管理。
- 新增风险项：pi 多 AgentSession 并发可行性、pi 信任事件拦截可行性。
- 新增原型：`plan/window-mode-mockup.html`（多窗口形态对比 + 方案 A 交互验证）。

## v1.0 (初始化)

- 立项 forge：以 pi 为固定引擎的桌面项目工作台。
- 锁定架构决策：pi 进程内 SDK + Electron + 复用 ai-coding Vue + 业务=pi 扩展 + 权限/存储跟 pi 一致 + v1 MVP。
- 初始化 docs 目录（specs/templates/prd/db/api/test/plan/ui）。
- 新增 PRD 队列（5 个业务模块，均草稿-待确认）：项目管理、会话管理、对话与消息、工具执行展示、模型与 Provider 配置。
- 关联文档：`plan/forge-v1-plan.md`、`plan/embedded-agent-discussion.md`、`plan/think-1786004271124-plan.md`。
