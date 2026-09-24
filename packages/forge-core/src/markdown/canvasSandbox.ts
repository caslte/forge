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
 * 判据取「存在任意标签形态」——残缺但确是 HTML 的（模型写到一半就闭合）仍判 true，
 * 交给浏览器自动补齐未闭合标签，这比退回代码块更接近用户预期。
 */
export function looksLikeHtmlCanvas(source: string): boolean {
  return /<[a-zA-Z!/][^>]*>/.test(source ?? '');
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
