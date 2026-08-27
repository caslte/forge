# pi 真实接入 P0 开发计划

> 目标：完成“真实项目 → 真实 pi 会话 → 发送消息 → 流式回复 → 持久化历史 → 可恢复会话”的最小可用闭环。  
> 原则：每个工作项按 TDD 推进；先打通主链路，再补异常分支和体验优化。

## P0-A：Session 创建接线

**状态：已完成**

### 目标行为

1. UI 调用 `session/createSession` 后，不再生成 `mock-session-*`。
2. forge 生成稳定、合法的 session ID。
3. `SessionRecord.projectPath` 继续保存在 forge store，作为对话时的 cwd 来源。
4. 对话工厂能根据 `sessionId + projectPath` 创建或恢复对应 pi session 文件。

### 实现要点

- 新增或替换现有 `MockPiSessionAdapter` 为可注入的真实 session ID 生成器。
- `SessionService.createSession(projectPath)` 只负责：
  - 规范化项目路径
  - 生成 forge session ID
  - 写入 forge store
- 不在创建阶段强制实例化 `AgentSession`，首次发送消息时懒加载即可。
- `PiConversationAdapter.sendMessage()` 必须拿到同一份 `SessionRecord.projectPath`。
- 新增真实 `PiSessionAdapter`，只生成 forge session ID；不提前实例化 pi 会话。
- `createForgeCore` 的 session 服务改用该适配器。

### 验收

- 新建会话后 forge store 中没有 `mock-session-*`。
- 同一 sessionId 多次发送消息时复用同一个 pi session 文件。
- 重启应用后仍可通过 store 记录定位该 pi session 文件。
- desktop 相关回归通过。

### 当前验证

2026-08-25：新增 adapter 测试先行失败后实现；desktop 回归 19 / 19 通过，typecheck 通过。

## P0-B：对话状态与消息闭环

**状态：已完成**  
**依赖：P0-A**

### 目标行为

1. 发送前进入 `streaming`。
2. pi 正常结束后进入 `done`，并推送完整 assistant 消息。
3. pi 报错或无模型凭据时进入 `error`，保留已有增量文本。
4. 取消调用 pi `abort()`，进入 `canceled` 或等价空闲状态，不丢弃已生成内容。

### 实现要点

- 在 `PiConversationAdapter` 中订阅并映射：
  - `agent_start`
  - `message_update`
  - `message_end`
  - `agent_settled`
  - 错误事件
- 将适配器回调接到 `ConversationService.setStatus()` 和 `ConversationApi.emitMessage()`。
- 禁止 UI 在 streaming 中重复发送。
- 错误信息转换为用户可理解的提示，例如缺少 API key、provider 配置错误。
- `ConversationService` 在 streaming 中拒绝重复发送，并透传 runtime options。
- `PiConversationAdapter` 发送异常时映射用户可读错误，保留已有增量文本。
- `createForgeCore` 将错误接入 `error` 状态与 `conversation.error` 事件。

### 验收

- 真实 provider 下发送一条消息能看到流式输出。
- 正常完成后历史中有 user 与 assistant 消息。
- 无凭据时不崩溃，状态为 error 并显示明确提示。
- 取消后已生成的部分内容仍然显示。

### 当前验证

2026-08-25：新增重复发送、发送异常和增量保留测试先行失败后实现；core 173 / 173，desktop 24 / 24 通过。

## P0-C：历史读取接 pi JSONL

**状态：已完成**  
**并行性：可在 P0-A 后与 P0-B 部分并行**

### 目标行为

1. 打开会话时从持久化 pi session 文件加载完整消息历史。
2. 至少支持 user、assistant 两类消息。
3. tool 消息可以先保持占位，但不能导致渲染失败。
4. 历史顺序稳定，重启后不丢失。

### 实现要点

- 使用 pi `SessionManager.open()` + `buildContextEntries()` 读取结构化 entries。
- 将 entry 映射为 `ConversationMessage`。
- 不直接解析 JSONL 字符串作为首选方案，优先复用 pi 的解析器。
- 需要区分“当前活跃分支”的历史，避免把所有分支都渲染进主对话流。
- 新增 `loadPiSessionHistory()`，复用 pi `SessionManager.open()` 和 `buildContextEntries()`。
- `PiConversationAdapter` 记录 session 文件路径，历史优先从 JSONL 活跃分支加载。

### 验收

- 发送过消息的会话重开后历史完整。
- 切换多个会话后历史互不串扰。
- 空 pi session 文件返回空历史且不报错。
- 损坏文件返回可读错误而不是崩溃。

### 当前验证

2026-08-25：新增活跃分支、tool 占位、空文件测试先行失败后实现；desktop 24 / 24 通过。

## P0-D：模型选择传入 pi runtime

**状态：已完成**  
**依赖：P0-A / P0-B 主线完成后接入**

### 目标行为

1. 全局默认模型对新会话生效。
2. 会话级模型覆盖对下一轮对话生效。
3. 未配置或不可用模型时给出明确错误。

### 实现要点

- 将 forge 的 `defaultModel` / `session.modelOverride` 解析成 pi runtime 可识别的 model 对象。
- 需要兼容 pi `models.json` 中 provider 名称、协议类型、model id 的组合关系。
- 新会话在创建 `AgentSession` 时传入模型；运行中会话如 SDK 支持则热切换，否则下一轮生效。
- `conversation/sendMessage` 通过 `resolveSendOptions()` 解析会话 cwd 和生效模型后传给 adapter/runtime。
- 会话覆盖优先于全局默认模型；未配置模型时继续由 pi 默认选择并按凭据错误反馈。

### 验收

- 选择不同模型后发送消息使用目标模型。
- 清除会话覆盖后回落到全局默认模型。
- 删除或禁用当前默认模型时有明确错误，不静默失败。

### 当前验证

2026-08-25：新增端到端测试验证 provider 默认模型传入 pi factory options；desktop 24 / 24、typecheck 通过。
