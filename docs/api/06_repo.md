# 仓库配置 API

## 接口列表

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/workspaces/:id/repos | 获取仓库列表 |
| POST | /api/workspaces/:id/repos | 添加仓库 |
| PATCH | /api/workspaces/:id/repos/:repoId | 更新仓库 |
| DELETE | /api/workspaces/:id/repos/:repoId | 删除仓库 |
| POST | /api/workspaces/:id/repos/:repoId/clone | 触发克隆 |

---

## 获取仓库列表

### 请求

```http
GET /api/workspaces/:id/repos
```

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": [
    {
      "id": "550e8400-e29b-41d4-a716-446655440000",
      "url": "https://github.com/user/myapp.git",
      "local_path": "~/projects/myapp",
      "branch": "main",
      "status": "active"
    }
  ]
}
```

---

## 添加仓库

### 请求

```http
POST /api/workspaces/:id/repos
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| url | string | 是 | Git 仓库 URL |
| local_path | string | 否 | 本地路径 (留空则自动推断) |
| branch | string | 否 | 默认分支，默认 main |

### 响应

```json
{
  "code": 0,
  "message": "success",
  "data": {
    "id": "550e8400-e29b-41d4-a716-446655440000",
    "url": "https://github.com/user/myapp.git",
    "local_path": "~/projects/myapp",
    "branch": "main",
    "status": "active"
  }
}
```

### 错误码

| code | message | 说明 |
|------|---------|------|
| 400 | 无效的 Git URL | url 格式错误 |
| 409 | 该仓库已配置 | url 重复 |
| 409 | 路径已被使用 | local_path 重复 |

---

## 更新仓库

### 请求

```http
PATCH /api/workspaces/:id/repos/:repoId
Content-Type: application/json
```

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| url | string | 否 | Git 仓库 URL |
| local_path | string | 否 | 本地路径 |
| branch | string | 否 | 默认分支 |

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

## 删除仓库

### 请求

```http
DELETE /api/workspaces/:id/repos/:repoId
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
| 400 | 该仓库有任务正在执行 | 有 in_progress 任务 |
| 404 | 仓库不存在 | repoId 不存在 |

---

## 触发克隆

### 请求

```http
POST /api/workspaces/:id/repos/:repoId/clone
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
| 400 | 仓库路径已存在 | 本地目录已存在 |
| 400 | 克隆失败 | git clone 失败 |
