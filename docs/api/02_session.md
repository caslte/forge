# 会话管理 API

> 模块编号：02
> 来源：PRD 02（docs/prd/02_session_management.md）
> 状态：已确认
> 传输：Electron IPC（forge-ui -> forge-core）；headless 同契约（v2+）

---

## 1. 创建会话

### session/createSession

**说明**：在当前项目下新建 pi session（SM-S01）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| projectPath | string | 是 | 所属项目路径 |

响应：

```json
{
  "session": {
    "sessionId": "sess_xxx",
    "projectPath": "C:/dev/a",
    "alias": null,
    "lastActiveAt": "2026-08-08T10:00:00Z",
    "createdAt": "2026-08-08T10:00:00Z",
    "modelOverride": null
  }
}
```

---

## 2. 查询会话列表

### session/querySessionList

**说明**：返回全部会话（跨项目会话池，SM-S05），或按项目过滤。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| projectPath | string | 否 | 为空时返回所有项目的会话 |

响应：

```json
{
  "sessions": [
    {
      "sessionId": "sess_xxx",
      "projectPath": "C:/dev/a",
      "alias": "修复登录 bug",
      "lastActiveAt": "...",
      "createdAt": "...",
      "modelOverride": null,
      "status": "idle"
    }
  ]
}
```

---

## 3. 删除会话

### session/deleteSession

**说明**：硬删 pi session（不可逆，前端先二次确认）（SM-S03）。删除运行中会话时先停止其执行。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：`data: null`

**事件**：删除后发射 `session.removed`。

---

## 4. 重命名会话

### session/updateSessionAlias

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| alias | string | 是 | 新别名（非空） |

响应：更新后的会话对象。

---

## 5. 会话状态

### session/getSessionStatus

**说明**：查询会话当前运行状态（SM-S04 状态显示）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：

```json
{
  "status": "running",
  "runningCount": 3
}
```

`status`: `idle` / `running` / `done` / `error`

---

## 6. 多窗口会话订阅

### session/attachSessionWindow

**说明**：前端某窗口开始订阅会话输出（SM-S05）。forge-core 统一管理输出流，窗口按 sessionId 订阅；同一会话同一时间至多一个观察窗口（TD-SM-04）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：

```json
{
  "history": [ { "role": "user", "content": "..." } ],
  "status": "idle"
}
```

`history` 为 pi session 已有消息（历史加载，CV-S05 全量）。

### session/detachSessionWindow

**说明**：窗口关闭时摘除订阅（会话不删除）。

请求参数：`sessionId`。

响应：`data: null`。

---

## 7. 事件

### session.statusChanged

**触发**：任一会话状态变化。

```json
{
  "sessionId": "sess_xxx",
  "status": "running",
  "runningCount": 3
}
```

### session.removed

**触发**：会话删除完成。

```json
{ "sessionId": "sess_xxx" }
```

---

## 8. 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误 |
| 1002 | 会话不存在 / 项目不存在 |
| 1004 | 会话重复开窗（已有关注窗口） |
| 5000 | 内部错误 |