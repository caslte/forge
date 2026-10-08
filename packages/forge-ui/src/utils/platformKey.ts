/**
 * 全局快捷键的主修饰键判定与展示（模块 13，docs/prd/13_keyboard_shortcuts.md §3.1）。
 *
 * 解决的问题：forge 此前渲染层没有任何平台判定，唯一的组合键（Ctrl+`）只认 ctrlKey，
 * Mac 上按 ⌘+` 无反应；而终端复制键（TerminalPanel.vue）却认了 metaKey——同一应用两种口径。
 * 这里把「怎么判」和「怎么显示」收敛到一处：
 * - 判定：Mac 用 metaKey、其余平台用 ctrlKey，且互斥（⌘+Ctrl 混按不算）并排除 alt；
 * - 展示：`P` 令牌在 Mac 渲染 ⌘、其他平台渲染 Ctrl；组合记法按平台惯例
 *   （Mac 的 ⌘ 组合连写 ⌘⇧N，其余用加号）。
 *
 * 设计约束（沿用 followGate.ts / reviewMode.ts 先例）：纯 TS，平台参数可注入，
 * 便于 node --test 覆盖双平台矩阵而不依赖 navigator。
 *
 * 注意：**不建 keymap 注册表**。注册表是为改键准备的基础设施，本期只有 4 个全局键，
 * 先统一判定与展示；开放改键时再把键位搬进来，判定逻辑不返工。
 */

/** 修饰键令牌 → [非 Mac 字面量, Mac 字形]；P 是「主修饰键」，跨平台语义即 CmdOrCtrl */
const MODIFIERS: Record<string, readonly [string, string]> = {
  P: ['Ctrl', '\u2318'], // Ctrl / ⌘
  C: ['Ctrl', '\u2303'], // Ctrl / ⌃
  S: ['Shift', '\u21e7'], // Shift / ⇧
  A: ['Alt', '\u2325'], // Alt / ⌥
};

const MAC_PRIMARY_GLYPH = '\u2318';

let macCached: boolean | null = null;

/**
 * 运行平台判定（结果缓存）。
 *
 * 事实来源是 preload 注入的 `window.forge.platform`（= 主进程 process.platform）：
 * contextIsolation 下 navigator.platform 在 mac/Windows 上不足以可靠判定，
 * 项目既有约定如此（App.vue 的 isMac、TitleBar.vue 同源）。
 * 仅在纯浏览器场景（vite mock / e2e，platform 为 'browser' 或桥缺失）才退回 navigator。
 */
export function isMacPlatform(): boolean {
  if (macCached === null) {
    const injected = typeof window === 'undefined' ? undefined : window.forge?.platform;
    if (injected !== undefined && injected !== 'browser') {
      macCached = injected === 'darwin';
    } else {
      const nav = typeof navigator === 'undefined' ? null : navigator;
      macCached = nav ? /Mac|iPhone|iPad|iPod/.test(String(nav.platform ?? nav.userAgent ?? '')) : false;
    }
  }
  return macCached;
}

/** 一次 keydown 的最小结构切片：KeyboardEvent 天然满足，单测可传字面对象 */
export interface KeySignal {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

/** 期望键位：key 按不区分大小写比对；code 为可选的第二判定通道（覆盖键盘布局差异） */
export interface KeyWant {
  key: string;
  code?: string;
  /** 是否要求按下 Shift（缺省 = 要求未按） */
  shift?: boolean;
  /** 是否要求按下 Alt（缺省 = 要求未按） */
  alt?: boolean;
}

/**
 * 该按键事件是否命中「主修饰键 + want」组合。
 *
 * 判定顺序沿用 App.vue 既有 onTerminalHotkey 的写法：先把多余修饰键排除掉再判键名，
 * 保证 Ctrl+Alt+B、⌘+Ctrl+, 这类混按不会误命中。
 * key 与 code 是**或**关系：反引号在部分布局上 key 产出不同字符，code 通道兜底。
 */
export function hitsPrimary(ev: KeySignal, want: KeyWant, mac: boolean = isMacPlatform()): boolean {
  if (ev.altKey !== (want.alt ?? false)) return false;
  if (ev.shiftKey !== (want.shift ?? false)) return false;
  if (mac) {
    if (!ev.metaKey || ev.ctrlKey) return false;
  } else {
    if (!ev.ctrlKey || ev.metaKey) return false;
  }
  if (ev.key.toLowerCase() === want.key.toLowerCase()) return true;
  return want.code !== undefined && ev.code === want.code;
}

/** 令牌展开为当前平台的字面量（未识别的令牌原样返回，如 'F12'、'Enter'） */
export function capLabels(caps: readonly string[], mac: boolean = isMacPlatform()): string[] {
  return caps.map((cap) => {
    const mod = MODIFIERS[cap];
    return mod ? (mac ? mod[1] : mod[0]) : cap;
  });
}

/**
 * 组合记法：Mac 上以 ⌘ 开头的组合连写（⌘⇧N，Apple 官方 Human Interface 记法），
 * 其余情况用加号分隔（Ctrl+Shift+N、Shift+Enter、F12）。
 */
export function capsSeparator(labels: readonly string[], mac: boolean = isMacPlatform()): string {
  return mac && labels[0] === MAC_PRIMARY_GLYPH ? '' : '+';
}

/** 单串形式（tooltip / 文案插值用），如 'Ctrl+`' 或 '⌘`' */
export function formatCaps(caps: readonly string[], mac: boolean = isMacPlatform()): string {
  const labels = capLabels(caps, mac);
  return labels.join(capsSeparator(labels, mac));
}
