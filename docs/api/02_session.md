# 会话管理 API

> 模块编号：02
> 来源：PRD 02（docs/prd/02_session_management.md）
> 状态：已确认
> 传输：Electron IPC（forge-ui -> forge-core）；headless 同契约（v2+）

---

## 1. 创建会话

### session/createSession

**说明**：在当前项目下新建 pi session（SM-S01）。调用时机为**发送首条用户消息时**（前端草稿输入态点"新建会话"不调用本接口，不产生会话记录）；会话别名在发送首条消息后由 forge-core 基于首条问题自动生成（`onFirstUserMessage` -> `updateSessionAlias`），并经 `session.updated` 事件通知 UI 会话树刷新。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| projectPath | string | 是 | 所属项目路径 |

响应：

```json
{
  "session": {
    "sessionId": "sess_xxx",
    "projectPath": "C:/dev/a",
    "alias": null,
    "lastActiveAt": "2026-08-08T10:00:00Z",
    "createdAt": "2026-08-08T10:00:00Z",
    "modelOverride": null
  }
}
```

---

## 2. 查询会话列表

### session/querySessionList

**说明**：返回全部会话（跨项目会话池，SM-S05），或按项目过滤。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| projectPath | string | 否 | 为空时返回所有项目的会话 |

响应：

```json
{
  "sessions": [
    {
      "sessionId": "sess_xxx",
      "projectPath": "C:/dev/a",
      "alias": "修复登录 bug",
      "lastActiveAt": "...",
      "createdAt": "...",
      "modelOverride": null,
      "doneReadAt": null,
      "status": "idle"
    }
  ]
}
```

`doneReadAt`：最近一次查看完成结果时间（会话树绿点已读落盘，见 §5）；null/缺省 = 完成结果未读。

---

## 3. 删除会话

### session/deleteSession

**说明**：硬删 pi session（不可逆，前端先二次确认）（SM-S03）。删除运行中会话时先停止其执行。

**删除范围（v3.73 起）**：除 forge 元数据记录外，同步删除磁盘残留 ——
pi 会话转录 `{agentDir}/sessions/{encodeURIComponent(cwd)}/forge-<sessionId>.jsonl`
与该会话的子 agent 执行过程输出目录（`%TEMP%/pi-subagents-*/…/forge-<sessionId>/`）。
顺序为「先清盘、后删记录」：磁盘删除失败时整个删除失败（错误 5000、会话保留可重试），
保证「删除成功」等价于「磁盘已清」。同目录下其它 forge 会话与 pi CLI 原生会话文件不受影响。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：`data: null`

**事件**：删除后发射 `session.removed`。

---

## 4. 重命名会话

### session/updateSessionAlias

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| alias | string | 是 | 新别名（非空） |

响应：更新后的会话对象。

---

## 5. 标记完成结果已读

### session/markSessionRead

**说明**：标记会话完成结果已读（会话树绿点落盘，SM-S04/SM-S05）。前端在**查看中的会话完成结果未读**时调用（点击已完成会话、正查看时会话完成、多窗口画布聚焦）。已读标记存 forge-store `session.doneReadAt`，跨窗口/重启一致；新一轮完成（状态非 done→done 转入）时由 forge-core 自动清回 null，绿点重新提示。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：更新后的会话对象（含 `doneReadAt`）。

**事件**：成功后发射 `session.updated`（各窗口会话树刷新绿点）。

---

## 6. 会话状态

### session/getSessionStatus

**说明**：查询会话当前运行状态（SM-S04 状态显示）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：

```json
{
  "status": "running",
  "runningCount": 3
}
```

`status`: `idle` / `running` / `done` / `error`

---

## 7. 多窗口会话订阅

### session/attachSessionWindow

**说明**：前端某窗口开始订阅会话输出（SM-S05）。forge-core 统一管理输出流，窗口按 sessionId 订阅；同一会话同一时间至多一个观察窗口（TD-SM-04）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |

响应：

```json
{
  "history": [ { "role": "user", "content": "..." } ],
  "status": "idle"
}
```

`history` 为 pi session 已有消息（历史加载，CV-S05 全量）。

### session/detachSessionWindow

**说明**：窗口关闭时摘除订阅（会话不删除）。

请求参数：`sessionId`。

响应：`data: null`。

---

## 8. 导出会话（交接包，SM-S08）

### forge:dialog:saveFile（扩展）

SM-S08 复用既有保存对话框，新增 `kind` 参数决定过滤器：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| name | string | 否 | 默认文件名。取 basename，目录成分被掐掉；缺省按 kind 取 `canvas.html` / `forge-session.zip` |
| kind | `'canvas' \| 'session'` | 否 | 缺省 `canvas`。`session` → 过滤器 `zip`、默认名 `forge-session.zip` |

**载荷形态变更（既有调用方兼容）**：此前该通道的载荷是裸字符串，现在是 `{ name, kind }` 对象。`preload` 已把旧签名 `saveFile(defaultName)` 包装成 `{ name: defaultName, kind: undefined }`，**渲染层调用方无需改动**。

返回：用户选定的绝对路径；取消返回 `null`（取消时同时清空写盘 allowlist）。

### forge:session:exportBundle

**说明**：把会话导出为 ZIP 交接包。**shell 级通道，不走 forge-core RPC** —— 包在主进程就地读盘打包直写（转录内图片是 base64 内嵌，包体可达数百 MB，穿 IPC 结构化克隆会再吃两份内存）。

**请求**

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| sessionId | string | 是 | 会话 ID |
| targetPath | string | 是 | 目标路径。**必须等于最近一次 `forge:dialog:saveFile` 的返回值**，且扩展名为 `.zip` |

**响应**

```json
{ "ok": true, "bytes": 24576 }
```

```json
{ "ok": false, "reason": "transcript-missing" }
```

`reason` 枚举：

| reason | 含义 |
|---|---|
| `invalid-session` / `invalid-path` | 参数非法 |
| `not-user-selected` | 路径不等于最近一次保存对话框返回值（CV-TRUST-03 围栏） |
| `core-not-ready` | 内核尚未组装完成（用户启动瞬间即点击） |
| `session-not-found` | 会话无磁盘记录（**解析走 `resolveSessionFile` 多候选链**，含 free-workspace 回落） |
| `transcript-missing` / `transcript-unreadable` | 转录文件不存在 / 读失败 |
| `target-unwritable` | 落盘失败（磁盘满、无权限） |
| `internal` | 未预期异常 |

**包内容**：只有一份 —— `transcript.jsonl`，磁盘原生转录，**逐字节原样**（不 trim / 不去空行 / 不重排）。

TD-SM-06：thinking、被压缩折叠的早期上下文、工具原始入参全须保留。转录首行本身即会话头（含 `id` / `cwd` / `timestamp`），紧随其后是模型与思考级别记录行 —— 所以**不再旁挂元信息文件**（TD-SM-09：两处描述同一事实必然漂移）。

**不变量**

- 只读：导出不改会话存储、不改状态、不中断运行中的会话；重复导出得到逐字节一致的包。
- 失败**不留任何残件**：读盘在打包之前完成，写盘是最后一步且只发生一次。
- 无体积上限（PRD 用户裁定）。
- 包由 `zipWriter.ts` 自建（零新增依赖），不做 ZIP64 / 数据描述符；单条目或包体超 4GB 时构建失败。

---

## 9. 事件

### session.statusChanged

**触发**：任一会话状态变化。

```json
{
  "sessionId": "sess_xxx",
  "status": "running",
  "runningCount": 3
}
```

### session.removed

**触发**：会话删除完成。

```json
{ "sessionId": "sess_xxx" }
```

### session.updated

**触发**：会话元数据变更（重命名、首条消息自动命名、标记完成结果已读）。

```json
{ "session": { "sessionId": "sess_xxx", "doneReadAt": "..." } }
```

---

## 10. 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误 |
| 1002 | 会话不存在 / 项目不存在 |
| 1004 | 会话重复开窗（已有关注窗口） |
| 5000 | 内部错误 |

> SM-S08 的 `forge:session:exportBundle` **不经此错误码表**（shell 级通道，返回 `{ ok, reason }`）。