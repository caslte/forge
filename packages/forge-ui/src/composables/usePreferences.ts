/**
 * 用户个性化偏好（渲染层 localStorage 持久，重启保持）。
 * 首个偏好：对话框 diff 展示开关（默认开，保持现有行为）。
 */
import { ref } from 'vue';

const SHOW_DIFF_KEY = 'forge:show-diff';
const showDiff = ref(true);

function load(): void {
  try {
    const saved = localStorage.getItem(SHOW_DIFF_KEY);
    // 仅显式 '0' 视为关闭；缺失/非法值回退默认开（保持现有行为不变）
    if (saved !== null) showDiff.value = saved !== '0';
  } catch {
    // ignore
  }
}

function saveShowDiff(v: boolean): void {
  showDiff.value = v;
  try {
    localStorage.setItem(SHOW_DIFF_KEY, v ? '1' : '0');
  } catch {
    // ignore
  }
}

load();

export function usePreferences() {
  return {
    showDiff,
    setShowDiff: saveShowDiff,
  };
}
