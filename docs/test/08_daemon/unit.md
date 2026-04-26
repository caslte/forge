# Daemon - 单元测试

## Daemon 注册

### TC-DAEMON-UNIT-001：注册成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-001 |
| 场景 | 首次注册 |
| 输入 | daemonID, deviceName, agents |
| 预期输出 | runtime 创建成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals |

### TC-DAEMON-UNIT-002：ID 复用

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-002 |
| 场景 | 重启后复用 ID |
| 输入 | 已存在的 daemonID |
| 预期输出 | runtime 记录更新，legacy_daemon_ids 合并 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + DB验证 |

---

## 心跳保活

### TC-DAEMON-UNIT-003：心跳成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-003 |
| 场景 | 正常心跳 |
| 输入 | daemonID, status="running", active_tasks=[] |
| 预期输出 | last_heartbeat_at 更新 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError + DB验证 |

### TC-DAEMON-UNIT-004：心跳超时检测

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-004 |
| 场景 | 超过 30s 无心跳 |
| 输入 | last_heartbeat_at 超过 30 秒前 |
| 预期输出 | runtime 状态标记为 stopped |
| 测试类型 | 单元测试 |
| 断言方式 | DB验证 status="stopped" |

---

## 任务轮询

### TC-DAEMON-UNIT-005：轮询间隔

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-005 |
| 场景 | 验证轮询频率 |
| 输入 | 启动 pollLoop |
| 预期输出 | 每 3 秒调用一次 claim |
| 测试类型 | 单元测试 |
| 断言方式 | assertCalledEvery(3 seconds) |

### TC-DAEMON-UNIT-006：领取任务后停止轮询该任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-006 |
| 场景 | 同一任务被领取后 |
| 输入 | 已 claimed 的 taskID |
| 预期输出 | 再次轮询时不返回该任务 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotReturned |

---

## 任务执行

### TC-DAEMON-UNIT-007：工作目录创建

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-007 |
| 场景 | 任务执行前准备目录 |
| 输入 | workspaceID, taskID |
| 预期输出 | 创建 ~/multica_workspaces/{ws_id}/{task_id}/ |
| 测试类型 | 单元测试 |
| 断言方式 | assertDirExists |

### TC-DAEMON-UNIT-008：技能文件写入

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-008 |
| 场景 | 执行时写入技能 |
| 输入 | task 有关联的 skills |
| 预期输出 | {workDir}/.claude/skills/{name}/SKILL.md 存在 |
| 测试类型 | 单元测试 |
| 断言方式 | assertFileExists |

### TC-DAEMON-UNIT-009：任务超时处理

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-009 |
| 场景 | 任务执行超时 |
| 输入 | timeout=2h，进程运行超过 2h |
| 预期输出 | 进程被 kill，任务标记为 failed |
| 测试类型 | 单元测试 |
| 断言方式 | assertProcessKilled + DB验证 status="failed" |

---

## 健康检查

### TC-DAEMON-UNIT-010：健康检查接口

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-010 |
| 场景 | GET /health |
| 输入 | - |
| 预期输出 | 200 OK + 健康状态 JSON |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals(200) + assertNotNil |

### TC-DAEMON-UNIT-011：健康检查 - 运行中

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-UNIT-011 |
| 场景 | Daemon 运行中 |
| 验证点 | status="healthy" |
| 测试步骤 | GET /health 返回 status="healthy" |

---

## API 测试

### TC-DAEMON-API-001：注册 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-API-001 |
| 场景 | POST /api/daemon/register |
| 输入 | {daemon_id, device_name, agents} |
| 预期输出 | 200 OK + runtime_id |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertNotNil |

### TC-DAEMON-API-002：心跳 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-API-002 |
| 场景 | POST /api/daemon/heartbeat |
| 输入 | {daemon_id, status, active_tasks} |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |

### TC-DAEMON-API-003：健康检查 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-API-003 |
| 场景 | GET /health |
| 输入 | - |
| 预期输出 | 200 OK + 健康状态 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertEquals("healthy") |
