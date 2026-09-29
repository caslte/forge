# 版本更新与安装包 e2e 设计

> 模块：07 版本更新与安装包
> 来源：`coverage-matrix.md` + PRD 07（IN-S03 自更新 UI 交互；预装/联动为后台静默，仅反向断言「无提示出现」）
> 状态：已实现（forge-ui/e2e/updater.spec.ts E-IN-001~006）；2026-09 「侧栏更新入口」改造后口径已同步本文件
> 自动化等级：mock-backend（mock-bridge seed updater/* + emit updater.stateChanged）

## 改造口径（2026-09，侧栏更新入口）

- 发现新版**不再弹 toast**；提示职责移交侧栏图标入口（`UpdateEntry.vue`，紧跟「设置」，仅更新相关时出现）。
- 进入关于 Tab**不再自动检查**；检查仅由「检查更新」按钮手动触发（启动自动检查仍在主进程）。
- 关于页版本更新分区保留，为同一全局状态的**镜像**（`useUpdater` 模块级单例）。
- 侧栏入口形态：found=方块下载图标（hover 展开「新版本」）；downloading=进度环（无文字）；ready=圆形刷新图标（hover 展开「更新」，点击弹独立安装确认框）；installing=转圈。

---

## 通用断言（每条必含）

- mock 经 `window.__forgeMock.seed('updater/…', handler)` 覆盖方法、`emit('updater.stateChanged', payload)` 驱动状态迁移。
- `updater/getState` 读页面内持久快照 `window.__forgeUpSnap`（模拟主进程状态机持久化；设置面板重挂载不丢态）。
- 页面健康：无 console error / pageerror（attachHealthGuards）。
- 全程不出现「组件/插件」字样的自更新文案（明面只有 forge 产品更新语义，PRD 07 §1.4）。

---

## E-IN-001 发现新版：侧栏图标入口 + 关于页镜像，无 toast（AC-IN-008 改造后）

- **前置**：`updater/getState` 初始 idle；seed `updater/checkForUpdates` → 写入快照 `found, latestVersion:'0.2.0'` 并返回
- **动作**：打开设置页关于分区（**不触发检查**）→ 点「检查更新」
- **预期**：检查前侧栏无 `.up-entry`、分区无版本提示；检查后侧栏出现 `data-mode:'found'` 图标入口，分区「0.1.0 → v0.2.0」+「更新」按钮镜像；全程 toast 计数 0
- **hover 展开**：`.up-txt` 默认收起（不可见），hover 展开「新版本」，移开收起
- **重开设置**：无重复提示，入口与镜像保持（全局状态）
- **反向**：见 E-IN-004（idle 无新版 → 无入口、无按钮态变化）

## E-IN-002 手动更新：下载进度（侧栏环）→ 双确认弹窗 → 重启安装（AC-IN-009 的 UI 部分）

- **前置**：初始 idle；seed check → found、`updater/downloadUpdate` → downloading、`updater/quitAndInstall` 捕获调用标记
- **动作**：点「检查更新」→ 点「更新」→ emit downloading(60) → emit downloaded
- **预期**：分区进度条百分比；侧栏入口切 `data-mode:'downloading'`（禁用、无文字、进度环 dashoffset 随 60% 收缩）；downloaded 后分区出现「重启安装」，侧栏切 `ready`（hover 展开「更新」）
- **确认弹窗（双路径）**：关于页「重启安装」弹 `.up-confirm`（含新版本号与「自动重启」说明）→ 取消停留、不触发安装；侧栏入口点击弹独立 `.up-entry-confirm` → 确认 → seed 捕获 `updater/quitAndInstall` 调用（真机重启行为走 manual）

## E-IN-003 检查失败静默（AC-IN-011）

- **前置**：seed `updater/checkForUpdates` 返回 6003
- **动作**：打开关于分区 → 点「检查更新」
- **预期**：无 toast、无错误弹窗、侧栏无入口；「检查更新」按钮保持可用（可重试）；无 console error（静默降级）

## E-IN-004 无新版反向 + 预装/联动更新全程无 UI（AC-IN-008/004/012 的反向断言）

- **前置**：seed `updater/checkForUpdates` 返回 idle 且 `latestVersion:null`
- **动作**：打开关于分区（此时无「已是最新」徽标——不再自动检查）→ 点「检查更新」
- **预期**：出现「✓ 已是最新」徽标、按钮保持「检查更新」；无 toast、无「发现新版本」、侧栏无 `.up-entry`、无确认弹窗；分区全程无「组件/插件」字样（后台预装/联动对用户不可见）

## E-IN-005 调试控制台（配置开启可见）

- **前置**：seed `app/getUpdateDebug` → enabled；seed check 返回 6003「更新源未配置」
- **动作**：打开关于分区 → 点「检查更新」制造失败日志 → 展开调试控制台
- **预期**：`.up-debug` 可见但控制台默认收起；展开后含版本/快照行与滚动日志（`checkForUpdates` 调用与 6003 失败原因入日志——静默不等于无日志）

## E-IN-006 调试控制台默认隐藏

- **前置**：seed `app/getUpdateDebug` → enabled:false（未配置 updater-debug.json）
- **预期**：`.up-debug`/`.up-debug-toggle` 均不存在（普通用户无调试入口）

## 重启安装与真机部分

- `updater/quitAndInstall` 成功路径（应用退出重启）为 **manual**（发布前 checklist 见 coverage-matrix.md），e2e 只断言按钮出现与点击调用（seed 捕获调用参数）。
