# 对话与消息 e2e 设计

> 模块：03 对话与消息
> 来源：`coverage-matrix.md` + PRD 03
> 状态：已确认（含扩展 CV-S06 E-CV-007~011、扩展 CV-S08 E-CV-014~018、扩展 CV-S11 E-CV-020~025、扩展 CV-S12 E-CV-026~028）
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

## 扩展 CV-S11 Todo 面板（E-CV-020~025）

> v3.63 在 coverage-matrix 定义了 E-CV-020~025，但未在本文件展开。本次（CV-S12 引入时）补齐，
> 使 coverage-matrix 的 e2e 引用不再悬空。

## E-CV-020 Todo 面板渲染（AC-CV-037）

- **关联 AC**：AC-CV-037 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：主会话激活；seed mock `tool.completed(tool.name='todo')` 事件，details 含 4 个任务（2 completed + 1 in_progress + 1 pending）
- **操作**：触发 todo 工具完成事件 → 观察输入框上方
- **断言**：
  - UI：面板出现；标题「已完成 2 / 共 4 个」；渲染 4 行（✓×2、●、○）；● 行括号内展示 activeForm
  - 数据：只消费 `tool.completed` 终态（不消费 `tool.started`，避免流式噪声）
  - 负向：非法 details（缺失/非对象/tasks 非数组）静默忽略、不抛错
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-021 任务行格式化（AC-CV-038）

- **关联 AC**：AC-CV-038 | **优先级**：P1 | **自动化等级**：mock-backend
- **前置**：已挂载面板；seed 含/不含 activeForm、含/不含 owner、空 subject、超长 subject（CJK 200 字 / emoji 50）
- **操作**：观察面板渲染
- **断言**：
  - UI：三种状态字符与色正确；空 subject 显「（无标题）」；● 行括号展示 activeForm；超长 subject 按码点截断 + 省略号（恰好 120 字不加省略号）
  - 数据：owner 不展示；不渲染 HTML（无 v-html）
  - 负向：不产生半个代理对（emoji 截断安全）
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-022 折叠切换与会话隔离（AC-CV-039）

- **关联 AC**：AC-CV-039 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：已挂载面板（默认展开）
- **操作**：点击标题头部 → 观察 → 再点击 → 切子 agent Tab → 切回主会话；切到另一会话再切回
- **断言**：
  - UI：折叠态仅渲染标题 + chevron、不渲染任务行；展开态渲染全部任务行；过渡 ≤200ms；hover 不触发展开/收起
  - 数据：折叠状态按 `sessionId` 内存隔离（切会话不串、刷新页面重置为默认展开）
  - 负向：无
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-023 空快照卸载与超量收口（AC-CV-040）

- **关联 AC**：AC-CV-040 | **优先级**：P1 | **自动化等级**：mock-backend
- **前置**：不同快照规模：空快照 / 仅墓碑 / 51 任务 / 5 任务
- **操作**：观察 DOM 与高度
- **断言**：
  - UI：空快照 / 仅墓碑 → 面板从 DOM 卸载、不留高度与占位；51 任务 → 前 50 行 + 「+N more」；5 任务 → 列表可视区固定 3 行高度、超出内部滚动（细滚动条 ≤6px）；输入框上提补位
  - 数据：可见 task 计算过滤 `status==='deleted'` 墓碑
  - 负向：卸载态不输出任何高度
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-024 多会话 todo 隔离 + 非法 details（AC-CV-041）

- **关联 AC**：AC-CV-041 | **优先级**：P1 | **自动化等级**：mock-backend
- **前置**：多会话画布；sessionA 已挂载 todo 面板；sessionB 无
- **操作**：切到 sessionB → 观察；sessionB 触发非法 details 事件（缺失/非对象/tasks 非数组）；切回 sessionA
- **断言**：
  - UI：sessionB 面板卸载；非法 details 静默忽略、不报错；切回 sessionA 面板快照还原
  - 数据：两会话快照各自独立，互不覆盖
  - 负向：连续多次非法事件不累积错误、不发 toast
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-025 长任务列表保证进行中可视（AC-CV-042）

- **关联 AC**：AC-CV-042 | **优先级**：P2 | **自动化等级**：mock-backend
- **前置**：已挂载面板；seed 20 个任务（in_progress 位于第 5 行）；另一组全部 completed 的 10 个任务
- **操作**：观察滚动位置 → 用户手动向下滚动 → 再触发一次状态变化
- **断言**：
  - UI：有 in_progress 时其落在 3 行可视窗口内（不强求顶部，第 1/2/3 行都可，用户无需手动滚动即可见）；无 in_progress（全部完成）时滚到最后一行
  - 数据：目标行已可视时 no-op，不抢用户手动滚动位置
  - 负向：不产生跳动（目标行已可视则无滚动）
  - 健康：无 console error / pageerror
- **证据**：screenshot

---

## 扩展 CV-S12 ask_user_question 内嵌问卷（E-CV-026~028）

> 与 CV-S11 的关键差别：问卷是**双向**的（面板 → 主进程 → 扩展 → 模型），
> 且必须在多窗格画布下按会话隔离投递与回填。
>
> **落地位置**：`packages/forge-ui/e2e/askUserQuestion.spec.ts`
> （E-CV-026 → `ASK-E2E-001/002/003`、E-CV-027 → `ASK-E2E-004/005`、
> E-CV-028 → `ASK-E2E-006`）。CV-S12 的这三条用例在 v3.69~v3.71 期间**只存在于本文件、
> 没有对应 spec**，于是组件层唯一的验证路径也是空的 —— `ASK-E2E-006` 正是用来堵住
> 这个缺口的（详见其断言说明）。

## E-CV-026 问卷面板渲染与作答（AC-CV-043/044/045/046/050）

- **关联 AC**：AC-CV-043/044/045/046 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：主会话激活；mock 扩展 emit 一份 2 题问卷（第 1 题单选、选项带 `preview` 且含推荐项；第 2 题 `multiSelect:true`）
- **操作**：触发 `conversation.askUserQuestionRequested` → 观察面板 → **点第 1 题（带 preview）某选项 → 观察自动切屏** → 点「上一题」回看 → 用「下一题」手动前进 → hover 各选项观察右侧预览（高度不得变化）→ 第 2 题勾 2 个多选项（观察不自动前进）→ 再点「自己答」选项观察展开输入框且**已勾选项仍保持勾选** → 填文本 → 收起输入框观察该行仍高亮 → 走到末步（备注 tab）点「提交答案」→ 观察折叠摘要
- **断言**：
  - UI：输入框上方出现内嵌面板；N+1 tab 可切换；**仅单选且选项带非空 preview** 时左右分栏（多选切回单栏）；推荐项渲染「推荐」徽标且标签**不显示** `(Recommended)` 后缀
  - **答完即收（AC-CV-050）**：走到末步点「提交答案」→ 摘要（`已答 n/N · 答案摘要 [· 备注：…]`）先出现，约 1.5s 后面板**带着 leave 动画（淡出 + 下沉 + 折叠）整体卸载**，输入框上方回到无面板状态；**摘要不会一直挂着**；卸载后**不得**因迟到的 `tool.completed` 重新弹出（等 2~3s 再断言面板仍不存在）；切到别的会话再切回来，该轮摘要**也不得**复活；随后同一会话再来一轮问卷 → 新面板正常出现、新的摘要正常显示
  - **提交按钮禁用（AC-CV-050）**：末步 `已答 0/N` 时「提交答案」为 `disabled`（点它不产生任何回填、面板不卸载）；只填备注、一题未选时同样禁用；作答至少一题后按钮恢复可用
  - **超时也要收（AC-CV-050 负向）**：已答部分题目后挂机等倒计时归零 → 已答部分回填成功、`cancelled:true` → 面板**同样**在约 1.5s 后收起（**不得**因为「`cancelled` 且 answers 非空」被误判成送达失败而留下过期卡片）
  - **操作条位置**：`已答 n/N` + 上一题 / 下一题 / 取消 / 提交答案 全部在**标题行**（标题与「等待回答 · Ns」徽标之间）；面板**底部无**操作条；折叠面板时操作条随之隐藏、展开后回来
  - 步骤导航（向导式）：多题时出现「上一题 / 下一题」（首步无「上一题」、末步无「下一题」）；点 tab 与点导航互不冲突（顺序不强制）；**「提交答案」只在末步渲染** —— 中间步断言该按钮不存在（`已答 0/N` 时也无）；单题问卷不出导航、提交按钮常驻
  - **自动前进**：**单选**点中普通选项后自动切到下一步；**多选不切**（可连续勾选）；点「自己答」**不切**（保留输入时间）；末步不切（无下一步）
  - **「自己答」形态**：是选项列表**末位的一行**（单选渲染 radio、多选渲染 checkbox），不是独立卡片；未选中时**不渲染**输入框（无占位高度）；选中才在选项区**下方整宽**展开（分栏时跨两列）；**单选**下与普通选项互斥 —— 选任一普通选项即取消该行并清空已输入文本（避免残留 custom 静默覆盖刚选的 option）；**多选**下与普通选项**并列** —— 先勾选项再点「自己答」，已勾选项**保持勾选**（反之亦然），收起输入框**不丢**文本且该行**仍高亮**（文本已计入答案）
  - **尺寸稳定（禁止跳动）**：hover / 切换不同选项时右侧 preview 面板高度恒定（固定 240px + 内部滚动），面板底部与下方输入框不发生垂直位移；preview 内容超长时面板内滚动而非撑高
  - **分栏宽度**：预览列窄于选项列（约 1.4 : 1；820px 面板下预览 ≈ 325px、选项列 ≈ 455px），选项列不多占一半宽度
  - **预览内容排版**：preview 含 `- 优点：…` / `1. …` 列表时，**黑点与序号完整落在圆角框内**（不得被左边框切掉半颗）；列表项之间无多余空行（`pre-wrap` 不得把标记间的换行节点渲染成空行）；嵌套列表有递进缩进
  - 数据：单选 → `kind='option'` + `answer=<原始 label>`；多选 → `kind='multi'` + `answer=null` + `selected`（保持勾选顺序，**自定义文本并入末位**，不另起 `kind='custom'` 条目）；单选自定义 → `kind='custom'`；部分作答只产出已答条目（摘要显示「已答 n/N」）；回填 label 为原始值（含后缀，剥离仅发生在显示层）；`details.answers[].preview` 保留但 envelope 不含 `selected preview:`
  - 负向：子 agent 结果视图激活时不渲染面板；选项无 preview 时不产出该字段；句中（非尾部）出现 `(Recommended)` 不误判为推荐；中间步无「提交答案」按钮（规避「0 答提交 ≡ 取消」歧义路径）；点操作条按钮**不得**顺带触发头部折叠；**多选题内不得互斥**（勾普通选项不得取消「自己答」，反之亦然）
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-027 倒计时归零与多窗格会话隔离回填（AC-CV-047/048）

- **关联 AC**：AC-CV-047/048 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：会话 A 面板倒计时进行中（下发 `timeoutMs` ≈ 10s，A 已答 1 题未提交）；会话 B 同时挂载并收到自身问卷
- **操作**：A 切走再切回观察剩余秒数 → A 归零 → B 同时 emit 请求 → 对 A 提交后再次触发归零
- **断言**：
  - UI：剩余秒数按绝对截止时刻连续（切走再切回不重置）；**头部读数必须 > 0 且逐秒递减**（面板首屏即挂载、问卷后到 —— 不得因 computed 缓存首屏空值而恒显示 0）；归零主动回填「已答部分 + `cancelled:true`」；提交 / 取消 / ESC 走同一路径
  - 数据：**A 的问卷只在 A 窗格出现，B 窗格不弹**；A 的回填只落 A 的会话总线；提交与归零竞态只上报一次（`settled` 门）
  - 负向：无 lease 会话回填返回 false 且零投递（作答被丢弃 → 模型收到 DECLINE）；缺 `sessionId` 的请求一律忽略
  - 健康：无 console error / pageerror
- **证据**：screenshot

## E-CV-028 首屏对话区渲染健康（AC-CV-043 前置）

- **关联 AC**：AC-CV-043 | **优先级**：P0 | **自动化等级**：mock-backend
- **前置**：冷启动首屏（默认 mock 种子 4 个会话），**不** emit 任何问卷事件
- **操作**：`goto('/')` → 选中一个会话 → 观察对话区三件套 → 在输入框输入文本
- **断言**：
  - UI：`.conv-view` 数量为 1；`.conv-input-wrap` 与 `.compose-box` 可见；无问卷时 `.ask-panel` 不占位（`toHaveCount(0)`）
  - **输入框可用**：能聚焦并输入（渲染中断时 DOM 可能残留，但事件系统已死 —— 只断言「元素存在」抓不到这类故障）
  - 健康：**无 pageerror / console error**
- **为什么必须单列一条**：`AskUserQuestionPanel` 常驻挂载在 `.conv-input-wrap` 内（`v-if="!showResultView"`，首屏无问卷也挂）。它的 setup 一旦抛错，**整个 `ConversationView` 的更新都会失败**，表现为「左侧项目/会话树正常、右侧对话区整块空白」—— 与面板自身完全无关的现象。而组件层没有单测设施（forge-ui 只测纯函数），CSS/声明顺序这类问题只有浏览器级用例兜得住。
  - 真实案例（v3.71 → v3.72）：「答完即收」的 watch 写在 `const showAnswered` **之前**，`doWatch` 建 effect 时会**同步求值一次** getter（不需要 `immediate`）→ 撞 `const` 的 TDZ → `ReferenceError: Cannot access 'showAnswered' before initialization` → 对话区整块空白。真机现象与终端只留下无害的 Chromium 网络告警，误导性极强。
  - 反向验证：把 `showAnswered` 挪回 watch 之后，本用例与 E-CV-026/027 全部 6 条一并变红（面板与 composer 都找不到），挪回前面即全绿。
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
| E-CV-019 | 034/035/036 | P1 | mock-backend | @ 补全触发/过滤/选中进待发区 + 空态降级 |
| E-CV-020 | 037 | P0 | mock-backend | 面板渲染 + 标题计数 + 三态任务行 |
| E-CV-021 | 038 | P1 | mock-backend | 格式化 fixture（activeForm/空 subject/超长/emoji） |
| E-CV-022 | 039 | P0 | mock-backend | 折叠切换 + sessionId 隔离 |
| E-CV-023 | 040 | P1 | mock-backend | 空快照卸载 + 51 任务收口 |
| E-CV-024 | 041 | P1 | mock-backend | 多会话快照隔离 + 非法 details |
| E-CV-025 | 042 | P2 | mock-backend | 长列表锁 in_progress + 不抢手动滚动 |
| E-CV-026 | 043/044/045/046/050 | P0 | mock-backend（emit askUserQuestionRequested） | 问卷面板渲染/标题行操作条/步骤导航（末步才可提交）/单选自动前进/「自己答」折叠为选项/preview 尺寸稳定 + 分栏宽度 + 列表黑点在框内/答完即收（1.5s 后卸载且不复活）/0 答禁用提交/回填原始 label |
| E-CV-027 | 047/048 | P0 | mock-backend（emit askUserQuestionRequested） | 倒计时连续 + 归零回填 + 多窗格隔离 + 无 lease 零投递 |
| E-CV-028 | 043（前置） | P0 | mock-backend | 首屏对话区三件套渲染 + 面板不占位 + 输入框可用 + 无 pageerror（组件 setup 崩溃打空整块对话区的唯一回归锁） |
| QC-001 | CV-S09 | P0 | mock-backend | 忙时入队/徽标浮窗/自动派发（慢回复脚本） |
| QC-002 | CV-S09 | P1 | mock-backend | 上限 5 条拒绝 + 输入保留 |
| QC-003 | CV-S09 | P0 | mock-backend | 停止清队 + \n\n 回填（TUI ESC 同款） |
| QC-004 | CV-S09 | P1 | mock-backend | 切走再切回徽标不丢（队列镜像按会话维护，v1.2） |
| AC-IH-001~007 | CV-S10 | P1 | mock-backend | 空输入 ↑↓ 翻阅/隔离/持久化/去重/草稿态 |
