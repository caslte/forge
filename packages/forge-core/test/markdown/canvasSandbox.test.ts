/**
 * 画布卡片渲染层（契约 docs/plan/canvas-card.md）。
 *
 * 守四件事：
 * 1. ```canvas 围栏出 data-md-canvas 占位，且 sanitize 不吃掉该属性（吃掉就永远不出卡片）；
 * 2. ```html 围栏不被劫持（模型展示 HTML 代码示例是常态，误渲染成卡片是回归）；
 * 3. 占位里的 base64 与源码 UTF-8 往返一致（中文标注不能乱码）；
 * 4. looksLikeHtmlCanvas 降级判据：JS/纯文本 false，残缺 HTML true。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  CANVAS_DEFAULT_HEIGHT,
  CANVAS_LANGUAGE,
  CANVAS_TALL_HEIGHT,
  buildCanvasDocument,
  buildCanvasStandaloneFile,
  clearRenderCache,
  looksLikeAsciiArt,
  looksLikeHtmlCanvas,
  renderMarkdown,
} from '../../src/markdown/renderMarkdown.ts';

const TOKENS = {
  bg: 'oklch(0.26 0.006 286.2)',
  fg: 'oklch(0.88 0.002 286.3)',
  muted: 'oklch(0.3 0.005 286.2)',
  mutedFg: 'oklch(0.7 0.008 286.3)',
  surface: 'oklch(0.3 0.005 286.2)',
  border: 'oklch(0.32 0.005 286.3)',
  ok: 'oklch(0.72 0.14 145)',
  warn: 'oklch(0.8 0.14 85)',
  bad: 'oklch(0.7 0.18 27.325)',
  accent: 'oklch(0.78 0.1 170)',
};

function decodeAttr(encoded: string): string {
  return Buffer.from(encoded, 'base64').toString('utf8');
}

test('canvas 围栏输出占位，data-md-canvas 在 sanitize 白名单内存活', () => {
  clearRenderCache();
  const out = renderMarkdown('```canvas\n<div class="x">hi</div>\n```');
  assert.match(out, /<pre class="md-canvas-wrap"><code class="md-canvas" data-md-canvas="/);
});

test('canvas 占位 base64 与源码 UTF-8 往返一致（中文标注不乱码）', () => {
  clearRenderCache();
  const src = '<div>登录接口防爆破机制 · 报告模型 vs 代码实际链路</div>';
  const out = renderMarkdown(`\`\`\`canvas\n${src}\n\`\`\``);
  const encoded = out.match(/data-md-canvas="([^"]+)"/)![1]!;
  assert.equal(decodeAttr(encoded), src);
});

test('canvas 源码里的 script 不会以可执行形态出现在宿主 HTML 中', () => {
  clearRenderCache();
  const out = renderMarkdown('```canvas\n<div>a</div><script>alert(1)</script>\n```');
  // 宿主侧只应看到 base64 与转义兜底文本，不应出现裸 <script>
  assert.ok(!out.includes('<script>'));
  assert.ok(out.includes('&lt;script&gt;'));
});

test('```html 围栏不被劫持，仍走高亮展示源码', () => {
  clearRenderCache();
  const out = renderMarkdown('```html\n<div>x</div>\n```');
  assert.ok(!out.includes('data-md-canvas'));
  assert.match(out, /<pre class="md-code-block"><code class="language-html"/);
  // ```html 是「给项目写示例」的常态，同样要有复制入口
  assert.match(out, /<button[^>]*class="md-code-copy"/);
});

test('mermaid 与 canvas 共存时互不干扰', () => {
  clearRenderCache();
  const out = renderMarkdown('```mermaid\ngraph TD;A-->B;\n```\n\n```canvas\n<div>c</div>\n```');
  assert.equal((out.match(/data-md-mermaid="/g) ?? []).length, 1);
  assert.equal((out.match(/data-md-canvas="/g) ?? []).length, 1);
});

test('高度档位：骨架蒙版与终态同高（跳变即回归）', () => {
  assert.equal(CANVAS_DEFAULT_HEIGHT, 320);
  assert.ok(CANVAS_TALL_HEIGHT > CANVAS_DEFAULT_HEIGHT);
});

test('looksLikeHtmlCanvas：JS 源码与纯文本判 false（降级代码块）', () => {
  assert.equal(looksLikeHtmlCanvas('const a = 1;\nif (a > 0) { throw new Error("x"); }'), false);
  assert.equal(looksLikeHtmlCanvas('就是一段说明文字，没有任何标签'), false);
  assert.equal(looksLikeHtmlCanvas(''), false);
});

test('looksLikeHtmlCanvas：完整与残缺 HTML 都判 true（残缺交给浏览器补闭合）', () => {
  assert.equal(looksLikeHtmlCanvas('<div>ok</div>'), true);
  assert.equal(looksLikeHtmlCanvas('<div style="color:red">写到一半'), true);
  assert.equal(looksLikeHtmlCanvas('<table><tr><td>a'), true);
});

test('looksLikeHtmlCanvas：薄 HTML 壳包 ASCII 字符画判 false（进 iframe 会被空白规则压毁）', () => {
  const art = [
    '<div style="font:13px sans-serif">',
    '| off |   | low |   | high |',
    '|___更牙___|___|___| 【A: Codex 共分镜清单】',
    '| 排查 | 原因 | 处置 |',
    '|__|__|__| 【B】 放桌 —— 上方原值展开',
    '</div>',
  ].join('\n');
  assert.equal(looksLikeHtmlCanvas(art), false);
  // 无壳的纯字符画同理
  assert.equal(looksLikeHtmlCanvas(art.replace('<div style="font:13px sans-serif">\n', '').replace('</div>', '')), false);
});

test('looksLikeHtmlCanvas：真 HTML 卡片即使文本里带少量管道也不误降级', () => {
  assert.equal(
    looksLikeHtmlCanvas('<div class="row"><div>方案A | 高对比</div><div>方案B</div><div>方案C</div></div>'),
    true,
  );
  // 标签间排版缩进不被当内容（剥标签前先吃掉标签间空白）
  assert.equal(
    looksLikeHtmlCanvas('<div>\n  <div>标题</div>\n  <div>内容说明文字</div>\n</div>'),
    true,
  );
});

test('looksLikeAsciiArt：正文段落级判定（minArt=2），普通硬换行散文不受影响', () => {
  // 两行密集分栏：命中
  assert.equal(looksLikeAsciiArt('| a |  | b |\n| c || d |', 2), true);
  // 制表字符命中
  assert.equal(looksLikeAsciiArt('┌─┐\n│x│\n└─┘', 2), true);
  // 单管道散文、尾随双空格硬换行：不命中
  assert.equal(looksLikeAsciiArt('选项 off | low | high\n第二行普通文字  ', 2), false);
});

test('沙箱文档：预注入语义变量 + 卡片源码原样进 body', () => {
  const doc = buildCanvasDocument('<div class="k">内容</div>', TOKENS);
  assert.ok(doc.startsWith('<!DOCTYPE html>'));
  assert.ok(doc.includes('--c-bg:oklch(0.26 0.006 286.2)'));
  assert.ok(doc.includes('--c-bad-bg:color-mix(in oklab, oklch(0.7 0.18 27.325) 12%, transparent)'));
  assert.ok(doc.includes('<div class="k">内容</div>'));
});

test('另存文档：独立可打开，标题转义不进标签', () => {
  const file = buildCanvasStandaloneFile('<div>x</div>', TOKENS, '</title><script>');
  assert.match(file, /<title>&lt;\/title&gt;&lt;script&gt;<\/title>/);
  assert.ok(file.includes('<meta name="viewport"'));
});
