# Daemon - E2E 测试

## Daemon 启动

### TC-DAEMON-E2E-001：Daemon 启动注册

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-001 |
| 场景 | Daemon 启动并注册 |
| 验证点 | 注册成功、heartbeat 开始 |
| 测试步骤 | 1. 启动 Daemon<br>2. 检查日志<br>3. 验证注册成功<br>4. 验证心跳开始 |

### TC-DAEMON-E2E-002：Daemon ID 持久化

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-002 |
| 场景 | Daemon 重启后 ID 不变 |
| 验证点 | 重启前后 daemon_id 一致 |
| 测试步骤 | 1. 停止 Daemon<br>2. 重新启动<br>3. 检查 daemon.id 文件<br>4. 验证 ID 与之前一致 |

---

## 任务轮询与执行

### TC-DAEMON-E2E-003：自动领取任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-003 |
| 场景 | 有待执行任务时自动领取 |
| 验证点 | 任务被领取、执行开始 |
| 测试步骤 | 1. 通过 API 创建任务并指派给助手<br>2. 等待轮询（最多 3 秒）<br>3. 验证任务被领取<br>4. 验证任务状态变为 in_progress |

### TC-DAEMON-E2E-004：任务执行进度推送

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-004 |
| 场景 | 任务执行中 WebSocket 推送 |
| 验证点 | 进度事件实时推送 |
| 测试步骤 | 1. 任务开始执行<br>2. 观察 WebSocket 推送<br>3. 验证 task:progress 事件 |

### TC-DAEMON-E2E-005：任务完成

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-005 |
| 场景 | 任务执行完成 |
| 验证点 | 状态变更、结果回传 |
| 测试步骤 | 1. 任务执行完成<br>2. 验证 issue.status = "done"<br>3. 验证 agent_task_queue.status = "completed" |

### TC-DAEMON-E2E-006：任务失败

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-006 |
| 场景 | 任务执行异常 |
| 验证点 | 状态变更、错误记录 |
| 测试步骤 | 1. 任务执行失败<br>2. 验证 agent_task_queue.status = "failed"<br>3. 验证 error 字段记录 |

---

## 任务取消

### TC-DAEMON-E2E-007：取消执行中任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-007 |
| 场景 | 用户取消正在执行的任务 |
| 验证点 | 进程终止、状态更新 |
| 测试步骤 | 1. 任务正在执行<br>2. 通过 API 取消任务<br>3. 验证 Claude Code 进程被终止<br>4. 验证任务状态变为 cancelled |

---

## 并发控制

### TC-DAEMON-E2E-008：助手并发限制

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-008 |
| 场景 | max_concurrent_tasks=1 的助手 |
| 验证点 | 同时只有一个任务执行 |
| 测试步骤 | 1. 创建 2 个任务指派给同一助手<br>2. 验证只有第一个任务开始执行<br>3. 等待第一个完成<br>4. 验证第二个开始执行 |

---

## 心跳与健康

### TC-DAEMON-E2E-009：心跳发送

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-009 |
| 场景 | Daemon 定期发送心跳 |
| 验证点 | 每 15 秒发送一次 |
| 测试步骤 | 1. 查看 Daemon 日志<br>2. 验证每 15 秒有心跳日志 |

### TC-DAEMON-E2E-010：健康检查接口

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-010 |
| 场景 | GET /health |
| 验证点 | 返回健康状态 |
| 测试步骤 | 1. 访问 GET /health<br>2. 验证返回 JSON 包含 status |

---

## GC 垃圾回收

### TC-DAEMON-E2E-011：过期工作目录清理

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-011 |
| 场景 | 24 小时前的已完成任务目录被清理 |
| 验证点 | 目录被删除 |
| 测试步骤 | 1. 手动创建过期的任务目录<br>2. 等待 GC 执行<br>3. 验证目录被删除 |

### TC-DAEMON-E2E-012：GC 禁用

| 属性 | 值 |
|------|-----|
| 用例ID | TC-DAEMON-E2E-012 |
| 场景 | GC_ENABLED=false |
| 验证点 | 不执行 GC |
| 测试步骤 | 1. 设置 MULTICA_GC_ENABLED=false<br>2. 重启 Daemon<br>3. 验证无 GC 日志 |
