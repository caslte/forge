# pi 真实接入开发进度

> 更新时间：2026-08-25  
> 范围：pi 真实接入与 MVP 剩余开发（P0–P3）  
> 结论：P0 全部完成并修复集成接线缺口；P1 全部完成；P2（信任接 pi / 安全 Markdown / Mermaid / 异常恢复）全部完成；P3（上下文用量与压缩 / 附件 / 多窗口打磨 / DPAPI 密钥安全）全部完成。P0–P3 二十二个工作项全部落实。

## 已完成

| 项目 | 状态 | 说明 |
|---|---|---|
| 安装 pi SDK | 已完成 | `@earendil-works/pi-coding-agent@0.84.3` |
| 对话事件适配器 | 已完成 | 新增 `PiConversationAdapter`，映射 `message_update` 增量、`message_end` 助手消息、取消 `abort()` |
| 取消保留文本 | 已完成 | 当前增量文本保留在适配器内存中，可查询 |
| pi 会话工厂 | 已完成 | 新增 `createPiAgentSessionFactory`，按项目 cwd 创建或恢复 pi session 文件 |
| session ID 映射 | 已完成 | forge session ID 映射为 `forge-<forgeSessionId>` 的 pi session 文件 ID |
| 桌面内核接线 | 已完成 | `createForgeCore` 默认使用真实 pi 工厂；测试可注入 mock 工厂隔离 |
| 回归验证 | 已完成 | core 217 / 217 测试通过；desktop 52 / 52 测试和 typecheck 通过；UI build 通过 |
| P0-A Session 创建接线 | 已完成 | 新增真实 `PiSessionAdapter` 并替换默认 mock session 适配器 |
| P0-B 对话状态与消息闭环 | 已完成（含修复） | streaming 改为发送前置位；`setEventHandlers` 统一接线 delta/message/done/error |
| P0-C 历史读取接 pi JSONL | 已完成（含修复） | JSONL 优先，无文件时回退内存 transcript（含 user）；损坏文件统一可读错误仍需手工样本补充 |
| P0-D 模型选择传入 pi runtime | 已完成（含修复） | 会话覆盖/全局默认解析后随发送链路传入 pi factory；新增 `piAgentDir` 注入隔离真实凭据 |

相关实现：

- `packages/forge-desktop/src/pi/piConversationAdapter.ts`
- `packages/forge-desktop/src/pi/createPiAgentSessionFactory.ts`
- `packages/forge-desktop/src/createForgeCore.ts`
- `packages/forge-desktop/test/pi/piConversationAdapter.test.ts`
- `packages/forge-desktop/test/pi/createPiAgentSessionFactory.test.ts`

## 未完成总览

详细拆分见：

- `docs/plan/pi-integration-p0.md`
- `docs/plan/pi-integration-roadmap.md`
- `docs/plan/pi-integration-parallel.md`

| 编号 | 工作项 | 当前状态 | 阻塞点 | 优先级 |
|---|---|---|---|---|
| P0-A | Session 创建接线 | 已完成 | 无 | P0 |
| P0-B | 对话状态与消息闭环 | 已完成 | 真实 provider 手工验收待内测执行 | P0 |
| P0-C | 历史读取接 pi JSONL | 已完成 | 损坏文件统一可读错误仍需手工样本补充 | P0 |
| P0-D | 模型选择传入 pi runtime | 已完成 | 运行中热切换未实现，当前按新一轮请求生效 | P0 |
| P1-A | 工具事件真实映射 | 已完成 | adapter 映射 tool_execution_start/end → ToolApi 状态机 + tool.started/completed/error 事件 | P1 |
| P1-B | edit 工具并排 Diff | 已完成 | core `buildSideBySideDiff` 纯函数 + DiffView.vue 并排渲染、200 行截断展开；UI 载荷对齐嵌套 tool.input | P1 |
| P1-C | 模型选择真实生效验证 | 已完成 | `resolvePiModel`（SDK ModelRuntime）解析 models.json；工厂创建注入 + 运行中 setModel 热切换（不支持则重建）；未配置抛稳定错误 | P1 |
| P1-D | 多会话并行与历史隔离 | 已完成 | 同会话 lease 复用（工厂单次调用）；双会话并发交错集成测试验证事件/历史按 sessionId 隔离 | P1 |
| P2-A | 项目信任机制接 pi | 已完成 | pi `ProjectTrustStore` 权威（get/setDecision + 资源检测），forge store 仅缓存；openProject 1005 → TrustAskDialog 信任/拒绝/信任一次；桌面适配器 + core 注入 + UI 弹窗均实现 | P2 |
| P2-B | Markdown 安全渲染与代码高亮 | 已完成 | forge-core `renderMarkdown`（marked + hljs 高亮 + sanitize-html 白名单，禁原生 HTML/危险协议）；增量渲染 `renderMarkdownPartial`（流式低成本）；15 条 XSS/结构回归测试 | P2 |
| P2-C | Mermaid 渲染 | 已完成 | MessageCard 流式结束后识别 mermaid 块 → MermaidBlock 组件（mermaid 11，securityLevel=strict），失败降级显示原文+错误 | P2 |
| P2-D | 异常、状态一致性与恢复 | 已完成 | provider 未配置（models 空）禁止发送返回 1004；损坏 JSONL 可读错误；重启后经 resolveSessionFile 恢复磁盘历史；删除会话先 removeSession（abort+dispose lease）；统一错误码 | P2 |
| P3-A | 上下文用量与压缩入口 | 已完成 | adapter `getContextUsage`/`compact`（SDK AgentSession 能力）+ IPC `conversation/getContextUsage`/`compact`；InstructionInput 用量百分比 + 阈值警告 + 压缩按钮（失败提示不破坏历史） | P3 |
| P3-B | 附件输入 | 已完成 | dialog/selectFiles（图片转 base64 + 文本 utf8，大小限制）；sendMessage attachments → adapter 转 pi image content / 文本受控片段；Input 待发区可移除、失败提示重试；测试覆盖 | P3 |
| P3-C | 多窗口布局打磨 | 已完成 | 布局 localStorage 持久化（重进恢复+clamp）；会话删除自动关窗；最小尺寸 180×120 clamp；吸附/4 窗格/最小尺寸抽为 forge-core `windowLayout` 纯模块 + 8 条几何测试（E-SM-005 核心断言）；窗口组件异常可从会话池重开（数据在 core） | P3 |
| P3-D | 密钥安全增强 | 已完成 | `SafeStorageKeychainAdapter`（Electron safeStorage，Windows DPAPI）加密落盘 + 启动 restoreEnv 回填 env（models.json 保持 $ENV_VAR 引用）；配置变更审计日志（无密钥载荷）；适配器 5 测 + 审计 2 测 | P3 |

## 关键风险

1. ~~**真实 provider 内测尚未执行**~~：**已基本解除（2026-08-30 用户确认）**——真实 provider 对话可正常进行；PIC-005（思考级别真实链路 + 1M 上下文运行时）与 PIC-006（子 agent 真实事件链路）一并确认 OK。
2. **损坏 session 文件的完整样本不足**：解析器依赖 pi 校验，需补充真实损坏文件样本验证 UI 反馈。（列入 v1.1 收尾，见 `forge-v1.1-plan.md` Q-01）
3. **多会话并发状态未验收**：工厂支持创建多个 session，P1-D 双会话并发集成测试已通过；剩真实环境下并发隔离人工验收（PIC-003）。（列入 v1.1 收尾，见 `forge-v1.1-plan.md` Q-02）
