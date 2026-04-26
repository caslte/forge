# 认证机制详解

## 概述

本文档详细说明 ClaudeTask 的认证机制，包括三种 Token 类型、认证流程和适用场景。

---

## 三种 Token 类型

ClaudeTask 使用三种不同的 Token 来处理不同场景的认证：

| Token 类型 | 前缀 | 用途 | 有效期 |
|-----------|------|------|--------|
| JWT Cookie | - | 浏览器自动携带 | 30 天 |
| PAT (Personal Access Token) | `mul_` | CLI / API 调用 | 自定义 |
| Daemon Token | `mdt_` | Daemon 专用 | 自定义 |

---

## JWT Cookie

### 说明

JWT Cookie 是浏览器用户的主要认证方式。登录成功后，Server 通过 HttpOnly Cookie 设置 Token。

### 特性

| 属性 | 值 |
|------|-----|
| Cookie 名称 | `multica_auth` |
| 类型 | HttpOnly Cookie |
| 有效期 | 30 天 |
| 传输 | 自动随请求发送 |
| 作用域 | 整个域名 |

### 认证流程

```
用户登录 → Server 验证邮箱/密码 → 生成 JWT → 设置 Cookie → 请求自动携带
```

### 使用场景

- Web 浏览器访问
- Desktop App（自动使用 Cookie）

---

## PAT (Personal Access Token)

### 说明

PAT 用于 CLI、脚本和 API 集成场景。

### 特性

| 属性 | 值 |
|------|-----|
| 前缀 | `mul_` |
| 获取方式 | Settings 页面 / `multica login` |
| 存储位置 | `~/.multica/config.json` |
| 有效期 | 用户自定义（默认永不过期） |

### 使用方式

```bash
# CLI 使用
multica login --token "mul_xxxxx"

# API 请求
curl -H "X-Token: mul_xxxxx" https://api.example.com/issues
```

### 创建和管理

1. **通过 Web UI**：
   - Settings → Personal Access Tokens
   - 点击 "Create Token"
   - 设置名称和过期时间
   - 复制 Token（只显示一次）

2. **通过 CLI**：
```bash
# 登录即自动创建 Token
multica login
```

### 撤销 Token

```bash
# Web UI 操作
# Settings → Personal Access Tokens → Revoke
```

---

## Daemon Token

### 说明

Daemon Token 是 Daemon 与 Server 通信的专用凭证。

### 特性

| 属性 | 值 |
|------|-----|
| 前缀 | `mdt_` |
| 获取方式 | `multica daemon login` |
| 权限范围 | 仅限 Daemon API |
| 存储位置 | Daemon 本地配置 |

### 认证流程

```
Daemon 启动 → multica daemon login → Server 返回 Daemon Token → Daemon 存储并使用
```

### 使用方式

```bash
# 登录 Daemon
multica daemon login --server "https://api.example.com"

# Server 生成 Daemon Token 并返回
# Daemon 存储到本地配置
```

### 与 PAT 的区别

| 区别 | PAT | Daemon Token |
|------|-----|--------------|
| 适用对象 | 用户/脚本 | Daemon 服务 |
| 权限范围 | User API | Daemon API |
| 获取方式 | 用户主动创建 | Daemon 登录自动生成 |

---

## Token 适用矩阵

| 路由 | JWT Cookie | PAT | Daemon Token |
|------|------------|-----|--------------|
| `/api/user/*` | ✅ | ✅ | ❌ |
| `/api/workspaces/*` | ✅ | ✅ | ❌ |
| `/api/issues/*` | ✅ | ✅ | ❌ |
| `/api/agents/*` | ✅ | ✅ | ❌ |
| `/api/skills/*` | ✅ | ✅ | ❌ |
| `/api/chat/*` | ✅ | ✅ | ❌ |
| `/api/daemon/*` | ❌ | ✅ | ✅ |
| `/api/tasks/*` | ✅ | ✅ | ✅ |
| `/ws` | ✅ (Cookie) | ✅ (首条消息) | ❌ |

---

## 登录流程

### 邮箱 + 验证码登录

```
1. 用户输入邮箱 → Server 发送验证码到邮箱
2. 用户输入验证码 → Server 验证
3. 验证通过 → 创建/查找用户 → 生成 JWT → 设置 Cookie
```

### Google OAuth 登录

```
1. 用户点击 "Sign in with Google"
2. 重定向到 Google OAuth
3. 用户授权
4. Google 返回 Code → Server 交换 Access Token
5. Server 获取用户信息 → 创建/查找用户
6. 生成 JWT → 设置 Cookie
```

---

## 认证中间件

### 用户认证中间件

```go
// server/internal/middleware/auth.go

// 验证 JWT Cookie 或 PAT
func AuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        // 优先检查 Cookie
        if cookie, err := c.Cookie("multica_auth"); err == nil {
            // 验证 JWT
            claims := verifyJWT(cookie)
            c.Set("user", claims.User)
            c.Next()
            return
        }

        // 检查 X-Token Header (PAT)
        if token := c.GetHeader("X-Token"); token != "" {
            claims := verifyPAT(token)
            c.Set("user", claims.User)
            c.Next()
            return
        }

        // 无效 → 401
        c.AbortWithStatus(401)
    }
}
```

### Daemon 认证中间件

```go
// server/internal/middleware/daemon_auth.go

// 仅验证 Daemon Token
func DaemonAuthMiddleware() gin.HandlerFunc {
    return func(c *gin.Context) {
        token := c.GetHeader("X-Token")
        if !strings.HasPrefix(token, "mdt_") {
            c.AbortWithStatus(401)
            return
        }

        claims := verifyDaemonToken(token)
        c.Set("runtime", claims.Runtime)
        c.Next()
    }
}
```

---

## APP_ENV 与安全

### development 模式

```bash
APP_ENV=development
```

- JWT 验证宽松
- 验证码在日志中打印（方便调试）
- 允许 DEV_AUTH_BYPASS

### production 模式

```bash
APP_ENV=production
```

**⚠️ 重要配置：**

1. **JWT_SECRET 必须设置强随机值**
   ```bash
   # 生成强随机密钥
   openssl rand -base64 32
   ```

2. **验证码不再打印到日志**

3. **必须配置正确的 FRONTEND_ORIGIN**
   - 用于 Cookie 作用域
   - 用于 CORS 验证

---

## 常见问题

### Q: Token 过期后怎么办？

**A:**
- JWT Cookie：自动刷新或重新登录
- PAT：重新登录获取新 Token
- Daemon Token：`multica daemon login` 重新登录

### Q: 可以同时使用多个 Token 吗？

**A:** 可以。不同类型的 Token 用于不同场景，互不冲突。

### Q: Daemon Token 可以给用户使用吗？

**A:** 不可以。Daemon Token 只能访问 `/api/daemon/*` 路由，无法访问用户数据。

### Q: 如何撤销访问权限？

**A:**
- 撤销 PAT：在 Settings 页面 Revoke
- 踢出 Daemon：在 Workspace 设置中移除 Runtime
- 修改密码：所有 Token 失效

---

## 安全最佳实践

1. **生产环境必须设置强 JWT_SECRET**
   ```bash
   export JWT_SECRET="$(openssl rand -base64 32)"
   ```

2. **PAT 应该设置过期时间**
   - 建议 90 天
   - 定期轮换

3. **不要在代码中硬编码 Token**
   - 使用环境变量
   - 使用 Secret 管理工具

4. **最小权限原则**
   - API Token 只授权需要的路由
   - Daemon 只使用 Daemon Token

5. **日志中不要记录完整 Token**
   - 只记录 Token 前缀：`mul_xxxx...`

---

## Logout 行为

### 用户 Logout

```bash
multica auth logout
```

**执行的操作：**

1. 删除本地 PAT 存储
2. **不**撤销 Server 端的 JWT（依赖过期）

### Daemon Logout

```bash
multica daemon stop
```

**执行的操作：**

1. 停止 Daemon 进程
2. 删除本地 Daemon Token

---

## 认证 API

### POST /api/auth/login

邮箱验证码登录。

**请求：**
```json
{
  "email": "user@example.com"
}
```

**响应：**
```json
{
  "code": 0,
  "message": "验证码已发送"
}
```

### POST /api/auth/verify

验证验证码。

**请求：**
```json
{
  "email": "user@example.com",
  "code": "123456"
}
```

**响应：**
```json
{
  "code": 0,
  "message": "success"
}
```
*设置 HttpOnly Cookie*

### POST /api/auth/logout

登出。

**响应：**
```json
{
  "code": 0,
  "message": "success"
}
```

### GET /api/auth/status

检查认证状态。

**响应：**
```json
{
  "code": 0,
  "data": {
    "authenticated": true,
    "user": {
      "id": "xxx",
      "email": "user@example.com"
    }
  }
}
```
