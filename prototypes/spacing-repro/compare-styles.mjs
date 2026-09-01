/** 对比：A 旧版(bug pre-wrap) / B 当前(6px) / C 建议(10px+标题16px)，用真实历史消息实测 */
import { chromium } from 'playwright';
import { renderMarkdown } from '../../packages/forge-core/dist/markdown/renderMarkdown.js';
import fs from 'node:fs';

let md = fs.readFileSync(new URL('./history-msg.md', import.meta.url), 'utf8');
md = md.replace(/<think>[\s\S]*?<\/think>\s*/, ''); // 应用历史加载时已剥离思考块
const html = renderMarkdown(md);

const base = `
.msg-content { font-size: 14px; line-height: 1.5; word-break: break-word; }
.msg-content p,.msg-content h1,.msg-content h2,.msg-content h3,.msg-content h4,
.msg-content h5,.msg-content h6,.msg-content blockquote,.msg-content hr,
.msg-content pre,.msg-content ul,.msg-content ol,.msg-content table { margin: 0; margin-block-end: 6px; }
.msg-content .md-inline-code { padding: 1px 6px; border-radius: 6px; font-size: 12px; }
.msg-content li { padding-left: 4px; line-height: 1.5; }
.msg-content li > p,.msg-content li li > p,.msg-content li > ul,.msg-content li > ol,
.msg-content li > pre,.msg-content li > blockquote,.msg-content li > table,
.msg-content li > h1,.msg-content li > h2,.msg-content li > h3,.msg-content li > h4,
.msg-content li > h5,.msg-content li > h6 { margin: 0; }
.msg-content li + li { margin-top: 0; }
.msg-content :first-child { margin-block-start: 0; }
.msg-content :last-child { margin-block-end: 0; }
body { font-family: system-ui; margin: 16px; }
.case { max-width: 660px; border: 1px solid #ccc; padding: 12px; margin-bottom: 24px; }
.cap { font: bold 13px system-ui; margin-bottom: 8px; color:#333 }
`;
// A 旧版：pre-wrap + ul line-height:10px + ul margin 4px
const cssA = `${base}
.A .msg-content { white-space: pre-wrap; }
.A .msg-content ul, .A .msg-content ol { margin-block-end: 4px; line-height: 10px; }`;
// B 当前：normal + 6px + 标题上 14px
const cssB = `${base}
.B .msg-content { white-space: normal; }
.B .msg-content h1,.B .msg-content h2,.B .msg-content h3,.B .msg-content h4,.B .msg-content h5,.B .msg-content h6 { margin-block-start: 14px; }`;
// C 建议：normal + 块间 10px + 标题上 16px
const cssC = `${base}
.C .msg-content { white-space: normal; }
.C .msg-content p,.C .msg-content h1,.C .msg-content h2,.C .msg-content h3,.C .msg-content h4,
.C .msg-content h5,.C .msg-content h6,.C .msg-content blockquote,.C .msg-content hr,
.C .msg-content pre,.C .msg-content ul,.C .msg-content ol,.C .msg-content table { margin-block-end: 10px; }
.C .msg-content h1,.C .msg-content h2,.C .msg-content h3,.C .msg-content h4,.C .msg-content h5,.C .msg-content h6 { margin-block-start: 16px; }`;

const measure = () => {
  const out = {};
  for (const s of ['A', 'B', 'C']) {
    const root = document.querySelector(`.${s} .msg-content`);
    const kids = [...root.children];
    const gaps = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect(), b = kids[i + 1].getBoundingClientRect();
      gaps.push(+(b.top - a.bottom).toFixed(1));
    }
    out[s] = {
      totalH: +root.getBoundingClientRect().height.toFixed(0),
      gapSet: [...new Set(gaps)].sort((a, b) => a - b),
    };
  }
  return out;
};

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 760, height: 900 } });
await page.setContent(`<style>${cssA}${''}</style><style>${cssB}</style><style>${cssC}</style>
  <div class="case A"><div class="cap">A · 旧版（pre-wrap bug，修复前你看到的「松」）</div><div class="msg-content">${html}</div></div>
  <div class="case B"><div class="cap">B · 当前（块间 6px，你觉得「紧凑」）</div><div class="msg-content">${html}</div></div>
  <div class="case C"><div class="cap">C · 建议校准（块间 10px，标题上 16px）</div><div class="msg-content">${html}</div></div>`);
const res = await page.evaluate(measure);
await page.screenshot({ path: 'prototypes/spacing-repro/compare.png', fullPage: true });
await browser.close();

for (const s of ['A', 'B', 'C']) {
  console.log(`${s}: 总高 ${res[s].totalH}px, 块间距集合 {${res[s].gapSet.join(', ')}}px`);
}
console.log('截图: prototypes/spacing-repro/compare.png');
