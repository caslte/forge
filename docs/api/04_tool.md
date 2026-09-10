# 工具执行 API

> 模块编号：04
> 来源：PRD 04（docs/prd/04_tool_execution.md）
> 状态：已确认（含扩展 TE-S05 tool.completed.result.details 透传，为模块 03 CV-S11 Todo 面板等结构化消费场景提供 IPC 支撑）
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

**扩展 TE-S05**：`result` 增加可选 `details` 字段透传 pi 工具的结构化详情（如 rpiv-todo 工具的 `{ action, tasks, nextId }`）。仅补充不重写，原 `{ text, image }` 字段完全保留；pi 工具未携带 details 时 `result` 不出现该字段（JSON omit 语义），序列化与原 100% 兼容，旧使用方零变更。

```json
{
  "sessionId": "sess_xxx",
  "toolEventId": "evt_2",
  "tool": { "name": "todo", "input": { "action": "list" } },
  "status": "completed",
  "result": {
    "text": "[ ] #1: 修复登录\n[x] #2: 加单元测试",
    "image": null,
    "details": {
      "action": "list",
      "tasks": [
        { "id": 1, "subject": "修复登录", "status": "pending" },
        { "id": 2, "subject": "加单元测试", "status": "completed", "activeForm": "提交测试" }
      ],
      "nextId": 3
    }
  }
}
```

> **消费方约定**：`details` 为透传字段（`unknown`），forge IPC 层不解析、不校验、不裁剪。需结构化消费的模块按 `tool.name` 识别并自行断言（如模块 03 CV-S11 Todo 面板仅消费 `tool.name === 'todo'` 的 `details`）。

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