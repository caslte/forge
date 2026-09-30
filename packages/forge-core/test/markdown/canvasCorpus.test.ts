/**
 * 画布判决语料回归锁（tmp/canvas-judge-demo.html 矩阵的测试侧冻结本）。
 *
 * 25 例覆盖：正常图示（必须进 iframe）、滥用（必须降级）、用户裁决样本。
 * 终态判决逐例断言；流式口径另有一条锚点断言（方案 A：长句进流式，薄壳/空壳/
 * 字符画只到闭合判一次）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { judgeCanvasSource } from '../../src/markdown/renderMarkdown.ts';
import { CANVAS_CORPUS } from './canvasCorpus.ts';

test(`语料矩阵：${CANVAS_CORPUS.length} 例终态判决与冻结语义一致（2026-09-30 用户裁决）`, () => {
  const wrong = CANVAS_CORPUS.filter((c) => judgeCanvasSource(c.src) !== c.expect);
  assert.deepEqual(
    wrong.map((c) => `${c.id}「${c.name}」期望 ${c.expect} 实测 ${judgeCanvasSource(c.src)}`),
    [],
    '语料出现偏差——改判据前先确认是否真的要推翻某条冻结裁决，并同步 demo 矩阵',
  );
});

test('流式口径（方案 A）：锚点卡全程骨架族；前言先行卡的中途翻面是已接受代价', () => {
  const onSkeleton = (v: string) => v === 'undecided' || v === 'html';

  // 锚点卡（94 短标签 + 2 长说明）：流式全程 undecided/html，闭合进卡片，零翻面
  const anchor = CANVAS_CORPUS.find((c) => c.id === 'N01')!;
  const seen: string[] = [];
  for (let i = 0; i <= anchor.src.length; i += 3) {
    const v = judgeCanvasSource(anchor.src.slice(0, i), { streaming: true });
    if (seen[seen.length - 1] !== v) seen.push(v);
  }
  assert.deepEqual(
    seen.filter((v) => !onSkeleton(v)),
    [],
    `锚点卡流式中途脱离骨架族：${seen.join(' → ')}`,
  );

  // 前言 + 盒子（G05/N10）：终态 html；流式中途长句占比先过半（prose）后被盒子稀释
  // 回 html——一次有界的翻面，是方案 A「占比进流式」的已接受代价，不在此钉死轨迹。
  for (const id of ['G05', 'N10']) {
    const c = CANVAS_CORPUS.find((x) => x.id === id)!;
    assert.equal(judgeCanvasSource(c.src), 'html');
  }
});

test('流式口径（方案 A）：薄壳/空壳/字符画三条终态专属规则不进流式（闭合一次判决）', () => {
  // W03 薄壳文字墙：句子 55 字 < 80，流式期间不满足长句铁证 → 全程骨架，闭合判 prose
  const w03 = CANVAS_CORPUS.find((c) => c.id === 'W03')!;
  assert.equal(judgeCanvasSource(w03.src, { streaming: true }), 'html');
  assert.equal(judgeCanvasSource(w03.src), 'prose');
  // G02 空壳：流式可见文本从 0 长起，不提前出 prose；闭合判 prose
  const g02 = CANVAS_CORPUS.find((c) => c.id === 'G02')!;
  assert.equal(judgeCanvasSource(g02.src, { streaming: true }), 'html');
  assert.equal(judgeCanvasSource(g02.src), 'prose');
  // G03 字符画薄壳：流式挂骨架，闭合降 code（对齐保命）
  const g03 = CANVAS_CORPUS.find((c) => c.id === 'G03')!;
  assert.equal(judgeCanvasSource(g03.src, { streaming: true }), 'html');
  assert.equal(judgeCanvasSource(g03.src), 'code');
});
