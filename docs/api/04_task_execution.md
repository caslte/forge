# 任务执行 API

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/tasks/claim | 领取任务 |
| POST | /api/tasks/:id/start | 开始任务执行 |
| POST | /api/tasks/:id/complete | 完成任务 |
| POST | /api/tasks/:id/fail | 任务失败 |
| POST | /api/tasks/:id/cancel | 取消任务 |
| GET | /api/tasks/:id/messages | 获取执行消息历史 |
| POST | /api/tasks/:id/messages | 发送执行消息 |

---

## 领取任务

Daemon 调用此接口领取待执行的任务。

### 请求

```http
GET /api/tasks/claim
X-Runtime-ID: daemon-uuid
X-Agent-ID: agent-uuid
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "agent_id": "550e8400-e29b-41d4-a716-446655440001",
    "issue_id": "550e8400-e29b-41d4-a716-446655440002",
    "status": "claimed",
    "priority": "high",
    "issue": {
      "id": "550e8400-e29b-41d4-a716-446655440002",
      "title": "实现用户登录功能",
      "description": "使用 JWT 实现...",
      "status": "in_progress",
      "priority": "high"
    },
    "workspace": {
      "id": "550e8400-e29b-41d4-a716-446655440003",
      "repos": [
        {
          "id": "repo-uuid",
          "url": "https://github.com/user/repo.git",
          "local_path": "~/projects/repo",
          "branch": "main"
        }
      ]
    },
    "agent": {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "name": "Code Agent",
      "instructions": "你是一个 Go 专家",
      "runtime_mode": "bypassPermissions",
      "model": "claude-opus-4-7"
    },
    "skills": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440010",
        "name": "Go 编程",
        "content": "# Go 编程技能...",
        "files": []
      }
    ]
  }
}
```

**无任务时响应：**

```json
{
  "code": 0,
  "message": "success",
  "data": null
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 助手不可用 | 助手状态非 idle |
| 400 | 达到并发上限 | 助手已达 max_concurrent_tasks |

---

## 开始任务执行

### 请求

```http
POST /api/tasks/:id/start
Content-Type: application/json
```

### 响应

```json
{
  "code": 0,
  "message": "success"
}
```

---

## 完成任务

### 请求

```http
POST /api/tasks/:id/complete
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| output | string | 是 | 执行输出 |
| session_id | string | 否 | Claude Session ID |
| usage | object | 否 | Token 用量 |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "completed",
    "completed_at": "2024-01-01T10:30:00Z",
    "duration_ms": 1800000
  }
}
```

---

## 任务失败

### 请求

```http
POST /api/tasks/:id/fail
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| error | string | 是 | 错误信息 |
| session_id | string | 否 | Claude Session ID |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "failed",
    "completed_at": "2024-01-01T10:30:00Z"
  }
}
```

---

## 取消任务

### 请求

```http
POST /api/tasks/:id/cancel
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "cancelled"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 任务已完成无法取消 | status= completed/failed |
| 404 | 任务不存在 | ID 不存在 |

---

## 获取执行消息历史

### 请求

```http
GET /api/tasks/:id/messages?page=1&page_size=100
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440100",
        "type": "text",
        "content": "好的，我来帮你实现...",
        "created_at": "2024-01-01T10:00:00Z"
      },
      {
        "id": "550e8400-e29b-41d4-a716-446655440101",
        "type": "tool_use",
        "tool": "Write",
        "call_id": "call-123",
        "input": {"file_path": "login.go", "content": "..."},
        "created_at": "2024-01-01T10:01:00Z"
      }
    ],
    "total": 50,
    "page": 1,
    "page_size": 100
  }
}
```

---

## 发送执行消息

### 请求

```http
POST /api/tasks/:id/messages
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| type | string | 是 | 消息类型 (text/tool_use/tool_result/log) |
| content | string | 否 | 消息内容 |
| tool | string | 否 | 工具名称 |
| call_id | string | 否 | 调用 ID |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440100",
    "created_at": "2024-01-01T10:00:00Z"
  }
}
```
