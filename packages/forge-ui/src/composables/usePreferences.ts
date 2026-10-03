/**
 * 用户个性化偏好（渲染层 localStorage 持久，重启保持）。
 * 偏好项：
 * - 开关：对话框 diff 展示（默认开，保持现有行为）
 * - 枚举：对话内容宽度（'standard' 收拢居中 / 'wide' 铺满，默认 standard = 收窄阅读）
 * - 终端面板（模块 10 TM-S05）：高度（默认高 240px）与配色档（auto=跟随应用主题 / dark / light，
 *   用户 2026-09-29 要求面板内可切）跨启动保持；**开/关状态与 tab 列表、终端内容不跨启动**——
 *   首页永远干净，面板只由本次运行里的入口动作打开
 * - 终端 Shell（模块 10 TD-TM-05 方案 B）：auto=跟随系统默认（主进程 pwsh → powershell →
 *   cmd 优先级链）/ 钉住某一档；渲染层只存枚举 id，路径解析在主进程（term/create shellId）
 * - 内置代码浏览器（模块 12 CE-S01/S02）：代码查看器布局与分割宽度
 */
import { computed, ref } from 'vue';

/** 对话内容宽度取值：standard = 固定列宽居中，wide = 随窗口铺满 */
export type ContentWidth = 'standard' | 'wide';

/** 终端配色档：auto = 跟随应用主题；dark/light = 用户手选，不再跟随 */
export type TerminalTint = 'auto' | 'dark' | 'light';

/**
 * 终端 Shell（TD-TM-05 方案 B）：auto = 跟随系统默认（主进程优先级链）；
 * pwsh/powershell/cmd = 钉住某一档（是否已装由主进程探测，选项来自 listTerminalShells）。
 * 渲染层只持久化这个 id，可执行路径永远不出主进程。
 */
export type TerminalShellPref = 'auto' | 'pwsh' | 'powershell' | 'cmd';

/**
 * 代码查看器布局（模块 12 CE-S01）：
 * - cover：整屏覆盖。对话纸的 DOM 保持挂载、宽度零变化，流式输出与滚动位置不丢。
 * - split：左右分割。可边看 AI 回复边看代码，代价是对话区被压缩（两侧各保底 320px）。
 */
export type CodeViewerLayout = 'cover' | 'split';

const SHOW_DIFF_KEY = 'forge:show-diff';
const CONTENT_WIDTH_KEY = 'forge:content-width';
const TERM_HEIGHT_KEY = 'forge:terminal-height';
const TERM_TINT_KEY = 'forge:terminal-tint';
const TERM_SHELL_KEY = 'forge:terminal-shell';
const CODE_LAYOUT_KEY = 'forge.codeViewerLayout';
const CODE_SPLIT_PCT_KEY = 'forge.codeViewerSplitPct';

/**
 * ===== 模块 12：代码查看器布局常量 =====
 * 与 PRD §3.3 一致。两套布局的切分比例统一在这里，UI 不再散落魔法数字。
 * 声明在下方 ref 之前：ref 初始化在模块加载时就会求值，放后面就是 TDZ 报错。
 */

/** 分割布局下双击 splitter 恢复的默认比例（与原型一致） */
export const CODE_SPLIT_PCT_DEFAULT = 46;
/** 单侧最小宽度（px）。比例保底由此换算，故与窗口宽度绑定。 */
export const CODE_SIDE_MIN_PX = 320;
/** 拖拽沟宽度（px）。两纸贴合、仅留一道 4px 缝，**不含可见分隔线**（线已删）。
 *  实现在 CodeSplitter.vue 的内联 style 上——改这里必须同步改那里，两处都别再写死。 */
export const CODE_SPLITTER_PX = 4;
/** 键盘 ←/→ 每次调整的步长（百分点） */
export const CODE_SPLIT_STEP = 2;
/**
 * 窗口窄于此值时，即便偏好是 split 也临时降级为 cover（CE-S04）。
 * 低于此宽度时两栏各保底 320px 根本放不下，硬切会直接把对话区挤没。
 * **只影响当次渲染，不改写用户偏好** —— 拉宽窗口自动恢复 split。
 */
export const CODE_LAYOUT_MIN_WINDOW = 820;

/**
 * 把百分比夹到两侧保底内。窗宽不足时上限与下限会交叉，这里以「对话区为重」
 * 取下限（代码区被压到刚好 320px），避免对话区被挤成一条缝。
 */
export function clampCodeSplitPct(pct: number, windowWidth: number): number {
  if (!Number.isFinite(pct)) return CODE_SPLIT_PCT_DEFAULT;
  // 窗口窄到两侧保底都放不下时（如 500px 窗），退回 50% 居中口径
  if (windowWidth <= CODE_SIDE_MIN_PX * 2) return CODE_SPLIT_PCT_DEFAULT;
  const minPct = (CODE_SIDE_MIN_PX / windowWidth) * 100;
  return Math.max(minPct, Math.min(100 - minPct, pct));
}

/**
 * 本次**实际生效**的布局 = 用户偏好 + 窗口宽度共同决定。
 *
 * 抽成函数而不是各组件自己写 if，是因为它同时决定两件必须一致的事：
 * CodeExplorer 自己判断「画 overlay 还是 flex 子项」，App 要判断「.content 是不是行布局」。
 * 两处一旦各算一遍，早晚会漂移成「代码画成了并排、但容器还是竖排」这种难查的错。
 */
export function effectiveCodeLayout(
  preference: CodeViewerLayout,
  windowWidth: number,
): CodeViewerLayout {
  return preference === 'split' && windowWidth < CODE_LAYOUT_MIN_WINDOW ? 'cover' : preference;
}

/**
 * 拖拽一步后的新百分比。pct 是**代码纸**占比，而沟在代码纸左缘：
 * 向左拖 = 沟的 x 变小 = 代码纸变宽，所以位移取 `startX - currentX`。
 *
 * 写成「起点 + 增量」而不是「当前值 + 增量」：拖到边界被钳住后，鼠标继续往回走
 * 必须先走回被钳掉的那段距离才动得了——否则用户会遇到「怎么拉都没反应」的死手感。
 */
export function nextSplitPct(
  startPct: number,
  startX: number,
  currentX: number,
  containerWidth: number,
): number {
  if (containerWidth <= 0) return startPct;
  return startPct + ((startX - currentX) / containerWidth) * 100;
}

const showDiff = ref(true);
/** 默认 standard：收拢居中列，长段落/代码/工具输出更易读；已显式存过 wide 的老用户不受影响 */
const contentWidth = ref<ContentWidth>('standard');
/** 终端面板开关：默认关，且**不跨启动**（模块级 ref 只保本次运行；启动永远从关开始） */
const terminalOpen = ref(false);
/** 终端面板高度：默认 240px，写入时恒 clamp 到 [120, 窗口高度−280]（AC-10-02 恢复超限同样 clamp） */
const terminalHeight = ref(240);
/** 终端配色档：默认 auto（跟随应用主题） */
const terminalTint = ref<TerminalTint>('auto');
/** 终端 Shell：默认 auto（跟随系统默认优先级链）；只存 id，路径解析在主进程 */
const terminalShell = ref<TerminalShellPref>('auto');
/** 代码查看器布局：默认 cover（2026-10-02 用户定稿：进代码态默认整屏覆盖读码，分割留给偏好并排的人） */
const codeViewerLayout = ref<CodeViewerLayout>('cover');
/** 分割布局下代码纸占宽百分比；写入时恒 clamp 到 [保底, 100−保底]（CE-S03） */
const codeViewerSplitPct = ref(CODE_SPLIT_PCT_DEFAULT);
/**
 * 视口宽度的**单一数据源**。放模块级而不是各组件私有，是因为「窄窗降级」这条规则
 * 有三个消费方：CodeExplorer 画不画并排、App 判不判要退出代码态、CodeTreePanel
 * 顶栏挂不挂窄窗徽标。三处各挂一个 resize 监听不只浪费，更危险的是它们的初值
 * 可能不一致（有的组件 onMounted 才同步、有的构造即求值），降级判定就会在
 * 「刚好卡在 820px」时不同步。用一个模块级 ref 锁死。
 *
 * 声明在 codeViewerLayout **之后**：它只在 computed 的 getter 里读那个 ref，
 * 构造期不求值，所以不会 TDZ；但放后面读起来才不用先跳回去找它在哪。
 */
export const viewportWidth = ref(typeof window === 'undefined' ? 1440 : window.innerWidth);

if (typeof window !== 'undefined') {
  window.addEventListener('resize', () => {
    viewportWidth.value = window.innerWidth;
  });
}

/**
 * 偏好是 split、但窗口窄到只能 cover —— 即 CE-S04 的「临时降级」态。
 * 注意它**只描述当次渲染**，不表示偏好被改写：用户把窗口拉宽就自动恢复 split。
 */
export const codeLayoutDegraded = computed(
  () =>
    codeViewerLayout.value === 'split' &&
    effectiveCodeLayout(codeViewerLayout.value, viewportWidth.value) === 'cover',
);

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
    const h = Number(localStorage.getItem(TERM_HEIGHT_KEY));
    if (Number.isFinite(h) && h > 0) terminalHeight.value = clampTerminalHeight(h);
    const tint = localStorage.getItem(TERM_TINT_KEY);
    if (tint === 'dark' || tint === 'light') terminalTint.value = tint;
    // 终端 Shell：仅显式钉住档生效（'auto' 是缺省不落盘），非法值回退 auto
    const shell = localStorage.getItem(TERM_SHELL_KEY);
    if (shell === 'pwsh' || shell === 'powershell' || shell === 'cmd') terminalShell.value = shell;
    // 布局：仅显式 'split' / 'cover' 生效，其余（含非法值）回退默认 cover
    const layout = localStorage.getItem(CODE_LAYOUT_KEY);
    if (layout === 'split' || layout === 'cover') codeViewerLayout.value = layout;
    const pct = Number(localStorage.getItem(CODE_SPLIT_PCT_KEY));
    if (Number.isFinite(pct) && pct > 0) {
      codeViewerSplitPct.value = clampCodeSplitPct(
        pct,
        typeof window === 'undefined' ? 1440 : window.innerWidth,
      );
    }
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

function setTerminalOpen(v: boolean): void {
  // 故意不落盘：开/关是本次运行的视图状态，不是偏好。启动首页必须干净。
  terminalOpen.value = v;
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

function saveTerminalShell(v: TerminalShellPref): void {
  terminalShell.value = v;
  try {
    localStorage.setItem(TERM_SHELL_KEY, v);
  } catch {
    // ignore
  }
}

function saveCodeViewerLayout(v: CodeViewerLayout): void {
  codeViewerLayout.value = v;
  try {
    localStorage.setItem(CODE_LAYOUT_KEY, v);
  } catch {
    // ignore
  }
}

function saveCodeViewerSplitPct(v: number): void {
  // 写盘前 clamp：否则拖到极窄后刷新会先以非法值恢复、clamp 一次闪一下
  codeViewerSplitPct.value = clampCodeSplitPct(
    v,
    typeof window === 'undefined' ? 1440 : window.innerWidth,
  );
  try {
    localStorage.setItem(CODE_SPLIT_PCT_KEY, String(codeViewerSplitPct.value));
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
    setTerminalOpen,
    terminalHeight,
    setTerminalHeight: saveTerminalHeight,
    terminalTint,
    setTerminalTint: saveTerminalTint,
    terminalShell,
    setTerminalShell: saveTerminalShell,
    codeViewerLayout,
    setCodeViewerLayout: saveCodeViewerLayout,
    codeViewerSplitPct,
    setCodeViewerSplitPct: saveCodeViewerSplitPct,
  };
}
