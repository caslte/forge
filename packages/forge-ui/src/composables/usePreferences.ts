/**
 * 用户个性化偏好（渲染层 localStorage 持久，重启保持）。
 * 偏好项：
 * - 开关：对话框 diff 展示（默认开，保持现有行为）
 * - 枚举：对话内容宽度（'standard' 收拢居中 / 'wide' 铺满，默认 standard = 收窄阅读）
 * - 终端面板（模块 10 TM-S05）：开/关状态、高度（默认高 240px；tab 列表与终端内容不持久）
 *   与配色档（auto=跟随应用主题 / dark / light，用户 2026-09-29 要求面板内可切）
 */
import { ref } from 'vue';

/** 对话内容宽度取值：standard = 固定列宽居中，wide = 随窗口铺满 */
export type ContentWidth = 'standard' | 'wide';

/** 终端配色档：auto = 跟随应用主题；dark/light = 用户手选，不再跟随 */
export type TerminalTint = 'auto' | 'dark' | 'light';

const SHOW_DIFF_KEY = 'forge:show-diff';
const CONTENT_WIDTH_KEY = 'forge:content-width';
const TERM_OPEN_KEY = 'forge:terminal-open';
const TERM_HEIGHT_KEY = 'forge:terminal-height';
const TERM_TINT_KEY = 'forge:terminal-tint';
const showDiff = ref(true);
/** 默认 standard：收拢居中列，长段落/代码/工具输出更易读；已显式存过 wide 的老用户不受影响 */
const contentWidth = ref<ContentWidth>('standard');
/** 终端面板开关：默认关（功能常驻但入口零打扰，PRD §3.4 无禁用开关） */
const terminalOpen = ref(false);
/** 终端面板高度：默认 240px，写入时恒 clamp 到 [120, 窗口高度−280]（AC-10-02 恢复超限同样 clamp） */
const terminalHeight = ref(240);
/** 终端配色档：默认 auto（跟随应用主题） */
const terminalTint = ref<TerminalTint>('auto');
const TERM_HEIGHT_MIN = 120;
/** 上限随窗口高度走（用户 2026-09-29：固定 520 在大屏/最大化窗口下不够用） */
const TERM_HEIGHT_KEEP = 280;
const TERM_HEIGHT_ABS_MAX = 1200;

/** 面板高度上限 = 窗口高度 − 280（给顶栏/对话区/输入框留最小可用高度），并钉绝对上限 */
export function termHeightMax(): number {
  // node 侧（单测）无 window：按默认窗口高度 820 口径回退
  const vh = typeof window === 'undefined' ? 820 : window.innerHeight;
  return Math.min(TERM_HEIGHT_ABS_MAX, Math.max(TERM_HEIGHT_MIN + 120, vh - TERM_HEIGHT_KEEP));
}

export const clampTerminalHeight = (n: number): number =>
  Math.min(termHeightMax(), Math.max(TERM_HEIGHT_MIN, Math.round(n)));

function load(): void {
  try {
    const saved = localStorage.getItem(SHOW_DIFF_KEY);
    // 仅显式 '0' 视为关闭；缺失/非法值回退默认开（保持现有行为不变）
    if (saved !== null) showDiff.value = saved !== '0';
    const w = localStorage.getItem(CONTENT_WIDTH_KEY);
    // 仅显式 'standard' / 'wide' 生效；缺失/非法值回退默认 standard
    if (w === 'standard' || w === 'wide') contentWidth.value = w;
    if (localStorage.getItem(TERM_OPEN_KEY) === '1') terminalOpen.value = true;
    const h = Number(localStorage.getItem(TERM_HEIGHT_KEY));
    if (Number.isFinite(h) && h > 0) terminalHeight.value = clampTerminalHeight(h);
    const tint = localStorage.getItem(TERM_TINT_KEY);
    if (tint === 'dark' || tint === 'light') terminalTint.value = tint;
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

function saveTerminalOpen(v: boolean): void {
  terminalOpen.value = v;
  try {
    localStorage.setItem(TERM_OPEN_KEY, v ? '1' : '0');
  } catch {
    // ignore
  }
}

function saveTerminalHeight(v: number): void {
  terminalHeight.value = clampTerminalHeight(v);
  try {
    localStorage.setItem(TERM_HEIGHT_KEY, String(terminalHeight.value));
  } catch {
    // ignore
  }
}

function saveTerminalTint(v: TerminalTint): void {
  terminalTint.value = v;
  try {
    localStorage.setItem(TERM_TINT_KEY, v);
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
    terminalOpen,
    setTerminalOpen: saveTerminalOpen,
    terminalHeight,
    setTerminalHeight: saveTerminalHeight,
    terminalTint,
    setTerminalTint: saveTerminalTint,
  };
}
