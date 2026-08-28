# 子 Agent 管理 API

> 模块编号：06
> 来源：PRD 06（docs/prd/06_subagent_management.md）
> 状态：已确认
> 传输：Electron IPC（方法 + 事件）；headless 同契约（v2+）
> 依赖：pi-subagents 扩展（`pi.events` 共享事件总线 + 跨扩展 RPC）。扩展缺失时本模块方法返回空数据、事件不产生（静默降级，PRD SA-F08）

---

## 0. 业务对象：Subagent

```json
{
  "agentId": "18154eb5-e14d-445",
  "agentType": "general-purpose",
  "description": "研究国产LLM定价",
  "status": "running",
  "startedAt": "2026-08-28T13:42:10.000Z",
  "finishedAt": null,
  "result": null,
  "usage": { "inputTokens": 1200, "outputTokens": 3400 }
}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| agentId | string | 扩展派生的子 agent 唯一 ID（幂等合并键） |
| agentType | string | agent 类型（如 general-purpose / Explore） |
| description | string | 描述（Tab 显示名，截断由前端处理） |
| status | string | `queued` / `running` / `completed` / `failed` / `stopped` |
| startedAt | string | 开始时间（ISO 8601） |
| finishedAt | string \| null | 结束时间（终态才有） |
| result | string \| null | 结果全文（completed 才有；failed 时为 null，错误信息走 error 字段） |
| error | string \| null | 失败/终止原因（终态非 completed 时有值） |
| usage | object | Token 用量（lifetime 累计；无产出时缺省） |

状态机：`queued → running → completed / failed / stopped`；终态不可逆（resume 场景扩展生成新 agentId）。

数据边界：子 agent 列表为 **forge-core 内存态**（按 sessionId 隔离，不持久化）。应用重启后为空（PRD TD-SA-05）。

---

## 1. 查询子 agent 列表

### subagent/queryList

**说明**：查询某会话的子 agent 内存态列表（SA-F01/SA-F03）。会话视图加载/切换时调用，用于重建 Tab 栏。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "subagents": [ { "agentId": "...", "status": "running", "...": "..." } ]
  }
}
```

- `subagents` 按展示顺序返回：运行中（queued/running）在前，终态按 finishedAt 倒序。
- 扩展缺失 / 会话无子 agent：`subagents: []`（不报错）。

| code | 说明 |
|------|------|
| 1001 | 参数错误（sessionId 缺失） |
| 1002 | 会话不存在 |

---

## 2. 终止单个子 agent

### subagent/stop

**说明**：终止一个排队中/运行中的子 agent（SA-F06，经扩展 RPC stop）。幂等：已终态的子 agent 重复终止直接返回成功。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| agentId | string | 是 | 子 agent ID |

响应：`data: null`。终止成功后扩展发出完成事件 → `subagent.updated`（status=`stopped`）推送给前端；主会话状态按活跃计数联动收敛（见第 4 节）。

| code | 说明 |
|------|------|
| 1001 | 参数错误 |
| 1002 | 子 agent 不存在（或已不在本会话列表中） |
| 5000 | 终止失败（扩展 RPC 出错；前端保留原状态可重试） |

---

## 3. 清除已完成

### subagent/clearFinished

**说明**：批量移除会话内全部终态（completed/failed/stopped）子 agent 的 UI 记录（SA-F03"清除已完成"按钮）。仅影响内存态列表，不影响扩展运行与消息流中的历史完成通知。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：

```json
{ "code": 0, "message": "success", "data": { "removed": ["id1", "id2"] } }
```

无终态记录时 `removed: []`。清除后触发 `subagent.removed` 事件（见下）。

---

## 4. 既有方法语义扩展（跨模块）

### conversation/cancelStream（模块 03，语义扩展）

**变更**：停止按钮触发的取消从"仅终止主 agent 本轮"扩展为**级联终止**（SA-F05）：

1. 终止主 agent 当前轮次（现有 abort 语义，保留已生成内容）；
2. 逐个终止该会话全部活跃（queued/running）子 agent（内部调用扩展 RPC，等价于逐个 `subagent/stop`）；
3. 主会话状态转 `done`。

请求/响应与错误码不变（见 `api/03_conversation.md`）。无活跃子 agent 时行为与原语义完全一致。重复调用幂等。

**失败处理**：级联中单个子 agent 终止失败重试一次，仍失败记日志并保留该子 agent 原状态（不阻塞其余终止与主轮停止）。

### conversation.statusChanged（模块 03，判定扩展）

**变更**：`done` 的进入判据从"主 agent 本轮结束"扩展为"主 agent 本轮结束 **且** 活跃子 agent 计数为 0"（SA-F02）。即：主 agent 本轮结束但仍有活跃子 agent 时，`done` **延迟发出**，直到计数归零或 30 分钟超时兜底触发。

- 事件结构与触发时机对前端透明（前端仍按收到 `done` 收尾）。
- 30 分钟兜底：活跃计数非零但连续 30 分钟无任何子 agent 事件更新 → 自动发 `done` 并记日志。

---

## 5. 事件（单向推送）

### subagent.updated

**触发**：子 agent 创建 / 状态变迁（created/started/completed/failed/终止）。前端按 agentId 幂等 upsert（SA-F01）。

```json
{
  "sessionId": "sess_xxx",
  "subagent": { "agentId": "18154eb5", "status": "running", "...": "..." }
}
```

携带该子 agent **完整记录**（非增量），前端整体替换同 ID 记录。终态记录后到字段不回退（`finishedAt`/`result` 一经设置不变）。

### subagent.removed

**触发**：`subagent/clearFinished` 执行后。

```json
{
  "sessionId": "sess_xxx",
  "agentIds": ["id1", "id2"]
}
```

前端移除对应 Tab；若被移除者正激活其结果视图，自动切回"主会话"（PRD AC-SA-015）。

---

## 6. 错误码汇总

| code | 说明 |
|------|------|
| 1001 | 参数错误（sessionId/agentId 缺失或非法） |
| 1002 | 会话不存在 / 子 agent 不存在 |
| 5000 | 内部错误（扩展 RPC 失败等） |

扩展缺失为**非错误路径**：`queryList` 返回空列表，`stop` 返回 1002，不产生 5xxx。

---

## 7. 时序示例（一次后台子 agent 全生命周期）

```
UI: conversation/sendMessage
    → 主 agent 调 Agent 工具(后台) → 扩展派生
E:  subagent.updated { status: "queued" }
E:  subagent.updated { status: "running" }
    → 主 agent 本轮结束（文字已推送完），但计数=1
    （不发 conversation.statusChanged done）
E:  subagent.updated { status: "completed", result, usage }
    → 计数=0 → 发 conversation.statusChanged { status: "done" }
E:  （扩展完成通知经 conversation.message 进消息流，模块 03 渲染）

—— 或用户中途点停止 ——
UI: conversation/cancelStream
    → 主轮 abort + 逐个 stop 活跃子 agent
E:  subagent.updated { status: "stopped" } ×N
E:  conversation.statusChanged { status: "done" }
```
