# 任务管理 - 单元测试

## 模块概述

本文档包含任务管理模块的单元测试用例，覆盖所有 Service 层方法和 API 接口。

---

## 创建任务

### TC-ISSUE-UNIT-001：创建任务成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-001 |
| 场景 | 正常创建任务 |
| 输入 | title="测试任务", description="描述", priority="high" |
| 预期输出 | 返回创建的 issue 对象，status="backlog" |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals |

### TC-ISSUE-UNIT-002：创建任务 - 标题为空

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-002 |
| 场景 | 标题为空 |
| 输入 | title="" |
| 预期输出 | 返回错误 "标题不能为空" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-ISSUE-UNIT-003：创建任务 - 标题超长

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-003 |
| 场景 | 标题超过 500 字符 |
| 输入 | title=501字符字符串 |
| 预期输出 | 返回错误 "标题不能超过 500 字符" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-ISSUE-UNIT-004：创建任务 - 默认值验证

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-004 |
| 场景 | 不填写可选字段 |
| 输入 | title="测试任务" |
| 预期输出 | status="backlog", priority="none" |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

---

## 更新任务

### TC-ISSUE-UNIT-005：更新任务状态成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-005 |
| 场景 | 正常更新状态 |
| 输入 | issueID, status="in_progress" |
| 预期输出 | issue.status = "in_progress" |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

### TC-ISSUE-UNIT-006：更新已完成任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-006 |
| 场景 | 尝试更新已完成任务 |
| 输入 | issueID (status="done"), title="新标题" |
| 预期输出 | 返回错误 "已完成任务不可编辑" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-ISSUE-UNIT-007：更新已取消任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-007 |
| 场景 | 尝试更新已取消任务 |
| 输入 | issueID (status="cancelled"), title="新标题" |
| 预期输出 | 返回错误 "已取消任务不可编辑" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-ISSUE-UNIT-008：更新优先级

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-008 |
| 场景 | 正常更新优先级 |
| 输入 | issueID, priority="urgent" |
| 预期输出 | issue.priority = "urgent" |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

---

## 删除任务

### TC-ISSUE-UNIT-009：删除 backlog 任务成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-009 |
| 场景 | 删除 backlog 状态任务 |
| 输入 | issueID (status="backlog") |
| 预期输出 | 删除成功，issue_dependency 关联同时删除 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError + DB验证 |

### TC-ISSUE-UNIT-010：删除执行中任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-010 |
| 场景 | 尝试删除执行中任务 |
| 输入 | issueID (status="in_progress") |
| 预期输出 | 返回错误 "任务执行中，不可删除" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-ISSUE-UNIT-011：删除审核中任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-011 |
| 场景 | 尝试删除审核中任务 |
| 输入 | issueID (status="in_review") |
| 预期输出 | 返回错误 "任务审核中，不可删除" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

---

## 任务状态流转

### TC-ISSUE-UNIT-012：有效状态流转

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-012 |
| 场景 | 测试所有有效状态流转路径 |
| 输入 | backlog→todo→in_progress→in_review→done |
| 预期输出 | 每步状态变更成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals (each step) |

### TC-ISSUE-UNIT-013：任意状态可转为 cancelled

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-013 |
| 场景 | 从任意状态转为 cancelled |
| 输入 | status IN (backlog, todo, in_progress, blocked) |
| 预期输出 | 全部可转为 cancelled |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

---

## 任务依赖

### TC-ISSUE-UNIT-014：添加依赖成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-014 |
| 场景 | 正常添加 blocks 依赖 |
| 输入 | issueA, issueB, type="blocks" |
| 预期输出 | 依赖关系创建成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + DB验证 |

### TC-ISSUE-UNIT-015：添加 blocked_by 依赖

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-015 |
| 场景 | 添加 blocked_by 依赖 |
| 输入 | issueA, issueB, type="blocked_by" |
| 预期输出 | 依赖关系创建成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + DB验证 |

### TC-ISSUE-UNIT-016：循环依赖检测 - A→B→C→A

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-016 |
| 场景 | 尝试创建循环依赖 |
| 输入 | A blocks B, B blocks C, C blocks A |
| 预期输出 | 返回错误 "不能创建循环依赖关系" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-ISSUE-UNIT-017：自依赖检测

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-017 |
| 场景 | 任务依赖自己 |
| 输入 | issueA, issueA |
| 预期输出 | 返回错误 "任务不能依赖自己" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-ISSUE-UNIT-018：删除任务时级联删除依赖

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-UNIT-018 |
| 场景 | 删除有依赖的任务 |
| 输入 | 有 2 个依赖关系的 issueID |
| 预期输出 | issue 删除后，issue_dependency 表中相关记录也删除 |
| 测试类型 | 单元测试 |
| 断言方式 | DB验证依赖记录数为 0 |

---

## API 测试

### TC-ISSUE-API-001：创建任务 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-001 |
| 场景 | POST /api/issues |
| 输入 | {title, description, priority} |
| 预期输出 | 201 Created + issue JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-ISSUE-API-002：获取任务列表 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-002 |
| 场景 | GET /api/issues |
| 输入 | ?status=backlog&priority=high |
| 预期输出 | 200 OK + 分页列表 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertGreaterThan |

### TC-ISSUE-API-003：获取任务详情 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-003 |
| 场景 | GET /api/issues/:id |
| 输入 | 存在的 issueID |
| 预期输出 | 200 OK + issue JSON 含 dependencies |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertNotNil |

### TC-ISSUE-API-004：获取不存在任务

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-004 |
| 场景 | GET /api/issues/:id |
| 输入 | 不存在的 UUID |
| 预期输出 | 404 Not Found |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(404) |

### TC-ISSUE-API-005：更新任务 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-005 |
| 场景 | PATCH /api/issues/:id |
| 输入 | {status: "in_progress"} |
| 预期输出 | 200 OK + 更新后的 issue |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |

### TC-ISSUE-API-006：删除任务 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-006 |
| 场景 | DELETE /api/issues/:id |
| 输入 | 存在的 issueID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证不存在 |

### TC-ISSUE-API-007：添加依赖 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-007 |
| 场景 | POST /api/issues/:id/dependencies |
| 输入 | {depends_on_issue_id, type} |
| 预期输出 | 201 Created + dependency JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-ISSUE-API-008：删除依赖 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-ISSUE-API-008 |
| 场景 | DELETE /api/issues/:id/dependencies/:depId |
| 输入 | 存在的 dependency ID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证不存在 |
