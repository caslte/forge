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

### PIC-005 思考级别真实集成（getSupportedThinkingLevels / clampThinkingLevel / setThinkingLevel）

- **关联**：模块 05 MP-S05（AC-MP-010/011/013/019 的 pi 真实层，不得全 mock）| **优先级**：P0 | **自动化等级**：real-integration
- **前置**：forge-core + 真实 pi（`@earendil-works/pi-coding-agent`），models.json 含 reasoning 模型与非推理模型各一
- **数据**：受控 provider 模型 A（reasoning=true，thinkingLevelMap 显式含 max）、模型 B（reasoning=false）
- **操作**：
  1. resolve 模型 A/B -> 调 `getSupportedThinkingLevels`：A 返回含 max 的完整列表；B 返回仅 `["off"]`
  2. 对 A 请求越界级别（如 xhigh 但模型不支持）-> `clampThinkingLevel` 就近收敛到可用级别
  3. 会话创建携带思考级别 -> `AgentSession.setThinkingLevel(level)` -> 断言会话 JSONL 出现 `thinking_level_change` 条目
  4. 重启/重开会话 -> 断言 thinkingLevel 恢复（会话级持久化）
  5. 配置模型 contextWindow=1000000 后新建会话 -> 断言上下文窗口上限按 1000000（contextUsage/压缩阈值）
- **断言**：
  - 级别列表与模型 reasoning/thinkingLevelMap 语义完全一致（**不硬编码**）
  - clamp 结果落在可用列表内且为最近级别
  - setThinkingLevel 真实持久化，重启返回语义正确；会话间级别不串扰（并发 2 会话各设不同级别互不影响）
  - contextWindow=1000000 生效于运行时上下文计算
  - 负向：非推理模型不得产生非 off 请求；非法/越界级别不崩溃
- **健康**：无未捕获异常、无吞错返回 success
- **证据**：级别列表日志 + 会话 JSONL thinking_level_change 条目 + 上下文用量上报

---

### PIC-006 子 agent 真实事件链路（eventBus 注入 / 生命周期映射 / 真实终止）

- **关联**：模块 06（AC-SA-001/002/003/004/016/024 的 pi 真实层，不得全 mock）| **优先级**：P0 | **自动化等级**：real-integration
- **前置**：forge-core + 真实 pi + `@tintinweb/pi-subagents` 扩展（`~/.pi/agent/npm`）；会话经 forge 工厂创建且注入共享 eventBus
- **数据**：一个可快速完成的子 agent 任务（如"回复 ok"）+ 一个可终止的长任务
- **操作**：
  1. 主 agent 派生后台子 agent → 断言 forge 侧订阅到 created/started 事件，记录进入会话内存态（ID/类型/描述正确）
  2. 等待其完成 → 断言 completed 事件与 result/usage 落位，活跃计数归零，会话 done 判据放行
  3. 派生长任务后经扩展 RPC stop → 断言 stopped 事件到达、记录终态、计数收敛
  4. 同一会话连续派生 2 个子 agent 并行 → 事件无丢/无乱序/无串扰（扩展并发上限内）
  5. 未注入 pi-subagents 的环境（临时移除扩展路径）→ queryList 空、无事件、无报错（AC-SA-024 真实层）
- **断言**：
  - 扩展 `pi.events` 事件与 forge 内存态一一对应（无丢事件/无错映射/无乱序收敛失败）
  - 终止后主会话状态按门控收敛；真实完成通知经 followUp 进入会话消息
  - 负向：终止不存在 ID 返回约定错误码不崩
- **健康**：无未捕获异常、无吞错返回 success
- **证据**：事件日志时序 + 注册表快照 + 会话 JSONL（子 agent 会话文件由扩展生成）

---

## 3. 覆盖汇总

| 用例 | 集成点 | 优先级 | 自动化等级 | 关键断言 |
|---|---|---|---|---|
| PIC-001 | 事件映射完整性 | P0 | real-integration | 无丢/无错/无乱序 |
| PIC-002 | AgentSession 生命周期 | P0 | real-integration | 创建/停止/删除/释放正确 |
| PIC-003 | 多会话真实并发 | P0 | real-integration | 无串扰/隔离/完整 |
| PIC-004 | 后端健康+契约 | P0 | real-integration | 无吞错/契约完整 |
| PIC-005 | 思考级别真实链路 | P0 | real-integration | 级别列表一致/持久化恢复/并发隔离/1M 上下文 |
| PIC-006 | 子 agent 真实事件链路 | P0 | real-integration | 事件无丢/无乱序/状态收敛/终止生效/缺失降级 |

> 注：本文件是跨模块集成设计，不并入任一模块 coverage-matrix；各模块矩阵的 A-* 契约用例与之互补（矩阵测契约、本文测真实映射）。