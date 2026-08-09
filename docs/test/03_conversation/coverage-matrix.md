# 对话与消息 覆盖矩阵

> 模块：03 对话与消息
> 来源：PRD 03（docs/prd/03_conversation.md）
> 状态：已确认
> 层级映射：unit=纯渲染/校验逻辑；API=IPC 方法 + CanonicalEvent 流式事件契约；E2E=对话区 UI + 渲染

---

## 风险维度适用性

| 风险维度 | 是否适用 | 原因 | 覆盖要求 |
|---|---|---|---|
| 正常流程 | 适用 | 发送→流式响应→渲染→完成；历史加载 | P0 |
| 字段边界 | 适用 | 空消息验证；内容长度；硬截断逻辑 | P1 |
| 权限角色 | 适用 | 单用户；消息内容信任由 pi 处理 | P0 |
| 状态流转 | 适用 | idle→streaming→done/cancel/error；取消后恢复 idle | P0 |
| 异常失败 | 适用 | 流中断、provider 未配置、渲染错误、Mermaid 语法错误 | P1 |
| 数据一致性 | 适用 | 消息不重不丢；取消保留已生成 | P0 |
| 幂等重复 | 适用 | 重复 cancel 无副作用；重复打开历史一致 | P1 |
| 查询组合 | 不适用 | 历史全量加载，无分页/筛选 | - |
| 前端反馈 | 适用 | 输入框反馈、代码复制、Mermaid 错误提示、provider 引导 | P1 |
| 跨模块影响 | 适用 | 工具消息穿插（模块 04）；Markdown 渲染复用 | P0 |

---

## 覆盖基线

| AC ID | PRD 功能点 | 风险维度 | 场景 | 优先级 | Unit ID | API ID | E2E ID | 核心断言 | 备注 |
|---|---|---|---|---|---|---|---|---|---|
| AC-CV-001 | CV-S01 发送消息 | 跨模块协作 | 正常流程：发送→流式响应 | P0 | - | A-CV-001 | E-CV-001 | 对话区显示消息，进入 streaming 状态 | |
| AC-CV-002 | CV-S01 发送消息 | 字段边界 | 正常流程：非空 | P1 | U-CV-001 | - | - | 空消息禁用发送 | unit 校验 |
| AC-CV-003 | CV-S01 发送消息 | 可用性 | 异常：provider 未配置 | P1 | - | A-CV-002 | E-CV-002 | 提示配置而非崩溃 | |
| AC-CV-004 | CV-S02 流式响应 | 性能 | 正常流程：长回复 | P0 | - | A-CV-003 | E-CV-001 | 增量渲染不卡顿；端到端延迟<100ms | 长文本性能 |
| AC-CV-005 | CV-S02 流式响应 | 状态/一致性 | 异常：流中断 | P1 | - | A-CV-004 | - | 保留已收内容，标记中断 | |
| AC-CV-006 | CV-S03 富文本渲染 | 功能 | 正常流程：markdown/代码/mermaid | P0 | U-CV-002 | - | E-CV-003 | 三种内容正确渲染 | |
| AC-CV-007 | CV-S03 富文本渲染 | 安全/XSS | 安全：恶意 HTML | P0 | U-CV-003 | - | E-CV-004 | script/onerror 被过滤不执行 | 白名单硬约束 |
| AC-CV-008 | CV-S03 富文本渲染 | 边界 | 异常：Mermaid 语法错误 | P1 | U-CV-004 | - | E-CV-003 | 显示错误提示+源码，不崩溃 | |
| AC-CV-009 | CV-S04 取消响应 | 状态/一致性 | 正常流程：取消保留已生成 | P0 | - | A-CV-005 | E-CV-002 | 停止响应，保留已生成内容 | 不可逆保留 |
| AC-CV-010 | CV-S04 取消响应 | 状态 | 正常流程：取消后恢复 | P1 | - | A-CV-005 | E-CV-002 | 取消后可以再次发送 | |
| AC-CV-011 | CV-S05 历史装载 | 一致性 | 正常流程：历史加载 | P0 | - | A-CV-006 | E-CV-005 | 全部历史被加载并正确渲染 | |
| AC-CV-012 | CV-S05 历史装载 | 一致性 | 正常流程：角色区分 | P1 | - | A-CV-006 | E-CV-005 | user/assistant/隔离区分 | |

---

## 用例设计说明

### unit

| 用例 ID | 关联 AC | 测试对象 | 风险维度 | 前置条件 | 输入 | 操作 | 预期结果 | 负向断言 |
|---|---|---|---|---|---|---|---|---|
| U-CV-001 | AC-CV-002 | sendMessage 输入校验 | 字段边界 | 会话存在 | 空字符串/空格 | sendMessage | 校验失败，不触发 ModelRuntime | 无消息写入 |
| U-CV-002 | AC-CV-006 | Markdown 渲染器 | 字段边界 | 消息内容 | `\`\`\` 代码块+标题+列表 | 渲染 | 正确生成 HTML 结构 | 不当转义 |
| U-CV-003 | AC-CV-007 | 白名单渲染器 | 安全 | 消息含恶意 HTML | `<script>alert</script>`、`<img onerror>` | 渲染 | 危险标签被剔除/转义，不执行 | 无跨站脚本（XSS）执行 |
| U-CV-004 | AC-CV-008 | Mermaid 渲染 | 边界 | 无效 mermaid 图 | `graph TD; a -- b --` 非法 | 渲染 | 返回错误信息+源码 | 不抛出未处理异常 |

### api（IPC 契约 + CanonicalEvent）

| 用例 ID | 关联 AC | 接口 | 前置条件 | 请求数据 | 预期响应/错误码 | 数据落地 | 断言点 |
|---|---|---|---|---|---|---|---|
| A-CV-001 | AC-CV-001 | conversation/sendMessage | 会话存在 | { sessionId, content: "hi" } | 200 | 写入 pi session | 事件流推送 user+assistant 消息 |
| A-CV-002 | AC-CV-003 | conversation/sendMessage | provider 未配置 | { sessionId, content } | 1004 | 无写入 | 返回 1004 不崩溃 |
| A-CV-003 | AC-CV-004 | conversation/sendMessage（长文本） | 会话可跑 | 长文本（>10k token） | streaming 增量事件 | 消息完整落库 | 无缺失/重复事件，顺序正确 |
| A-CV-004 | AC-CV-005 | conversation/sendMessage（中途断流） | mock 断流 | 发送后中断 | 标记中断事件 | 已收内容保留 | 停止后可重试 |
| A-CV-005 | AC-CV-009/010 | conversation/cancelStream | 会话 runnin g | { sessionId } | 200 | 保留已生成，标记 cancelled | 可再次发送 |
| A-CV-006 | AC-CV-011/012 | session/queryHistory | 会话含历史 | { sessionId } | 返回全部历史 | 无 | 角色区分正确、顺序正确 |

### e2e

| 用例 ID | 关联 AC | 页面 | 前置场景 | 测试数据 | 自动化等级 | 操作 | 断言 |
|---|---|---|---|---|---|---|---|
| E-CV-001 | AC-CV-001/004 | 对话区 | 会话存在 + provider | mock 流式数据 | mock-backend | 发消息→观察流式 | 消息显示，内容实时增量，无卡顿 |
| E-CV-002 | AC-CV-009/010 | 对话区 | 会话运行中 | mock 流式 | mock-backend | 点取消→再发 | 取消后已生成保留，可再发 |
| E-CV-003 | AC-CV-006/008 | 对话区 | 历史消息含富文本 | 消息含 markdown+代码+mermaid（含错误语法） | mock-backend | 打开会话→观察渲染 | 三种富文本正确；Mermaid 错误显示提示+源码 |
| E-CV-004 | AC-CV-007 | 对话区 | 恶意 HTML 消息 | 消息含 `<script>`/`onerror` | manual（安全断言） | 渲染消息 | 无脚本执行，无交互注入 |
| E-CV-005 | AC-CV-011/012 | 对话区 | 会话有历史消息 | 10+ 历史消息，含 user/assistant/tool | mock-backend | 打开→滚到最新 | 历史全加载，角色正确渲染 |

> E-CV-004 用 manual（安全边界，需人工确认无脚本执行，无法由 mock 自动判定）——已注明。可另配合禁用 CSP 的专用用例做自动化安全断言（P2 补充）。