# 模型与 Provider 配置 API

> 模块编号：05
> 来源：PRD 05（docs/prd/05_model_provider.md）
> 状态：已确认
> 传输：Electron IPC；headless 同契约（v2+）

---

## 1. 查询 provider 列表

### model/queryProviderList

**说明**：返回配置中可用 provider（从 pi 已加载的 models.json 读取，MP-S03）。

请求参数：无。

响应：

```json
{
  "providers": [
    {
      "id": "openai",
      "name": "OpenAI",
      "type": "openai",
      "baseUrl": "https://api.openai.com/v1",
      "models": ["gpt-4o", "gpt-4o-mini"],
      "contextWindow": null,
      "vision": true,
      "reasoning": true,
      "thinkingLevels": ["minimal", "low", "medium", "high", "max"],
      "lastError": null
    }
  ]
}
```

`contextWindow`：该 provider 首个模型在 models.json 中的上下文窗口（token 数，模块 05 MP-S06）。v1 表单按「一条配置 = 一个模型」管理，`contextWindow` 对应当前表单模型；多模型配置仅首模型透出（其余在 models.json 中保留、编辑回显不覆盖）。未配置为 `null`（回退 pi 默认）。

`vision`：该 provider 首模型是否支持图片输入（多模态）。`true` = models.json 该模型记录 `input` 数组含 `"image"`；`false`/缺省 = 纯文本（pi 默认）。

`reasoning`（MP-S07）：该 provider 首模型是否启用思考。`true` = models.json 该模型记录 `reasoning: true`；`false` = 未启用（只支持 off）。

`thinkingLevels`（MP-S07）：该 provider 首模型启用的思考等级白名单（仅 `reasoning: true` 时返回）。按 pi `getSupportedThinkingLevels` 语义由 `thinkingLevelMap` 推导：值为 `null` 的项隐藏；minimal/low/medium/high 缺省即可用；xhigh/max 缺省不可用。顺序固定 off→minimal→low→medium→high→xhigh→max。

---

## 2. 保存 / 更新 Provider 配置

### `model/saveProvider`

**说明**：保存 provider 配置，写入 pi `models.json`（MP-S01）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| id | string | 否 | 已有 provider 更新时必填（= 当前别名锚点）。缺省时由 `name` 生成 slug；落盘后读回的 `id` 恒等于 `name`（pi 按 name 作 key）。改 `name` 即改锚点，服务端会把引用旧别名的全局默认与会话覆盖一并改写（见下） |
| name | string | 是 | Provider 名称 |
| type | string | 是 | 类型 |
| baseUrl | string | 否 | 基础 URL |
| models | string[] | 是 | 模型列表 |
| apiKey | string | 否 | API Key（v1 明文直接写入 models.json，与 pi 原生一致） |
| contextWindow | number \| null | 否 | 首个模型的上下文窗口（MP-S06）：传 `1000000` 写入该模型记录 `contextWindow`；传 `null` 移除该字段（回退 pi 默认）；缺省保留原值（不篡改） |
| vision | boolean | 否 | 首模型是否支持图片输入（多模态）：传 `true` 写该模型记录 `input: ["text","image"]`；传 `false` 移除 `input` 字段（回退 pi 默认纯文本，与 MP-S06 一样一律按勾选覆盖）；缺省保留原值（不覆盖手工声明的复杂能力） |
| reasoning | boolean | 否 | 首模型是否启用思考（MP-S07）：传 `true` 写该模型记录 `reasoning: true`；传 `false` 写 `reasoning: false`；缺省保留原值 |
| thinkingLevels | ThinkingLevel[] \| null | 否 | 首模型思考等级白名单（MP-S07）：数组内每项 ∈ off/minimal/low/medium/high/xhigh/max（重复项去重），保存后写该模型记录 `thinkingLevelMap`——选中项值为级别名、未选项为 `null`（全量 7 项显式写出，如 `["high","max"]` → `{off:null,minimal:null,low:null,medium:null,high:"high",xhigh:null,max:"max"}`）；传 `null` 移除 `thinkingLevelMap` 字段；缺省保留原值。搭配 `reasoning: true` 使用；`off` 不参与配置（值为 null 时对话框不出现「关闭思考」挡位） |

响应：`data: null`（成功后承诺事件见 §7）。

**别名锚点（模型选择的存储口径）**：pi `models.json` 的 provider 段以 `name` 为 key，读回时 `id === name === provider key`，这个值同时是「主会话模型 / 会话模型覆盖」在 forge-store 里存的**别名锚点**（见 §4/§5/§6）。因此本方法有两种截然不同的落盘后果：

- **只改 `models`（模型 ID）**：不动任何锚点存储——`settings.defaultModel` 与所有 `session.modelOverride` 存的都是别名，读取时按别名取该配置首模型派生，改完即全站自动跟随（主会话徽标、下拉选中态、思考级别入参都不断链）。
- **改 `name`（别名）**：等于换锚点，服务端在写库成功后**静默传播**——把 `settings.defaultModel` 与所有 `modelOverride === 旧别名` 的会话覆盖改写为新别名。不弹提示、不报条数。

模型 ID 在配置间**允许重复**（不做跨配置去重校验）：归属由锚点决定，不靠模型 ID 反查，重复不会让「主会话」认不出配置。

**落盘附加行为**：写回时若 `baseUrl` 为火山方舟地址（域名含 `volces.com`，如 `https://ark.cn-beijing.volces.com/api/coding/v3`），自动为**没有 `compat`** 的模型记录补充默认兼容块：

```json
{
  "thinkingFormat": "deepseek",
  "supportsDeveloperRole": false,
  "maxTokensField": "max_tokens",
  "requiresReasoningContentOnAssistantMessages": true
}
```

原因：火山 OpenAI 兼容接口不认 pi 默认的 `developer` role / `max_completion_tokens`，且 DeepSeek 系模型多轮对话必须回传 `reasoning_content`。已有手配 `compat` 的模型保留原值不覆盖；非火山地址不注入。

---

## 3. 删除 Provider

`model/deleteProvider`

请求参数：`id`。

响应：`data: null`。若全局默认（主会话）锚点指向该配置（含存量的裸模型 ID 形态），删除后全局默认自动置空。会话覆盖**不**在此清理：残留的悬空别名由 `model/getSessionModel` 读取时降级到全局默认，并在发送前探测自愈时清除（不让会话卡在坏值上）。

---

## 4. 查询模型列表

`model/queryModels`

**用途**：返回可选项（**一条 provider 配置 = 一个可选项**）与全局默认所属配置（MP-S02）。选项以配置别名标识，模型 ID 为该配置首模型的派生值。

请求参数：无。

响应：

```json
{
  "options": [
    { "providerId": "mx", "model": "MiniMax-M3.1-Flash-Preview" },
    { "providerId": "Grok 4.5", "model": "grok-4.5" }
  ],
  "defaultProviderId": "mx"
}
```

- `providerId`：配置别名（= models.json 的 provider key，可含空格），前端据此标记选中项、并作为 §5/§6 写入参数原样回传。
- `model`：该配置的首模型 ID（派生值）。models 为空的配置**不进选项**（无法派生）。
- `defaultProviderId`：全局默认（主会话）所属配置别名；未配置或悬空为 `null`。存量裸模型 ID 形态在此**读时自愈**：解析到归属配置后把 `settings.defaultModel` 回写为该配置别名。

---

## 5. 设置全局默认模型

### model/setDefault

**用途**：把某个已保存配置设为全局默认（主会话）。写入的是**别名锚点**，不是模型 ID——此后改该配置的模型 ID，主会话自动跟着换模型。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| providerId | string \| null | 是 | 配置别名（= provider id）；`null` 清除全局默认 |

校验：`providerId` 非字符串 / 空白 → 1001；配置未保存 → 1004（`模型配置未保存: <别名>`）；配置存在但 models 为空 → 1004（`模型配置 <别名> 没有可用模型`）。**不做模型 ID 形态校验**（别名可含空格，形态校验会误杀合法别名）。

响应：`data: null`；成功后发射 `model.providersChanged`（清除默认同样发射）。

---

## 6. 会话模型

### `model/getSessionModel`

**用途**：查看会话当前生效模型（优先会话覆盖，其次全局默认）。存储是别名，返回派生出的模型 ID。

请求参数：`sessionId`。

响应：

```json
{ "model": "MiniMax-M3.1-Flash-Preview", "providerId": "mx", "effective": "session" }
```

- `model`：生效模型 ID（派生值，pi 消费）；无任何可用配置时为 `null`。
- `providerId`：该模型所属配置别名（UI 标记下拉选中项）；悬空时为 `null`。
- `effective`: `session` / `global`。

覆盖值为存量裸模型 ID 时，解析到归属配置后**回写为别名**（读一次即自愈）；覆盖悬空（配置被删/改名）时不报错，降级返回全局默认（`effective: "global"`）。

### `model/setSessionModel`

**用途**：设置会话级模型覆盖（MP-S02），不影响其他会话。写入的是**配置别名**。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| providerId | string \| null | 是 | 配置别名（`null` 表示清除覆盖回到全局默认） |

只校验非空（别名可含空格），**不**拿配置列表做包含性校验——列表不是权威第二真相，别名是否还在由读取侧降级 + 发送前探测自愈处理。未知会话 → 1002。

响应：`data: null`。

---

## 7. 事件

### model.providersChanged

**触发**：provider 列表变化（新增/修改/删除），以及全局默认模型变化（`model/setDefault` 成功后，含清除默认；主会话模型变化需同步各视图草稿态展示）。

```json
{ "providers": [ ... ] }
```

前端订阅该事件后应重跑 `model/queryModels` + `model/getSessionModel`：改了某配置的模型 ID 时，派生值（下拉标签、设置页 `别名 · 模型 ID`、思考级别入参模型）随之一新，而选中的别名锚点不变。

---

## 8. 模型思考级别

### `model/getModelThinkingLevels`

**用途**：返回指定模型支持的思考级别列表（模块 05 MP-S05）。能力来源为 pi SDK `getSupportedThinkingLevels`（`reasoning` + `thinkingLevelMap` 共同决定）；仅 `["off"]` 时前端隐藏思考级别切换入口（非推理模型）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| model | string | 是 | 模型 ID（= `getSessionModel` 返回的派生 `model`，不是别名锚点）。设置页改了某配置的模型 ID 后，前端按新派生值重查本接口 |

响应：

```json
{ "levels": ["off", "minimal", "low", "medium", "high", "xhigh", "max"] }
```

说明：`levels` 为该模型可用级别列表（顺序固定：off→minimal→low→medium→high→xhigh→max）。**推理模型不返回 `off`**（MP-S07 产品决策：对话框切换器不出现「关闭思考」挡位，服务层过滤；存量配置缺省 off 同样被过滤）；非推理模型仍返回 `["off"]`（供前端隐藏切换入口）。请求级别超出范围由实现层经 pi `clampThinkingLevel` 就近收敛（不在此接口返回）。

---

## 9. 会话思考级别

### `model/getSessionThinkingLevel`

**用途**：查看会话当前生效思考级别（模块 05 MP-S05；优先会话覆盖，其次全局默认）；sessionId 缺省时查全局默认思考级别（草稿态/新建会话未创建时，新会话继承全局）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 否 | 会话 ID；缺省查询全局默认（草稿态，`effective: "global"`） |

响应：

```json
{ "level": "high", "effective": "session" }
```

`effective`: `session`（会话已存值）/ `global`（继承全局默认后快照；sessionId 缺省时恒为 `global`）。

### `model/setSessionThinkingLevel`

**用途**：设置会话思考级别（模块 05 MP-S05）。语义：写当前会话 `thinkingLevel` 覆盖**并同步全局默认**（新会话创建时快照全局默认，故已存在会话互不影响）；已存在会话各自持有已存值。从下一轮对话生效，不打断进行中的回复。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| level | string \| null | 是 | 思考级别（off/minimal/low/medium/high/xhigh/max；null 清除覆盖回全局默认） |

响应：`data: null`。

---

## 10. 连通性测试

### `model/testProvider`

**用途**：设置页「添加/编辑模型」表单中的「测试」按钮，验证填写的地址 / Key / 模型 ID 能否正常收发。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| baseUrl | string | 是 | API 地址，须以 `http(s)://` 开头；服务端拼接 `{baseUrl}/chat/completions`（去尾斜杠） |
| model | string | 是 | 模型 ID |
| apiKey | string | 否 | API Key；空串视为无鉴权（本地推理服务），此时不发 `authorization` 头 |

**行为口径**：
- 参数取**表单当前值**，无需先保存——新建与编辑态都可测。
- 一次 OpenAI 兼容非流式 `chat/completions` 调用（不起 agent 会话、不落盘），`max_tokens: 64`、提示词 `Reply with exactly: ok`，超时 15s。
- 判定「通」= HTTP 200 且响应体无网关业务错误（`base_resp.status_code` / `error`）。思考型模型 200 但 `content` 为空（预算被 reasoning 吃满）**仍判成功**，避免假阴性。
- `apiKey` 即用即弃：只进请求头，绝不入日志、绝不进错误 message。

响应：`data: { latencyMs: number }`（往返耗时，UI 展示「连接成功（342ms）」）。

失败：`1001` 参数非法（不发请求）；`1006` 测试失败，`message` 为人话原因——网络不可达（附 Node 错误原因）、超时、`401/403` Key 无效、`404` 地址或模型不存在、`429` 限流、其它状态码附 provider 错误摘要（截断 200 字符）。

---

## 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误（baseUrl 非法 / apiKey 为空 / 别名锚点 `providerId` 为空或非字符串 / level 非法思考级别；testProvider 地址非 http(s) 亦此码） |
| 1002 | provider / 会话不存在 |
| 1004 | 模型配置未保存 / 配置无可用模型（setDefault 的 `providerId`）；模型未配置（getModelThinkingLevels 的模型不可用） |
| 1006 | 模型连通性测试失败（网络/超时/鉴权/模型不可用；message 不含密钥） |
| 5000 | 内部错误（models.json 写失败 / 思考级别解析异常） |