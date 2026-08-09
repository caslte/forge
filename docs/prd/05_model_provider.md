# 模型与 Provider 配置 PRD

> 状态：PRD 已确认
> 模块编号：05

## 1. 场景意图

### 1.1 业务背景与目标

forge 对接 pi 的 provider / model 系统。pi 通过 `~/.pi/agent/models.json` 声明 provider 与模型，打开 `/model` 时自动重载。forge 作为 models.json 的可视化编辑器：用户用表单配置第三方 provider（OpenAI / Anthropic / OpenRouter / 自定义 / 本地模型），forge 生成并读写 models.json。密钥安全存储是硬约束（借 pi `!command` 机制 + OS keychain，不明文写入配置）。v1 不涉及扩展层 `registerProvider`（OAuth/非标准 API 留后续）。

### 1.2 场景清单

| 场景 ID | 场景 | 业务价值 | 必须达成 | 明确不做 |
|---|---|---|---|---|
| MP-S01 | Provider 配置 | 配置第三方 LLM provider | 表单配置 -> 生成 pi models.json -> pi 加载 | 不明文存密钥；不自造 provider 系统 |
| MP-S02 | 模型选择 | 选择会话用模型 | 全局默认 + 每会话可覆盖 | 不做复杂 ToolProfile CRUD |
| MP-S03 | 配置持久化 | 保存配置重启保留 | 写 models.json + 全局默认持久化 | 不丢失配置 |
| MP-S04 | 配置生效 | 配置即时生效 | pi 重载 models.json，新会话可用 | 不需重启 |

### 1.3 边界与权限

- **不可接受方案**：明文密钥写入 models.json；自造独立 provider 系统（脱离 pi）；配置丢失；配置不生效。
- **必须满足条件**：对接 pi models.json；密钥借 `!command`（OS keychain）或 `$ENV_VAR` 安全引用；配置持久化；pi 重载即时生效。
- **角色与权限边界**：单用户；密钥本机存储不上传；v1 不用扩展层 registerProvider。

### 1.4 已确认业务决策

- forge 是 pi models.json 的可视化编辑器，不自造独立 provider 系统。
- v1 基础配置（表单配 provider + 模型选择），不做复杂 ToolProfile CRUD，不用扩展层 registerProvider。
- 密钥安全存储：借 pi `!command` 机制从 OS keychain 读，或用 `$ENV_VAR`，不明文写入 models.json。
- 模型配置粒度：全局默认 + 每会话可覆盖。

## 2. 关键技术决策

| 决策 ID | 影响场景 | 关键理由 | 备选方案 | 推荐方案 | 确认结果 |
|---|---|---|---|---|---|
| TD-MP-01 | MP-S01 | 密钥存储方式影响安全（API key 泄露风险） | A: 借 pi `!command` 从 OS keychain 读 + `$ENV_VAR`（不明文写 models.json）；B: 明文写入 models.json | A（安全引用，不明文） | 已确认 |
| TD-MP-02 | MP-S02 | 模型配置粒度影响交互与状态 | A: 全局默认 + 每会话可覆盖；B: 仅全局；C: 仅每会话 | A（全局默认 + 可覆盖） | 已确认 |
| TD-MP-03 | MP-S01/S03 | provider 配置管理方式影响跨模块与升级 | A: 复用 pi models.json（forge 做可视化编辑）；B: forge 自管配置再转 pi；C: 用扩展层 registerProvider | A（复用 models.json，v1 不用 registerProvider） | 已确认 |

> **已采用的常规默认项**：配置即时生效（pi 重载 models.json，新会话直接用；运行中会话切模型下一轮生效）；v1 支持主流 provider（OpenAI / Anthropic / OpenRouter / 本地 OpenAI 兼容）；provider/model 列表从 pi 已注册的获取；表单校验（baseUrl 格式、apiKey 非空）。

> **开发期风险（已计入 overview）**：pi models.json 格式与重载机制对接验证；`!command` 在不同 OS keychain 的可用性（macOS keychain / Windows DPAPI / Linux libsecret）。

---

## 3. 详细设计

### 3.1 模块概述与边界

- **业务目标**：pi models.json 的可视化编辑 + 密钥安全配置 + 模型选择。
- **核心职责**：provider 表单配置（生成 models.json）、密钥安全引用、模型选择（全局默认 + 每会话覆盖）。
- **核心业务对象**：Provider 配置（类型、baseUrl、apiKey 引用、models）；模型选择（全局默认模型、每会话覆盖模型）。
- **涉及角色**：单用户。
- **前置条件**：forge 已启动。
- **上下游与职责边界**：
  - 上游：无（设置入口）。
  - 下游：模块 02 会话管理（会话使用模型）；pi（models.json、认证）。
  - 数据边界：provider 配置存 pi models.json；全局默认模型由 forge 持久化；密钥存 OS keychain，models.json 仅存 `!command`/`$ENV_VAR` 引用。

### 3.2 核心流程与状态

```
表单配 provider(类型+baseUrl+apiKey+models) -> 生成 pi models.json(apiKey 用 !command/env 引用)
   -> pi 打开/model 时重载 -> 新会话可用
模型选择: 设置全局默认 -> 新会话默认用 -> 会话内可切(覆盖, 不影响他会在)
密钥: 用户填 key -> forge 存 OS keychain -> models.json apiKey 设为 !command 引用 -> pi 请求时执行 command 读出
```

### 3.3 功能点

#### 功能点：MP-S01 Provider 配置

- **目标**：用表单配置第三方 provider，生成 pi models.json。
- **前置条件**：无。
- **业务规则**：
  - 表单填：provider 类型（OpenAI / Anthropic / OpenRouter / 自定义）、baseUrl（默认官方，可改代理）、apiKey、models 列表。
  - forge 生成/更新 pi models.json。
  - apiKey 用 `!command` 引用 **forge 自带的跨 OS keychain 读取命令**（如 `!forge-secret get <provider>`，forge 负责 macOS keychain / Windows DPAPI / Linux libsecret 适配），或 `$ENV_VAR`，不明文写入 models.json（TD-MP-01）。
  - 复用 pi models.json，不自造（TD-MP-03）。
- **业务数据**：provider 配置（models.json providers 段）。
- **交互与反馈**：设置页表单填写 -> 保存 -> 写 models.json -> 提示成功。
- **权限边界**：密钥安全是硬约束；密钥本机存储不上传。
- **合法/非法状态流转**：无 provider -> 已配置（合法）；明文 key 写入 models.json（非法）。
- **异常与边界**：models.json 写失败 -> 提示重试；baseUrl 格式无效 / apiKey 空 -> 校验提示，不保存；OS 无 keychain -> 降级提示用 `$ENV_VAR`。
- **数据一致性与幂等**：同 provider 重复配置覆盖更新；models.json 与 pi 期望格式一致。
- **跨模块影响**：pi 加载 models.json 后 provider 可用。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-001 | 表单配置 provider 后写入 pi models.json，pi 能加载该 provider | E2E | 正常流程 | 跨模块协作 | 有效配置 |
| AC-MP-002 | apiKey 不以明文存入 models.json，使用 !command 或 $ENV_VAR 引用 | unit | 安全 | 安全 | 配置含 key |
| AC-MP-003 | baseUrl 格式无效或 apiKey 为空时校验提示，不保存 | unit | 边界 | 输入校验 | 无效输入 |
| AC-MP-004 | OS 无 keychain 时降级提示使用环境变量 | E2E | 异常 | 可用性 | 无 keychain 环境 |

#### 功能点：MP-S02 模型选择

- **目标**：选择会话使用的模型，全局默认 + 每会话可覆盖。
- **前置条件**：至少一个 provider 已配置。
- **业务规则**：从 pi 已注册模型中选；设全局默认模型；每会话可覆盖（切换该会话模型，不影响其他会话）（TD-MP-02）。
- **业务数据**：全局默认模型、每会话覆盖模型。
- **交互与反馈**：设置页选全局默认；会话内可切模型（覆盖）。
- **权限边界**：无。
- **合法/非法状态流转**：全局默认 -> 会话覆盖（合法）；会话覆盖不影响全局与其他会话（合法）。
- **异常与边界**：所选模型不可用（provider 未配）-> 提示。
- **数据一致性与幂等**：全局默认持久化；会话覆盖只影响该会话。
- **跨模块影响**：模块 02 会话使用所选模型。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-005 | 设置全局默认模型后，新会话默认使用该模型 | E2E | 正常流程 | 状态 | 已配 provider |
| AC-MP-006 | 会话内切换模型仅覆盖该会话，不影响其他会话与全局默认 | E2E | 正常流程 | 状态/一致性 | 多会话 |

#### 功能点：MP-S03 配置持久化

- **目标**：配置保存后重启保留。
- **前置条件**：已配置。
- **业务规则**：provider 配置写 pi models.json；全局默认模型由 forge 持久化；重启后加载。
- **业务数据**：models.json、全局默认模型。
- **交互与反馈**：保存即持久化，无额外操作。
- **权限边界**：无。
- **合法/非法状态流转**：不适用。
- **异常与边界**：写失败 -> 提示重试，配置不丢（保留旧值）。
- **数据一致性与幂等**：持久化一致；重复保存幂等。
- **跨模块影响**：pi models.json 持久化。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-007 | 配置保存后重启 forge，provider 与全局默认模型配置仍在 | E2E | 正常流程 | 一致性 | - |

#### 功能点：MP-S04 配置生效

- **目标**：配置即时生效，无需重启。
- **前置条件**：已配置。
- **业务规则**：provider 配置写 models.json 后，pi 打开 `/model` 时重载；新会话直接用新配置；运行中会话切模型从下一轮生效。
- **业务数据**：无。
- **交互与反馈**：保存后新会话立即可用该 provider；会话内切模型下一轮生效。
- **权限边界**：无。
- **合法/非法状态流转**：不适用。
- **异常与边界**：pi 重载失败 -> 提示，可手动触发重载。
- **数据一致性与幂等**：最终一致（pi 重载后生效）。
- **跨模块影响**：pi models.json 重载机制。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-008 | provider 配置保存后，新会话立即可用该 provider | E2E | 正常流程 | 状态 | pi 重载 |
| AC-MP-009 | 运行中会话切换模型后，下一轮对话使用新模型 | E2E | 正常流程 | 状态 | 会话运行中 |

### 3.4 页面承载

- **页面路径与访问权限**：设置页（provider 配置 + 模型选择，无前置权限）；会话内模型切换入口。
- **页面结构**：
```
设置页
┌────────────────────────────────┐
│ Provider 配置                  │
│  类型: [OpenAI ▾]               │
│  baseUrl: [https://...]         │
│  API key: [••••••••] (存keychain)│
│  models: [+ 添加]               │
│  [保存]                         │
├────────────────────────────────┤
│ 模型选择                        │
│  全局默认: [claude-sonnet-4 ▾]  │
└────────────────────────────────┘
```
- **操作入口、按钮和链接**：provider 表单（类型选择/baseUrl/apiKey/models 编辑）；"保存"按钮；全局默认模型下拉；会话内模型切换。
- **表单字段与业务校验**：baseUrl 格式校验；apiKey 非空校验；models 列表（至少一个 model id）。
- **弹窗、loading、成功/失败反馈**：保存成功提示；校验失败字段标红 + 提示；OS 无 keychain 降级提示。
- **失败时的上下文和数据保留**：保存失败时表单内容保留，不丢失输入。

### 3.5 非功能要求

- **性能与容量**：配置保存 < 200ms；模型列表加载 < 200ms；pi models.json 重载 < 500ms。
- **安全与审计**：apiKey 不明文，借 `!command` / `$ENV_VAR`；密钥本机不上传；provider 配置变更记日志。
- **可用性与降级**：OS 无 keychain 降级用环境变量；写失败提示重试。
- **可观测性**：provider 配置变更（provider、模型、时间）记日志。
- **兼容性**：models.json 格式与 pi 兼容；复用 pi 重载机制。

## 4. 自检报告

| 来源 | 来源要求 | 第 3 节承接位置 | AC ID | 结果 | 说明 |
|---|---|---|---|---|---|
| MP-S01 | Provider 配置 | MP-S01 功能点 | AC-MP-001/002/003/004 | PASS | 完整承接，含密钥安全 |
| MP-S01 明确不做 | 不明文存密钥；不自造 provider | MP-S01 业务规则 | AC-MP-002 | PASS | !command/env 引用；复用 pi |
| MP-S02 | 模型选择 | MP-S02 功能点 | AC-MP-005/006 | PASS | 完整承接 |
| MP-S02 明确不做 | 不做复杂 ToolProfile CRUD | MP-S02 业务规则 | N/A | PASS | 明确不做已落实 |
| MP-S03 | 配置持久化 | MP-S03 功能点 | AC-MP-007 | PASS | 完整承接 |
| MP-S03 明确不做 | 不丢失配置 | MP-S03 业务规则 | AC-MP-007 | PASS | 持久化 |
| MP-S04 | 配置生效 | MP-S04 功能点 | AC-MP-008/009 | PASS | 完整承接 |
| MP-S04 明确不做 | 不需重启 | MP-S04 业务规则 | AC-MP-008 | PASS | pi 重载即时 |
| 边界：对接 pi models.json | TD-MP-03 | 3.1 数据边界/MP-S01 | AC-MP-001 | PASS | 复用 pi |
| TD-MP-01 | 密钥安全引用 | MP-S01 业务规则 | AC-MP-002 | PASS | !command/env 不明文 |
| TD-MP-02 | 全局默认+会话覆盖 | MP-S02 业务规则 | AC-MP-005/006 | PASS | 完整承接 |
| TD-MP-03 | 复用 models.json，不用 registerProvider | MP-S01/3.1 | AC-MP-001 | PASS | v1 不用扩展层 |
| 性能量化 | 保存<200ms/重载<500ms | 3.5 性能 | N/A | PASS | 已量化 |
| 证据唯一性 | 无 API/DB 技术细节 | 全文 | N/A | PASS | models.json 是配置文件（非 API/DB）；!command 属技术决策描述 |

> 自检结论：14 项 PASS，0 WARN，0 FAIL。第 1、2 节场景、边界、决策均逐项承接。开发期风险为 pi models.json 格式对接与 `!command` 跨 OS keychain 可用性，已计入 `docs/overview.md`，不阻塞 PRD 确认。
