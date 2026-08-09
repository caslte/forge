# 模型与 Provider 配置 覆盖矩阵

> 模块：05 模型与 Provider 配置
> 来源：PRD 05（docs/prd/05_model_provider.md）
> 状态：规划中
> 层级映射：unit=配置校验/密钥存储逻辑；API=IPC 方法 + models.json 对接；E2E=设置页表单

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | provider 配置、模型选择、持久化、生效四场景 | P0 |
| 字段边界 | 适用 | baseUrl 格式、apiKey 非空、models 至少一项 | P0 |
| 权限角色 | 适用 | 单用户；密钥安全（不明文写入） | P0 |
| 状态流转 | 适用 | 无provider→已配置；会话覆盖不影响全局 | P1 |
| 异常失败 | 适用 | models.json 写失败、无 keychain、pi 重载失败 | P1 |
| 数据一致性 | 适用 | 配置持久化；重启保留；覆盖只影响该会话 | P0 |
| 幂等重复 | 适用 | 重复保存覆盖更新，幂等 | P1 |
| 查询组合 | 适用 | provider 列表/模型列表查询（从 pi 读取） | P2 |
| 前端反馈 | 适用 | 保存成功/校验失败字段标红/无 keychain 提示 | P1 |
| 跨模块影响 | 适用 | 会话使用模型（模块 02）；pi 加载 models.json | P0 |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| AC-MP-001 | MP-S01 Provider 配置 | 跨模块协作 | 正常流程：配置写入并加载 | P0 | - | A-MP-001 | E-MP-001 | 写 models.json，pi 加载该 provider | 依赖 pi 重载 mock |
| AC-MP-002 | MP-S01 Provider 配置 | 安全 | 安全：apiKey 不明文 | P0 | U-MP-001 | A-MP-002 | - | models.json 中 apiKey 为 `!command`/`$ENV_VAR` 引用，非明文 | 安全硬约束 |
| AC-MP-003 | MP-S01 Provider 配置 | 边界 | 异常：无效输入 | P1 | U-MP-002 | A-MP-001 | E-MP-002 | baseUrl 格式无效/apiKey 为空|校验拒绝，不保存 | |
| AC-MP-004 | MP-S01 Provider 配置 | 可用性 | 异常：OS 无 keychain | P1 | - | A-MP-004 | - | 降级提示使用环境变量 | 平台差异 |
| AC-MP-005 | MP-S02 模型选择 | 状态 | 正常流程：全局默认生效 | P0 | - | A-MP-005 | E-MP-003 | 新会话使用全局默认模型 | |
| AC-MP-006 | MP-S02 模型选择 | 状态/一致性 | 正常流程：会话覆盖隔离 | P0 | - | A-MP-006 | E-MP-003 | 会话 1 切模型，会话 2/全局不变 | |
| AC-MP-007 | MP-S03 持久化 | 一致性 | 正常流程：重启保留 | P0 | - | A-MP-007 | E-MP-004 | 重启后 provider 与全局默认仍在 | 只需持久化断言 |
| AC-MP-008 | MP-S04 配置生效 | 状态 | 正常：新会话立即可用 | P0 | - | A-MP-001 | E-MP-001 | 保存后新会话直接用新配置 | 无需重启 |
| AC-MP-009 | MP-S04 配置生效 | 状态 | 正常：运行中切模型 | P1 | - | A-MP-008 | - | 运行中会话切模型下一轮生效 | |

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-MP-001 | AC-MP-003 | provider 校验 | 字段边界 | - | 非法 baseUrl、空 apiKey、空 models | 保存 | 字段校验失败，不写文件 | 无 models.json 变更 |
| U-MP-002 | AC-MP-002/003 | keychainStore | 安全 | OS keychain 可用 | apiKey 明文 | 写入 | models.json 只有 `!command`/`$ENV_VAR` 引用；真实值存 keychain | 文件内不含明文 key |

### api（IPC+models.json 对接）

| 用例 | 关联 AC | 接口 | 前置 | 断言 |
|---|---|---|---|---|
| A-MP-001 | AC-MP-001 | model/saveProvider | 无 provider | 返回 200；models.json 写库；vi 加载 |
| A-MP-002 | AC-MP-002 | model/saveProvider（含 key） | - | 返回的 models.json 不含明文 key |
| A-MP-003 | AC-MP-003 | model/saveProvider（非法） | - | 1001 校验错误，无写库 |
| A-MP-004 | AC-MP-004 | model/saveProvider（无 keychain） | 模拟无 keychain | 降级提示环境变量，仍可保存（用 env 引用） |
| A-MP-005 | AC-MP-005 | model/setDefaultModel | 已配 provider | 200；新会话默认用该模型；持久化 |
| A-MP-006 | AC-MP-006 | model/setSessionModel | 会话已存在 | 仅该会话覆盖；全局与其他会话不受影响 |
| A-MP-007 | AC-MP-007 | model/queryConfig | 已保存配置 | 重启后 provider 与全局默认仍在 |
| A-MP-008 | AC-MP-008/009 | model/saveProvider + conversation | 配置后新会话 | 新会话用新 provider；运行中会话切模型下一轮生效 |

### e2e

| 用例 | 关联 AC | 页面 | 前置 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-MP-001 | AC-MP-001/008 | 设置页 | 无 provider | 合法配置 | mock（写 models.json） | 填表→保存→新会话 | 保存成功提示；写了 models.json；新会话可用 |
| E-MP-002 | AC-MP-003 | 设置页 | - | 非法 baseUrl、空 key | mock | 填非法→保存 | 字段标红提示，不保存 |
| E-MP-003 | AC-MP-005/006 | 会话+设置页 | 多会话+全局默认 | 2 会话 | mock | 设全局默认；会话1切模型 | 全局默认生效；会话1覆盖仅自身生效 |
| E-MP-004 | AC-MP-007 | 设置页 | 已保存配置 | - | real | 重启应用 | 配置与全局默认仍显示 |