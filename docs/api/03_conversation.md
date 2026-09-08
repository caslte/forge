# 对话与消息 API

> 模块编号：03
> 来源：PRD 03（docs/prd/03\_conversation.md）
> 状态：已确认
> 传输：Electron IPC（方法 + 事件）；headless 同契约（v2+）

***

## 1. 发送消息

### conversation/sendMessage

**说明**：向会话发送用户消息，触发 AI 处理并进入流式响应（CV-S01）。

请求参数：

| 参数名       | 类型     | 必填 | 说明                          |
| --------- | ------ | -- | --------------------------- |
| sessionId | string | 是  | 会话 ID                       |
| content   | string | 是  | 消息内容（非空）；附件以 @ 路径行随正文发送（见下） |

**附件约定（统一给路径）**：附件不再作为独立参数传输。前端把附件文件的绝对路径以 `@` 前缀独立行追加在正文后（`正文\n@C:\path\a.ts\n@C:\path\b.png`，v3.27 起带 @ 协议标记：@ 开头=附件，手敲裸路径=正文，展示层零歧义；旧会话裸路径行兼容识别），剪贴板截图先由主进程落盘系统临时目录再给路径。文件内容由模型自行用 read 工具读取（图片自动转 image 块；非视觉模型由 pi-ai 传输层降级为占位文本，不报错）。加入待发区时主进程对文本类附件做密钥嗅探，命中需用户确认后才会发送。

**附件格式白名单**（单一事实来源：`@forge/core` `attachments.ts`）：图片 `png/jpg/jpeg/gif/webp`；文本与代码 `txt/md/json/log/csv/yaml/yml/toml/xml/html/css/js/ts/py/java/go/rs/c/cpp/h`；Office 文档 `xlsx/xls/docx/doc`。选择/粘贴/拖拽三入口统一校验（渲染层 `addPaths` 把关，选择器的 dialog filter 仅为软过滤）；不支持格式拒绝入待发区并提示。xlsx/docx 等二进制格式不参与密钥嗅探。

**响应**：

- `data: null`：正常（消息已在对话区即时展示；后续内容靠事件推送）。

**CV-S09 消息队列（v1.1；v1.2 修分流竞态）**：会话处于流式中时调用本接口 = **入队**（非报错）。适配器以 `session.isStreaming` + 直发提交门分流（v1.2：pi `prompt()` 置位 `isStreaming` 前有 preflight 窗口——鉴权/压缩预检 await，期间到达的消息先等上一条直发提交（preflightResult 回调）再分流，防止误直发与启动中的轮次相撞）：streaming 中经 pi `prompt(content, { streamingBehavior: 'followUp' })` 入队，pi 在当前轮收尾后自动按 FIFO 逐条投递（每条投递时发 `message_start(role=user)`，适配器确认后转发 `conversation.message`，UI 渲染普通 user 气泡）；队列变更经 `conversation.queueUpdated` 全量推送（UI 按会话镜像维护，切走再切回徽标不丢，v1.2）。上限 5 条由 UI 层软校验（超限拒绝 + toast）；忙时输入框不再禁用（placeholder 提示 Enter 排队发送）。

| code | 说明                    |
| ---- | --------------------- |
| 1004 | provider 未配置，前端提示引导配置 |
| 1002 | 会话不存在                 |
| 5000 | 入队失败（如斜杠扩展命令不能排队，不影响在途轮次） |

***

## 2. 取消响应

### conversation/cancelStream

**说明**：停止当前处理，保留已生成内容（CV-S04）。

**CV-S09 变更（v1.1）**：停止前先清空待发队列（pi TUI ESC 同款语义），响应携带被清空的队列文本供 UI 回填输入框：

```json
{ "code": 0, "data": { "clearedMessages": ["待发 1", "待发 2"] } }
```

`clearedMessages` 为 FIFO 序；UI 将其以 `\n\n` 拼接回填输入框（不丢内容，可编辑重发）。无队列时为空数组。

请求参数：

| 参数名       | 类型     | 必填 | 说明    |
| --------- | ------ | -- | ----- |
| sessionId | string | 是  | 会话 ID |

响应：`data: null`（CV-S09 起改为 `data: { clearedMessages: string[] }`，见上）。

**事件：conversation.queueUpdated（CV-S09 新增）**

pi followUp 队列每次变化（入队/派发/清空）全量推送：

```json
{ "sessionId": "...", "followUp": ["最先派发", "其次", "..."] }
```

UI 据此渲染输入框工具区的「待发送 N」徽标与只读浮窗（无删除/立即发送；丢弃唯一入口 = 停止按钮清队回填）。

**变更**：主轮看门狗改用真中断（SA-F02 修正）：pi 侧 run 挂起且连续 30 分钟无任何会话事件（delta/消息/工具/子 agent）时，看门狗调用本接口语义执行 `session.abort()` 并置 `canceled`，保证 forge 状态与 pi 一致。此前经 forceDone 只把 forge 状态打成 `done`（假结束），pi run 仍挂着，下一次发送会被 pi 以 "Agent is already processing" 拒绝且无法自愈。

**变更**：sendMessage 撞车自愈：若发送时 pi 侧仍有残留 run（返回 "Agent is already processing"），适配器先 `abort()` 结束僵尸轮再报错提示重新发送，会话不再砖化。

***

## 3. 查询历史

### conversation/queryHistory

**参数**

| 字段        | 类型     | 必填 | 说明    |
| --------- | ------ | -- | ----- |
| sessionId | string | 是  | 会话 ID |

**响应 data**

```json
{
  "messages": [
    { "role": "user", "content": "你好", "ts": "2026-08-31T09:00:00.000Z" }
  ]
}
```

**tool 消息**：历史中的工具结果消息（`role=tool`）带 `toolEventId / toolName / status`，并尽可能带 `input`——从 pi 会话 assistant 消息的 toolCall.arguments 恢复；极旧会话或无匹配 toolCall 时不带该字段。`input` 供前端渲染工具卡 diff 与每轮「改动文件汇总卡片」，入参形状见 api/04_tool.md §2。

**流式语义**：pi 仅在 `message_end` 时把 assistant 消息写入会话文件。轮次进行中查询历史时，
响应末尾会额外包含一条**未完成 assistant 快照**（流式清洗后全文）；轮次结束后不再返回该快照，
不会与已落盘的终态消息重复。这保证流式中切换会话再切回时，后续增量有正确的追加基点（界面不截断）。

### conversation/getLastError

**参数**：`{ sessionId }`

**响应 data**

```json
{ "message": "模型额度耗尽（429）：请检查账户额度" }
```

查询会话最近一次轮次错误信息（内存态，不落盘）。前端错误横幅（`conversation.error` 事件驱动）
是瞬态内存态，错误发生在非当前查看会话（切走再切回 / 后台会话出错）时已丢失，而会话树红点
（`session.status='error'`）持久——UI 在挂载/切换到 error 状态会话时经本方法拉取，恢复横幅显示。

**语义**：

- 无错误记录（未出错 / 已被新轮次或正常终态清除 / 应用重启后）返回 `message: null`，不报错；

- `lastError` 随 error 状态记录（事件路径的友好信息优先于 adapter 抛错的原始信息），
  新一轮发送（streaming）与正常终态（done / canceled / idle）清除；

- 拉取失败 UI 静默降级（横幅非关键路径）。

***

## 4. 上下文用量

### conversation/getContextUsage

**参数**：`{ sessionId }`

**响应 data**

```json
{
  "usage": { "tokens": 42000, "contextWindow": 128000, "percent": 32.8 }
}
```

`usage` 为 `null` 表示当前无法获取用量（无会话文件或无模型元数据），UI 显示未知。

会话激活时读取运行时实时用量；重启后仅加载历史（无 lease）时回落磁盘估算：
读会话 JSONL，取最后一条有效 assistant 用量 + 尾部消息字符估算（与 pi 运行时
同一规则），contextWindow 由会话模型（DB 持久化）解析。因此重启后进入会话
即可见估算用量，发出首条消息后回落为运行时实时读数。

> 压缩边界之后、尚无新的助手响应前，运行时无法给出可信用量，此时返回
> `{ "tokens": null, "contextWindow": 128000, "percent": null }`。
> UI 须显示「未知」而非 0，否则用户会误判压缩未生效。

***

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

| 字段                  | 类型      | 说明                             |
| ------------------- | ------- | ------------------------------ |
| result.ok           | boolean | 是否压缩成功                         |
| result.message      | string? | 失败原因（仅 ok=false；如「会话未激活，无法压缩」） |
| result.tokensBefore | number? | 压缩前 token 数；未知为 null           |
| result.tokensAfter  | number? | 压缩后估算 token 数；未知为 null         |
| result.summary      | string? | 压缩摘要；未知为 null                  |

**错误码**：1001 参数错误 / 1002 会话不存在 / 5000 压缩异常（不破坏会话历史）。

**流式限制**：运行时压缩会先中止当前轮（`abort`），因此 UI 在 streaming 期间禁用压缩入口，避免静默截断正在生成的回答。

***

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

> **自动重试提示复用本事件**：可重试错误（network\_error/429/5xx/超时等）触发 pi
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

| 字段           | 类型      | 说明                                 |
| ------------ | ------- | ---------------------------------- |
| reason       | string  | `manual` = 用户点击压缩；`auto` = 运行时自动触发 |
| tokensBefore | number? | 压缩前 token 数；未知为 null               |
| tokensAfter  | number? | 压缩后估算 token 数；未知为 null             |
| summary      | string? | 压缩摘要；未知为 null                      |

**UI 契约**：收到本事件必须重拉 `conversation/queryHistory`——压缩会把 transcript
替换为摘要，不重拉则界面显示的仍是压缩前的旧内容，与真实上下文不一致。
`reason: auto` 时还应给出可见提示（历史已被自动压缩）。

> 自动压缩失败不会发射本事件，而是走 `conversation.error`（绝不静默）。

***

## 7. Markdown / Mermaid 渲染

渲染由前端完成（复用 ai-coding：marked / prismjs / mermaid），接口不涉及；`conversation.delta` 只携带纯文本或代码块结构，`message.content` 为原始 markdown 字符串，前端白名单渲染（CV-S03）。

***

## 8. 错误码

| code | 说明           |
| ---- | ------------ |
| 1001 | 参数错误（空消息）    |
| 1002 | 会话不存在        |
| 1004 | provider 未配置 |
| 5000 | 内部错误 / 流中断   |

***

## 9. 斜杠命令清单（扩展 CV-S08）

### conversation/getSlashCommands

**说明**：查询当前可用的 pi 生态斜杠命令（扩展命令 / skills / prompt 模板），供输入框 `/` 浮窗展示（CV-S08）。命令清单为会话级内存缓存，无持久化。

请求参数：

| 参数名         | 类型     | 必填 | 说明                                                              |
| ----------- | ------ | -- | --------------------------------------------------------------- |
| sessionId   | string | 否  | 会话 ID。提供时返回该会话的命令清单；省略时为草稿态查询                                   |
| projectPath | string | 否  | 草稿态（无 sessionId）时的项目工作目录，用于发现项目级 skills/模板；省略时仅发现全局（agentDir）资源 |

响应 data：

```json
{
  "commands": [
    { "name": "skill:git-push", "description": "推送当前分支", "source": "skill" },
    { "name": "review-pr", "description": "审查拉取请求", "source": "extension" },
    { "name": "write-tests", "description": "生成测试用例", "source": "prompt" }
  ]
}
```

| 字段                      | 类型      | 说明                                                   |
| ----------------------- | ------- | ---------------------------------------------------- |
| commands\[].name        | string  | 原始命令名（skill 命令带 `skill:` 前缀；插入输入框时补 `/` 前缀）          |
| commands\[].description | string? | 命令描述；缺失为 null（UI 副文本留空）                              |
| commands\[].source      | string  | `extension` = 扩展命令；`skill` = 技能；`prompt` = prompt 模板 |

**两种查询模式**：

- **会话模式**（提供 sessionId）：返回该会话缓存的命令上报清单（三类全量，来自命令上报扩展会话启动时的上报，见下方桥接约定）。上报尚未到达（如首条消息刚发出）时，降级返回轻量资源查询结果（skills + 模板，无扩展命令）。

- **草稿态模式**（省略 sessionId）：轻量资源查询直取 skills + prompt 模板（不加载扩展、不创建会话，TD-CV-08）；扩展命令不可见，会话激活后经 `conversation.slashCommandsUpdated` 补全。

**枚举失败语义**：资源查询失败不报错，返回 `commands: []`（UI 显示「无可用命令」，输入不受阻塞，AC-CV-033）；仅参数非法（sessionId 非字符串）与未知会话报错。

**错误码**：

| code | 说明                               |
| ---- | -------------------------------- |
| 1001 | 参数错误（sessionId/projectPath 非字符串） |
| 1002 | 会话不存在（提供 sessionId 但未注册）         |

**UI 缓存契约**：同一会话首次触发浮窗时调用一次并缓存，切换会话失效重拉；收到 `conversation.slashCommandsUpdated` 后失效该会话缓存（下次触发浮窗重拉）。

### conversation.slashCommandsUpdated（事件）

**触发**：命令上报扩展的上报到达 forge（会话激活后，覆盖此前的降级清单）。

```json
{
  "sessionId": "sess_xxx"
}
```

**UI 契约**：收到本事件后失效该会话的命令清单缓存，下次触发浮窗时重新拉取 `conversation/getSlashCommands`（扩展命令补全，AC-CV-032）。

### 桥接约定（forge-desktop 内部，非 UI 契约）

- **命令上报扩展**（forge-extensions 首个真实 pi 扩展，TD-CV-07）：随每个 pi 会话加载，在 `session_start` 时调用运行时命令枚举能力（`pi.getCommands()`，覆盖扩展命令 + skills + prompt 模板三类），经会话事件总线上报（channel 形如 `slash-commands:reported`，与 pi-subagents 的 `subagents:*` 同构）。

- forge-desktop 桥接该 channel → forge-core 会话级缓存，并转发为 `conversation.slashCommandsUpdated` 事件；扩展缺失/上报失败时静默降级（会话模式回落轻量查询）。

- **命令执行无专用接口**：选中命令以原始命令串（如 `/skill:git-push `  ）经 `conversation/sendMessage` 原样发送，由 pi 运行时原生解析执行（TD-CV-09，零拦截零注册表）；AC-CV-031 的集成验证走真实 pi 会话。

