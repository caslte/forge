/**
 * 用户个性化偏好（渲染层 localStorage 持久，重启保持）。
 * 偏好项：
 * - 开关：对话框 diff 展示（默认开，保持现有行为）
 * - 枚举：对话内容宽度（'standard' 收拢居中 / 'wide' 铺满，默认 standard = 收窄阅读）
 */
import { ref } from 'vue';

/** 对话内容宽度取值：standard = 固定列宽居中，wide = 随窗口铺满 */
export type ContentWidth = 'standard' | 'wide';

const SHOW_DIFF_KEY = 'forge:show-diff';
const CONTENT_WIDTH_KEY = 'forge:content-width';
const showDiff = ref(true);
/** 默认 standard：收拢居中列，长段落/代码/工具输出更易读；已显式存过 wide 的老用户不受影响 */
const contentWidth = ref<ContentWidth>('standard');

function load(): void {
  try {
    const saved = localStorage.getItem(SHOW_DIFF_KEY);
    // 仅显式 '0' 视为关闭；缺失/非法值回退默认开（保持现有行为不变）
    if (saved !== null) showDiff.value = saved !== '0';
    const w = localStorage.getItem(CONTENT_WIDTH_KEY);
    // 仅显式 'standard' / 'wide' 生效；缺失/非法值回退默认 standard
    if (w === 'standard' || w === 'wide') contentWidth.value = w;
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

function saveContentWidth(v: ContentWidth): void {
  contentWidth.value = v;
  try {
    localStorage.setItem(CONTENT_WIDTH_KEY, v);
  } catch {
    // ignore
  }
}

load();

export function usePreferences() {
  return {
    showDiff,
    setShowDiff: saveShowDiff,
    contentWidth,
    setContentWidth: saveContentWidth,
  };
}
