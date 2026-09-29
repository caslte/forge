# 对话与消息 覆盖矩阵

> 模块：03 对话与消息
> 来源：PRD 03（docs/prd/03_conversation.md）
> 状态：已确认（含扩展 CV-S06 会话历史导航、CV-S08 斜杠命令、CV-S11 Todo 面板、CV-S12 ask_user_question 内嵌问卷）
> 层级映射：unit=纯渲染/校验逻辑；API=IPC 方法 + CanonicalEvent 流式事件契约；E2E=对话区 UI + 渲染；CV-S08 真实命令执行链路见 test/integration/pi-core.md PIC-007

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | 发送→流式响应→渲染→完成；历史加载 | P0 |
| 字段边界 | 适用 | 空消息验证；内容长度；硬截断逻辑 | P1 |
| 权限角色 | 适用 | 单用户；消息内容信任由 pi 处理 | P0 |
| 状态流转 | 适用 | idle→streaming→done/cancel/error；取消后恢复 idle | P0 |
| 异常失败 | 适用 | 流中断、provider 未配置、渲染错误、Mermaid 语法错误 | P1 |
| 数据一致性 | 适用 | 消息不重不丢；取消保留已生成 | P0 |
| 幂等重复 | 适用 | 重复 cancel 无副作用；重复打开历史一致 | P1 |
| 查询组合 | 不适用 | 历史全量加载，无分页/筛选 | - |
| 前端反馈 | 适用 | 输入框反馈、代码复制、Mermaid 错误提示、provider 引导 | P1 |
| 跨模块影响 | 适用 | 工具消息穿插（模块 04）；Markdown 渲染复用 | P0 |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| AC-CV-001 | CV-S01 发送消息 | 跨模块协作 | 正常流程：发送→流式响应 | P0 | - | A-CV-001 | E-CV-001 | 对话区显示消息，进入 streaming 状态 | |
| AC-CV-002 | CV-S01 发送消息 | 字段边界 | 正常流程：非空 | P1 | U-CV-001 | - | - | 空消息禁用发送 | unit 校验 |
| AC-CV-003 | CV-S01 发送消息 | 可用性 | 异常：provider 未配置 | P1 | - | A-CV-002 | E-CV-002 | 提示配置而非崩溃 | |
| AC-CV-004 | CV-S02 流式响应 | 性能 | 正常流程：长回复 | P0 | - | A-CV-003 | E-CV-001 | 增量渲染不卡顿；端到端延迟<100ms | 长文本性能 |
| AC-CV-005 | CV-S02 流式响应 | 状态/一致性 | 异常：流中断 | P1 | - | A-CV-004 | - | 保留已收内容，标记中断 | |
| AC-CV-006 | CV-S03 富文本渲染 | 功能 | 正常流程：markdown/代码/mermaid | P0 | U-CV-002 | - | E-CV-003 | 三种内容正确渲染 | |
| AC-CV-007 | CV-S03 富文本渲染 | 安全/XSS | 安全：恶意 HTML | P0 | U-CV-003 | - | E-CV-004 | script/onerror 被过滤不执行 | 白名单硬约束 |
| AC-CV-008 | CV-S03 富文本渲染 | 边界 | 异常：Mermaid 语法错误 | P1 | U-CV-004 | - | E-CV-003 | 显示错误提示+源码，不崩溃 | |
| AC-CV-009 | CV-S04 取消响应 | 状态/一致性 | 正常流程：取消保留已生成 | P0 | - | A-CV-005 | E-CV-002 | 停止响应，保留已生成内容 | 不可逆保留 |
| AC-CV-010 | CV-S04 取消响应 | 状态 | 正常流程：取消后恢复 | P1 | - | A-CV-005 | E-CV-002 | 取消后可以再次发送 | |
| AC-CV-011 | CV-S05 历史装载 | 一致性 | 正常流程：历史加载 | P0 | - | A-CV-006 | E-CV-005 | 全部历史被加载并正确渲染 | |
| AC-CV-012 | CV-S05 历史装载 | 一致性 | 正常流程：角色区分 | P1 | - | A-CV-006 | E-CV-005 | user/assistant/隔离区分 | |
| AC-CV-013 | CV-S01 发送消息（附件统一给路径） | 一致性 | 正常流程：附件随消息发送 | P1 | U-CV-005 | A-CV-007 | E-CV-006 | 附件以 @ 绝对路径行随正文发送（v3.27 协议标记，旧会话裸路径行兼容），内容由模型自行 read；非视觉模型遇图片由 pi-ai 传输层降级占位不报错；密钥嗅探命中需确认后才发送 | 统一机制降低复杂度 |

### 覆盖基线（扩展 CV-S06 会话历史导航）

> 扩展为纯前端派生视图：零新增接口（无 API ID），数据源为组件内已加载消息流（TD-CV-05）。

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| AC-CV-014 | CV-S06 时间线 | 展示正确性 | 正常流程：时间线展示与实时新增 | P0 | - | - | E-CV-007 | 左缘时间线正序列出全部用户消息；新消息条目实时出现；子 agent 结果视图不渲染 | 简化短横条标记（无文本，title 提示截断文本；无分隔边框） |
| AC-CV-015 | CV-S06 浮窗预览 | 前端反馈 | 正常流程：hover 浮窗快照 | P0 | U-CV-006 | - | E-CV-008 | ≥300ms 弹出、移开/Esc 即关、扫过不弹；该轮 user/assistant 纯文本截断；流式中快照不刷新 | 仅提问未回复显状态提示 |
| AC-CV-016 | CV-S06 点击定位 | 状态/一致性 | 正常流程：定位+回看模式 | P0 | U-CV-008 | - | E-CV-009 | 点击滚动定位并高亮；流式不再强制滚底；"回到底部"点击/触底恢复自动滚底 | TD-CV-06 承接 |
| AC-CV-017 | CV-S06 空态 | 状态渲染 | 边界：草稿态/无用户消息 | P1 | - | - | E-CV-010 | 不渲染时间线与占位 | - |
| AC-CV-018 | CV-S06 浮窗布局 | 布局完整性 | 边界：浮窗不溢出视口 | P1 | U-CV-007 | - | E-CV-011 | 靠边翻转/收拢、超高内滚；窄窗口不溢出 | 定位纯函数 |
| AC-CV-019 | CV-S06 快照截取 | 字段边界/展示 | 字段边界：截取与码点截断 | P1 | U-CV-006 | - | - | 跳过 tool/图片；码点截断无半代理对；畸形消息不抛异常 | 派生纯函数 |

### 覆盖基线（CV-S07 上下文压缩）

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| AC-CV-020 | CV-S07 手动压缩 | 前端反馈 | 正常流程：点击压缩并显示结果 | P0 | U-CV-010 | A-CV-008 | E-CV-012 | 返回 `{ok:true, tokensBefore, tokensAfter}`；界面显示「压缩完成：before → after tokens」 | 缺失详情时回退「压缩完成」 |
| AC-CV-021 | CV-S07 压缩失败 | 错误反馈 | 异常：内容过少/会话未激活 | P1 | U-CV-009 | A-CV-008 | E-CV-012 | 显示失败原因（「Nothing to compact」/「会话未激活，无法压缩」）；不破坏会话历史 | 不静默 |
| AC-CV-022 | CV-S07 流式保护 | 状态/一致性 | 边界：streaming 期间压缩入口禁用 | P0 | - | - | E-CV-012 | 入口置灰不可点；不静默截断正在生成的回答 | 运行时压缩会先 abort 当前轮 |
| AC-CV-023 | CV-S07 自动压缩 | 跨模块协作 | 正常流程：自动压缩完成通知 | P0 | - | A-CV-009 | E-CV-013 | 发射 `conversation.compacted`（reason=auto）并携带前后 token；UI 重拉历史并提示 | 无 RPC 入口，事件是唯一通道 |
| AC-CV-024 | CV-S07 自动压缩失败 | 错误反馈 | 异常：自动压缩异常 | P1 | - | A-CV-010 | - | 走 `conversation.error` 上报 errorMessage；不发射 compacted | 绝不静默 |
| AC-CV-025 | CV-S07 用量显示（重启恢复） | 状态/一致性 | 正常流程：无 lease 时磁盘估算用量 | P2 | - | A-CV-008 | - | 重启后仅加载历史的会话查询用量：最后有效 assistant usage + 尾部估算（与 pi 同规则）；contextWindow 取会话模型；压缩边界后无新用量时 tokens/percent 为 null | 发出首条消息后回落运行时实时读数；无文件/无模型时返回 null |

### 覆盖基线（扩展 CV-S08 斜杠命令）

> 前端层（InstructionInput 命令浮窗）+ 后端层（getSlashCommands 枚举/缓存/事件桥接）；命令执行真实链路（AC-CV-031）为集成层，不得全 mock（contract §B2 集成完整性）。

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | 必测 | Unit ID | API ID | E2E ID | 核心断言 |
|---|---|---|---|---|---|---|---|---|---|
| AC-CV-026 | CV-S08 斜杠命令 | 交互与反馈/状态渲染 | 正常流程：行首 / 触发浮窗 | P0 | 是 | U-CV-011 | A-CV-011 | E-CV-014 | 光标行行首 / 弹浮窗列出三类命令；streaming 期间不可触发 |
| AC-CV-027 | CV-S08 斜杠命令 | 内容正确性 | 正常流程：codex 风格美化显示 | P1 | 是 | U-CV-012 | - | E-CV-014 | 无 `/` 与 `skill:` 前缀；kebab→Title Case；skill 加粗品牌色；描述副文本；来源标签 |
| AC-CV-028 | CV-S08 斜杠命令 | 查询/筛选视图 | 正常流程：模糊过滤（包含匹配）与空态 | P0 | 是 | U-CV-012 | A-CV-011 | E-CV-014 | 包含匹配（原始名或描述、大小写不敏感，用户裁定 2026-09-03 由前缀放宽）；无匹配「无匹配命令」；清单空「无可用命令」 |
| AC-CV-029 | CV-S08 斜杠命令 | 交互与反馈/数据一致性 | 正常流程：导航+选择+插入原始串 | P0 | 是 | U-CV-011 | - | E-CV-015 | ↑↓ 循环高亮；Enter/Tab/单击插入原始命令串+尾随空格（美化名不进输入框）；期间 Enter 不发送 |
| AC-CV-030 | CV-S08 斜杠命令 | 状态流转 | 边界：浮窗关闭路径 | P1 | 是 | U-CV-011 | - | E-CV-016 | Esc/失焦/删空行首 `/`/行内空格均关闭；关闭后 Enter 恢复发送语义 |
| AC-CV-031 | CV-S08 斜杠命令 | 集成完整性/跨模块影响 | 集成：命令原样发送 pi 原生执行 | P0 | 是 | - | PIC-007 | - | 真实 pi 会话中 `/skill:name` 展开为 skill 内容块；扩展命令被运行时立即执行 |
| AC-CV-032 | CV-S08 斜杠命令 | 状态渲染/异常降级 | 边界：草稿态可见 skills、激活后补全 | P0 | 是 | - | A-CV-012 | E-CV-017 | 草稿态列出 skills/模板、无扩展命令；`slashCommandsUpdated` 后缓存失效、扩展命令出现 |
| AC-CV-033 | CV-S08 斜杠命令 | 异常失败/后端健康 | 异常：枚举失败降级 | P1 | 是 | - | A-CV-012 | E-CV-018 | 枚举失败返回空清单 →「无可用命令」；输入与消息发送不受阻塞 |
| AC-CV-034 | CV-S01 扩展 @ 文件补全 | 交互与反馈/状态流转 | 正常流程：行内 @ 触发 + 键盘选择 | P1 | 是 | U-CV-013 | - | E-CV-019 | 行内 @token（@ 前为空白/行首）弹项目白名单文件补全；↑↓ 循环、Enter/Tab/点击选中、Esc 关闭；邮箱式 token（@ 前非空白）与无项目路径不触发 |
| AC-CV-035 | CV-S01 扩展 @ 文件补全 | 数据一致性 | 正常流程：选中进待发区，与附件三入口同链路 | P0 | 是 | U-CV-013 | A-CV-014 | E-CV-019 | 选中后 @token 移除、文件经 addPaths 白名单/嗅探入待发区，发送时与三入口同格式（@路径行，v3.30）；不合格式拒绝并提示 |
| AC-CV-036 | CV-S01 扩展 @ 文件补全 | 异常失败/后端健康 | 异常：拉取失败/无匹配降级 | P1 | 是 | U-CV-013 | A-CV-014 | E-CV-019 | 拉取失败或无匹配显示「无匹配文件」，不阻塞输入与发送；候选按项目缓存，切项目失效重拉；主进程遍历目录缺失返回 [] 不抛错 |

### 覆盖基线（扩展 CV-S11 Todo 面板）

> 前端层（TodoPanel.vue + todoSnapshot 按 sessionId 内存隔离 + 保证进行中可视的滚动策略）+ 后端层（TE-S05 IPC 透传 details，详见 test/04_tool 覆盖矩阵 AC-TE-011\~013）。面板只读不写、不跨进程持久化，关闭 APP 随进程消失，与 rpiv-todo TUI 面板共享单数据源。

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | 必测 | Unit ID | API ID | E2E ID | 核心断言 |
|---|---|---|---|---|---|---|---|---|---|
| AC-CV-037 | CV-S11 Todo 面板 | 跨模块协作 / 数据一致性 | 正常流程：收到 todo 完成事件后渲染面板 | P0 | 是 | U-CV-016 | A-CV-015 | E-CV-020 | 收到 `tool.completed(toolName='todo', result.details)` 后输入框上方出现面板；标题展示「已完成 X / 共 Y 个」计数；任务行按状态符号+subject+activeForm 渲染；details 缺失/非对象/tasks 非数组均静默忽略 |
| AC-CV-038 | CV-S11 Todo 面板 | 展示正确性 / 字段边界 | 正常流程：任务行按状态渲染 | P0 | 是 | U-CV-017 | - | E-CV-021 | `○ pending`（dim 空心点）/ `● in_progress`（呼吸点 warning + 括号 activeForm，灰色文字 muted）/ `✓ completed`（success + 删除线）；subject 空显示「（无标题）」；activeForm 空不渲染括号；长 subject 按码点截断 + 省略号 |
| AC-CV-039 | CV-S11 Todo 面板 | 状态流转 / 交互 | 正常流程：点击头部切换折叠 | P0 | 是 | U-CV-018 | - | E-CV-022 | 点击头部任意位置切换折叠/展开；折叠态仅渲染标题+chevron、不渲染任务行；折叠状态按 sessionId 内存隔离（切会话不串、刷新页面重置为默认展开）；hover 不自动展开/收起 |
| AC-CV-040 | CV-S11 Todo 面板 | 状态渲染 / 边界 | 边界：空快照卸载 + 超量收口 | P1 | 是 | U-CV-019 | - | E-CV-023 | 可见 task=0（仅墓碑 / 初始空 / clear 后）→ 面板从 DOM 卸载、不留高度与占位；visible task>50 → 渲染前 50 行 + 「+N more」收口；输入框上提补位 |
| AC-CV-041 | CV-S11 Todo 面板 | 数据一致性 / 异常 | 边界：会话隔离 + details 非法 | P1 | 是 | U-CV-020 | A-CV-015 | E-CV-024 | 切会话 → 旧快照保留在内存 Map，切回时还原；多会话同时有 todo 互不串；details 缺失/非对象/tasks 非数组 → 静默忽略当次事件、不污染对应会话快照、不抛错 |
| AC-CV-042 | CV-S11 Todo 面板 | 展示与交互 | 正常流程：长任务列表保证进行中可视 | P2 | 是 | U-CV-021 | - | E-CV-025 | 有 in_progress 时保证其在 3 行可视窗口内（不强求顶部，第 1/2/3 行都可，用户不需手动滚动即可看到）；无 in_progress（全部完成）时滚到最后一行让用户看到最终状态；不抢用户手动滚动位置（目标行已可视则 no-op）；触发时机：初次挂载 / 折叠→展开 / 布局变化 |
| AC-CV-051 | CV-S11 Todo 面板 | 数据一致性 / 边界 | 边界：会话终态兑底 in_progress→completed | P1 | - | U-CV-022 | - | - | status∈{done,idle,canceled,error} 到达时本会话快照里残留的 in_progress 任务被标为 completed；其他状态不动；空快照 / 无 in_progress 不写回（引用稳定）；兑底后 TodoPanel 走“全部完成 → 折叠 → 隐藏”路径 |

### 扩展 CV-S12 ask_user_question 内嵌问卷

> 前端层（`AskUserQuestionPanel.vue` + `useSessionConversation` 按 sessionId 内存隔离的问卷态 + `utils/askUserQuestion.ts` 纯逻辑）+ 扩展层（`@forge/extensions` 的 `ask_user_question` 内置扩展：schema / 校验 / envelope / 双阈值超时）+ 传输层（`bindAskUserBus` + `replyAskUserQuestion` + `conversation.askUserQuestionRequested` + `askUserQuestion/reply`）。
> 与 CV-S11 的关键差别：问卷是**双向**的（todo 面板只读），因此除 unit/E2E 外必须覆盖 transport 层（会话隔离、退订、畸形载荷、投递失败降级）。

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | 必测 | Unit ID | API ID | E2E ID | 核心断言 |
|---|---|---|---|---|---|---|---|---|---|
| AC-CV-043 | CV-S12 问卷面板 | 跨模块协作 | 正常流程：模型调用工具后渲染面板 | P0 | 是 | U-CV-022 | A-CV-016 | E-CV-026 / E-CV-028 | 请求到达后输入框上方出现内嵌面板（N+1 tab / 选项 / 备注 / 折叠摘要）；工具卡片仍按通用规则进消息流；子 agent 结果视图激活时不渲染 |
| AC-CV-044 | CV-S12 问卷面板 | 数据一致性 / 字段边界 | 正常流程：单选 / 多选 / 自定义作答 | P0 | 是 | U-CV-022 | - | E-CV-026 | 单选 → `kind='option'` + `answer=label`；多选 → `kind='multi'` + `answer=null` + `selected`（保持勾选顺序）；自定义 → `kind='custom'`；**部分作答只产出已答条目**（answers 长度即「已答 n/N」） |
| AC-CV-045 | CV-S12 问卷面板 | 展示正确性 | 正常流程：preview 左右分栏且不回流 | P1 | 是 | U-CV-022 | A-CV-016 | E-CV-026 | 仅单选且任一选项带非空 `preview` 时切分栏（多选恒不切）；模型侧 envelope **不含** `selected preview:` 段；`details.answers[].preview` 保留；选项无 preview 时不产出该字段 |
| AC-CV-046 | CV-S12 问卷面板 | 展示正确性 / 字段边界 | 字段边界：推荐标记双通道 | P1 | 是 | U-CV-022 | - | E-CV-026 | `recommended===true` 或 label 尾部 `(Recommended)` 均渲染「推荐」徽标；后者**仅显示层**剥离后缀，回填 label 保持原始值；句中（非尾部）出现后缀不误判 |
| AC-CV-047 | CV-S12 问卷面板 | 状态流转 | 正常流程：倒计时与回填 | P0 | 是 | U-CV-023 | A-CV-016 | E-CV-027 | 倒计时取载荷下发 `timeoutMs`（绝对截止时刻，切走再切回剩余秒数连续）；归零主动回填「已答部分 + `cancelled:true`」；提交 / 取消 / ESC 同路径；提交与归零竞态只上报一次（`settled` 门）；extension 返回 `cancelled:true` 时仍带 `answers` |
| AC-CV-048 | CV-S12 问卷面板 | 数据一致性 | 边界：多窗格会话隔离 | P0 | 是 | U-CV-024 | A-CV-016 | E-CV-027 | 各会话订阅**各自私有**总线，sessionId 取自订阅闭包；A 的请求不上抛给 B；回填只落对应会话总线；缺 `sessionId` 或与本窗格不符一律忽略（不做「无 sessionId 归当前会话」兜底）；`removeSession` 退订后迟到请求不再上抛（幂等） |
| AC-CV-049 | CV-S12 问卷面板 | 降级正确性 / 异常 | 异常：畸形载荷与非法 details | P1 | 是 | U-CV-024 | A-CV-016 | - | 畸形请求（缺 requestId / questions 空或非数组 / timeoutMs 非正）静默忽略不投递；`details` 非法 / 含 `error` / 无题目上下文不渲染已答摘要；`delivered=false` 时摘要标「已取消」；leaseless（扩展未激活）静默降级不抛错 |
| AC-CV-050 | CV-S12 问卷面板 | 状态流转 / 展示正确性 | 正常流程：已答后自动收起；异常：空 payload 提交 | P1 | 是 | U-CV-022 | U-CV-025 | E-CV-026 | **答完即收**：摘要亮 `ASK_ANSWERED_AUTO_CLOSE_MS` 后面板折叠关闭（含 leave 动画），且该轮摘要（含迟到的 `tool.completed` 权威摘要）不再出现；收起只作用于本会话，新一轮问卷照常显示摘要；**唯一例外**是 `deliveryFailed`（用户点了提交但答案没送达）→ 保留摘要可见，且该标记**活过权威 details 覆盖**（`details` 不含这个本地判定）；**不得**用 `cancelled && answers 非空` 近似（超时归零同样满足，但那条路径答案已回填成功、必须收起）；`提交答案` 在 payload 为空（含只填备注未选任何选项）时**禁用**（空 payload 落到扩展侧是与「取消」完全相同的 DECLINE 信号） |

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-001 | AC-CV-002 | sendMessage 输入校验 | 字段边界 | 会话存在 | 空字符串/空格 | sendMessage | 校验失败，不触发 ModelRuntime | 无消息写入 |
| U-CV-002 | AC-CV-006 | Markdown 渲染器 | 字段边界 | 消息内容 | `\`\`\` 代码块+标题+列表 | 渲染 | 正确生成 HTML 结构 | 不当转义 |
| U-CV-003 | AC-CV-007 | 白名单渲染器 | 安全 | 消息含恶意 HTML | `<script>alert</script>`、`<img onerror>` | 渲染 | 危险标签被剔除/转义，不执行 | 无跨站脚本（XSS）执行 |
| U-CV-004 | AC-CV-008 | Mermaid 渲染 | 边界 | 无效 mermaid 图 | `graph TD; a -- b --` 非法 | 渲染 | 返回错误信息+源码 | 不抛出未处理异常 |
| U-CV-006 | AC-CV-008 | Mermaid 非 mermaid 内容误包围栏 | 边界 | 围栏标记 mermaid 但内容不是任何图语法（如 ASCII 框图 `┌─┐`） | `\`\`\`mermaid\n┌──┐\n\`\`\`` | 渲染 | detectType 失败不弹红色报错，按普通代码块+灰色提示展示（MermaidBlock notMermaid 分支） | 不尝试图表渲染报错打断阅读 |
| U-CV-005 | AC-CV-013 | 附件路径化 | 一致性 | 会话存在 + 生效模型 | 正文+@路径行；残留 attachments 选项；含密钥附件；粘贴截图；不支持格式（如 exe） | sendMessage / scanAttachments / savePasteImage | content 原样透传不拼接片段、恒返回 data=null；文本文件命中密钥特征 → flagged；截图落盘临时文件返回真实路径；不在白名单的格式拒绝入待发区并提示 | 附件机制单一：路径进正文，无内容内联/门控分支 |

#### unit（扩展 CV-S06）

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-006 | AC-CV-015/019 | 预览快照派生（截取+截断） | 字段边界/展示 | 消息数组 fixture（多轮含 tool/图片/空内容/畸形） | 完整多轮；超长文本（500/1000 字）；恰好等于上限；空数组；仅 user 无 assistant；content 非字符串；含 emoji/全角 | 派生快照 | 取该轮最后 user + 其后最后 assistant；超上限按码点截断加省略号（恰等不加）；空→空会话态；无回复→状态提示态；畸形按空处理不抛异常 | 不把 tool 消息当 user/assistant 文本；不产生半个代理对；不解析 Markdown/图片 |
| U-CV-007 | AC-CV-018 | 浮窗定位计算 | 布局完整性 | 注入条目/视口/浮窗尺寸矩形组合 | 右侧空间充足；贴右缘；贴上/下缘；两侧都放不下的极窄视口；0 高条目 | 求解坐标 | 右侧优先、空间不足翻左侧、垂直夹取进视口、极窄收拢至最大可用宽；同输入输出稳定 | 坐标恒在视口内（含边距）；无 NaN/Infinity |
| U-CV-008 | AC-CV-016 | 回看模式状态机 | 状态/一致性 | 消息流 + 流式增量信号（fake） | 点击条目；定位后持续 delta；手动滚到底；点击"回到底部"；会话切换 | 驱动状态流转 | 点击→定位+进入回看（delta 不再强制滚底，提示条出现）；触底或点击提示→退出回看恢复自动滚底；切换会话重置为浏览模式 | 回看模式下任何 delta 不得强制改 scrollTop；退出恰好一次、不重复触发 |

#### unit（CV-S07 上下文压缩）

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-009 | AC-CV-021 | 压缩结果归一化与失败收敛 | 错误反馈 | 已激活会话（lease 存在）/未激活会话；pi compaction_end 载荷 | 成功载荷（manual/threshold/overflow）；`errorMessage` 载荷；`aborted:true` 载荷；compact 抛错；会话不存在 | 驱动 handleEvent / compact | 成功→回调 onCompacted（manual→manual，其余→auto，带 tokensBefore/tokensAfter/summary）；失败→onError 上报；aborted→既不回调也不误报；抛错→ok:false 带原因 | 失败绝不静默；aborted 不误报为错误；压缩失败不破坏会话历史 |
| U-CV-010 | AC-CV-020 | 压缩详情提取（pi CompactionResult） | 字段边界 | compact 返回体 | 完整载荷（summary/tokensBefore/estimatedTokensAfter）；缺字段；非对象 | compact() | 提取为 `{tokensBefore, tokensAfter, summary}`，缺失归一为 null | 不因 pi 无 message 字段而丢失详情；不产生 undefined |
| U-CV-026 | AC-CV-052 | 历史加载在压缩会话上的口径（getBranch） | 数据一致性 | session JSONL 含 compaction 条目 / 不含 | 压缩点前 2 条 + compaction + 压缩点后 2 条；纯消息会话 | loadPiSessionHistory | 压缩点之前的消息按原时间序返回；compaction 条目落成 `{role:'system', compacted:true, content:摘要, ts}` 且恰好 1 条、位置在压缩前后之间；未压缩会话无 system 标记 | 不得退回 `buildContextEntries()`：那会让压缩点之前的对话整段消失 |

#### unit（扩展 CV-S08）

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-011 | AC-CV-026/029/030 | 斜杠上下文检测与插入串构建（slashCommand 纯函数） | 状态流转/数据一致性 | 无（纯函数） | 首行行首 `/`；多行中间行行首 `/`；`/` 后含空格；光标在命令中间；行首非 `/`；空文本；光标在第二行行首前有换行 | 检测 + 构建插入 | 行首 `/` 且无空格 → 激活（过滤串=光标前段）；空格后 → 不激活；插入区间=[行首, 光标) 且插入串=`/`+原始命令名+空格 | 非行首 `/`（如句中）不激活；插入串不含美化名；空文本不抛异常 |
| U-CV-012 | AC-CV-027/028 | 命令过滤与显示美化（纯函数） | 内容正确性/查询筛选 | 命令清单 fixture（三类 + 无描述 + 大小写混合名） | 过滤串 `git`/`GIT`/`skill:git`/`tests`（中间文字）/`推送`（描述）/空串/无匹配 `zzz`；显示名转换 `git-push`/`skill:git-push`/`writeTests`/`review-pr`；消息气泡命令段识别 `extractCommandFromMessage`（原始串含 skill 前缀/无前缀/多行 rest、pi 展开块收起留尾部正文、路径/普通文本/句中斜杠负向）；正文技能引用切段 `splitSkillRefs`（多引用切段/无引用单段/中文标点不吞名/裸 `/skill:` 无名不误切/连写逐个切/空串非字符串） | 过滤 + 美化 + 气泡命令识别 + 正文引用切段 | 包含匹配大小写不敏感（原始名含 `skill:` 前缀或描述命中，保持原序不排序）；无匹配返回空列表；显示名剥离 `/` 与 `skill:` 前缀、kebab/snake/camel 分段首字母大写（`git-push`→`Git Push`）；无描述副文本为空；气泡命令段两种形态提取正确、非命令不误伤；正文内全部 `/skill:name` 引用逐段切出且前后文保留（样式性美化，不代表 pi 执行） | 不把美化名当过滤匹配键；不产生 undefined/NaN；畸形名（空串、纯符号）不抛异常 |
| U-CV-013 | AC-CV-034/035/036 | @ 补全上下文检测与候选过滤排序（atCompletion 纯函数） | 状态流转/内容正确性/查询筛选 | 文件路径 fixture（basename/目录分层含混合大小写） | `detectAtContext`：行内 `@edu`、刚输 `@`（空过滤）、光标压 `@`、@ 后空格、邮箱式 `a@b`/`user@example.com`、无 @、越界、空文本；`filterAtFiles`：basename 前缀/包含/路径包含分级排序（同级路径短者前）、空过滤原序截 limit、无匹配 `zzz`、limit 截断 | 检测 + 过滤排序 | 激活返回 {filter, atStart}（token 起点=@ 位置）；@ 前非空白不激活；激活后过滤串大小写不敏感排序分级正确；空过滤按原序（BFS 浅层优先）截前 limit 条 | 光标越界/非整数/空文本不抛异常；非字符串入参防御 |

### api（IPC 契约 + CanonicalEvent）

| 用例 ID | 关联 AC | 接口 | 前置条件 | 请求数据 | 预期响应/错误码 | 数据落地 | 断言点 |
|---|---|---|---|---|---|---|---|
| A-CV-001 | AC-CV-001 | conversation/sendMessage | 会话存在 | { sessionId, content: "hi" } | 200 | 写入 pi session | 事件流推送 user+assistant 消息 |
| A-CV-002 | AC-CV-003 | conversation/sendMessage | provider 未配置 | { sessionId, content } | 1004 | 无写入 | 返回 1004 不崩溃 |
| A-CV-003 | AC-CV-004 | conversation/sendMessage（长文本） | 会话可跑 | 长文本（>10k token） | streaming 增量事件 | 消息完整落库 | 无缺失/重复事件，顺序正确 |
| A-CV-004 | AC-CV-005 | conversation/sendMessage（中途断流） | mock 断流 | 发送后中断 | 标记中断事件 | 已收内容保留 | 停止后可重试 |
| A-CV-005 | AC-CV-009/010 | conversation/cancelStream | 会话 runnin g | { sessionId } | 200 | 保留已生成，标记 cancelled | 可再次发送 |
| A-CV-006 | AC-CV-011/012 | session/queryHistory | 会话含历史 | { sessionId } | 返回全部历史 | 无 | 角色区分正确、顺序正确 |
| A-CV-007 | AC-CV-013 | conversation/sendMessage（附件@路径行） | 会话存在 | { sessionId, content: 正文+@路径行 } | 200 + data=null | content 原样透传 | 不拼接附件片段；残留 attachments 参数被忽略；非视觉模型不报错（pi-ai 降级） |
| A-CV-010 | AC-CV-011/012 | conversation/queryHistory（流式中切回） | 会话轮次进行中（message_end 未到，助手消息未落盘） | { sessionId } | 200 | 无写入 | 历史末尾包含未完成 assistant 快照（清洗后全文）；轮次结束后不重复追加；修复切回后内容截断（终态消息覆盖前一直缺前文） |

#### api（CV-S07 上下文压缩）

| 用例 ID | 关联 AC | 接口 | 前置条件 | 请求数据 | 预期响应/错误码 | 数据落地 | 断言点 |
|---|---|---|---|---|---|---|---|
| A-CV-008 | AC-CV-020/021 | conversation/compact | 会话已激活（发过消息） | { sessionId } | 200 + `data.result.{ok,tokensBefore,tokensAfter,summary}`；会话不存在 1002；参数缺失 1001 | 压缩写 pi session transcript | 详情逐层透传到 UI；失败返回 ok=false + 原因且不破坏历史 |
| A-CV-009 | AC-CV-023 | conversation.compacted 事件 | 会话已激活；运行时 emit compaction_end | reason=threshold/overflow/manual + result | 事件发射 `conversation.compacted`（reason 归一为 auto/manual） | 无 | payload 含 sessionId/reason/tokensBefore/tokensAfter/summary；UI 据此重拉历史 |
| A-CV-010 | AC-CV-024 | conversation.compacted 失败路径 | 会话已激活；emit compaction_end 带 errorMessage | reason=overflow + errorMessage | 发射 `conversation.error`，不发射 compacted | 无 | 失败必上报；不静默 |

#### api（扩展 CV-S08）

| 用例 ID | 关联 AC | 接口 | 前置条件 | 请求数据 | 预期响应/错误码 | 数据落地 | 断言点 |
|---|---|---|---|---|---|---|---|
| A-CV-011 | AC-CV-026/028 | conversation/getSlashCommands（会话模式） | 会话存在；命令上报已缓存 / 上报未到达 | { sessionId }；未知 sessionId；sessionId 非字符串 | 缓存命中返回三类全量清单（name/description/source）；上报未到降级轻量查询（skills+模板）；1002 未知会话；1001 参数错误 | 无（内存缓存，不落盘） | 响应结构与 source 枚举正确；降级路径不报错；description 缺失为 null 非 undefined |
| A-CV-012 | AC-CV-032/033 | conversation/getSlashCommands（草稿态与降级） | 未创建会话（草稿态）；资源查询可注入失败 | {} / { projectPath }；资源查询抛错 | 草稿态返回 skills+模板（无扩展命令）；projectPath 定位项目级资源；枚举失败返回 `commands: []` 不报错 | 无 | 草稿态清单不含 source=extension；失败路径 code=0（空清单）而非 5000 |
| A-CV-014 | AC-CV-035/036 | file.listProjectFiles（主进程遍历，IPC 直连不走 RPC 表） | 数据一致性/异常失败 | 真实临时项目目录（白名单/非白名单文件 + node_modules）；缺失目录 | 遍历返回白名单内文件绝对路径（BFS 浅层优先，上限 2000）；缺失/不可读目录返回 [] 不抛错；渲染层 addPaths 白名单二次把关 | 无 | node_modules/dist 等忽略目录不入候选；上限截断不炸内存；不可读目录跳过不中断 |
| A-CV-013 | AC-CV-032 | conversation.slashCommandsUpdated 事件桥接 | 命令上报扩展 emit 上报 channel（desktop 桥接注入） | 会话激活后扩展上报载荷 | forge-core 更新会话缓存并转发 `conversation.slashCommandsUpdated { sessionId }` | 会话级内存缓存更新 | 事件恰好发射一次；重复上报幂等覆盖缓存；未注册会话的上报不崩不泄漏 |

### e2e

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-CV-001 | AC-CV-001/004 | 对话区 | 会话存在 + provider | mock 流式数据 | mock-backend | 发消息→观察流式 | 消息显示，内容实时增量，无卡顿 |
| E-CV-002 | AC-CV-009/010 | 对话区 | 会话运行中 | mock 流式 | mock-backend | 点取消→再发 | 取消后已生成保留，可再发 |
| E-CV-003 | AC-CV-006/008 | 对话区 | 历史消息含富文本 | 消息含 markdown+代码+mermaid（含错误语法） | mock-backend | 打开会话→观察渲染 | 三种富文本正确；Mermaid 错误显示提示+源码 |
| E-CV-004 | AC-CV-007 | 对话区 | 恶意 HTML 消息 | 消息含 `<script>`/`onerror` | manual（安全断言） | 渲染消息 | 无脚本执行，无交互注入 |
| E-CV-005 | AC-CV-011/012 | 对话区 | 会话有历史消息 | 10+ 历史消息，含 user/assistant/tool | mock-backend | 打开→滚到最新 | 历史全加载，角色正确渲染 |
| E-CV-006 | AC-CV-013 | 对话区 | 会话存在 | 选择文件/粘贴截图 → 发送 | mock-backend | 附附件→发送→观察 | 用户气泡按原文展示正文+@路径行（@行=附件 chip，裸路径=正文）；流式正常返回；无红色报错 |

#### e2e（扩展 CV-S06）

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-CV-007 | AC-CV-014 | 对话区+时间线 | 多轮会话已加载 | 5+ 轮对话（长文本 user 消息） | mock-backend | 打开会话→观察时间线→流式中发新消息→切子 agent Tab | 时间线正序、横条标记（无文本、无分隔边框）；新条目实时出现；结果视图激活时不渲染；无 console error |
| E-CV-008 | AC-CV-015 | 时间线浮窗 | 会话含完整多轮 | 长文本（>120/200 码点）+ 仅提问未回复会话 | mock-backend | hover <300ms 移开；hover ≥300ms；Esc；流式中 hover | 扫过不弹；快照截断+省略号、纯文本（Markdown 符号原样）；移开/Esc 即关；流式中内容不随 delta 变化 |
| E-CV-009 | AC-CV-016 | 对话区+时间线 | 长会话 + 流式进行中 | mock 流式事件序列 | mock-backend | 点击中部条目→观察滚动态→等待 delta→点击"回到底部" | 定位准确+高亮；回看模式 delta 不强制滚底；点击提示/手动触底恢复自动滚底 |
| E-CV-010 | AC-CV-017 | 对话区 | 草稿态 / 空会话 | 新建会话未发消息；已打开但无 user 消息 | mock-backend | 观察左缘 | 无时间线、无占位、无 console error |
| E-CV-011 | AC-CV-018 | 时间线浮窗 | 窄视口 | 视口设最小支持尺寸；条目贴边 | mock-backend | hover 贴边条目；resize 极窄重复 | 浮窗完整在视口内（翻转/收拢）；超高内滚；无布局报错 |

#### e2e（CV-S07 上下文压缩）

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-CV-012 | AC-CV-020/021/022 | 输入框用量区 | 会话已选中 | seed 覆盖 compact 成功/失败响应；emit statusChanged=streaming | mock-backend | 点「压缩」→观察提示；streaming 下观察入口状态 | 成功显示「压缩完成：before → after tokens」；失败显示原因原文；streaming 期间入口 disabled；无 pageerror |
| E-CV-013 | AC-CV-023 | 消息区 | 会话已加载历史 | emit conversation.compacted（reason=auto） | mock-backend（emit 事件） | emit 压缩事件→观察提示条与历史重拉 | 出现「上下文已自动压缩」提示条；queryHistory 被重新调用；无 pageerror |
| E-CV-029 | AC-CV-053 | 消息区 | 会话已加载历史 | seed queryHistory 返回「压缩前 2 条 + compacted 标记 + 压缩后 1 条」；emit compacted 触发重拉 | mock-backend（seed + emit） | 观察消息流与分隔条；点击摘要 | 压缩前消息仍在；`.compact-divider` 恰好 1 条且文案为「上下文已压缩」；摘要默认折叠、点击后展开；无 pageerror（本机无 Playwright 浏览器，待补跑） |
| E-CV-030 | AC-CV-054 | 消息区 | 流式回复即将结束（autoFollow=true 贴底） | mock 流式回复；`--grep "repro L"` 布局后逐帧采样 | mock-backend（探针 `e2e/__repro-stream-end-jump.spec.ts`） | 观察收尾帧 `think` 行高度序列与 footer 高度序列、卸载帧 `dScrollH` | `think` 39px→0 连续收拢（不得卡在 20px = padding 之和）；footer 0→17px 同步展开；全过程 `dScrollH == dScrollTop` 恒成立且卸载帧位移 ≈0；单帧最大位移 ≤12px（修复前单帧 −30px）；回看态（已上滚）不出现强制滚底 |

#### e2e（扩展 CV-S08；详设见 e2e.md）

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-CV-014 | AC-CV-026/027/028 | 输入框命令浮窗 | 会话激活（seed 三类命令清单） | seed getSlashCommands（skill/extension/prompt + 无描述项） | mock-backend | 行首输入 `/`→续输前缀→输入无匹配串；emit streaming 后再触发 | 浮窗弹出、美化显示（无前缀/Title Case/skill 加粗品牌色/来源标签）；过滤实时；「无匹配命令」空态；streaming 期间输入不禁用、浮窗可触发（CV-S09 起忙时解锁） |
| E-CV-015 | AC-CV-029 | 输入框命令浮窗 | 浮窗已打开（高亮首条） | seed 命令清单 | mock-backend | ↓↓ 到末条再 ↓（循环）→Enter 选中；再开浮窗 Tab 选中；鼠标单击选中 | 插入原始命令串+尾随空格、光标在空格后；浮窗关闭；期间 Enter 不发送消息（消息区无新 user 气泡） |
| E-CV-016 | AC-CV-030 | 输入框命令浮窗 | 浮窗已打开 | - | mock-backend | 分别：Esc；点输入框外部（失焦）；删空行首 `/`；行内输入空格 | 四路径均关闭浮窗；关闭后 Enter 恢复发送（可正常发出普通消息） |
| E-CV-017 | AC-CV-032 | 输入框命令浮窗 | 新建会话草稿态（未发消息） | seed 草稿态清单（skills+模板）；emit slashCommandsUpdated | 草稿态输入 `/` 观察；发送首条消息激活会话→emit 事件→再次输入 `/` | 草稿态列 skills/模板、无扩展命令；事件后扩展命令出现（缓存失效重拉） |
| E-CV-018 | AC-CV-033 | 输入框命令浮窗 | seed getSlashCommands 抛错/返回空清单 | - | mock-backend | 输入 `/`→观察浮窗→直接发送普通消息 | 浮窗显示「无可用命令」；输入不阻塞；普通消息正常发送无报错 |
| E-CV-019 | AC-CV-034/035/036 | 输入框 @ 文件补全 | mock listProjectFiles 固定 3 条清单 | - | mock-backend | 输入 `看下 @`→过滤 `read`→↓+Enter 选中→输 `@zzz` 空态→Esc→普通消息 | 触发弹 3 条、过滤 1 条；选中后 @token 移除且待发区出 chip；空态「无匹配文件」Esc 关闭；输入与发送不阻塞、无报错 |

> E-CV-004 用 manual（安全边界，需人工确认无脚本执行，无法由 mock 自动判定）——已注明。可另配合禁用 CSP 的专用用例做自动化安全断言（P2 补充）。
#### e2e（扩展 CV-S09 消息队列 / CV-S10 输入历史翻阅，v1.1；实现为 e2e/queue.spec.ts 与 e2e/inputHistory.spec.ts）

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| QC-001 | CV-S09 | 输入框队列区 | 会话流式中（慢回复脚本） | 脚本 delay 900ms；两条排队文本 | mock-backend | 忙时连发两条→看徽标→开浮窗→等自动派发 | 徽标计数 1→2；浮窗只读（无按钮）FIFO 展示；脚本结束后逐条派发为 user 气泡、徽标清空；无 console error |
| QC-002 | CV-S09 | 输入框队列区 | 队列已满 5 条 | q1~q5 + 第 6 条 | mock-backend | 忙时连发 5 条→第 6 条 Enter | toast「队列已满」；输入框内容保留；计数仍 5 |
| QC-003 | CV-S09 | 输入框+队列区 | 队列 2 条流式中 | 两条待发文本 | mock-backend | 点停止 | 徽标消失；被清空文本按 \n\n 拼接回填输入框（pi TUI ESC 同款，零丢失） |
| QC-004 | CV-S09 | 输入框队列区+会话树 | 会话 A 流式中已入队 1 条，双会话（A/B） | 长脚本 delay 8000ms 防派发干扰 | mock-backend | A 入队→切 B（无徽标）→切回 A | 徽标仍在且计数不变（队列镜像按会话维护，切走再切回不丢；旧缺陷：resetForSession 清空 + 非当前会话事件被丢，徽标永久丢失） |
| AC-IH-001/002 | CV-S10 | 输入框 | 发送 3 条后清空输入框 | msg-1~3 | mock-backend | 空输入 ↑↑↓↓ | ↑ 回填最近→更早；↓ 反向；走过最新清空回当前编辑 |
| AC-IH-003 | CV-S10 | 输入框 | 输入框非空 | 任意文本 | mock-backend | 非空时按 ↑/↓ | 不触发翻阅（方案 B，让出默认光标移动） |
| AC-IH-004 | CV-S10 | localStorage | 未发任何消息 | - | mock-backend | 检查存储 | 无 forge.inputHistory.* 键（草稿态不入栈） |
| AC-IH-005 | CV-S10 | 双会话 | A/B 各发一条 | A-only/B-only | mock-backend | 切会话后 ↑ | 历史按 sessionId 隔离；历史模式残留文本随切换清空 |
| AC-IH-006 | CV-S10 | 输入框 | 发送 2 条后刷新页面 | persist-1/2 | mock-backend | 刷新→↑↑ | localStorage 持久化跨刷新生效 |
| AC-IH-007 | CV-S10 | 输入框 | 连续发送相同内容 | same-msg ×2 | mock-backend | 翻阅 | 去重不产生重复条目 |

#### unit（CV-S09 分流竞态回归，v1.2；实现为 forge-desktop test/pi/piConversationAdapter.test.ts）

> 背景：pi `prompt()` 在置位 `isStreaming` 前有 preflight 窗口（鉴权/压缩预检 await），期间适配器若仅以 `isStreaming` 分流，窗口内到达的消息会误走直发与启动中的轮次相撞（already processing → abort 误杀在途轮 / 双重并发轮次），队列徽标不出现且报错。修复：适配器增设直发提交门（pendingSubmit），同会话后续消息等待上一条直发提交（preflightResult 回调）后再分流。

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-014 | CV-S09 | 适配器 sendMessage 分流（PreflightGate fake） | 状态/并发一致性 | 首条直发挂起在 preflight（isStreaming=false） | 第二条消息在窗口内到达 | 完成提交（isStreaming=true + preflightResult） | 窗口内第二条不产生新直发调用；提交完成后以 followUp 入队 | 提交完成前不得提前入队（pi 空闲时 followUp 会滞留队列） |
| U-CV-015 | CV-S09 | 提交门释放（factory 失败路径） | 错误反馈/不悬挂 | factory 抛错 | 并发两条消息 | 等待提交结果 | 等待中的第二条同样收到错误并返回，不得永久悬挂 | 不得因首条失败导致后续消息无响应 |

#### unit（扩展 CV-S11）

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-016 | AC-CV-037 | todoSnapshot 归约器（applyTodoCompletion 纯函数） | 数据一致性/字段边界 | 初始 null；已有快照 | `tool.completed(tool.name='todo')` 事件 payload（details 含/缺失/非对象/tasks 非数组/含 deleted 墓碑）；非 todo 工具事件；连续多事件 | 归约 | 合法 `todo+details` → 全量替换为 `details.{tasks,nextId}`；`todo+无 details` / `todo+details 非对象` / `todo+tasks 非数组` → 静默忽略、不抛错、不改现有快照；非 todo 工具 → 静默忽略 | details 为 string/number/null 不抛错；非法结构不得污染上一份有效快照 |
| U-CV-017 | AC-CV-038 | 任务行格式化（formatTodoRow + truncateSubject 纯函数） | 展示正确性/字段边界 | 主题/状态/activeForm/owner fixture（中文/emoji/超长/空） | 3 种状态 × 含/不含 activeForm × 含/不含 owner × 空 subject；CJK 200 字、emoji 50、刚好 120 字、超 200 字 | 渲染 | 状态字符与色正确；in_progress 行括号包裹 activeForm；空 subject 显「（无标题）」；owner 不显；超长按码点截断 + 省略号（恰好 120 字不加省略号） | 不产生半个代理对；不渲染 HTML/不执行 v-html；不依赖外部 i18n 库 |
| U-CV-018 | AC-CV-039 | 折叠状态机（toggle + sessionKey 隔离） | 状态流转 | useTodoPanelSessionState fake（sessionId → {collapsed}） | 同一 session 内连续 toggle；sessionA 折叠后切 sessionB 再切回；刷新重置 | 驱动 toggle/reset | 同一 session toggle 切换、状态稳定；切到新 session → 新 state（默认展开）；回切旧 session → 还原旧 state（不串）；刷新 → 默认展开 | 不持久化到 localStorage；不跨 IPC 同步；状态机无非法流转（已展开 → 展开非法等同一次） |
| U-CV-019 | AC-CV-040 | 可见任务计算 + 卸载门（selectVisibleTasks + shouldRenderPanel 纯函数） | 状态渲染/边界 | tasks fixture（空、仅墓碑、1~50、51、100） | 空数组；含 1 个 deleted 墓碑；30 个混合状态；51 个任务（含 20 completed + 31 pending）；仅 1 个 in_progress | 过滤 + 可见性判断 | 过滤墓碑后剩余 = visible；visible=0 → 返回 `false`（面板卸载）；visible≤50 → 全部可见；visible>50 → 取前 50 行 + 提示剩余 | visible 计算不含 deleted；卸载门返回 false 时不输出任何高度 |
| U-CV-020 | AC-CV-041 | 会话切换 + 非法 details 防御（applyTodoCompletion + resetForSession） | 数据一致性/异常 | sessionId 序列；非法 details fixture | 切 sessionA→B（B 初始 null）；B 收到合法 details → 填充；切回 A 仍为 null；非法 details（undefined/null/"str"/42/tasks="str"/tasks=[null]）；持续多次非法事件 | 归约 + 切会话 | 切会话清空快照；新会话独立积累；非法 details 静默忽略、不抛错、不修改上一份有效快照；连续 10 次非法 events 不累积错误 | 不抛异常到上层；不污染 store；非法 events 不发 toast/error |
| U-CV-022 | AC-CV-051 | 会话终态兑底（applyTerminalCleanup 纯函数） | 数据一致性/边界 | TodoSnapshot fixture（null / 空 tasks / 仅 pending / 仅 completed / 仅 in_progress / 混合状态） | null 快照；空 tasks 数组；全 completed 不重复处理；混合 in_progress+pending+completed；deleted 墓碑不动；连续调用两次幂等 | 兑底返回 | null / 空 / 无 in_progress → 返回原引用（稳定）；含 in_progress → 返回新快照（tasks 映射为 completed，subject/activeForm/nextId 保留）；deleted 墓碑不动；未改动 pending/completed | 不修改原快照任务其他字段；调用幂等 |
| U-CV-022 | AC-CV-043/044/045/046/050 | 问卷面板纯逻辑（`utils/askUserQuestion.ts`：buildAskUserAnswers / isRecommendedOption / displayLabel / questionHasPreview / tabLabel / applyAskUserCompletion / stepCount / isLastStep / canStepPrev / canStepNext / shouldAutoAdvance / canSubmitAnswers / shouldAutoCloseAnswered）| 数据一致性/字段边界 | 问卷 fixture（单选/多选/自定义/带 preview/带 recommended/带 label 后缀/越界下标/单题/多题步骤边界）| 单选命中；单选未答；多选勾选顺序；**多选下自定义文本与已勾选项并存**；多选仅自定义（未勾任何选项）；多选空白自定义文本；自定义文本；选项带/不带 preview；`recommended:true`；label 尾部/句中 `(Recommended)`；越界下标；完全未作答；步骤导航边界（单题 → 1 步；多题末步 = 备注 tab；越界下标按末步处理）；自动前进边界（多选 / 末步 / 单题均不前进）| 纯函数计算 | 单选 → `kind='option'` + `answer=label`；多选 → `kind='multi'` + `answer=null` + `selected`（保序；**自定义文本并入末位**，不另起 `kind='custom'` 条目 —— 对模型仍是「一个多选答案」）；**单选**自定义 → `kind='custom'`（互斥，custom 优先于 option）；多选空白文本不并入；未答不产出条目（answers 长度即 n/N）；仅单选且任一选项带非空 preview 才切分栏；`recommended===true` 或 **label 尾部**后缀均判推荐；句中后缀不误判；**回填 label 为原始值**（剥离仅发生在显示层）；`applyAskUserCompletion` 对非法 details / 含 error / 无题目上下文返回 null；**步骤导航**：多题 `stepCount = 题目数 + 1`（末位备注 tab），**仅末步** `isLastStep` 为真（「提交答案」的唯一渲染条件），首步无「上一题」、末步无「下一题」；单题 `stepCount=1` → 不出导航且提交按钮常驻；**自动前进**：`shouldAutoAdvance` 单选且非末步为真，多选恒假（前进等于打断继续勾）；**提交可用性**：`canSubmitAnswers` 以 payload 长度为准（空数组 → 假；仅填备注不选任何选项 → 仍假，因备注单独不成答案、落到扩展侧也是 DECLINE）；**自动收起**：`shouldAutoCloseAnswered` 正常作答、主动取消、**超时归零（已答部分非空）**都为真，仅 `deliveryFailed`（提交但没送达）为假 | 不抛错；不渲染 HTML；`(no input)` 等空值占位仅在摘要层 |
| U-CV-023 | AC-CV-047 | 倒计时与回填竞态（remainingSeconds + settled 门 + summarizeAskAnswers） | 状态流转/幂等重复 | 绝对截止时刻；已答草稿 | 截止时刻 +5s / +0.5s / 已过期；切走再切回复算；提交与归零同时触发；提交后再次归零；取消态带 answers | 计时 + 回填 | `remainingSeconds` 向上取整且不 <0；归零主动回填「已答部分 + `cancelled:true`」；提交 / 取消 / ESC 走同一路径；`settled` 门保证只上报一次；多选顿号连接、空值占位、全空回退「（已答）」 | 不产生负秒；不重复上报（重复上报 = 模型收到两次 DECLINE 或答案被后到的空回填覆盖） |
| U-CV-024 | AC-CV-048/049 | 传输层会话隔离与降级（`PiConversationAdapter.bindAskUserBus` / `replyAskUserQuestion`） | 数据一致性/异常 | 每会话私有假总线；lease 含/不含 `events` | A/B 两会话各自 `emit(ask-user:request)`；`replyAskUserQuestion` 打 A / B / 未知会话；畸形载荷 8 种（null / string / 缺 requestId / 空 requestId / questions 空 / questions 非数组 / timeoutMs=0 / timeoutMs=NaN）；`removeSession` 后迟到 request；lease 无 `events` | 订阅 → emit → 断言 → 退订 | 请求带**必需** `sessionId` 上抛且只认领给订阅会话（A 的事件不上抛给 B）；`replyAskUserQuestion` 只落该会话总线，无 lease 返回 `false` 且零投递；8 种畸形载荷全部静默忽略（`seen.length===0`）；退订后迟到请求不再上抛（幂等）；lease 无 `events` 时静默降级不抛错 | 不做「无 sessionId 归当前会话」兜底；畸形请求宁可不弹也不弹残缺面板 |
| U-CV-025 | AC-CV-047/048/049/050 | 问卷会话状态仓（`composables/askQuestionStore.ts`：`createAskQuestionStore` 的 4 张表 + 1 个抑制集 + 3 个 computed + accept / settle / applyCompletion / clearAnswered / dismissAnswered） | 状态流转/数据一致性/异常 | 注入 `now()` 假时钟；`getSessionId` 由 `ref` 驱动可切换 | **面板首屏常驻挂载**（尚无问卷）时先读一次 computed → 再 `accept` → 再读（复刻真机「读秒恒 0」的时序）；同一会话二次 accept；切换会话 s1→s2→null→s1；`details` 缺失 / 含 `error` / 非对象；`clearAnswered` 时仍有进行中请求；**收起后再收迟到的权威 details**；`dismissAnswered`/`clearAnswered` 作用于 s1 时查 s2；收起后同一会话再来一轮 `accept` | 先读 computed → 驱动表 → 再读；**收尾后再塞权威 details** | **首屏已求值并缓存空值后，`accept` 仍必须让 `deadline` 重算**（表若是普通 Map 则此处返回缓存的 null → 面板读秒恒为 0；反向验证：把 `deadlines` 改回普通 `Map` 时本条与下一条用例变红、其余 7 条保持绿，证明锁定到位）；`accept` 让上一轮已答摘要让位；切会话时三个 computed 跟随刷新、切回后问卷与截止时刻还原（绝对时刻**不**重置）；`settle` / `applyCompletion` 释放 requests + deadlines 但**保留** questionSets（折叠摘要回显 n/N）；`applyCompletion` 对非法 / 含 error / 缺失 details 不产出也不污染摘要，但**照样释放进行中请求**（工具已返回，面板不得停在交互态）；`clearAnswered` 不清进行中的请求；**`dismissAnswered` / `clearAnswered` 后迟到的 `tool.completed` 不得把摘要重新点亮**（收尾是乐观的：settle 先落摘要、权威 details 后到 —— 只删表会让面板在用户眼前重新弹出；反向验证：注释掉抑制判断时恰好这 2 条变红、其余 11 条保持绿）；收起只作用于本会话；`accept` 解除抑制使新一轮摘要可显示；`applyCompletion` **保留** `deliveryFailed`（权威 details 不得抹掉「答案没送出去」这一本地事实），且不无中生有该标记 | 不抛错；不依赖 DOM 与 IPC 桥（纯 vue 响应式原语，可在 `node:test` 直接跑）；无 sessionId（null）时三者为 null |

#### api（扩展 CV-S11 / CV-S12；IPC 事件契约）

| 用例 ID | 关联 AC | 接口 | 前置条件 | 请求数据 | 预期响应/错误码 | 数据落地 | 断言点 |
|---|---|---|---|---|---|---|---|
| A-CV-015 | AC-CV-037/041 | tool.completed（todo 工具，TE-S05 details 透传） | mock todo 完成事件；mock 普通工具完成事件 | `tool.name='todo'` 含 `result.details={tasks,nextId}`；`tool.name='todo'` 无 `result.details`；`tool.name='read'` 含 `result.details`（仅验证透传，UI 不消费）；`tool.name='todo'` `result.details` 为 string/null/tasks 非数组 | 事件正常推送 | todoSnapshot 仅在合法 details 到达时更新 | todo 工具合法 details → 前端 useSessionConversation 写入 todoSnapshot；todo 工具无 details / 非法 details → 静默忽略、toastSnapshot 不变；非 todo 工具 details 不被 03 消费；IPC 事件序列化兼容（详见 test/04_tool 覆盖矩阵 AC-TE-011\~013） |
| A-CV-016 | AC-CV-043/045/047/048/049 | `conversation.askUserQuestionRequested`（事件，main→renderer）+ `askUserQuestion/reply`（RPC 方法，renderer→main） | 会话已激活（有 lease）；mock 扩展侧 emit | 事件：`{requestId, questions, timeoutMs, sessionId}`（含/不含 sessionId、畸形 8 种）；回填：`{sessionId, requestId, answers, cancelled, globalNote?}`（含/不含 globalNote、未知 sessionId/requestId） | 事件正常推送 + 回填返回 `boolean`（有 lease=true / 无 lease=false） | 请求落到 `useSessionConversation` 的按 sessionId Map；回填经 `bindAskUserReply` 打到方法表 | 事件必须登记 `FORGE_EVENTS` 白名单（漏登 = 面板永不出现且无报错）；回填必须走 methodTable 的 RPC 方法而非事件；`sessionId` 为必需项且与订阅闭包一致；`details.answers[].preview` 透传但 envelope 不含 `selected preview:` |

#### e2e（扩展 CV-S11 / CV-S12）

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-CV-020 | AC-CV-037 | 主会话对话区 | 主会话激活 | seed mock todo 事件序列（4 个任务：2 completed + 1 in_progress + 1 pending） | mock-backend | 触发 todo 工具完成事件 | 输入框上方出现面板；标题「已完成 2 / 共 4 个」；任务行渲染 4 行（✓×2、●、○）；无 console error |
| E-CV-021 | AC-CV-038 | 主会话对话区 | 已挂载面板 | seed 含/不含 activeForm / 含/不含 owner / 空 subject / 超长 subject | mock-backend | 观察面板渲染 | 三种状态字符与色正确；空 subject 显「（无标题）」；activeForm 在 ● 行括号展示；超长 subject 按码点截断 + 省略号 |
| E-CV-022 | AC-CV-039 | 主会话对话区 | 已挂载面板（默认展开） | - | mock-backend | 点击标题头部 → 观察 → 再点击；切子 agent Tab → 切回主会话 | 折叠态仅渲染标题 + chevron、不渲染任务行；展开态渲染全部任务行；折叠/展开带高度+透明度过渡动画（≤200ms）；切走再切回折叠状态保留（sessionId 隔离）；hover 不触发展开/收起 |
| E-CV-023 | AC-CV-040 | 主会话对话区 | 不同快照规模 | seed：空快照 / 仅墓碑 / 51 任务 / 5 任务 | mock-backend | 观察 DOM 与高度 | 空快照 / 仅墓碑 → 面板从 DOM 卸载、不留高度与占位；51 任务 → 渲染前 50 行 + 「+N more」收口；5 任务 → 列表可视区固定 3 行高度、超出内部滚动（细滚动条 ≤6px）；输入框上提补位 |
| E-CV-024 | AC-CV-041 | 多会话画布 | sessionA 已挂载 todo 面板；sessionB 无 | seed sessionA 面板快照；sessionB 不发 todo 事件 | mock-backend | 切到 sessionB → 观察；sessionB 触发非法 details 事件（缺失/非对象/tasks 非数组）；切回 sessionA | sessionB 面板卸载；非法 details 静默忽略、不报错；切回 sessionA 面板快照还原（独立快照） |
| E-CV-025 | AC-CV-042 | 主会话对话区 | 已挂载面板；任务数 > 3 且含 in_progress 在第 5 行 / 全部 completed | seed：20 个任务（in_progress 位于第 5 行）；全部 completed 的 10 个任务 | mock-backend | 观察面板滚动位置 → 用户手动向下滚动 → 再触发一次状态变化 | 有 in_progress 时其落在 3 行可视窗口内（不强求顶部，用户无需手动滚动即可见）；无 in_progress（全部完成）时滚到最后一行；目标行已可视时 no-op，不抢用户手动滚动位置；触发时机：初次挂载 / 折叠→展开 / 布局变化 |
| E-CV-026 | AC-CV-043/044/045/046 | 主会话对话区 | 主会话激活；mock 扩展 emit 一份 2 题问卷（第 1 题单选带 preview + 推荐项，第 2 题多选） | mock 问卷：`questions[0]` 单选项含 `preview` 与 `recommended:true` / label 尾部 `(Recommended)`；`questions[1]` `multiSelect:true` | mock-backend | 触发 `conversation.askUserQuestionRequested` → 观察面板 → **点第 1 题某选项观察自动切屏** → 用「上一题 / 下一题」手动回看 → 勾多选 / 点「自己答」选项填文本 / 点「推荐」项 → 观察摘要 | 输入框上方出现内嵌面板；N+1 tab 可切换；仅单选且选项带 preview 时左右分栏（多选切回单栏）；推荐项渲染「推荐」徽标且标签**不显示** `(Recommended)` 后缀；回填 payload 的 label 为**原始值**（含后缀）；多选按勾选顺序产出 `selected`；工具卡片仍按通用规则进消息流；子 agent 结果视图激活时不渲染面板；**操作条固定在标题行**（`已答 n/N` / 上一题 / 下一题 / 取消 / 提交答案，位于标题与「等待回答」徽标之间），底部无操作条；**步骤导航**：多题时出现「上一题 / 下一题」（首步无「上一题」、末步无「下一题」），**「提交答案」仅在末步**（最后一题之后的备注 tab）出现；**单选点选后自动切到下一步**（多选与点「自己答」不切，末步不切）；**「自己答」是选项列表末位的一行**（非独立大卡片），选中才在下方**整宽**展开输入框，选普通选项即撤销并清空其文本；**尺寸稳定**：hover 不同选项时 preview 面板高度不变（固定 240px 内部滚动），面板底部与下方输入框位置不跳动；**分栏宽度**：预览列窄于选项列（约 1.4 : 1）；**预览列表黑点在框内**：preview 含 `ul`/`ol` 时黑点与序号完整落在圆角框内（全局 `* { padding:0 }` reset 清掉 `ul` 内边距后必须显式补回），列表项之间无 `pre-wrap` 造成的多余空行；**多选题里「自己答」与普通选项并列**：勾选项后再点「自己答」→ 已勾选项**保持勾选**（不被取消），反之亦然；收起输入框后该行**仍高亮**（文本已计入答案），提交后 `selected` 末位含该文本且**不额外产出 `kind='custom'` 条目**；**头部读数非 0**：面板首屏即挂载（尚无问卷），请求到达后倒计时应按载荷 `timeoutMs` 正常递减（不得因 computed 缓存首屏空值而恒显示 0） |
| E-CV-027 | AC-CV-047/048 | 主会话对话区 + 多会话画布 | 会话 A 面板倒计时进行中（下发 `timeoutMs` ≈ 10s）；会话 B 同时挂载自身会话 | 短 `timeoutMs` 载荷；A 已答 1 题未提交 | mock-backend | A 切走再切回观察剩余秒数；A 归零；B 同时 emit 请求；对 A 提交后再次触发归零 | 剩余秒数按绝对截止时刻连续（切走再切回不重置）；归零主动回填「已答部分 + `cancelled:true`」且只上报一次；提交 / 取消 / ESC 同路径；**A 的问卷只在 A 窗格出现，B 窗格不弹**；回填只落 A 的会话总线；无 lease 会话回填返回 false 且零投递 |
| E-CV-028 | AC-CV-043 | 主会话对话区（首屏） | 无问卷、无流式的冷启动首屏 | 默认 mock 种子（4 会话）；不 emit 任何问卷事件 | mock-backend | `goto('/')` → 选中会话 → 观察 `.conv-view` / `.conv-input-wrap` / `.compose-box` 是否渲染 → 在输入框输入文本 | **对话区必须正常渲染**：三个容器各 1 且可见、无问卷时面板不占位；输入框可聚焦可输入（渲染中断时 DOM 可能残留但事件系统已死）；**无 pageerror / console error**。本用例是「组件 setup 抛错打空整块对话区」的唯一回归锁（v3.71 的 `Cannot access 'showAnswered' before initialization` 即此类：面板 setup 抛 TDZ → 连累整个 ConversationView 更新失败 → 真机「左侧树正常、右侧整块空白」） |
