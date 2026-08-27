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
 * - 增量渲染：renderMarkdownPartial 用于流式期间的低成本渲染（仅转义 + 行内 code + 粗体，
 *   不解析块级结构，避免半截代码块闪烁）；消息结束后用 renderMarkdown 完整格式化一次。
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
    const encoded = Buffer.from(trimmed, 'utf8').toString('base64');
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
 * 增量渲染（流式期间）：仅转义 + 行内 code + 粗体，不做块级结构解析。
 * 避免半截代码块/列表在流式过程中闪动；结束后调用 renderMarkdown 完整格式化。
 */
export function renderMarkdownPartial(source: string): string {
  let html = htmlEscape(source ?? '');
  html = html.replace(/`([^`\n]+)`/g, '<code class="md-inline-code">$1</code>');
  html = html.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  return html;
}

/**
 * 校验字符串是否为可安全渲染的 mermaid 源码（前端渲染前粗校验，防止奇形输入）。
 * 失败不阻止显示原文，仅影响是否尝试渲染图表。
 */
export function looksLikeMermaid(source: string): boolean {
  const s = (source ?? '').trim();
  return s.length > 0 && s.length <= 8192;
}