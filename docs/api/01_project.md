# 项目管理 API

> 模块编号：01
> 来源：PRD 01（docs/prd/01_project_management.md）
> 状态：已确认
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

---

## 9. 错误码

| code | 说明 |
|------|------|
| 1001 | 参数错误（路径非法/重复注册） |
| 1002 | 项目不存在 |
| 1005 | 信任未授予（需弹窗确认） |
| 5000 | 内部错误 |