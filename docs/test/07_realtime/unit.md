# 实时同步 - 单元测试

## WebSocket 连接

### TC-WS-UNIT-001：连接成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-001 |
| 场景 | 有效 Token 连接 |
| 输入 | valid token |
| 预期输出 | 连接成功，返回 connected 消息 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals("connected") |

### TC-WS-UNIT-002：连接失败 - 无效 Token

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-002 |
| 场景 | 无效 Token |
| 输入 | invalid token |
| 预期输出 | 连接拒绝 |
| 测试类型 | 单元测试 |
| 断言方式 | assertError |

---

## 订阅管理

### TC-WS-UNIT-003：订阅 workspace scope

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-003 |
| 场景 | 订阅工作空间范围 |
| 输入 | {action: "subscribe", scope: "workspace:xxx"} |
| 预期输出 | 返回 subscribed 响应 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals("subscribed") |

### TC-WS-UNIT-004：订阅 task scope - 需要 token

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-004 |
| 场景 | 订阅任务范围不带 token |
| 输入 | {action: "subscribe", scope: "task:xxx"} |
| 预期输出 | 返回错误 "需要授权 token" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-WS-UNIT-005：取消订阅

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-005 |
| 场景 | 取消订阅 |
| 输入 | {action: "unsubscribe", scope: "workspace:xxx"} |
| 预期输出 | 返回 unsubscribed 响应 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals("unsubscribed") |

---

## 事件广播

### TC-WS-UNIT-006：issue:created 广播

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-006 |
| 场景 | 创建任务时广播 |
| 输入 | 创建 issue 事件 |
| 预期输出 | 所有订阅 workspace 的客户端收到消息 |
| 测试类型 | 单元测试 |
| 断言方式 | assertMessageSent + assertScope |

### TC-WS-UNIT-007：issue:updated 广播

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-007 |
| 场景 | 更新任务时广播 |
| 输入 | 更新 issue 事件 |
| 预期输出 | 所有订阅 workspace 的客户端收到消息 |
| 测试类型 | 单元测试 |
| 断言方式 | assertMessageSent |

### TC-WS-UNIT-008：task:progress 广播

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-008 |
| 场景 | 任务进度更新时广播 |
| 输入 | 任务进度事件 |
| 预期输出 | 订阅 task 或 workspace 的客户端收到消息 |
| 测试类型 | 单元测试 |
| 断言方式 | assertMessageSent |

### TC-WS-UNIT-009：chat:message 广播

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-009 |
| 场景 | 对话消息时广播 |
| 输入 | 消息内容 |
| 预期输出 | 订阅 chat 的客户端收到消息 |
| 测试类型 | 单元测试 |
| 断言方式 | assertMessageSent + assertType("chat:message") |

### TC-WS-UNIT-010：范围过滤

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-010 |
| 场景 | 未订阅的范围不推送 |
| 输入 | 事件 scope="workspace:A"，客户端订阅 workspace="B" |
| 预期输出 | 该客户端不收到消息 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoMessageSent |

---

## 心跳保活

### TC-WS-UNIT-011：Ping-Pong 正常

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-011 |
| 场景 | 正常心跳 |
| 输入 | {type: "pong"} |
| 预期输出 | 连接保持 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError |

### TC-WS-UNIT-012：Ping 超时断开

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-012 |
| 场景 | 客户端无响应 |
| 输入 | 发送 Ping 后等待 15 秒 |
| 预期输出 | 连接断开 |
| 测试类型 | 单元测试 |
| 断言方式 | assertDisconnected |

---

## 重连机制

### TC-WS-UNIT-013：指数退避

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-013 |
| 场景 | 重连延迟计算 |
| 输入 | 第 3 次重试 |
| 预期输出 | 延迟 = 1000 * 2^3 = 8000ms |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals(8000) |

### TC-WS-UNIT-014：重试上限

| 属性 | 值 |
|------|-----|
| 用例ID | TC-WS-UNIT-014 |
| 场景 | 超过最大重试次数 |
| 输入 | 第 11 次重试 |
| 预期输出 | 停止重试 |
| 测试类型 | 单元测试 |
| 断言方式 | assertStopsRetrying |
