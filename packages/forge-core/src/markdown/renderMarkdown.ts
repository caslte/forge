/**
 * 安全 Markdown 渲染（P2-B）。
 *
 * 职责：把助手消息的原始 Markdown 渲染为白名单安全 HTML，供前端 v-html 直接输出。
 * - 解析：marked（gfm + breaks），代码块按 lang 经 highlight.js 高亮，行号/int 扩展不引入。
 * - 安全（白名单 sanitize-html，见 docs/prd/03_conversation.md 渲染安全要求）：
 *   - 禁止原生 HTML：script/style/iframe/事件属性（on*）一律移除。
 *   - 危险协议链接：javascript:/data:/vbscript: 等 href/src 被清除。
 *   - 链接策略：仅 http/https/mailto 保留为 <a>（点击由渲染层拦截交系统浏览器打开），
 *     相对路径/锚点/协议相对等一律降级为 <span> 纯文本——防投毒链接把应用窗口导航走。
 * - mermaid 块：语言为 mermaid 时输出带 `data-md-mermaid` 的占位 div（源码经 base64 编码），
 *   前端扫描该标记后异步渲染为图表（渲染失败时该 div 内已含转义原文，直接可读）。
 * - canvas 块：语言为 canvas 时同理输出 `data-md-canvas` 占位，前端解码后塞进
 *   iframe srcdoc 沙箱渲染（见 forge-ui HtmlCanvasBlock）。卡片源码是完整 HTML，
 *   **绝不能过本文件的 sanitize 白名单**（白名单不含 style，会把卡片样式剥光），
 *   故走 base64 占位绕开；安全边界由 iframe 的 sandbox 全关承担，两条线互斥。
 *   注意 ` ```html ` 仍走 hljs 高亮展示源码（模型给项目写 HTML 示例是常态），
 *   不可劫持——画布围栏只用 canvas 这一个语言名。模型把纯文字包进 canvas 围栏时
 *   （looksLikeProseCanvas），前端不出 iframe，改按正文流渲染，见 canvasSandbox。
 * - 统一渲染：流式与结束后均用本函数完整渲染，保证两种状态样式一致
 *   （曾用流式简化渲染导致紧凑/正常样式跳变，已移除）。
 * - 代码块复制：每个 ``` 围栏套一层 `.md-code-wrap`，内含一枚空的 `.md-code-copy`
 *   按钮（图标与点击都在渲染层）；按钮是 pre 的兄弟——pre 里的多余空白会变成代码首行。
 *
 * 纯 Node 模块：不 import Electron / Vue / pi，可在 node:test 下直接回归（含 XSS 用例）。
 */

import { Marked } from 'marked';
import { hljs } from './hljsCore.ts';
import sanitizeHtml from 'sanitize-html';

import { CANVAS_LANGUAGE, looksLikeAsciiArt } from './canvasSandbox.ts';

/** marked 实例：gfm + 换行即 <br>（对齐消息正文既有行为） */
const marked = new Marked({ gfm: true, breaks: true });

export {
  CANVAS_LANGUAGE,
  CANVAS_DEFAULT_HEIGHT,
  CANVAS_TALL_HEIGHT,
  looksLikeHtmlCanvas,
  looksLikeProseCanvas,
  looksLikeAsciiArt,
  stripCanvasProse,
  buildCanvasDocument,
  buildCanvasStandaloneFile,
  type CanvasTokens,
} from './canvasSandbox.ts';

/** 白名单标签（sanitize-html allowedTags） */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div',
  // 代码块右上角的复制按钮（点击行为在渲染层委托，见 forge-ui markdownLinks）
  'button',
];

/** hljs 行内 span 的 class 需放行（hljs-keyword 等） */
const ALLOWED_ATTRIBUTES = {
  a: ['href', 'title', 'target'],
  img: ['src', 'alt', 'title'],
  pre: ['class'],
  code: ['class', 'data-md-mermaid', 'data-md-canvas'],
  span: ['class'],
  div: ['class'],
  th: ['align'],
  td: ['align'],
  button: ['class', 'type', 'tabindex'],
};

/**
 * 用户书写语言标识 → hljs 注册名（与 hljsCore.ts 的注册集一一对应）。
 * sh/shell、yml、html 等别名在此归一，白名单外的语言走转义展示（与全量版行为一致）。
 */
const LANG_ALIASES: Record<string, string> = {
  js: 'javascript',
  javascript: 'javascript',
  ts: 'typescript',
  typescript: 'typescript',
  json: 'json',
  html: 'xml',
  xml: 'xml',
  css: 'css',
  bash: 'bash',
  sh: 'bash',
  shell: 'bash',
  powershell: 'powershell',
  python: 'python',
  java: 'java',
  go: 'go',
  rust: 'rust',
  c: 'c',
  cpp: 'cpp',
  csharp: 'csharp',
  sql: 'sql',
  yaml: 'yaml',
  yml: 'yaml',
  markdown: 'markdown',
  diff: 'diff',
  dockerfile: 'dockerfile',
};

/**
 * marked renderer：代码块经 hljs 高亮；mermaid 块输出占位 div（base64 编码源码）。
 * @param lang 语言标识（无则 null）
 * @param text 代码原文
 */
function codeRenderer(lang: string | undefined, text: string): string {
  const trimmed = text.replace(/\n$/, '');
  const language = (lang ?? '').toLowerCase().trim() || undefined;

  // Mermaid：转义原文 + 数据标记，交给前端异步渲染为图表
  if (language === 'mermaid') {
    const escaped = htmlEscape(trimmed);
    const encoded = encodeBase64Utf8(trimmed);
    return `<pre class="md-mermaid-wrap"><code class="md-mermaid" data-md-mermaid="${encoded}">${escaped}</code></pre>`;
  }

  // Canvas：模型手写的 HTML 卡片。转义原文兜底（非 HTML 内容降级时可读），
  // 真正的渲染源是 base64 —— 它绕开 sanitize，交给 iframe 沙箱承载
  if (language === CANVAS_LANGUAGE) {
    const escaped = htmlEscape(trimmed);
    const encoded = encodeBase64Utf8(trimmed);
    return `<pre class="md-canvas-wrap"><code class="md-canvas" data-md-canvas="${encoded}">${escaped}</code></pre>`;
  }

  let highlighted: string;
  const hlLang = language !== undefined ? LANG_ALIASES[language] : undefined;
  if (hlLang !== undefined && hljs.getLanguage(hlLang)) {
    highlighted = hljs.highlight(trimmed, { language: hlLang }).value;
  } else {
    highlighted = htmlEscape(trimmed);
  }
  const cls = language !== undefined ? ` class="language-${htmlEscape(language)}"` : '';
  // 复制按钮是 pre 的兄弟而非子节点：pre 内任何多余空白都会渲染成代码首行
  return `<div class="md-code-wrap"><button type="button" class="md-code-copy" tabindex="0"></button><pre class="md-code-block"><code${cls}>${highlighted}</code></pre></div>`;
}

/** 转义 HTML 特殊字符 */
function htmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * UTF-8 → base64（不依赖 Node Buffer / 浏览器 btoa，Node 与浏览器渲染进程通用）。
 * 编码结果与 Buffer.from(s, 'utf8').toString('base64') 一致，供前端 atob+TextDecoder 还原。
 */
const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function encodeBase64Utf8(s: string): string {
  const bytes: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x80) {
      bytes.push(cp);
    } else if (cp < 0x800) {
      bytes.push(0xc0 | (cp >> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      bytes.push(0xe0 | (cp >> 12), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      bytes.push(0xf0 | (cp >> 18), 0x80 | ((cp >> 12) & 0x3f), 0x80 | ((cp >> 6) & 0x3f), 0x80 | (cp & 0x3f));
    }
  }
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i]!;
    const b1 = bytes[i + 1];
    const b2 = bytes[i + 2];
    out += BASE64_CHARS[b0 >> 2];
    out += BASE64_CHARS[((b0 & 0x3) << 4) | ((b1 ?? 0) >> 4)];
    out += b1 === undefined ? '=' : BASE64_CHARS[((b1 & 0xf) << 2) | ((b2 ?? 0) >> 6)];
    out += b2 === undefined ? '=' : BASE64_CHARS[b2 & 0x3f];
  }
  return out;
}

marked.use({
  renderer: {
    code(token) {
      return codeRenderer(token.lang, token.text);
    },
    codespan(token) {
      return `<code class="md-inline-code">${htmlEscape(token.text)}</code>`;
    },
    // 字符画段落兜底：模型常不用任何围栏、直接在正文里画 ASCII 图。breaks 只保住
    // 换行，连续空格仍会被浏览器折叠，对齐照样全毁。呈字符画形态的段落整体转
    // <pre>（等宽 + pre 空白），用户看到的是完整可读的图而不是一坨管道符。
    // 返回 false 走 marked 默认段落渲染，普通正文零影响。
    paragraph(token) {
      const raw = token.text ?? '';
      if (looksLikeAsciiArt(raw, 2)) {
        return `<pre class="md-ascii">${htmlEscape(raw)}</pre>`;
      }
      return false;
    },
  },
});

/**
 * 渲染结果 LRU 缓存（v3.73 性能：点击大会话 221 条全量重渲染 5.1s → 命中即回）。
 *
 * 键 = 长度 + FNV-1a 32 位哈希 + 首/尾 48 字符采样：不用完整原文做键是为了避免
 * LRU 间接持有几百份 12KB 级消息文本。四元组同时碰撞的概率在会话场景可忽略；
 * 且即使碰撞，markdown 渲染差异也不是安全边界（XSS 已由 sanitize 白名单保证）。
 *
 * cacheable=false（流式中间态）只读不写：一次长回复的中间态多达数百个，写入会把
 * 稳定态历史挤出 LRU。
 */
const RENDER_CACHE_LIMIT = 400;
const renderCache = new Map<string, string>();

function fnv1a32(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

function cacheKey(source: string): string {
  const head = source.slice(0, 48);
  const tail = source.length > 96 ? source.slice(-48) : '';
  return `${source.length}:${fnv1a32(source)}:${head}:${tail}`;
}

/** 通用渲染：完整格式化（消息结束/历史回放）。cacheable=false 用于流式中间态。 */
export function renderMarkdown(source: string, cacheable = true): string {
  const key = cacheKey(source ?? '');
  const cached = renderCache.get(key);
  if (cached !== undefined) {
    // Map 迭代序即 LRU 序：命中后重插，保持「最近使用」在尾
    renderCache.delete(key);
    renderCache.set(key, cached);
    return cached;
  }
  const html = marked.parse(source ?? '', { async: false }) as string;
  const sanitized = sanitizeHtml(html, {
    allowedTags: ALLOWED_TAGS,
    allowedAttributes: ALLOWED_ATTRIBUTES,
    allowedSchemes: ['http', 'https', 'mailto'],
    allowProtocolRelative: false,
    // 只放行 hljs 主题 span / md-mermaid 占位 div，其余 class 移除（防止属性投毒）
    transformTags: {
      span: (tagName, attribs) => {
        const cls = sanitizeClass(attribs['class']);
        const next = { ...attribs };
        if (cls) {
          next['class'] = cls;
        } else {
          delete next['class'];
        }
        return { tagName, attribs: next } as never;
      },
      // 复制按钮只认本渲染器生成的那一个类：其余 button（用户手写的 HTML）降级为
      // span，且不带任何属性——渲染层只按 .md-code-copy 委托点击，认不得别的
      button: (tagName, attribs) => {
        const cls = sanitizeClass(attribs['class']);
        if (cls !== 'md-code-copy') return { tagName: 'span', attribs: {} } as never;
        return { tagName, attribs: { class: cls, type: 'button', tabindex: '0' } } as never;
      },
      // 链接白名单前移到标签转换：http/https/mailto 保留为 <a>（点击交渲染层拦截
      // → openExternal），其余（相对路径、#锚点、//协议相对、javascript: 等）整体
      // 降级为 span——模型爱写 [`docs/x.md`](docs/x.md) 当文档入口，这类死链不该
      // 有链接形态，更不该让窗口导航。
      a: (tagName, attribs) => {
        const href = attribs['href'] ?? '';
        if (/^(https?:|mailto:)/i.test(href)) {
          return { tagName, attribs } as never;
        }
        return { tagName: 'span', attribs: {} } as never;
      },
    },
  });
  if (cacheable) {
    if (renderCache.size >= RENDER_CACHE_LIMIT) {
      const oldest = renderCache.keys().next().value;
      if (oldest !== undefined) renderCache.delete(oldest);
    }
    renderCache.set(key, sanitized);
  }
  return sanitized;
}

/** 测试观测：当前渲染缓存条数 */
export function renderCacheSize(): number {
  return renderCache.size;
}

/** 测试与调试辅助：清空渲染缓存 */
export function clearRenderCache(): void {
  renderCache.clear();
}

/** 仅保留 hljs-* / md-* 前缀且字符安全的 class */
function sanitizeClass(cls: string | undefined): string | undefined {
  if (!cls) return undefined;
  const kept = cls.split(/\s+/).filter((c) => /^(hljs-|md-)/.test(c) && /^[a-zA-Z0-9_-]+$/.test(c));
  return kept.length > 0 ? kept.join(' ') : undefined;
}

/**
 * 校验字符串是否为可安全渲染的 mermaid 源码（前端渲染前粗校验，防止奇形输入）。
 * 失败不阻止显示原文，仅影响是否尝试渲染图表。
 */
export function looksLikeMermaid(source: string): boolean {
  const s = (source ?? '').trim();
  return s.length > 0 && s.length <= 8192;
}

/**
 * 围栏是否未闭合（按行扫描 GFM 围栏语法）。
 *
 * 为什么按行而不是全局数 ```：正文里行中提到「```canvas」这类词（模型解释自己为
 * 什么没出图，是常态）会把全局奇偶计数带偏——围栏明明闭合却判未闭合，终态下
 * canvas 骨架蒙版永远不撤（不会再有后续 token 来"闭合"它），界面假转圈。
 *
 * GFM 规则：开栏行 = 行首 ≤3 空格 + ≥3 个同字符（` 或 ~），可带信息串；闭栏行 =
 * 同字符、长度不小于开栏长度、行尾除空白外无别的。四反引号外壳包三反引号示例时，
 * 内层行因长度不足不会被误判为闭栏。
 *
 * 已知取舍：列表内缩进 ≥4 空格的围栏不参与判定（与缩进代码块无法行级区分），
 * 聊天场景围栏几乎都在顶层，可接受。
 */
export function hasOpenFence(source: string): boolean {
  let open: { ch: string; len: number } | null = null;
  for (const line of (source ?? '').split(/\r?\n/)) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (open === null) {
      if (m) open = { ch: m[1]![0]!, len: m[1]!.length };
    } else if (m && m[1]![0] === open.ch && m[1]!.length >= open.len && m[2]!.trim() === '') {
      open = null;
    }
  }
  return open !== null;
}