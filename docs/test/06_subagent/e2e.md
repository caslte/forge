# 子 Agent 管理 E2E 测试设计

> 模块：06 子 Agent 管理
> 关联：coverage-matrix.md；来源 PRD 06 / API 06
> 自动化等级：`mock-backend`（经 window.__forgeMock 注入 subagent 事件序列；真实链路由 pi-core.md PIC-006 承接）
> 状态：已确认

---

## Mock 能力前置

mock-bridge 需扩展（开发期实现）：

- `setSubagents(sessionId, list)`：设置会话子 agent 内存态种子
- `emit(sessionId, 'subagent.updated' | 'subagent.removed', payload)`：发射子 agent 事件
- `conversation/cancelStream` 种子：可配置是否伴随 subagent.updated(stopped) 事件序列

每条用例通用断言：无未声明 console error / pageerror；关键元素可见无重叠；结束无残留 streaming cursor。

---

## E-SA-001 主会话保持运行中（AC-SA-004）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **页面**：单视图会话
- **前置**：会话 A 空闲；种子子 agent 列表空
- **准备**：seedSendScript：delta（主 agent 文字）→ message（本轮完成）→ 不发 statusChanged done
- **操作**：
  1. 发送消息，等待主 agent 文字输出完毕（思考指示消失前不发 done）
  2. `emit('subagent.updated', { status: 'running', agentId: 'a1', description: '研究定价' })`
- **断言**：
  - UI：会话树 A 状态点保持"运行中"脉动；输入框处于可停止状态
  - 数据：未收到 done 前前端不显示完成态（无绿点/无完成 toast）
  - 健康：无 console error
- **失败证据**：screenshot + trace

## E-SA-002 计数归零自动完成（AC-SA-005）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：承接 E-SA-001 末态（a1 running，主轮已结束未 done）
- **操作**：`emit('subagent.updated', { agentId: 'a1', status: 'completed', finishedAt, result: '完成' })`
- **断言**：
  - UI：会话状态自动转"已完成"（状态点变绿/灰，无需用户操作）；Tab 中 a1 状态点变绿
  - 事件：前端收到 conversation.statusChanged done（由后端门控发出，mock 侧在子 agent 终态后补发）
  - 负向：done 前发送的第二条用户消息按运行中排队规则处理（沿用现状）

## E-SA-003 完成通知渲染与续跑（AC-SA-007）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：同 E-SA-002
- **操作**：子 agent 完成后 mock 侧以 `conversation.message` 推送完成通知消息（模拟扩展 followUp），再推送一段 assistant 续跑文字
- **断言**：
  - UI：通知消息在消息流渲染一次（不与子 agent Tab/result 重复显示为两条）；续跑文字正常流式追加
  - 负向：刷新历史后通知不重复（历史回显幂等）

## E-SA-004 Tab 栏出现与状态实时（AC-SA-008/010/001）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：会话 A 打开，Tab 栏不渲染
- **操作**：依次 emit a1 queued → running → completed；再 emit a2 running（两 Tab 并存）
- **断言**：
  - 首个事件到达后 Tab 栏出现（≤500ms 内状态点变化，用 expect 轮询）：结构 = 主会话 Tab + a1 Tab（状态点+描述名）
  - 状态点颜色/文案随事件变：黄(运行中)→绿(已完成)；a2 黄
  - 排序：运行中 a2 在前、终态 a1 在后
  - 健康：全程无 console error / pageerror

## E-SA-005 清除已完成与 Tab 关闭（AC-SA-011/015）

- **优先级**：P1 | **自动化**：mock-backend
- **前置**：承接 E-SA-004 末态（a1 completed、a2 running）
- **操作**：
  1. 检查 a1 Tab 关闭钮可用、a2 关闭钮禁用
  2. 关闭 a1 Tab → a1 消失（触发 subagent/clearFinished 单个语义或前端移除+removed 事件回放）
  3. 点"清除已完成"（先补一个 a3 completed）→ 终态全移除、a2 保留
  4. 激活 a2 结果视图后 emit `subagent.removed { agentIds: ['a2'] }`（模拟后端清除）→ 自动切回主会话
- **断言**：Tab 增删正确；消息流内容不受 Tab 操作影响；切换回主会话后滚动位置不强制重置（内容原样）

## E-SA-006 多窗口一致与隔离（AC-SA-012/021）

- **优先级**：P1 | **自动化**：mock-backend
- **前置**：会话 A、B 各开一个画布窗口；A 派生 a1、B 派生 b1
- **操作**：交错 emit A/B 的事件（A 完成、B 仍在跑）；切换窗口焦点往返
- **断言**：
  - 窗口 A：Tab 只含 a1（已完成），会话 A 状态已完成
  - 窗口 B：Tab 只含 b1（运行中），会话 B 状态运行中
  - 两窗口 Tab/状态互不串扰；行为与单视图一致（同一组件逻辑）
  - 健康：无跨窗口事件错误

## E-SA-007 结果视图（AC-SA-013/014/015）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：会话 A 有 a1（running，startedAt 已知）
- **操作**：
  1. 点 a1 Tab → 消息区切换结果视图
  2. 运行中观察 2 秒 → 点主会话 Tab → 再点回 a1 Tab
  3. emit a1 completed（result 全文 5000 字 + usage）→ 观察正文
- **断言**：
  - 结果视图头部：图标+描述名+类型徽标+状态文字+实时耗时（每秒递增）
  - 运行中正文为占位提示；完成后正文 = result 全文（无截断，内部滚动）+ Token 用量；耗时停止在总时长
  - 主会话 Tab 切回后消息流原样（消息条数不变、流式内容不丢）
  - 负向：result 为空时显示"无结果输出"占位

## E-SA-008 终止交互（AC-SA-016/017/019/020）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **前置**：会话 A 有 a1、a2（running）；mock cancelStream 配置为级联（随发 stopped 事件）
- **操作与断言**：
  1. **单个终止**：a1 结果视图点"终止"→ 二次确认弹窗出现；点"取消"→ 无变化（状态仍 running）；再点"确认"→ a1 状态点变灰"已终止"，a2 不受影响（仍 running）
  2. **停止级联**：点输入框停止按钮（无二次确认）→ a2 转"已终止"，会话 A 状态转"已完成"
  3. **幂等**：再次点击停止（此时已无活跃子 agent）→ 无报错、无重复终止调用
- **负向**：终止失败分支（mock 配置 RPC 报错）→ toast 报错、状态不变、可重试

## E-SA-009 回归基线：无/重启无子 agent（AC-SA-009/018/023）

- **优先级**：P0 | **门禁**：上线必过 | **自动化**：mock-backend
- **操作与断言**：
  1. 无子 agent 会话：Tab 栏不渲染；发送→流式→停止，行为与改造前一致（停止即 done，已生成内容保留）
  2. 历史含完成通知的会话重开（setHistory 含通知消息）：通知正常渲染、Tab 栏不出现（列表内存态为空）
  3. 页面健康：两场景无 console error / pageerror，无残留 streaming cursor
