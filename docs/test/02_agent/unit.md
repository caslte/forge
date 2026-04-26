# 助手配置 - 单元测试

## 创建助手

### TC-AGENT-UNIT-001：创建助手成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-001 |
| 场景 | 正常创建助手 |
| 输入 | name="Test Agent", runtime_mode="bypassPermissions" |
| 预期输出 | 返回 agent 对象，status="idle" |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals |

### TC-AGENT-UNIT-002：创建助手 - 名称为空

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-002 |
| 场景 | 名称为空 |
| 输入 | name="" |
| 预期输出 | 返回错误 "名称不能为空" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-AGENT-UNIT-003：创建助手 - 名称重复

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-003 |
| 场景 | 助手名称已存在 |
| 输入 | name="Existing Agent" |
| 预期输出 | 返回错误 "助手名称已存在" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-AGENT-UNIT-004：创建助手 - 默认值验证

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-004 |
| 场景 | 不填写可选字段 |
| 输入 | name="Test Agent" |
| 预期输出 | runtime_mode="default", max_concurrent_tasks=1 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

---

## 更新助手

### TC-AGENT-UNIT-005：更新助手成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-005 |
| 场景 | 正常更新助手 |
| 输入 | agentID, instructions="新指令" |
| 预期输出 | agent.instructions 已更新 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

### TC-AGENT-UNIT-006：更新工作中的助手

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-006 |
| 场景 | 尝试更新 working 状态助手 |
| 输入 | agentID (status="working"), name="新名称" |
| 预期输出 | 返回错误 "工作中的助手不可编辑" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-AGENT-UNIT-007：更新助手状态

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-007 |
| 场景 | 正常更新助手状态 |
| 输入 | agentID, status="working" |
| 预期输出 | agent.status = "working" |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

---

## 删除助手

### TC-AGENT-UNIT-008：删除空闲助手成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-008 |
| 场景 | 删除 idle 状态助手 |
| 输入 | agentID (status="idle") |
| 预期输出 | 删除成功，agent_skill 关联同时删除 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError + DB验证 |

### TC-AGENT-UNIT-009：删除工作中的助手

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-009 |
| 场景 | 尝试删除 working 状态助手 |
| 输入 | agentID (status="working") |
| 预期输出 | 返回错误 "工作中的助手不可删除" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-AGENT-UNIT-010：删除助手时级联删除关联

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-010 |
| 场景 | 删除有关联技能的助手 |
| 输入 | 有 2 个关联技能的 agentID |
| 预期输出 | agent 删除后，agent_skill 表中相关记录也删除 |
| 测试类型 | 单元测试 |
| 断言方式 | DB验证关联记录数为 0 |

---

## 助手技能关联

### TC-AGENT-UNIT-011：添加技能关联

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-011 |
| 场景 | 正常添加技能关联 |
| 输入 | agentID, skillID |
| 预期输出 | 关联创建成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + DB验证 |

### TC-AGENT-UNIT-012：添加重复关联

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-012 |
| 场景 | 尝试添加已存在的关联 |
| 输入 | 已关联的 agentID + skillID |
| 预期输出 | 返回错误 "该技能已关联" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-AGENT-UNIT-013：移除技能关联

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-UNIT-013 |
| 场景 | 正常移除技能关联 |
| 输入 | agentID, skillID |
| 预期输出 | 关联删除成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError + DB验证不存在 |

---

## API 测试

### TC-AGENT-API-001：创建助手 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-API-001 |
| 场景 | POST /api/agents |
| 输入 | {name, instructions, runtime_mode} |
| 预期输出 | 201 Created + agent JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-AGENT-API-002：获取助手列表 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-API-002 |
| 场景 | GET /api/agents |
| 输入 | ?status=idle |
| 预期输出 | 200 OK + 分页列表 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertGreaterThan |

### TC-AGENT-API-003：获取助手详情 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-API-003 |
| 场景 | GET /api/agents/:id |
| 输入 | 存在的 agentID |
| 预期输出 | 200 OK + agent JSON 含 skills |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertNotNil |

### TC-AGENT-API-004：更新助手 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-API-004 |
| 场景 | PATCH /api/agents/:id |
| 输入 | {instructions: "新指令"} |
| 预期输出 | 200 OK + 更新后的 agent |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |

### TC-AGENT-API-005：删除助手 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-API-005 |
| 场景 | DELETE /api/agents/:id |
| 输入 | 存在的 agentID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证不存在 |

### TC-AGENT-API-006：添加技能关联 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-API-006 |
| 场景 | POST /api/agents/:id/skills |
| 输入 | {skill_id} |
| 预期输出 | 201 Created + association JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-AGENT-API-007：移除技能关联 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-AGENT-API-007 |
| 场景 | DELETE /api/agents/:id/skills/:skillId |
| 输入 | 存在的关联 |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证不存在 |
