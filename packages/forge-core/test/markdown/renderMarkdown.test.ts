import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, looksLikeMermaid, hasOpenFence, renderCacheSize, clearRenderCache } from '../../src/markdown/renderMarkdown.ts';

test('字符画段落整体转 <pre class="md-ascii">，等宽保对齐', () => {
  clearRenderCache();
  const art = '| off |   | low |   | high |\n|___更牙___|___|___|\n| 排查 | 原因 | 处置 |';
  const html = renderMarkdown(`标题行\n\n${art}\n\n收尾说明`);
  assert.match(html, /<pre class="md-ascii">/);
  assert.match(html, /\| off \|   \| low \|/);
  assert.ok(!html.includes('<p>| off |'));
});

test('普通硬换行散文不受字符画判定影响，仍渲染为段落', () => {
  clearRenderCache();
  const html = renderMarkdown('第一行普通文字\n第二行 off | low | high 单管道分隔\n第三行收尾  ');
  assert.match(html, /<p>第一行普通文字<br \/>/);
  assert.ok(!html.includes('md-ascii'));
});

test('常见 Markdown 结构正确渲染', () => {
  const html = renderMarkdown('# 标题\n\n**加粗** *斜体* `行内码`\n\n- 列表项\n- 第二项\n\n> 引用');
  assert.match(html, /<h1[^>]*>标题<\/h1>/);
  assert.match(html, /<strong>加粗<\/strong>/);
  assert.match(html, /<em>斜体<\/em>/);
  assert.match(html, /<code class="md-inline-code"/);
  assert.match(html, /<ul>/);
  assert.match(html, /<blockquote>/);
});

test('代码块按语言高亮并保留离线可读性', () => {
  const html = renderMarkdown('```js\nconst a = 1;\n```');
  assert.match(html, /<pre class="md-code-block"/);
  assert.match(html, /language-js/);
  // hljs 注入主题 class（span 高亮）
  assert.match(html, /hljs-/);
  // 原文仍可读（关键字被 span 包裹，但完整单词保留）
  assert.match(html, /const<\/span>/);
  assert.match(html, /1/);
});

test('未知语言代码块不崩溃并保留原文', () => {
  const html = renderMarkdown('```nolangxyz\nraw <text>\n```');
  assert.match(html, /&lt;text&gt;/);
  assert.match(html, /raw/);
});

test('代码块自带复制按钮（渲染层按 .md-code-copy 委托点击）', () => {
  const html = renderMarkdown('```bash\nfor f in *.tar; do echo "$f"; done\n```');
  assert.match(html, /<div class="md-code-wrap">/);
  assert.match(html, /<button[^>]*class="md-code-copy"/);
  // 按钮是 pre 的兄弟：pre 内的空白会渲染成代码首行的空行
  assert.match(html, /<\/button><pre class="md-code-block"><code/);
});

test('mermaid / canvas 围栏不套复制按钮（各自有渲染形态）', () => {
  clearRenderCache();
  assert.doesNotMatch(renderMarkdown('```mermaid\ngraph TD\n  A --> B\n```'), /md-code-copy/);
  clearRenderCache();
  assert.doesNotMatch(renderMarkdown('```canvas\n<div>x</div>\n```'), /md-code-copy/);
});

test('XSS：用户手写的 button 降级为 span，不带属性', () => {
  const html = renderMarkdown('<button onclick="alert(1)" class="evil">点我</button>');
  assert.doesNotMatch(html, /<button/i);
  assert.doesNotMatch(html, /onclick/i);
  assert.doesNotMatch(html, /md-code-copy/);
});

test('XSS：script 标签被移除', () => {
  const html = renderMarkdown('前文\n\n<script>alert(1)</script>\n\n后文');
  assert.doesNotMatch(html, /<script/i);
});

test('XSS：事件属性被移除', () => {
  const html = renderMarkdown('<img src=x onerror=alert(1)>');
  assert.doesNotMatch(html, /onerror/i);
  assert.doesNotMatch(html, /<script/i);
});

test('XSS：javascript: 链接被清除', () => {
  const html = renderMarkdown('[点我](javascript:alert(1))');
  assert.doesNotMatch(html, /javascript:/i);
  // 非白名单协议整体降级为 span：连 <a> 外壳都不保留（防无 href 的伪链接形态）
  assert.doesNotMatch(html, /<a[\s>]/);
  assert.match(html, /<span[^>]*>点我<\/span>|点我/);
});

test('XSS：data: 链接被清除', () => {
  const html = renderMarkdown('[bad](data:text/html,<script>alert(1)</script>)');
  assert.doesNotMatch(html, /data:/i);
});

test('相对路径链接降级为纯文本（模型写的文档入口死链不成链接）', () => {
  const html = renderMarkdown('[`docs/overview.md`](docs/overview.md)');
  assert.doesNotMatch(html, /<a[\s>]/);
  assert.doesNotMatch(html, /href=/);
  // 行内代码胶囊保留，下划线来源（a）消失
  assert.match(html, /<code class="md-inline-code">docs\/overview\.md<\/code>/);
});

test('协议相对链接（//evil）降级为纯文本', () => {
  const html = renderMarkdown('[x](//evil.example.com/a)');
  assert.doesNotMatch(html, /<a[\s>]/);
  assert.doesNotMatch(html, /evil\.example\.com/);
});

test('锚点链接降级为纯文本', () => {
  const html = renderMarkdown('[跳转](#section-1)');
  assert.doesNotMatch(html, /<a[\s>]/);
});

test('合法 https 链接保留', () => {
  const html = renderMarkdown('[官方](https://pi.earendil.dev)');
  assert.match(html, /href="https:\/\/pi\.earendil\.dev"/);
});

test('mailto 链接保留', () => {
  const html = renderMarkdown('[邮件](mailto:someone@example.com)');
  assert.match(html, /href="mailto:someone@example\.com"/);
});

test('XSS：链接 text 中夹带 HTML 被转义', () => {
  const html = renderMarkdown('[<b>粗</b>](https://ok.example) 与 **加粗**');
  // marked 会把链接文本当作普通文本，粗体标签最大程度保留语义
  assert.doesNotMatch(html, /<b>/);
});

test('合法 https 链接保留', () => {
  const html = renderMarkdown('[官方](https://pi.earendil.dev)');
  assert.match(html, /href="https:\/\/pi\.earendil\.dev"/);
});

test('mermaid 块输出占位与编码源码', () => {
  const html = renderMarkdown('```mermaid\ngraph TD\n  A --> B\n```');
  assert.match(html, /md-mermaid/);
  assert.match(html, /graph TD/);
  const encoded = html.match(/data-md-mermaid="([^"]+)"/)?.[1];
  assert.ok(encoded);
  const decoded = Buffer.from(encoded!, 'base64').toString('utf8');
  assert.match(decoded, /A --> B/);
});

test('mermaid 编码含非 ASCII（UTF-8 往返一致，与 Buffer 编码等价）', () => {
  const html = renderMarkdown('```mermaid\ngraph TD\n  A[用户输入] --> B[结果输出]\n```');
  const encoded = html.match(/data-md-mermaid="([^"]+)"/)?.[1];
  assert.ok(encoded);
  const decoded = Buffer.from(encoded!, 'base64').toString('utf8');
  assert.match(decoded, /用户输入/);
  // 等价性：与 Node Buffer 编码结果完全一致（前端解码端兼容）
  const expected = Buffer.from('graph TD\n  A[用户输入] --> B[结果输出]', 'utf8').toString('base64');
  assert.equal(encoded, expected);
});

test('空输入安全', () => {
  assert.doesNotThrow(() => renderMarkdown(''));
  assert.ok(renderMarkdown('') !== '<script>');
});

test('流式片段（半截代码块）走完整渲染，样式与结束后一致', () => {
  // 未闭合围栏解析为到末尾的代码块，不崩溃、安全转义，且与最终渲染同一套输出
  const html = renderMarkdown('前文\n\n```js\nconst a =');
  assert.match(html, /<pre class="md-code-block"/);
  assert.match(html, /language-js/);
  assert.match(html, /a =/);
  assert.doesNotMatch(html, /<script/i);
});

test('looksLikeMermaid 边界', () => {
  assert.ok(looksLikeMermaid('graph TD\n  A --> B'));
  assert.ok(!looksLikeMermaid(''));
  assert.ok(!looksLikeMermaid('x'.repeat(9000)));
});

test('hasOpenFence：围栏闭合检测（流式 mermaid 展示源码的依据）', () => {
  assert.ok(!hasOpenFence(''));
  assert.ok(!hasOpenFence('```js\nconst a = 1;\n```'));
  assert.ok(hasOpenFence('```mermaid\ngraph TD\n  A --> B'));
  // 前块已闭合 + 末块未闭合 → 按行扫描第二个围栏未闭合
  assert.ok(hasOpenFence('```js\na;\n```\n\n```mermaid\ngraph TD'));
  // 两个已闭合块 → 全闭合
  assert.ok(!hasOpenFence('```js\na;\n```\n\n```py\nb;\n```'));
});

test('hasOpenFence：正文行中提到 ```canvas 等词不算围栏（终态骨架不假转圈）', () => {
  // 曾按全局 ``` 计数：正文 1 次 + 真围栏 2 次 = 3 → 误判未闭合，
  // 消息结束后 canvas 骨架蒙版永远不撤。行中三反引号不是围栏行。
  assert.ok(!hasOpenFence(
    '但回复正文里没有任何 ```canvas 围栏——界面只能看到文字。\n\n```canvas\n<div>x</div>\n```\n',
  ));
  assert.ok(!hasOpenFence('正文里 ```canvas 和 ```mermaid 都是行内提及，不是围栏'));
});

test('hasOpenFence：GFM 围栏细则（四反引号外壳 / 波浪线 / 闭栏行尾）', () => {
  // 四反引号外壳包三反引号：内层行长度不足，不是闭栏（全局计数会把这里数错）
  assert.ok(!hasOpenFence('````md\n```js\nx\n````\n'));
  // 波浪线围栏与反引号围栏互不闭合
  assert.ok(hasOpenFence('~~~\ncontent'));
  assert.ok(!hasOpenFence('~~~\ncontent\n~~~'));
  assert.ok(hasOpenFence('```js\na;\n~~~'));
  // 闭栏行允许尾随空白，不允许带别的字符
  assert.ok(!hasOpenFence('```js\na;\n```   \n'));
  assert.ok(hasOpenFence('```js\na;\n```js'));
});

test('XSS：非 hljs/md 前缀的 class 被剥离', () => {
  const html = renderMarkdown('<span class="hljs-keyword evil" style="display:none">x</span>');
  assert.match(html, /class="hljs-keyword"/);
  assert.doesNotMatch(html, /evil/);
  assert.doesNotMatch(html, /style=/);
});

test('缓存：同内容二次渲染命中（不新增条目，输出一致）', () => {
  clearRenderCache();
  const src = '# 缓存命中\n\n```js\nconst x = 1;\n```';
  const first = renderMarkdown(src);
  assert.equal(renderCacheSize(), 1);
  const second = renderMarkdown(src);
  assert.equal(renderCacheSize(), 1);
  assert.equal(second, first);
});

test('缓存：cacheable=false（流式中间态）只读不写', () => {
  clearRenderCache();
  const before = renderCacheSize();
  const html = renderMarkdown('# 流式中间态\n\n```js\nconst y =', false);
  assert.ok(html.length > 0);
  assert.equal(renderCacheSize(), before);
});

test('缓存：LRU 上限 400，超限淘汰最旧且冷渲染输出仍正确', () => {
  clearRenderCache();
  for (let i = 0; i < 402; i += 1) {
    renderMarkdown(`# 条目 ${i}\n\n内容 ${i}`);
  }
  assert.equal(renderCacheSize(), 400);
  assert.match(renderMarkdown('# 条目 0\n\n内容 0'), /内容 0/);
});