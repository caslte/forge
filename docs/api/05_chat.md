# 对话功能 API

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/chat/sessions | 创建会话 |
| GET | /api/chat/sessions | 获取会话列表 |
| GET | /api/chat/sessions/:id | 获取会话详情 |
| PATCH | /api/chat/sessions/:id | 更新会话 |
| DELETE | /api/chat/sessions/:id | 删除会话 |
| POST | /api/chat/sessions/:id/messages | 发送消息 |
| GET | /api/chat/sessions/:id/messages | 获取消息历史 |

## WebSocket 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| chat:message | Server→Client | 流式消息 |
| chat:done | Server→Client | 消息完成 |
| chat:error | Server→Client | 执行错误 |

---

## 创建会话

### 请求

```http
POST /api/chat/sessions
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| agent_id | string | 是 | 助手 ID |
| title | string | 否 | 会话标题 |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "agent_id": "550e8400-e29b-41d4-a716-446655440001",
    "title": "Hello World",
    "status": "active",
    "session_id": "claude-session-uuid",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 404 | 助手不存在 | agent_id 不存在 |

---

## 获取会话列表

### 请求

```http
GET /api/chat/sessions?status=active&agent_id=xxx&page=1&page_size=20
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| status | string | 否 | 按状态筛选 (active/archived/deleted) |
| agent_id | string | 否 | 按助手筛选 |
| page | int | 否 | 页码，默认 1 |
| page_size | int | 否 | 每页数量，默认 20 |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "items": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440000",
        "agent_id": "550e8400-e29b-41d4-a716-446655440001",
        "title": "Hello World",
        "status": "active",
        "last_message_at": "2024-01-01T10:30:00Z"
      }
    ],
    "total": 10,
    "page": 1,
    "page_size": 20
  }
}
```

---

## 获取会话详情

### 请求

```http
GET /api/chat/sessions/:id
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "agent_id": "550e8400-e29b-41d4-a716-446655440001",
    "title": "Hello World",
    "status": "active",
    "session_id": "claude-session-uuid",
    "last_message_at": "2024-01-01T10:30:00Z",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

---

## 更新会话

### 请求

```http
PATCH /api/chat/sessions/:id
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| title | string | 否 | 会话标题 |
| status | string | 否 | 状态 (active/archived) |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

---

## 删除会话

### 请求

```http
DELETE /api/chat/sessions/:id
```

### 响应

```json
{
  "code": 0,
  "message": "success"
}
```

---

## 发送消息

### 请求

```http
POST /api/chat/sessions/:id/messages
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| content | string | 是 | 消息内容 (最长 50000 字符) |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440100",
    "chat_session_id": "550e8400-e29b-41d4-a716-446655440000",
    "role": "user",
    "content": "帮我写一个 Hello World 程序",
    "created_at": "2024-01-01T10:00:00Z"
  }
}
```

**流式响应通过 WebSocket 推送：**

```json
// chat:message
{
  "event": "chat:message",
  "data": {
    "type": "text",
    "content": "好的，我来帮你..."
  }
}

// chat:message (tool_use)
{
  "event": "chat:message",
  "data": {
    "type": "tool_use",
    "tool": "Write",
    "call_id": "call-123",
    "input": {"file_path": "hello.go", "content": "..."}
  }
}

// chat:done
{
  "event": "chat:done",
  "data": {
    "session_id": "claude-session-uuid",
    "usage": {
      "claude-opus-4-7": {
        "input_tokens": 1000,
        "output_tokens": 500
      }
    }
  }
}

// chat:error
{
  "event": "chat:error",
  "data": {
    "error": "执行超时"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 会话已归档 | status= archived |
| 404 | 会话不存在 | ID 不存在 |

---

## 获取消息历史

### 请求

```http
GET /api/chat/sessions/:id/messages?page=1&page_size=50
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
        "role": "user",
        "content": "帮我写一个 Hello World 程序",
        "created_at": "2024-01-01T10:00:00Z"
      },
      {
        "id": "550e8400-e29b-41d4-a716-446655440101",
        "role": "assistant",
        "content": "好的，我来帮你创建...",
        "created_at": "2024-01-01T10:00:01Z"
      }
    ],
    "total": 100,
    "page": 1,
    "page_size": 50
  }
}
```
