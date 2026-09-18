# 项目管理 API

> 模块编号：01
> 来源：PRD 01（docs/prd/01_project_management.md）
> 状态：已确认（含扩展 PM-S05 git 分支查看与切换）
> 传输：Electron IPC（forge-ui -> forge-core）；headless 同契约（v2+）

---

## 1. 添加项目

```
project/addProject
```

**说明**：选择本地目录注册为项目。对应 PM-S01。

### 请求参数

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 目录绝对路径（未规范化原值） |

### 响应 data

```json
{
  "project": {
    "path": "D:/dev/my-app",
    "alias": "my-app",
    "createdAt": "2026-08-08T10:00:00Z",
    "lastOpenedAt": null,
    "trustState": "untrusted"
  }
}
```

| code | 说明 |
|------|------|
| 0 | 成功 |
| 1001 | 路径为空 / 非法路径 / 同路径已注册 |

---

## 2. 移除项目

### project/removeProject

**说明**：从 forge 列表移除项目注册，**级联删除该项目名下全部会话**（停运行 + 删 pi 会话文件 + 删 forge 会话记录，逐个发射 `session.removed`；v3.32 用户改判 TD-PM-05）；不删除源文件（PM-S03）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 项目规范化路径 |

响应：`data = { removedSessions: number }`（级联删除的会话数；幂等重复移除返回 `{ removedSessions: 0 }`）

错误码：1002（项目不存在）

---

## 3. 查询项目列表

### project/queryProjectList

**说明**：返回全部已注册项目。排序规则：拖拽钉扎（`priority`）升序优先，未钉扎项目按最近打开时间倒序排其后（PM-S01/列表页）。

请求参数：无。

响应：

```json
{
  "projects": [
    {
      "path": "C:/dev/a",
      "alias": "a",
      "createdAt": "...",
      "lastOpenedAt": "...",
      "trustState": "trusted",
      "priority": 0
    }
  ]
}
```

`priority`：手动排序优先级（拖拽钉扎），数字越小越靠前；`null`/缺省=未钉扎（按最近打开倒序）。

---

## 4. 重排项目（拖拽排序）

### project/reorderProjects

**说明**：项目拖拽排序后提交**全量新顺序**，为列表内每个项目写 `priority=index`（全部钉扎），一次落盘（PM-S01）。排序立即生效并持久化，打开项目不再影响已钉扎顺序。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| paths | string[] | 是 | 新的全量项目顺序（已注册的规范化路径列表，非空、每项非空白） |

响应：`data: null`。

| code | 说明 |
|------|------|
| 1001 | paths 非数组 / 为空 / 含非字符串 |
| 1002 | paths 中含未注册项目路径（不写盘） |

---

## 5. 打开项目

### project/openProject

**说明**：将项目设为当前项目、更新最近打开时间，并触发加载该项目会话列表（单模块）。若项目含 `.pi` 资源且未信任，**同步返回 `code=1005`** 并附带信任询问信息（`prompt`），前端据此渲染信任弹窗；用户决策后调 `project/setTrust` 回传 pi（PM-S02/S04）。**v1 信任询问的主路径是 openProject 同步返回 1005**；`project.trustRequested` 事件为预留，v1 不依赖。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 项目路径 |

### 响应

成功：

```json
{ "code": 0, "data": { "path": "C:/dev/a" } }
```

信任询问（code=1005）：

```json
{
  "code": 1005,
  "message": "项目含 .pi 资源，需确认信任",
  "data": { "path": "C:/dev/a", "prompt": { "reason": "project-extensions" } }
}
```

**事件**：打开项目后发射 `project.opened`；信任询问后若用户选择，前端调用 `project/setTrust` 回传。

---

## 6. 更新项目别名

### project/updateProjectAlias

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 项目路径 |
| alias | string | 是 | 新别名（非空） |

响应：`data` 为更新后的项目对象。

---

## 7. 设置项目信任

### project/setTrust

**说明**：回传信任询问弹窗的决策结果给 pi（PM-S04）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 项目路径 |
| decision | enum | 是 | `trust` / `reject` / `trustOnce` |

### 响应

`data: null`

| code | 说明 |
|------|------|
| 1005 | 决策结果回传 pi 失败 |

---

## 8. 事件

### project.trustRequested

**触发**：打开含 `.pi` 资源的未信任项目。

> 预留事件。v1 信任询问经 `project/openProject` 同步返回 `code=1005` 实现，前端从响应体取 `prompt` 渲染弹窗，不依赖本事件。本事件供后续异步信任场景（如运行中项目资源变更需重新信任）预留。

载荷：

```json
{
  "path": "C:/dev/a",
  "prompt": { "reason": "project-extensions", "detail": "..." }
}
```

### project.opened

**触发**：项目打开成功。

```json
{ "path": "C:/dev/a" }
```

### project.removed

**触发**：项目移除完成。

```json
{ "path": "C:/dev/a" }
```

### git.branchChanged（扩展 PM-S05）

**触发**：`git/switchBranch` 切换成功后广播（TD-PM-09）。所有打开该项目的窗口订阅后刷新分支徽标。

```json
{ "path": "C:/dev/a", "branch": "main" }
```

`branch`：切换后的当前分支名（detached 时为短 SHA）。非 git 项目不产生本事件。

---

## 9. 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误（路径非法/重复注册/分支名缺失） |
| 1002 | 项目不存在 |
| 1005 | 信任未授予（需弹窗确认） |
| 5000 | 内部错误 |
| 6001 | git 切换失败（data.stderr 附 git 原始错误，分支不变；扩展 PM-S05） |

---

## 10. 查询 git 分支信息（扩展 PM-S05）

### git/getBranchInfo

**说明**：实时查询项目 git 分支状态（TD-PM-07：不缓存不持久化）。对应 PRD PM-S05。窗口聚焦/打开项目时调用，徽标与浮窗数据同源。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 项目规范化路径 |

响应 data：

```json
{
  "isGitRepo": true,
  "branch": "main",
  "branches": ["main", "feat/login", "fix/dark-mode"],
  "dirty": false,
  "detached": false
}
```

| 字段 | 说明 |
|------|------|
| isGitRepo | 是否 git 仓库；false 时其余字段为空值，前端隐藏徽标 |
| branch | 当前分支名；detached 时为短 SHA；空仓库（unborn）为分支名 |
| branches | 本地分支列表（git 默认字典序）；不含远程分支 |
| dirty | 是否有未提交更改（git status 非空），供切换确认框使用 |
| detached | 是否 detached HEAD |

实现口径：`git -C <path> branch --format=%(refname:short)` + `git -C <path> status --porcelain`；项目目录为仓库子目录时自然取仓库根分支。

错误码：1001（path 缺失）、1002（项目未注册）。git 命令执行失败（如未安装 git）**不报错**，返回 `isGitRepo:false`。

---

## 11. 切换分支（扩展 PM-S05）

### git/switchBranch

**说明**：切换项目本地分支。采用 `git switch` 默认语义：远程存在同名分支而本地不存在时自动建跟踪分支（AC-PM-022）。成功后广播 `git.branchChanged`。流式禁用判定在前端（入口禁用不可达），本方法不做服务端流式守卫；未提交更改确认亦在前端（dirty 来自 getBranchInfo），本方法直接执行，git 自身拒绝时透传（TD-PM-08）。

请求参数：

| 参数名 | 类型 | 必填 | 说明 |
|--------|------|------|------|
| path | string | 是 | 项目规范化路径 |
| branch | string | 是 | 目标本地分支名（非空白） |

响应 data：

```json
{ "branch": "feat/login" }
```

| code | 说明 |
|------|------|
| 1001 | branch 缺失/非法 |
| 1002 | 项目未注册 |
| 6001 | git 切换失败（冲突/拒绝等）：`data.stderr` 为 git 原始错误输出，仓库分支保持不变 |
| 5000 | 内部错误 |

幂等：目标分支即当前分支时成功返回（git 无操作），不重复广播事件。