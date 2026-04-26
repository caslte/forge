# 任务管理 API

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/issues | 创建任务 |
| GET | /api/issues | 获取任务列表 |
| GET | /api/issues/:id | 获取任务详情 |
| PATCH | /api/issues/:id | 更新任务 |
| DELETE | /api/issues/:id | 删除任务 |
| POST | /api/issues/:id/dependencies | 添加依赖 |
| DELETE | /api/issues/:id/dependencies/:depId | 删除依赖 |
| GET | /api/issues/:id/tasks | 获取任务的执行历史 |

---

## 创建任务

### 请求

```http
POST /api/issues
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| title | string | 是 | 任务标题 (1-500 字符) |
| description | string | 否 | 任务描述 (最长 50000 字符) |
| status | string | 否 | 状态，默认 backlog |
| priority | string | 否 | 优先级，默认 none |
| assignee_id | string | 否 | 指派对象 ID |
| assignee_type | string | 否 | 指派类型 (agent/member) |
| due_date | string | 否 | 截止日期 (ISO 8601) |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "title": "实现用户登录功能",
    "description": "使用 JWT 实现用户登录",
    "status": "backlog",
    "priority": "high",
    "assignee_type": "agent",
    "assignee_id": "550e8400-e29b-41d4-a716-446655440001",
    "creator_type": "member",
    "creator_id": "550e8400-e29b-41d4-a716-446655440002",
    "position": 0,
    "due_date": "2024-12-31T23:59:59Z",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 标题不能为空 | title 为空 |
| 400 | 标题不能超过 500 字符 | title 过长 |
| 404 | 助手不存在 | assignee_id 不存在 |
| 500 | 服务器错误 | 内部错误 |

---

## 获取任务列表

### 请求

```http
GET /api/issues?status=backlog&priority=high&assignee_id=xxx&page=1&page_size=20
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| status | string | 否 | 按状态筛选 |
| priority | string | 否 | 按优先级筛选 |
| assignee_id | string | 否 | 按指派人筛选 |
| search | string | 否 | 按标题搜索 |
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
        "title": "实现用户登录功能",
        "status": "todo",
        "priority": "high",
        "assignee_type": "agent",
        "assignee_id": "550e8400-e29b-41d4-a716-446655440001",
        "due_date": "2024-12-31T23:59:59Z",
        "created_at": "2024-01-01T00:00:00Z"
      }
    ],
    "total": 100,
    "page": 1,
    "page_size": 20
  }
}
```

---

## 获取任务详情

### 请求

```http
GET /api/issues/:id
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "workspace_id": "00000000-0000-0000-0000-000000000000",
    "title": "实现用户登录功能",
    "description": "使用 JWT 实现用户登录",
    "status": "todo",
    "priority": "high",
    "assignee_type": "agent",
    "assignee_id": "550e8400-e29b-41d4-a716-446655440001",
    "creator_type": "member",
    "creator_id": "550e8400-e29b-41d4-a716-446655440002",
    "parent_issue_id": null,
    "position": 0,
    "due_date": "2024-12-31T23:59:59Z",
    "dependencies": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440010",
        "type": "blocked_by",
        "depends_on": {
          "id": "550e8400-e29b-41d4-a716-446655440011",
          "title": "数据库设计"
        }
      }
    ],
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 404 | 任务不存在 | ID 不存在 |

---

## 更新任务

### 请求

```http
PATCH /api/issues/:id
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| title | string | 否 | 任务标题 |
| description | string | 否 | 任务描述 |
| status | string | 否 | 状态 |
| priority | string | 否 | 优先级 |
| assignee_id | string | 否 | 指派对象 ID |
| assignee_type | string | 否 | 指派类型 |
| due_date | string | 否 | 截止日期 |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "status": "in_progress",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 已完成任务不可编辑 | status= done |
| 400 | 已取消任务不可编辑 | status= cancelled |
| 404 | 任务不存在 | ID 不存在 |

---

## 删除任务

### 请求

```http
DELETE /api/issues/:id
```

### 响应

```json
{
  "code": 0,
  "message": "success"
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 任务执行中，不可删除 | status= in_progress |
| 400 | 任务审核中，不可删除 | status= in_review |
| 404 | 任务不存在 | ID 不存在 |

---

## 添加依赖

### 请求

```http
POST /api/issues/:id/dependencies
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| depends_on_issue_id | string | 是 | 被依赖的任务 ID |
| type | string | 否 | 依赖类型，默认 blocks |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440010",
    "issue_id": "550e8400-e29b-41d4-a716-446655440000",
    "depends_on_issue_id": "550e8400-e29b-41d4-a716-446655440001",
    "type": "blocks",
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 不能创建循环依赖关系 | A→B→C→A |
| 400 | 任务不能依赖自己 | 自依赖 |
| 404 | 任务不存在 | ID 不存在 |

---

## 删除依赖

### 请求

```http
DELETE /api/issues/:id/dependencies/:depId
```

### 响应

```json
{
  "code": 0,
  "message": "success"
}
```

---

## 获取执行历史

### 请求

```http
GET /api/issues/:id/tasks
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440100",
      "status": "completed",
      "started_at": "2024-01-01T10:00:00Z",
      "completed_at": "2024-01-01T10:30:00Z",
      "duration_ms": 1800000,
      "output": "登录功能已实现",
      "error": null
    }
  ]
}
```
