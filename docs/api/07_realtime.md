# 实时同步 API

## WebSocket 连接

### 连接建立

```http
WebSocket ws://localhost:8080/ws
```

连接时需要携带认证 Token 作为查询参数：

```
ws://localhost:8080/ws?token=xxx
```

### 连接成功响应

```json
{
  "type": "connected",
  "data": {
    "session_id": "ws-session-uuid"
  }
}
```

---

## 订阅管理

### 订阅

```json
{
  "action": "subscribe",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000",
  "token": "optional-task-access-token"
}
```

**Scope 类型：**

| Scope | 说明 | 权限 |
|-------|------|------|
| workspace:{id} | 工作空间所有事件 | 自动订阅 |
| user:{id} | 用户相关事件 | 自动订阅 |
| task:{id} | 特定任务事件 | 需要 token |
| chat:{id} | 特定会话事件 | 需要 token |

### 订阅响应

```json
{
  "action": "subscribed",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000"
}
```

### 取消订阅

```json
{
  "action": "unsubscribe",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000"
}
```

### 取消订阅响应

```json
{
  "action": "unsubscribed",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000"
}
```

---

## 事件类型

### 任务事件

| 事件 | Scope | 说明 |
|------|-------|------|
| issue:created | workspace | 任务创建 |
| issue:updated | workspace | 任务更新 |
| issue:deleted | workspace | 任务删除 |
| task:dispatch | workspace | 任务分发 |
| task:progress | workspace/task | 任务进度 |
| task:completed | workspace/task | 任务完成 |
| task:failed | workspace/task | 任务失败 |
| task:cancelled | workspace/task | 任务取消 |

### 助手事件

| 事件 | Scope | 说明 |
|------|-------|------|
| agent:status | workspace | 助手状态变更 |

### 对话事件

| 事件 | Scope | 说明 |
|------|-------|------|
| chat:message | chat | 对话消息 |
| chat:done | chat | 对话完成 |

---

## 事件消息格式

### 任务创建

```json
{
  "id": "ulid-xxx",
  "type": "issue:created",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "issue_id": "550e8400-e29b-41d4-a716-446655440001",
    "title": "新任务",
    "status": "backlog",
    "priority": "high",
    "created_by": "user-uuid"
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### 任务状态更新

```json
{
  "id": "ulid-xxx",
  "type": "issue:updated",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "issue_id": "550e8400-e29b-41d4-a716-446655440001",
    "status": "in_progress",
    "updated_by": "user-uuid"
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### 任务分发

```json
{
  "id": "ulid-xxx",
  "type": "task:dispatch",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440002",
    "issue_id": "550e8400-e29b-41d4-a716-446655440001",
    "agent_id": "550e8400-e29b-41d4-a716-446655440003"
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### 任务进度

```json
{
  "id": "ulid-xxx",
  "type": "task:progress",
  "scope": "task:550e8400-e29b-41d4-a716-446655440002",
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440002",
    "type": "text",
    "content": "正在实现登录功能..."
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

### 任务完成

```json
{
  "id": "ulid-xxx",
  "type": "task:completed",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "task_id": "550e8400-e29b-41d4-a716-446655440002",
    "issue_id": "550e8400-e29b-41d4-a716-446655440001",
    "duration_ms": 1800000,
    "output": "登录功能已实现"
  },
  "timestamp": "2024-01-01T00:30:00Z"
}
```

### 助手状态变更

```json
{
  "id": "ulid-xxx",
  "type": "agent:status",
  "scope": "workspace:550e8400-e29b-41d4-a716-446655440000",
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440003",
    "status": "working",
    "active_task_count": 1
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

---

## 心跳保活

### 服务端 Ping

```json
{
  "type": "ping"
}
```

### 客户端 Pong

```json
{
  "type": "pong"
}
```

---

## 错误处理

### 订阅失败

```json
{
  "action": "error",
  "error": "unauthorized",
  "message": "需要授权 token 才能订阅此 scope"
}
```

### 连接断开

```json
{
  "type": "disconnected",
  "reason": "ping_timeout"
}
```
