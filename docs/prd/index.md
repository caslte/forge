# PRD 模块索引

> 按模块快速定位 PRD。只维护目录与状态，详细业务内容写各模块 PRD。

## 模块清单

| 编号 | 模块名称 | 路径 | 状态 | 备注 |
|---|---|---|---|---|
| 01 | 项目管理 | prd/01_project_management.md | PRD 已确认 | 工作台入口；对齐 pi cwd；信任继承 pi；扩展 PM-S05 分支查看与切换（输入框项目区徽标+浮窗切换） |
| 02 | 会话管理 | prd/02_session_management.md | PRD 已确认 | 多会话并行；多窗口画布；复用 pi session；扩展 SM-S08 导出会话交接包（右键导出 ZIP＝仅原始完整转录一份不加旁挂元信息，零新增依赖自建打包器，落盘沿用「用户亲手选定路径」围栏） |
| 03 | 对话与消息 | prd/03_conversation.md | PRD 已确认 | 流式响应、Markdown/Mermaid、取消、历史；扩展：会话历史导航 CV-S06（主会话时间线+浮窗预览+点击定位）、斜杠命令 CV-S08（输入 / 浮窗选择 pi 生态命令，codex 风格美化）、消息队列 CV-S09（忙时入队+徽标）、输入历史翻阅 CV-S10（空输入 ↑/↓）、Todo 面板 CV-S11（输入框上方只读+折叠面板，复用 pi todo 工具 details 快照，依赖模块 04 TE-S05 IPC 透传） |
| 04 | 工具执行展示 | prd/04_tool_execution.md | PRD 已确认 | tool 卡片、并排 Diff、状态流转；扩展 TE-S05 tool.completed.result 增加可选 details 透传（为模块 03 CV-S11 等结构化消费场景提供 IPC 支撑） |
| 05 | 模型与 Provider 配置 | prd/05_model_provider.md | PRD 已确认 | models.json 可视化编辑、密钥安全、全局+会话模型；扩展：思考级别选择（输入框）、上下文 1M 配置 |
| 06 | 子 Agent 管理 | prd/06_subagent_management.md | PRD 已确认 | 主会话状态联动、Tab 栏+结果视图监控、停止级联/单个终止 |
| 07 | 版本更新与安装包（pi 运行时） | prd/07_installer_update.md | PRD 已确认 | 同一套完整更新体系：设置页「版本更新」分区（forge 版本 + 组件清单 + 手动更新，**已实现**）；Windows 安装包、首启静默预装推荐组件、应用自更新（GitHub Releases 提示+手动）、引擎-插件联动更新（**待开发**） |
| 08 | UI 国际化（中/英） | prd/08_ui_i18n.md | 已完成 | 自研轻量 composable，仅 UI 静态文案；zh-CN/en/跟随系统，localStorage 持久化，主进程零改动；2026-09-22 交付（typecheck/单测/浏览器三态验收通过） |
| 09 | Skill 管理 | prd/09_skill_management.md | 开发中 | 设置页 Skills 分区：列表（全局+项目级）、导入本地文件夹、模板新建、删除（回收站优先）；四方法 skill/* RPC；代码与单测/mock 链路已完成，真机（Electron 实应用 + Windows 回收站 AC-09-10）待验收 |
| 10 | 内嵌终端 | prd/10_embedded_terminal.md | PRD 已确认（待开工） | 底部面板多 tab 交互终端（xterm.js+node-pty）；新 tab cwd 自动跟随当前会话项目，tab 手动管理；工具栏图标+Ctrl+\` 入口；**前置风险：node-pty 原生模块 spike（TD-TM-01）**；demo 2026-09-23 验收通过 |
| 11 | Git 提交与推送 | prd/11_git_commit_push.md | PRD 已确认（待开工） | 提交或推送弹窗（全量语义，无"仅本会话"）：状态行+分支浮窗双入口、包含未暂存变更勾选、AI 生成=一次 chat/completions 调用复用 provider、push stderr 弹窗内回显；git/getStatus·commit·push·generateCommitMessage 四 RPC；demo 2026-09-23 验收通过 |
| 12 | 内置代码浏览器 | prd/12_code_explorer.md | **已交付**（2026-10-02 主体交付，多轮迭代至 v6.16） | 左栏整栏替换的只读代码浏览器：目录树懒加载 + 多签代码纸 + 布局 A/B（整屏覆盖/左右分割，窄窗自动降级）、签条跟随磁盘自动刷新、右键复制路径/外部编辑器打开；扩展：Git 变更视图 + 并排/行内 diff（§3.6，用户反馈驱动）；**git 提交历史视图归属本模块**（拟 CE-S11，见 3.7）；demo 2026-10-01 验收通过 |
| 13 | 快捷键 | prd/13_keyboard_shortcuts.md | PRD 已确认（待开工） | 设置页第 5 个 Tab：只读快捷键清单 4 组 16 行（布局 B、排 Skills 之后）；主修饰键抽象（Mac ⌘/其他 Ctrl，顺带修 ``⌘+` `` 在 Mac 失效）；新增 3 个全局键 `Ctrl+,` 设置 toggle、`Ctrl+B` 侧栏、`Ctrl+Shift+N` 新建会话；**本期不做改键**，零新增接口；demo 2026-10-08 定稿 |
| 14 | 首次使用指引蒙层 | prd/14_first_run_onboarding.md | **已交付**（2026-10-09，真机视觉验收待用户跑） | 六步分步聚光灯（形态 A，三形态 demo 后拍板）：会话树 → 目录视图 `<>` → 新建会话 → 终端 → 设置 → 侧栏更新入口；**仅全新安装首启自动弹一次**（主进程启动早期快照 `forge:startup-flags`，渲染层不可自行判定）；重看入口只放设置「关于」Tab；蒙层期间全部不可操作；锚点契约 = 真实元素 `data-onboarding` 标记，缺失自动剔步（mock 实测 5 步） |

## 状态说明

- `草稿-待确认`：第 1、2 节生成中，待用户确认
- `PRD 已确认`：第 3、4 节完成，可作为事实来源
- `开发中` / `已完成`：按开发进度更新

## 跨模块扩展索引

| 扩展 ID | 跨模块影响 | 承接模块 | 发起需求 |
|---|---|---|---|
| CV-S06 → 模块 03 | 纯前端派生，零新增接口 | 模块 03 自含 | ZCode 风格会话历史浮窗（2026-08-29） |
| CV-S08 → 模块 03 | 首个真实扩展经 forge-extensions 桥接 | 模块 03 + 03 扩展 | 输入 `/` 斜杠命令浮窗（2026-09-02） |
| CV-S09/CV-S10 → 模块 03 | 消息队列/输入历史，纯前端 | 模块 03 自含 | 输入框增强（2026-09-04） |
| **CV-S11 ↔ TE-S05** | **CV-S11 消费 TE-S05 透传的 details 字段** | **模块 03 + 模块 04** | **输入框上方 todo 面板（2026-09-10）** |
| 模块 12 ↔ 模块 11 | 代码树行尾复用 git/getStatus 变更集标注 M/A/D/U | 模块 12 + 11 | 内置代码浏览器（2026-10-01） |
| **CE-S11 → 模块 12** | **Git 提交历史视图：新增 git/getCommitLog·git/getCommitDetail·git/getCommitFileDiff 三 RPC（复用模块 11 的 gitService 底座，不新增写入语义）；UI 落在模块 12 左栏第三视图** | **模块 12 自含** | **Zed 同款提交历史浏览 + 提交人（2026-10-08，PRD 12 §3.7 / api/11 §6~§8）** |

## 更新规则

- 新模块先写入 `docs/overview.md`，再更新本索引。
- 模块状态变化时同步更新两处与 `docs/changelog.md`。
