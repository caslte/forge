# 更新体系自有存储设计（updater-state）

> 模块编号：07_installer（版本更新与安装包）
> 状态：已确认（PRD 07 已确认，本设计随确认通过）
> 存储介质：本地 JSON 单文件 `updater-state.json`（路径在 userData 目录，由 forge-desktop 主进程传入；**不经 forge-core**——更新体系属 Electron 壳层职责）

---

## 0. 设计前提与边界

- 刻意**不放入 forge-store.json**：forge-store 是项目组织层存储（项目/会话/模型偏好），更新体系的状态与其无业务关联，独立文件避免 schemaVersion 迁移耦合（用户拍板：独立 updater-state）。
- **不存**：pi/共享组件的任何数据（forge 专属 agent 目录 `<userData>/agent` 归引擎侧文件形态管理）；安装包本体（下载缓存由 electron-updater 自管）。
- 单文件原子写（临时文件 + rename），与 forge-store 同一策略；文件损坏/缺失时按全默认值重建（降级为重新预装/重新触发联动，均幂等安全）。
- 单写者：仅 forge-desktop 主进程更新流程读写，无并发写者。

---

## 文档：updaterState（单例结构）

| 字段名 | 类型 | 可空 | 默认值 | 用途 |
|--------|------|------|--------|------|
| schemaVersion | number | 否 | 1 | 结构版本，向后迁移用 |
| lastRunForgeVersion | string | 是 | null | 上次运行时记录的 forge 版本；null = 首次运行。启动时与当前版本不等 → 触发组件联动更新（AC-IN-012）并回写 |
| preinstallDone | boolean | 否 | false | 推荐组件预装是否已执行完成（AC-IN-006 幂等标志）；失败保持 false，下次启动重试 |
| preinstallDoneAt | string(ISO8601) | 是 | null | 预装完成时间（观测用，无业务判断依赖） |
| lastUpdateCheckAt | string(ISO8601) | 是 | null | 最近一次检查应用更新时间（观测用；检查时机=启动+分区打开/手动，不做硬节流） |
| components | object | 否 | {} | 组件版本快照：`{ "包名": "版本", … }`。每次组件更新成功后（手动/预装/联动）整体刷新；用于变更明细日志的「旧版本 → 新版本」差值与「只升不降」判别参考（原型确认 2026-09-08） |

- 主键：单例文档，无主键概念
- 索引：无
- 关联：无（自包含）
- seed 数据（首次创建时写入）：`{ "schemaVersion": 1, "lastRunForgeVersion": null, "preinstallDone": false, "preinstallDoneAt": null, "lastUpdateCheckAt": null, "components": {} }`
- 状态：已确认

### 设计说明

- `lastRunForgeVersion` 与 `preinstallDone` 是仅有的两个**业务判断**字段：
  - 联动更新判定：`lastRunForgeVersion !== 当前版本` → 后台静默组件更新 → 成功后回写当前版本；失败保留旧值下次重试（AC-IN-012/013）。
  - 预装判定：`preinstallDone === false` 且首次启动 → 后台静默补缺 → 成功置 true；失败保持 false（AC-IN-004/006/007）。
- 首次运行（`lastRunForgeVersion === null`）：同时满足预装触发；联动更新首次不触发（无「版本变化」语义），仅回写版本。
- 刻意不存：更新包下载路径/进度（electron-updater 内存态）、用户跳过的版本（v1 无跳过功能，每次有新版都提示）。
- 卸载重装：userData 保留则标志仍在（不重复预装，符合 PRD）；用户手动清 userData 则视为全新安装（重新预装，幂等安全）。

---

## 与其他存储的边界

| 数据 | 归属 | 介质 | 行为 |
|---|---|---|---|
| 联动/预装标志、检查时间 | forge（本文件） | updater-state.json | 读写 |
| 项目/会话/模型偏好 | forge | forge-store.json | 不涉及 |
| 共享组件清单与实体 | forge 引擎侧 | `<userData>/agent/settings.json` + `npm/` | 经模块 07 更新器读写（见 api/07_pi.md） |
| 更新包下载缓存 | electron-updater | 其自管目录 | 不设计、不干预 |
