# 对话与消息 API

> 模块编号：03
> 来源：PRD 03（docs/prd/03_conversation.md）
> 状态：已确认
> 传输：Electron IPC（方法 + 事件）；headless 同契约（v2+）

---

## 1. 发送消息

### conversation/sendMessage

**说明**：向会话发送用户消息，触发 AI 处理并进入流式响应（CV-S01）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| content | string | 是 | 消息内容（非空） |
| attachments | array | 否 | 附件列表（P3-B）：`{ kind: 'image', name, mimeType, data }` 图片（base64）/ `{ kind: 'text', name, content }` 文本 |

响应：

- `data: null`：正常（消息已在对话区即时展示；后续内容靠事件推送）。
- `data: { "skippedImages": number }`：多模态门控生效——发送时当前生效模型的 `input` 能力不含 `"image"`，已自动跳过图片附件仅发送文字（内容中追加说明），附件不会触发对方 API 报错。`skippedImages` 为跳过的图片数量。

| code | 说明 |
|------|------|
| 1004 | provider 未配置，前端提示引导配置 |
| 1002 | 会话不存在 |

---

## 2. 取消响应

### conversation/cancelStream

**说明**：停止当前处理，保留已生成内容（CV-S04）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：`data: null`。

---

## 3. 查询历史

### conversation/queryHistory

**参数**

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| sessionId | string | 是 | 会话 ID |

**响应 data**

```json
{
  "messages": [
    { "role": "user", "content": "你好", "ts": "2026-08-31T09:00:00.000Z" }
  ]
}
```

---

## 4. 上下文用量

### conversation/getContextUsage

**参数**：`{ sessionId }`

**响应 data**

```json
{
  "usage": { "tokens": 42000, "contextWindow": 128000, "percent": 32.8 }
}
```

`usage` 为 `null` 表示当前无法获取用量（会话未激活或运行时不支持），UI 显示未知。

> 压缩边界之后、尚无新的助手响应前，运行时无法给出可信用量，此时返回
> `{ "tokens": null, "contextWindow": 128000, "percent": null }`。
> UI 须显示「未知」而非 0，否则用户会误判压缩未生效。

---

## 5. 手动压缩

### conversation/compact

**参数**：`{ sessionId }`

**响应 data**

```json
{
  "result": {
    "ok": true,
    "tokensBefore": 90000,
    "tokensAfter": 12000,
    "summary": "上下文摘要…"
  }
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| result.ok | boolean | 是否压缩成功 |
| result.message | string? | 失败原因（仅 ok=false；如「会话未激活，无法压缩」） |
| result.tokensBefore | number? | 压缩前 token 数；未知为 null |
| result.tokensAfter | number? | 压缩后估算 token 数；未知为 null |
| result.summary | string? | 压缩摘要；未知为 null |

**错误码**：1001 参数错误 / 1002 会话不存在 / 5000 压缩异常（不破坏会话历史）。

**流式限制**：运行时压缩会先中止当前轮（`abort`），因此 UI 在 streaming 期间禁用压缩入口，避免静默截断正在生成的回答。

---

## 6. 事件（流式推送）

所有流式内容由事件单向推送，前端增量渲染 DOM。

### conversation.delta

**触发**：AI 回复 token 增量。

```json
{
  "sessionId": "sess_xxx",
  "delta": { "text": "修", "kind": "text" }
}
```

`kind`: `text`（正文增量）。

### conversation.message

**触发**：一条完整消息完成（assistant 或 user）。

```json
{
  "sessionId": "sess_xxx",
  "message": { "role": "assistant", "content": "...", "ts": "..." }
}
```

### conversation.statusChanged

**触发**：会话执行状态变化。

```json
{
  "sessionId": "sess_xxx",
  "status": "streaming"
}
```

`status`: `streaming` / `done` / `canceled` / `error`

### conversation.error

**触发**：处理出错（如 provider 失败、流中断）。

```json
{
  "sessionId": "sess_xxx",
  "code": 5000,
  "message": "stream interrupted"
}
```

流转时中断标记：出现 `conversation.error` 后保留已收内容，不再接收该轮增量。

> **自动重试提示复用本事件**：可重试错误（network_error/429/5xx/超时等）触发 pi
> 内部自动重试时，轮次并未终止 —— 内核先发射 status `streaming`（恢复进行中），
> 再发射本事件，`message` 为「模型连接中断，正在自动重试（第 N/M 次）…」。
> UI 对本事件只展示提示、不断开进行中状态（终态一律以 status 事件为准）；
> 重试耗尽的终态错误仍以 status `error` + 本事件（真实错误文案）收尾。

### conversation.compacted

**触发**：一次上下文压缩完成（手动压缩，或运行时按阈值/溢出自动触发）。
自动压缩没有 RPC 入口，本事件是 UI 感知它的唯一通道。

```json
{
  "sessionId": "sess_xxx",
  "reason": "auto",
  "tokensBefore": 88000,
  "tokensAfter": 9000,
  "summary": "上下文摘要…"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| reason | string | `manual` = 用户点击压缩；`auto` = 运行时自动触发 |
| tokensBefore | number? | 压缩前 token 数；未知为 null |
| tokensAfter | number? | 压缩后估算 token 数；未知为 null |
| summary | string? | 压缩摘要；未知为 null |

**UI 契约**：收到本事件必须重拉 `conversation/queryHistory`——压缩会把 transcript
替换为摘要，不重拉则界面显示的仍是压缩前的旧内容，与真实上下文不一致。
`reason: auto` 时还应给出可见提示（历史已被自动压缩）。

> 自动压缩失败不会发射本事件，而是走 `conversation.error`（绝不静默）。

---

## 7. Markdown / Mermaid 渲染

渲染由前端完成（复用 ai-coding：marked / prismjs / mermaid），接口不涉及；`conversation.delta` 只携带纯文本或代码块结构，`message.content` 为原始 markdown 字符串，前端白名单渲染（CV-S03）。

---

## 8. 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误（空消息） |
| 1002 | 会话不存在 |
| 1004 | provider 未配置 |
| 5000 | 内部错误 / 流中断 |