# 模型与 Provider 配置 API

> 模块编号：05
> 来源：PRD 05（docs/prd/05_model_provider.md）
> 状态：规划中
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
      "lastError": null
    }
  ]
}
```

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
| apiKey | string | 否 | API Key（用于加密存储，不明文写入 models.json） |

响应：`data: null`（成功后承诺事件见 §6）。

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

**触发**：provider 列表变化（新增/修改/删除）。

```json
{ "providers": [ ... ] }
```

---

## 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误（baseUrl 非法 / apiKey 为空） |
| 1002 | provider / 会话不存在 |
| 1004 | provider 未配置 |
| 5000 | 内部错误（models.json 写失败、keychain 不可用降级环境变量） |