# 变更日志

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
