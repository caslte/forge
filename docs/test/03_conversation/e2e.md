# 对话与消息 e2e 设计

> 模块：03 对话与消息
> 来源：`coverage-matrix.md` + PRD 03
> 状态：已确认
> 触发：流式 mock 事件序列/时序、XSS fixtures、断流/取消时序复杂，按 contract §D 客观触发展开。

---

## 通用健康断言（每条必含）

- 无未声明 console error / pageerror / requestfailed。
- 关键元素可见、无重叠/溢出。
- 结束无残留 loading / 残留 streaming cursor。

---

## E-CV-001 流式响应（mock 事件序列 + 时序）

- **关联 AC**：AC-CV-001/004 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：会话存在 + provider 已配置
- **数据**：mock 流式事件序列（受控 token 流，含多次 `text_delta`，间隔可控以验证时序）
- **操作**：
  1. 前：进入对话区，输入框聚焦
  2. 中：发消息 → 逐 token 注入 mock 事件
  3. 后：全部 token 注入完
- **断言**：
  - UI：消息气泡出现；token 逐个增量渲染（不整段闪现）；无卡顿
  - 数据：最终渲染内容与 mock 序列一致；无缺失/重复 token
  - 负向：无残留 cursor、无"运行中"卡死
- **健康**：无 console error
- **证据**：video（时序）+ trace

## E-CV-002 取消响应（保留已生成）

- **关联 AC**：AC-CV-009/010 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：会话运行中（mock 流式未结束）
- **操作**：
  1. 前：发消息，已渲染部分 token
  2. 中：点"取消"
  3. 后：再发新消息
- **断言**：
  - UI：已生成内容保留显示；状态变 idle；可再次发送
  - 负向：已生成不丢、无残留 cursor、无第二个响应
- **健康**：无 console error
- **证据**：screenshot + trace

## E-CV-003 富文本渲染（含 Mermaid 错误）

- **关联 AC**：AC-CV-006/008 | **优先级**：P0 | **自动化等级**：mock-backend
- **数据**：消息含 markdown+代码块+mermaid（一图合法、一图非法语法）
- **操作**：打开会话 → 观察渲染
- **断言**：
  - UI：markdown/代码高亮/mermaid 正确渲染；非法 mermaid 显示错误提示+源码
  - 负向：非法 mermaid 不崩、不影响其他消息
- **健康**：无 console error
- **证据**：screenshot

## E-CV-004 XSS 安全（fixtures）

- **关联 AC**：AC-CV-007 | **优先级**：P0（断言由 U-CV-003 自动覆盖；本 E2E 为补充）| **自动化等级**：manual（安全，需人判定无交互注入）
- **数据**：消息含 `<script>alert(1)</script>`、`<img onerror=...>`、`<iframe>`、Javascript 协议链接
- **操作**：渲染消息 → 观察 + 检查无脚本执行
- **断言**：
  - 危险标签被剥离/转义，不渲染为可执行 DOM
  - 无 alert 弹窗、无跨域请求、无交互注入
- **证据**：screenshot + 手工记录
- **落地**：P0 断言由 U-CV-003（白名单渲染器单测）自动覆盖；本 E2E 作浏览器级补充，可另配禁用 CSP 的专用自动化安全用例（P2）替代 manual。

## E-CV-005 历史加载

- **关联 AC**：AC-CV-011/012 | **优先级**：P0 | **自动化等级**：mock-backend
- **数据**：10+ 历史消息，含 user/assistant/tool 三类角色
- **操作**：打开会话 → 滚到最新
- **断言**：
  - 全部历史加载、角色正确区分（user/assistant/tool 渲染不同样式）
  - 顺序正确、无重复、无丢失
- **健康**：无 console error
- **证据**：screenshot + trace

---

## 覆盖汇总

| 用例 | AC | 优先级 | 自动化等级 | 触发展开项 |
|---|---|---|---|---|
| E-CV-001 | 001/004 | P0 | mock-backend | mock 事件序列/时序 |
| E-CV-002 | 009/010 | P0 | mock-backend | 断流/取消时序 |
| E-CV-003 | 006/008 | P0 | mock-backend | fixture（mermaid 合法+非法） |
| E-CV-004 | 007 | P0 | manual（U-CV-003 自动覆盖断言） | XSS fixtures |
| E-CV-005 | 011/012 | P0 | mock-backend | 多角色历史数据