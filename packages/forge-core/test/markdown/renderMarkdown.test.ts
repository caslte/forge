import { test } from 'node:test';
import assert from 'node:assert/strict';

import { renderMarkdown, renderMarkdownPartial, looksLikeMermaid } from '../../src/markdown/renderMarkdown.ts';

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
  // 链接本身被降级为无 href 的文本（sanitize-html 去掉危险 href）
  assert.match(html, /<a[^>]*>点我<\/a>/);
});

test('XSS：data: 链接被清除', () => {
  const html = renderMarkdown('[bad](data:text/html,<script>alert(1)</script>)');
  assert.doesNotMatch(html, /data:/i);
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

test('增量渲染：流式片段只转义与行内格式', () => {
  const html = renderMarkdownPartial('半截代码块 ```js\nconst a =');
  assert.doesNotMatch(html, /<pre/);
  assert.match(html, /```js/);
  assert.doesNotMatch(html, /<script/i);
});

test('增量渲染：合法的行内 code / 加粗保留', () => {
  const html = renderMarkdownPartial('用 `x` 表示 **重要**');
  assert.match(html, /md-inline-code/);
  assert.match(html, /<strong>重要<\/strong>/);
});

test('looksLikeMermaid 边界', () => {
  assert.ok(looksLikeMermaid('graph TD\n  A --> B'));
  assert.ok(!looksLikeMermaid(''));
  assert.ok(!looksLikeMermaid('x'.repeat(9000)));
});

test('XSS：非 hljs/md 前缀的 class 被剥离', () => {
  const html = renderMarkdown('<span class="hljs-keyword evil" style="display:none">x</span>');
  assert.match(html, /class="hljs-keyword"/);
  assert.doesNotMatch(html, /evil/);
  assert.doesNotMatch(html, /style=/);
});