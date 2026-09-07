# pi isStreaming 置位前的 preflight 窗口：忙时分流不能只看 isStreaming

- 日期：2026-09-09 ｜ 来源：v3.47 消息队列不稳定（徽标不出现/在途轮被误杀）
- 适用：所有「pi AgentSession 忙时入队、闲时直发」类分流逻辑（forge CV-S09 及任何类似托管）

## 反直觉根因

pi 的 `AgentSession.prompt()` 直发路径在 `_runAgentPrompt` 第一行才置位 `_isAgentRunActive`（即 `isStreaming`）。在此之前有一段 preflight 窗口，全部是 await：

1. 扩展 `input` 钩子（`emitInput`）
2. 鉴权校验 `checkAuth`（凭据未缓存时含**网络往返**，可达数秒）
3. 压缩预检 `_checkCompaction`（文件 IO）
4. `before_agent_start` 扩展钩子

窗口期间 `isStreaming === false`，但轮次马上就要开始。此时只看 `isStreaming` 分流，会把窗口内到达的消息误判为"闲时"走直发：

- 误重置在途轮次状态（partialContent 等）
- 二次 `prompt()` 与启动中的轮次相撞：pi 在窗口关闭后抛 `Agent is already processing` → 适配器的"撞车自愈"反手 `abort()` **误杀在途轮**；或两条 `_runAgentPrompt` 并发交错

用户习惯（首条发出后立即补发分段指令）极易命中，表现为"队列不稳定、经常看不到"。

## 修复模式（直发提交门）

适配器维护 `pendingSubmit: Map<sessionId, Promise<void>>`：

- **登记**：直发路径同步登记（先于 factory/preflight 首个 await，保证并发消息可见）
- **放行**：pi `prompt(text, { preflightResult: cb })` 的 `preflightResult` 回调（提交完成/预检失败均触发）提前放行；异常与收尾路径兜底放行（resolve 幂等 + Map 删除守卫）
- **等待**：同会话后续 `sendMessage` 循环 `await pendingSubmit`（循环重读，防等待者相继触发新直发的时序交错）后，再按 `isStreaming` 分流
- 时序保证：`preflightResult(true)` 与 `_isAgentRunActive = true` 在同一同步批次内完成，等待者微任务恢复时 `isStreaming` 已为 true → 正确走 followUp

## 关键辨析

- **等待后必须重读状态**而非沿用入口快照：提交失败（鉴权错）后等待者应走直发重建。
- **不能反过来无脑 followUp**：pi 空闲时 `followUp()` 只入队不触发轮次，消息会永久滞留——所以"等提交再分流"是唯一正确姿势。
- `preflightResult` 是 pi AgentSession 的公开 PromptOptions（agent-session.d.ts），扩展命令 handled 也回调 true（无轮次启动），等待者按 isStreaming 重判即可兼容。
