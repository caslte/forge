# forge 项目总览

> 项目唯一入口文档。需求以 `docs/prd/` 为准，技术规范以 `docs/specs/` 为准，计划以 `docs/plan/` 为准。

---

## 一、项目背景

- **项目名称**：forge
- **项目类型**：全新项目（greenfield）
- **业务目标**：以 pi 为固定引擎的桌面项目工作台，覆盖"项目启动 → 对话编程"全流程。
- **本期目标（v1）**：交付聚焦 MVP 的桌面应用——项目管理、多会话、对话编程（含工具执行展示）、模型/Provider 配置。

## 二、核心产品原则

1. **pi 为固定基座**：pi 作 npm 依赖可独立升级，forge 不 fork pi 核心源码。
2. **业务能力 = pi 扩展**：forge 业务能力以 pi 扩展（TS）承载，非源码修改。
3. **复用 ai-coding 前端**：桌面 UI 复用 ai-coding 的 Vue 3 SPA，在 API 边界对接 forge-core。
4. **跟 pi 一致**：权限/信任/沙箱策略与 pi 一致，不另造（继承项目信任，无 per-tool 审批，无沙箱）。
5. **v1 聚焦 MVP**：核心先行，终端/发送队列/子代理等后续迭代。
6. **forge-core 纯 Node + 传输无关**：Electron 专有逻辑放 forge-desktop，forge-core 保持纯 Node 且不绑传输（暴露方法+事件）；桌面端走 IPC（不走 HTTP，堵本地攻击面），headless 走 HTTP/SSE（v2+）。详见 `plan/embedded-agent-discussion.md`。

## 三、技术栈与运行环境

- **引擎**：Node.js ≥22 + TypeScript；pi（`@earendil-works/pi-coding-agent` 等）作 npm 依赖，进程内 SDK（`AgentSession`）
- **桌面壳**：Electron + electron-builder + electron-updater
- **前端**：Vue 3 + Vite + TS（复用 ai-coding），marked / prismjs / mermaid
- **通信**：forge-core 传输无关接口（方法+事件）；桌面端 Electron IPC（不走 HTTP，避免本地端口攻击面），headless HTTP/SSE（v2+）；pi 事件映射到 `CanonicalEvent`
- **扩展**：pi 扩展（TS，jiti 加载）
- **存储**：pi session JSONL（`~/.pi/agent/sessions`）+ forge 项目组织层
- **构建**：npm workspaces，tsc/tsgo

## 四、技术分层（实现结构，非 PRD 模块）

| 层 | 职责 |
|---|---|
| forge-core | 引擎层：pi SDK 集成、扩展加载、事件→CanonicalEvent 映射、传输无关接口（方法+事件）、项目/会话树组织、模型/provider 对接。**纯 Node** |
| forge-desktop | Electron 壳：窗口/托盘/单例/原生对话框/通知/自动更新/安装器 |
| forge-ui | Vue 前端：复用 ai-coding，改造适配 Electron + pi |
| forge-extensions | 业务能力：pi 扩展承载 |

> PRD 按业务能力划分（见下），不按技术层划分。

## 五、一级模块（业务能力）与 PRD 导航

| 编号 | 模块 | 核心职责 | PRD 路径 | 状态 |
|---|---|---|---|---|
| 01 | 项目管理 | 本地目录注册为项目、项目列表、打开/移除、项目信任；扩展：分支查看与切换（PM-S05，输入框项目区徽标） | prd/01_project_management.md | PRD 已确认（含扩展 PM-S05） |
| 02 | 会话管理 | 会话创建/切换/删除/重命名，多会话并行，多窗口跨项目并排观察 | prd/02_session_management.md | PRD 已确认 |
| 03 | 对话与消息 | 发消息、流式响应、Markdown/代码/Mermaid 渲染、取消、历史；扩展：会话历史导航（主会话时间线+浮窗预览+点击定位）、斜杠命令（输入 / 浮窗选择 pi 生态命令/skills/模板，codex 风格美化，pi 原生识别）、消息队列（忙时入队+徽标，v1.1）、输入历史翻阅（空输入 ↑/↓，v1.1）、Todo 面板（输入框上方只读+折叠面板，复用 pi `todo` 工具 details 快照，v1.2，依赖模块 04 TE-S05 IPC 透传） | prd/03_conversation.md | PRD 已确认（含扩展 CV-S06、CV-S08、CV-S09、CV-S10、CV-S11） |
| 04 | 工具执行展示 | tool call/result 卡片、并排 Diff、状态流转；扩展 TE-S05 `tool.completed.result` 增加可选 `details` 透传（为模块 03 CV-S11 等结构化消费场景提供 IPC 支撑，补充不重写） | prd/04_tool_execution.md | PRD 已确认（含扩展 TE-S05） |
| 05 | 模型与 Provider 配置 | pi models.json 可视化编辑、密钥安全、模型选择；扩展：思考级别选择（输入框）、上下文 1M 配置 | prd/05_model_provider.md | PRD 已确认（含扩展 MP-S05/MP-S06） |
| 06 | 子 Agent 管理 | 主会话状态与后台子 agent 联动、Tab 栏+结果视图监控、停止级联/单个终止 | prd/06_subagent_management.md | PRD 已确认 |
| 07 | 版本更新与安装包 | 设置页「版本更新」分区（已实现）；Windows 安装包、预装推荐组件、应用自更新与引擎-插件联动更新（待开发） | prd/07_installer_update.md | PRD 已确认 |
| 08 | UI 国际化（中/英） | App 界面文案中英切换（自研轻量 composable，仅 UI 静态文案，主进程零改动） | prd/08_ui_i18n.md | 已完成（2026-09-22 交付） |
| 09 | Skill 管理 | 全局+项目级 skill 列表、导入文件夹、模板新建、删除 | prd/09_skill_management.md | 开发中（代码+单测+mock 链路完成，真机验收待确认） |

### 配套设计文档

| 类型 | 路径 | 状态 |
|---|---|---|
| DB（forge 自有存储） | db/forge-store/schema.md | 已确认 |
| API（forge-core 接口契约） | api/index.md + api/01~07, 09_skill.md | 已确认 |
| 测试设计 | [test/index.md](test/index.md) + 各模块 coverage-matrix.md | 已确认 |

## 六、核心业务流程

```
打开 forge → 项目列表 → [添加项目(选目录)] → 打开项目 → (首次:项目信任询问)
   → 创建会话 → (无 provider 则配置) → 对话编程(发消息→流式响应→工具执行展示)
   → 切换/删除会话 → 切换/移除项目
```

## 七、MVP 范围

**做**：项目管理、多会话（并行执行）、对话（Markdown/Mermaid）、工具执行卡片/Diff、模型配置、项目信任（pi 自带）、多窗口观察（多会话跨项目并排，窗口吸附）、子 Agent 管理（模块 06：状态联动+Tab 监控+终止）、会话历史导航（模块 03 扩展 CV-S06：主会话时间线+hover 浮窗预览+点击定位，零新增后端）、分支查看与切换（模块 01 扩展 PM-S05：输入框项目区分支徽标+浮窗切换本地分支，流式中禁用、dirty 先确认、失败透传 git 错误）、斜杠命令（模块 03 扩展 CV-S08：输入 / 浮窗选择 pi 生态命令/skills/模板，codex 风格美化显示，原样发送 pi 原生识别；forge-extensions 承载首个真实扩展——命令上报扩展）、附件（统一给路径：选择/粘贴/拖拽 → 路径行随消息发送，截图先落盘临时文件，模型自行 read）。

**不做（后续迭代）**：嵌入式终端、发送队列、复杂 ToolProfile CRUD、per-tool 审批扩展、嵌入式 agent（v2+）、TUI 形态、子 agent 左侧树分组与逐 token 实时查看（PRD 06 明确不做）。

> 子代理面板原列"不做"，2026-08-28 提级为模块 06（PRD 已确认）。

## 八、当前状态

- 已完成：立项与架构决策（`plan/forge-v1-plan.md`）、docs 初始化、5 个 PRD（01-05）确认、DB/API/测试设计全档确认、PRD 05 扩展（MP-S05 思考级别选择、MP-S06 上下文 1M）文档确认与**开发交付（dev-flow run 20260827115957，COMPLETE：6 WU 通过 + Fan-in + 模块 QA PASS）**；开发产物含输入框思考级别切换器（含 max 金色流光动画）、设置页上下文 1M 勾选、forge-core/desktop 对应业务与运行时接线；**模块 03 扩展 CV-S06 会话历史导航文档确认与开发交付（dev-flow run 20260829155926，COMPLETE：3 WU 通过 + Fan-in 39 e2e 全绿 + 模块 QA PASS；独立模块 07 方案撤销，纯前端零新增后端）**。
- 进行中：v1.1 计划草案（`plan/forge-v1.1-plan.md`，待确认范围后进入 gen-doc-prd / dev）。
- 已完成（2026-09-02）：模块 03 扩展 CV-S08 斜杠命令全档确认（gen-doc-all：PRD + API §9 + 测试设计 U-CV-011/012、A-CV-011~013、E-CV-014~018、PIC-007）。
- 进行中：CV-S08 开发交付（dev-flow run `20260902145236`，状态文件 `docs/plan/dev-20260902145236-flow.json`）——5 WU 中 4 个已通过 D3+D4（WU-01 core 服务与 RPC 329 测试、WU-02 forge-extensions 命令上报扩展+desktop 装配 161 测试、WU-03 UI 纯函数+bridge+mock 103 测试、WU-05 desktop 桥接+草稿态 port 171 测试）；**WU-04（InstructionInput 浮窗集成 + e2e）代码已落地但 5 条 e2e（E-CV-014~018）全部失败，Dev Agent 结果丢失，需重派修复**（WU 仍处 claimed/in_progress，重派修复后直接提交即可，不消耗 local_fix 次数）；之后 D5 Fan-in（全量回归）→ D6 模块 QA（含 PIC-007 真实链路验证项）。
- 已完成（2026-09-07）：模块 01 扩展 PM-S05 git 分支查看与切换全档确认（gen-doc-all）与开发交付（dev-flow run `20260907175149`，COMPLETE：4 WU 通过 + Fan-in 706 单测全绿 + e2e 74 过/2 存量挂 + 模块 QA PASS gap 0）；改动待提交。
- 已完成（2026-09-22）：模块 08 UI 国际化开发交付（自研 composable + domains 字典拆分 + 全量硬编码迁移 + 设置页三态语言切换器；forge-ui typecheck/293 单测/浏览器三态验收全绿）。模块 09 Skill 管理代码交付：desktop 侧 `pi/skillService.ts` 四方法 RPC（list/import/create/delete，4090 冲突确认协议 + 影子扫描补报 + containment 防穿越）+ 15 单测（全套 272 过/1 skip），UI 侧 `SkillsSection.vue` 挂设置页「关于」Tab + mock-bridge 内存实现；浏览器 mock 链路全交互验收通过（建/冲突覆盖/删/导入/项目级落 `.agents/skills`/非法名保留输入）。e2e 连带修复：`playwright.config.ts` 钉 `locale=zh-CN`（否则 i18n system 偏好在 en-US 测试浏览器整页英文，打爆中文选择器），并修复 smoke（logo 化后的 `.workspace-brand` 存量挂）与 updater E-IN-001/002（`v0.2.0` 前缀存量挂）。全量 e2e **106/117**，剩余 11 条经 HEAD 干净基线 worktree 对照验证为逐条一致的存量挂（归属近期已提交的 logo/TitleBar/hero 重构，留待对应改动方修期望值），与 08/09 无关。**真机（Electron 实应用 + Windows 回收站 AC-09-10）待用户验收后翻状态为已完成**。
- 阻塞项：无（v1.1 范围待确认点见计划文档 §7）。
- 风险项：pi 扩展 API/SDK 覆盖度、ai-coding 前端改造量（多窗口为新开发 + fetch/SSE 改 IPC 适配）、pi 事件->CanonicalEvent 映射可行性（已补集成测试设计 `test/integration/pi-core.md`，开发期实现验证）、pi 多 AgentSession 并发（源码分析支持 + demo 已运行时验证 2 并发；纪律=每会话独立 ResourceLoader + forge 扩展禁用模块级可变状态；已补 PIC-003 真实并发集成用例）、pi 信任事件拦截可行性（待开发验证）；PRD 05 扩展的思考级别真实链路（PIC-005）与 1M 上下文运行时验证、PIC-006 子 agent 真实链路 **已于 2026-08-30 用户确认 OK**；forge-ui session 模块 2 条既有 e2e（E-SM-001/002）已修复（全量 41/41 通过）。
## 九、AI 开发约束

- **允许改动**：forge 自有代码（forge-core/desktop/ui/extensions）；docs/。
- **禁止改动**：pi 源码（`D:\work\aiwork\pi`，作 npm 依赖）；不 fork。
- **编码约束**：遵循 `docs/specs/`（vue.md / common/coding-style.md 等）；TypeScript；pi 扩展遵循 pi 扩展规范。
- **架构约束**：forge-core 不得引入 Electron 专有 API；Electron 逻辑仅限 forge-desktop。

## 十、文档事实来源

- 需求 → `docs/prd/`
- API → `docs/api/`
- 数据库 → `docs/db/`
- 技术规范 → `docs/specs/`
- 计划与状态 → `docs/plan/`
- 测试 → `docs/test/`
- 嵌入式讨论 → `docs/plan/embedded-agent-discussion.md`
