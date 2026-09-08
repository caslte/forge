# PRD 模块索引

> 按模块快速定位 PRD。只维护目录与状态，详细业务内容写各模块 PRD。

## 模块清单

| 编号 | 模块名称 | 路径 | 状态 | 备注 |
|---|---|---|---|---|
| 01 | 项目管理 | prd/01_project_management.md | PRD 已确认 | 工作台入口；对齐 pi cwd；信任继承 pi；扩展 PM-S05 分支查看与切换（输入框项目区徽标+浮窗切换） |
| 02 | 会话管理 | prd/02_session_management.md | PRD 已确认 | 多会话并行；多窗口画布；复用 pi session |
| 03 | 对话与消息 | prd/03_conversation.md | PRD 已确认 | 流式响应、Markdown/Mermaid、取消、历史；扩展：会话历史导航 CV-S06（主会话时间线+浮窗预览+点击定位）、斜杠命令 CV-S08（输入 / 浮窗选择 pi 生态命令，codex 风格美化） |
| 04 | 工具执行展示 | prd/04_tool_execution.md | PRD 已确认 | tool 卡片、并排 Diff、状态流转 |
| 05 | 模型与 Provider 配置 | prd/05_model_provider.md | PRD 已确认 | models.json 可视化编辑、密钥安全、全局+会话模型；扩展：思考级别选择（输入框）、上下文 1M 配置 |
| 06 | 子 Agent 管理 | prd/06_subagent_management.md | PRD 已确认 | 主会话状态联动、Tab 栏+结果视图监控、停止级联/单个终止 |
| 07 | 版本更新与安装包（pi 运行时） | prd/07_installer_update.md | PRD 已确认 | 同一套完整更新体系：设置页「版本更新」分区（forge 版本 + 组件清单 + 手动更新，**已实现**）；Windows 安装包、首启静默预装推荐组件、应用自更新（GitHub Releases 提示+手动）、引擎-插件联动更新（**待开发**） |

## 状态说明

- `草稿-待确认`：第 1、2 节生成中，待用户确认
- `PRD 已确认`：第 3、4 节完成，可作为事实来源
- `开发中` / `已完成`：按开发进度更新

## 更新规则

- 新模块先写入 `docs/overview.md`，再更新本索引。
- 模块状态变化时同步更新两处与 `docs/changelog.md`。
