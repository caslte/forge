# 对话功能 - 单元测试

## 创建会话

### TC-CHAT-UNIT-001：创建会话成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-001 |
| 场景 | 正常创建会话 |
| 输入 | agentID, title="测试会话" |
| 预期输出 | 返回 session 对象，status="active" |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals |

### TC-CHAT-UNIT-002：创建会话 - 助手不存在

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-002 |
| 场景 | 使用不存在的助手 |
| 输入 | agentID (不存在) |
| 预期输出 | 返回错误 "助手不存在" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-CHAT-UNIT-003：创建会话 - 默认标题

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-003 |
| 场景 | 不填写标题 |
| 输入 | agentID |
| 预期输出 | title 为 null（后续使用第一条消息作为标题） |
| 测试类型 | 单元测试 |
| 断言方式 | assertNil |

---

## 发送消息

### TC-CHAT-UNIT-004：发送消息成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-004 |
| 场景 | 正常发送消息 |
| 输入 | sessionID, content="你好" |
| 预期输出 | 返回 message 对象，role="user" |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals |

### TC-CHAT-UNIT-005：发送消息 - 会话已归档

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-005 |
| 场景 | 向已归档会话发送消息 |
| 输入 | sessionID (status="archived"), content="你好" |
| 预期输出 | 返回错误 "会话已归档" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-CHAT-UNIT-006：发送消息 - 内容超长

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-006 |
| 场景 | 消息内容超过 50000 字符 |
| 输入 | sessionID, content=50001字符 |
| 预期输出 | 返回错误 "消息内容过长" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

---

## 会话列表

### TC-CHAT-UNIT-007：获取会话列表

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-007 |
| 场景 | 正常获取会话列表 |
| 输入 | creatorID |
| 预期输出 | 返回会话列表，按最后更新时间倒序 |
| 测试类型 | 单元测试 |
| 断言方式 | assertIsArray + assertSortedByUpdatedAt |

### TC-CHAT-UNIT-008：筛选会话 - 按状态

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-008 |
| 场景 | 按状态筛选 |
| 输入 | status="active" |
| 预期输出 | 只返回 active 状态的会话 |
| 测试类型 | 单元测试 |
| 断言方式 | assertAllMatch |

---

## 删除会话

### TC-CHAT-UNIT-009：删除会话（软删除）

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-UNIT-009 |
| 场景 | 正常删除会话 |
| 输入 | sessionID |
| 预期输出 | session.status = "deleted" |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals("deleted") + DB验证 |

---

## API 测试

### TC-CHAT-API-001：创建会话 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-API-001 |
| 场景 | POST /api/chat/sessions |
| 输入 | {agent_id, title} |
| 预期输出 | 201 Created + session JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-CHAT-API-002：获取会话列表 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-API-002 |
| 场景 | GET /api/chat/sessions |
| 输入 | ?status=active |
| 预期输出 | 200 OK + 分页列表 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertGreaterThan |

### TC-CHAT-API-003：获取会话详情 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-API-003 |
| 场景 | GET /api/chat/sessions/:id |
| 输入 | 存在的 sessionID |
| 预期输出 | 200 OK + session JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertNotNil |

### TC-CHAT-API-004：发送消息 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-API-004 |
| 场景 | POST /api/chat/sessions/:id/messages |
| 输入 | {content} |
| 预期输出 | 200 OK + message JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertNotNil |

### TC-CHAT-API-005：获取消息历史 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-API-005 |
| 场景 | GET /api/chat/sessions/:id/messages |
| 输入 | sessionID |
| 预期输出 | 200 OK + 消息列表 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertIsArray |

### TC-CHAT-API-006：删除会话 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-API-006 |
| 场景 | DELETE /api/chat/sessions/:id |
| 输入 | 存在的 sessionID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 status="deleted" |

### TC-CHAT-API-007：更新会话 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-CHAT-API-007 |
| 场景 | PATCH /api/chat/sessions/:id |
| 输入 | {status: "archived"} |
| 预期输出 | 200 OK + 更新后的 session |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |
