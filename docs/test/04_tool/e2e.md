# 工具执行展示 e2e 设计

> 模块：04 工具执行展示
> 来源：`coverage-matrix.md` + PRD 04
> 状态：已确认
> 触发：Diff 数据准备（old/new fixtures、大文件）、状态机、XSS fixtures 复杂，按 contract §D 客观触发展开。

---

## 通用健康断言（每条必含）

- 无未声明 console error / pageerror / requestfailed。
- 关键元素可见；工具卡片不重叠。
- 结束无残留 spinner（工具状态必须收敛到 completed/error）。

---

## E-TE-001 工具卡片与状态流转

- **关联 AC**：AC-TE-001/009 | **优先级**：P0 | **自动化等级**：mock-backend
- **数据**：mock 工具事件流（tool.started → tool.completed / tool.error）
- **操作**：触发 AI 调工具 → 观察卡片
- **断言**：
  - UI：卡片出现含工具名+参数；状态实时 running→completed/error
  - 负向：状态不跳跃（无 completed 又回 running）、无残留 spinner
- **健康**：无 console error
- **证据**：video（状态时序）+ screenshot

## E-TE-002 工具结果与失败展示

- **关联 AC**：AC-TE-003/010 | **优先级**：P0 | **自动化等级**：mock-backend
- **数据**：工具含正常结果（含代码）+ 失败工具（返回 error）
- **操作**：观察结果与失败卡片
- **断言**：
  - 正常：结果文本/代码高亮渲染
  - 失败：卡片标红 + 错误信息；不崩对话流
  - 负向：正常/失败结果不串、失败不显示空结果
- **健康**：无 console error
- **证据**：screenshot

## E-TE-003 文件 Diff（fixtures + 大文件）

- **关联 AC**：AC-TE-006/007/008 | **优先级**：P0 | **自动化等级**：mock-backend
- **数据**：
  - 小 Diff fixture：edit 事件含 oldText/newText（增删改混合，明确差异行）
  - 大文件 fixture：>10k 行变更（虚拟滚动/行数限制场景）
- **操作**：触发 edit 工具 → 观察 Diff
- **断言**：
  - UI：并排 Diff 左旧右新，增删行高亮；显示文件路径
  - 数据：Diff 增删行与实际 old/new 一致（逐行比对）；大文件不卡顿（虚拟滚动/压缩展示）
  - 负向：无差异时旧=新；Diff 数据缺失（无 oldText）降级显示 newText；大文件渲染不崩
- **健康**：无 console error
- **证据**：screenshot（大小各一）+ trace

## E-TE-004 结果 XSS（fixtures）

- **关联 AC**：AC-TE-005 | **优先级**：P0（断言由 U-TE-002 自动覆盖；本 E2E 为补充）| **自动化等级**：manual（安全，需人判定）
- **数据**：工具结果含 `<script>`、`<img onerror>`、Javascript 协议链接
- **操作**：渲染结果 → 观察 + 检查无脚本执行
- **断言**：危险标签剥离/转义；无脚本执行、无 alert、无跨域请求
- **落地**：P0 断言由 U-TE-002（结果白名单渲染单测）自动覆盖；本 E2E 作浏览器级补充。

---

## 覆盖汇总

| 用例 | AC | 优先级 | 自动化等级 | 触发展开项 |
|---|---|---|---|---|
| E-TE-001 | 001/009 | P0 | mock-backend | 工具状态机时序 |
| E-TE-002 | 003/010 | P0 | mock-backend | 结果+失败数据 |
| E-TE-003 | 006/007/008 | P0 | mock-backend | Diff fixtures + 大文件 |
| E-TE-004 | 005 | P0 | manual（U-TE-002 自动覆盖断言） | XSS fixtures |