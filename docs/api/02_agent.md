# 助手配置 API

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/agents | 创建助手 |
| GET | /api/agents | 获取助手列表 |
| GET | /api/agents/:id | 获取助手详情 |
| PATCH | /api/agents/:id | 更新助手 |
| DELETE | /api/agents/:id | 删除助手 |
| GET | /api/agents/:id/skills | 获取助手关联的技能 |
| POST | /api/agents/:id/skills | 添加技能关联 |
| DELETE | /api/agents/:id/skills/:skillId | 移除技能关联 |

---

## 创建助手

### 请求

```http
POST /api/agents
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 助手名称 (1-100 字符) |
| instructions | string | 否 | 角色设定 (最长 50000 字符) |
| runtime_mode | string | 否 | 权限模式，默认 default |
| max_concurrent_tasks | int | 否 | 最大并发任务数，默认 1 |
| model | string | 否 | 指定模型 |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Code Agent",
    "instructions": "你是一个专业的后端开发工程师",
    "runtime_mode": "bypassPermissions",
    "status": "idle",
    "max_concurrent_tasks": 2,
    "model": "claude-opus-4-7",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 名称不能为空 | name 为空 |
| 409 | 助手名称已存在 | name 重复 |
| 500 | 服务器错误 | 内部错误 |

---

## 获取助手列表

### 请求

```http
GET /api/agents?status=idle&search=code&page=1&page_size=20
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| status | string | 否 | 按状态筛选 |
| search | string | 否 | 按名称搜索 |
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
        "name": "Code Agent",
        "runtime_mode": "bypassPermissions",
        "status": "idle",
        "max_concurrent_tasks": 2,
        "model": "claude-opus-4-7"
      }
    ],
    "total": 5,
    "page": 1,
    "page_size": 20
  }
}
```

---

## 获取助手详情

### 请求

```http
GET /api/agents/:id
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Code Agent",
    "instructions": "你是一个专业的后端开发工程师",
    "runtime_mode": "bypassPermissions",
    "status": "idle",
    "max_concurrent_tasks": 2,
    "model": "claude-opus-4-7",
    "skills": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440100",
        "name": "Go 编程",
        "position": 0
      }
    ],
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

---

## 更新助手

### 请求

```http
PATCH /api/agents/:id
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 否 | 助手名称 |
| instructions | string | 否 | 角色设定 |
| runtime_mode | string | 否 | 权限模式 |
| max_concurrent_tasks | int | 否 | 最大并发任务数 |
| model | string | 否 | 指定模型 |

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

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 工作中的助手不可编辑 | status= working |
| 409 | 助手名称已存在 | name 重复 |

---

## 删除助手

### 请求

```http
DELETE /api/agents/:id
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
| 400 | 工作中的助手不可删除 | status= working |
| 400 | 该助手有待执行任务 | 有待执行任务 |
| 404 | 助手不存在 | ID 不存在 |

---

## 获取助手关联的技能

### 请求

```http
GET /api/agents/:id/skills
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440100",
      "name": "Go 编程",
      "description": "Go 语言开发最佳实践",
      "position": 0
    }
  ]
}
```

---

## 添加技能关联

### 请求

```http
POST /api/agents/:id/skills
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| skill_id | string | 是 | 技能 ID |
| position | int | 否 | 排序位置，默认 0 |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "agent_id": "550e8400-e29b-41d4-a716-446655440000",
    "skill_id": "550e8400-e29b-41d4-a716-446655440100",
    "position": 0
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 404 | 技能不存在 | skill_id 不存在 |
| 409 | 该技能已关联 | 重复关联 |

---

## 移除技能关联

### 请求

```http
DELETE /api/agents/:id/skills/:skillId
```

### 响应

```json
{
  "code": 0,
  "message": "success"
}
```
