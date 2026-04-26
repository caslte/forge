# 模块七：实时同步

## 模块概述

### 业务目标
通过 WebSocket 实现服务端与客户端的实时通信，推送任务状态变更、对话消息等事件。

### 核心职责
- WebSocket 连接管理
- 订阅范围（Scope）管理
- 事件广播
- 重连机制

### 涉及角色
- 系统（自动推送事件）
- 用户（订阅事件）

### 核心业务对象
- **WebSocket 连接** - 客户端与服务器的持久连接
- **订阅** - 客户端对特定范围的事件订阅

### 前置条件
- 用户已登录

---

## 模块边界

### 上游模块
| 模块 | 输入 |
|------|------|
| 任务管理 | 任务状态变更事件 |
| 任务执行 | 执行进度/结果事件 |
| 对话功能 | 消息/完成事件 |

### 下游模块
| 模块 | 输出 |
|------|------|
| 前端 | 接收并展示事件 |

### 职责边界
- 本模块不负责事件的业务逻辑处理
- 本模块不负责事件的持久化存储

---

## 核心流程与状态

### WebSocket 连接流程

```
┌─────────────────────────────────────────────────────────────────┐
│  WebSocket 连接流程                                               │
└─────────────────────────────────────────────────────────────────┘

1. 连接建立
┌─────────────────────────────────────────────────────────────────┐
│  客户端连接 ws://server/ws                                       │
│       │                                                         │
│       ├── 验证用户身份                                           │
│       ├── 创建连接记录                                           │
│       └── 返回连接成功                                           │
└─────────────────────────────────────────────────────────────────┘

2. 订阅范围
┌─────────────────────────────────────────────────────────────────┐
│  客户端发送 subscribe 消息                                        │
│       │                                                         │
│       ├── workspace:{id} → 订阅工作空间所有事件                   │
│       ├── user:{id} → 订阅用户相关事件                           │
│       ├── task:{id} → 订阅特定任务事件                          │
│       └── chat:{id} → 订阅特定会话事件                          │
│       │                                                         │
│       ▼                                                         │
│  服务端记录订阅关系                                               │
└─────────────────────────────────────────────────────────────────┘

3. 事件广播
┌─────────────────────────────────────────────────────────────────┐
│  业务模块触发事件                                                 │
│       │                                                         │
│       ├── 任务状态变更 → issue:updated                          │
│       ├── 任务执行进度 → task:progress                          │
│       ├── 对话消息 → chat:message                               │
│       └── ...                                                   │
│       │                                                         │
│       ▼                                                         │
│  WebSocket Hub 根据订阅关系广播                                   │
└─────────────────────────────────────────────────────────────────┘

4. 重连机制
┌─────────────────────────────────────────────────────────────────┐
│  连接断开                                                       │
│       │                                                         │
│       ├── 检测断开（ping/pong 超时）                             │
│       ├── 清理连接记录                                           │
│       └── 客户端自动重连                                         │
│       │                                                         │
│       └── 重连成功后重新订阅                                     │
└─────────────────────────────────────────────────────────────────┘
```

### 订阅范围（Scope）

| Scope | 说明 | 自动订阅 |
|-------|------|---------|
| workspace:{id} | 工作空间内所有事件 | 是（登录后） |
| user:{id} | 用户相关事件 | 是（登录后） |
| task:{id} | 特定任务事件 | 否（需要授权） |
| chat:{id} | 特定会话事件 | 否（需要授权） |

---

## 功能点

### 功能 1：WebSocket 连接

**功能目标/解决的问题**
客户端与服务器建立持久连接。

**前置条件**
- 用户已登录

**业务规则**
- 连接时需要携带认证 Token
- 每个用户可以有多个连接（多设备/多标签页）
- 连接空闲超时为 60 秒

**交互流程**
1. 客户端通过 HTTP 升级到 WebSocket
2. 服务端验证 Token
3. 创建连接记录
4. 返回连接成功
5. 开始心跳保活

**异常与边界**
- Token 无效：拒绝连接
- 连接数超限：提示「设备数超限」

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 连接成功 | E2E | 有效 Token 连接 | - |
| 连接失败 | 单元测试 | 无效 Token | - |
| 多设备 | E2E | 同时 3 个设备连接 | - |

---

### 功能 2：订阅管理

**功能目标/解决的问题**
客户端订阅感兴趣的事件范围。

**前置条件**
- WebSocket 已连接

**业务规则**
- 支持同时订阅多个 Scope
- 订阅即时生效
- 取消订阅发送 unsubscribe 消息

**WebSocket 消息格式：**

**订阅：**
```json
{
  "action": "subscribe",
  "scope": "workspace:uuid-xxx",
  "token": "optional-task-access-token"
}
```

**取消订阅：**
```json
{
  "action": "unsubscribe",
  "scope": "workspace:uuid-xxx"
}
```

**响应：**
```json
{
  "action": "subscribed",
  "scope": "workspace:uuid-xxx"
}
```

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 订阅成功 | E2E | 订阅 workspace scope | - |
| 多 Scope 订阅 | E2E | 同时订阅多个 scope | 5+ scope |
| 取消订阅 | E2E | 取消订阅 | - |
| 权限验证 | E2E | task scope 需要授权 token | - |

---

### 功能 3：事件推送

**功能目标/解决的问题**
服务端向客户端推送事件。

**前置条件**
- 客户端已订阅相应 Scope

**业务规则**
- 事件按 Scope 过滤推送
- 消息按时间顺序推送
- 使用 ULID 防止消息重复

**事件类型：**

| 事件 | Scope | 说明 |
|------|-------|------|
| issue:created | workspace | 任务创建 |
| issue:updated | workspace | 任务更新 |
| issue:deleted | workspace | 任务删除 |
| task:dispatch | workspace/task | 任务分发 |
| task:progress | workspace/task | 任务进度 |
| task:completed | workspace/task | 任务完成 |
| task:failed | workspace/task | 任务失败 |
| task:cancelled | workspace/task | 任务取消 |
| agent:status | workspace | 助手状态变更 |
| chat:message | chat | 对话消息 |
| chat:done | chat | 对话完成 |

**消息格式：**
```json
{
  "id": "ulid-xxx",
  "type": "issue:updated",
  "scope": "workspace:uuid-xxx",
  "data": {
    "issue_id": "uuid-xxx",
    "status": "in_progress",
    "updated_by": "user-uuid"
  },
  "timestamp": "2024-01-01T00:00:00Z"
}
```

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 事件推送 | E2E | 创建任务后检查事件 | - |
| 范围过滤 | E2E | 未订阅的事件不推送 | - |
| 消息顺序 | 单元测试 | 检查消息时间顺序 | - |
| 去重 | 单元测试 | ULID 去重 | - |

---

### 功能 4：心跳保活

**功能目标/解决的问题**
检测连接是否存活，防止僵尸连接。

**前置条件**
- WebSocket 已连接

**业务规则**
- 服务端每 30 秒发送 ping
- 客户端需在 10 秒内响应 pong
- 超时未响应则断开连接

**消息格式：**

**Ping：**
```json
{
  "type": "ping"
}
```

**Pong：**
```json
{
  "type": "pong"
}
```

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 心跳正常 | E2E | 正常 ping/pong | - |
| 超时断开 | 单元测试 | 客户端无响应 | 10s 超时 |

---

### 功能 5：重连机制

**功能目标/解决的问题**
网络不稳定时自动恢复连接。

**前置条件**
- 连接意外断开

**业务规则**
- 客户端自动重连
- 重连延迟：1000ms → 2000ms → 4000ms（指数退避）
- 最大重试次数：10 次
- 重连成功后重新订阅之前的 scope

**客户端重连逻辑：**
```javascript
let retryCount = 0;
const maxRetries = 10;
const baseDelay = 1000;

function reconnect() {
  if (retryCount >= maxRetries) {
    console.error('Max retries reached');
    return;
  }

  const delay = baseDelay * Math.pow(2, retryCount);
  setTimeout(() => {
    ws = new WebSocket(url);
    ws.onopen = () => {
      // 重新订阅之前的 scope
      subscribe(savedScopes);
      retryCount = 0;
    };
    ws.onclose = reconnect;
    retryCount++;
  }, delay);
}
```

**验收标准**

| 验收项 | 验证方式 | 测试场景 | 边界条件 |
|-------|---------|---------|---------|
| 自动重连 | E2E | 断开后自动重连 | - |
| 指数退避 | 单元测试 | 检查重连延迟 | - |
| 重试上限 | 单元测试 | 超过 10 次停止 | - |
| 恢复订阅 | E2E | 重连后事件恢复 | - |

---

## 技术实现参考（Multica）

### WebSocket Hub

```go
// server/internal/realtime/hub.go
type Hub struct {
    clients    map[*Client]bool
    subscribe  chan *Subscription
    unsubscribe chan *Subscription
    broadcast  chan *Message
}

type Client struct {
    hub    *Hub
    conn   *websocket.Conn
    send   chan []byte
    userID uuid.UUID
    scopes map[string]bool // 用户订阅的 scope
}

type Subscription struct {
    client *Client
    scope  string
    token  string // 授权 token（task/chat scope 需要）
}

func (h *Hub) Run() {
    for {
        select {
        case client := <-h.register:
            h.clients[client] = true
        case client := <-h.unregister:
            delete(h.clients, client)
            close(client.send)
        case sub := <-h.subscribe:
            sub.client.scopes[sub.scope] = true
        case msg := <-h.broadcast:
            // 根据 scope 过滤并发送
            for client := range h.clients {
                if client.shouldReceive(msg.Scope) {
                    select {
                    case client.send <- msg.Data:
                    default:
                        delete(h.clients, client)
                    }
                }
            }
        }
    }
}
```

### 事件发送

```go
// server/internal/realtime/hub.go
func (h *Hub) Publish(scope string, eventType string, data interface{}) error {
    msg := Message{
        ID:    ulid.Make().String(),
        Type:  eventType,
        Scope: scope,
        Data:  data,
    }

    jsonData, err := json.Marshal(msg)
    if err != nil {
        return err
    }

    h.broadcast <- jsonData
    return nil
}
```

### Redis Relay（多实例部署）

```go
// server/internal/realtime/redis_relay.go
// 当有多个 server 实例时，通过 Redis Pub/Sub 广播消息
type RedisRelay struct {
    pub    *redis.PubConn
    sub    *redis.PubConn
    hub    *Hub
}

func (r *RedisRelay) Start() {
    // 订阅 "multica:ws:global"
    r.sub.Subscribe("multica:ws:global", func(msg redis.MCallback) {
        // 转发到本地 Hub
        r.hub.Broadcast(msg.Payload)
    })
}

func (r *RedisRelay) Publish(scope string, data []byte) {
    // 序列化 scope + data 一起发布
    payload := scope + ":" + string(data)
    r.pub.Publish("multica:ws:global", payload)
}
```

### 前端 WebSocket 客户端

```typescript
// packages/core/api/ws-client.ts
class WSClient {
  private ws: WebSocket | null = null;
  private scopes: Set<string> = new Set();
  private retryCount = 0;

  connect() {
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.retryCount = 0;
      // 重新订阅
      this.scopes.forEach(scope => this.subscribe(scope));
    };
    this.ws.onmessage = (event) => this.handleMessage(event);
    this.ws.onclose = () => this.reconnect();
  }

  subscribe(scope: string, token?: string) {
    this.send({ action: 'subscribe', scope, token });
    this.scopes.add(scope);
  }

  private handleMessage(event: MessageEvent) {
    const msg = JSON.parse(event.data);
    this.emit(msg.type, msg.data);
  }

  private reconnect() {
    if (this.retryCount >= 10) return;
    const delay = 1000 * Math.pow(2, this.retryCount);
    setTimeout(() => {
      this.connect();
      this.retryCount++;
    }, delay);
  }
}
```

---

## 后续扩展

### P1 后续
- **离线消息** - 离线期间的消息补发
- **消息已读** - 标记消息已读状态

### P2 后续
- **消息压缩** - 大批量消息压缩传输
- **WebRTC** - 替代 WebSocket 的更低延迟方案
