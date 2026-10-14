/**
 * 从 assistant 文本里提取 canvas-ir 围栏（修复回路的提取器）。
 *
 * 纯函数、可单测。为什么放 forge-core：修复回路在 forge-extensions，
 * 但提取逻辑要在 node:test 里锁行为（围栏未闭合 / 嵌套反引号 / 混排），
 * 且 core 已是两端共享的最底层。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractIrFences, repairIrFenceOpeners } from '../../src/markdown/canvasIr.ts';

test('提取单个闭合围栏', () => {
  const text = '前言\n```canvas-ir\n{"a":1}\n```\n后记';
  assert.deepEqual(extractIrFences(text), ['{"a":1}']);
});

test('多个围栏按顺序全部提取', () => {
  const text = '```canvas-ir\nA\n```\n中\n```canvas-ir\nB\n```';
  assert.deepEqual(extractIrFences(text), ['A', 'B']);
});

test('未闭合围栏（流式/截断）不提取——残缺 JSON 判定无意义', () => {
  const text = '```canvas-ir\n{"a":1}';
  assert.deepEqual(extractIrFences(text), []);
});

test('围栏体首尾空白被修剪', () => {
  const text = '```canvas-ir\n\n  {"a":1}  \n\n```';
  assert.deepEqual(extractIrFences(text), ['{"a":1}']);
});

test('不误吃 canvas 围栏（语言名必须精确 canvas-ir）', () => {
  const text = '```canvas\nHTML\n```';
  assert.deepEqual(extractIrFences(text), []);
});

test('空文本返回空数组', () => {
  assert.deepEqual(extractIrFences(''), []);
  assert.deepEqual(extractIrFences(undefined as unknown as string), []);
});

// ---------------------------------------------------------------------------
// 思考标记漏进围栏开口行（2026-10-13 门禁第 2 轮实测，flow-ci）
//
// mx 模型把 reasoning 块的闭合标记直接吐在正文流里。它落在围栏开口行内时会把
// ```canvas-ir 劈成「```canvas + 标记 + 空行 + -ir」。不修的后果是三级静默：
// 提取不到围栏 ⇒ 卡片不渲染、修复回路看不见、采样端把样本当成「模型没画」挤出分母。
// ---------------------------------------------------------------------------

test('思考标记劈开围栏开口：修回后照常提取（实测字节序列）', () => {
  // 逐字复刻转录里的损坏形态：```canvas + 标记 + \n\n + -ir
  const leak = '</' + 'thi' + 'nk>';
  const text = 'Let me finalize.```canvas' + leak + '\n\n-ir\n{"schema_version":"forge-ir/2"}\n```';
  assert.deepEqual(extractIrFences(text), ['{"schema_version":"forge-ir/2"}']);
});

test('思考标记插在围栏与语言名之间也能修', () => {
  const leak = '</' + 'thi' + 'nk>';
  const text = '```' + leak + 'canvas-ir\n{"a":1}\n```';
  assert.deepEqual(extractIrFences(text), ['{"a":1}']);
});

test('思考标记跟在完整语言名后、换行前也能修', () => {
  const leak = '</' + 'thi' + 'nk>';
  const text = '```canvas-ir' + leak + '\n{"a":1}\n```';
  assert.deepEqual(extractIrFences(text), ['{"a":1}']);
});

test('开口标记用开始形态（不止闭合）同样处理', () => {
  const leak = '<' + 'thi' + 'nk>';
  const text = '```canvas' + leak + '\n-ir\n{"a":1}\n```';
  assert.deepEqual(extractIrFences(text), ['{"a":1}']);
});

test('修复只动围栏开口行：围栏外正文里的思考标记原样保留', () => {
  // 标记出现在正文是模型的思考输出，提取器不该抹掉它（那是显示层的事）。
  const leak = '</' + 'thi' + 'nk>';
  const text = leak + '先想想' + leak + '\n然后画图\n```canvas-ir\n{"a":1}\n```';
  assert.deepEqual(extractIrFences(text), ['{"a":1}']);
  assert.equal(repairIrFenceOpeners(text), text, '没有任何劈开的开口行时应原样返回');
});

test('围栏体内的标记不修——那是模型的内容问题，该由 judgeIr 报 IR000', () => {
  const leak = '</' + 'thi' + 'nk>';
  const text = '```canvas-ir\n{"a":' + leak + '1}\n```';
  // 围栏照样提得出来（闭合、语言名完好），标记留在体内 ⇒ JSON.parse 失败 ⇒ IR000。
  // 这才是诚实的路径：提取器不替模型改内容，只修被传输层劈开的围栏语法。
  assert.deepEqual(extractIrFences(text), ['{"a":' + leak + '1}']);
});

test('修复不把 canvas（HTML 围栏）误判成 canvas-ir', () => {
  const leak = '</' + 'thi' + 'nk>';
  const text = '```canvas' + leak + '\nHTML\n```';
  assert.deepEqual(extractIrFences(text), []);
});

test('修复幂等：修好的文本再修一次不变', () => {
  const leak = '</' + 'thi' + 'nk>';
  const text = 'Let me finalize.```canvas' + leak + '\n\n-ir\n{"a":1}\n```';
  const once = repairIrFenceOpeners(text);
  assert.equal(repairIrFenceOpeners(once), once);
  assert.ok(once.includes('```canvas-ir\n'), '修好后应出现完整开口行');
});

test('开口粘在 prose 尾部（缺换行）：补换行，否则 marked 只当行内代码', () => {
  // flow-ci 实测的第二个缺陷：围栏开口紧跟在一行 prose 后面（finalize.```canvas-ir）。
  // marked 只认行首围栏 ⇒ 解析成行内代码 span ⇒ 卡片不渲染、没有任何报错。
  const text = 'Let me finalize.```canvas-ir\n{"a":1}\n```';
  const fixed = repairIrFenceOpeners(text);
  assert.equal(fixed, 'Let me finalize.\n```canvas-ir\n{"a":1}\n```');
  assert.deepEqual(extractIrFences(text), ['{"a":1}']);
});

test('散文里反引号提到 canvas-ir 不动（那不是开口，后面跟的是文字不是 {）', () => {
  // 实测 26 条会话里散文大量出现 "the diagram goes in a ```canvas-ir fence" 这类引用。
  // 形状 4 的 split 判定带「紧跟换行 + {」的 lookahead，正是为了不误伤它们。
  for (const s of [
    'the diagram goes in a ```canvas-ir fence',
    '请只修复上述问题并重新输出完整的 ```canvas-ir 围栏（不要复述其他内容）。',
    '```canvas-ir 是围栏名',
  ]) {
    assert.equal(repairIrFenceOpeners(s), s, '不应改动：' + s);
  }
  // 提完之后真的换行写 JSON 才是开口——那才修
  assert.equal(
    repairIrFenceOpeners('看这个 ```canvas-ir\n{"a":1}\n```'),
    '看这个 \n```canvas-ir\n{"a":1}\n```',
  );
});