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
 *   不可劫持——画布围栏只用 canvas 这一个语言名。
 * - 统一渲染：流式与结束后均用本函数完整渲染，保证两种状态样式一致
 *   （曾用流式简化渲染导致紧凑/正常样式跳变，已移除）。
 *
 * 纯 Node 模块：不 import Electron / Vue / pi，可在 node:test 下直接回归（含 XSS 用例）。
 */

import { Marked } from 'marked';
import { hljs } from './hljsCore.ts';
import sanitizeHtml from 'sanitize-html';

import { CANVAS_LANGUAGE } from './canvasSandbox.ts';

/** marked 实例：gfm + 换行即 <br>（对齐消息正文既有行为） */
const marked = new Marked({ gfm: true, breaks: true });

export {
  CANVAS_LANGUAGE,
  CANVAS_DEFAULT_HEIGHT,
  CANVAS_TALL_HEIGHT,
  looksLikeHtmlCanvas,
  buildCanvasDocument,
  buildCanvasStandaloneFile,
  type CanvasTokens,
} from './canvasSandbox.ts';

/** 白名单标签（sanitize-html allowedTags） */
const ALLOWED_TAGS = [
  'p', 'br', 'hr', 'strong', 'em', 'del', 'code', 'pre', 'blockquote',
  'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'a', 'img', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'span', 'div',
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
  return `<pre class="md-code-block"><code${cls}>${highlighted}</code></pre>`;
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
 * 围栏是否未闭合（``` 计数为奇数）：未闭合围栏会吞到文末，故末块必是未闭合的那个。
 * 流式期间用于：末尾 mermaid 块先按源码展示，闭合后再渲染图表，避免半截源码反复渲染失败。
 * ponytail: 按计数奇偶判断，正文里出现行内三反引号（非围栏）会误判，聊天场景罕见，可接受。
 */
export function hasOpenFence(source: string): boolean {
  return ((source ?? '').match(/```/g)?.length ?? 0) % 2 === 1;
}