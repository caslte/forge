# pi 真实接入 P0 开发计划

> 目标：完成“真实项目 → 真实 pi 会话 → 发送消息 → 流式回复 → 持久化历史 → 可恢复会话”的最小可用闭环。  
> 原则：每个工作项按 TDD 推进；先打通主链路，再补异常分支和体验优化。

## P0-A：Session 创建接线

**状态：未开始**

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

### 验收

- 新建会话后 forge store 中没有 `mock-session-*`。
- 同一 sessionId 多次发送消息时复用同一个 pi session 文件。
- 重启应用后仍可通过 store 记录定位该 pi session 文件。
- desktop 相关回归通过。

## P0-B：对话状态与消息闭环

**状态：未开始**  
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

### 验收

- 真实 provider 下发送一条消息能看到流式输出。
- 正常完成后历史中有 user 与 assistant 消息。
- 无凭据时不崩溃，状态为 error 并显示明确提示。
- 取消后已生成的部分内容仍然显示。

## P0-C：历史读取接 pi JSONL

**状态：未开始**  
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

### 验收

- 发送过消息的会话重开后历史完整。
- 切换多个会话后历史互不串扰。
- 空 pi session 文件返回空历史且不报错。
- 损坏文件返回可读错误而不是崩溃。

## P0-D：模型选择传入 pi runtime

**状态：未开始**  
**依赖：P0-A / P0-B 主线完成后接入**

### 目标行为

1. 全局默认模型对新会话生效。
2. 会话级模型覆盖对下一轮对话生效。
3. 未配置或不可用模型时给出明确错误。

### 实现要点

- 将 forge 的 `defaultModel` / `session.modelOverride` 解析成 pi runtime 可识别的 model 对象。
- 需要兼容 pi `models.json` 中 provider 名称、协议类型、model id 的组合关系。
- 新会话在创建 `AgentSession` 时传入模型；运行中会话如 SDK 支持则热切换，否则下一轮生效。

### 验收

- 选择不同模型后发送消息使用目标模型。
- 清除会话覆盖后回落到全局默认模型。
- 删除或禁用当前默认模型时有明确错误，不静默失败。
