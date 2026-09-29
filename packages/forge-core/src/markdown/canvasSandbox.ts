/**
 * 画布卡片（```canvas 围栏）的沙箱侧约定。
 *
 * 为什么单独成文件：这些判据既被渲染层（renderMarkdown 的围栏分派）用，也被渲染
 * 进程（HtmlCanvasBlock 决定「出 iframe / 出骨架 / 出代码块」）用，还必须是纯函数
 * ——它们要在 node:test 下回归，不能碰 DOM。
 *
 * 安全口径（不可放宽）：卡片源码不过 sanitize-html 白名单（白名单不含 style，会把
 * 卡片样式剥光），而是 base64 内嵌 → 前端解码 → iframe srcdoc。安全边界完全由
 * iframe 的 `sandbox=""` 承担：不给 allow-scripts，也不给 allow-same-origin。
 * 因此 srcdoc 是独立 origin —— 主文档读不到它的内容、它拿不到 window.forge，
 * 模型 HTML 里的 <script> 与 on* 事件属性一律不执行。
 */

/**
 * 画布围栏的语言标记名（唯一权威定义）。
 *
 * 与 forge-extensions canvasHint 扩展写给模型的围栏名必须一致；不一致时卡片会静默
 * 退化成普通代码块（没有任何报错可查），故由 forge-desktop 的回归测试跨包断言相等。
 *
 * 注意不要复用 `html`：那个语言名已被 hljs 高亮占用（模型给项目展示 HTML 代码示例
 * 是常态），劫持它会把正常代码块误渲染成卡片。
 */
export const CANVAS_LANGUAGE = 'canvas';

/** 卡片默认高度（px）。骨架蒙版用同一数值，保证闭合瞬间零跳变。 */
export const CANVAS_DEFAULT_HEIGHT = 320;

/** 「拉高」档高度（px）。iframe 高度无法自适应内容（见文件头安全口径），故只给档位。 */
export const CANVAS_TALL_HEIGHT = 560;

/**
 * 内容是否像一张 HTML 图示。
 *
 * 用途是闭合那一刻的降级判定：蒙版期间用户看不到内容，若模型误把一段 JS / 纯文本
 * 塞进 canvas 围栏，无条件塞进 iframe 会得到一张空白卡片，用户等半天什么也没得到。
 *
 * 判据分两层：
 * 1. 存在任意标签形态——残缺但确是 HTML 的（模型写到一半就闭合）仍可进 iframe，
 *    交给浏览器自动补齐未闭合标签；
 * 2. 但「有一个标签」不等于「是一张有布局的图」：模型常拿一个薄壳（如
 *    `<div style="font:...">`）包住 ASCII 字符画。字符画进 iframe 会被 HTML 空白
 *    规则压成一坨（换行丢、连续空格折叠、对齐全毁），比降级代码块差得多。
 *    故剥掉标签取可见文本，文本呈字符画形态时判 false（降级代码块，等宽保对齐）。
 */
export function looksLikeHtmlCanvas(source: string): boolean {
  const s = source ?? '';
  if (!/<[a-zA-Z!/][^>]*>/.test(s)) return false;
  return !looksLikeAsciiArt(stripTagsToText(s));
}

/** 取标签外的可见文本。先吃掉「标签间纯空白」（模型的排版缩进），缩进不是内容。 */
function stripTagsToText(s: string): string {
  return s
    .replace(/>\s+</g, '><')
    .replace(/<[^>]*>/g, '');
}

/* ------------------------------------------------------------------ *
 * 「文字塞卡片」判据（prose 降级）。
 *
 * looksLikeHtmlCanvas 只挡「没有标签」和「ASCII 字符画」，`<div>` 包一段纯文字
 * 会畅通进 iframe——固定 320px 高的卡片装着几百字说明，底部大片留白，用户读的
 * 还是不带 markdown 语义的裸文本。模型把 prose 塞进 ```canvas 围栏是实测高频
 * 行为（提示词已于 2026-09 收紧，仍需宿主兜底），故加第二道降级：判出「标签只是
 * 排版壳、内容是文章」的卡片，摘出文字按正文流渲染，不出 iframe。
 */

/**
 * 布局特征（命中任一即不判 prose）——只认「真排版」，不认「内容像图」。
 *
 * 教训（2026-09-29 真机漏网）：初版把箭头 → ← 和边框线型也算特征，结果
 * 「正文里夹内联箭头的伪流程卡」（origin → 你的 fork ← 拉新提交…）畅通进
 * iframe。行文里的 A → B → C 是标点不是布局，中文技术写作里极常见；带边框的
 * 薄壳 wrapper 同理（callout 式排版壳）。这里只留布局信号：flex/grid/绝对定位/
 * 浮动（模型按契约画图必用其中之一）、table/svg/img 图元、制表字符。
 * 误伤方向也核实过：纯文字序列被降级成正文不丢信息，可接受。
 */
const VISUAL_CUE_RE =
  /display\s*:\s*(flex|grid)|position\s*:\s*absolute|float\s*:|<(table|svg|img)\b|[─│┌┐└┘├┤┬┴┼]/i;

/** 可见文本占源码的比例上限：超过才算「标签只是壳」。真图示的样式文本通常占一半以上。 */
const PROSE_TEXT_RATIO = 0.6;

/** 可见文本最短长度：低于它不判 prose（带个标题的小图示不值得降级）。 */
const PROSE_MIN_TEXT = 40;

/**
 * 长句阈值：单个标签间文本片段的字符数超过它就是句子。
 *
 * 真图示的文本节点是短标签（「网关」「服务」「API Gateway」），几十字的连续长句
 * 不可能住在图示的节点里——所以长句是无视布局信号的 prose 铁证。第二轮真机漏网
 * 正是反例：P0/P1/P2 分级列表套着 grid 壳、每条一个带样式 div，布局信号全齐，
 * 本质仍是文字堆。
 */
const PROSE_LONG_RUN = 80;

/**
 * 图形兜底：含 svg/img 的卡片是「画」，文字判据对它无权重——降级路径靠剥标签取文，
 * 会把整张图拆没。宁可留着卡片（哪怕它还带了段长文），也不做不可逆的破坏。
 */
const GRAPHIC_RE = /<(svg|img)\b/i;

/** 逐个取标签间的文本片段（trim 后），返回最长片段的字符数。 */
function longestTextRun(s: string): number {
  let max = 0;
  for (const frag of s.split(/<[^>]*>/)) {
    const len = frag.trim().length;
    if (len > max) max = len;
  }
  return max;
}

/**
 * 源码是否「文字塞卡片」：有标签（否则归 looksLikeHtmlCanvas 的代码块降级）、
 * 非图形（svg/img 不碰），且命中其一——
 * 1. 长句路径：任一标签间文本 ≥ PROSE_LONG_RUN（无视布局信号）；
 * 2. 薄壳路径：可见文本占源码六成以上、且无任何布局特征（flex/grid/定位/图元/制表符）。
 */
export function looksLikeProseCanvas(source: string): boolean {
  const s = source ?? '';
  if (!looksLikeHtmlCanvas(s)) return false;
  if (GRAPHIC_RE.test(s)) return false;
  const text = stripTagsToText(s).trim();
  if (text.length < PROSE_MIN_TEXT) return false;
  if (longestTextRun(s) >= PROSE_LONG_RUN) return true;
  if (text.length / s.length <= PROSE_TEXT_RATIO) return false;
  return !VISUAL_CUE_RE.test(s);
}

/**
 * 「文字塞卡片」的降级还原：把 HTML 片段摘成可读纯文本，交给渲染层过
 * renderMarkdown（sanitize 白名单在内）按正文流渲染。
 *
 * 顺序敏感：先整块丢弃 script/style（其内容不配出现在正文里），再剥标签，最后才
 * 解码实体——反过来先解码，`&lt;script&gt;` 会复活成真标签。块级闭标签还原成段落
 * 边界防文字粘连；行首空白剥掉，防 renderMarkdown 把模型排版缩进顶成代码块。
 */
export function stripCanvasProse(source: string): string {
  return (source ?? '')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|ul|ol|h[1-6]|table|tr|blockquote|pre|section|article)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '')
    .replace(/^[ \t]+/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

/**
 * 文本是否呈 ASCII 字符画形态。
 *
 * 行级判据（命中其一即算一行「画」）：
 * 1. 制表字符（┌─│ 等）——字符画的强特征，单独成立；
 * 2. ≥2 个管道符且行中（非行尾）有 ≥2 连续空格——「竖线分栏 + 空格对齐」；
 *    排除行尾是避开 markdown 硬换行的尾随双空格习惯；
 * 3. ≥2 个管道符且带下划线长跑——`|__|__|` 式表格线；
 * 4. ≥3 个管道符——密集分栏（「off | low | high」式的两管道单空格写法不误伤）；
 * 5. 同行出现 ≥2 段 `___` 级下划线长跑——横线分隔。
 *    单段 `___` 可能是强调记号，不单独计。
 *
 * 整体判据：非空行数 ≥ minArt，且「画」≥ minArt 行、占非空行一半以上——
 * 少量 `|` 分隔的正文（如「off | low | high」单空格写法）不误伤。
 * minArt 传 2 供 markdown 正文段落用（段落行数天然少），围栏降级用默认 3。
 */
export function looksLikeAsciiArt(text: string, minArt = 3): boolean {
  const lines = (text ?? '').split(/\r?\n/).filter((l) => l.trim() !== '');
  if (lines.length < minArt) return false;
  let art = 0;
  for (const line of lines) {
    if (asciiArtLine(line)) art += 1;
  }
  return art >= minArt && art * 2 >= lines.length;
}

function asciiArtLine(line: string): boolean {
  if (/[─━│┃┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩═║]/.test(line)) return true;
  const pipes = (line.match(/\|/g) ?? []).length;
  if (pipes >= 3) return true;
  if (pipes >= 2 && / {2,}\S/.test(line)) return true;
  if (pipes >= 2 && /_{2,}/.test(line)) return true;
  return (line.match(/_{3,}/g) ?? []).length >= 2;
}

/** 注入沙箱文档的语义色令牌（由渲染进程从 :root 计算样式读出，随主题切换重算） */
export interface CanvasTokens {
  bg: string;
  fg: string;
  muted: string;
  mutedFg: string;
  surface: string;
  border: string;
  ok: string;
  warn: string;
  bad: string;
  accent: string;
}

/**
 * 沙箱文档的预注入样式（preflight）。
 *
 * 为什么需要：模型不知道也不该知道 forge 的调色板。给它一套固定的 `--c-*` 语义变量，
 * 提示词里要求只准用这些变量取色，于是同一份卡片源码在暗色/亮色下都自动成立——
 * 换主题时我们重算 srcdoc，模型侧零改动。
 *
 * 这里刻意只做「变量声明 + 最小 reset + 滚动条」，不预设任何排版：卡片布局是模型的
 * 表达自由，我们只保证它拿得到一套和宿主同源的色。
 */
export function buildCanvasPreflight(tokens: CanvasTokens): string {
  return `<style>
:root{
  --c-bg:${tokens.bg};
  --c-fg:${tokens.fg};
  --c-muted:${tokens.muted};
  --c-muted-fg:${tokens.mutedFg};
  --c-surface:${tokens.surface};
  --c-border:${tokens.border};
  --c-ok:${tokens.ok};
  --c-warn:${tokens.warn};
  --c-bad:${tokens.bad};
  --c-accent:${tokens.accent};
  --c-ok-bg:color-mix(in oklab, ${tokens.ok} 12%, transparent);
  --c-warn-bg:color-mix(in oklab, ${tokens.warn} 14%, transparent);
  --c-bad-bg:color-mix(in oklab, ${tokens.bad} 12%, transparent);
}
*{box-sizing:border-box;margin:0;padding:0}
body{
  background:var(--c-bg);
  color:var(--c-fg);
  font-family:"Noto Sans CJK SC",-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
  font-size:13px;
  line-height:1.7;
  padding:14px 16px;
}
::-webkit-scrollbar{width:8px;height:8px}
::-webkit-scrollbar-track{background:transparent}
::-webkit-scrollbar-thumb{background:color-mix(in oklab, ${tokens.fg} 18%, transparent);border-radius:999px}
</style>`;
}

/** 拼出完整的沙箱文档。卡片源码原样进 body，不做任何改写。 */
export function buildCanvasDocument(body: string, tokens: CanvasTokens): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8">${buildCanvasPreflight(tokens)}</head><body>${body}</body></html>`;
}

/**
 * 另存的独立 HTML 文档（脱离 forge 也能看）。
 *
 * 与 buildCanvasDocument 分开是因为语义不同：另存件要能作为独立文件被浏览器打开，
 * 所以带 <title>；沙箱件只活在 iframe 里，标题无意义。
 */
export function buildCanvasStandaloneFile(body: string, tokens: CanvasTokens, title: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escapeHtmlText(title)}</title>
${buildCanvasPreflight(tokens)}
</head>
<body>${body}</body>
</html>
`;
}

/** 文本转义（标题进 <title> 用；卡片正文本身不过这里，它进的是 iframe 沙箱） */
function escapeHtmlText(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
