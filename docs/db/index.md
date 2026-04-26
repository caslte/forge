# 数据库设计

## 概述

ClaudeTask 使用 PostgreSQL 数据库存储所有业务数据。本目录包含各模块的数据库表设计。

## 表清单

| 编号 | 模块 | 表名 | 说明 |
|------|------|------|------|
| 01 | 工作空间 | workspace | 工作空间配置，包含仓库配置 |
| 02 | 助手配置 | agent, agent_skill | AI 助手及技能关联 |
| 03 | 技能管理 | skill, skill_file | 技能定义及附件 |
| 04 | 任务管理 | issue, issue_dependency | 任务及依赖关系 |
| 05 | 任务执行 | agent_task_queue, task_message | 任务队列及执行消息 |
| 06 | 对话功能 | chat_session, chat_message | 对话会话及消息 |
| 07 | Daemon | runtime | Daemon 注册及心跳 |

## ER 图

```
┌─────────────┐       ┌─────────────┐       ┌─────────────┐
│  workspace  │       │    agent    │       │    skill   │
├─────────────┤       ├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │       │ id (PK)     │
│ name        │       │ name        │       │ name        │
│ repos (JSONB)│       │ instructions│       │ description │
│ created_at  │       │ status      │       │ content     │
│ updated_at  │       │ runtime_mode │       │ created_at  │
└─────────────┘       └──────┬──────┘       └──────┬──────┘
                             │                      │
                      ┌──────┴──────┐       ┌──────┴──────┐
                      │ agent_skill │       │ skill_file   │
                      ├─────────────┤       ├─────────────┤
                      │ agent_id (FK)│       │ skill_id (FK)│
                      │ skill_id (FK)│       │ path         │
                      │ position     │       │ content      │
                      └─────────────┘       └─────────────┘
                             │
                             │
┌─────────────┐       ┌──────┴──────┐       ┌─────────────┐
│   runtime   │       │    issue    │       │chat_session │
├─────────────┤       ├─────────────┤       ├─────────────┤
│ id (PK)     │       │ id (PK)     │       │ id (PK)     │
│ daemon_id    │       │ workspace_id│       │ agent_id (FK)│
│ device_name  │       │ title       │       │ creator_id  │
│ status       │       │ status      │       │ title       │
│ last_heartbeat│     │ priority    │       │ status      │
└─────────────┘       │ assignee_*  │       │ session_id  │
                      └──────┬──────┘       └─────────────┘
                             │
                      ┌──────┴──────┐       ┌─────────────┐
                      │issue_dependency│     │chat_message │
                      ├─────────────┤       ├─────────────┤
                      │ issue_id (FK)│       │session_id(FK)│
                      │depends_on_* │       │ role        │
                      │ type        │       │ content     │
                      └─────────────┘       └─────────────┘
                             │
                      ┌──────┴──────┐
                      │agent_task_queue│
                      ├─────────────┤
                      │ id (PK)     │
                      │ agent_id (FK)│
                      │ runtime_id(FK)│
                      │ issue_id (FK)│
                      │ status      │
                      │ priority    │
                      └─────────────┘
                             │
                      ┌──────┴──────┐
                      │ task_message │
                      ├─────────────┤
                      │ id (PK)     │
                      │ task_id (FK) │
                      │ type        │
                      │ content     │
                      │ tool        │
                      │ call_id     │
                      └─────────────┘
```

## 索引设计

### 任务查询索引
- `idx_issue_workspace` ON issue(workspace_id)
- `idx_issue_assignee` ON issue(assignee_type, assignee_id)
- `idx_issue_status` ON issue(workspace_id, status)
- `idx_issue_priority` ON issue(workspace_id, priority)

### 助手查询索引
- `idx_agent_status` ON agent(status)

### 技能查询索引
- `idx_skill_name` ON skill(name) UNIQUE

### 任务队列索引
- `idx_task_queue_agent` ON agent_task_queue(agent_id)
- `idx_task_queue_status` ON agent_task_queue(status)
- `idx_task_queue_priority` ON agent_task_queue(agent_id, status, priority)

### 对话查询索引
- `idx_chat_session_creator` ON chat_session(creator_id)
- `idx_chat_session_status` ON chat_session(creator_id, status)
- `idx_chat_message_session` ON chat_message(chat_session_id)

## 命名规范

- 表名：snake_case（如 `issue`）
- 字段名：snake_case（如 `issue_id`）
- 主键：统一使用 `id` (UUID)
- 外键：`<表名>_id` 格式
- 时间字段：`created_at`, `updated_at` (TIMESTAMPTZ)
- JSONB 字段：存储复杂结构（如 `repos`）

## 版本历史

| 版本 | 日期 | 变更 |
|------|------|------|
| v1.0.0 | 2026-04-26 | 初始版本 |
