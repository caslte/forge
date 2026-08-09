# DB 设计索引

> 按模块快速定位数据库设计。只维护目录与状态，详细结构写各模块 schema。

## 说明

forge 是 Electron 桌面应用，**无 MySQL / ClickHouse 等传统数据库**。数据存储分三层，schema 文档只覆盖 forge 自有存储层：

| 层 | 归属 | 介质 | 内容 | 设计文档 |
|---|---|---|---|---|
| forge 自有存储 | forge | JSON 文件（forge-desktop 传入的 userData 路径） | 项目元数据、会话元数据缓存、全局默认模型 | [db/forge-store/schema.md](forge-store/schema.md) |
| pi 会话存储 | pi | JSONL（`~/.pi/agent/sessions`） | 会话与消息原始数据 | 只读对接，不设计为 forge 表 |
| pi 配置与密钥 | pi | models.json + OS keychain | provider 配置、API key | forge 读写对接，不设计为 forge 表 |

## 模块清单

| 编号 | 存储域 | 路径 | 状态 | 对应 PRD |
|---|---|---|---|---|
| forge-store | forge 自有存储 | db/forge-store/schema.md | 规划中 | 01/02/05 |

## 更新规则

- 每张"表"必须有主键与用途说明，关联关系要清晰。
- PRD 变更时同步更新 schema 与 `docs/changelog.md`。