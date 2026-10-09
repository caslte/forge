/**
 * 启动特征判定（首次使用指引 / 版本更新说明共用的单一事实源）。
 *
 * 输入只有 updater-state.json 里的 `lastRunForgeVersion` 与当前包版本，两个布尔值互斥：
 * - `null` → 从没运行过 = 全新安装首启
 * - 有值且 ≠ 当前版本 → 升级后首启
 * - 有值且 = 当前版本 → 平运行
 *
 * 设计为**纯函数**：判定必须在主进程 `app.whenReady()` 的同步段做（startupUpdate 会异步
 * 把 lastRunForgeVersion 改写为当前版本，晚一步就分不出「新装」「升级」「平运行」），
 * 抽出纯函数后这一步可以被单测直接覆盖，不必起 Electron。
 *
 * 已知口径：状态文件缺失与损坏在 readUpdaterState 里都归一为全默认值（lastRunForgeVersion
 * = null），因此「用户手动删过 updater-state.json」会被判成新装、重看一次指引。这是刻意
 * 接受的降级——指引不阻塞任何操作，比多写一层损坏识别更划算。
 */
import type { StartupFlags } from './ipc-contract.ts';

export function resolveStartupFlags(
  lastRunForgeVersion: string | null,
  appVersion: string,
): StartupFlags {
  const isFreshInstall = lastRunForgeVersion === null;
  return {
    isFreshInstall,
    isUpgradeRun: !isFreshInstall && lastRunForgeVersion !== appVersion,
  };
}
