# 对话与消息 覆盖矩阵

> 模块：03 对话与消息
> 来源：PRD 03（docs/prd/03_conversation.md）
> 状态：已确认（含扩展 CV-S06 会话历史导航、CV-S08 斜杠命令）
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

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-001 | AC-CV-002 | sendMessage 输入校验 | 字段边界 | 会话存在 | 空字符串/空格 | sendMessage | 校验失败，不触发 ModelRuntime | 无消息写入 |
| U-CV-002 | AC-CV-006 | Markdown 渲染器 | 字段边界 | 消息内容 | `\`\`\` 代码块+标题+列表 | 渲染 | 正确生成 HTML 结构 | 不当转义 |
| U-CV-003 | AC-CV-007 | 白名单渲染器 | 安全 | 消息含恶意 HTML | `<script>alert</script>`、`<img onerror>` | 渲染 | 危险标签被剔除/转义，不执行 | 无跨站脚本（XSS）执行 |
| U-CV-004 | AC-CV-008 | Mermaid 渲染 | 边界 | 无效 mermaid 图 | `graph TD; a -- b --` 非法 | 渲染 | 返回错误信息+源码 | 不抛出未处理异常 |
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

#### e2e（扩展 CV-S08；详设见 e2e.md）

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-CV-014 | AC-CV-026/027/028 | 输入框命令浮窗 | 会话激活（seed 三类命令清单） | seed getSlashCommands（skill/extension/prompt + 无描述项） | mock-backend | 行首输入 `/`→续输前缀→输入无匹配串；emit streaming 后再尝试触发 | 浮窗弹出、美化显示（无前缀/Title Case/skill 加粗品牌色/来源标签）；过滤实时；「无匹配命令」空态；streaming 期间输入禁用、浮窗不可触发 |
| E-CV-015 | AC-CV-029 | 输入框命令浮窗 | 浮窗已打开（高亮首条） | seed 命令清单 | mock-backend | ↓↓ 到末条再 ↓（循环）→Enter 选中；再开浮窗 Tab 选中；鼠标单击选中 | 插入原始命令串+尾随空格、光标在空格后；浮窗关闭；期间 Enter 不发送消息（消息区无新 user 气泡） |
| E-CV-016 | AC-CV-030 | 输入框命令浮窗 | 浮窗已打开 | - | mock-backend | 分别：Esc；点输入框外部（失焦）；删空行首 `/`；行内输入空格 | 四路径均关闭浮窗；关闭后 Enter 恢复发送（可正常发出普通消息） |
| E-CV-017 | AC-CV-032 | 输入框命令浮窗 | 新建会话草稿态（未发消息） | seed 草稿态清单（skills+模板）；emit slashCommandsUpdated | 草稿态输入 `/` 观察；发送首条消息激活会话→emit 事件→再次输入 `/` | 草稿态列 skills/模板、无扩展命令；事件后扩展命令出现（缓存失效重拉） |
| E-CV-018 | AC-CV-033 | 输入框命令浮窗 | seed getSlashCommands 抛错/返回空清单 | - | mock-backend | 输入 `/`→观察浮窗→直接发送普通消息 | 浮窗显示「无可用命令」；输入不阻塞；普通消息正常发送无报错 |
| E-CV-019 | AC-CV-034/035/036 | 输入框 @ 文件补全 | mock listProjectFiles 固定 3 条清单 | - | mock-backend | 输入 `看下 @`→过滤 `read`→↓+Enter 选中→输 `@zzz` 空态→Esc→普通消息 | 触发弹 3 条、过滤 1 条；选中后 @token 移除且待发区出 chip；空态「无匹配文件」Esc 关闭；输入与发送不阻塞、无报错 |

> E-CV-004 用 manual（安全边界，需人工确认无脚本执行，无法由 mock 自动判定）——已注明。可另配合禁用 CSP 的专用用例做自动化安全断言（P2 补充）。