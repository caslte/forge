/**
 * U-CV-006 时间线/快照派生纯函数单测（AC-CV-015/019，docs/test/03_conversation/coverage-matrix.md）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts，先例
 * packages/forge-core/test/markdown/renderMarkdown.test.ts）。
 * 覆盖输入变体：完整多轮（user/assistant/tool 交错）、超长文本（500/1000 字）、
 * 恰好等于上限、空数组、仅 user 无 assistant、content 非字符串、emoji/全角码点截断、
 * 负向（tool 不进条目/快照、图片字段忽略、Markdown 不解析）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildTimelineEntries,
  buildRoundSnapshot,
} from '../src/utils/conversationTimeline.ts';

import type { ConversationMessage } from '../src/types.ts';

/** 码点数（非 UTF-16 单元数） */
function cp(text: string): number {
  return Array.from(text).length;
}

const T = '2026-08-29T10:00:00.000Z';

/** 消息构造器（extra 覆盖任意字段，含畸形 content） */
function msg(role: ConversationMessage['role'], content: unknown, extra?: Partial<ConversationMessage>): ConversationMessage {
  return { role, content: content as string, ts: T, ...extra };
}

/** 完整多轮 fixture：user → tool → assistant → tool → assistant → user → assistant → user */
function multiRound(): ConversationMessage[] {
  return [
    msg('user', '第一条提问'),
    msg('tool', '工具输出A', { toolEventId: 't-1', toolName: 'file.read', status: 'completed' }),
    msg('assistant', '第一轮回复'),
    msg('tool', '工具输出B', { toolEventId: 't-2', toolName: 'Edit', status: 'completed' }),
    msg('assistant', '第一轮补充'),
    msg('user', '第二条提问'),
    msg('assistant', '第二轮回复'),
    msg('user', '第三条提问'),
  ];
}

// ===== buildTimelineEntries（AC-CV-014 派生） =====

test('时间线条目：仅取 user 消息、按数组时间正序、index 指向原数组', () => {
  const entries = buildTimelineEntries(multiRound());
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => e.index),
    [0, 5, 7],
  );
  assert.deepEqual(
    entries.map((e) => e.text),
    ['第一条提问', '第二条提问', '第三条提问'],
  );
  // ts 透传原消息
  assert.ok(entries.every((e) => e.ts === T));
});

test('时间线负向：tool/assistant 消息文本不进条目', () => {
  const entries = buildTimelineEntries(multiRound());
  const all = entries.map((e) => e.text).join('\n');
  assert.ok(!all.includes('工具输出'), 'tool 消息不得进条目');
  assert.ok(!all.includes('回复'), 'assistant 消息不得进条目');
});

test('时间线条目单行截断：>40 码点截断加省略号，恰好 40 码点不加', () => {
  const long = buildTimelineEntries([msg('user', 'a'.repeat(50))]);
  assert.equal(cp(long[0]!.text), 41);
  assert.equal(long[0]!.text, 'a'.repeat(40) + '…');

  const exact = buildTimelineEntries([msg('user', 'b'.repeat(40))]);
  assert.equal(exact[0]!.text, 'b'.repeat(40));
  assert.ok(!exact[0]!.text.includes('…'));
});

test('时间线条目：多字节（全角/汉字）按码点截断，不产生半个代理对', () => {
  const entries = buildTimelineEntries([msg('user', '汉'.repeat(50))]);
  assert.equal(cp(entries[0]!.text), 41);
  assert.equal(entries[0]!.text, '汉'.repeat(40) + '…');
});

test('时间线条目：换行折叠为单行展示文本', () => {
  const entries = buildTimelineEntries([msg('user', '第一行\n第二行\t继续')]);
  assert.equal(entries[0]!.text, '第一行 第二行 继续');
});

test('时间线负向：Markdown 符号原样保留（不解析渲染）', () => {
  const entries = buildTimelineEntries([msg('user', '**加粗** `代码`')]);
  assert.equal(entries[0]!.text, '**加粗** `代码`');
});

test('时间线负向：user 消息 images 字段被忽略（不进条目文本）', () => {
  const entries = buildTimelineEntries([
    msg('user', '看图说话', { images: [{ data: 'aGVsbG8=', mimeType: 'image/png' }] }),
  ]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0]!.text, '看图说话');
});

// ===== buildRoundSnapshot（AC-CV-015/019 派生） =====

test('快照：取该轮 user 文本 + 其后最后一条 assistant（中间 tool 跳过）', () => {
  const msgs = multiRound();
  const s0 = buildRoundSnapshot(msgs, 0);
  assert.equal(s0.userText, '第一条提问');
  assert.equal(s0.assistantText, '第一轮补充');

  const s1 = buildRoundSnapshot(msgs, 5);
  assert.equal(s1.userText, '第二条提问');
  assert.equal(s1.assistantText, '第二轮回复');
});

test('快照：仅提问未回复 → assistantText 为 null（状态提示态由组件处理）', () => {
  const msgs = multiRound();
  const s = buildRoundSnapshot(msgs, 7);
  assert.equal(s.userText, '第三条提问');
  assert.equal(s.assistantText, null);
});

test('快照：快照不跨轮——assistant 取到下一条 user 消息之前为止', () => {
  const msgs: ConversationMessage[] = [
    msg('user', '问A'),
    msg('assistant', '答A'),
    msg('user', '问B'),
    msg('assistant', '答B'),
  ];
  const s = buildRoundSnapshot(msgs, 0);
  assert.equal(s.userText, '问A');
  assert.equal(s.assistantText, '答A');
});

test('快照：轮内 system 消息跳过，不当作 assistant 文本', () => {
  const msgs: ConversationMessage[] = [
    msg('user', '问'),
    msg('system', '系统提示'),
    msg('assistant', '答'),
  ];
  const s = buildRoundSnapshot(msgs, 0);
  assert.equal(s.userText, '问');
  assert.equal(s.assistantText, '答');
});

test('快照：空数组 → 空会话态（userText 空且 assistantText null）', () => {
  assert.deepEqual(buildRoundSnapshot([], 0), { userText: '', assistantText: null });
});

test('快照：索引越界/负数/非整数 → 空会话态，不抛异常', () => {
  const msgs = multiRound();
  assert.deepEqual(buildRoundSnapshot(msgs, 99), { userText: '', assistantText: null });
  assert.deepEqual(buildRoundSnapshot(msgs, -1), { userText: '', assistantText: null });
  assert.deepEqual(buildRoundSnapshot(msgs, 1.5), { userText: '', assistantText: null });
});

test('快照负向：tool/assistant 索引不产生快照（仅 user 消息有效）', () => {
  const msgs = multiRound();
  // index 1 = tool、index 2 = assistant
  assert.deepEqual(buildRoundSnapshot(msgs, 1), { userText: '', assistantText: null });
  assert.deepEqual(buildRoundSnapshot(msgs, 2), { userText: '', assistantText: null });
});

test('快照：user 500 字截断为 120 码点 + 省略号；assistant 1000 字截断为 200 码点 + 省略号', () => {
  const msgs: ConversationMessage[] = [
    msg('user', 'u'.repeat(500)),
    msg('assistant', 'a'.repeat(1000)),
  ];
  const s = buildRoundSnapshot(msgs, 0);
  assert.equal(cp(s.userText), 121);
  assert.equal(s.userText, 'u'.repeat(120) + '…');
  assert.equal(cp(s.assistantText ?? ''), 201);
  assert.equal(s.assistantText, 'a'.repeat(200) + '…');
});

test('快照：恰好 120/200 码点不加省略号', () => {
  const msgs: ConversationMessage[] = [
    msg('user', '问'.repeat(120)),
    msg('assistant', '答'.repeat(200)),
  ];
  const s = buildRoundSnapshot(msgs, 0);
  assert.equal(s.userText, '问'.repeat(120));
  assert.ok(!s.userText.includes('…'));
  assert.equal(s.assistantText, '答'.repeat(200));
  assert.ok(!s.assistantText!.includes('…'));
});

test('快照：emoji（代理对）截断完整——不产生半个代理对', () => {
  // '😀' = 1 码点（2 个 UTF-16 单元）；'a' + 129 个 emoji = 130 码点，
  // 截到 120 码点 = 'a' + 119 个完整 emoji + 省略号。
  // 若实现按 UTF-16 单元截断，第 60 个 emoji 会被劈成半个代理对，此断言即失败。
  const emoji = '😀';
  const msgs: ConversationMessage[] = [msg('user', 'a' + emoji.repeat(129))];
  const s = buildRoundSnapshot(msgs, 0);
  assert.equal(cp(s.userText), 121);
  assert.equal(s.userText, 'a' + emoji.repeat(119) + '…');
});

test('快照：全角字符按码点截断', () => {
  const msgs: ConversationMessage[] = [msg('user', 'あ'.repeat(150))];
  const s = buildRoundSnapshot(msgs, 0);
  assert.equal(cp(s.userText), 121);
  assert.equal(s.userText, 'あ'.repeat(120) + '…');
});

test('快照：user 消息 images 字段被忽略', () => {
  const msgs: ConversationMessage[] = [
    msg('user', '描述这张图', { images: [{ data: 'aGVsbG8=', mimeType: 'image/jpeg' }] }),
    msg('assistant', '这是截图'),
  ];
  const s = buildRoundSnapshot(msgs, 0);
  assert.equal(s.userText, '描述这张图');
  assert.equal(s.assistantText, '这是截图');
});

test('畸形输入：content 非字符串（null/数字/对象）不抛异常，按空串处理', () => {
  const msgs: ConversationMessage[] = [
    msg('user', null),
    msg('assistant', 42),
    msg('user', { text: '对象内容' }),
    msg('user', undefined),
    msg('assistant', true),
  ];
  // 不抛异常
  const entries = buildTimelineEntries(msgs);
  assert.deepEqual(
    entries.map((e) => e.text),
    ['', '', ''],
  );

  const s0 = buildRoundSnapshot(msgs, 0);
  assert.equal(s0.userText, '');
  // assistant 存在但内容畸形 → 文本为空串（非 null，null 仅表示无回复）
  assert.equal(s0.assistantText, '');

  const s2 = buildRoundSnapshot(msgs, 2);
  assert.equal(s2.userText, '');
  // 其后紧跟另一条 user（无 assistant）→ null（畸形 user 自身文本仍按空处理）
  assert.equal(s2.assistantText, null);
});

test('时间线：空数组 → 空条目列表', () => {
  assert.deepEqual(buildTimelineEntries([]), []);
});

test('时间线：仅 tool/assistant/system 无 user 消息 → 空条目列表（组件据此不渲染）', () => {
  const entries = buildTimelineEntries([
    msg('assistant', '只有回复'),
    msg('tool', '只有工具', { toolEventId: 't-9', toolName: 'file.read', status: 'completed' }),
    msg('system', '系统'),
  ]);
  assert.deepEqual(entries, []);
});
