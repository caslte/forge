# 任务执行 - 单元测试

## 任务领取

### TC-TASK-UNIT-001：领取任务成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-001 |
| 场景 | 有待领取任务时领取 |
| 输入 | runtimeID, agentID |
| 预期输出 | 返回任务详情，status="claimed" |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals |

### TC-TASK-UNIT-002：无任务可领取

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-002 |
| 场景 | 队列为空 |
| 输入 | runtimeID, agentID |
| 预期输出 | 返回 null |
| 测试类型 | 单元测试 |
| 断言方式 | assertNil |

### TC-TASK-UNIT-003：助手达到并发上限

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-003 |
| 场景 | 助手已达 max_concurrent_tasks |
| 输入 | agentID (正在执行的任务数 = max) |
| 预期输出 | 返回错误 "达到并发上限" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-TASK-UNIT-004：领取优先级最高的任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-004 |
| 场景 | 多个任务不同优先级 |
| 输入 | 队列中有 urgent, high, medium 任务 |
| 预期输出 | 领取 urgent 任务 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals(urgent) |

### TC-TASK-UNIT-005：同优先级按创建时间领取

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-005 |
| 场景 | 同优先级任务按时间 |
| 输入 | 队列中有 2 个同优先级任务 |
| 预期输出 | 领取创建时间较早的任务 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals(较早创建的任务) |

---

## 任务状态变更

### TC-TASK-UNIT-006：任务开始执行

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-006 |
| 场景 | 调用 start 接口 |
| 输入 | taskID |
| 预期输出 | task.status = "in_progress", started_at 已设置 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals + DB验证 |

### TC-TASK-UNIT-007：任务完成

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-007 |
| 场景 | 正常完成任务 |
| 输入 | taskID, output="执行结果", usage={...} |
| 预期输出 | task.status = "completed", completed_at 已设置 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals + DB验证 |

### TC-TASK-UNIT-008：任务失败

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-008 |
| 场景 | 执行异常 |
| 输入 | taskID, error="执行超时" |
| 预期输出 | task.status = "failed" |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals + DB验证 |

### TC-TASK-UNIT-009：任务取消

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-009 |
| 场景 | 用户取消任务 |
| 输入 | taskID |
| 预期输出 | task.status = "cancelled" |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals + DB验证 |

### TC-TASK-UNIT-010：取消已完成任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-UNIT-010 |
| 场景 | 尝试取消已完成任务 |
| 输入 | taskID (status="completed") |
| 预期输出 | 返回错误 "任务已完成无法取消" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

---

## API 测试

### TC-TASK-API-001：领取任务 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-API-001 |
| 场景 | GET /api/tasks/claim |
| 输入 | X-Runtime-ID, X-Agent-ID headers |
| 预期输出 | 200 OK + task 详情或 null |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) |

### TC-TASK-API-002：开始任务 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-API-002 |
| 场景 | POST /api/tasks/:id/start |
| 输入 | taskID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证状态 |

### TC-TASK-API-003：完成任务 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-API-003 |
| 场景 | POST /api/tasks/:id/complete |
| 输入 | {output, session_id, usage} |
| 预期输出 | 200 OK + task 详情 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |

### TC-TASK-API-004：任务失败 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-API-004 |
| 场景 | POST /api/tasks/:id/fail |
| 输入 | {error, session_id} |
| 预期输出 | 200 OK + task 详情 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |

### TC-TASK-API-005：取消任务 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-API-005 |
| 场景 | POST /api/tasks/:id/cancel |
| 输入 | taskID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证状态 |

### TC-TASK-API-006：获取执行消息 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-API-006 |
| 场景 | GET /api/tasks/:id/messages |
| 输入 | taskID |
| 预期输出 | 200 OK + 消息列表 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertIsArray |

### TC-TASK-API-007：发送执行消息 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-TASK-API-007 |
| 场景 | POST /api/tasks/:id/messages |
| 输入 | {type, content, tool} |
| 预期输出 | 201 Created + message JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |
