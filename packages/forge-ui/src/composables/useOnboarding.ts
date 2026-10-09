/**
 * 首次使用指引（蒙层聚光灯）状态（模块级单例，对齐 useWhatsNew/useToast 套路）。
 *
 * 触发口径（2026-10-09 拍板）：**只有全新安装首启**自动起一次，升级与平运行都不弹。
 * 判定在主进程启动同步段（packages/forge-desktop/src/startupFlags.ts）——渲染层自己判不了：
 * core 组装后的更新联动会把 updater-state.json 的 lastRunForgeVersion 改写为当前版本。
 *
 * 「看过」的持久化走 localStorage['forge:onboarding:seen:v1']：自动起的那一刻就落盘，
 * 所以中途崩溃/强退也不会第二次再来一遍。设置「关于」Tab 的「重看使用指引」不受该标志
 * 约束（openTour 直接置 visible），这是它存在的意义。
 */
import { ref } from 'vue';
import { getStartupFlags } from '../bridge.ts';

const SEEN_KEY = 'forge:onboarding:seen:v1';

const visible = ref(false);

function markSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, '1');
  } catch {
    /* 隐私模式/存储被禁：本次运行仍只起一次（模块级标志在下面兜），不重试 */
  }
}

function hasSeen(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

/** 本次运行是否已经拉起过（存储写不进时的第二道闸，防同一会话反复自动弹） */
let startedThisRun = false;

/** 自动起（App.vue 在 veil 淡出后调用一次）：非新装直接记为已看过，省掉以后每次启动的询问 */
async function autoStart(): Promise<void> {
  if (visible.value || startedThisRun || hasSeen()) return;
  let fresh: boolean;
  try {
    fresh = (await getStartupFlags()).isFreshInstall;
  } catch {
    // 拿不到结论（老版主进程没这条 handler）就宁可不弹——指引是加分项，不许挡启动
    return;
  }
  startedThisRun = true;
  if (!fresh) {
    markSeen();
    return;
  }
  markSeen();
  visible.value = true;
}

/** 手动起（设置 → 关于 → 重看使用指引）：不看 seen 标志 */
function openTour(): void {
  visible.value = true;
}

function closeTour(): void {
  visible.value = false;
}

export function useOnboarding() {
  return { visible, autoStart, openTour, closeTour };
}
