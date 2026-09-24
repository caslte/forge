/**
 * Markdown 渲染区链接点击拦截（消息正文 / Ask 预览等所有 v-html 出口共用）。
 *
 * 背景：renderMarkdown 已把非 http/https/mailto 的链接降级为 span（死链不成形），
 * 这里负责剩下的活：任何 <a> 点击一律 preventDefault——绝不让应用窗口导航
 * （window.forge 桥跟 URL 无关，导航走 = 把整套 IPC 能力交给外部页面）；
 * http/https/mailto 交主进程校验后经系统浏览器/邮件客户端打开。
 */
export function onMarkdownContentClick(e: MouseEvent): void {
  const el = e.target instanceof Element ? e.target : null;
  const a = el?.closest('a');
  if (!a) return;
  e.preventDefault();
  const href = a.getAttribute('href') ?? '';
  if (/^(https?:|mailto:)/i.test(href)) {
    void window.forge.shell.openExternal(href);
  }
  // 其余（理论上到不了这里，渲染层已降级）= 死链，无动作
}
