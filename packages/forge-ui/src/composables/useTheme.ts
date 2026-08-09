/**
 * 主题切换 composable。light/dark，localStorage 持久化，document data-theme 属性驱动。
 */
import { ref, watch } from 'vue';
import type { ThemeMode } from '../types';

const STORAGE_KEY = 'forge:theme';
const themeMode = ref<ThemeMode>('light');

function apply(mode: ThemeMode): void {
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
