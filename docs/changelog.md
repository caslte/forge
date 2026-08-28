# 变更日志

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
