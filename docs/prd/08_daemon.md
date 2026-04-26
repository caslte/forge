# 模块八：后台服务（Daemon）

## 模块概述

### 业务目标
作为本地后台进程，负责任务轮询领取、Claude Code CLI 进程管理、工作环境准备和垃圾回收。

### 核心职责
- 任务轮询与领取
- Claude Code CLI 进程管理
- 工作环境准备与清理
- 心跳保活
- 垃圾回收

### 涉及角色
- 系统（自动运行）

### 前置条件
- Claude Code CLI 已安装
- Server 已启动

---

## 模块边界

### 上游模块
| 模块 | 输入 |
|------|------|
| Server | 任务队列、心跳响应 |
| 任务管理 | 任务创建/状态变更 |

### 下游模块
| 模块 | 输出 |
|------|------|
| Server | 任务状态更新、执行结果 |

### 数据边界
- 每个 Daemon 有唯一标识
- Daemon 状态通过心跳更新

### 职责边界
- 本模块不负责 Claude Code CLI 的安装
- 本模块不负责任务的创建和指派

---

## 核心流程与状态

### Daemon 架构

```
┌─────────────────────────────────────────────────────────────────┐
│  Daemon 架构                                                     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│  Daemon 进程                                                     │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  pollLoop() │  │heartbeat() │  │  gcLoop()   │              │
│  │  任务轮询    │  │  心跳保活   │  │  垃圾回收   │              │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘              │
│         │               │               │                       │
│         └───────────────┼───────────────┘                       │
│                         │                                       │
│                  ┌──────▼──────┐                               │
│                  │Task Handler │                               │
│                  │  任务执行   │                               │
│                  └──────┬──────┘                               │
│                         │                                       │
│                  ┌──────▼──────┐                               │
│                  │Claude Code  │                               │
│                  │    CLI      │                               │
│                  └─────────────┘                               │
└─────────────────────────────────────────────────────────────────┘
                         │
                         │ HTTP / WebSocket
                         │
                         ▼
┌─────────────────────────────────────────────────────────────────┐
│  Server                                                           │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐              │
│  │  Issue API  │  │  Task API   │  │  Agent API  │              │
│  └─────────────┘  └─────────────┘  └─────────────┘              │
└─────────────────────────────────────────────────────────────────┘
```

### 核心循环

#### pollLoop - 任务轮询

```
┌─────────────────────────────────────────────────────────────────┐
│  pollLoop()                                                      │
│  每 3 秒执行                                                     │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │ 1. GET /api/tasks/claim (携带 Runtime-ID, Agent-ID)    │    │
│  │ 2. 检查响应                                               │    │
│  │      │                                                   │    │
│  │      ├── 有任务 → 执行任务                                 │    │
│  │      │      │                                             │    │
│  │      │      ├── 准备工作目录                               │    │
│  │      │      ├── POST /api/tasks/:id/start                │    │
│  │      │      ├── 启动 Claude Code CLI                      │    │
│  │      │      ├── 循环推送进度 WS                           │    │
│  │      │      ├── POST /api/tasks/:id/complete             │    │
│  │      │      └── 清理工作目录（如配置）                     │    │
│  │      │                                                   │    │
│  │      └── 无任务 → 等待                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

#### heartbeat - 心跳保活

```
┌─────────────────────────────────────────────────────────────────┐
│  heartbeat()                                                     │
│  每 15 秒执行                                                    │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  POST /api/daemon/heartbeat                             │    │
│  │  Payload: {                                              │    │
│  │    daemon_id,                                           │    │
│  │    device_name,                                         │    │
│  │    runtime_name,                                        │    │
│  │    status: "running",                                  │    │
│  │    active_tasks: [...],                                 │    │
│  │    workspaces: [...]                                    │    │
│  │  }                                                      │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

#### gcLoop - 垃圾回收

```
┌─────────────────────────────────────────────────────────────────┐
│  gcLoop()                                                        │
│  每 1 小时执行                                                   │
│  ┌─────────────────────────────────────────────────────────┐    │
│  │  遍历 ~/multica_workspaces/                             │    │
│  │       │                                                   │    │
│  │       ├── 检查任务状态                                   │    │
│  │       │     │                                             │    │
│  │       │     ├── done/cancelled → 超过 24h TTL → 删除    │    │
│  │       │     │                                             │    │
│  │       │     └── orphan（无 meta 文件）→ 超过 72h TTL → 删除│    │
│  │       │                                                   │    │
│  │       └── 记录清理结果                                     │    │
│  └─────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────┘
```

---

## 功能点

### 功能 1：Daemon 注册

**功能目标/解决的问题**
Daemon 启动时向 Server 注册，建立身份。

**前置条件**
- Daemon 首次启动

**业务规则**
- 生成唯一 Daemon ID（UUID）
- 存储 Daemon ID 到本地文件
- 后续启动复用已有 ID

**交互流程**
1. Daemon 启动
2. 检查本地是否有 daemon.id 文件
3. 有则读取，无则生成新 UUID
4. POST /api/daemon/register
5. Server 返回注册结果

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 注册成功 | 单元测试 | 首次启动 | - |
| ID 复用 | 单元测试 | 重启后 ID 一致 | - |

---

### 功能 2：任务轮询

**功能目标/解决的问题**
自动发现并领取待执行的任务。

**前置条件**
- Daemon 已注册
- 有可用的助手

**业务规则**
- 每 3 秒轮询一次
- 按优先级和创建时间排序
- 检查助手并发数限制
- 领取成功后才停止轮询该任务

**交互流程**
1. 定时器触发
2. GET /api/tasks/claim
3. 处理响应

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 轮询正常 | E2E | 观察日志 | - |
| 领取正确 | 单元测试 | 领取优先级最高的 | 同优先级按时间 |
| 并发限制 | 单元测试 | 助手满载时不再领取 | max=1 |

---

### 功能 3：任务执行

**功能目标/解决的问题**
实际运行 Claude Code CLI 执行任务。

**前置条件**
- 任务已领取

**业务规则**
- 任务在独立工作目录执行
- 复用 Claude Code Session 保持上下文
- 支持 Task Handler 并发执行

**交互流程**
1. 准备工作目录
2. 启动 Claude Code CLI
3. 处理流式输出
4. 收集结果
5. 上报完成状态

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 执行完整 | E2E | 简单任务完整执行 | - |
| 并发执行 | E2E | 多任务同时执行 | 3+ 任务 |
| 超时处理 | 单元测试 | 任务超时 | 2h 超时 |

---

### 功能 4：心跳保活

**功能目标/解决的问题**
让 Server 知道 Daemon 存活状态。

**前置条件**
- Daemon 已注册

**业务规则**
- 每 15 秒发送一次
- 报告当前活跃任务数
- Server 超时未收则标记 Daemon 离线

**交互流程**
1. 定时器触发
2. POST /api/daemon/heartbeat
3. 处理响应（如有新配置）

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 心跳正常 | E2E | 观察日志 | - |
| 超时检测 | 单元测试 | Server 标记 Daemon 离线 | 30s 无心跳 |

---

### 功能 5：工作环境准备

**功能目标/解决的问题**
为每个任务准备隔离的工作目录。

**前置条件**
- 任务已领取

**业务规则**
- 工作目录结构：`{workspacesRoot}/{workspace_id}/{task_id}/`
- 克隆仓库到工作目录
- 写入技能文件
- 设置环境变量

**交互流程**
1. 创建工作目录
2. 克隆仓库
3. 写入技能文件
4. 返回工作目录路径

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 目录创建 | 单元测试 | 检查目录存在 | - |
| 仓库克隆 | 单元测试 | 首次执行 | - |
| 技能写入 | 单元测试 | 检查技能文件 | - |

---

### 功能 6：垃圾回收

**功能目标/解决的问题**
清理过期的工作目录，释放磁盘空间。

**前置条件**
- 工作目录已配置

**业务规则**
- 定期扫描工作目录
- 完成/取消的任务目录：24h TTL
- 孤儿目录（无 meta）：72h TTL
- 可配置禁用 GC

**交互流程**
1. 遍历工作目录
2. 检查 meta.json
3. 判断是否过期
4. 删除过期目录

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 正常清理 | 单元测试 | 删除过期目录 | 24h+ TTL |
| 孤儿清理 | 单元测试 | 无 meta 的孤儿目录 | 72h+ TTL |
| GC 禁用 | 单元测试 | GC_ENABLED=false | - |

---

### 功能 7：健康检查

**功能目标/解决的问题**
提供本地健康检查接口。

**前置条件**
- Daemon 运行中

**业务规则**
- HTTP 端口 19514
- 返回 Daemon 状态和统计

**交互流程**
1. 外部请求 GET /health
2. 返回 JSON 状态

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 健康检查 | 单元测试 | GET /health | - |
| 统计数据 | 单元测试 | 检查返回的任务数 | - |

---

## 配置项

### 环境变量

| 变量 | 默认值 | 说明 |
|------|-------|------|
| MULTICA_SERVER_URL | ws://localhost:8080/ws | Server 地址 |
| MULTICA_DAEMON_POLL_INTERVAL | 3s | 轮询间隔 |
| MULTICA_DAEMON_HEARTBEAT_INTERVAL | 15s | 心跳间隔 |
| MULTICA_AGENT_TIMEOUT | 2h | 任务超时 |
| MULTICA_WORKSPACES_ROOT | ~/multica_workspaces | 工作目录根路径 |
| MULTICA_KEEP_ENV_AFTER_TASK | false | 任务后保留环境 |
| MULTICA_GC_ENABLED | true | 启用 GC |
| MULTICA_GC_INTERVAL | 1h | GC 间隔 |
| MULTICA_GC_TTL | 24h | 任务目录 TTL |
| MULTICA_GC_ORPHAN_TTL | 72h | 孤儿目录 TTL |
| MULTICA_CLAUDE_PATH | claude | Claude CLI 路径 |

### CLI 参数

```bash
multica daemon \
  --server-url ws://localhost:8080/ws \
  --poll-interval 3s \
  --heartbeat-interval 15s \
  --agent-timeout 2h \
  --workspaces-root ~/multica_workspaces \
  --health-port 19514
```

---

## API 设计

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/daemon/register | 注册 Daemon |
| POST | /api/daemon/heartbeat | 心跳保活 |
| GET | /api/tasks/claim | 领取任务 |
| POST | /api/tasks/:id/start | 开始任务 |
| POST | /api/tasks/:id/complete | 完成任务 |
| POST | /api/tasks/:id/fail | 任务失败 |
| POST | /api/tasks/:id/cancel | 取消任务 |
| GET | /health | 健康检查 |

### 请求/响应示例

**注册 POST /api/daemon/register**

Request:
```json
{
  "daemon_id": "uuid",
  "legacy_daemon_ids": ["hostname-1", "hostname-2"],
  "device_name": "My-MacBook",
  "runtime_name": "Local Agent",
  "cli_version": "0.1.13",
  "agents": {
    "claude": {
      "path": "/usr/local/bin/claude",
      "model": "claude-opus-4-7"
    }
  }
}
```

**心跳 POST /api/daemon/heartbeat**

Request:
```json
{
  "daemon_id": "uuid",
  "status": "running",
  "active_tasks": [
    {
      "task_id": "uuid",
      "agent_id": "uuid",
      "started_at": "2024-01-01T00:00:00Z"
    }
  ],
  "workspaces": ["workspace-uuid-1", "workspace-uuid-2"]
}
```

---

## 技术实现参考（Multica）

### Daemon 入口

```go
// server/cmd/daemon/main.go
func main() {
    cfg, err := daemon.LoadConfig(daemon.Overrides{
        ServerURL: flag.String("server-url", "", "Server WebSocket URL"),
        // ... 其他参数
    })
    if err != nil {
        log.Fatal(err)
    }

    d := daemon.New(cfg)
    if err := d.Run(context.Background()); err != nil {
        log.Fatal(err)
    }
}
```

### pollLoop 实现

```go
// server/internal/daemon/daemon.go
func (d *Daemon) pollLoop(ctx context.Context) {
    ticker := time.NewTicker(d.config.PollInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            d.poll(ctx)
        }
    }
}

func (d *Daemon) poll(ctx context.Context) {
    // 获取可用的助手
    for agentID, agent := range d.config.Agents {
        // 检查并发数
        if d.activeTaskCount(agentID) >= agent.MaxConcurrentTasks {
            continue
        }

        // 领取任务
        task, err := d.api.ClaimTask(ctx, d.config.DaemonID, agentID)
        if err != nil {
            d.logger.Error("claim task", "error", err)
            continue
        }
        if task == nil {
            continue
        }

        // 执行任务
        go d.runTask(ctx, task, agent)
    }
}
```

### Task Handler 实现

```go
// server/internal/daemon/task.go
func (d *Daemon) runTask(ctx context.Context, task *Task, agent *AgentEntry) {
    d.activeTasks.Add(task.ID)

    // 准备工作目录
    env, err := d.prepareEnv(ctx, task)
    if err != nil {
        d.failTask(ctx, task, err)
        return
    }

    // 通知开始
    if err := d.api.StartTask(ctx, task.ID); err != nil {
        d.logger.Error("start task", "error", err)
    }

    // 执行 Claude Code
    session, err := d.agentBackend.Execute(ctx, task.Prompt, agent.ExecOptions(env))
    if err != nil {
        d.failTask(ctx, task, err)
        return
    }

    // 处理流式输出
    for msg := range session.Messages {
        d.wsClient.Send(task.WorkspaceID, "task:progress", msg)
    }

    // 收集结果
    result := <-session.Result
    if result.Status == "completed" {
        d.completeTask(ctx, task, result)
    } else {
        d.failTask(ctx, task, errors.New(result.Error))
    }

    d.activeTasks.Remove(task.ID)
}
```

### 工作环境准备

```go
// server/internal/execenv/prepare.go
type ExecEnv struct {
    WorkDir        string
    WorkspacesRoot string
    WorkspaceID    string
    TaskID         string
    Workspace      *Workspace
    Skills         []Skill
}

func (e *ExecEnv) Prepare(ctx context.Context) error {
    // 创建工作目录
    workDir := filepath.Join(e.WorkspacesRoot, e.WorkspaceID, e.TaskID)
    if err := os.MkdirAll(workDir, 0755); err != nil {
        return err
    }

    // 克隆仓库
    for _, repo := range e.Workspace.Repos {
        if err := e.cloneRepo(repo, workDir); err != nil {
            return err
        }
    }

    // 写入技能
    if err := e.WriteSkills(e.Skills); err != nil {
        return err
    }

    e.WorkDir = workDir
    return nil
}
```

### GC 实现

```go
// server/internal/daemon/gc.go
func (d *Daemon) gcLoop(ctx context.Context) {
    if !d.config.GCEnabled {
        return
    }

    ticker := time.NewTicker(d.config.GCInterval)
    defer ticker.Stop()

    for {
        select {
        case <-ctx.Done():
            return
        case <-ticker.C:
            d.runGC(ctx)
        }
    }
}

func (d *Daemon) runGC(ctx context.Context) {
    workspaces, err := os.ReadDir(d.config.WorkspacesRoot)
    if err != nil {
        return
    }

    for _, ws := range workspaces {
        if !ws.IsDir() {
            continue
        }
        d.gcWorkspace(ws.Name())
    }
}

func (d *Daemon) gcWorkspace(workspaceID string) {
    tasks, err := os.ReadDir(filepath.Join(d.config.WorkspacesRoot, workspaceID))
    if err != nil {
        return
    }

    now := time.Now()
    for _, task := range tasks {
        if !task.IsDir() {
            continue
        }
        metaPath := filepath.Join(task.Name(), "meta.json")
        fi, err := os.Stat(metaPath)

        if os.IsNotExist(err) {
            // 孤儿目录
            d.gcOrphan(task.Name(), now, d.config.GCOrphanTTL)
        } else if err == nil {
            // 检查 TTL
            age := now.Sub(fi.ModTime())
            if age > d.config.GCTTL {
                d.removeTaskDir(task.Name())
            }
        }
    }
}
```

---

## 后续扩展

### P1 后续
- **多设备协作** - 多台机器协同执行任务
- **优先级调度** - 更复杂的优先级算法

### P2 后续
- **云端 Runtime** - 云上 Agent 执行
- **分布式 GC** - 多节点协同垃圾回收
