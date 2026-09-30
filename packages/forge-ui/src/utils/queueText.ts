/**
 * 待发送队列条目的呈现辅助纯函数（InstructionInput 队列面板用）。
 *
 * 背景（2026-09-29 CV-S09 面板重设计）：队列条目**收趟态强制一行**（nowrap +
 * 省略号），长路径在等宽下比在正文字体下更容易横向对齐，混排代码块更是如此
 * ——所以按内容启发式决定是否切等宽。纯 TS 零依赖（Node type stripping 可直跑，
 * 先例 utils/prependQueuedText.ts / utils/pasteText.ts）。
 */

/** CJK（含全角标点）：混排中文的条目一律走正文字体——等宽下中文更难扫 */
const CJK = /[\u2e80-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/** Windows 盘符路径：C:\… / D:/… */
const WIN_PATH = /^[A-Za-z]:[\\/]/;

/** POSIX 绝对或相对路径：至少 3 段（/a/b/c/… 或 ./a/b/…），避免把普通斜杠句子误判 */
const POSIX_PATH = /^(?:\.{0,2}\/|\/)[^\s]*\/(?:[^\s/]+\/){1,}/;

/** 常见源码/配置/日志扩展名 */
const CODE_EXT = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|go|py|java|kt|rs|json|ya?ml|toml|md|sh|bat|cmd|log|sql|css|scss|less|html?|xml|txt)$/i;

/** 代码结构启发式：花括号 / 行尾分号 / 箭头函数 / 常见声明关键字 */
const CODE_SHAPE = /[{};]|\)\s*(?:=>|:)|(?:^|\n)\s*(?:function|const|let|var|def|func|class|import|export|package|func)\s|<\/?[a-z][\w-]*\s*\/?>/i;

/**
 * 队列条目是否按等宽呈现（路径 / 代码启发式）。
 *
 * 判定顺序：先排除含 CJK 的条目（等宽下中文更难扫），再依次看盘符路径、
 * POSIX 多段路径、源码扩展名、代码结构。宁可不切（少一处等宽的视觉噪声），
 * 也不要为了「看起来像代码」而误切普通句子。
 */
export function looksMonospace(text: string): boolean {
  const s = text.trim();
  if (s === '' || CJK.test(s)) return false;
  if (WIN_PATH.test(s)) return true;
  if (POSIX_PATH.test(s)) return true;
  if (CODE_EXT.test(s)) return true;
  return CODE_SHAPE.test(s);
}

/**
 * 队列条目当前是否被截断（超出部分靠省略号藏起来了 → 需要挂 title 提示全文）。
 *
 * 收趟态是 `white-space: nowrap` + `text-overflow: ellipsis`，溢出体现在
 * **横向**（`scrollWidth > clientWidth`）；纵向也一并检查，避免样式再变时
 * 标题悄悄失效。不能按字数猜——同一条 68 字的路径在 890px 宽下 1 行放得下、
 * 在窄窗下会截断。
 */
export function isQueueItemClamped(el: HTMLElement): boolean {
  return el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
}

/**
 * 队列条目的行数：1。
 *
 * 用户 2026-09-29 反馈：「内容放在一行，不要换行」+「展开去掉，超出了给个 title」。
 * 所以面板是纯一行列表：超出用省略号，悬停出原生 title 看全文，没有展开态。
 * 导出为常量而非魔法数，便于测试共用同一个口径。
 */
export const QUEUE_TEXT_CLAMP_LINES = 1;
