# pi-core 集成测试设计（跨模块）

> 模块：forge-core（跨 02/03/04 的 pi 集成层）
> 状态：已确认
> 触发：contract §B2 集成完整性——pi 事件→CanonicalEvent 映射、AgentSession 生命周期、真实并发，不得只用 mock 冒充。
> 说明：本设计覆盖各模块 coverage-matrix 里"pi 事件契约"的**真实映射层**（矩阵多把 pi 当 mock，本文件补真实集成）。矩阵 A-* 积案仍保留作契约层用例。

---

## 0. 目标与边界

- **目标**：验证 forge-core 与 pi SDK 的真实集成——pi 事件能否完整、正确、不乱序地映射为 `CanonicalEvent` 并驱动前端；AgentSession 生命周期正确；多会话真实并发不串扰。
- **边界**：本文件只测 forge-core + pi SDK 集成层与真实并发，不覆盖前端 UI（前端在模块矩阵/e2e）。
- **依赖**：真实 pi（`@earendil-works/pi-coding-agent`）、真实模型 API（或可注入的受控 provider）。
- **健康断言（必含）**：每个用例无未捕获异常、无吞错返回 success、无静默失败。

---

## 1. 集成点清单

| 集成点 | pi 侧 | forge-core 侧 | 映射结果 |
|---|---|---|---|
| 会话创建 | `createAgentSession({model, cwd})` | 每会话一个 AgentSession + 独立 ResourceLoader | AgentSession 就绪 |
| 发消息 | `session.prompt()` | 订阅事件 -> CanonicalEvent | 流式 assistant 消息 |
| 工具调用 | `tool_call`/`tool_execution_start/end` 事件 | 映射为工具卡片事件 | 工具卡片渲染数据 |
| 中断 | abort/取消 | 停止当前 turn | 保留已生成 + 状态 idle |
| 会话删除 | dispose + 删 pi session | 停止 AgentSession + 清元数据 | 资源释放 |
| 模型切换 | 更换 model | 下一轮用新模型 | 生效 |

---

## 2. 测试设计

### PIC-001 pi 事件→CanonicalEvent 映射完整性

- **关联**：模块 03/04 事件契约 | **优先级**：P0 | **自动化等级**：real-integration（真实 pi，受控模型）
- **前置**：forge-core 就绪，受控 provider（可注入固定 token 流 + 固定工具调用序列）
- **数据**：预置一则会话，受控模型按固定序列产出：text_delta ×N → tool_call(read) → tool_result → text_delta
- **操作**：
  1. 前：订阅 forge-core 的 CanonicalEvent 流
  2. 中：`session.prompt("触发工具调用")`
  3. 后：收集全部 CanonicalEvent
- **断言**：
  - **无丢**：pi 产生的每个事件（message_update/tool_call/tool_result/agent_end）都有对应 CanonicalEvent
  - **无错**：每个 CanonicalEvent 的字段（toolName/input/result/oldText/newText）与 pi 事件一致
  - **无乱序**：text→tool_call→tool_result→text 顺序保持；toolEventId 关联正确
  - **负向**：无未映射事件静默丢弃、无错映射（如 tool 事件被当文本）
- **健康**：无未捕获异常、无吞错
- **证据**：事件流日志（pi 侧 vs CanonicalEvent 侧对照）

### PIC-002 AgentSession 生命周期正确

- **关联**：模块 02 会话生命周期 | **优先级**：P0 | **自动化等级**：real-integration
- **前置**：forge-core + 真实 pi SessionManager（持久化）
- **操作**：
  1. 创建会话 -> 断言 AgentSession 就绪、pi session 落盘
  2. 运行中删除会话 -> 断言先 stop 再 dispose、pi session 删除、无残留进程/句柄
  3. 取消 -> 断言 turn 停止、可再 prompt
- **断言**：
  - 创建/删除/取消各状态流转合法
  - 删除运行中会话先停止再释放；无 AgentSession 泄漏（dispose 被调用）
  - 负向：未 stop 直接删被拦截；取消不丢已生成
- **健康**：无未捕获异常
- **证据**：生命周期日志 + 资源计数（dispose 次数）

### PIC-003 多 AgentSession 真实并发（非 mock）

- **关联**：AC-SM-008（≤10 并发）| **优先级**：P0 | **自动化等级**：real-integration
- **前置**：forge-core + 真实 pi，2~3 个独立 AgentSession（各自独立 ResourceLoader/SessionManager），受控模型或真实模型
- **操作**：
  1. 前：并发创建 N（2~3）个 AgentSession
  2. 中：`Promise.all` 同时 prompt 各会话
  3. 后：收集各会话事件
- **断言**：
  - 各会话输出流独立，**无串扰**（A 不出现 B 的 token/事件）
  - 各会话事件总线隔离（每会话独立 ResourceLoader）
  - N 个并发都完整完成；无全局状态冲突/未捕获异常
  - 负向：无共享状态污染、无事件泄露跨会话
- **健康**：无未捕获异常、无进程崩
- **证据**：并发事件流（按 sessionId 分离）+ 资源占用
- **前置参考**：meeting-room demo 已运行时验证 2 并发（`plan/meeting-room-concept.md`），本用例作为正式集成验收。

### PIC-004 后端健康与契约完整性（横切）

- **关联**：contract §B2 后端健康/契约完整性 | **优先级**：P0 | **自动化等级**：real-integration
- **覆盖**：
  - 合法输入各 IPC 方法：响应结构对、错误码对、不返回 5xx、成功须有数据落地+副作用
  - 非法输入：返回约定错误码（1001/1002/1004/1005），不崩、不吞错
  - 无静默失败：成功即真实生效（如"保存成功"必有数据落库）
- **证据**：方法级契约测试 + 错误码矩阵

---

## 3. 覆盖汇总

| 用例 | 集成点 | 优先级 | 自动化等级 | 关键断言 |
|---|---|---|---|---|
| PIC-001 | 事件映射完整性 | P0 | real-integration | 无丢/无错/无乱序 |
| PIC-002 | AgentSession 生命周期 | P0 | real-integration | 创建/停止/删除/释放正确 |
| PIC-003 | 多会话真实并发 | P0 | real-integration | 无串扰/隔离/完整 |
| PIC-004 | 后端健康+契约 | P0 | real-integration | 无吞错/契约完整 |

> 注：本文件是跨模块集成设计，不并入任一模块 coverage-matrix；各模块矩阵的 A-* 契约用例与之互补（矩阵测契约、本文测真实映射）。