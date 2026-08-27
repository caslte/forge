# 模型与 Provider 配置 PRD

> 状态：PRD 已确认（含扩展 MP-S05 思考级别 / MP-S06 上下文大小 / MP-S07 思考等级配置）
> 模块编号：05

## 1. 场景意图

### 1.1 业务背景与目标

forge 对接 pi 的 provider / model 系统。pi 通过 `~/.pi/agent/models.json` 声明 provider 与模型，打开 `/model` 时自动重载。forge 作为 models.json 的可视化编辑器：用户用表单配置第三方 provider（OpenAI / Anthropic / OpenRouter / 自定义 / 本地模型），forge 生成并读写 models.json。**v1 为尽快联调跑通，apiKey 暂以明文直接写入 `models.json`（与 pi 原生明文形式一致，不经 OS keychain / `$ENV_VAR` 引用）；安全引用（`!command`/`$ENV_VAR`）留至后续迭代。** v1 不涉及扩展层 `registerProvider`（OAuth/非标准 API 留后续）。

### 1.2 场景清单

| 场景 ID | 场景 | 业务价值 | 必须达成 | 明确不做 |
|---|---|---|---|---|
| MP-S01 | Provider 配置 | 配置第三方 LLM provider | 表单配置 -> 生成 pi models.json（v1 明文 apiKey） -> pi 加载 | 不自造 provider 系统 |
| MP-S02 | 模型选择 | 选择会话用模型 | 全局默认 + 每会话可覆盖 | 不做复杂 ToolProfile CRUD |
| MP-S03 | 配置持久化 | 保存配置重启保留 | 写 models.json + 全局默认持久化 | 不丢失配置 |
| MP-S04 | 配置生效 | 配置即时生效 | pi 重载 models.json，新会话可用 | 不需重启 |
| MP-S05 | 思考级别选择 | 输入框模型选择旁切换模型思考级别（如 high/max），控制推理强度与速度 | 按模型能力渲染可用级别；会话级生效；新会话默认跟随全局；非推理模型隐藏入口 | 不做单条消息级切换；不做 thinkingBudgets（各级 token 预算）编辑；不做 thinkingLevelMap 的 provider 侧值（effort 字符串）编辑（等级白名单管理见 MP-S07） |
| MP-S06 | 上下文大小配置 | 模型配置时勾选「上下文 1M」，使大上下文模型启用 100 万 token 上下文 | 勾选→models.json 该模型 contextWindow=1000000；取消→移除该字段；重启保留；编辑回显 | 仅提供 1M 一档，不做多档位/自定义输入；不做运行时上下文参数透传 |
| MP-S07 | 思考等级配置 | 模型配置时勾选「思考强度」并多选常用思考等级，控制对话框可选挡位 | 勾选→写 reasoning:true；多选选中项→thinkingLevelMap 非 null，未选→null；编辑回显；对话框可选级与之一致 | 不做 thinkingLevelMap 的 provider 侧值（effort 字符串）可视化编辑，值恒取级别名 |

### 1.3 边界与权限

- **不可接受方案**：自造独立 provider 系统（脱离 pi）；配置丢失；配置不生效。（v1 明文写入为临时方案，后续迭代再收紧为安全引用）
- **必须满足条件**：对接 pi models.json；配置持久化；pi 重载即时生效。（v1 apiKey 明文写入 models.json，与 pi 原生一致）
- **角色与权限边界**：单用户；密钥本机存储不上传；v1 不用扩展层 registerProvider。

### 1.4 已确认业务决策

- forge 是 pi models.json 的可视化编辑器，不自造独立 provider 系统。
- v1 基础配置（表单配 provider + 模型选择），不做复杂 ToolProfile CRUD，不用扩展层 registerProvider。
- 密钥存储（v1 临时）：直接明文写入 `models.json` 的 `apiKey` 字段，与 pi 原生明文形式一致，便于联调；后续迭代再切换为 `!command`/`$ENV_VAR` 安全引用。
- 模型配置粒度：全局默认 + 每会话可覆盖。
- （扩展 MP-S05）思考级别**不进设置页**，只在输入框模型选择旁切换；切换同时写当前会话并同步全局默认（新会话继承），已存在会话保持各自值不受影响（每会话独立持久化）。
- （扩展 MP-S05）思考级别能力来源为 pi SDK `getSupportedThinkingLevels(model)`：返回级别列表仅 `["off"]` 即非推理模型，隐藏切换入口；不做独立 reasoning 字段判断。
- （扩展 MP-S05）思考级别切换器可选挡位受模型配置的 thinkingLevelMap 白名单约束（MP-S07 写入）：默认（未显式配置）为 off/minimal/low/medium/high 可用、xhigh/max 需显式开启，与 pi 原生缺省一致。
- （扩展 MP-S06）「1M」写入值为 1,000,000（十进制，与 Gemini 官方口径一致）；勾选写 `contextWindow` 字段、取消移除该字段（回退 pi 内置默认值）。
- （扩展 MP-S07）思考等级配置**进设置页模型表单**：思考强度勾选控制 `reasoning` 字段；下方多选下拉选择常用思考等级（minimal/low/medium/high/xhigh/max 六档），选中项写 `thinkingLevelMap` 值为级别名、未选项为 null（隐藏），`off` 不参与配置（恒为 null，对话框不出现「关闭思考」挡位）。保存语义一律按勾选覆盖；对话框思考级别切换器的可选挡位随之变化（经 pi `getSupportedThinkingLevels` 读取）。

## 2. 关键技术决策

| 决策 ID | 影响场景 | 关键理由 | 备选方案 | 推荐方案 | 确认结果 |
|---|---|---|---|---|---|
| TD-MP-01 | MP-S01 | 密钥存储方式影响安全（API key 泄露风险） | A: 借 pi `!command` 从 OS keychain 读 + `$ENV_VAR`（不明文写 models.json）；B: 明文写入 models.json | B（v1 明文，直连 pi；安全引用留后续） | 已确认 |
| TD-MP-02 | MP-S02 | 模型配置粒度影响交互与状态 | A: 全局默认 + 每会话可覆盖；B: 仅全局；C: 仅每会话 | A（全局默认 + 可覆盖） | 已确认 |
| TD-MP-03 | MP-S01/S03 | provider 配置管理方式影响跨模块与升级 | A: 复用 pi models.json（forge 做可视化编辑）；B: forge 自管配置再转 pi；C: 用扩展层 registerProvider | A（复用 models.json，v1 不用 registerProvider） | 已确认 |
| TD-MP-04 | MP-S05 | 思考级别能力来源决定「每个模型有几个级别」的判断正确性 | A: 硬编码固定级别列表；B: 自行解析 models.json 的 reasoning/thinkingLevelMap；C: 消费 pi SDK `getSupportedThinkingLevels(model)` | C（pi SDK 是每模型可用级别的唯一事实来源，forge 不复制过滤规则） | 已确认 |
| TD-MP-05 | MP-S05 | 思考级别作用域与生效规则影响会话数据模型与跨模块协作 | A: 仅会话级（切换只改当前会话，新会话无默认）；B: 全局默认+每会话覆盖（设置页入口）；C: 输入框切换，会话级持久化 + 同步全局默认，已存在会话不变 | C（用户拍板：不进设置页；新会话设置影响全局默认，已存在会话保持各自值） | 已确认 |
| TD-MP-06 | MP-S06 | contextWindow 写入值与取消语义影响 models.json 兼容性与执行行为 | A: 写 1,048,576（2^20）；B: 写 1,000,000（十进制）；C: 取消时置空保留字段 | B（1,000,000 与 Gemini 官方 1M 口径一致）；取消=移除字段，回退 pi 默认（已确认） | 已确认 |
| TD-MP-07 | MP-S07 | thinkingLevelMap 的写入语义决定「对话框可选挡位」与落盘文件的确定性 | A: 仅写选中项；B: 全量 7 项显式写（选中=级别名，未选=null）；C: 复制编辑 map 值 | B（全量显式，文件确定可读，与 pi getSupportedThinkingLevels 语义精确对应：null 隐藏、xhigh/max 需显式非 null） | 已确认 |

> **已采用的常规默认项**：配置即时生效（pi 重载 models.json，新会话直接用；运行中会话切模型下一轮生效）；v1 支持主流 provider（OpenAI / Anthropic / OpenRouter / 本地 OpenAI 兼容）；provider/model 列表从 pi 已注册的获取；表单校验（baseUrl 格式、apiKey 非空）。

> **开发期风险（已计入 overview）**：pi models.json 格式与重载机制对接验证；v1 明文为临时方案，需在后续迭代评估切回 `!command`/`$ENV_VAR` 的迁移成本。

---

## 3. 详细设计

### 3.1 模块概述与边界

- **业务目标**：pi models.json 的可视化编辑 + 密钥安全配置 + 模型选择 +（扩展）按模型能力的思考级别选择 + 上下文大小配置。
- **核心职责**：provider 表单配置（生成 models.json）、密钥安全引用、模型选择（全局默认 + 每会话覆盖）、思考级别选择（输入框入口，会话级 + 全局默认）、上下文大小配置（上下文 1M 勾选）、思考等级配置（思考强度勾选 + 等级多选，MP-S07）。
- **核心业务对象**：Provider 配置（类型、baseUrl、apiKey 明文、models）；模型选择（全局默认模型、每会话覆盖模型）；思考级别（每会话思考级别、全局默认思考级别）；模型上下文配置（contextWindow 字段）；模型思考能力配置（reasoning 字段 + thinkingLevelMap 白名单）。
- **涉及角色**：单用户。
- **前置条件**：forge 已启动。
- **上下游与职责边界**：
  - 上游：无（设置入口 / 输入框）。
  - 下游：模块 02 会话管理（会话模型、会话思考级别）；模块 03 对话（输入框切换器与 max 动画）；pi（models.json、思考级别运行时、上下文窗口）。
  - 数据边界：provider 配置（含明文 apiKey、模型 contextWindow）存 pi models.json；全局默认模型 / 全局默认思考级别 / 每会话思考级别由 forge 持久化。

### 3.2 核心流程与状态

```
表单配 provider(类型+baseUrl+apiKey+models[+上下文1M 勾选]) -> 生成 pi models.json(apiKey 明文)
   -> pi 打开/model 时重载 -> 新会话可用（含 contextWindow）
模型选择: 设置全局默认 -> 新会话默认用 -> 会话内可切(覆盖, 不影响他会在)
思考级别: resolve 模型 -> getSupportedThinkingLevels 得可用级别(仅 off 则隐藏入口)
   -> 输入框切换器选级 -> 写当前会话 + 同步全局默认 -> 下一轮生效(setThinkingLevel)
   -> 新会话继承全局默认；已存在会话保持各自值；切到 max 输入框触发金色流光动画
密钥(v1): 用户填 key -> 直接明文写入 models.json apiKey -> pi 直接读取
上下文 1M: 勾选 -> models.json contextWindow=1000000；取消 -> 移除字段(回 pi 默认)
思考等级(MP-S07): 表单勾选「思考强度」-> reasoning:true；右侧多选选等级 -> thinkingLevelMap
   (选中=级别名, 未选=null) -> pi 重载 -> 对话框思考级别切换器按新白名单渲染可选挡位
```

### 3.3 功能点

#### 功能点：MP-S01 Provider 配置

- **目标**：用表单配置第三方 provider，生成 pi models.json。
- **前置条件**：无。
- **业务规则**：
  - 表单填：provider 类型（OpenAI / Anthropic / OpenRouter / 自定义）、baseUrl（默认官方，可改代理）、apiKey、models 列表。
  - forge 生成/更新 pi models.json，`apiKey` 明文写入 `providers.<id>.apiKey`（与 pi 原生一致，v1 临时）。
  - 复用 pi models.json，不自造（TD-MP-03）。
  - 保存时按地址自动兼容：`baseUrl` 为火山方舟地址（含 `volces.com`）时，自动为缺 `compat` 的模型补默认兼容块（`thinkingFormat: deepseek` / `supportsDeveloperRole: false` / `maxTokensField: max_tokens` / `requiresReasoningContentOnAssistantMessages: true`，适配火山 OpenAI 兼容接口的 developer role / max_completion_tokens / reasoning_content 回传差异）；已有手配 `compat` 保留不覆盖，非火山地址不注入。
- **业务数据**：provider 配置（models.json providers 段，含明文 apiKey）。
- **交互与反馈**：设置页表单填写 -> 保存 -> 写 models.json（明文） -> 提示成功。
- **权限边界**：v1 明文为临时方案，密钥随文件明文存储。
- **合法/非法状态流转**：无 provider -> 已配置（合法）；apiKey 为空 -> 校验失败（非法）。
- **异常与边界**：models.json 写失败 -> 提示重试；baseUrl 格式无效 / apiKey 空 -> 校验提示，不保存。
- **数据一致性与幂等**：同 provider 重复配置覆盖更新；models.json 与 pi 期望格式一致。
- **跨模块影响**：pi 加载 models.json 后 provider 可用。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-001 | 表单配置 provider 后写入 pi models.json（明文 apiKey），pi 能加载该 provider | E2E | 正常流程 | 跨模块协作 | 有效配置 |
| AC-MP-002 | apiKey 以明文存入 models.json（v1 临时，与 pi 原生一致） | unit | 功能 | 持久化 | 配置含 key |
| AC-MP-003 | baseUrl 格式无效或 apiKey 为空时校验提示，不保存 | unit | 边界 | 输入校验 | 无效输入 |
| AC-MP-004 | （已废弃，v1 不涉及 keychain 降级） | - | - | - | - |
| AC-MP-028 | 保存 baseUrl 为火山方舟地址（含 volces.com）的 provider 时，缺 compat 的模型记录自动补默认兼容块；已有手配 compat 保留原值，非火山地址不注入 | unit | 边界 | 持久化 | 火山/非火山地址、有/无 compat |

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

#### 功能点：MP-S05 思考级别选择

- **目标**：输入框模型选择旁提供思考级别切换器，按当前模型的能力渲染可用级别（high/max 等），切换后对会话生效、控制推理强度与速度。
- **前置条件**：会话当前生效模型已配置且支持思考（`getSupportedThinkingLevels` 返回级别列表长度 > 1）。
- **业务规则**：
  - 可用级别来源为 pi SDK `getSupportedThinkingLevels(model)`，forge 不复制过滤规则、不硬编码（TD-MP-04）。
  - 返回列表仅 `["off"]`（非推理模型）时隐藏切换入口；切换器展示当前模型可用级别——推理模型不包含 `off`（MP-S07 产品决策，见 `docs/api/05_model.md` §8 接口说明），**即使仅剩一个可用级别（如 `["max"]`）也显示切换器**。
  - 请求级别超出模型支持范围时经 pi `clampThinkingLevel` 就近收敛为可用级别（TD-MP-04）。
  - 切换同时写当前会话思考级别并同步全局默认；已存在会话各自持久化其级别值，不受其他会话切换影响；新会话创建时继承全局默认（TD-MP-05）。
  - 生效时点：下一轮对话生效，不中断进行中的回复（与切模型规则一致）。
  - 会话思考级别经 pi 会话级 `setThinkingLevel` 应用，随会话 JSONL 持久化，重启保留。
  - 切换模型后：会话思考级别保留已存值，运行时按新模型能力 clamp；会话无已存值时按全局默认。
  - 交互反馈：正常切换无提示；切换到 `max` 级别时输入框触发金色流光动画（光效约 2-3s，纯视觉、不阻塞输入）。
- **业务数据**：每会话思考级别（会话覆盖）、全局默认思考级别（forge 持久化）、可查询当前生效级别。
- **交互与反馈**：输入框模型下拉右侧紧凑下拉/胶囊，显示当前级别；展开列出该模型全部可用级别，点选即切换；选 max 时触发金色流光动画。
- **权限边界**：无额外权限。
- **合法/非法状态流转**：支持思考模型 -> 任意可用级别（合法）；非推理模型 -> 无入口（合法）；请求超范围 -> clamp 就近收敛（合法）；级别查询失败 -> 隐藏切换器并在控制台记录（降级）。
- **异常与边界**：模型解析失败（模型未配置/不可用）-> 不渲染切换器；SDK 查询异常 -> 按无入口降级，不阻塞对话。
- **数据一致性与幂等**：重复选择同一级别幂等；会话覆盖与全局默认相互独立；切换不影响其他会话与进行中的流式输出。
- **跨模块影响**：模块 02（每会话思考级别持久化、新会话继承全局默认）；模块 03（输入框切换器与 max 金色流光动画）；pi（会话级 `setThinkingLevel`）。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-010 | 输入框模型选择旁出现思考级别切换器，选项与 pi `getSupportedThinkingLevels` 返回一致（推理模型不含 off，MP-S07）；非推理模型不显示切换器 | E2E | 正常流程 | 跨模块协作 | 推理/非推理模型各一 |
| AC-MP-011 | 切换思考级别后当前会话下一轮对话按新级别发送；进行中的回复不被中断 | E2E | 正常流程 | 状态 | 会话运行中 |
| AC-MP-012 | 新会话继承全局默认思考级别；已存在会话切换只改本会话，互不影响且不影响全局 | E2E | 正常流程 | 状态/一致性 | 多会话 |
| AC-MP-013 | 请求级别超出模型支持时按 `clampThinkingLevel` 就近收敛为可用级别并生效 | unit | 边界 | 状态 | 越界请求 |
| AC-MP-014 | 切到 max 时输入框触发金色流光动画；切到其他级别无动画且无 toast 提示 | E2E | 正常流程 | 交互 | 支持 max |

#### 功能点：MP-S06 上下文大小配置

- **目标**：模型配置表单增加单档「上下文窗口 1M」勾选，控制该模型在 models.json 中的 contextWindow，使大上下文模型启用 100 万 token 上下文。
- **前置条件**：存在模型配置表单（添加 / 编辑模型）。
- **业务规则**：
  - 表单提供单档勾选「上下文窗口 1M」，位于模型 ID 下方。
  - 勾选保存 -> 写 models.json 该模型记录 `contextWindow: 1000000`（十进制，TD-MP-06）。
  - 取消勾选保存 -> 移除该字段，回退 pi 内置默认（TD-MP-06）。
  - 保存语义一律按勾选状态覆盖：勾选写 1000000，未勾选移除字段（含清掉原有非 1M 配置）。
  - 编辑回显：仅当该模型 contextWindow 严格等于 1000000 时显示勾选；其他值（含缺失、非数字）显示未勾选。
  - 写 models.json 沿用原子写 + .bak 备份；仅写/移除 contextWindow，保留模型记录其他 pi 字段（reasoning/thinkingLevelMap/compat 等）。
  - 配置即时生效：保存后刷新模型运行时缓存，新会话按新 contextWindow 计算上下文用量与压缩阈值。
- **业务数据**：models.json 模型记录 `contextWindow` 字段（1000000 或缺失）。
- **交互与反馈**：勾选/取消即时反馈于勾选框；保存成功提示复用现有表单反馈。
- **权限边界**：无。
- **合法/非法状态流转**：合法态仅两态——字段为 1000000 或字段缺失。
- **异常与边界**：models.json 写失败 -> 提示重试、勾选状态不丢；contextWindow 为非法类型/等值不匹配 -> 按未勾选回显，不误写。
- **数据一致性与幂等**：重复保存幂等；勾选/取消各自幂等；取消移除字段幂等。
- **跨模块影响**：pi ModelRuntime 读取 contextWindow（上下文用量条上限、压缩阈值、上下文百分比）；新会话即生效，无需重启。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-015 | 勾选「上下文窗口 1M」保存后，models.json 该模型记录出现 `contextWindow: 1000000` | E2E | 正常流程 | 持久化 | 需本地 pi 配置 |
| AC-MP-016 | 取消勾选保存后，models.json 该模型记录移除 `contextWindow` 字段 | E2E | 正常流程 | 持久化 | 需本地 pi 配置 |
| AC-MP-017 | 编辑已有非 1M contextWindow（如 200000）的模型，表单显示未勾选；直接保存即移除该字段（一律按勾选覆盖） | unit | 边界 | 一致性 | 存量非 1M 配置 |
| AC-MP-018 | contextWindow 恰为 1000000 的模型编辑时勾选回显 | unit | 正常流程 | 状态 | 等值比较 |
| AC-MP-019 | 保存 1M 配置后，新会话上下文窗口上限按 1000000 计算（上下文用量显示/压缩阈值随之变化） | E2E | 正常流程 | 跨模块协作 | 已配 1M 模型 |

#### 功能点：MP-S07 思考等级配置

- **目标**：模型配置表单增加「思考强度」勾选与思考等级多选下拉，控制该模型在 models.json 中的 `reasoning` 与 `thinkingLevelMap`，从而决定对话框思考级别切换器的可选挡位。
- **前置条件**：存在模型配置表单（添加 / 编辑模型）。
- **业务规则**：
  - 表单布局：思考强度为独立勾选行（与「上下文 1M / 支持图片输入」样式一致），其下方为思考等级多选下拉（minimal/low/medium/high/xhigh/max 共 6 档；off 不参与配置，写 null 隐藏，对话框切换器不出现「关闭思考」挡位）。
  - 勾选「思考强度」保存 -> 写该模型记录 `reasoning: true`；未勾选 -> 写 `reasoning: false` 并移除 `thinkingLevelMap`。
  - 保存语义一律按勾选状态覆盖：选中级别写 `thinkingLevelMap[级别] = 级别名`（如 `"high": "high"`），未选级别写 `null`（隐藏该挡位），全量 7 项显式写出（TD-MP-07）。
  - 编辑回显：思考强度按 `reasoning === true` 勾选；白名单按 pi `getSupportedThinkingLevels` 语义推导（null=隐藏；minimal/low/medium/high 缺省即可用；xhigh/max 缺省不可用），过滤 off，缺失/空回退默认集 minimal/low/medium/high。
  - 生效链路：保存 -> 写 models.json -> pi 重载 -> 对话框思考级别切换器（MP-S05）按新白名单渲染可选挡位。
  - 写 models.json 沿用原子写 + .bak 备份；仅写/移除 reasoning 与 thinkingLevelMap，保留模型记录其他 pi 字段（contextWindow/input/compat 等）。
  - 未启用思考（reasoning 非 true）时，对话框无思考级别切换入口（仅 `["off"]`，MP-S05）。
- **业务数据**：models.json 模型记录 `reasoning` 布尔字段 + `thinkingLevelMap` 对象（7 档，值为级别名或 null）。
- **交互与反馈**：未勾选思考强度时下拉禁用置灰（文案「未启用思考」）；勾选后下拉可展开勾选各挡位，触发器显示已选挡位；编辑回显与列表项联动（列表展示无变化）。
- **权限边界**：无。
- **合法/非法状态流转**：合法态 = 布尔值 reasoning + 全量 7 项 map（值为级别名或 null）；非法（reasoning 非布尔 / 白名单非 THINKING_LEVELS 内去重列表）-> 1001 不写。
- **异常与边界**：models.json 写失败 -> 提示重试、勾选状态不丢；存量手工 thinkingLevelMap（含自定义值如 `{"high": "custom"}`）在表单保存后会重写为全量显式形态（值恒为级别名，TD-MP-07 取舍）；未显式配置的模型保存表单不触碰 reasoning/thinkingLevelMap（缺省保留）。
- **数据一致性与幂等**：重复保存幂等；勾选/取消各自幂等；全量 map 写出确定性一致。
- **跨模块影响**：pi（models.json 的 reasoning/thinkingLevelMap 字段、思考级别运行时）；模块 03 对话框思考级别切换器（可选挡位随白名单变化）。

验收标准：

| AC ID | 验收事实 | 验证层级 | 场景 | 风险维度 | 边界条件 |
|---|---|---|---|---|---|
| AC-MP-023 | 勾选「思考强度」并勾选部分等级（如 off/high/max）保存后，models.json 该模型记录出现 `reasoning: true` 与 `thinkingLevelMap`（选中=级别名，未选=null） | unit | 正常流程 | 持久化 | 部分选中 |
| AC-MP-024 | 取消「思考强度」保存后，models.json 写 `reasoning: false` 并移除 `thinkingLevelMap` | unit | 正常流程 | 持久化 | 关闭思考 |
| AC-MP-025 | 编辑既有思考配置模型回显一致（reasoning 勾选态、白名单挡位与 pi 语义推导一致） | unit | 正常流程 | 状态 | 存量配置 |
| AC-MP-026 | 非法输入（reasoning 非布尔 / 白名单含非法级别或重复）保存被拒（1001），不写文件 | unit | 边界 | 输入校验 | 非法值 |
| AC-MP-027 | 保存思考等级配置后，对话框思考级别切换器可选挡位与白名单一致（未选挡位不再出现） | E2E | 正常流程 | 跨模块协作 | 已配白名单模型 |

### 3.4 页面承载

- **页面路径与访问权限**：设置页（provider 配置 + 模型选择，无前置权限）；会话内模型切换入口；输入框（模型选择旁思考级别切换器，MP-S05）。
- **页面结构**：
```
设置页
┌────────────────────────────────┐
│ Provider 配置                  │
│  类型: [OpenAI ▾]               │
│  baseUrl: [https://...]         │
│  API key: [••••••••] (存keychain)│
│  models: [+ 添加]               │           模型 ID: [grok-4.5]
│  [保存]                         │           ☑ 上下文窗口 1M   ← MP-S06 勾选
│                                │           ☑ 支持图片输入（多模态）
│                                │           ☑ 思考强度
│                                │           [未启用思考 / off / high / max ▾]  ← MP-S07 多选下拉
├────────────────────────────────┤
│ 模型选择                        │
│  全局默认: [claude-sonnet-4 ▾]  │
└────────────────────────────────┘
对话输入框
┌────────────────────────────────┐
│ [模型 ▾] [思考级别 high ▾]       │  ← 模型选择旁思考级别切换器(MP-S05)
│ 输入……                          │     仅可用级别>off 时显示；max 触发金色流光
└────────────────────────────────┘
```
- **操作入口、按钮和链接**：provider 表单（类型选择/baseUrl/apiKey/模型 ID/上下文窗口 1M 勾选/多模态勾选/思考强度勾选+思考等级多选下拉编辑）；"保存"按钮；全局默认模型下拉；会话内模型切换；输入框思考级别切换器。
- **表单字段与业务校验**：baseUrl 格式校验；apiKey 非空校验；模型 ID 非空；上下文窗口 1M 为复选（无独立校验，保存时按勾选状态写/移除 contextWindow）；多模态为复选；思考强度为复选（无独立校验）；思考等级多选下拉（六档，off 不展示且写 null 隐藏；下拉在未勾选思考强度时禁用）。
- **弹窗、loading、成功/失败反馈**：保存成功提示；校验失败字段标红 + 提示；切到 max 级别时输入框金色流光动画（约 2-3s，不弹窗）。
- **失败时的上下文和数据保留**：保存失败时表单内容保留，不丢失输入；勾选状态保留。

### 3.5 非功能要求

- **性能与容量**：配置保存 < 200ms；模型列表加载 < 200ms；pi models.json 重载 < 500ms；思考级别可用列表查询（resolve 模型 + `getSupportedThinkingLevels`）< 200ms；max 金色流光动画帧率 ≥ 30fps 且不阻塞输入事件。
- **安全与审计**：v1 明文为临时方案；provider 配置变更记日志（不含明文回显）；思考级别切换记注入日志（会话、级别、时间）。
- **可用性与降级**：写失败提示重试；思考级别查询失败时隐藏切换器，不影响对话主流程。
- **可观测性**：provider 配置变更（provider、模型、时间）、思考级别切换（会话、级别、时间）记日志。
- **兼容性**：models.json 格式与 pi 兼容（明文 apiKey、contextWindow 数值）；复用 pi 重载/思考级别运行时机制；金色流光动画为纯 CSS/合成器动画，不影响输入框功能。

## 4. 自检报告

| 来源 | 来源要求 | 第 3 节承接位置 | AC ID | 结果 | 说明 |
|---|---|---|---|---|---|
| MP-S01 | Provider 配置 | MP-S01 功能点 | AC-MP-001/002/003/004 | PASS | 完整承接，含密钥安全 |
| MP-S01 明确不做 | 不自造 provider | MP-S01 业务规则 | AC-MP-001 | PASS | 复用 pi；v1 明文 |
| MP-S02 | 模型选择 | MP-S02 功能点 | AC-MP-005/006 | PASS | 完整承接 |
| MP-S02 明确不做 | 不做复杂 ToolProfile CRUD | MP-S02 业务规则 | N/A | PASS | 明确不做已落实 |
| MP-S03 | 配置持久化 | MP-S03 功能点 | AC-MP-007 | PASS | 完整承接 |
| MP-S03 明确不做 | 不丢失配置 | MP-S03 业务规则 | AC-MP-007 | PASS | 持久化 |
| MP-S04 | 配置生效 | MP-S04 功能点 | AC-MP-008/009 | PASS | 完整承接 |
| MP-S04 明确不做 | 不需重启 | MP-S04 业务规则 | AC-MP-008 | PASS | pi 重载即时 |
| MP-S05 | 思考级别选择 | MP-S05 功能点 | AC-MP-010/011/012/013/014 | PASS | 完整承接，含 max 动画 |
| MP-S05 明确不做 | 不做单条消息级切换 / thinkingBudgets 编辑 / thinkingLevelMap 可视化编辑 | MP-S05 业务规则与边界 | N/A | PASS | 明确不做已落实 |
| MP-S06 | 上下文大小配置 | MP-S06 功能点 | AC-MP-015/016/017/018/019 | PASS | 完整承接 |
| MP-S06 明确不做 | 仅 1M 一档 / 不做运行时上下文参数透传 | MP-S06 业务规则与边界 | N/A | PASS | 明确不做已落实 |
| MP-S07 | 思考等级配置 | MP-S07 功能点 | AC-MP-023/024/025/026/027 | PASS | 完整承接 |
| MP-S07 明确不做 | 不做 map 值（provider 侧 effort 字符串）可视化编辑 | MP-S07 业务规则与边界 | N/A | PASS | 值恒取级别名；白名单编辑 |
| 边界：对接 pi models.json | TD-MP-03 | 3.1 数据边界/MP-S01 | AC-MP-001 | PASS | 复用 pi |
| TD-MP-01 | 密钥明文写入（v1 临时） | MP-S01 业务规则 | AC-MP-002 | PASS | 明文直写，后续再安全引用 |
| TD-MP-02 | 全局默认+会话覆盖 | MP-S02 业务规则 | AC-MP-005/006 | PASS | 完整承接 |
| TD-MP-03 | 复用 models.json，不用 registerProvider | MP-S01/3.1 | AC-MP-001 | PASS | v1 不用扩展层 |
| TD-MP-04 | 思考级别能力来源 = pi SDK | MP-S05 业务规则 | AC-MP-010/013 | PASS | getSupportedThinkingLevels 唯一事实来源 |
| TD-MP-05 | 输入框切换 + 会话级 + 同步全局默认 | MP-S05 业务规则/3.1 | AC-MP-011/012 | PASS | 已存在会话各自保持 |
| TD-MP-06 | contextWindow=1000000，取消移除字段 | MP-S06 业务规则 | AC-MP-015/016/017 | PASS | 十进制 1M，移除回 pi 默认 |
| TD-MP-07 | thinkingLevelMap 全量 7 项显式写出（选中=级别名，未选=null） | MP-S07 业务规则 | AC-MP-023/025 | PASS | 文件确定可读，与 pi 语义精确对应 |
| 性能量化 | 保存<200ms/重载<500ms/级别查询<200ms/动画≥30fps | 3.5 性能 | N/A | PASS | 已量化 |
| 证据唯一性 | 无 API/DB 技术细节 | 全文 | N/A | PASS | models.json 是配置文件；contextWindow 为 pi 配置字段，非 API/DB 设计 |

> 自检结论：22 项 PASS，0 WARN，0 FAIL。第 1、2 节场景、边界、决策均逐项承接（含扩展 MP-S05/MP-S06/MP-S07）。开发期风险为思考级别运行时（getSupportedThinkingLevels / setThinkingLevel）与 forge 会话模型覆盖的衔接验证、max 金色流光动画的视觉还原度，已计入 `docs/overview.md`，不阻塞 PRD 确认。
