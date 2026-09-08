# 工具执行 API

> 模块编号：04
> 来源：PRD 04（docs/prd/04_tool_execution.md）
> 状态：已确认
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
  "tool": { "name": "edit", "input": { "path": "src/a.ts", "edits": [{ "oldText": "...", "newText": "..." }] } },
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

**真实 pi 入参形状**（`tool.input` 由 pi 事件原样透传）：

- edit：`{ "path": "src/a.ts", "edits": [{ "oldText": "...", "newText": "..." }] }`——同一文件可含多个编辑块（hunk）
- write：`{ "path": "src/a.ts", "content": "..." }`——全量写入

> 更正：本节此前写的 `file_path`/`old_string`/`new_string` 为 mock/旧形状，真实 pi 链路不出现；前端按形状判定同时兼容两者。

**前端消费**（共享解析器 `parseFileToolInput`，按入参形状识别"修改文件类"工具，不依赖工具名——read/bash 等形状不命中）：

- 工具卡 / 工具组 diff：edit 按 `edits[]` 逐块渲染并排 diff（每块一个 DiffView，仅首块显示文件名）；write 按全量新增渲染；旧形状按单块处理。
- 改动文件汇总卡片（每轮回复末尾，CV 改动文件卡片）：仅统计 `status=completed` 的工具；edit 逐块经 `buildSideBySideDiff` 数新增/删除行，write 以 content 行数计新增（入参无旧内容，删除行记 0）；同轮同文件聚合（行数求和、diff 块按序拼接）。

---

## 3. 错误码

工具事件为单向推送，无请求-响应错误码；订阅方只需按 `status` 字段渲染状态。数据完整性以 pi 最终状态为准（状态最终一致）。