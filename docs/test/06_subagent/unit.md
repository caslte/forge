# 子 Agent 管理 单元测试设计

> 模块：06 子 Agent 管理
> 关联：coverage-matrix.md；来源 PRD 06 / API 06
> 测试对象：forge-core 子 agent 注册表（事件归组/幂等合并/状态门控/超时兜底/级联终止/会话清理）
> 状态：已确认

---

## U-SA-001 子 agent 记录幂等合并（AC-SA-001/002）

- **关联 AC**：AC-SA-001、AC-SA-002 | **风险维度**：状态流转/幂等 | **优先级**：P0
- **测试对象**：子 agent 注册表 upsert 逻辑
- **前置条件**：注册表空；注入 mock 事件源
- **输入**：同一 agentId 的事件序列变体：
  1. 顺序正常：created → started → completed
  2. 乱序：completed 先于 started 到达
  3. 重复：completed 发两次
- **操作**：依次喂入事件，每步检查注册表
- **预期结果**：
  1. 单条记录，状态收敛 completed，字段（type/description/startedAt/finishedAt/result/usage）为后到有效值
  2. 乱序时按最终状态收敛（completed），不因缺 started 崩溃或丢记录
  3. 重复事件无新增记录、字段不回退（finishedAt/result 一经设置不变）
- **断言点**：记录数恒为 1；状态机单向；字段只增不改
- **负向断言**：终态后再到 started 不回退为 running；未知 agentId 事件不污染其他记录
- **边界补充**：description/result 为空串按缺失处理；usage 缺省不报错

## U-SA-002 终态语义（AC-SA-003）

- **关联 AC**：AC-SA-003 | **风险维度**：状态流转 | **优先级**：P0
- **前置条件**：注册表含一条 running 记录
- **输入**：分别喂入 failed（error="boom"）与 stopped（reason="user"）事件
- **操作**：检查记录状态与字段
- **预期结果**：状态分别为 failed/stopped；error/reason 字段落位；status 恒不为 completed；isTerminal() 判定为真
- **负向断言**：failed/stopped 记录不携带 result（或为 null）；活跃计数（queued+running）随之递减

## U-SA-003 主会话 done 门控（AC-SA-004/005）

- **关联 AC**：AC-SA-004、AC-SA-005 | **风险维度**：状态流转/跨模块 | **优先级**：P0
- **测试对象**：完成判定器（主 agent 本轮结束 × 活跃计数）
- **前置条件**：会话 X 注册表有 1 个 running 子 agent；注入 mock 主轮结束信号
- **操作与预期**：
  1. 主轮结束信号到达、计数=1 → **不**发出 done，会话保持 running
  2. 随后子 agent completed → 计数=0 → 发出 done（恰好一次）
  3. 反向序列：子 agent 先 completed → 主轮结束后立即 done（无延迟计时器残留）
  4. 两个子 agent 先后完成 → done 仅在第二个完成时发出一次
- **断言点**：done 发出时机与次数；running 状态持续；子 agent 文字消息推送不受门控影响（消息事件照常透传）
- **负向断言**：计数>0 时任何信号组合都不得发出 done；done 不重复发

## U-SA-004 超时兜底（AC-SA-006）

- **关联 AC**：AC-SA-006 | **风险维度**：异常失败/可用性 | **优先级**：P0
- **前置条件**：计数=1（running）；时钟可注入（fake timers）
- **操作**：
  1. 主轮结束后推进虚拟时钟 29 分钟（期间无子 agent 事件）→ 仍为 running
  2. 推进至 30 分钟整 → done 发出，兜底日志写入
  3. 对照组：第 20 分钟喂入一次任意子 agent 事件 → 计时器重置，30 分钟窗口重新起算
- **预期结果**：超时恰好触发一次；触发后即使迟到的 completed 事件到达也不再改变会话状态（子 agent 记录本身照常更新）
- **负向断言**：兜底后活跃子 agent 若真实仍在跑，其后续完成事件不得把会话拉回 running
- **边界补充**：兜底触发顺序在多子 agent 下与单个一致（计数不清零也放行）

## U-SA-005 级联终止编排（AC-SA-016/017）

- **关联 AC**：AC-SA-016、AC-SA-017 | **风险维度**：状态流转/幂等/异常失败 | **优先级**：P0
- **测试对象**：cancelStream 级联编排器
- **前置条件**：会话 X 有子 agent a（running）、b（queued）、c（completed）
- **操作与预期**：
  1. 触发级联 → 终止调用恰好覆盖 a、b（每个一次），c 不被调用
  2. a、b 事件置 stopped，活跃计数归零 → done 发出
  3. 重复触发级联 → 零次新增终止调用（幂等）
  4. 失败分支：a 的终止 RPC 首次抛错 → 自动重试一次成功；持续失败 → 记日志、b/c 处理不中断、done 仍按剩余计数规则发出（a 保留原状态）
- **断言点**：终止调用集合与次数；重试恰一次；部分失败不阻塞
- **负向断言**：级联不触碰终态记录；主轮 abort 失败不阻止子 agent 终止

## U-SA-006 按会话隔离（AC-SA-021）

- **关联 AC**：AC-SA-021 | **风险维度**：并发隔离 | **优先级**：P0
- **前置条件**：会话 A、B 同时存在
- **操作**：A 派生 a1、B 派生 b1；各自完成/终止交错发生
- **预期结果**：queryList(A) 只含 a1，queryList(B) 只含 b1；A 的事件不改变 B 计数；A 计数归零只发 A 的 done
- **负向断言**：不存在跨会话字段泄漏（B 记录不得出现在 A 列表）

## U-SA-007 会话删除清理（AC-SA-022）

- **关联 AC**：AC-SA-022 | **风险维度**：资源生命周期 | **优先级**：P1
- **前置条件**：会话 X 有 running 子 agent，事件订阅活跃
- **操作**：删除会话 X → 随后喂入 X 的子 agent 完成事件
- **预期结果**：内存态清空、事件监听移除；迟到事件被丢弃不报错、不重建记录
- **负向断言**：清理后注册表无 X 残留键；重复删除幂等
