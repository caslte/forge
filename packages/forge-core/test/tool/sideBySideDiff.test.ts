import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSideBySideDiff } from '../../src/tool/sideBySideDiff.ts';

test('相同文本逐行配对为 equal 行', () => {
  const rows = buildSideBySideDiff('a\nb', 'a\nb');

  assert.deepEqual(
    rows.map((r) => [r.left?.type, r.right?.type]),
    [
      ['equal', 'equal'],
      ['equal', 'equal'],
    ],
  );
});

test('替换块按行配对为 removed/added 对齐行', () => {
  const rows = buildSideBySideDiff('old1\nold2', 'new1\nnew2');

  assert.deepEqual(rows[0], {
    left: { type: 'removed', text: 'old1', line: 1 },
    right: { type: 'added', text: 'new1', line: 1 },
  });
  assert.deepEqual(rows[1]?.left, { type: 'removed', text: 'old2', line: 2 });
  assert.deepEqual(rows[1]?.right, { type: 'added', text: 'new2', line: 2 });
});

test('纯新增块右侧 added、左侧为空', () => {
  const rows = buildSideBySideDiff('base', 'base\nextra1\nextra2');

  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.left?.type, 'equal');
  assert.equal(rows[1]?.left, null);
  assert.equal(rows[1]?.right?.type, 'added');
  assert.equal(rows[2]?.right?.text, 'extra2');
});

test('新建文件渲染为全量新增', () => {
  const rows = buildSideBySideDiff('', 'l1\nl2');

  assert.equal(rows.length, 2);
  for (const row of rows) {
    assert.equal(row.left, null);
    assert.equal(row.right?.type, 'added');
  }
});

test('缺失旧文本时降级为全量新增显示新文本', () => {
  const rows = buildSideBySideDiff(null, 'only-new');

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.left, null);
  assert.equal(rows[0]?.right?.type, 'added');
  assert.equal(rows[0]?.right?.text, 'only-new');
});

test('纯删除块左侧 removed、右侧为空', () => {
  const rows = buildSideBySideDiff('gone1\ngone2\nkeep', 'keep');

  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.left?.type, 'removed');
  assert.equal(rows[0]?.right, null);
  assert.equal(rows[2]?.left?.type, 'equal');
  assert.equal(rows[2]?.right?.type, 'equal');
});

test('空输入返回空行列表', () => {
  assert.deepEqual(buildSideBySideDiff(null, null), []);
});
