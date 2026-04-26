# 模块五：对话功能

## 模块概述

### 业务目标
支持用户与 AI 助手进行实时对话，提供会话管理、消息收发和流式响应功能。

### 核心职责
- 对话会话管理
- 消息发送与接收
- 流式响应处理
- 上下文保持
- 会话历史记录

### 涉及角色
- 用户（创建会话、发送消息）
- 助手（Claude Code CLI 响应消息）

### 核心业务对象
- **对话会话（ChatSession）** - 对话上下文容器
- **对话消息（ChatMessage）** - 具体的消息记录

### 前置条件
- 用户已配置助手

---

## 模块边界

### 上游模块
| 模块 | 输入 |
|------|------|
| 助手配置 | 提供会话使用的助手 |
| 仓库配置 | 提供工作目录上下文 |

### 下游模块
| 模块 | 输出 |
|------|------|
| 实时同步 | 推送消息流式响应 |

### 数据边界
- 一个会话归属于一个用户
- 一个会话归属于一个助手
- 消息按时间顺序存储

### 职责边界
- 本模块不负责会话的 AI 理解（由 Claude Code CLI 处理）
- 本模块不负责 Session 的长期存储（由 Claude Code CLI 管理）

---

## 核心流程与状态

### 对话流程

```
┌─────────────────────────────────────────────────────────────────┐
│                         对话流程                                  │
└─────────────────────────────────────────────────────────────────┘

1. 创建会话
┌─────────────────────────────────────────────────────────────────┐
│  用户点击「新建对话」                                            │
│       │                                                         │
│       ├── 选择助手                                               │
│       ├── 填写会话标题（可选）                                   │
│       └── 创建会话记录                                           │
│       │                                                         │
│       ▼                                                         │
│  返回会话 ID                                                    │
└─────────────────────────────────────────────────────────────────┘

2. 发送消息
┌─────────────────────────────────────────────────────────────────┐
│  用户输入消息并发送                                              │
│       │                                                         │
│       ├── 保存用户消息到数据库                                   │
│       ├── 构建 ChatPrompt                                       │
│       │     │                                                   │
│       │     ├── 历史消息拼接                                    │
│       │     ├── 助手 instructions                               │
│       │     └── 仓库上下文                                      │
│       │                                                         │
│       └── 发送给 Claude Code CLI                                │
└─────────────────────────────────────────────────────────────────┘

3. 流式响应
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code CLI 输出 stream-json                               │
│       │                                                         │
│       ├── 解析消息类型                                           │
│       ├── 提取 text/tool_use/tool_result                       │
│       └── WebSocket 推送: chat:message                          │
│       │                                                         │
│       └── 执行完成                                               │
│             │                                                   │
│             ├── 保存助手消息到数据库                             │
│             └── WebSocket 推送: chat:done                        │
└─────────────────────────────────────────────────────────────────┘

4. 上下文保持
┌─────────────────────────────────────────────────────────────────┐
│  Claude Code CLI 通过 Session 保持上下文                        │
│       │                                                         │
│       ├── Session ID 存储在 chat_session 表                    │
│       ├── 每次请求携带 --resume {session_id}                    │
│       └── 本地 Session 文件在 ~/.claude/sessions/               │
└─────────────────────────────────────────────────────────────────┘
```

### 会话状态

| 状态 | 说明 |
|------|------|
| active | 活跃，可发送消息 |
| archived | 已归档 |
| deleted | 已删除（软删除） |

---

## 功能点

### 功能 1：创建会话

**功能目标/解决的问题**
用户需要创建新的对话会话。

**前置条件**
- 已配置至少一个助手

**业务规则**
- 会话标题为选填，不填则使用第一句用户消息
- 一个会话归属于一个助手
- 会话创建时生成新 Session ID

**交互流程**
1. 用户点击「新建对话」按钮
2. 系统弹出会话创建弹窗
3. 用户选择助手
4. 用户填写标题（可选）
5. 创建会话，返回会话 ID
6. 进入会话页面

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 创建成功 | E2E | 选择助手创建会话 | - |
| 默认标题 | 单元测试 | 不填标题，使用第一句消息 | - |
| 助手必选 | E2E | 不选择助手时保存 | - |

---

### 功能 2：发送消息

**功能目标/解决的问题**
用户向助手发送消息并接收响应。

**前置条件**
- 会话存在且状态为 active
- 助手可用

**业务规则**
- 消息内容为必填，最长 50000 字符
- 消息按时间顺序存储
- 支持多轮对话（上下文通过 Session 保持）

**交互流程**
1. 用户在输入框输入消息
2. 用户点击发送按钮
3. 系统保存用户消息
4. 系统构建 Prompt（历史 + instructions + 上下文）
5. 系统调用 Claude Code CLI
6. 流式接收并推送响应
7. 执行完成后保存助手消息

**异常与边界**
- 会话已归档：提示「会话已归档，无法发送消息」
- 助手离线：提示「助手离线，请稍后重试」

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 消息发送 | E2E | 发送普通文本消息 | - |
| 多轮对话 | E2E | 连续发送多条消息 | 10+ 轮 |
| 流式响应 | E2E | 观察响应逐字显示 | - |
| 上下文保持 | E2E | 多轮后助手能记住之前内容 | 5+ 轮 |
| 消息长度限制 | 单元测试 | 发送 50001 字符 | 超长 |

---

### 功能 3：会话列表

**功能目标/解决的问题**
用户查看和管理所有对话会话。

**前置条件**
- 用户已登录

**业务规则**
- 按最后更新时间倒序排列
- 支持按标题搜索
- 支持按助手筛选

**交互流程**
1. 用户进入对话列表页
2. 系统显示会话列表
3. 用户可搜索或筛选
4. 用户点击会话进入详情

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 列表展示 | E2E | 查看会话列表 | - |
| 搜索功能 | E2E | 按标题搜索 | - |
| 筛选功能 | E2E | 按助手筛选 | - |

---

### 功能 4：删除会话

**功能目标/解决的问题**
用户删除不需要的对话会话。

**前置条件**
- 会话存在

**业务规则**
- 删除为软删除（更新状态为 deleted）
- 删除后不清理 Claude Code 本地 Session

**交互流程**
1. 用户点击会话的「删除」按钮
2. 系统弹出确认对话框
3. 用户确认删除
4. 系统更新会话状态

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 删除成功 | E2E | 确认删除会话 | - |
| 软删除 | 单元测试 | 检查会话状态为 deleted | - |

---

### 功能 5：流式响应

**功能目标/解决的问题**
实时展示助手的响应内容。

**前置条件**
- 消息已发送

**业务规则**
- WebSocket 推送 chat:message 事件
- 每条消息包含 type/content/tool 信息
- 执行完成后推送 chat:done 事件

**WebSocket 消息格式：**

| 事件 | 数据 |
|------|------|
| chat:message | {type, content, tool?, call_id?} |
| chat:done | {session_id, usage?} |
| chat:error | {error} |

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 消息推送 | E2E | 发送消息后检查 WS 消息 | - |
| 完成信号 | E2E | 执行完成后检查 chat:done | - |
| 错误处理 | E2E | 执行异常时检查 chat:error | - |

---

## 数据库设计

### 表结构

#### chat_session 表（对话会话）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | 主键 |
| agent_id | UUID | NOT NULL, REFERENCES agent | 助手 ID |
| creator_id | UUID | NOT NULL | 创建者 ID |
| title | TEXT | | 会话标题 |
| status | TEXT | NOT NULL, CHECK | 状态 |
| session_id | TEXT | | Claude Session ID（用于 resume） |
| last_message_at | TIMESTAMPTZ | | 最后消息时间 |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |
| updated_at | TIMESTAMPTZ | NOT NULL | 更新时间 |

**CHECK 约束：**
```sql
status IN ('active', 'archived', 'deleted')
```

#### chat_message 表（对话消息）

| 字段 | 类型 | 约束 | 说明 |
|------|------|------|------|
| id | UUID | PK | 主键 |
| chat_session_id | UUID | NOT NULL, REFERENCES chat_session | 会话 ID |
| role | TEXT | NOT NULL, CHECK | 角色 |
| content | TEXT | NOT NULL | 消息内容 |
| created_at | TIMESTAMPTZ | NOT NULL | 创建时间 |

**CHECK 约束：**
```sql
role IN ('user', 'assistant', 'system')
```

### 索引

```sql
CREATE INDEX idx_chat_session_creator ON chat_session(creator_id);
CREATE INDEX idx_chat_session_agent ON chat_session(agent_id);
CREATE INDEX idx_chat_session_status ON chat_session(creator_id, status);
CREATE INDEX idx_chat_message_session ON chat_message(chat_session_id);
CREATE INDEX idx_chat_message_created ON chat_message(chat_session_id, created_at);
```

---

## API 设计

### REST API

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/chat/sessions | 创建会话 |
| GET | /api/chat/sessions | 获取会话列表 |
| GET | /api/chat/sessions/:id | 获取会话详情 |
| PATCH | /api/chat/sessions/:id | 更新会话 |
| DELETE | /api/chat/sessions/:id | 删除会话 |
| POST | /api/chat/sessions/:id/messages | 发送消息 |
| GET | /api/chat/sessions/:id/messages | 获取消息历史 |

### WebSocket 事件

| 事件 | 方向 | 说明 |
|------|------|------|
| chat:message | Server→Client | 流式消息 |
| chat:done | Server→Client | 消息完成 |
| chat:error | Server→Client | 执行错误 |

### 请求/响应示例

**发送消息 POST /api/chat/sessions/:id/messages**

Request:
```json
{
  "content": "帮我写一个 Hello World 程序"
}
```

Response:
```json
{
  "id": "message-uuid",
  "chat_session_id": "session-uuid",
  "role": "user",
  "content": "帮我写一个 Hello World 程序",
  "created_at": "2024-01-01T00:00:00Z"
}
```

**流式响应通过 WebSocket 推送：**

```json
{
  "event": "chat:message",
  "data": {
    "type": "text",
    "content": "好的，我来帮你写一个 Hello World 程序。"
  }
}
```

```json
{
  "event": "chat:message",
  "data": {
    "type": "tool_use",
    "tool": "Write",
    "call_id": "call-123",
    "input": {"file_path": "hello.go", "content": "package main\n\nfunc main() {\n    println(\"Hello, World!\")\n}"}
  }
}
```

```json
{
  "event": "chat:done",
  "data": {
    "session_id": "claude-session-uuid",
    "usage": {
      "claude-opus-4-7": {
        "input_tokens": 1000,
        "output_tokens": 500
      }
    }
  }
}
```

---

## 页面承载

### 会话列表页 `/chat`

```
+------------------------------------------------------------------+
|  对话                                            [+ 新建对话]     |
+------------------------------------------------------------------+
|  [全部助手 ▼] [搜索...]                                         |
+------------------------------------------------------------------+
|  +----------------------------------------------------------+   |
|  | 🤖 Code Agent                                             |   |
|  | 今天 帮我写一个 Hello World 程序         [active]  [删除] |   |
|  | 10:30 用户: 帮我写一个 Hello World 程序                  |   |
|  +----------------------------------------------------------+   |
|  | 🤖 Review Agent                                           |   |
|  | 昨天 代码审查                               [archived] [删除] |   |
|  +----------------------------------------------------------+   |
+------------------------------------------------------------------+
```

| 元素 | 类型 | 功能描述 | 触发条件 |
|------|------|---------|---------|
| 新建对话按钮 | 按钮 | 创建新会话 | 点击 |
| 助手筛选 | 下拉框 | 按助手筛选 | 选择 |
| 搜索框 | 输入框 | 按标题搜索 | 输入 |
| 会话行 | 行 | 进入会话详情 | 点击 |
| 删除按钮 | 按钮 | 删除会话 | 点击 |

### 会话详情页 `/chat/:id`

```
+------------------------------------------------------------------+
|  ← 返回    Hello World 程序                        [归档] [⋮]    |
+------------------------------------------------------------------+
|                                                                    |
|  用户: 帮我写一个 Hello World 程序                    10:30      |
|                                                                    |
|  助手: 好的，我来帮你写一个 Hello World 程序。          10:30   │
|                                                                    |
|  助手: 我将创建以下文件:                               10:30   |
|        - hello.go                                                 │
|                                                                    |
|  助手: 已创建文件 hello.go                            10:31   │
|        ```go                                                       |
|        package main                                                |
|                                                                    |
|        func main() {                                              |
|            println("Hello, World!")                                |
|        }                                                           |
|        ```                                                         |
|                                                                    |
+------------------------------------------------------------------+
|  ┌────────────────────────────────────────────────────────────┐  |
|  │ 输入消息...                                             [发送] │  |
|  └────────────────────────────────────────────────────────────┘  |
+------------------------------------------------------------------+
```

| 元素 | 类型 | 功能描述 | 触发条件 |
|------|------|---------|---------|
| 返回按钮 | 按钮 | 返回会话列表 | 点击 |
| 归档按钮 | 按钮 | 归档会话 | 点击 |
| 消息输入框 | 输入框 | 输入消息内容 | 输入 |
| 发送按钮 | 按钮 | 发送消息 | 点击 |
| 消息气泡 | 展示 | 显示消息内容 | - |

---

## 技术实现参考（Multica）

### Chat Prompt 构建

```go
// server/internal/chat/service.go
func buildChatPrompt(msgs []ChatMessage, agent Agent, repo Repo) string {
    var sb strings.Builder

    // 系统上下文
    if agent.Instructions != "" {
        sb.WriteString(agent.Instructions)
        sb.WriteString("\n\n")
    }

    // 仓库上下文
    if repo != nil {
        sb.WriteString("当前工作目录: ")
        sb.WriteString(repo.LocalPath)
        sb.WriteString("\n")
    }

    // 消息历史
    for _, m := range msgs {
        role := "User"
        if m.Role == "assistant" {
            role = "Assistant"
        }
        sb.WriteString(fmt.Sprintf("%s: %s\n", role, m.Content))
    }

    return sb.String()
}
```

### 流式消息处理

与任务执行相同，使用 Claude Code CLI 的 stream-json 模式：

```go
// WebSocket 推送
func (h *ChatHandler) handleMessage(ctx context.Context, session *Session, ws *websocket.Conn) {
    for msg := range session.Messages {
        ws.WriteJSON(Message{
            Event: "chat:message",
            Data: msg,
        })
    }

    // 执行完成
    result := <-session.Result
    ws.WriteJSON(Message{
        Event: "chat:done",
        Data: map[string]interface{}{
            "session_id": result.SessionID,
            "usage":      result.Usage,
        },
    })
}
```

### Session 复用

```go
// 发送消息时携带 --resume 参数
args := []string{
    "-p",
    "--resume", sessionID,  // 复用之前会话
    "--output-format", "stream-json",
    "--input-format", "stream-json",
}
```

---

## 后续扩展

### P1 后续
- **会话分享** - 分享对话链接
- **会话导入/导出** - 导出为 Markdown/JSON

### P2 后续
- **多点对话** - 同时与多个助手对话
- **语音输入** - 语音转文字
