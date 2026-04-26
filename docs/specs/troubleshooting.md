# 故障排查指南

## 概述

本文档提供 ClaudeTask 常见问题的排查和解决方案。

---

## 问题分类索引

| 问题类型 | 常见场景 |
|---------|---------|
| [Daemon 问题](#daemon-问题) | Daemon 连不上、任务不执行 |
| [认证问题](#认证问题) | 登录失败、Token 过期 |
| [任务问题](#任务问题) | 任务一直排队、执行失败 |
| [WebSocket 问题](#websocket-问题) | 实时推送不工作、重连失败 |
| [Email 问题](#email-问题) | 收不到验证码 |
| [数据库问题](#数据库问题) | 连接失败、迁移错误 |
| [部署问题](#部署问题) | 端口冲突、构建失败 |

---

## Daemon 问题

### Daemon 连不上 Server

**症状：** Daemon 日志显示连接失败或心跳无响应。

**可能原因：**

1. Token 过期或无效
2. Server 地址配置错误
3. 网络不通
4. Server 未运行

**排查步骤：**

```bash
# 1. 检查 Daemon 状态
multica daemon status

# 2. 检查 Server 地址配置
multica config --get server

# 3. 验证 Token 是否有效
multica auth status

# 4. 测试网络连通性
curl -I https://your-server.com/health
```

**解决方案：**

```bash
# 重新登录 Daemon
multica daemon login --server "https://your-server.com"
```

---

### 任务一直处于 queued 状态

**症状：** 任务创建后一直显示 queued，从不执行。

**可能原因：**

1. Runtime 离线（Daemon 未运行）
2. Agent 被归档
3. 最大并发任务数已满
4. 任务被其他任务阻塞

**排查步骤：**

```bash
# 1. 检查 Runtime 状态
multica runtime list

# 2. 检查 Agent 状态
multica agent list

# 3. 检查任务的依赖关系
multica issue get <issue-id>
```

**解决方案：**

```bash
# 启动 Daemon
multica daemon start

# 恢复归档的 Agent
multica agent restore <agent-slug>

# 取消阻塞任务
multica issue update <blocked-issue-id> --status todo
```

---

### 任务执行失败 (failed)

**症状：** 任务执行后状态变为 failed。

**排查步骤：**

```bash
# 查看任务详情
multica issue runs <issue-id>

# 查看任务消息（具体错误）
multica issue runs <issue-id> --messages
```

**常见错误及解决方案：**

| 错误类型 | 可能原因 | 解决方案 |
|---------|---------|---------|
| `runtime_offline` | Daemon 未运行 | 启动 Daemon |
| `timeout` | 执行超时 | 增加 TASK_EXECUTION_TIMEOUT |
| `permission_denied` | 权限模式不足 | 使用 bypassPermissions |
| `command_not_found` | Claude CLI 未安装 | 安装 Claude Code CLI |

---

### Daemon 频繁掉线

**症状：** Daemon 经常显示 offline。

**可能原因：**

1. 心跳间隔过长
2. 网络不稳定
3. Server 负载过高

**解决方案：**

```bash
# 设置较短的心跳间隔（默认 15s）
export DAEMON_HEARTBEAT_INTERVAL=10s
multica daemon start
```

---

## 认证问题

### 登录失败：验证码不正确

**症状：** 收到验证码但输入后提示错误。

**可能原因：**

1. APP_ENV=production 时验证码为固定值 888888（开发陷阱）
2. 验证码过期（5分钟）
3. 邮箱收到多个验证码

**⚠️ 重要：** 如果设置了 `APP_ENV=production` 但 JWT_SECRET 未正确配置，验证码将固定为 `888888`。

**排查步骤：**

```bash
# 检查 APP_ENV
echo $APP_ENV

# 检查 JWT_SECRET 是否设置
multica config --get jwt_secret
```

**解决方案：**

```bash
# 确认 APP_ENV 设置正确
# 生产环境应该 JWT_SECRET 使用强随机值

# 如果忘记 JWT_SECRET，需要重置
```

---

### Token 过期

**症状：** API 请求返回 401 Unauthorized。

**解决方案：**

```bash
# 重新登录
multica login
```

---

### 无法访问某些资源 (403 Forbidden)

**症状：** 对特定资源没有访问权限。

**可能原因：**

1. 不是 Workspace 成员
2. 权限不足（member vs admin）
3. Private Agent 只能 owner/admin 操作

**排查步骤：**

```bash
# 检查当前用户角色
multica workspace members
```

---

## 任务问题

### 任务依赖阻塞

**症状：** 任务一直等待，不执行。

**可能原因：**

1. 依赖的任务未完成
2. 依赖的任务被阻塞

**排查步骤：**

```bash
# 查看任务依赖
multica issue get <issue-id>

# 查看依赖的任务状态
multica issue list --status blocked
```

**解决方案：**

```bash
# 解除依赖
multica issue update <issue-id> --clear-dependencies

# 或者完成阻塞的任务
```

---

### 任务取消后不生效

**症状：** 取消任务后，Claude Code 进程仍在运行。

**解决方案：**

```bash
# 手动杀死进程
# Linux/macOS
pkill -f "claude.*task"

# Windows
taskkill /IM "claude.exe" /F
```

---

## WebSocket 问题

### WebSocket 连不上

**症状：** 页面不显示实时更新。

**可能原因：**

1. Cookie 被阻止
2. CORS 配置错误
3. 反向代理配置问题

**排查步骤：**

1. 打开浏览器开发者工具 → Console
2. 查看 WebSocket 连接错误信息

**解决方案：**

```bash
# 检查 FRONTEND_ORIGIN 配置
# 确保与浏览器访问地址一致

# 检查反向代理 WebSocket 支持
# Nginx 需要配置：
# proxy_http_version 1.1;
# proxy_set_header Upgrade $http_upgrade;
# proxy_set_header Connection "upgrade";
```

---

### WebSocket 自动重连失败

**症状：** 连接断开后不自动重连。

**可能原因：**

1. 最大重试次数已用完
2. 网络问题持续存在

**解决方案：** 刷新页面重新连接。

---

## Email 问题

### 收不到验证码邮件

**症状：** 登录时收不到验证码。

**可能原因：**

1. RESEND_API_KEY 未配置
2. 邮件被拦截
3. 邮箱地址错误

**排查步骤：**

```bash
# 检查 RESEND_API_KEY 是否配置
echo $RESEND_API_KEY

# 如果未配置，验证码会打印到 Server 日志
# 查看 Server 日志
tail -f server.log | grep "verification"
```

**解决方案：**

```bash
# 配置 Resend API Key
export RESEND_API_KEY="re_xxxxx"

# 重启 Server
```

---

## 数据库问题

### 数据库连接失败

**症状：** Server 启动时报连接错误。

**可能原因：**

1. PostgreSQL 未运行
2. DATABASE_URL 配置错误
3. 连接数已满

**排查步骤：**

```bash
# 检查 PostgreSQL 状态
pg_isready

# 测试连接
psql $DATABASE_URL
```

**解决方案：**

```bash
# 启动 PostgreSQL
# Docker
docker start postgres

# 或本地安装
pg_ctl start

# 检查连接池配置
export DB_POOL_MAX=10
```

---

### 迁移失败

**症状：** `make migrate-up` 报错。

**可能原因：**

1. 迁移文件冲突
2. 数据库版本不兼容

**排查步骤：**

```bash
# 查看迁移状态
make migrate-status

# 查看具体错误
make migrate-up 2>&1
```

**解决方案：**

```bash
# 回滚上一次迁移
make migrate-down

# 重新迁移
make migrate-up
```

---

## 部署问题

### 端口冲突

**症状：** Server 启动失败，提示端口被占用。

**解决方案：**

```bash
# 查找占用端口的进程
# Linux/macOS
lsof -i :8080

# Windows
netstat -ano | findstr :8080

# 结束进程或更换端口
export PORT=8081
```

---

### 构建失败 (make build)

**症状：** Go 构建报错。

**排查步骤：**

```bash
# 检查 Go 版本
go version  # 需要 1.26+

# 清理缓存
go clean -cache

# 重新构建
make build
```

---

### 前端构建失败

**症状：** pnpm build 报错。

**排查步骤：**

```bash
# 清理 node_modules
rm -rf node_modules

# 重新安装
pnpm install

# 重新构建
pnpm build
```

---

## 日志位置

| 组件 | 日志位置 | 查看方式 |
|------|---------|---------|
| Server | stdout / server.log | `tail -f server.log` |
| Daemon | stdout / daemon.log | `multica daemon logs --follow` |
| Frontend | Browser Console | F12 → Console |
| PostgreSQL | /var/log/postgresql/ | 系统日志 |

---

## 健康检查

### Server 健康检查

```bash
curl http://localhost:8080/health
# 期望响应：
# {"status":"healthy","timestamp":"..."}
```

### Daemon 健康检查

```bash
multica daemon status
# 期望输出：
# Daemon: running
# Runtime: connected
# Active tasks: 0
```

---

## 获取帮助

如果以上方案无法解决问题：

1. 收集诊断信息：
```bash
# Server 版本
multica version

# 配置信息（敏感信息除外）
multica config --get-all

# Daemon 日志
multica daemon logs --lines 100
```

2. 查看 [GitHub Issues](https://github.com/your-repo/issues)
3. 创建新 Issue 时附上诊断信息
