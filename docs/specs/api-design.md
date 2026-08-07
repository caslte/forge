# API 接口设计文档

> 所有后端 API 统一定义
> 技术栈：Python + FastAPI + PostgreSQL
> 统一响应格式：`{code, message, data}`

---

## 一、统一响应格式

所有 API 响应统一使用以下格式：

```typescript
interface ApiResponse<T> {
  code: number;           // 200=成功，其他=错误码
  message: string;        // 提示信息，如 "success" 或错误描述
  data: T;                // 数据载荷
}
```

**成功示例：**
```json
{
  "code": 200,
  "message": "success",
  "data": { "id": 1, "name": "示例资源" }
}
```

**失败示例：**
```json
{
  "code": 400,
  "message": "参数验证失败",
  "data": null
}
```

---

## 二、认证

### 认证方式：Bearer Token

```http
Authorization: Bearer <token>
```

---

## 三、用户模块（Users）

| 方法 | 路径 | 说明 | 认证 |
|-----|------|------|------|
| POST | `/api/users` | 创建用户 | 否 |
| POST | `/api/users/login` | 用户登录 | 否 |
| GET | `/api/users/current` | 获取当前用户信息 | 是 |
| PUT | `/api/users/current` | 更新当前用户信息 | 是 |

### 3.1 创建用户

```http
POST /api/users
```

**请求体：**
```json
{
  "nickname": "测试用户",
  "phone": "13800138000",
  "password": "password123"
}
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "nickname": "测试用户",
    "phone": "13800138000",
    "avatarUrl": null,
    "createdAt": "2026-02-17T10:00:00Z"
  }
}
```

### 3.2 用户登录

```http
POST /api/users/login
```

**请求体：**
```json
{
  "phone": "13800138000",
  "password": "password123"
}
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "token": "eyJhbGciOiJIUzI1NiIs...",
    "user": {
      "id": 1,
      "nickname": "测试用户"
    }
  }
}
```

---

## 四、资源模块（Resources）

| 方法 | 路径 | 说明 | 认证 |
|-----|------|------|------|
| POST | `/api/resources` | 创建资源 | 是 |
| GET | `/api/resources` | 获取资源列表 | 是 |
| GET | `/api/resources/{id}` | 获取资源详情 | 是 |
| PUT | `/api/resources/{id}` | 更新资源 | 是 |
| DELETE | `/api/resources/{id}` | 删除资源 | 是 |

### 4.1 创建资源

```http
POST /api/resources
```

**请求体：**
```json
{
  "name": "示例资源",
  "type": "standard",
  "description": "资源说明"
}
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "name": "示例资源",
    "type": "standard",
    "status": "active",
    "createdAt": "2026-02-17T10:00:00Z"
  }
}
```

### 4.2 获取资源列表

```http
GET /api/resources?page=1&pageSize=20
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "items": [
      {
        "id": 1,
        "name": "示例资源",
        "type": "standard",
        "status": "active"
      }
    ],
    "total": 1,
    "page": 1,
    "pageSize": 20
  }
}
```

---

## 五、任务模块（Tasks）

| 方法 | 路径 | 说明 | 认证 |
|-----|------|------|------|
| POST | `/api/resources/{resourceId}/tasks` | 创建任务 | 是 |
| GET | `/api/resources/{resourceId}/tasks` | 获取任务列表 | 是 |
| PUT | `/api/tasks/{taskId}` | 更新任务 | 是 |
| POST | `/api/tasks/{taskId}/complete` | 标记任务完成 | 是 |

### 5.1 创建任务

```http
POST /api/resources/{resourceId}/tasks
```

**请求体：**
```json
{
  "title": "示例任务",
  "plannedDate": "2026-03-15",
  "priority": "normal"
}
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "resourceId": 1,
    "title": "示例任务",
    "status": "pending",
    "plannedDate": "2026-03-15"
  }
}
```

### 5.2 标记任务完成

```http
POST /api/tasks/{taskId}/complete
```

**请求体：**
```json
{
  "completedAt": "2026-03-15T10:00:00Z",
  "remark": "处理完成"
}
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "status": "done",
    "completedAt": "2026-03-15T10:00:00Z"
  }
}
```

---

## 六、记录模块（Records）

| 方法 | 路径 | 说明 | 认证 |
|-----|------|------|------|
| POST | `/api/resources/{resourceId}/records` | 创建记录 | 是 |
| GET | `/api/resources/{resourceId}/records` | 获取记录列表 | 是 |
| GET | `/api/records/{id}` | 获取单条记录 | 是 |
| PUT | `/api/records/{id}` | 更新记录 | 是 |
| DELETE | `/api/records/{id}` | 删除记录 | 是 |

### 6.1 创建记录

```http
POST /api/resources/{resourceId}/records
```

**请求体：**
```json
{
  "title": "示例记录",
  "content": "记录内容",
  "recordDate": "2026-02-17",
  "tags": ["示例", "测试"]
}
```

**响应：**
```json
{
  "code": 200,
  "message": "success",
  "data": {
    "id": 1,
    "resourceId": 1,
    "title": "示例记录",
    "content": "记录内容",
    "recordDate": "2026-02-17",
    "tags": ["示例", "测试"],
    "createdAt": "2026-02-17T10:00:00Z"
  }
}
```

---

## 七、错误码定义

| Code | 说明 |
|------|------|
| 200 | 成功 |
| 400 | 参数验证失败 |
| 401 | 未登录 / Token 失效 |
| 403 | 无权限 |
| 404 | 资源不存在 |
| 409 | 状态冲突 |
| 500 | 服务器内部错误 |
