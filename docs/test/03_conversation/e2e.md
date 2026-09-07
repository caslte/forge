# 对话与消息 e2e 设计

> 模块：03 对话与消息
> 来源：`coverage-matrix.md` + PRD 03
> 状态：已确认（含扩展 CV-S06 E-CV-007~011、扩展 CV-S08 E-CV-014~018）
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

## 扩展 CV-S06 会话历史导航（已确认）

> 纯前端派生视图，无需新增 mock 能力（消息种子即数据源）；时序类断言复用 E-CV-001 的受控流式事件注入。

## E-CV-007 时间线展示与实时新增

- **关联 AC**：AC-CV-014 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：5+ 轮对话会话已加载；首条 user 消息超长（>单行宽度）
- **操作**：
  1. 打开会话观察对话区左缘时间线
  2. 流式进行中发送一条新消息
  3. 切到任一子 agent Tab（如有），再切回主会话
- **断言**：
  - UI：时间线按时间正序列出全部用户消息，条目为简化短横条标记（不展示文本，title 提示截断文本，Rail 无分隔边框）；新消息条目实时出现（无手动刷新）
  - 状态：子 agent 结果视图激活时时间线不渲染；切回主会话恢复
  - 健康：无 console error
- **证据**：screenshot

## E-CV-007b 横条纵向居中 + 悬停波浪衰减（AC-CV-014/016 视觉细化，ZCode 风格）

- **优先级**：P1 | **门禁**：上线必过 | **自动化等级**：mock-backend
- **前置**：8 轮对话会话已加载
- **操作**：观察 Rail → hover 条目 4 → 读取各条宽度 → 移开 → 点击条目 6 后移开指针
- **断言**：
  - 居中：条目块中点与 Rail 可视区中点偏差 ≤30px（不在顶部堆叠）
  - 波浪衰减：默认横条 8~16px；hover 后波峰 >20px，一阶邻居 >默认+2，波峰 > 一阶 > 二阶 ≥ 远端，左右对称（±1px）；全程 width 过渡；移开全部收缩复位；无独立指示条元素
  - 选中保持：点击进入回看后选中条保持突出（>14px）且为 brand 色，其波包带动邻居 >默认+1（注意：波浪距离按条目序数计算，非消息索引）；**定位滚动贴底不退出回看**（触底抑制窗口 800ms——程序化定位 ≠ 手动滚到底）
  - 健康：无 console error

## E-CV-008 浮窗快照（hover/Esc/流式）

- **关联 AC**：AC-CV-015 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：会话含完整多轮（user>120 码点、assistant>200 码点）；另一会话仅提问未回复
- **操作**：
  1. hover 条目 <300ms 移开 → 观察
  2. 重新 hover 停留 ≥300ms → 读浮窗 → 按 Esc
  3. 流式进行中 hover 最后一条目并保持，期间注入 delta
- **断言**：
  - 时序：扫过不弹；停留弹出；Esc/移开立即关闭且无残留节点
  - 内容：用户消息 120 码点截断 + 省略号、助手回复 200 码点截断 + 省略号；纯文本（Markdown 符号原样、无图片）；仅提问未回复会话浮窗显示提问 + 状态提示
  - 快照：delta 期间浮窗内容不变化（关闭再 hover 为更新后快照）
  - 负向：浮窗内无 tool 消息内容
- **证据**：screenshot + trace

## E-CV-009 点击定位与回看模式

- **关联 AC**：AC-CV-016 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：长会话（滚动可回看）+ mock 流式进行中
- **操作**：
  1. 点击中部某条目 → 观察滚动与高亮
  2. 保持不动，注入持续 delta
  3. 点击"回到底部"提示条；对照组：手动滚到底部
- **断言**：
  - 定位：消息流滚动至目标用户消息并短暂高亮
  - 回看模式：delta 持续期间 scrollTop 不被强制改写（无自动滚底）；底部"回到底部"提示出现
  - 恢复：点击提示或手动触底后恢复自动滚底（后续 delta 跟随到底）
  - 负向：回看模式期间页面不得跳动；恢复动作不重复触发
- **证据**：video（时序）+ trace

## E-CV-010 空态不渲染

- **关联 AC**：AC-CV-017 | **优先级**：P1 | **自动化等级**：mock-backend
- **前置**：新建会话草稿态；对照：已打开但无任何 user 消息的会话
- **操作**：观察对话区左缘
- **断言**：无时间线、无占位元素；消息区行为与扩展上线前一致；无 console error
- **证据**：screenshot

## E-CV-011 浮窗不溢出视口（窄窗口）

- **关联 AC**：AC-CV-018 | **优先级**：P2 | **自动化等级**：mock-backend（窄视口）
- **前置**：视口设为最小支持尺寸；条目分别位于侧缘上/中/下
- **操作**：hover 各条目出浮窗；resize 至极窄重复
- **断言**：浮窗完整落在视口内（翻转/收拢生效）；超高内容内部滚动不撑破；resize 无布局报错
- **证据**：screenshot

---

## E-CV-012 手动上下文压缩（AC-CV-020/021/022）

- **关联 AC**：AC-CV-020/021/022 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：会话已选中；`window.__forgeMock.seed('conversation/compact', …)` 可编程覆盖
- **操作**：点击用量区「压缩」按钮；分别注入成功（带 token 详情）与失败（ok=false）响应；
  再注入 `conversation.statusChanged {status:'streaming'}` 观察入口状态
- **断言**：
  - 成功：显示「压缩完成：90000 → 12000 tokens」（详情缺失时回退「压缩完成」）；
  - 失败：显示失败原因原文（如 `Nothing to compact`），不静默；
  - streaming 期间：压缩入口带 `disabled` 且不可点；
  - 全程无 console error / pageerror（dev 预览走 mock-bridge，曾因缺失该方法抛 TypeError）
- **证据**：screenshot

## E-CV-013 自动压缩感知（AC-CV-023）

- **关联 AC**：AC-CV-023 | **优先级**：P0 | **自动化等级**：mock-backend（emit conversation.compacted）
- **前置**：会话已选中并加载过历史
- **操作**：`window.__forgeMock.emit(sid, 'conversation.compacted', { reason:'auto', tokensBefore, tokensAfter, summary })`
- **断言**：消息区顶部出现「上下文已自动压缩」提示条；`conversation/queryHistory` 被调用
  （历史已重拉，避免界面仍显示压缩前的旧内容）；无 console error / pageerror
- **证据**：screenshot

## E-CV-014 斜杠命令浮窗：触发/美化/过滤/空态（AC-CV-026/027/028）

- **关联 AC**：AC-CV-026/027/028 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：会话激活（非 streaming）；`window.__forgeMock.seed('conversation/getSlashCommands', …)` 返回三类命令清单
  （`skill:git-push`「推送当前分支」、`review-pr`「审查拉取请求」、`write-tests`（无描述））
- **操作**：
  1. 输入框行首输入 `/` → 浮窗弹出
  2. 续输 `git` → 过滤；再改为 `zzz` → 空态
  3. `window.__forgeMock.emit(sid, 'conversation.statusChanged', { status:'streaming' })` 后尝试输入 `/`
- **断言**：
  - UI：浮窗自输入框向上弹出；条目显示 **Git Push**（无 `/` 与 `skill:` 前缀、Title Case、加粗+品牌色）+ 来源标签「技能」+ 描述副文本；
    `review-pr` 普通色「命令」；`write-tests` 弱化色「模板」且无描述行；输入 `git` 后仅剩 `skill:git-push`；
    `zzz` 后显示「无匹配命令」而非隐藏
  - 负向：streaming 期间 textarea 禁用（disabled），浮窗不出现
  - 健康：无 console error / pageerror
- **证据**：screenshot（三类条目样式 + 空态）

## E-CV-015 斜杠命令：导航/选择/插入原始串（AC-CV-029）

- **关联 AC**：AC-CV-029 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：浮窗已打开（seed ≥3 条命令，高亮首条）
- **操作**：
  1. 按 ↓↓ 到末条再按 ↓（循环回首条）→ Enter 选中
  2. 重新打开浮窗 → Tab 选中；再开浮窗 → 鼠标单击第三条
  3. 浮窗打开期间按 Enter（选择）后检查消息区
- **断言**：
  - UI：↑↓ 循环导航高亮跟随；三种选择方式（Enter/Tab/单击）均把行内命令前缀替换为
    **原始命令串 + 尾随空格**（如 `/skill:git-push `），光标落在空格后；浮窗关闭
  - 数据一致性：输入框文本为原始命令串（**美化名 `Git Push` 不得出现在输入框**）
  - 负向：浮窗打开期间的 Enter 被浮窗消费——消息区无新 user 气泡（不触发发送）
  - 健康：无 console error / pageerror
- **证据**：trace + 输入框 value 断言

## E-CV-016 斜杠命令：浮窗关闭路径（AC-CV-030）

- **关联 AC**：AC-CV-030 | **优先级**：P1 | **自动化等级**：mock-backend
- **前置**：浮窗已打开（行首 `/g`）
- **操作**（四路径独立触发，每路径后重开浮窗）：
  1. Esc；2. 点击输入框外部（失焦）；3. 删空行首 `/`；4. 行内输入空格（`/git push`）
  5. 关闭后输入普通文本按 Enter
- **断言**：
  - UI：四路径均关闭浮窗；关闭后 Enter 恢复发送语义（普通消息正常出现在消息区）
  - 负向：关闭后按 Enter 不再被浮窗消费（消息发出，非无响应）
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-017 斜杠命令：草稿态可见 skills、激活后扩展命令补全（AC-CV-032）

- **关联 AC**：AC-CV-032 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：新建会话未发消息（草稿态）；seed：无 sessionId 的 `getSlashCommands` 返回 skills+模板；
  有 sessionId 时返回三类全量
- **操作**：
  1. 草稿态行首输入 `/` → 观察清单
  2. 发送首条消息（激活会话）→ `window.__forgeMock.emit(sid, 'conversation.slashCommandsUpdated', { sessionId: sid })`
  3. 删除输入内容，再次输入 `/` → 观察清单
- **断言**：
  - UI：草稿态列出 skills 与模板（**无扩展命令**）；事件后再次触发浮窗，扩展命令出现（缓存失效重拉）
  - 数据：第二次打开浮窗时 `getSlashCommands` 携带 sessionId 被再次调用
  - 负向：草稿态清单不含来源「命令」的条目
  - 健康：无 console error / pageerror
- **证据**：screenshot（前后清单对比）

## E-CV-018 斜杠命令：枚举失败降级（AC-CV-033）

- **关联 AC**：AC-CV-033 | **优先级**：P1 | **自动化等级**：mock-backend
- **前置**：seed `conversation/getSlashCommands` 抛错（或返回 `commands: []`）
- **操作**：行首输入 `/` → 观察浮窗 → 清空后输入普通消息发送
- **断言**：
  - UI：浮窗弹出显示「无可用命令」；已输入文本保留不被清空
  - 数据：普通消息经 sendMessage 正常发送（消息区出现 user 气泡），无报错弹窗
  - 负向：枚举失败不产生全局错误提示、不阻塞输入
  - 健康：无 console error / pageerror（mock 抛错由后端收敛为空清单）
- **证据**：screenshot

---

## E-CV-019 @ 文件补全：触发/过滤/选中/空态（AC-CV-034/035/036）

- **关联 AC**：AC-CV-034/035/036 | **优先级**：P1 | **自动化等级**：mock-backend
- **前置**：mock 会话（projectPath = mock 默认项目）；mock-bridge `file.listProjectFiles` 返回固定 3 条清单
- **操作**：输入框输入「看下 @」→ 触发浮窗 → 续输 `read` 过滤 → ↓+Enter 选中 → 再输 `@zzz`（空态）→ Esc → 输入普通消息
- **断言**：
  - UI：@ 触发弹出浮窗 3 条；过滤后 1 条（README.md）；选中后 @token 从输入框移除（剩「看下 」）、待发区出现 attach-chip；空态显示「无匹配文件」；Esc 关闭；输入不被阻塞
  - 数据：选中文件经 addPaths 入待发区（与选择/粘贴/拖拽同链路，发送时由 onSend 拼 @ 路径行）
  - 负向：无匹配不产生全局错误、不阻塞输入
  - 健康：无 console error / pageerror
- **证据**：screenshot

---

## 覆盖汇总

| 用例 | AC | 优先级 | 自动化等级 | 触发展开项 |
|---|---|---|---|---|
| E-CV-001 | 001/004 | P0 | mock-backend | mock 事件序列/时序 |
| E-CV-002 | 009/010 | P0 | mock-backend | 断流/取消时序 |
| E-CV-003 | 006/008 | P0 | mock-backend | fixture（mermaid 合法+非法） |
| E-CV-004 | 007 | P0 | manual（U-CV-003 自动覆盖断言） | XSS fixtures |
| E-CV-005 | 011/012 | P0 | mock-backend | 多角色历史数据 |
| E-CV-007 | 014 | P0 | mock-backend | 时间线派生 + 流式中实时新增 |
| E-CV-007b | 014/016 | P1 | mock-backend | 纵向居中 + 悬停波浪衰减（ZCode 风格）+ 定位贴底不退出 |
| E-CV-008 | 015 | P0 | mock-backend | hover 时序 + 截断 fixture + 流式快照 |
| E-CV-009 | 016 | P0 | mock-backend | 定位/回看模式与滚动时序 |
| E-CV-010 | 017 | P1 | mock-backend | 空态 |
| E-CV-011 | 018 | P2 | mock-backend（窄视口） | 极端尺寸布局 |
| E-CV-012 | 020/021/022 | P0 | mock-backend | 压缩结果反馈 + 流式禁用 |
| E-CV-013 | 023 | P0 | mock-backend（emit 事件） | 自动压缩感知与历史重拉 |
| E-CV-014 | 026/027/028 | P0 | mock-backend | 斜杠浮窗触发/美化/过滤/空态 + streaming 可用（CV-S09 起忙时不禁用） |
| E-CV-015 | 029 | P0 | mock-backend | 导航/选择/插入原始串（含 Enter 不发送负向） |
| E-CV-016 | 030 | P1 | mock-backend | 四关闭路径 + Enter 恢复发送 |
| E-CV-017 | 032 | P0 | mock-backend（emit slashCommandsUpdated） | 草稿态 skills 可见 + 激活后扩展命令补全 |
| E-CV-018 | 033 | P1 | mock-backend | 枚举失败降级不阻塞输入 |
| E-CV-019 | 034/035/036 | P1 | mock-backend | @ 补全触发/过滤/选中进待发区 + 空态降级 || QC-001 | CV-S09 | P0 | mock-backend | 忙时入队/徽标浮窗/自动派发（慢回复脚本） |
| QC-002 | CV-S09 | P1 | mock-backend | 上限 5 条拒绝 + 输入保留 |
| QC-003 | CV-S09 | P0 | mock-backend | 停止清队 + \n\n 回填（TUI ESC 同款） |
| QC-004 | CV-S09 | P1 | mock-backend | 切走再切回徽标不丢（队列镜像按会话维护，v1.2） |
| AC-IH-001~007 | CV-S10 | P1 | mock-backend | 空输入 ↑↓ 翻阅/隔离/持久化/去重/草稿态 |
