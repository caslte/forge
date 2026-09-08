/**
 * 改动文件汇总纯函数单测（解析 / 行数统计 / 按轮收集）。
 *
 * 覆盖：parseFileToolInput（pi edit 多 hunk / pi write / 旧形状 / read/bash 形状不命中 /
 * 反斜杠归一 / 非法入参）、countDiffLines（纯增/纯删/替换/空）、
 * collectTurnChangedFiles（分轮 Map 键位 / 同文件聚合 / error·started·read 不计入 /
 * 无文件工具无键 / key 取首条文件工具 toolEventId）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseFileToolInput,
  countDiffLines,
  collectTurnChangedFiles,
} from '../src/composables/useChangedFiles.ts';
import type { ConversationMessage } from '../src/types.ts';

function tool(partial: Partial<ConversationMessage>): ConversationMessage {
  return { role: 'tool', content: '', ts: '2026-01-01T00:00:00Z', status: 'completed', ...partial };
}

// ===== parseFileToolInput =====

test('parseFileToolInput: pi edit 多 hunk', () => {
  const parsed = parseFileToolInput({
    path: 'src\\a.ts',
    edits: [
      { oldText: 'foo', newText: 'bar' },
      { oldText: 'baz', newText: 'qux' },
    ],
  });
  assert.deepEqual(parsed, {
    path: 'src/a.ts',
    parts: [
      { oldText: 'foo', newText: 'bar' },
      { oldText: 'baz', newText: 'qux' },
    ],
  });
});

test('parseFileToolInput: pi write 全量写入', () => {
  const parsed = parseFileToolInput({ path: 'docs/b.md', content: 'l1\nl2' });
  assert.deepEqual(parsed, { path: 'docs/b.md', parts: [{ oldText: null, newText: 'l1\nl2' }] });
});

test('parseFileToolInput: 旧形状（file_path/old_string/new_string）', () => {
  const parsed = parseFileToolInput({ file_path: 'a.ts', old_string: 'x', new_string: 'y' });
  assert.deepEqual(parsed, { path: 'a.ts', parts: [{ oldText: 'x', newText: 'y' }] });
});

test('parseFileToolInput: 旧形状仅 new_string 也命中', () => {
  const parsed = parseFileToolInput({ file_path: 'a.ts', new_string: 'y' });
  assert.deepEqual(parsed, { path: 'a.ts', parts: [{ oldText: null, newText: 'y' }] });
});

test('parseFileToolInput: read/bash 形状不命中', () => {
  assert.equal(parseFileToolInput({ path: 'src/a.ts' }), null); // read：path 但无 edits/content
  assert.equal(parseFileToolInput({ command: 'rm -rf' }), null);
  assert.equal(parseFileToolInput({ path: 'src/a.ts', edits: [] }), null); // 空 edits 无有效块
});

test('parseFileToolInput: edits 内非字符串块跳过，全无效返回 null', () => {
  assert.equal(parseFileToolInput({ path: 'a.ts', edits: [{ oldText: 1 }, null] }), null);
  const parsed = parseFileToolInput({ path: 'a.ts', edits: [{ oldText: 1 }, { oldText: 'a', newText: 'b' }] });
  assert.deepEqual(parsed, { path: 'a.ts', parts: [{ oldText: 'a', newText: 'b' }] });
});

test('parseFileToolInput: 非对象/路径类型非法返回 null', () => {
  assert.equal(parseFileToolInput(null), null);
  assert.equal(parseFileToolInput('edit'), null);
  assert.equal(parseFileToolInput({ path: 42, edits: [{ oldText: 'a', newText: 'b' }] }), null);
});

// ===== countDiffLines =====

test('countDiffLines: 纯增（oldText=null 快速路径）', () => {
  assert.deepEqual(countDiffLines(null, 'a\nb\nc'), { added: 3, removed: 0 });
});

test('countDiffLines: 纯删（newText=null）', () => {
  assert.deepEqual(countDiffLines('a\nb', null), { added: 0, removed: 2 });
});

test('countDiffLines: 替换 +1/-1', () => {
  assert.deepEqual(countDiffLines('const a = 1;', 'const a = 2;'), { added: 1, removed: 1 });
});

test('countDiffLines: 两侧皆空为 0（write 空 content）', () => {
  assert.deepEqual(countDiffLines(null, ''), { added: 0, removed: 0 });
});

// ===== collectTurnChangedFiles =====

test('collectTurnChangedFiles: 两轮各自成 Summary，键位 = 下一条 user 下标与 msgs.length', () => {
  const msgs: ConversationMessage[] = [
    { role: 'user', content: 'q1', ts: 't0' },
    tool({ toolEventId: 'e1', input: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } }),
    { role: 'assistant', content: 'done', ts: 't1' },
    { role: 'user', content: 'q2', ts: 't2' },
    tool({ toolEventId: 'e2', input: { path: 'b.ts', content: 'l1' } }),
    { role: 'assistant', content: 'ok', ts: 't3' },
  ];
  const map = collectTurnChangedFiles(msgs);
  assert.equal(map.size, 2);
  const first = map.get(3)!;
  assert.ok(first);
  assert.deepEqual(first.files.map((f) => f.path), ['a.ts']);
  assert.equal(first.key, 'e1-files');
  const last = map.get(msgs.length)!;
  assert.deepEqual(last.files.map((f) => f.path), ['b.ts']);
});

test('collectTurnChangedFiles: edit 多 hunk 行数求和', () => {
  const msgs = [
    tool({
      toolEventId: 'e1',
      input: {
        path: 'a.ts',
        edits: [
          { oldText: 'x', newText: 'y' }, // +1 -1
          { oldText: null, newText: 'l1\nl2' }, // +2 -0
        ],
      },
    }),
  ];
  const map = collectTurnChangedFiles(msgs);
  assert.deepEqual(map.get(1)!.files[0], { path: 'a.ts', name: 'a.ts', added: 3, removed: 1, parts: [
    { oldText: 'x', newText: 'y' },
    { oldText: null, newText: 'l1\nl2' },
  ] });
});

test('collectTurnChangedFiles: 同文件同轮聚合（行数求和 + parts 拼接）', () => {
  const msgs = [
    tool({ toolEventId: 'e1', input: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } }),
    tool({ toolEventId: 'e2', input: { path: 'a.ts', content: 'l1\nl2' } }),
  ];
  const map = collectTurnChangedFiles(msgs);
  assert.equal(map.size, 1);
  const entry = map.get(2)!.files[0]!;
  assert.equal(entry.path, 'a.ts');
  assert.deepEqual([entry.added, entry.removed], [3, 1]);
  assert.equal(entry.parts.length, 2);
  assert.equal(map.get(2)!.key, 'e1-files');
});

test('collectTurnChangedFiles: error / started / read / assistant 不计入', () => {
  const msgs = [
    tool({ toolEventId: 'e1', status: 'error', input: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } }),
    tool({ toolEventId: 'e2', status: 'started', input: { path: 'a.ts', edits: [{ oldText: 'x', newText: 'y' }] } }),
    tool({ toolEventId: 'e3', input: { path: 'a.ts' } }), // read 形状
    { role: 'assistant', content: 'hi', ts: 't1' },
  ];
  const map = collectTurnChangedFiles(msgs);
  assert.equal(map.size, 0);
});

test('collectTurnChangedFiles: 无 toolEventId 时 key 回退 ts', () => {
  const msgs = [tool({ ts: '2026-01-01T00:00:00Z', input: { path: 'a.ts', content: 'x' } })];
  const map = collectTurnChangedFiles(msgs);
  assert.equal(map.get(1)!.key, '2026-01-01T00:00:00Z-files');
});

test('collectTurnChangedFiles: 无文件工具返回空 Map', () => {
  const msgs: ConversationMessage[] = [
    { role: 'user', content: 'q', ts: 't0' },
    { role: 'assistant', content: 'a', ts: 't1' },
  ];
  assert.equal(collectTurnChangedFiles(msgs).size, 0);
});
