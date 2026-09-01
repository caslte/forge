/**
 * 复现测试：消息正文块间距忽宽忽窄（用户截图 image1/image2）。
 * 方法：用项目真实 renderMarkdown 产出 HTML + MessageCard.vue 的原样样式，
 * 在无头 Chromium 里测量每种相邻块的真实垂直间隙（gap = next.top - prev.bottom）。
 */
import { chromium } from 'playwright';

// 1) 用项目真实渲染器生成 HTML（gfm + breaks + sanitize，与线上一致）
const { renderMarkdown } = await import('../../packages/forge-core/dist/markdown/renderMarkdown.js');

// 模拟截图 image1 的典型结构：加粗段、标题、无序列表、行内代码、普通段
const mdSource = `计费是否会重复叠加，是提交交付率来自一次的核心逻辑在 dist/core/agent-session.js 的 getContextUsage() 和 completion/completion.js 的 estimateTokenEstimate()。

## 计费方式

- 取自会话最后一条带 usage 的消息上报的 usage（provider 上报的 input + output + cacheRead + cacheWrite）
- 每次上调，\`local\` 纯本地，你自定义上下文裁剪带来的内容外的 token 估算值
- 两相加次减软议起变，scoped 上下文退订，显示在输入框旁边的 footer

## 是否真的会增值？—— 是（如缓存的）

每个 assistant 消息的 usage 均按 \`context tokens\` 总量选入 JSONL 文件（~/.pi/agent/sessions/，按工作目录分子目录存），计数没有独立存储，但你可从已存的自条中可回累算重数置。

## 重开 App 服务后 —— 不会重置

用 \`pi -c\` —— \`continue\` —— \`resume\` 单条会话时，会从 JSONL 重新加载并计算历史完整，只开方全新会话这个从 0 开始。

一个原因是 compare 之前， 千万一次 assistant 角色发的之前，计费 Totals 为 null/空 因为当前时的 usage 日不提供代表上下文大小，代码里会盖式返回 \`{ tokens: null }\`，等下一条消息返回自动修置。`;

const realHtml = renderMarkdown(mdSource);
console.log('===== marked 实际输出的 HTML（前 600 字符）=====');
console.log(JSON.stringify(realHtml.slice(0, 600)));
console.log();

// 2) 样式：逐条从 MessageCard.vue 搬运（:deep 转普通后代选择器）
const css = `
.msg-content { font-size: 14px; line-height: 1.5; word-break: break-word; }
.current .msg-content { white-space: pre-wrap; }        /* 现状 */
.fixed   .msg-content { white-space: normal; }          /* 仅改这一处做对比 */
.msg-content p,.msg-content h1,.msg-content h2,.msg-content h3,.msg-content h4,
.msg-content h5,.msg-content h6,.msg-content blockquote,.msg-content hr,
.msg-content pre,.msg-content ul,.msg-content ol,.msg-content table { margin: 0; margin-block-end: 6px; }
.msg-content .md-inline-code { padding: 1px 6px; border-radius: 6px; font-size: 12px; }
.msg-content ul,.msg-content ol { padding-left: 0; list-style-position: inside; margin-block-end: 4px; line-height: 10px; }
.msg-content li { padding-left: 4px; line-height: 1.5; }
.msg-content li > p,.msg-content li li > p,.msg-content li > h1,.msg-content li > h2,
.msg-content li > h3,.msg-content li > h4,.msg-content li > h5,.msg-content li > h6,
.msg-content li > ul,.msg-content li > ol,.msg-content li > pre,
.msg-content li > blockquote,.msg-content li > table { margin: 0; }
.msg-content li + li { margin-top: 0; }
body { font-family: system-ui; margin: 20px; }
.case { max-width: 640px; margin-bottom: 30px; border-top: 1px dashed #999; padding-top: 6px; }
h4 { margin: 6px 0; }
`;

// 3) 测量脚本：顶层元素两两求垂直 gap；列表内 li 两两求 gap；段内逐行测行高
const measure = () => {
  const out = {};
  for (const scope of ['current', 'fixed']) {
    const root = document.querySelector(`.${scope} .msg-content`);
    const kids = [...root.children];
    const gaps = [];
    for (let i = 0; i < kids.length - 1; i++) {
      const a = kids[i].getBoundingClientRect();
      const b = kids[i + 1].getBoundingClientRect();
      gaps.push({ between: `${kids[i].tagName.toLowerCase()}→${kids[i + 1].tagName.toLowerCase()}`, gap: +(b.top - a.bottom).toFixed(1) });
    }
    // 列表内部：li→li
    const ul = root.querySelector('ul');
    if (ul) {
      const lis = [...ul.querySelectorAll(':scope > li')];
      const lg = [];
      for (let i = 0; i < lis.length - 1; i++) {
        const a = lis[i].getBoundingClientRect();
        const b = lis[i + 1].getBoundingClientRect();
        lg.push(+(b.top - a.bottom).toFixed(1));
      }
      out[scope + '.liGaps'] = lg;
    }
    // 末尾尾随空行：最后一块的 bottom 到容器 content 底部
    const last = kids[kids.length - 1].getBoundingClientRect();
    const r = root.getBoundingClientRect();
    out[scope + '.trailingExtra'] = +(r.bottom - last.bottom).toFixed(1);
    out[scope + '.gaps'] = gaps;
    // 段落纯文本行高（取第一段第二行 baseline 差，用 Range 测行盒）
    const p = root.querySelector('p');
    const range = document.createRange();
    const textNode = p.firstChild;
    range.setStart(textNode, 0); range.setEnd(textNode, Math.min(20, textNode.length));
    out[scope + '.lineBoxH'] = +range.getBoundingClientRect().height.toFixed(1);
  }
  return out;
};

const browser = await chromium.launch();
const page = await browser.newPage();
await page.setContent(`<style>${css}</style>
  <div class="case current"><h4>现状 pre-wrap</h4><div class="msg-content">${realHtml}</div></div>
  <div class="case fixed"><h4>对照 white-space: normal</h4><div class="msg-content">${realHtml}</div></div>`);
const result = await page.evaluate(measure);
await browser.close();

console.log('===== 顶层块间距 gap(px) =====');
for (const k of ['current.gaps', 'fixed.gaps']) {
  console.log(`-- ${k}:`);
  for (const g of result[k]) console.log(`   ${g.between.padEnd(10)} ${g.gap}`);
}
console.log('===== 列表内 li→li gap =====');
console.log('current:', result['current.liGaps'], ' fixed:', result['fixed.liGaps']);
console.log('===== 段内行盒高度 =====');
console.log('current:', result['current.lineBoxH'], ' fixed:', result['fixed.lineBoxH']);
console.log('===== 尾随空白高度（最后一块下方多出的空隙）=====');
console.log('current:', result['current.trailingExtra'], ' fixed:', result['fixed.trailingExtra']);
