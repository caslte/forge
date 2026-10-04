/**
 * Git 状态字母 → 展示字形的共享映射表（utils/gitStatusUi.ts）。
 *
 * 背景（用户 2026-10-03 报）：CodeViewer 面包屑旁的徽标直接印后端原始字符，
 * 文件树却走展示层映射——同一个未跟踪文件，树里是绿 U、查看器头部是橙 ?。
 * 修复后两处共用一张表；这里钉住映射本身，防止哪天又被各写各的。
 *
 * 两个映射是**故意的**，别「简化」回去：
 * - `?` → `U`：porcelain 的问号没人认得，按 VSCode 口径读作 Untracked；
 * - `U` → `!`：冲突若原样印 `U`，恰好和「U=未跟踪」撞车，会把冲突读成未跟踪。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gitStatusUi } from '../src/utils/gitStatusUi.ts';

test('未跟踪 ? → 印 U（绿，is-u），提示「未跟踪」', () => {
  const ui = gitStatusUi('?');
  assert.equal(ui.glyph, 'U');
  assert.equal(ui.cls, 'U');
  assert.equal(ui.title, '未跟踪');
  assert.equal(ui.nameCls, 'is-new');
});

test('冲突 U → 印 !（红，is-x），不能和「U=未跟踪」撞车', () => {
  const ui = gitStatusUi('U');
  assert.equal(ui.glyph, '!');
  assert.equal(ui.cls, 'X');
  assert.match(ui.title, /冲突/);
});

test('常规状态原样透传（M/A/D），R/C 保持中性', () => {
  assert.equal(gitStatusUi('M').glyph, 'M');
  assert.equal(gitStatusUi('A').glyph, 'A');
  assert.equal(gitStatusUi('D').glyph, 'D');
  assert.equal(gitStatusUi('R').glyph, 'R');
  assert.equal(gitStatusUi('C').glyph, 'C');
});

test('未知状态兜底到 M（映射表必须覆盖后端联合类型全集之外的脏值）', () => {
  const ui = gitStatusUi('X' as never);
  assert.equal(ui.glyph, 'M');
  assert.equal(ui.cls, 'M');
});
