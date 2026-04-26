# 技能管理 - 单元测试

## 创建技能

### TC-SKILL-UNIT-001：创建技能成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-001 |
| 场景 | 正常创建技能 |
| 输入 | name="Go 编程", content="# Go 编程技能..." |
| 预期输出 | 返回 skill 对象 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + assertEquals |

### TC-SKILL-UNIT-002：创建技能 - 名称为空

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-002 |
| 场景 | 名称为空 |
| 输入 | name="" |
| 预期输出 | 返回错误 "名称不能为空" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-SKILL-UNIT-003：创建技能 - 内容为空

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-003 |
| 场景 | 内容为空 |
| 输入 | name="Go 编程", content="" |
| 预期输出 | 返回错误 "内容不能为空" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-SKILL-UNIT-004：创建技能 - 名称重复

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-004 |
| 场景 | 技能名称已存在 |
| 输入 | name="已存在技能" |
| 预期输出 | 返回错误 "技能名称已存在" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

---

## 更新技能

### TC-SKILL-UNIT-005：更新技能成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-005 |
| 场景 | 正常更新技能 |
| 输入 | skillID, content="新内容..." |
| 预期输出 | skill.content 已更新 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals |

### TC-SKILL-UNIT-006：更新技能 - 名称重复

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-006 |
| 场景 | 尝试使用已存在的名称 |
| 输入 | skillID, name="其他技能名称" |
| 预期输出 | 返回错误 "技能名称已存在" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

---

## 删除技能

### TC-SKILL-UNIT-007：删除无关联技能

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-007 |
| 场景 | 删除无关联的技能 |
| 输入 | 无关联的 skillID |
| 预期输出 | 删除成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError + DB验证 |

### TC-SKILL-UNIT-008：删除有关联技能

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-008 |
| 场景 | 删除有关联的技能 |
| 输入 | 关联了 agent 的 skillID |
| 预期输出 | 返回错误 "该技能已关联到 N 个助手" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-SKILL-UNIT-009：删除技能时级联删除文件

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-009 |
| 场景 | 删除有附件的技能 |
| 输入 | 有 2 个附件文件的 skillID |
| 预期输出 | skill 删除后，skill_file 表中相关记录也删除 |
| 测试类型 | 单元测试 |
| 断言方式 | DB验证文件记录数为 0 |

---

## 技能附件文件

### TC-SKILL-UNIT-010：添加附件文件

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-010 |
| 场景 | 正常添加附件 |
| 输入 | skillID, path="examples/hello.go", content="package main..." |
| 预期输出 | 文件创建成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + DB验证 |

### TC-SKILL-UNIT-011：添加附件 - 路径为空

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-011 |
| 场景 | 路径为空 |
| 输入 | skillID, path="" |
| 预期输出 | 返回错误 "路径不能为空" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-SKILL-UNIT-012：添加附件 - 路径重复

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-012 |
| 场景 | 同一技能下路径重复 |
| 输入 | skillID, path="已存在的路径" |
| 预期输出 | 返回错误 "该路径已存在" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-SKILL-UNIT-013：删除附件文件

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-UNIT-013 |
| 场景 | 正常删除附件 |
| 输入 | fileID |
| 预期输出 | 文件删除成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError + DB验证不存在 |

---

## API 测试

### TC-SKILL-API-001：创建技能 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-API-001 |
| 场景 | POST /api/skills |
| 输入 | {name, description, content} |
| 预期输出 | 201 Created + skill JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-SKILL-API-002：获取技能列表 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-API-002 |
| 场景 | GET /api/skills |
| 输入 | ?search=go |
| 预期输出 | 200 OK + 分页列表 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertGreaterThan |

### TC-SKILL-API-003：获取技能详情 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-API-003 |
| 场景 | GET /api/skills/:id |
| 输入 | 存在的 skillID |
| 预期输出 | 200 OK + skill JSON 含 files 和 agents |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertNotNil |

### TC-SKILL-API-004：更新技能 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-API-004 |
| 场景 | PATCH /api/skills/:id |
| 输入 | {content: "新内容"} |
| 预期输出 | 200 OK + 更新后的 skill |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |

### TC-SKILL-API-005：删除技能 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-API-005 |
| 场景 | DELETE /api/skills/:id |
| 输入 | 存在的 skillID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证不存在 |

### TC-SKILL-API-006：添加附件 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-API-006 |
| 场景 | POST /api/skills/:id/files |
| 输入 | {path, content} |
| 预期输出 | 201 Created + file JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-SKILL-API-007：删除附件 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-SKILL-API-007 |
| 场景 | DELETE /api/skills/:id/files/:fileId |
| 输入 | 存在的 fileID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证不存在 |
