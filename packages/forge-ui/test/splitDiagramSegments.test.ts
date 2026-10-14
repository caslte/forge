/**
 * 正文分段：把 canvas 占位从 HTML 流里切出来，换成组件槽位。
 *
 * 为什么抽成纯函数（而不留在 MessageCard.vue 的 computed 里）：
 * 分段是**正则与状态机**逻辑，最容易出「切错位置」「漏切」「误切」三类 bug，
 * 而这三类在UI 上都表现为卡片消失或正文丢段——很难靠肉眼定位。
 * 抽出来即可在 node:test 回归，不必起浏览器。
 *
 * 与既有 canvas 分段的差别（刻意保持）：
 * - canvas 卡片留在正文原位（给上文配图），不堆到气泡底部
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { splitDiagramSegments, type DiagramSegment } from '../src/utils/splitDiagramSegments.ts';

const CANVAS_RE = '<pre class="md-canvas-wrap"><code class="md-canvas" data-md-canvas="ENC1">原文</code></pre>';

test('无占位时整段作为 html 返回', () => {
  const segs = splitDiagramSegments('<p>正文</p>');
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.kind, 'html');
  assert.equal(segs[0]!.html, '<p>正文</p>');
});

test('单个 canvas 占位被切出', () => {
  const segs = splitDiagramSegments('<p>前</p>' + CANVAS_RE + '<p>后</p>');
  assert.deepEqual(segs.map(s => s.kind), ['html', 'canvas', 'html']);
  assert.equal(segs[1]!.kind === 'canvas' && segs[1]!.encoded, 'ENC1');
});

test('多个同类占位全部切出，顺序保持', () => {
  const html = CANVAS_RE + '<p>x</p>' + CANVAS_RE;
  const segs = splitDiagramSegments(html);
  assert.deepEqual(segs.map(s => s.kind), ['canvas', 'html', 'canvas']);
});

test('key 稳定：同输入两次切分得到同样的 key', () => {
  const html = CANVAS_RE + CANVAS_RE;
  const a = splitDiagramSegments(html);
  const b = splitDiagramSegments(html);
  assert.deepEqual(
    a.map(s => (s.kind === 'html' ? 'h' : s.key)),
    b.map(s => (s.kind === 'html' ? 'h' : s.key)),
  );
});

test('占位前后无正文时不产生空 html 段', () => {
  const segs = splitDiagramSegments(CANVAS_RE + CANVAS_RE);
  assert.equal(segs.some(s => s.kind === 'html' && s.html === ''), false);
});

test('空输入返回空数组', () => {
  assert.deepEqual(splitDiagramSegments(''), []);
});

test('只有正文无占位时不产生任何卡片段', () => {
  const segs = splitDiagramSegments('<p>a</p><p>b</p>');
  assert.equal(segs.length, 1);
  assert.equal(segs[0]!.kind, 'html');
});

test('blocked 只打在最后一张卡片上（流式骨架口径）', () => {
  const segs = splitDiagramSegments(CANVAS_RE + CANVAS_RE, { lastBlocked: true });
  const cards = segs.filter(s => s.kind !== 'html');
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.blocked, false);
  assert.equal(cards[1]!.blocked, true, '只最后一张挂骨架');
});

test('blocked 不影响 html 段', () => {
  const segs = splitDiagramSegments(CANVAS_RE + '<p>x</p>', { lastBlocked: true });
  const h = segs.find(s => s.kind === 'html');
  assert.equal(h && h.kind === 'html' && (h as { blocked?: boolean }).blocked, undefined);
});

test('非流式时 lastBlocked 不生效', () => {
  const segs = splitDiagramSegments(CANVAS_RE, { lastBlocked: false });
  assert.equal(segs[0]!.blocked, false);
});