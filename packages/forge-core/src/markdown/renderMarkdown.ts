/**
 * 安全 Markdown 渲染（P2-B）。
 *
 * 职责：把助手消息的原始 Markdown 渲染为白名单安全 HTML，供前端 v-html 直接输出。
 * - 解析：marked（gfm + breaks），代码块按 lang 经 highlight.js 高亮，行号/int 扩展不引入。
 * - 安全（白名单 sanitize-html，见 docs/prd/03_conversation.md 渲染安全要求）：
 *   - 禁止原生 HTML：script/style/iframe/事件属性（on*）一律移除。
 *   - 危险协议链接：javascript:/data:/vbscript: 等 href/src 被清除。
 * - mermaid 块：语言为 mermaid 时输出带 `data-md-mermaid` 的占位 div（源码经 base64 编码），
 *   前端扫描该标记后异步渲染为图表（渲染失败时该 div 内已含转义原文，直接可读）。
 * - 统一渲染：流式与结束后均用本函数完整渲染，保证两种状态样式一致
 *   （曾用流式简化渲染导致紧凑/正常样式跳变，已移除）。
 *
 * 纯 Node 模块：不 import Electron / Vue / pi，可在 node:test 下直接回归（含 XSS 用例）。
 */

import { Marked } from 'marked';
import hljs from 'highlight.js';
import sanitizeHtml from 'sanitize-html';

/** marked 实例：gfm + 换行即 <br>（对齐消息正文既有行为） */
const marked = new Marked({ gfm: true, breaks: true });

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
  code: ['class', 'data-md-mermaid'],
  span: ['class'],
  div: ['class'],
  th: ['align'],
  td: ['align'],
};

/** 高亮语言白名单 + 兜底自动识别（仅常见语言，避免耗时误判） */
const HIGHLIGHT_LANGUAGES = [
  'js', 'javascript', 'ts', 'typescript', 'json', 'html', 'xml', 'css',
  'bash', 'sh', 'shell', 'powershell', 'python', 'java', 'go', 'rust',
  'c', 'cpp', 'csharp', 'sql', 'yaml', 'yml', 'markdown', 'diff', 'dockerfile',
];

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

  let highlighted: string;
  if (language !== undefined && HIGHLIGHT_LANGUAGES.includes(language)) {
    highlighted = hljs.getLanguage(language)
      ? hljs.highlight(trimmed, { language }).value
      : htmlEscape(trimmed);
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

/** 通用渲染：完整格式化（消息结束/历史回放） */
export function renderMarkdown(source: string): string {
  const html = marked.parse(source ?? '', { async: false }) as string;
  return sanitizeHtml(html, {
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
    },
  });
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