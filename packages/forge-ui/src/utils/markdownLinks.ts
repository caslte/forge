/**
 * Markdown 渲染区交互（消息正文 / Ask 预览 / 子代理输出等所有 v-html 出口共用）。
 *
 * 链接：renderMarkdown 已把非 http/https/mailto 的链接降级为 span（死链不成形），
 * 这里负责剩下的活：任何 <a> 点击一律 preventDefault——绝不让应用窗口导航
 * （window.forge 桥跟 URL 无关，导航走 = 把整套 IPC 能力交给外部页面）；
 * http/https/mailto 交主进程校验后经系统浏览器/邮件客户端打开。
 *
 * 代码块复制：renderMarkdown 给每个 ``` 围栏输出一枚空的 `.md-code-copy` 按钮
 * （纯 DOM 形态，图标走 CSS mask，见 global.css）。本模块负责两件事：
 * - decorateMarkdownHtml：把本地化 tooltip 注进渲染好的 HTML（core 是纯 Node 模块，
 *   拿不到 i18n，只能由渲染层补）；
 * - onMarkdownContentClick：委托点击 → 取同块 pre 的 textContent 写剪贴板，
 *   成功即翻成 is-copied 回执态。
 */
import { i18n } from '../i18n/index.ts';

/** 复制回执态时长（与消息 footer 的复制反馈保持一致） */
const COPIED_MS = 1400;

/** 各按钮的重置计时器（元素随 v-html 重渲染整批替换，WeakMap 免清理） */
const copyTimers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();

/** 给渲染好的 HTML 里的复制按钮补本地化 tooltip（在 sanitize 之后，只碰自有标记） */
export function decorateMarkdownHtml(html: string): string {
  return html.replace(
    /class="md-code-copy"/g,
    `class="md-code-copy" data-tooltip="${i18n.t('chat.copyCode')}"`,
  );
}

export function onMarkdownContentClick(e: MouseEvent): void {
  const el = e.target instanceof Element ? e.target : null;
  const btn = el?.closest('.md-code-copy');
  if (btn instanceof HTMLElement) {
    void copyCodeBlock(btn);
    return;
  }
  const a = el?.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') ?? '';
  if (/^(https?:|mailto:)/i.test(href)) {
    void window.forge.shell.openExternal(href);
  }
  // 其余（理论上到不了这里，渲染层已降级）= 死链，无动作
}

/** 复制代码块原文：按钮与 pre 是 .md-code-wrap 的兄弟，取 code 的 textContent */
async function copyCodeBlock(btn: HTMLElement): Promise<void> {
  const text = btn.parentElement?.querySelector('pre code')?.textContent ?? '';
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    return;
  }
  showCopied(btn);
}

function showCopied(btn: HTMLElement): void {
  btn.classList.add('is-copied');
  btn.setAttribute('data-tooltip', i18n.t('chat.copied'));
  const pending = copyTimers.get(btn);
  if (pending) clearTimeout(pending);
  copyTimers.set(
    btn,
    setTimeout(() => {
      btn.classList.remove('is-copied');
      btn.setAttribute('data-tooltip', i18n.t('chat.copyCode'));
      copyTimers.delete(btn);
    }, COPIED_MS),
  );
}
