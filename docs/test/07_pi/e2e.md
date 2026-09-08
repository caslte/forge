# 版本更新与安装包 e2e 设计

> 模块：07 版本更新与安装包
> 来源：`coverage-matrix.md` + PRD 07（IN-S03 自更新 UI 交互；预装/联动为后台静默，仅反向断言「无提示出现」）
> 状态：已确认（待开发部分，实现时按本文件落地 forge-ui/e2e/updater.spec.ts）
> 自动化等级：mock-backend（mock-bridge seed updater/* + emit updater.stateChanged）

---

## 通用断言（每条必含）

- mock 经 `window.__forgeMock.seed('updater/…', handler)` 覆盖方法、`emit('updater.stateChanged', payload)` 驱动状态迁移。
- 页面健康：无 console error / pageerror（attachHealthGuards）。
- 全程不出现「组件/插件」字样的自更新文案（明面只有 forge 产品更新语义，PRD 07 §1.4）。

---

## E-IN-001 发现新版：toast 一次 + 分区常驻（AC-IN-008）

- **前置**：seed `updater/getState` → `{ status:'found', latestVersion:'0.2.0', … }`；打开设置页版本更新分区
- **动作**：触发检查（分区打开自动触发）
- **预期**：分区出现「发现新版本 0.2.0」与「更新」按钮常驻；发现瞬间 toast 提示一次（同版本重复打开设置不重复 toast）
- **反向**：seed `status:'idle', latestVersion:null` → 无提示、无「更新」按钮

## E-IN-002 手动更新：下载进度 → 确认弹窗 → 重启安装（AC-IN-009 的 UI 部分）

- **前置**：seed `status:'found'`；点击「更新」→ seed `updater/downloadUpdate` 返回 `status:'downloading'`
- **动作**：依次 emit `updater.stateChanged`：downloading(30) → downloading(80) → downloaded
- **预期**：分区内展示下载百分比；downloaded 后出现「重启安装」按钮
- **确认弹窗**：点击「重启安装」→ 弹确认框（含新版本号与「关闭应用并安装更新，完成后自动重启」说明）→ 取消则停留；确认 → seed 捕获 `updater/quitAndInstall` 调用参数（真机重启行为走 manual）
- **反向**：seed `updater/downloadUpdate` 返回 6004 → 分区回「发现新版本 + 更新」可重试态，无打断弹窗

## E-IN-003 检查失败静默（AC-IN-011）

- **前置**：seed `updater/checkForUpdates` 返回 6003
- **动作**：打开设置页分区
- **预期**：无 toast、无错误弹窗、分区保持当前版本展示；无 console error（静默降级）

## E-IN-004 预装/联动更新全程无 UI（AC-IN-004/012 的反向断言）

- **前置**：mock 端模拟首启（updater-state 标志为初始值）与版本变化场景；seed `pi/updatePlugins` 成功
- **动作**：启动应用 / 模拟版本变化启动
- **预期**：更新在后台执行成功，**全程无任何 toast/提示/文案出现**（预装与联动对用户不可见）；设置页组件清单事后可查到最新版本

## 重启安装与真机部分

- `updater/quitAndInstall` 成功路径（应用退出重启）为 **manual**（发布前 checklist 见 coverage-matrix.md），e2e 只断言按钮出现与点击调用（seed 捕获调用参数）。
