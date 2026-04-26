# 技能管理 API

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/skills | 创建技能 |
| GET | /api/skills | 获取技能列表 |
| GET | /api/skills/:id | 获取技能详情 |
| PATCH | /api/skills/:id | 更新技能 |
| DELETE | /api/skills/:id | 删除技能 |
| POST | /api/skills/:id/files | 添加附件文件 |
| GET | /api/skills/:id/files | 获取附件列表 |
| DELETE | /api/skills/:id/files/:fileId | 删除附件文件 |

---

## 创建技能

### 请求

```http
POST /api/skills
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 是 | 技能名称 (1-200 字符) |
| description | string | 否 | 技能描述 (最长 2000 字符) |
| content | string | 是 | SKILL.md 内容 (最长 500000 字符) |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Go 编程",
    "description": "Go 语言开发最佳实践",
    "content": "# Go 编程技能\n\n## 概述\n你是一个 Go 语言专家...",
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 名称不能为空 | name 为空 |
| 400 | 内容不能为空 | content 为空 |
| 409 | 技能名称已存在 | name 重复 |

---

## 获取技能列表

### 请求

```http
GET /api/skills?search=go&page=1&page_size=20
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
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
        "name": "Go 编程",
        "description": "Go 语言开发最佳实践",
        "agent_count": 2
      }
    ],
    "total": 10,
    "page": 1,
    "page_size": 20
  }
}
```

---

## 获取技能详情

### 请求

```http
GET /api/skills/:id
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "name": "Go 编程",
    "description": "Go 语言开发最佳实践",
    "content": "# Go 编程技能\n\n## 概述\n你是一个 Go 语言专家...",
    "files": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440001",
        "path": "examples/hello.go",
        "size": 1024
      }
    ],
    "agents": [
      {
        "id": "550e8400-e29b-41d4-a716-446655440010",
        "name": "Code Agent"
      }
    ],
    "created_at": "2024-01-01T00:00:00Z",
    "updated_at": "2024-01-01T00:00:00Z"
  }
}
```

---

## 更新技能

### 请求

```http
PATCH /api/skills/:id
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 否 | 技能名称 |
| description | string | 否 | 技能描述 |
| content | string | 否 | SKILL.md 内容 |

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
| 409 | 技能名称已存在 | name 重复 |

---

## 删除技能

### 请求

```http
DELETE /api/skills/:id
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
| 400 | 该技能已关联到 N 个助手 | 有关联助手 |
| 404 | 技能不存在 | ID 不存在 |

---

## 添加附件文件

### 请求

```http
POST /api/skills/:id/files
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 文件路径 (相对于技能目录) |
| content | string | 是 | 文件内容 |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440001",
    "skill_id": "550e8400-e29b-41d4-a716-446655440000",
    "path": "examples/hello.go",
    "size": 1024,
    "created_at": "2024-01-01T00:00:00Z"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 路径不能为空 | path 为空 |
| 409 | 该路径已存在 | path 重复 |

---

## 获取附件列表

### 请求

```http
GET /api/skills/:id/files
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440001",
      "path": "examples/hello.go",
      "size": 1024,
      "created_at": "2024-01-01T00:00:00Z"
    }
  ]
}
```

---

## 删除附件文件

### 请求

```http
DELETE /api/skills/:id/files/:fileId
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
| 404 | 文件不存在 | fileId 不存在 |
