# pi 真实接入开发进度

> 更新时间：2026-08-24  
> 范围：P0 真实 pi 会话与对话闭环  
> 结论：P0 完成约 35%，已具备 pi 适配层与会话工厂基础，但 UI 到真实对话的端到端链路尚未打通。

## 已完成

| 项目 | 状态 | 说明 |
|---|---|---|
| 安装 pi SDK | 已完成 | `@earendil-works/pi-coding-agent@0.84.3` |
| 对话事件适配器 | 已完成 | 新增 `PiConversationAdapter`，映射 `message_update` 增量、`message_end` 助手消息、取消 `abort()` |
| 取消保留文本 | 已完成 | 当前增量文本保留在适配器内存中，可查询 |
| pi 会话工厂 | 已完成 | 新增 `createPiAgentSessionFactory`，按项目 cwd 创建或恢复 pi session 文件 |
| session ID 映射 | 已完成 | forge session ID 映射为 `forge-<forgeSessionId>` 的 pi session 文件 ID |
| 桌面内核接线 | 已完成 | `createForgeCore` 默认使用真实 pi 工厂；测试可注入 mock 工厂隔离 |
| 回归验证 | 已完成 | desktop 构建通过；17 / 17 个 desktop 测试通过 |

相关实现：

- `packages/forge-desktop/src/pi/piConversationAdapter.ts`
- `packages/forge-desktop/src/pi/createPiAgentSessionFactory.ts`
- `packages/forge-desktop/src/createForgeCore.ts`
- `packages/forge-desktop/test/pi/piConversationAdapter.test.ts`
- `packages/forge-desktop/test/pi/createPiAgentSessionFactory.test.ts`

## 未完成

| 编号 | 工作项 | 当前状态 | 阻塞点 | 优先级 |
|---|---|---|---|---|
| P0-A | Session 创建接线 | 未开始 | UI 新建会话仍走 `MockPiSessionAdapter`，生成 `mock-session-*` | P0 |
| P0-B | 对话状态与消息闭环 | 未开始 | pi 发送前后未稳定驱动 `streaming/done/error` 和完整消息事件 | P0 |
| P0-C | 历史读取接 pi JSONL | 未开始 | `loadHistory()` 只返回内存中的当前助手消息，未读取持久化历史 | P0 |
| P0-D | 模型选择传入 pi runtime | 未开始 | 全局默认与会话覆盖仍是 forge 元数据，未映射为 pi 可用模型 | P0 |

## 关键风险

1. **无凭据时的用户反馈不足**：pi 在发送阶段会抛出模型 API key 缺失错误，UI 目前只能显示原始异常文本。
2. **历史解析尚未实现**：当前只验证了 pi session 文件的创建和恢复，没有把 user / assistant / tool entry 转换为前端消息。
3. **模型对象转换缺失**：forge 存的是模型字符串 ID，pi runtime 需要 provider/model 对象；不能直接透传。
4. **多会话并发状态未验收**：工厂支持创建多个 session，但真实并发下的状态隔离还需要集成测试确认。
