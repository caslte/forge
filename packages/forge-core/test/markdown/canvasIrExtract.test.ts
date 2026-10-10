/**
 * 从 assistant 文本里提取 canvas-ir 围栏（修复回路的提取器）。
 *
 * 纯函数、可单测。为什么放 forge-core：修复回路在 forge-extensions，
 * 但提取逻辑要在 node:test 里锁行为（围栏未闭合 / 嵌套反引号 / 混排），
 * 且 core 已是两端共享的最底层。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { extractIrFences } from '../../src/markdown/canvasIr.ts';

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