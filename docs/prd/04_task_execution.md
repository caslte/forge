# 模块四：任务执行

## 模块概述

### 业务目标
管理任务的实际执行过程，包括任务入队、领取、Claude Code CLI 执行、进度推送、结果回传和执行取消。

### 核心职责
- 任务队列管理
- 任务领取与分发
- Claude Code CLI 执行
- 流式输出解析与推送
- 执行结果回传
- 任务取消
- 执行历史记录

### 涉及角色
- 系统（自动执行）
- 助手（Claude Code CLI 实际执行者）

### 核心业务对象
- **任务队列（AgentTaskQueue）** - 待执行任务的队列
- **执行消息（TaskMessage）** - 执行过程中的流式输出

### 前置条件
- 任务已创建并指派给助手
- 助手状态为 idle
- 工作空间已配置

---

## 模块边界

### 上游模块
| 模块 | 输入 |
|------|------|
| 任务管理 | 任务创建、指派 |
| 助手配置 | 助手配置、状态 |
| 仓库配置 | 工作目录、仓库信息 |

### 下游模块
| 模块 | 输出 |
|------|------|
| 实时同步 | 推送执行进度、结果 |
| 对话功能 | 共享 Session 上下文 |

### 数据边界
- 一个任务在队列中只有一条记录
- 一个执行可以有零条或多条执行消息
- Session 信息存储在 Claude Code 本地目录

### 职责边界
- 本模块不负责 Claude Code CLI 的安装
- 本模块不负责 Session 的长期存储（由 Claude Code CLI 管理）

---

## 核心流程与状态

### 任务执行完整流程

```
┌─────────────────────────────────────────────────────────────────┐
│                         任务执行流程                              │
└─────────────────────────────────────────────────────────────────┘

1. 入队 (Enqueue)
┌─────────────────────────────────────────────────────────────────┐
│  用户指派任务给助手                                              │
│       │                                                         │
│       ▼                                                         │
│  创建任务队列记录: status=pending                               │
│       │                                                         │
│       ▼                                                         │
│  WebSocket 广播: task:dispatch                                   │
└─────────────────────────────────────────────────────────────────┘

2. 领取 (Claim)
┌─────────────────────────────────────────────────────────────────┐
│  Daemon 轮询: GET /api/tasks/claim                              │
│       │                                                         │
│       ├── 检查助手状态                                            │
│       ├── 检查并发数限制                                          │
│       └── 通过则领取                                              │
│       │                                                         │
│       ▼                                                         │
│  更新队列记录: status=claimed, started_at=now()                  │
│       │                                                         │
│       ▼                                                         │
│  准备工作目录 (execenv.Prepare)                                  │
│       ├── 创建 ~/multica_workspaces/{ws_id}/{task_id}/          │
│       ├── 克隆仓库 (如配置)                                      │
│       └── 写入技能文件                                          │
└─────────────────────────────────────────────────────────────────┘

3. 执行 (Execute)
┌─────────────────────────────────────────────────────────────────┐
│  启动 Claude Code CLI                                            │
│  claude -p --output-format stream-json \                        │
│       --permission-mode {mode} \                                │
│       --resume {session_id} \                                   │
│       --append-system-prompt "{task_prompt}"                    │
│       │                                                         │
│       ├── stdin 输入任务描述                                     │
│       ├── stdout 解析 JSON 流                                    │
│       └── stderr 捕获日志                                        │
│       │                                                         │
│       ▼                                                         │
│  解析输出类型:                                                   │
│  - assistant: 提取 text/thinking/tool_use                      │
│  - user: 提取 tool_result                                       │
│  - result: 执行完成                                              │
│  - log: 日志消息                                                 │
│       │                                                         │
│       ▼                                                         │
│  WebSocket 推送: task:progress                                  │
└─────────────────────────────────────────────────────────────────┘

4. 完成 (Complete)
┌─────────────────────────────────────────────────────────────────┐
│  执行成功: status=completed                                     │
│       │                                                         │
│       ├── 解析 result.is_error 判断是否成功                      │
│       ├── 记录 output/error/duration/usage                      │
│       └── 清理工作目录 (如 KeepEnvAfterTask=false)              │
│       │                                                         │
│       ▼                                                         │
│  WebSocket 推送: task:completed                                 │
└─────────────────────────────────────────────────────────────────┘
```

### 任务队列状态流转

```
┌──────────┐     ┌──────────┐     ┌────────────┐     ┌────────────┐
│ pending  │────►│ claimed  │────►│ in_progress│────►│ completed  │
└──────────┘     └──────────┘     └────────────┘     └────────────┘
                                     │                      │
                                     ▼                      │
                              ┌────────────┐                │
                              │  failed    │                │
                              └────────────┘                │
                                     │                      │
                                     ▼                      ▼
                              ┌────────────────────────────┐
                              │        cancelled           │
                              └────────────────────────────┘
```

| 状态 | 说明 | 触发条件 |
|------|------|---------|
| pending | 待领取 | 任务指派给助手 |
| claimed | 已领取 | Daemon 领取任务 |
| in_progress | 执行中 | 实际开始执行 |
| completed | 已完成 | 正常结束 |
| failed | 失败 | 执行异常 |
| cancelled | 已取消 | 用户取消 |

---

## 功能点

### 功能 1：任务入队

**功能目标/解决的问题**
任务指派给助手后，需要将任务加入执行队列。

**前置条件**
- 任务存在且已指派给助手
- 助手状态为 idle

**业务规则**
- 每个任务在队列中只有一条记录
- 优先级影响领取顺序
- 优先级的 Claim 顺序: urgent > high > medium > low > none

**交互流程**
1. 用户指派任务给助手
2. 系统创建任务队列记录
3. WebSocket 广播 task:dispatch 事件

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 入队成功 | 单元测试 | 指派任务后检查队列记录 | - |
| 优先级顺序 | 单元测试 | 多任务时检查领取顺序 | 同优先级 |
| WebSocket 广播 | E2E | 检查 task:dispatch 事件 | - |

---

### 功能 2：任务领取

**功能目标/解决的问题**
Daemon 从队列中领取任务准备执行。

**前置条件**
- 队列中有 pending 状态的任务
- 助手状态为 idle
- 助手未达到并发数限制

**业务规则**
- 每次只领取一个任务
- 按优先级和创建时间排序
- 领取后更新任务队列状态
- 领取后更新助手状态为 working

**交互流程**
1. Daemon 轮询 GET /api/tasks/claim
2. 系统检查助手可用性
3. 系统选择最高优先级任务
4. 创建工作目录
5. 写入技能文件
6. 返回任务详情给 Daemon

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 领取成功 | 单元测试 | 有待领取任务时领取 | - |
| 优先级正确 | 单元测试 | 不同优先级任务领取顺序 | urgent > high |
| 并发限制 | 单元测试 | 助手达到并发上限时拒绝 | max=1 |
| 助手状态变更 | 单元测试 | 领取后助手状态为 working | - |

---

### 功能 3：任务执行

**功能目标/解决的问题**
使用 Claude Code CLI 执行任务。

**前置条件**
- 任务已领取
- 工作目录已准备
- 技能文件已写入

**业务规则**
- 通过 stdin/stdout 与 Claude Code CLI 交互
- 解析 stream-json 格式输出
- 支持 --resume 复用 Session
- 支持 --append-system-prompt 添加额外指令
- 支持 --max-turns 限制最大轮数

**流式输出类型：**

| 类型 | 内容 | 处理 |
|------|------|------|
| assistant | text/thinking/tool_use | 提取并推送 |
| user | tool_result | 提取并推送 |
| system | session_id | 记录 Session |
| result | 执行结果 | 完成信号 |
| log | 日志 | 推送日志 |

**交互流程**
1. Daemon 启动 Claude Code CLI
2. 通过 stdin 发送任务描述
3. 循环读取 stdout 解析 JSON
4. 每条消息通过 WebSocket 推送
5. 任务完成后收集结果
6. 更新任务状态

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 执行正常完成 | E2E | 简单任务完整执行 | - |
| 执行超时 | 单元测试 | --max-turns 限制 | 超时 |
| Session 复用 | 单元测试 | --resume 参数 | - |
| 技能注入 | 单元测试 | 检查技能文件 | 无技能 |
| Token 用量记录 | 单元测试 | 检查 usage 字段 | - |

---

### 功能 4：任务取消

**功能目标/解决的问题**
用户可以取消正在执行的任务。

**前置条件**
- 任务状态为 in_progress 或 claimed

**业务规则**
- 取消时终止 Claude Code CLI 进程
- 关闭 stdin/stdout 管道
- 更新任务状态为 cancelled
- 不清理已产生的文件（由 GC 负责）

**交互流程**
1. 用户点击「取消任务」按钮
2. 系统发送取消信号
3. 终止 Claude Code CLI 进程
4. 关闭相关管道
5. 更新任务状态
6. WebSocket 广播 task:cancelled

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 取消成功 | E2E | 取消执行中任务 | in_progress |
| 进程终止 | 单元测试 | 检查进程是否终止 | - |
| 状态正确 | 单元测试 | 取消后状态为 cancelled | - |

---

### 功能 5：执行历史

**功能目标/解决的问题**
记录和展示任务的执行历史。

**前置条件**
- 任务有执行记录

**业务规则**
- 记录每次执行的开始/结束时间
- 记录执行输出和错误信息
- 记录 Token 用量
- 记录 Session ID（用于 resume）

**业务数据**
- 执行ID：标识每次执行
- 开始时间：实际开始时间
- 结束时间：完成/失败时间
- 执行时长：结束时间 - 开始时间
- 输出：Claude Code 的最终输出
- 错误：执行失败的原因
- Token 用量：输入/输出 Token 数量

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 历史记录 | E2E | 查看已完成任务的历史 | - |
| 重试执行 | E2E | 基于历史重新执行 | - |
| Token 用量 | 单元测试 | 检查 usage 准确性 | - |

---

## 数据库设计

### 表结构

#### agent_task_queue 表（任务队列）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | 主键 |
| agent_id | UUID | NOT NULL, REFERENCES agent | 助手 ID |
| runtime_id | UUID | NOT NULL | Daemon/Runtime ID |
| issue_id | UUID | NOT NULL, REFERENCES issue | 任务 ID |
| status | TEXT | NOT NULL, CHECK | 状态 |
| priority | TEXT | NOT NULL, CHECK | 优先级（继承自 issue） |
| dispatched_at | TIMESTAMPTZ | | 分发时间 |
| started_at | TIMESTAMPTZ | | 开始时间 |
| completed_at | TIMESTAMPTZ | | 完成时间 |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 更新时间 |

**CHECK 约束：**
```sql
status IN ('pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled')
priority IN ('urgent', 'high', 'medium', 'low', 'none')
```

#### task_message 表（任务执行消息）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | 主键 |
| task_id | UUID | NOT NULL, REFERENCES agent_task_queue | 任务 ID |
| type | TEXT | NOT NULL | 消息类型 |
| content | TEXT | | 消息内容 |
| tool | TEXT | | 工具名称 |
| call_id | TEXT | | 调用 ID |
| session_id | TEXT | | Session ID |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |

### 索引

```sql
CREATE INDEX idx_task_queue_agent ON agent_task_queue(agent_id);
CREATE INDEX idx_task_queue_status ON agent_task_queue(status);
CREATE INDEX idx_task_queue_priority ON agent_task_queue(agent_id, status, priority);
CREATE INDEX idx_task_message_task ON task_message(task_id);
```

---

## API 设计

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /api/tasks/claim | 领取任务 |
| POST | /api/tasks/:id/start | 开始任务执行 |
| POST | /api/tasks/:id/complete | 完成任务 |
| POST | /api/tasks/:id/fail | 任务失败 |
| POST | /api/tasks/:id/cancel | 取消任务 |
| GET | /api/tasks/:id/messages | 获取执行消息历史 |
| POST | /api/tasks/:id/messages | 发送执行消息 |

### 请求/响应示例

**领取任务 GET /api/tasks/claim**

Headers:
```
X-Runtime-ID: daemon-uuid
X-Agent-ID: agent-uuid
```

Response:
```json
{
  "id": "task-queue-uuid",
  "issue_id": "issue-uuid",
  "agent_id": "agent-uuid",
  "status": "claimed",
  "issue": {
    "id": "issue-uuid",
    "title": "实现用户登录功能",
    "description": "使用 JWT 实现...",
    "status": "in_progress",
    "priority": "high"
  },
  "workspace": {
    "id": "workspace-uuid",
    "repos": [...]
  },
  "agent": {
    "id": "agent-uuid",
    "name": "Code Agent",
    "instructions": "...",
    "runtime_mode": "bypassPermissions",
    "model": "claude-opus-4-7"
  },
  "skills": [...]
}
```

**完成任务 POST /api/tasks/:id/complete**

Request:
```json
{
  "output": "登录功能已实现...\n修改文件: auth/login.ts",
  "session_id": "session-uuid",
  "usage": {
    "claude-opus-4-7": {
      "input_tokens": 5000,
      "output_tokens": 3000
    }
  }
}
```

**任务失败 POST /api/tasks/:id/fail**

Request:
```json
{
  "error": "执行超时：超过最大轮数限制",
  "session_id": "session-uuid"
}
```

---

## 技术实现参考（Multica）

### Claude Code CLI 调用

```go
// server/pkg/agent/claude.go
func (b *claudeBackend) Execute(ctx context.Context, prompt string, opts ExecOptions) (*Session, error) {
    args := buildClaudeArgs(opts, b.cfg.Logger)

    cmd := exec.CommandContext(runCtx, execPath, args...)
    cmd.Dir = opts.Cwd
    cmd.Env = buildEnv(b.cfg.Env)

    // stdin/stdout 管道
    stdin, _ := cmd.StdinPipe()
    stdout, _ := cmd.StdoutPipe()

    // 启动进程
    if err := cmd.Start(); err != nil {
        return nil, err
    }

    // 发送输入
    if err := writeClaudeInput(stdin, prompt); err != nil {
        return nil, err
    }

    // 返回 Session 用于异步读取
    return &Session{Messages: msgCh, Result: resCh}, nil
}
```

### 流式输出解析

```go
// server/pkg/agent/claude.go
type claudeSDKMessage struct {
    Type      string          `json:"type"`
    Message   json.RawMessage `json:"message,omitempty"`
    SessionID string          `json:"session_id,omitempty"`
    ResultText string         `json:"result,omitempty"`
    IsError   bool            `json:"is_error,omitempty"`
    Log       *claudeLogEntry `json:"log,omitempty"`
}

for scanner.Scan() {
    var msg claudeSDKMessage
    if err := json.Unmarshal(scanner.Bytes(), &msg); err != nil {
        continue
    }

    switch msg.Type {
    case "assistant":
        // 解析 message 字段，提取 content blocks
    case "user":
        // tool_result
    case "result":
        // 执行完成
    case "log":
        // 日志消息
    }
}
```

### 工作目录准备

```go
// server/internal/execenv/prepare.go
func (e *ExecEnv) Prepare(ctx context.Context) error {
    // 创建工作目录
    workDir := filepath.Join(e.WorkspacesRoot, e.WorkspaceID, e.TaskID)
    if err := os.MkdirAll(workDir, 0755); err != nil {
        return err
    }

    // 克隆仓库（如配置）
    for _, repo := range e.Workspace.Repos {
        if err := e.cloneRepo(repo, workDir); err != nil {
            return err
        }
    }

    // 写入技能文件
    if err := e.WriteSkills(e.Skills); err != nil {
        return err
    }

    e.WorkDir = workDir
    return nil
}
```

### Session 复用

Claude Code CLI 将 Session 存储在 `~/.claude/sessions/` 目录，通过 `--resume <session_id>` 参数复用：

```bash
claude -p --resume session-uuid --output-format stream-json
```

---

## 后续扩展

### P1 后续
- **任务重试** - 失败任务自动/手动重试
- **并行执行** - 支持多任务同时执行

### P2 后续
- **执行回放** - 回放历史执行过程
- **执行分支** - 基于历史创建分支任务
