# 环境变量规范

## 概述

本文档定义 ClaudeTask 所有环境变量的完整清单、默认值、用途说明。

---

## 变量分类总览

| 分类 | 必填 | 说明 |
|------|------|------|
| 基础配置 | ✅ | DATABASE_URL / PORT / JWT_SECRET |
| 应用模式 | ✅ | APP_ENV |
| 前端配置 | ✅ | FRONTEND_ORIGIN |
| Email | 条件 | RESEND_API_KEY（发送邮件时必填） |
| OAuth | 条件 | GOOGLE_CLIENT_ID / _SECRET（启用 Google 登录时） |
| Storage | 可选 | S3_BUCKET 等（默认本地存储） |
| Signup 控制 | 可选 | ALLOW_SIGNUP / ALLOWED_EMAIL_DOMAINS |

---

## 基础配置

### DATABASE_URL

| 属性 | 值 |
|------|-----|
| 必填 | ✅ |
| 默认值 | `postgres://postgres:postgres@localhost:5432/multica` |
| 格式 | `postgres://user:password@host:port/database` |
| 说明 | PostgreSQL 连接字符串 |

### PORT

| 属性 | 值 |
|------|-----|
| 必填 | ✅ |
| 默认值 | `8080` |
| 范围 | 1-65535 |
| 说明 | API 服务器监听端口 |

### JWT_SECRET

| 属性 | 值 |
|------|-----|
| 必填 | ✅ |
| 默认值 | 无（必须设置） |
| 长度要求 | 至少 32 字符 |
| 说明 | JWT 签名密钥，生产环境必须使用强随机字符串 |

### APP_ENV

| 属性 | 值 |
|------|-----|
| 必填 | ✅ |
| 可选值 | `development` / `production` |
| 默认值 | `development` |
| 说明 | 应用环境，影响认证逻辑和调试功能 |

> **⚠️ 重要**：生产环境必须设置为 `production`，否则验证码固定为 `888888`（安全风险）。

### FRONTEND_ORIGIN

| 属性 | 值 |
|------|-----|
| 必填 | ✅ |
| 示例 | `http://localhost:3000` |
| 说明 | 前端应用地址，用于 CORS 和重定向 |

---

## 数据库连接池

### DB_POOL_MAX

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `25` |
| 说明 | 最大连接池数量 |

### DB_POOL_MIN

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `5` |
| 说明 | 最小连接池数量 |

### DB_POOL_MAX_CONN_LIFETIME

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `1h` |
| 说明 | 连接最大生命周期 |

### DB_POOL_MAX_CONN_IDLE_TIME

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `30m` |
| 说明 | 空闲连接最大存活时间 |

---

## Email 配置

### RESEND_API_KEY

| 属性 | 值 |
|------|-----|
| 必填 | 条件（发送邮件时必填） |
| 说明 | Resend API Key，用于发送验证邮件 |
| 获取方式 | https://resend.com 注册获取 |

### EMAIL_FROM

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `noreply@localhost` |
| 说明 | 发件人地址 |

### EMAIL_DOMAIN

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 说明 | 邮件域名 |

> **注意**：如果未配置 RESEND_API_KEY，验证码邮件会打印到 stderr 而不发送。

---

## OAuth 配置

### GOOGLE_CLIENT_ID

| 属性 | 值 |
|------|-----|
| 必填 | 条件（启用 Google 登录时） |
| 说明 | Google OAuth 2.0 Client ID |
| 获取方式 | Google Cloud Console → APIs & Services → Credentials |

### GOOGLE_CLIENT_SECRET

| 属性 | 值 |
|------|-----|
| 必填 | 条件（启用 Google 登录时） |
| 说明 | Google OAuth 2.0 Client Secret |

### GOOGLE_REDIRECT_URI

| 属性 | 值 |
|------|-----|
| 必填 | 条件（启用 Google 登录时） |
| 默认值 | `{FRONTEND_ORIGIN}/api/auth/callback/google` |
| 说明 | OAuth 回调地址 |

---

## Storage 配置

### STORAGE_DRIVER

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `local` |
| 可选值 | `local` / `s3` |
| 说明 | 文件存储驱动 |

### STORAGE_LOCAL_PATH

| 属性 | 值 |
|------|-----|
| 必填 | 条件（STORAGE_DRIVER=local 时） |
| 默认值 | `./data/uploads` |
| 说明 | 本地存储路径 |

### S3_BUCKET

| 属性 | 值 |
|------|-----|
| 必填 | 条件（STORAGE_DRIVER=s3 时） |
| 说明 | S3 存储桶名称 |

### S3_REGION

| 属性 | 值 |
|------|-----|
| 必填 | 条件（STORAGE_DRIVER=s3 时） |
| 说明 | S3 区域 |

### S3_ENDPOINT

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 说明 | S3 兼容存储的 Endpoint（如 MinIO） |

### AWS_ACCESS_KEY_ID

| 属性 | 值 |
|------|-----|
| 必填 | 条件（STORAGE_DRIVER=s3 时） |
| 说明 | AWS Access Key |

### AWS_SECRET_ACCESS_KEY

| 属性 | 值 |
|------|-----|
| 必填 | 条件（STORAGE_DRIVER=s3 时） |
| 说明 | AWS Secret Key |

### S3_PUBLIC_URL

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 说明 | 公开访问的 URL 前缀 |

---

## Signup 控制

### ALLOW_SIGNUP

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `true` |
| 说明 | 是否允许用户自主注册 |

### ALLOWED_EMAIL_DOMAINS

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 示例 | `company.com,partner.com` |
| 说明 | 允许注册的邮箱域名（逗号分隔），为空则不限制 |

### ALLOWED_EMAILS

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 示例 | `admin@test.com,ceo@company.com` |
| 说明 | 精确允许的邮箱地址（逗号分隔），优先级最高 |

### 优先级规则

```
ALLOWED_EMAILS（精确邮箱） > ALLOWED_EMAIL_DOMAINS（域名） > ALLOW_SIGNUP（布尔开关）
```

---

## Agent 执行配置

### CLAUDE_CODE_PATH

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `claude` |
| 说明 | Claude Code CLI 路径 |

### DEFAULT_PERMISSION_MODE

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `default` |
| 可选值 | `bypassPermissions` / `clippings` / `default` |
| 说明 | 默认权限模式 |

### MAX_CONCURRENT_TASKS

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `20` |
| 说明 | Daemon 最大并发任务数 |

### TASK_DISPATCH_TIMEOUT

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `5m` |
| 说明 | 任务分发超时时间 |

### TASK_EXECUTION_TIMEOUT

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `2.5h` |
| 说明 | 任务执行超时时间 |

---

## Daemon 配置

### DAEMON_HEARTBEAT_INTERVAL

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `15s` |
| 说明 | 心跳发送间隔 |

### DAEMON_POLL_INTERVAL

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `3s` |
| 说明 | 任务轮询间隔 |

### DAEMON_OFFLINE_THRESHOLD

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `45s` |
| 说明 | 离线判定阈值（无心跳超过此时间则标记为离线） |

### GC_ENABLED

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `true` |
| 说明 | 是否启用垃圾回收 |

### GC_WORKSPACE_TTL

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `24h` |
| 说明 | 已完成任务工作目录 TTL |

### GC_ORPHAN_TTL

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `72h` |
| 说明 | 孤儿工作目录（任务被取消）TTL |

---

## WebSocket 配置

### WS_PING_INTERVAL

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `30s` |
| 说明 | WebSocket Ping 间隔 |

### WS_PONG_TIMEOUT

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `15s` |
| 说明 | WebSocket Pong 超时 |

### WS_MAX_MESSAGE_SIZE

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `65536` |
| 说明 | 最大消息大小（字节） |

---

## Session 配置

### SESSION_COOKIE_NAME

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `multica_auth` |
| 说明 | Session Cookie 名称 |

### SESSION_COOKIE_SECURE

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `true`（生产环境） |
| 说明 | Cookie 是否仅 HTTPS 传输 |

### SESSION_COOKIE_HTTP_ONLY

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `true` |
| 说明 | Cookie 是否仅 HTTP 获取 |

### SESSION_COOKIE_SAME_SITE

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `lax` |
| 可选值 | `strict` / `lax` / `none` |
| 说明 | Cookie SameSite 策略 |

---

## 日志配置

### LOG_LEVEL

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `info` |
| 可选值 | `debug` / `info` / `warn` / `error` |
| 说明 | 日志级别 |

### LOG_FORMAT

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `json` |
| 可选值 | `json` / `text` |
| 说明 | 日志格式 |

---

## 开发配置

### DEV_AUTH_BYPASS

| 属性 | 值 |
|------|-----|
| 必填 | ❌ |
| 默认值 | `false` |
| 说明 | 开发环境跳过认证（⚠️ 禁止生产环境使用） |

### DEV_ADMIN_TOKEN

| 属性 | 值 |
|------|-----|
| 必填 | 条件（DEV_AUTH_BYPASS=true 时） |
| 说明 | 开发环境管理员 Token |

---

## 环境变量文件

项目使用以下环境变量文件：

| 文件 | 优先级 | 说明 |
|------|--------|------|
| `.env` | 低 | 默认配置 |
| `.env.local` | 中 | 本地覆盖（不提交） |
| `.env.worktree` | 高 | Worktree 专用（自动生成） |

> **注意**：敏感信息（密码、密钥）不应提交到版本控制系统。
