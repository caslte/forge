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
| id | string | 否 | 已有 provider 更新时必填 |
| name | string | 是 | Provider 名称 |
| type | string | 是 | 类型 |
| baseUrl | string | 否 | 基础 URL |
| models | string[] | 是 | 模型列表 |
| apiKey | string | 否 | API Key（v1 明文直接写入 models.json，与 pi 原生一致） |
| contextWindow | number \| null | 否 | 首个模型的上下文窗口（MP-S06）：传 `1000000` 写入该模型记录 `contextWindow`；传 `null` 移除该字段（回退 pi 默认）；缺省保留原值（不篡改） |
| vision | boolean | 否 | 首模型是否支持图片输入（多模态）：传 `true` 写该模型记录 `input: ["text","image"]`；传 `false` 移除 `input` 字段（回退 pi 默认纯文本，与 MP-S06 一样一律按勾选覆盖）；缺省保留原值（不覆盖手工声明的复杂能力） |
| reasoning | boolean | 否 | 首模型是否启用思考（MP-S07）：传 `true` 写该模型记录 `reasoning: true`；传 `false` 写 `reasoning: false`；缺省保留原值 |
| thinkingLevels | ThinkingLevel[] \| null | 否 | 首模型思考等级白名单（MP-S07）：数组内每项 ∈ off/minimal/low/medium/high/xhigh/max（重复项去重），保存后写该模型记录 `thinkingLevelMap`——选中项值为级别名、未选项为 `null`（全量 7 项显式写出，如 `["high","max"]` → `{off:null,minimal:null,low:null,medium:null,high:"high",xhigh:null,max:"max"}`）；传 `null` 移除 `thinkingLevelMap` 字段；缺省保留原值。搭配 `reasoning: true` 使用；`off` 不参与配置（值为 null 时对话框不出现「关闭思考」挡位） |

响应：`data: null`（成功后承诺事件见 §6）。

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

响应：`data: null`。若为全局默认模型所属 provider，删除后全局默认模型自动置空。

---

## 4. 查询模型列表

`model/queryModels`

**用途**：返回可用模型列表（全局已注册模型，MP-S02）。

请求参数：无。

响应：

```json
{ "models": ["gpt-4o", "claude-sonnet-4"], "defaultModel": "claude-sonnet-4" }
```

---

## 5. 设置全局默认模型

### model/setDefault

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| model | string | 是 | 模型 ID |

响应：`data: null`。

---

## 6. 会话模型

### `model/getSessionModel`

**用途**：查看会话当前生效模型（优先会话覆盖，其次全局默认）。

请求参数：`sessionId`。

响应：

```json
{ "model": "gpt-4o", "effective": "session" }
```

`effective`: `session` / `global`。

### `model/setSessionModel`

**用途**：设置会话级模型覆盖（MP-S02），不影响其他会话。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| model | string | 是 | 模型 ID（null 表示清除覆盖回到全局默认） |

响应：`data: null`。

---

## 7. 事件

### model.providersChanged

**触发**：provider 列表变化（新增/修改/删除），以及全局默认模型变化（`model/setDefault` 成功后，含清除默认；主会话模型变化需同步各视图草稿态展示）。

```json
{ "providers": [ ... ] }
```

---

## 8. 模型思考级别

### `model/getModelThinkingLevels`

**用途**：返回指定模型支持的思考级别列表（模块 05 MP-S05）。能力来源为 pi SDK `getSupportedThinkingLevels`（`reasoning` + `thinkingLevelMap` 共同决定）；仅 `["off"]` 时前端隐藏思考级别切换入口（非推理模型）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| model | string | 是 | 模型 ID（会话当前生效模型的 ID） |

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

## 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误（baseUrl 非法 / apiKey 为空 / level 非法思考级别） |
| 1002 | provider / 会话不存在 |
| 1004 | provider 未配置 / 模型未配置（getModelThinkingLevels 的模型不可用） |
| 5000 | 内部错误（models.json 写失败 / 思考级别解析异常） |