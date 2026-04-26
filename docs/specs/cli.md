# CLI 命令参考

## 概述

本文档定义 ClaudeTask CLI (`multica`) 的完整命令参考。

---

## 认证命令

### login

登录到 Multica 服务器。

```bash
multica login [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--token` | string | 否 | 直接指定 PAT Token |
| `--device-name` | string | 否 | 设备名称 |

**示例：**
```bash
# 交互式登录
multica login

# 指定 Token
multica login --token "mul_xxxxx"
```

### auth status

检查当前认证状态。

```bash
multica auth status
```

**示例：**
```bash
multica auth status
# 输出：Logged in as user@example.com (workspace: my-team)
```

### auth logout

登出并清除本地 Token。

```bash
multica auth logout
```

---

## Setup 命令

### setup cloud

配置 Cloud Runtime。

```bash
multica setup cloud [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--server` | string | 否 | 服务器地址，默认使用官方 Cloud |

**示例：**
```bash
multica setup cloud
```

### setup self-host

配置 Self-Host Runtime。

```bash
multica setup self-host [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--server` | string | 是 | 服务器地址 |

**示例：**
```bash
multica setup self-host --server "https://multica.example.com"
```

---

## Workspace 命令

### workspace list

列出当前用户的工作空间。

```bash
multica workspace list
```

### workspace get

获取工作空间详情。

```bash
multica workspace get [workspace] [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `workspace` | string | 否 | 工作空间 Slug，默认使用当前工作空间 |

**示例：**
```bash
multica workspace get my-team
```

### workspace members

列出工作空间成员。

```bash
multica workspace members [workspace] [flags]
```

---

## Issue 命令

### issue list

列出 Issues。

```bash
multica issue list [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--status` | string | 否 | 按状态筛选 |
| `--assignee` | string | 否 | 按 assignee 筛选 |
| `--labels` | string | 否 | 按标签筛选（逗号分隔） |

**示例：**
```bash
multica issue list --status in_progress
multica issue list --assignee @agent-1
```

### issue get

获取 Issue 详情。

```bash
multica issue get <issue-id> [flags]
```

**示例：**
```bash
multica issue get 42
```

### issue create

创建 Issue。

```bash
multica issue create [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--title` | string | 是 | Issue 标题 |
| `--description` | string | 否 | Issue 描述 |
| `--assignee` | string | 否 | 指派给（member 或 agent） |
| `--status` | string | 否 | 状态，默认 backlog |
| `--priority` | string | 否 | 优先级 |

**示例：**
```bash
multica issue create --title "实现登录功能" --assignee @alice
```

### issue update

更新 Issue。

```bash
multica issue update <issue-id> [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--title` | string | 否 | 新标题 |
| `--description` | string | 否 | 新描述 |
| `--status` | string | 否 | 新状态 |
| `--priority` | string | 否 | 新优先级 |

**示例：**
```bash
multica issue update 42 --status done
```

### issue assign

分配 Issue 给 Agent（会触发任务执行）。

```bash
multica issue assign <issue-id> --agent <agent-slug> [flags]
```

**示例：**
```bash
multica issue assign 42 --agent code-agent
```

### issue status

快速修改 Issue 状态。

```bash
multica issue status <issue-id> <status> [flags]
```

**示例：**
```bash
multica issue status 42 in_review
```

### issue search

搜索 Issues。

```bash
multica issue search <query> [flags]
```

**示例：**
```bash
multica issue search "登录"
```

### issue runs

查看 Issue 的执行历史。

```bash
multica issue runs <issue-id> [flags]
```

### issue rerun

重新执行 Issue。

```bash
multica issue rerun <issue-id> [flags]
```

---

## Issue 子命令

### issue comment

在 Issue 下添加评论。

```bash
multica issue comment <issue-id> [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--body` | string | 是 | 评论内容 |
| `--mentions` | string | 否 | @提及的对象 |

**示例：**
```bash
multica issue comment 42 --body "这个任务需要先完成 #38"
```

### issue subscriber

管理 Issue 订阅者。

```bash
multica issue subscriber <issue-id> [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--add` | string | 否 | 添加订阅者 |
| `--remove` | string | 否 | 移除订阅者 |

**示例：**
```bash
multica issue subscriber 42 --add @alice
```

---

## Project 命令

### project list

列出 Projects。

```bash
multica project list [flags]
```

### project get

获取 Project 详情。

```bash
multica project get <project-id> [flags]
```

### project create

创建 Project。

```bash
multica project create [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--name` | string | 是 | Project 名称 |
| `--slug` | string | 否 | Slug（自动生成） |

### project update

更新 Project。

```bash
multica project update <project-id> [flags]
```

### project delete

删除 Project。

```bash
multica project delete <project-id> [flags]
```

---

## Agent 命令

### agent list

列出 Agents。

```bash
multica agent list [flags]
```

**示例：**
```bash
multica agent list
# 输出：
# NAME          STATUS   RUNTIME MODE         MAX TASKS
# code-agent    idle     bypassPermissions    3
# review-agent  offline  default              1
```

### agent get

获取 Agent 详情。

```bash
multica agent get <agent-slug> [flags]
```

### agent create

创建 Agent。

```bash
multica agent create [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--name` | string | 是 | Agent 名称 |
| `--instructions` | string | 否 | 角色设定 |
| `--runtime-mode` | string | 否 | 权限模式 |
| `--max-tasks` | int | 否 | 最大并发任务数 |

**示例：**
```bash
multica agent create --name "code-agent" --instructions "你是一个 Go 专家"
```

### agent update

更新 Agent。

```bash
multica agent update <agent-slug> [flags]
```

### agent archive

归档 Agent。

```bash
multica agent archive <agent-slug> [flags]
```

### agent restore

恢复归档的 Agent。

```bash
multica agent restore <agent-slug> [flags]
```

### agent tasks

查看 Agent 的任务历史。

```bash
multica agent tasks <agent-slug> [flags]
```

---

## Agent 子命令

### agent skills

管理 Agent 的 Skills。

```bash
multica agent skills <agent-slug> [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--add` | string | 否 | 添加 Skill |
| `--remove` | string | 否 | 移除 Skill |
| `--list` | bool | 否 | 列出当前 Skills |

**示例：**
```bash
multica agent skills code-agent --add go-programming
```

---

## Skill 命令

### skill list

列出 Skills。

```bash
multica skill list [flags]
```

### skill get

获取 Skill 详情。

```bash
multica skill get <skill-name> [flags]
```

### skill create

创建 Skill。

```bash
multica skill create [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--name` | string | 是 | Skill 名称 |
| `--description` | string | 否 | 描述 |
| `--content` | string | 否 | Skill 内容（SKILL.md） |

**示例：**
```bash
multica skill create --name "go-programming" --description "Go 编程专家"
```

### skill update

更新 Skill。

```bash
multica skill update <skill-name> [flags]
```

### skill delete

删除 Skill。

```bash
multica skill delete <skill-name> [flags]
```

### skill import

导入 Skill。

```bash
multica skill import [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--from` | string | 是 | 来源（local/GitHub/ClawHub） |
| `--path` | string | 否 | 本地路径或 GitHub URL |

**示例：**
```bash
multica skill import --from local --path ~/skills/go-programming
```

---

## Skill 子命令

### skill files

管理 Skill 附件文件。

```bash
multica skill files <skill-name> [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--add` | string | 否 | 添加文件 |
| `--remove` | string | 否 | 移除文件 |
| `--list` | bool | 否 | 列出文件 |

---

## Routines 命令

> **注意**：CLI 命令名为 `autopilot`，文档中称为 Routines。

### autopilot list

列出 Routines。

```bash
multica autopilot list [flags]
```

### autopilot get

获取 Routine 详情。

```bash
multica autopilot get <routine-id> [flags]
```

### autopilot create

创建 Routine。

```bash
multica autopilot create [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--name` | string | 是 | Routine 名称 |
| `--agent` | string | 是 | 关联的 Agent |
| `--schedule` | string | 否 | Cron 表达式 |
| `--prompt` | string | 是 | 执行指令 |

**示例：**
```bash
multica autopilot create --name "daily-standup" --agent code-agent --schedule "0 9 * * 1-5" --prompt "生成每日站会报告"
```

### autopilot update

更新 Routine。

```bash
multica autopilot update <routine-id> [flags]
```

### autopilot delete

删除 Routine。

```bash
multica autopilot delete <routine-id> [flags]
```

### autopilot trigger

手动触发 Routine。

```bash
multica autopilot trigger <routine-id> [flags]
```

### autopilot runs

查看 Routine 执行历史。

```bash
multica autopilot runs <routine-id> [flags]
```

---

## Repo 命令

### repo checkout

克隆仓库到工作目录。

```bash
multica repo checkout <url> [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--path` | string | 否 | 本地路径 |

**示例：**
```bash
multica repo checkout https://github.com/user/repo --path ~/projects/repo
```

---

## Daemon 命令

### daemon install

安装 Daemon 为系统服务。

```bash
multica daemon install [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--name` | string | 否 | 服务名称 |

### daemon login

登录 Daemon（生成 Daemon Token）。

```bash
multica daemon login [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--server` | string | 是 | 服务器地址 |
| `--token` | string | 否 | 直接指定 Daemon Token |

**示例：**
```bash
multica daemon login --server "https://multica.example.com"
```

### daemon start

启动 Daemon。

```bash
multica daemon start [flags]
```

**示例：**
```bash
multica daemon start
```

### daemon stop

停止 Daemon。

```bash
multica daemon stop [flags]
```

### daemon status

查看 Daemon 状态。

```bash
multica daemon status
```

**输出示例：**
```
Daemon: running
Runtime: cloud
Last heartbeat: 10 seconds ago
Active tasks: 2
```

### daemon logs

查看 Daemon 日志。

```bash
multica daemon logs [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--lines` | int | 否 | 显示行数，默认 50 |
| `--follow` | bool | 否 | 实时跟踪 |

---

## Runtime 命令

### runtime list

列出 Runtimes。

```bash
multica runtime list [flags]
```

### runtime usage

查看 Runtime 使用统计。

```bash
multica runtime usage [runtime-id] [flags]
```

### runtime activity

查看 Runtime 活动记录。

```bash
multica runtime activity [runtime-id] [flags]
```

### runtime ping

Ping Runtime。

```bash
multica runtime ping <runtime-id> [flags]
```

### runtime update

更新 Runtime。

```bash
multica runtime update <runtime-id> [flags]
```

---

## 通用命令

### config

查看/修改配置。

```bash
multica config [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--get` | string | 否 | 获取配置项 |
| `--set` | string | 否 | 设置配置项 |

**示例：**
```bash
multica config --get server
multica config --set server "https://multica.example.com"
```

### version

查看版本信息。

```bash
multica version
```

### update

检查并更新 CLI。

```bash
multica update [flags]
```

### attachment download

下载附件。

```bash
multica attachment download <attachment-id> [flags]
```

**参数：**

| 参数 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `--path` | string | 否 | 保存路径 |

---

## 全局 flags

| flag | 说明 |
|------|------|
| `--workspace` | 指定工作空间 Slug |
| `--output` | 输出格式 (`table` / `json` / `yaml`) |
| `--no-color` | 禁用彩色输出 |
| `--quiet` | 静默模式 |
| `--debug` | 调试模式 |

---

## 退出码

| 退出码 | 说明 |
|--------|------|
| 0 | 成功 |
| 1 | 通用错误 |
| 2 | 认证错误 |
| 3 | 权限错误 |
| 4 | 资源不存在 |
| 5 | 网络错误 |
| 6 | 参数错误 |
