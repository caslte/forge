# Daemon API

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/daemon/register | 注册 Daemon |
| POST | /api/daemon/heartbeat | 心跳保活 |
| GET | /api/tasks/claim | 领取任务 |
| POST | /api/tasks/:id/start | 开始任务执行 |
| POST | /api/tasks/:id/complete | 完成任务 |
| GET | /health | 健康检查 |

---

## 注册 Daemon

Daemon 启动时调用此接口注册。

### 请求

```http
POST /api/daemon/register
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| daemon_id | string | 是 | Daemon 唯一标识 (UUID) |
| legacy_daemon_ids | string[] | 否 | 历史 daemon_id 列表 |
| device_name | string | 是 | 设备名称 |
| runtime_name | string | 否 | Runtime 名称，默认 Local Agent |
| cli_version | string | 否 | multica CLI 版本 |
| agents | object | 是 | 可用代理配置 |

### agents 结构

```json
{
  "claude": {
    "path": "/usr/local/bin/claude",
    "model": "claude-opus-4-7"
  }
}
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "runtime_id": "550e8400-e29b-41d4-a716-446655440000",
    "server_version": "0.2.17"
  }
}
```

---

## 心跳保活

Daemon 每 15 秒调用一次。

### 请求

```http
POST /api/daemon/heartbeat
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| daemon_id | string | 是 | Daemon UUID |
| status | string | 是 | running/stopped/error |
| active_tasks | array | 是 | 当前活跃任务列表 |
| workspaces | string[] | 是 | 关联的工作空间 ID 列表 |

### active_tasks 结构

```json
[
  {
    "task_id": "550e8400-e29b-41d4-a716-446655440001",
    "agent_id": "550e8400-e29b-41d4-a716-446655440002",
    "started_at": "2024-01-01T10:00:00Z"
  }
]
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "timestamp": "2024-01-01T10:00:00Z"
  }
}
```

### Server 响应超时

如果 Server 超过 30 秒未收到心跳，会将 Daemon 标记为离线。

---

## 任务执行接口

任务执行相关接口见 [任务执行 API](./04_task_execution.md)

---

## 健康检查

### 请求

```http
GET /health
```

### 响应

```json
{
  "status": "healthy",
  "version": "0.2.17",
  "timestamp": "2024-01-01T00:00:00Z",
  "uptime_seconds": 3600,
  "active_tasks": 2,
  "memory_usage_mb": 128
}
```

### 异常响应

```json
{
  "status": "unhealthy",
  "error": "database connection failed"
}
```
