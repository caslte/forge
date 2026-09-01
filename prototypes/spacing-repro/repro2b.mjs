/** 复现测试2b：量「可见文字块」与「工具条」之间的视觉间隙（而非卡片盒子边界） */
import { chromium } from 'playwright';
import { renderMarkdown } from '../../packages/forge-core/dist/markdown/renderMarkdown.js';

const html1 = renderMarkdown('我先查一下 RPC 识别代码和 mock bridge，然后再确定修复方案：');
const html2 = renderMarkdown('根据原因已确定，我来拆解这项工作并进行实现：');

const css = `
.conv-messages-inner { display: flex; flex-direction: column; gap: 16px; }
.current .msg-content { white-space: pre-wrap; }
.fixed .msg-content { white-space: normal; }
.msg { padding: 2px 4px; }
.msg-content { font-size: 14px; line-height: 1.5; word-break: break-word; }
.msg-content p { margin: 0; margin-block-end: 6px; }
.tool-calls { border-radius: 12px; background: rgba(128,128,128,.25); }
.tool-calls-head { display:flex; gap:8px; width:100%; padding: 8px 12px; font-size:12px; }
body { font-family: system-ui; margin: 20px; }
.case { max-width: 640px; margin-bottom: 30px; border-top: 1px dashed #999; padding-top: 6px; }
h4 { margin: 6px 0; }
`;

const measure = () => {
  const out = {};
  for (const scope of ['current', 'fixed']) {
    const inner = document.querySelector(`.${scope} .conv-messages-inner`);
    const kids = [...inner.children];
    const nameOf = (el) => (el.classList.contains('msg') ? '文字' : '工具条');
    // 可视底/顶：文字卡取内容最后/第一个块级元素的矩形；工具条取自身矩形
    const visBottom = (el) => el.classList.contains('msg')
      ? Math.max(...[...el.querySelector('.msg-content').children].map((c) => c.getBoundingClientRect().bottom))
      : el.getBoundingClientRect().bottom;
    const visTop = (el) => el.classList.contains('msg')
      ? Math.min(...[...el.querySelector('.msg-content').children].map((c) => c.getBoundingClientRect().top))
      : el.getBoundingClientRect().top;
    const gaps = [];
    for (let i = 0; i < kids.length - 1; i++) {
      gaps.push({
        between: `${nameOf(kids[i])}→${nameOf(kids[i + 1])}`,
        gap: +(visTop(kids[i + 1]) - visBottom(kids[i])).toFixed(1),
      });
    }
    out[scope] = gaps;
  }
  return out;
};

const browser = await chromium.launch();
const page = await browser.newPage();
const card = (h) => `<div class="msg"><div class="msg-bubble"><div class="msg-content">${h}</div></div></div>`;
const chip = (t) => `<div class="tool-calls"><div class="tool-calls-head">${t}</div></div>`;
await page.setContent(`<style>${css}</style>
  <div class="case current"><h4>现状 pre-wrap</h4><div class="conv-messages-inner">
    ${card(html1)}${chip('工具调用 1次 bash &lt;read&gt;')}${card(html2)}${chip('工具调用 1次 todo &lt;4&gt;')}
  </div></div>
  <div class="case fixed"><h4>对照 white-space: normal</h4><div class="conv-messages-inner">
    ${card(html1)}${chip('工具调用 1次 bash &lt;read&gt;')}${card(html2)}${chip('工具调用 1次 todo &lt;4&gt;')}
  </div></div>`);
const result = await page.evaluate(measure);
await browser.close();

for (const scope of ['current', 'fixed']) {
  console.log(`-- ${scope}:`);
  for (const g of result[scope]) console.log(`   ${g.between} 视觉间隙 ${g.gap}px`);
}
