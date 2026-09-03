import test from 'node:test';
import assert from 'node:assert/strict';

import { detectAtContext, filterAtFiles } from '../src/utils/atCompletion.ts';

// ===== detectAtContext：触发 / 不触发 =====

test('detectAtContext：行内 token @ 后输入 → 激活，filter 为 @ 后至光标', () => {
  const ctx = detectAtContext('看下 @edu', 7);
  assert.equal(ctx.active, true);
  if (ctx.active) {
    assert.equal(ctx.filter, 'edu');
    assert.equal(ctx.atStart, 3);
  }
});

test('detectAtContext：刚输入 @（空过滤）→ 激活，filter 空串', () => {
  const ctx = detectAtContext('看下 @', 4);
  assert.equal(ctx.active, true);
  if (ctx.active) assert.equal(ctx.filter, '');
});

test('detectAtContext：@ 前是 token 字符（邮箱）→ 不激活', () => {
  assert.equal(detectAtContext('邮箱 user@example.com', 19).active, false);
  assert.equal(detectAtContext('a@b', 3).active, false);
});

test('detectAtContext：token 内有空白（@ 后已空格）→ 不激活', () => {
  assert.equal(detectAtContext('看下 @edu 说明', 9).active, false);
});

test('detectAtContext：光标压在 @ 上 / 无 @ / 越界 → 不激活', () => {
  assert.equal(detectAtContext('看下 @', 3).active, false);
  assert.equal(detectAtContext('没有标记', 4).active, false);
  assert.equal(detectAtContext('abc', 99).active, false);
  assert.equal(detectAtContext('', 0).active, false);
});

// ===== filterAtFiles：过滤 + 排序 =====

const FILES = [
  'C:/proj/src/edu-community/index.ts',
  'C:/proj/edu-community.md',
  'C:/proj/src/readme.txt',
  'C:/proj/EDU.md',
];

test('filterAtFiles：basename 前缀 > basename 包含 > 路径包含，同级路径短者前', () => {
  const r = filterAtFiles(FILES, 'edu');
  assert.deepEqual(r, ['C:/proj/EDU.md', 'C:/proj/edu-community.md', 'C:/proj/src/edu-community/index.ts']);
});

test('filterAtFiles：空过滤串按原序（BFS 浅层优先）截前 limit 条', () => {
  const r = filterAtFiles(FILES, '', 2);
  assert.deepEqual(r, FILES.slice(0, 2));
});

test('filterAtFiles：无匹配返回空数组；limit 截断', () => {
  assert.deepEqual(filterAtFiles(FILES, 'zzz'), []);
  const many = Array.from({ length: 50 }, (_, i) => `C:/proj/f${i}.md`);
  assert.equal(filterAtFiles(many, 'f', 30).length, 30);
});
