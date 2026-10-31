# 子 Agent 管理 E2E 测试设计

> 模块：06 子 Agent 管理
> 关联：coverage-matrix.md；来源 PRD 06 / API 06
> 自动化等级：`mock-backend`（经 window.__forgeMock 注入 subagent 事件序列；真实链路由 pi-core.md PIC-006 承接）
> 状态：已确认
> v6.37 改版：子 agent 呈现从「输入框上方胶囊 Tab 栏 + 整页结果视图」改为**消息流内的一行 Agent 行**。
> 用例 ID 与验收编号沿用，断言口径随之调整（选择器由 `.subagent-tabbar/.subagent-tab/.subagent-result-view`
> 改为 `.agent-row` 系列）。状态机、事件序列、停止级联语义完全不变。

---

## Mock 能力前置

mock-bridge 需扩展（开发期实现）：

- `setSubagents(sessionId, list)`：设置会话子 agent 内存态种子
- `emit(sessionId, 'subagent.updated' | 'subagent.removed', payload)`：发射子 agent 事件
- `conversation/cancelStream` 种子：可配置是否伴随 subagent.updated(stopped) 事件序列
- Agent 行的挂载锚点是消息流里的 `agent` 工具调用：用例经 `tool.started` + `tool.completed`
  注入一条 `tool:{name:'agent', input:{description}}`（与真实后端链路同构）；
  也可完全不注入工具调用，验证「孤儿兜底」路径（子 agent 记录仍单独成行）

每条用例通用断言：无未声明 console error / pageerror；关键元素可见无重叠；结束无残留 streaming cursor。

---

## E-SA-001 主会话保持运行中（AC-SA-004）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **页面**：单视图会话
- **前置**：会话 A 空闲；种子子 agent 列表空
- **准备**：注入 `agent` 工具调用（description='研究定价'）；seedSendScript：delta（主 agent 文字）→ message（本轮完成）→ 不发 statusChanged done
- **操作**：
  1. 发送消息，等待主 agent 文字输出完毕（思考指示消失前不发 done）
  2. `emit('subagent.updated', { status: 'running', agentId: 'a1', description: '研究定价' })`
- **断言**：
  - UI：会话树 A 状态点保持"运行中"脉动；输入框处于可停止状态
  - 消息流内出现 1 行 `.agent-row`（`is-running`），描述名「研究定价」可见
  - 旧形态选择器（`.subagent-tabbar` / `.subagent-result-view`）计数为 0（改造已彻底落地）
  - 数据：未收到 done 前前端不显示完成态（无绿点/无完成 toast）
  - 健康：无 console error
- **失败证据**：screenshot + trace

## E-SA-002 计数归零自动完成（AC-SA-005）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：承接 E-SA-001 末态（a1 running，主轮已结束未 done）
- **操作**：`emit('subagent.updated', { agentId: 'a1', status: 'completed', finishedAt, result: '完成' })`
- **断言**：
  - UI：会话状态自动转"已完成"（状态点变绿/灰，无需用户操作）；Agent 行转 `is-completed`，行头元信息带「已完成」
  - 事件：前端收到 conversation.statusChanged done（由后端门控发出，mock 侧在子 agent 终态后补发）
  - 负向：done 前发送的第二条用户消息按运行中排队规则处理（沿用现状）

## E-SA-003 完成通知渲染与续跑（AC-SA-007）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：同 E-SA-002
- **操作**：子 agent 完成后 mock 侧以 `conversation.message` 推送完成通知消息（模拟扩展 followUp），再推送一段 assistant 续跑文字
- **断言**：
  - UI：通知消息在消息流渲染一次（不与 Agent 行重复显示为两条）；续跑文字正常流式追加
  - 负向：刷新历史后通知不重复（历史回显幂等）

## E-SA-004 Agent 行出现与状态实时（AC-SA-008/010/011）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：会话 A 打开，消息流内无任何 `.agent-row`
- **操作**：注入两条 `agent` 工具调用（子A-研究 / 子B-抓取）；依次 emit a1 running → completed；再 emit a2 running
- **断言**：
  - 首个事件到达后 Agent 行出现（≤500ms 内状态类变化，用 expect 轮询）：结构 = 状态图标 + 描述名 + agent 类型 + 「阶段 · N 次工具 · 耗时」
  - 状态图标/文案随事件变：运行中转圈 → 完成绿勾；a2 转圈
  - **并发每个一行**：两 agent 并存时 `.agent-row` 计数为 2，各自 `is-running` / `is-completed` 独立
  - 健康：全程无 console error / pageerror

## E-SA-005 行内展开与收起（AC-SA-011/015）

- **优先级**：P1 | **自动化**：mock-backend
- **前置**：承接 E-SA-004 末态（a1 completed、a2 running）
- **操作**：
  1. 点 a1 行 → 行加 `.open`，展开体 `.agent-body` 出现
  2. 再点 a1 行 → `.open` 移除，行内高度归零
  3. 展开 a2 行 → 两行可各自独立展开/收起（互不影响）
  4. emit `subagent.removed { agentIds: ['a2'] }`（模拟后端清除）→ a2 行及其展开态一并移除
- **断言**：展开/收起只改变行内高度；消息流其余内容（条数、滚动位置不强制重置）原样；移除后无残留展开态

## E-SA-006 多窗口一致与隔离（AC-SA-012/021）

- **优先级**：P1 | **自动化**：mock-backend
- **前置**：会话 A、B 各开一个画布窗口；A 派生 a1、B 派生 b1
- **操作**：交错 emit A/B 的事件（A 完成、B 仍在跑）；切换窗口焦点往返
- **断言**：
  - 窗口 A：Agent 行只含 a1（状态类正确），会话 A 状态已完成
  - 窗口 B：Agent 行只含 b1（运行中），会话 B 状态运行中
  - 两窗口 Agent 行/状态互不串扰；行为与单视图一致（同一组件逻辑）
  - 注：画布窗口可能互相叠压，断言用 count/文本而非 `toBeVisible`
  - 健康：无跨窗口事件错误

## E-SA-007 行内展开的过程与结果（AC-SA-013/014/015）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：会话 A 有历史消息；有 a1（running，startedAt 已知）
- **操作**：
  1. 点 a1 行 → 原地展开（不切视图、消息流不被替换）
  2. 运行中观察 2 秒 → 再点收起 → 再点展开
  3. emit a1 completed（result 全文 5000 字 + usage）→ 观察正文
- **断言**：
  - 行头：状态图标+描述名+类型徽标+状态文字+实时耗时（每秒递增）+ N 次工具
  - 展开体：过程流（markdown 正文 + 工具摘要行）；完成后正文 = result 全文（无截断，内部滚动）+ Token 用量行；耗时停止在总时长
  - 主消息流始终可见（历史 assistant 消息条数不变、内容不丢）
  - 负向：result 为空时显示"无结果输出"占位

## E-SA-008 终止交互（AC-SA-016/017/019/020）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：会话 A 有 a1、a2（running）；mock cancelStream 配置为级联（随发 stopped 事件）
- **操作与断言**：
  1. **单个终止**：hover a1 行 → 行内「终止」按钮出现 → 点击弹二次确认；点"取消"→ 无变化（状态仍 running）；再点"确认"→ a1 行转 `is-stopped`，a2 不受影响（仍 running）
  2. **停止级联**：点输入框停止按钮（无二次确认）→ a2 转"已终止"，会话 A 状态转"已完成"
  3. **幂等**：再次点击停止（此时已无活跃子 agent）→ 无报错、无重复终止调用
- **负向**：终止失败分支（mock 配置 RPC 报错）→ toast 报错、状态不变、可重试

## E-SA-009 回归基线：无/重启无子 agent（AC-SA-009/018/023）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **操作与断言**：
  1. 无子 agent 会话：消息流内无 `.agent-row`；发送→流式→停止，行为与改造前一致（停止即 done，已生成内容保留）
  2. 历史含完成通知的会话重开（setHistory 含通知消息）：通知正常渲染、无 Agent 行（列表内存态为空）；注：页面重载后项目组回到默认折叠态，需重新展开才能点会话行
  3. 页面健康：两场景无 console error / pageerror，无残留 streaming cursor

## E-SA-010 实时过程流与终态一致（AC-SA-025/026）

- **优先级**：P1 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：会话 A 空闲；seed 子 agent 列表空；mock `subagent/queryOutput` 返回真实 JSONL 格式（user/assistant/toolResult 条目，运行中按 startedAt 逐步推进，终态末条 assistant 正文 = result）
- **操作**：
  1. `emit('subagent.updated', { agentId: 'a1', status: 'running', startedAt: 10s 前 })` → 点 a1 行
  2. 观察实时过程流 → `emit('subagent.updated', { agentId: 'a1', status: 'completed', result: '完成结果全文。' })`
- **断言**：
  - 收起态已有读数：行头元信息含「N 次工具」（不展开也知道在干活）
  - 运行中：展开体逐条工具摘要行平铺（ls/grep，✓ 状态）——**不再二次聚合折叠**（旧 `.stg-head` 计数 0）；markdown 正文渲染（含"正在扫描"）；无原始 JSON 协议文本、无外框容器
  - 完成：同一条过程流保留且末条正文 = result（"完成结果全文"可见，视图不切换）；附 Token 用量；终态后行内不再出现「终止」按钮
  - 健康：无 console error
- **失败证据**：screenshot + trace

## E-SA-011 工具调用绑定兜底（v6.37 新增）

- **优先级**：P1 | **自动化**：mock-backend
- **前置**：会话 A 打开；消息流内**没有**任何 `agent` 工具调用
- **操作**：直接 `emit('subagent.updated', { agentId: 'a-orphan', description: '孤儿任务', status: 'running' })`
- **断言**：
  - 仍然出现 1 行 `.agent-row`（`is-running`），描述名可见
  - 理由：历史缺工具记录 / 扩展先派发时，绑定不上也必须看得到「有个 agent 在跑」
  - 健康：无 console error
