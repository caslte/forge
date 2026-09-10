# 工具执行展示 覆盖矩阵

> 模块：04 工具执行展示
> 来源：PRD 04（docs/prd/04_tool_execution.md）
> 状态：已确认（含扩展 TE-S05 tool.completed.result.details 透传，为模块 03 CV-S11 Todo 面板等结构化消费场景提供 IPC 支撑）
> 层级映射：unit=事件映射/状态流/长结果折叠逻辑；API=CanonicalEvent 工具事件（工具信息透传）；E2E=对话内工具卡片 UI

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | 卡片创建、结果展示、Diff 展示、状态流转 | P0 |
| 字段边界 | 适用 | 卡片校验、结果为空、Diff 缺失/超大文件 | P1 |
| 权限角色 | 适用 | 无 per-tool 审批（跟 pi 一致），仅展示 | P0 |
| 状态流转 | 适用 | running→completed/error；非法反向 | P0 |
| 异常失败 | 适用 | 工具执行失败标红、Diff 数据缺失降级 | P1 |
| 数据一致性 | 适用 | 结果与工具对应不串；Diff 与实际一致 | P0 |
| 幂等重复 | 适用 | 同一工具事件仅渲染一张卡片 | P1 |
| 查询组合 | 不适用 | 无查询场景 | - |
| 前端反馈 | 适用 | 折叠/展开、spinner、绿勾、红标 | P1 |
| 跨模块影响 | 适用 | 卡片穿插对话流（模块 03）；白名单渲染复用 | P0 |

---

## 覆盖基线

| AC ID | 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 |
|---|---|---|---|---|---|---|---|---|
| AC-TE-001 | TE-S01 工具调用卡片 | 功能 | 正常流程：工具调用出现卡片 | P0 | - | A-TE-001 | E-TE-001 |
| AC-TE-002 | TE-S01 工具调用卡片 | 交互 | 正常流程：可折叠/展开 | P1 | - | - | E-TE-001 |
| AC-TE-003 | TE-S02 工具结果展示 | 功能 | 正常流程：文本/代码高亮 | P0 | - | A-TE-002 | E-TE-002 |
| AC-TE-004 | TE-S02 工具结果展示 | 性能/可读性 | 正常：长结果折叠+展开 | P1 | U-TE-001 | - | E-TE-002 |
| AC-TE-005 | TE-S02 工具结果展示 | 安全/XSS | 安全：结果含恶意 HTML | P0 | U-TE-002 | - | E-TE-004 |
| AC-TE-006 | TE-S03 文件 Diff | 功能 | 正常：edit 并排 Diff | P0 | U-TE-003 | A-TE-003 | E-TE-003 |
| AC-TE-007 | TE-S03 文件 Diff | 一致性 | 正常：Diff 反映实际变更 | P0 | - | A-TE-004 | E-TE-003 |
| AC-TE-008 | TE-S03 文件 Diff | 性能 | 异常：超大文件 | P1 | U-TE-004 | - | E-TE-003 |
| AC-TE-009 | TE-S04 状态流转 | 状态 | 正常：运行中→完成/出错 | P0 | U-TE-005 | A-TE-005 | E-TE-001 |
| AC-TE-010 | TE-S04 状态流转 | 边界 | 异常：工具失败 | P0 | - | - | E-TE-002 |

### 覆盖基线（扩展 TE-S05 tool.completed 透传 details）

> IPC 契约扩展：仅补充不重写。原 AC-TE-001\~010 全部零变更（`text`/`image` 字段语义不变），本扩展仅在 `result` 上增加可选 `details` 字段透传 pi 工具结构化详情。

| AC ID | 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 |
|---|---|---|---|---|---|---|---|---|
| AC-TE-011 | TE-S05 IPC details 透传 | 跨模块协作 / 数据一致性 | 正常流程：pi 工具携带 details 透传 | P0 | U-TE-006 | A-TE-006 | E-TE-005 | pi `todo` 工具完成事件（`tool.name='todo'`，`result.details={action, tasks, nextId}`）经 piConversationAdapter 映射后，IPC `tool.completed.result.details` 字段原值透传；前端 `useSessionConversation` 收到可读取；序列化不丢失字段 |
| AC-TE-012 | TE-S05 IPC details 透传 | 向后兼容 | 正常流程：pi 工具未携带 details 不破坏 IPC 契约 | P0 | U-TE-007 | A-TE-007 | E-TE-006 | pi 普通工具（read/write/grep/bash/edit）完成事件经映射后，`result` 中不出现 `details` 字段（JSON omit 语义）；序列化结果与扩展前 100% 一致；现有 tool.started/completed/error 使用方零变更 |
| AC-TE-013 | TE-S05 IPC details 透传 | 字段边界 / 数据一致性 | 边界：details 各种类型透传不解析不抛错 | P1 | U-TE-008 | A-TE-008 | - | details 类型 fixture（对象 / 数组 / 嵌套对象 / string / number / null / 0 / false / 空对象）透传后字段类型完整保留；非对象 details 原样透传、消费方自行判空；序列化往返不丢字段 |

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-TE-001 | AC-TE-004 | ToolCard 折叠逻辑 | 性能 | 结果 > 阈值 | 10k 行字符串 | 挂载 tool 卡片 | 默认折叠，点展开完整显示 | 不意外截断数据 |
| U-TE-002 | AC-TE-005 | 结果渲染安全 | XSS | 结果含 `<script>` | 渲染 | 通过白名单 | 标签被剥离，不执行 | 无脚本执行 |
| U-TE-003 | AC-TE-006 | Diff 渲染 | 功能 | edit 事件 new/old | old/new 两段文本 | 渲染 | 左右对照，增删高亮 | 无差异时旧=新 |
| U-TE-004 | AC-TE-008 | Diff 性能 | 性能 | 大文件（>10k 行） | 渲染大 Diff | 虚拟滚动/行数限制 | UI 不卡顿，压缩展示 | 无 O(n²) 渲染 |
| U-TE-005 | AC-TE-009 | 卡片状态机 | 状态 | running 卡片 | completed/error | 状态流转 | running→completed; running→error 合法；reverse 非法 | 非法反向被阻止 |

### api（事件契约）

| 用例 ID | 关联 AC | 接口 | 前置 | 请求 | 预期响应/错误码 | 断言点 |
|---|---|---|---|---|---|---|
| A-TE-001 | AC-TE-001 | tool.started | ⽐工具开始 | tool_event 载荷 | started 事件含 name/input 透传 | 卡片渲染所需数据完整 |
| A-TE-002 | AC-TE-003 | tool.completed | 工具执行完成 | tool_event | completed 数据含 result | 结果正确关联同一 toolEventId |
| A-TE-003 | AC-TE-006 | tool.completed（edit） | edit 执行 | 含 oldText/newText | 数据透传 | Diff 字段完整 |
| A-TE-004 | AC-TE-007 | tool.completed（edit） | edit 完成 | 变更前后文件 | 返回变更数据 | Diff 与文件真实变更一致 |
| A-TE-005 | AC-TE-009 | tool.started/ completed | 一次执行 | - | started → completed 状态对 | 状态无跳跃缺失 |
| A-TE-006 | AC-TE-011 | tool.completed（todo 工具，details 透传） | todo 工具执行完成 | `tool.name='todo'` 含 `result.details={action, tasks, nextId}` | 事件推送 result.details 字段 | details 字段原值透传；与 result.text 不重复不覆盖；前端可读取为对象 |
| A-TE-007 | AC-TE-012 | tool.completed（普通工具，无 details） | read/write/grep/bash 工具执行完成 | `result` 中无 details 字段 | 事件推送 | 序列化结果中 `details` 字段不出现（JSON omit）；与扩展前序列化字节相同；旧使用方零变更 |
| A-TE-008 | AC-TE-013 | tool.completed（details 多种类型透传） | 注入不同类型 details | string / number / null / 0 / false / 嵌套对象 / 大对象（10k+ 字段） | 事件推送 | 字段类型完整保留；序列化往返不丢失；非对象不抛错 |

### e2e

| 用例 ID | 关联 AC | 页面 | 前置 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-TE-005 | AC-TE-011 | 对话区 + Todo 面板 | 主会话激活；rpiv-todo 已安装 | seed mock todo 事件序列（含 details） | mock-backend | 触发 AI 调 todo 工具 → 观察工具卡 + Todo 面板 | 工具卡正常渲染（用 text 字段）；Todo 面板按 details 渲染（3 行任务 + activeForm）；面板位置在输入框上方；无 console error |
| E-TE-006 | AC-TE-012 | 对话区 | 主会话激活 | seed 普通工具事件（read/grep） | mock-backend | 触发 AI 调 read/grep → 观察 | 工具卡正常渲染（text 字段不变）；Todo 面板不渲染（普通工具不带 details）；IPC 序列化结果与扩展前字节相同 |
|---|---|---|---|---|---|---|---|
| E-TE-001 | AC-TE-001/009 | 对话区 | 会话运行 | mock tool 事件流 | mock-backend | 触发 AI 调工具 | 卡片出现（name+状态），状态实时流转 |
| E-TE-002 | AC-TE-003/010 | 对话区 | 会话运行 | 工具含结果/失败 | mock-backend | 观察结果与失败 | 结果渲染；失败标红含错误信息 |
| E-TE-003 | AC-TE-006/007/008 | 对话区 | edit 工具执行 | 变更 + 超大文件 | mock-backend | 观察 Diff | 并排 Diff 高亮，与实际一致，大文件不卡顿 |
| E-TE-004 | AC-TE-005 | 对话区 | 恶意结果 | 结果含危险 HTML | manual | 渲染结果 | 不执行脚本；安全渲染 |

#### unit（扩展 TE-S05）

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-TE-006 | AC-TE-011 | IPC 事件映射器（piConversationAdapter.handleEvent） | 跨模块协作 / 数据一致性 | fake pi 事件源 | `message_end` 携带 toolResult details（`{action, tasks, nextId}`）；pi session JSONL 完整快照 | 触发 handleEvent | 经映射器后 IPC `tool.completed.result` 含 `details` 字段、值与 pi 原始一致 | 映射器不修改 details 内容、不增字段、不删字段；details 缺失时 result 中不出现 |
| U-TE-007 | AC-TE-012 | IPC 序列化契约（forge-core ToolEvent 序列化/反序列化） | 向后兼容 | 序列化 fixture | 完整 ToolCompletedEvent（result 无 details）；完整 ToolCompletedEvent（result 有 details）；旧 IPC payload（无 details 字段） | 序列化 → 反序列化 | 无 details → 序列化结果不出现该字段；JSON 字节与扩展前一致；有 details → 序列化后字段保留；往返不丢失；旧 payload 解析零变更 | 序列化不应输出 `"details": undefined` |
| U-TE-008 | AC-TE-013 | details 透传边界（IPC 通道） | 字段边界 / 数据一致性 | details fixture 集 | 对象 `{tasks: [...]}` / 数组 `[]` / 嵌套对象 / string `'foo'` / number `42` / null / `0` / `false` / 空对象 `{}` / 大对象（10k 字段） | 序列化 → IPC → 反序列化 | 字段类型完整保留；非对象 details 原样透传；大对象不爆内存；往返不丢字段 | 不解析、不校验、不裁剪；不抛错到上层 |

> E-TE-004 采用 manual（安全类断言适用浏览器自动化受限，需人判定执行效果），属补充说明，不影响 P0 门禁（P0 相关断言覆盖见 E-TE-002 的主链路）。