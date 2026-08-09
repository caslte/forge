# 工具执行 API

> 模块编号：04
> 来源：PRD 04（docs/prd/04_tool_execution.md）
> 状态：规划中
> 传输：Electron IPC（事件推送为主）；headless 同契约（v2+）

---

## 1. 工具事件（CanonicalEvent 工具部分）

**工具执行不走方法请求-响应，全部由 pi 事件映射为 `CanonicalEvent` 推送前端**（TE-S01/S04）。forge-core 负责将 pi 工具事件映射为统一的工具事件结构。

### tool.started

**触发**：AI 开始调用工具。

```json
{
  "sessionId": "sess_xxx",
  "toolEventId": "evt_1",
  "tool": { "name": "edit", "input": { "file_path": "src/a.ts", "old_string": "..." } },
  "status": "running"
}
```

### tool.completed

**触发**：工具执行完成。

```json
{
  "sessionId": "sess_xxx",
  "toolEventId": "evt_1",
  "tool": { "name": "edit", "input": { "file_path": "src/a.ts" } },
  "status": "completed",
  "result": { "text": "Edited 3 lines", "image": null }
}
```

### tool.error

**触发**：工具执行出错。

```json
{
  "sessionId": "sess_xxx",
  "toolEventId": "evt_1",
  "tool": { "name": "grep", "input": { "pattern": "..." } },
  "status": "error",
  "error": { "message": "No files matched" }
}
```

---

## 2. Diff 数据

edit 类工具（含 `oldText`/`newText`）在 `tool.completed` 中附带 Diff 所需字段：

```json
{
  "tool": {
    "name": "edit",
    "input": {
      "file_path": "src/a.ts",
      "old_string": "old",
      "new_string": "new"
    }
  }
}
```

前端用 `old_string`/`new_string` 渲染并排 Diff（TD-TE-01 A）。若旧文本缺失则降级显示新文本。

---

## 3. 错误码

工具事件为单向推送，无请求-响应错误码；订阅方只需按 `status` 字段渲染状态。数据完整性以 pi 最终状态为准（状态最终一致）。