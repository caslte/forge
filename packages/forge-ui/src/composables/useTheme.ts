/**
 * 主题切换 composable。light/dark，localStorage 持久化，document data-theme 属性驱动。
 *
 * v3.78.6：`apply()` 追加一步「回写主进程」。主进程的 BrowserWindow.backgroundColor 只在
 * 建窗时刻能设，那一刻它读不到 localStorage——所以每次解析/切换主题都把结果同步给主进程，
 * 由它落盘（userData/forge-theme.json）供下次冷启动取用，并就地刷新窗口底色。
 * **localStorage 仍是唯一事实来源**（真正驱动 data-theme 的还是它），主进程那份只是镜像：
 * 因此 `load()` 也要回写一次，镜像被清/损坏时下一次启动即自愈。
 */
import { ref, watch } from 'vue';
import type { ThemeMode } from '../types';

const STORAGE_KEY = 'forge:theme';
const themeMode = ref<ThemeMode>('dark');

/**
 * 回写主进程（fire-and-forget）。两条路径都要能容忍缺失：
 * - 纯浏览器 dev / e2e：mock-bridge 提供空实现；
 * - 模块链早于 preload 桥就绪的极端时序：可选链兜底。
 * 失败只影响「下次冷启动的第一帧底色」，不影响本次会话，故全部静默。
 */
function mirrorToMain(mode: ThemeMode): void {
  try {
    window.forge?.theme?.set(mode);
  } catch {
    // ignore
  }
}

function apply(mode: ThemeMode): void {
  mirrorToMain(mode);
  if (typeof document === 'undefined') return;
  document.documentElement.setAttribute('data-theme', mode);
}

function load(): void {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved === 'dark' || saved === 'light') {
      themeMode.value = saved;
    }
  } catch {
    // ignore
  }
  apply(themeMode.value);
}

function save(mode: ThemeMode): void {
  themeMode.value = mode;
  apply(mode);
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    // ignore
  }
}

load();

watch(themeMode, (m) => apply(m));

export function useTheme() {
  return {
    themeMode,
    setTheme: save,
    toggle() {
      save(themeMode.value === 'light' ? 'dark' : 'light');
    },
  };
}
