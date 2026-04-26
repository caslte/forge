# 仓库配置 - 单元测试

## 添加仓库

### TC-REPO-UNIT-001：添加仓库成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-UNIT-001 |
| 场景 | 正常添加仓库 |
| 输入 | workspaceID, url="https://github.com/user/repo.git" |
| 预期输出 | 仓库配置创建成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNotNil + DB验证 |

### TC-REPO-UNIT-002：添加仓库 - URL 无效

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-UNIT-002 |
| 场景 | 非 Git URL |
| 输入 | url="http://example.com" |
| 预期输出 | 返回错误 "无效的 Git URL" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-REPO-UNIT-003：添加仓库 - URL 重复

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-UNIT-003 |
| 场景 | 仓库 URL 已存在 |
| 输入 | url="已存在的 URL" |
| 预期输出 | 返回错误 "该仓库已配置" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

### TC-REPO-UNIT-004：添加仓库 - 路径重复

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-UNIT-004 |
| 场景 | 本地路径已被使用 |
| 输入 | local_path="已存在的路径" |
| 预期输出 | 返回错误 "路径已被使用" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

---

## 更新仓库

### TC-REPO-UNIT-005：更新仓库成功

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-UNIT-005 |
| 场景 | 正常更新仓库 |
| 输入 | repoID, branch="develop" |
| 预期输出 | 仓库配置已更新 |
| 测试类型 | 单元测试 |
| 断言方式 | assertEquals + DB验证 |

---

## 删除仓库

### TC-REPO-UNIT-006：删除无关联仓库

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-UNIT-006 |
| 场景 | 删除无执行中任务的仓库 |
| 输入 | repoID |
| 预期输出 | 删除成功 |
| 测试类型 | 单元测试 |
| 断言方式 | assertNoError + DB验证 |

### TC-REPO-UNIT-007：删除有执行中任务的仓库

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-UNIT-007 |
| 场景 | 仓库有 in_progress 任务 |
| 输入 | repoID (有 in_progress 任务) |
| 预期输出 | 返回错误 "该仓库有任务正在执行" |
| 测试类型 | 单元测试 |
| 断言方式 | assertErrorContains |

---

## API 测试

### TC-REPO-API-001：获取仓库列表 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-API-001 |
| 场景 | GET /api/workspaces/:id/repos |
| 输入 | workspaceID |
| 预期输出 | 200 OK + 仓库列表 |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + assertIsArray |

### TC-REPO-API-002：添加仓库 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-API-002 |
| 场景 | POST /api/workspaces/:id/repos |
| 输入 | {url, local_path, branch} |
| 预期输出 | 201 Created + repo JSON |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(201) + DB验证 |

### TC-REPO-API-003：更新仓库 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-API-003 |
| 场景 | PATCH /api/workspaces/:id/repos/:repoId |
| 输入 | {branch: "develop"} |
| 预期输出 | 200 OK + 更新后的 repo |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证 |

### TC-REPO-API-004：删除仓库 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-API-004 |
| 场景 | DELETE /api/workspaces/:id/repos/:repoId |
| 输入 | 存在的 repoID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) + DB验证不存在 |

### TC-REPO-API-005：触发克隆 API

| 属性 | 值 |
|------|-----|
| 用例ID | TC-REPO-API-005 |
| 场景 | POST /api/workspaces/:id/repos/:repoId/clone |
| 输入 | repoID |
| 预期输出 | 200 OK |
| 测试类型 | 单元测试 (API) |
| 断言方式 | assertEquals(200) |
