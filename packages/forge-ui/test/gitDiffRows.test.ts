/**
 * 模块 12：`git diff` unified 文本 → 并排 diff 行（代码查看器「并排 diff」的解析层）。
 *
 * 数据源是 core `git/getFileDiff` 返回的原始 unified diff 文本（真实 git 产出，
 * 含 3 行上下文）。解析职责只有两件事：
 * 1. 把 hunk 内的 ` `/`-`/`+` 行配对成并排行（连续删除块与新增块按序配对，
 *    多出的一侧为空——与 core `buildSideBySideDiff` 的配对口径一致）；
 * 2. 从 hunk 头 `@@ -a,b +c,d @@` 取两侧行号（上下文行两侧都要有号）。
 *
 * 关键坑（都有用例钉住）：
 * - `--- a/x` / `+++ b/x` 文件头只在 hunk **外**是元数据；hunk 内的 `--- foo`
 *   是一条内容为 `- foo` 的删除行——需要 hunk 内外状态机，不能无脑 startsWith。
 * - `\ No newline at end of file` 不是内容行，跳过且不能吃掉行号。
 * - 二进制差异没有 hunk，单独用 binary 标志暴露给 UI 给专门空态。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  collectDiffOmissions,
  parseGitInlineDiff,
  parseGitUnifiedDiff,
} from '../src/utils/gitDiffRows.ts';
import type { SideBySideRow } from '@forge/core/side-by-side-diff';

test('parseGitUnifiedDiff：null/空串 → 零行、非二进制', () => {
  assert.deepEqual(parseGitUnifiedDiff(null), { rows: [], binary: false });
  assert.deepEqual(parseGitUnifiedDiff(''), { rows: [], binary: false });
});

test('parseGitUnifiedDiff：修改 + 上下文 → equal 行两侧行号来自 hunk 头', () => {
  const diff = [
    'diff --git a/src/a.ts b/src/a.ts',
    'index 111..222 100644',
    '--- a/src/a.ts',
    '+++ b/src/a.ts',
    '@@ -1,3 +1,3 @@',
    ' const a = 1;',
    '-const b = 2;',
    '+const b = 20;',
    ' const c = 3;',
  ].join('\n');
  const { rows, binary } = parseGitUnifiedDiff(diff);
  assert.equal(binary, false);
  assert.equal(rows.length, 3);
  // 上下文行：两侧同文同号（内容剥掉模式字符）
  assert.deepEqual(rows[0], {
    left: { type: 'equal', text: 'const a = 1;', line: 1 },
    right: { type: 'equal', text: 'const a = 1;', line: 1 },
  });
  // 修改行：左 removed / 右 added
  assert.deepEqual(rows[1], {
    left: { type: 'removed', text: 'const b = 2;', line: 2 },
    right: { type: 'added', text: 'const b = 20;', line: 2 },
  });
  assert.deepEqual(rows[2], {
    left: { type: 'equal', text: 'const c = 3;', line: 3 },
    right: { type: 'equal', text: 'const c = 3;', line: 3 },
  });
});

test('parseGitUnifiedDiff：新文件 @@ -0,0 +1,N @@ → 全 added，左侧空', () => {
  const diff = [
    'diff --git a/new.ts b/new.ts',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.ts',
    '@@ -0,0 +1,2 @@',
    '+first',
    '+second',
  ].join('\n');
  const { rows, binary } = parseGitUnifiedDiff(diff);
  assert.equal(binary, false);
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.left, null);
  assert.deepEqual(rows[0]!.right, { type: 'added', text: 'first', line: 1 });
  assert.deepEqual(rows[1]!.right, { type: 'added', text: 'second', line: 2 });
});

test('parseGitUnifiedDiff：连续删除块 > 新增块 → 多出的删除行右侧为空', () => {
  const diff = [
    '@@ -10,4 +10,2 @@',
    '-keepA',
    '-drop1',
    '-drop2',
    '-drop3',
    '+keepB',
  ].join('\n');
  const { rows } = parseGitUnifiedDiff(diff);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[0]!.left, { type: 'removed', text: 'keepA', line: 10 });
  assert.deepEqual(rows[0]!.right, { type: 'added', text: 'keepB', line: 10 });
  assert.deepEqual(rows[1]!.left, { type: 'removed', text: 'drop1', line: 11 });
  assert.equal(rows[1]!.right, null);
  assert.deepEqual(rows[2]!.left, { type: 'removed', text: 'drop2', line: 12 });
  assert.deepEqual(rows[3]!.left, { type: 'removed', text: 'drop3', line: 13 });
});

test('parseGitUnifiedDiff：多个 hunk → 行号按各自 hunk 头重置', () => {
  const diff = ['@@ -1,2 +1,2 @@', '-a1', '+b1', ' a2', '@@ -5,1 +6,1 @@', ' old5'].join('\n');
  const { rows } = parseGitUnifiedDiff(diff);
  assert.equal(rows.length, 3);
  assert.equal(rows[1]!.left!.line, 2);
  // 第二个 hunk：old 从 5、new 从 6 起（新增了行导致两侧错位）
  assert.deepEqual(rows[2], {
    left: { type: 'equal', text: 'old5', line: 5 },
    right: { type: 'equal', text: 'old5', line: 6 },
  });
});

test('parseGitUnifiedDiff：\\ No newline 标记跳过且不影响配对', () => {
  const diff = ['@@ -1 +1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n');
  const { rows } = parseGitUnifiedDiff(diff);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0]!.left, { type: 'removed', text: 'old', line: 1 });
  assert.deepEqual(rows[0]!.right, { type: 'added', text: 'new', line: 1 });
});

test('parseGitUnifiedDiff：hunk 外的 ---/+++ 是文件头；hunk 内的 --- 是删除行内容', () => {
  const diff = [
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -1,2 +1,1 @@',
    '--- not a header',
    '+not a header',
    ' ctx',
  ].join('\n');
  const { rows, binary } = parseGitUnifiedDiff(diff);
  assert.equal(binary, false);
  // 若把 hunk 内的 `--- not a header` 当文件头吃掉，配对就断、行数全错
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0]!.left, { type: 'removed', text: '-- not a header', line: 1 });
  assert.deepEqual(rows[0]!.right, { type: 'added', text: 'not a header', line: 1 });
  assert.deepEqual(rows[1], {
    left: { type: 'equal', text: 'ctx', line: 2 },
    right: { type: 'equal', text: 'ctx', line: 2 },
  });
});

test('parseGitUnifiedDiff：hunk 内的裸空行按空上下文处理（不掐断 hunk）', () => {
  // git 本体输出单个空格，但手写 fixture/转写常剥成裸空行——宽容口径
  const diff = ['@@ -2,4 +2,5 @@', ' first', '', '-old', '+new', ' last'].join('\n');
  const { rows, binary } = parseGitUnifiedDiff(diff);
  assert.equal(binary, false);
  assert.equal(rows.length, 4);
  assert.deepEqual(rows[1], {
    left: { type: 'equal', text: '', line: 3 },
    right: { type: 'equal', text: '', line: 3 },
  });
  assert.deepEqual(rows[2]!.left, { type: 'removed', text: 'old', line: 4 });
  assert.deepEqual(rows[2]!.right, { type: 'added', text: 'new', line: 4 });
  assert.deepEqual(rows[3], {
    left: { type: 'equal', text: 'last', line: 5 },
    right: { type: 'equal', text: 'last', line: 5 },
  });
});

test('parseGitUnifiedDiff：Binary files 提示行 → binary=true、零行', () => {
  const { rows, binary } = parseGitUnifiedDiff('Binary files a/img.png and b/img.png differ');
  assert.equal(binary, true);
  assert.deepEqual(rows, []);
});

// ===== parseGitInlineDiff：行内 diff（文件正文 + 行级标记）的数据投影 =====
// 模型与原型（code-tree-git-demo.html）一致：
// - 新增行 → addedLines（文件正文按行号上色，色条画行号栏右缘）；
// - 被删的行在工作区文件里**根本不存在** → delBlocks 以「贴在某行之后」的
//   可展开占位条表示（-a +b 的替换也算：旧行进占位条、新行上色）。

test('parseGitInlineDiff：null/空串 → 零标记、零删除块', () => {
  assert.deepEqual(parseGitInlineDiff(null), { addedLines: [], delBlocks: [], binary: false });
  assert.deepEqual(parseGitInlineDiff(''), { addedLines: [], delBlocks: [], binary: false });
});

test('parseGitInlineDiff：修改对（-旧 +新）→ 新行上标记，旧行进删除块', () => {
  const diff = ['@@ -1,3 +1,3 @@', ' ctx1', '-old', '+new', ' ctx2'].join('\n');
  const { addedLines, delBlocks, binary } = parseGitInlineDiff(diff);
  assert.equal(binary, false);
  assert.deepEqual(addedLines, [2]);
  // 占位条贴在上下文第 1 行之后（新文件视角：它夹在 ctx1 与 new 之间）
  assert.equal(delBlocks.length, 1);
  assert.equal(delBlocks[0]!.afterLine, 1);
  assert.deepEqual(delBlocks[0]!.lines, [{ no: 2, text: 'old' }]);
});

test('parseGitInlineDiff：纯新增行只上标记，不产生删除块', () => {
  const diff = ['@@ -1,2 +1,3 @@', ' a', '+b', '+c', ' d'].join('\n');
  const { addedLines, delBlocks } = parseGitInlineDiff(diff);
  assert.deepEqual(addedLines, [2, 3]);
  assert.deepEqual(delBlocks, []);
});

test('parseGitInlineDiff：连续删除块不与新增配对，整块进一个占位条', () => {
  const diff = ['@@ -10,5 +10,2 @@', ' keep', '-drop1', '-drop2', '-drop3', '+fresh', ' tail'].join('\n');
  const { addedLines, delBlocks } = parseGitInlineDiff(diff);
  assert.deepEqual(addedLines, [11]);
  assert.equal(delBlocks.length, 1);
  assert.equal(delBlocks[0]!.afterLine, 10, '块贴在上下文 keep（第 10 行）之后');
  assert.deepEqual(
    delBlocks[0]!.lines,
    [
      { no: 11, text: 'drop1' },
      { no: 12, text: 'drop2' },
      { no: 13, text: 'drop3' },
    ],
    '占位条里的行号是**旧文件**行号',
  );
});

test('parseGitInlineDiff：hunk 开头的删除 → afterLine=null（文件最前）；hunk 末尾的删除贴最后一行', () => {
  const head = ['@@ -1,2 +1,1 @@', '-old1', '-old2', '+new1'].join('\n');
  const r1 = parseGitInlineDiff(head);
  assert.equal(r1.delBlocks[0]!.afterLine, null, '块在首个新行之前');
  assert.deepEqual(r1.delBlocks[0]!.lines, [
    { no: 1, text: 'old1' },
    { no: 2, text: 'old2' },
  ]);

  const tail = ['@@ -1,1 +1,2 @@', ' a', '+b', '-gone'].join('\n');
  const r2 = parseGitInlineDiff(tail);
  assert.deepEqual(r2.addedLines, [2]);
  assert.equal(r2.delBlocks[0]!.afterLine, 2, '块贴在新文件最后一行 b 之后');
  assert.deepEqual(r2.delBlocks[0]!.lines, [{ no: 2, text: 'gone' }]);
});

test('parseGitInlineDiff：多个 hunk → 锚点按各自 hunk 重置，块 id 稳定递增', () => {
  const diff = [
    '@@ -1,2 +1,2 @@',
    '-a1',
    '+b1',
    ' a2',
    '@@ -5,1 +6,2 @@',
    ' old5',
    '+add6',
    '-gone5',
  ].join('\n');
  const { addedLines, delBlocks } = parseGitInlineDiff(diff);
  assert.deepEqual(addedLines, [1, 7]);
  assert.equal(delBlocks.length, 2);
  assert.equal(delBlocks[0]!.afterLine, null);
  assert.equal(delBlocks[1]!.afterLine, 7);
  // hunk2 头 @@ -5,1 +6,2 @@：上下文吃掉旧第 5 行，删除行是旧第 6 行
  assert.deepEqual(delBlocks[1]!.lines, [{ no: 6, text: 'gone5' }]);
  assert.notEqual(delBlocks[0]!.id, delBlocks[1]!.id, '展开态按 id 记，必须互不相同');
});

test('parseGitInlineDiff：Binary files → binary=true', () => {
  const { addedLines, delBlocks, binary } = parseGitInlineDiff('Binary files a/x and b/x differ');
  assert.equal(binary, true);
  assert.deepEqual(addedLines, []);
  assert.deepEqual(delBlocks, []);
});


// ===== collectDiffOmissions：并排视图 hunk 之间「未变更 N 行」省略段 =====
// git diff 的输出只含变更块 ±上下文，hunk 之间的未变更区域不在其中——
// 并排视图直接渲染就会出现「行号无解释地跳变」（用户 2026-10-03 报）。
// 这里算出省略段：endsAt = 省略段之后第一条新行号（渲染时插在它前面）；
// endsAt=null = 文件末尾的尾段。总数用 activeFile.data.totalLines 兜底。

function row(left: { line: number } | null, right: { line: number } | null): SideBySideRow {
  return {
    left: left ? { type: 'equal', text: 'x', line: left.line } : null,
    right: right ? { type: 'equal', text: 'x', line: right.line } : null,
  };
}

test('collectDiffOmissions：文件头省略段 + hunk 之间省略段 + 尾段，一次算全', () => {
  // 20 行文件，hunk 覆盖新 5..8 行
  const rows = [row({ line: 5 }, { line: 5 }), row({ line: 6 }, { line: 6 }), row(null, { line: 7 }), row({ line: 8 }, { line: 8 })];
  const oms = collectDiffOmissions(rows, 20);
  assert.deepEqual(oms, [
    { count: 4, endsAt: 5 },   // 文件头 1..4 行
    { count: 12, endsAt: null }, // 尾段 9..20 行
  ]);
});

test('collectDiffOmissions：两个 hunk 之间也有省略段', () => {
  const rows = [
    row({ line: 1 }, { line: 1 }),
    row({ line: 2 }, { line: 2 }),
    row({ line: 10 }, { line: 10 }),
    row(null, { line: 11 }),
  ];
  const oms = collectDiffOmissions(rows, 15);
  assert.deepEqual(oms, [
    { count: 7, endsAt: 10 },  // 3..9 行
    { count: 4, endsAt: null }, // 12..15 行
  ]);
});

test('collectDiffOmissions：纯删除行不占新文件行，不影响省略段计算', () => {
  // 左侧删除行夹在上下文之间（右侧为 null）
  const rows = [
    row({ line: 3 }, { line: 3 }),
    row({ line: 4 }, null),
    row({ line: 5 }, { line: 4 }),
  ];
  const oms = collectDiffOmissions(rows, 8);
  // 新侧连续 3..4，只有头段（1..2）与尾段（5..8）
  assert.deepEqual(oms, [
    { count: 2, endsAt: 3 },
    { count: 4, endsAt: null },
  ]);
});

test('collectDiffOmissions：全文都在 hunk 里 → 无省略段', () => {
  const rows = [row({ line: 1 }, { line: 1 }), row({ line: 2 }, { line: 2 })];
  assert.deepEqual(collectDiffOmissions(rows, 2), []);
});
