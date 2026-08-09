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

响应：`data: null`（消息已在对话区即时展示；后续内容靠事件推送）。

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

## 3. 事件（流式推送）

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

---

## 4. Markdown / Mermaid 渲染

渲染由前端完成（复用 ai-coding：marked / prismjs / mermaid），接口不涉及；`conversation.delta` 只携带纯文本或代码块结构，`message.content` 为原始 markdown 字符串，前端白名单渲染（CV-S03）。

---

## 5. 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误（空消息） |
| 1002 | 会话不存在 |
| 1004 | provider 未配置 |
| 5000 | 内部错误 / 流中断 |