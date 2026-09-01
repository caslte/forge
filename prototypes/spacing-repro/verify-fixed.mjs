/** 验证修复后样式：统一纵向节奏（行距21 / 块间6 / 标题上14 / 卡片间18对称） */
import { chromium } from 'playwright';
import { renderMarkdown } from '../../packages/forge-core/dist/markdown/renderMarkdown.js';

const mdSource = `计费是否会重复叠加，是提交交付率来自一次的核心逻辑在 dist/core/agent-session.js 的 getContextUsage()。

## 计费方式

- 取自会话最后一条带 usage 的消息上报的 usage（provider 上报的 input + output + cacheRead + cacheWrite）
- 每次上调，\`local\` 纯本地，你自定义上下文裁剪带来的内容外的 token 估算值
- 两相加次减软议起变，scoped 上下文退订，显示在输入框旁边的 footer

## 是否真的会增值？—— 是（如缓存的）

每个 assistant 消息的 usage 均按 \`context tokens\` 总量选入 JSONL 文件，计数没有独立存储。

## 重开 App 服务后 —— 不会重置

一个原因是 compare 之前，计费 Totals 为 null/空，代码里会盖式返回 \`{ tokens: null }\`，等下一条消息返回自动修置。`;
const realHtml = renderMarkdown(mdSource);

// 与修复后 MessageCard.vue 一致的样式
const css = `
.msg-content { font-size: 14px; line-height: 1.5; word-break: break-word; }
.msg-content p,.msg-content h1,.msg-content h2,.msg-content h3,.msg-content h4,
.msg-content h5,.msg-content h6,.msg-content blockquote,.msg-content hr,
.msg-content pre,.msg-content ul,.msg-content ol,.msg-content table { margin: 0; margin-block-end: 6px; }
.msg-content .md-inline-code { padding: 1px 6px; border-radius: 6px; font-size: 12px; }
.msg-content ul,.msg-content ol { padding-left: 0; list-style-position: inside; }
.msg-content li { padding-left: 4px; line-height: 1.5; }
.msg-content li > p,.msg-content li li > p,.msg-content li > h1,.msg-content li > h2,
.msg-content li > h3,.msg-content li > h4,.msg-content li > h5,.msg-content li > h6,
.msg-content li > ul,.msg-content li > ol,.msg-content li > pre,
.msg-content li > blockquote,.msg-content li > table { margin: 0; }
.msg-content li + li { margin-top: 0; }
.msg-content h1,.msg-content h2,.msg-content h3,.msg-content h4,.msg-content h5,.msg-content h6 { margin-block-start: 14px; }
.msg-content :first-child { margin-block-start: 0; }
.msg-content :last-child { margin-block-end: 0; }
body { font-family: system-ui; margin: 20px; }
`;

const measure = () => {
  const root = document.querySelector('.msg-content');
  const kids = [...root.children];
  const gaps = [];
  for (let i = 0; i < kids.length - 1; i++) {
    const a = kids[i].getBoundingClientRect();
    const b = kids[i + 1].getBoundingClientRect();
    gaps.push({ between: `${kids[i].tagName.toLowerCase()}→${kids[i + 1].tagName.toLowerCase()}`, gap: +(b.top - a.bottom).toFixed(1) });
  }
  const ul = root.querySelector('ul');
  const lis = [...ul.querySelectorAll(':scope > li')];
  const lg = [];
  for (let i = 0; i < lis.length - 1; i++) lg.push(+(lis[i + 1].getBoundingClientRect().top - lis[i].getBoundingClientRect().bottom).toFixed(1));
  const last = kids[kids.length - 1].getBoundingClientRect();
  const r = root.getBoundingClientRect();
  return { gaps, liGaps: lg, trailing: +(r.bottom - last.bottom).toFixed(1) };
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<style>${css}</style><div class="msg-content">${realHtml}</div>`);
const res = await page.evaluate(measure);

// 消息流级：文字卡↔工具条对称性
const html1 = renderMarkdown('我先查一下 RPC 识别代码和 mock bridge，然后再确定修复方案：');
await page.setContent(`<style>${css}
  .conv { display: flex; flex-direction: column; gap: 16px; }
  .msg { padding: 2px 4px; }
  .tool-calls { border-radius: 12px; background: rgba(128,128,128,.25); }
  .tool-calls-head { padding: 8px 12px; font-size: 12px; }
</style>
<div class="conv">
  <div class="msg"><div class="msg-content">${html1}</div></div>
  <div class="tool-calls"><div class="tool-calls-head">工具调用</div></div>
  <div class="msg"><div class="msg-content">${html1}</div></div>
</div>`);
const sym = await page.evaluate(() => {
  const kids = [...document.querySelector('.conv').children];
  const visBottom = (el) => el.classList.contains('msg')
    ? Math.max(...[...el.querySelector('.msg-content').children].map((c) => c.getBoundingClientRect().bottom))
    : el.getBoundingClientRect().bottom;
  const visTop = (el) => el.classList.contains('msg')
    ? Math.min(...[...el.querySelector('.msg-content').children].map((c) => c.getBoundingClientRect().top))
    : el.getBoundingClientRect().top;
  return {
    textToChip: +(visTop(kids[1]) - visBottom(kids[0])).toFixed(1),
    chipToText: +(visTop(kids[2]) - visBottom(kids[1])).toFixed(1),
  };
});
await browser.close();

console.log('===== 修复后：顶层块间距 =====');
for (const g of res.gaps) console.log(`   ${g.between.padEnd(8)} ${g.gap}px`);
console.log(`   列表内 li→li: ${res.liGaps.join(', ')}px`);
console.log(`   尾部多余空隙: ${res.trailing}px`);
console.log(`===== 修复后：文字卡↔工具条 =====`);
console.log(`   文字→工具条 ${sym.textToChip}px / 工具条→文字 ${sym.chipToText}px`);
