/** 终版验证：10px/16px 全场景块间距（含代码块、表格、引用） */
import { chromium } from 'playwright';
import { renderMarkdown } from '../../packages/forge-core/dist/markdown/renderMarkdown.js';
import fs from 'node:fs';

let md = fs.readFileSync(new URL('./history-msg.md', import.meta.url), 'utf8').replace(/<think>[\s\S]*?<\/think>\s*/, '');
md += '\n\n代码块示例：\n\n```json\n{\n  "reasoning": true\n}\n```\n\n| 字段 | 值 |\n|---|---|\n| reasoning | true |\n';
const html = renderMarkdown(md);

const css = `
.msg-content { font-size: 14px; line-height: 1.5; word-break: break-word; }
.msg-content p,.msg-content h1,.msg-content h2,.msg-content h3,.msg-content h4,
.msg-content h5,.msg-content h6,.msg-content blockquote,.msg-content hr,
.msg-content pre,.msg-content ul,.msg-content ol,.msg-content table { margin: 0; margin-block-end: 12px; }
.msg-content .md-inline-code { padding: 1px 6px; border-radius: 6px; font-size: 12px; }
.msg-content ul,.msg-content ol { padding-left: 0; list-style-position: inside; }
.msg-content li { padding-left: 4px; line-height: 1.5; }
.msg-content li > p,.msg-content li > h1,.msg-content li > h2,.msg-content li > h3,.msg-content li > h4,
.msg-content li > h5,.msg-content li > h6,.msg-content li > ul,.msg-content li > ol,
.msg-content li > pre,.msg-content li > blockquote,.msg-content li > table { margin: 0; }
.msg-content li + li { margin-top: 0; }
.msg-content h1,.msg-content h2,.msg-content h3,.msg-content h4,.msg-content h5,.msg-content h6 { margin-block-start: 18px; }
.msg-content :first-child { margin-block-start: 0; }
.msg-content :last-child { margin-block-end: 0; }
.msg-content pre { background: rgba(128,128,128,.12); padding: 10px 12px; margin: 12px 0; }
.msg-content table { border-collapse: collapse; margin: 12px 0; }
body { font-family: system-ui; margin: 16px; }
`;
const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<style>${css}</style><div class="msg-content">${html}</div>`);
const res = await page.evaluate(() => {
  const root = document.querySelector('.msg-content');
  const kids = [...root.children];
  const gaps = [];
  for (let i = 0; i < kids.length - 1; i++) {
    gaps.push(+(kids[i + 1].getBoundingClientRect().top - kids[i].getBoundingClientRect().bottom).toFixed(1));
  }
  return { gaps: [...new Set(gaps)].sort((a, b) => a - b), h: +root.getBoundingClientRect().height.toFixed(0) };
});
await browser.close();
console.log(`总高 ${res.h}px，全场景块间距集合 {${res.gaps.join(', ')}}px（18=标题上方，其余应全为 10）`);
