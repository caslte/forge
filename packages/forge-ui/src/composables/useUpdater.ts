/**
 * 应用自更新全局状态（07 IN-S03 改造：侧栏更新入口）。
 *
 * 模块级单例：主进程 updater 状态机经 updater.stateChanged 全局推送，
 * 渲染端由侧栏 UpdateEntry 与设置「关于」页共同消费同一份快照。
 * 口径：发现新版不再弹 toast，提示职责由侧栏图标入口承担；
 * 检查/下载/安装失败（6003/6004/6005）静默回可重试态，仅入调试日志。
 */
import { ref, computed } from 'vue';
import { call, subscribe } from '../bridge';
import type { UpdaterSnapshot } from '../bridge';

const snapshot = ref<UpdaterSnapshot | null>(null);
/** 检查在途本地标记（checkForUpdates invoke 往返；状态跃迁本身经事件推送） */
const checking = ref(false);
/** quitAndInstall 在途标记（确认安装按钮 busy） */
const installing = ref(false);
/** 安装失败（6005）后本地回到 downloaded 可重试态（后端 fail 收敛为 idle，快照仅保留 latestVersion） */
const installRetry = ref(false);
/** 检查完成且无新版本：关于页版本行显示「✓ 已是最新」徽标 */
const checkedUpToDate = ref(false);
/** 调试滚动日志（关于页调试控制台数据源；状态迁移/调用结果） */
const logLines = ref<string[]>([]);

let unsubscribe: (() => void) | null = null;

function upLog(line: string): void {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  logLines.value.push(`[${ts}] ${line}`);
  if (logLines.value.length > 300) {
    logLines.value.splice(0, logLines.value.length - 300);
  }
}

/** 快照落位：整体替换 + 派生标记清理（不弹任何提示） */
function applySnapshot(snap: UpdaterSnapshot | null | undefined): void {
  if (!snap || typeof snap.status !== 'string') return;
  snapshot.value = snap;
  upLog(
    `state=${snap.status} current=${snap.currentVersion} latest=${snap.latestVersion ?? '-'}` +
      ` progress=${snap.downloadProgress ?? '-'}` +
      (snap.error ? ` error=${snap.error}` : ''),
  );
  if (snap.status !== 'idle' || snap.latestVersion !== null || snap.error !== null) {
    checkedUpToDate.value = false;
  }
  if (snap.status !== 'idle' && snap.status !== 'installing') {
    installRetry.value = false;
  }
}

/** 订阅全局状态推送（幂等；App 级组件挂载时调用，进程存活期不取消） */
function ensureSubscribed(): void {
  if (unsubscribe !== null) return;
  unsubscribe = subscribe('updater.stateChanged', (payload) => {
    applySnapshot(payload as UpdaterSnapshot | null);
  });
}

/** 初始状态拉取（getState 快照还原） */
async function refresh(): Promise<void> {
  try {
    applySnapshot(await call<UpdaterSnapshot>('updater/getState'));
  } catch {
    // 静默：快照缺失按未检查态展示
  }
}

/** 检查更新（关于页手动按钮触发；启动自动检查在主进程） */
async function check(): Promise<void> {
  if (checking.value) return;
  checking.value = true;
  upLog('checkForUpdates → 发起检查');
  try {
    const res = await call<UpdaterSnapshot>('updater/checkForUpdates');
    upLog(`checkForUpdates → 返回（state=${res.status}）`);
    applySnapshot(res);
    checkedUpToDate.value = res.status === 'idle' && !res.latestVersion && !res.error;
  } catch (e) {
    upLog(`checkForUpdates → 失败 ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    checking.value = false;
  }
}

/** 下载更新；进度经事件推送，失败静默回可重试态 */
async function download(): Promise<void> {
  upLog('downloadUpdate → 发起下载');
  try {
    const res = await call<UpdaterSnapshot>('updater/downloadUpdate');
    upLog(`downloadUpdate → 返回（state=${res.status}）`);
    applySnapshot(res);
  } catch (e) {
    upLog(`downloadUpdate → 失败 ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 确认后执行安装重启；失败（6005）置 installRetry 回可重试态 */
async function quitAndInstall(): Promise<void> {
  if (installing.value) return;
  installing.value = true;
  upLog('quitAndInstall → 确认安装');
  try {
    // 直用 invoke：需按 code 分流（call 会把非 0 信封压成 Error 丢字段）
    const res = await window.forge.invoke('updater/quitAndInstall');
    if (res.code === 0) {
      applySnapshot(res.data as UpdaterSnapshot | null);
    } else {
      upLog(`quitAndInstall → 返回 code ${res.code}（${res.message}）`);
      installRetry.value = true;
    }
  } catch (e) {
    upLog(`quitAndInstall → 失败 ${e instanceof Error ? e.message : String(e)}`);
    installRetry.value = true;
  } finally {
    installing.value = false;
  }
}

/** 分区常驻的「发现新版本」信息（found 之后有值；下载/安装失败后端保留该值供重试） */
const foundVersion = computed<string | null>(() => snapshot.value?.latestVersion ?? null);

/** 下载进度 0-100（侧栏进度环数据源） */
const downloadPct = computed<number>(() => Math.round(snapshot.value?.downloadProgress ?? 0));

/** 侧栏入口显隐：仅更新相关时出现；idle+latest（下载失败重试态）也算相关 */
const entryVisible = computed<boolean>(() => {
  const s = snapshot.value;
  if (!s) return false;
  if (s.status === 'found' || s.status === 'downloading' || s.status === 'downloaded' || s.status === 'installing') {
    return true;
  }
  return s.status === 'idle' && s.latestVersion !== null;
});

/** 侧栏入口语义态：found=可下载（含失败重试）、ready=待安装，其余为过程态 */
const entryMode = computed<'found' | 'downloading' | 'ready' | 'installing'>(() => {
  const s = snapshot.value;
  const status = s?.status ?? 'idle';
  if (status === 'downloading') return 'downloading';
  if (status === 'installing') return 'installing';
  if (status === 'downloaded' || (installRetry.value && foundVersion.value !== null)) return 'ready';
  return 'found';
});

export function useUpdater() {
  return {
    snapshot,
    checking,
    installing,
    installRetry,
    checkedUpToDate,
    logLines,
    foundVersion,
    downloadPct,
    entryVisible,
    entryMode,
    ensureSubscribed,
    refresh,
    check,
    download,
    quitAndInstall,
  };
}
