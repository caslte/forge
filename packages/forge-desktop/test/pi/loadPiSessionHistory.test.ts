import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPiSessionHistory } from '../../src/pi/loadPiSessionHistory.ts';
import type { ConversationMessage } from '@forge/core';
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-history-'));
}

test('loadPiSessionHistory 读取当前活跃分支的 user 和 assistant 消息', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-session', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hi', timestamp: Date.parse('2026-01-01T00:00:01Z') } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }], stopReason: 'stop', usage: {}, api: 'openai-completions', provider: 'test', model: 'test-model', timestamp: Date.parse('2026-01-01T00:00:02Z') } },
      { type: 'model_change', id: 'c1', parentId: 'm2', timestamp: '2026-01-01T00:00:03Z', provider: 'test', modelId: 'other' },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);

    assert.deepEqual(history.map((m) => ({ role: m.role, content: m.content })), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
    assert.equal(history[0]?.ts, '2026-01-01T00:00:01Z');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 对 tool 消息返回占位内容且不崩溃', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-session-tool', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      {
        type: 'message',
        id: 'tool-1',
        parentId: null,
        timestamp: '2026-01-01T00:00:01Z',
        message: { role: 'toolResult', content: [{ type: 'text', text: 'tool output' }] },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);

    assert.deepEqual(history, [{ role: 'tool', content: 'tool output', ts: '2026-01-01T00:00:01Z', toolEventId: 'tool-1', toolName: undefined, status: 'completed' }]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 空 session 文件返回空历史', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'empty.jsonl');
    fs.writeFileSync(file, '');
    assert.deepEqual(await loadPiSessionHistory(file), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 剥离 history 中混入正文的 thinking 包裹块（兜底展示过滤）', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-session-strip', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hi', timestamp: Date.parse('2026-01-01T00:00:01Z') } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: '结论<reasoning>推理过程</reasoning>尾巴' }], stopReason: 'stop', usage: {}, api: 'openai-completions', provider: 'test', model: 'test-model', timestamp: Date.parse('2026-01-01T00:00:02Z') } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);

    assert.deepEqual(history.map((m) => ({ role: m.role, content: m.content })), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '结论尾巴' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 剥离 MiniMax 混流思考正文（` thinking…response`）', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-session-mm', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hi', timestamp: Date.parse('2026-01-01T00:00:01Z') } },
      { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: ' thinking先想一下用户意图。 response\n\n历史回答' }], stopReason: 'stop', usage: {}, api: 'openai-completions', provider: 'mx', model: 'MiniMax-M3', timestamp: Date.parse('2026-01-01T00:00:02Z') } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);

    assert.deepEqual(history.map((m) => ({ role: m.role, content: m.content })), [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: '历史回答' },
    ]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 不再剥离附件片段：历史消息按原文展示（含旧格式）', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    // 旧版内联机制产生的历史（含受控片段）也按原文展示，不做特殊解析
    const composed = '这个问题\n\n[附件：old.txt]\n旧内容';
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-session-att-old', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: composed, timestamp: Date.parse('2026-01-01T00:00:01Z') } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);

    assert.equal(history[0]?.role, 'user');
    assert.equal(history[0]?.content, composed, '附件片段按原文保留，不再剥离');
    assert.equal(history[0]?.files, undefined);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 从 assistant toolCall part 恢复工具入参回填 tool 消息', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-session-tc', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hi', timestamp: Date.parse('2026-01-01T00:00:01Z') } },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: '我来改文件' },
            { type: 'toolCall', id: 'call-1', name: 'edit', arguments: { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y' }] } },
          ],
          stopReason: 'toolUse',
          usage: {},
          api: 'openai-completions',
          provider: 'test',
          model: 'test-model',
          timestamp: Date.parse('2026-01-01T00:00:02Z'),
        },
      },
      {
        type: 'message',
        id: 'm3',
        parentId: 'm2',
        timestamp: '2026-01-01T00:00:03Z',
        message: { role: 'toolResult', toolCallId: 'call-1', toolName: 'edit', content: [{ type: 'text', text: 'Edited 1 line' }] },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);

    const toolMsg = history.find((m) => m.role === 'tool') as
      | (ConversationMessage & { input?: Record<string, unknown> })
      | undefined;
    assert.ok(toolMsg);
    assert.equal(toolMsg.toolEventId, 'call-1');
    assert.equal(toolMsg.toolName, 'edit');
    assert.deepEqual(toolMsg.input, { path: 'src/a.ts', edits: [{ oldText: 'x', newText: 'y' }] });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory assistant 仅含 toolCall（正文空被跳过）仍回填入参', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-session-tc-only', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hi', timestamp: Date.parse('2026-01-01T00:00:01Z') } },
      {
        type: 'message',
        id: 'm2',
        parentId: 'm1',
        timestamp: '2026-01-01T00:00:02Z',
        message: {
          role: 'assistant',
          content: [{ type: 'toolCall', id: 'call-9', name: 'write', arguments: { path: 'b.md', content: 'hello' } }],
          stopReason: 'toolUse',
          usage: {},
          api: 'openai-completions',
          provider: 'test',
          model: 'test-model',
          timestamp: Date.parse('2026-01-01T00:00:02Z'),
        },
      },
      {
        type: 'message',
        id: 'm3',
        parentId: 'm2',
        timestamp: '2026-01-01T00:00:03Z',
        message: { role: 'toolResult', toolCallId: 'call-9', content: [{ type: 'text', text: 'ok' }] },
      },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);

    // assistant 正文为空被跳过，不出现在历史中
    assert.equal(history.some((m) => m.role === 'assistant'), false);
    const toolMsg = history.find((m) => m.role === 'tool') as
      | (ConversationMessage & { input?: Record<string, unknown> })
      | undefined;
    assert.ok(toolMsg);
    // toolResult 无 toolName → 从 toolCall part 兜底恢复
    assert.equal(toolMsg.toolName, 'write');
    assert.deepEqual(toolMsg.input, { path: 'b.md', content: 'hello' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== CV-S07 口径修正（2026-09-26 用户反馈「压缩后历史消息没了」）=====
//
// 压缩只该替换喂给**模型**的上下文；用户看到的 transcript 应完整保留。
// pi 为此提供两个读取口：buildContextEntries() = 已应用压缩的上下文视图，
// getBranch() = 叶子→根的全量分支。历史加载必须走后者，并把 compaction 条目
// 渲染成 witness 标记，否则压缩点之前的对话在界面上会整段消失。

/** 造一个「压缩点前 2 条 + 压缩 + 压缩点后 2 条」的会话文件 */
function writeCompactedSession(file: string, root: string): void {
  fs.writeFileSync(file, [
    { type: 'session', version: 3, id: 'pi-session-compact', timestamp: '2026-01-01T00:00:00Z', cwd: root },
    { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: '旧提问', timestamp: Date.parse('2026-01-01T00:00:01Z') } },
    { type: 'message', id: 'm2', parentId: 'm1', timestamp: '2026-01-01T00:00:02Z', message: { role: 'assistant', content: [{ type: 'text', text: '旧回答' }], stopReason: 'stop', usage: {}, api: 'openai-completions', provider: 'test', model: 'test-model', timestamp: Date.parse('2026-01-01T00:00:02Z') } },
    { type: 'compaction', id: 'c1', parentId: 'm2', timestamp: '2026-01-01T00:00:03Z', summary: '旧对话摘要', firstKeptEntryId: 'm2', tokensBefore: 40000 },
    { type: 'message', id: 'm3', parentId: 'c1', timestamp: '2026-01-01T00:00:04Z', message: { role: 'user', content: '新提问', timestamp: Date.parse('2026-01-01T00:00:04Z') } },
    { type: 'message', id: 'm4', parentId: 'm3', timestamp: '2026-01-01T00:00:05Z', message: { role: 'assistant', content: [{ type: 'text', text: '新回答' }], stopReason: 'stop', usage: {}, api: 'openai-completions', provider: 'test', model: 'test-model', timestamp: Date.parse('2026-01-01T00:00:05Z') } },
  ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');
}

test('loadPiSessionHistory 压缩后压缩点之前的消息仍在历史里（不再随上下文一起丢）', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    writeCompactedSession(file, root);

    const history = await loadPiSessionHistory(file);
    const texts = history.filter((m) => m.role === 'user' || m.role === 'assistant').map((m) => m.content);

    assert.deepEqual(texts, ['旧提问', '旧回答', '新提问', '新回答'], '压缩点之前的 旧提问/旧回答 必须还在');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory compaction 条目产出压缩分隔标记（role=system + compacted）', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    writeCompactedSession(file, root);

    const history = await loadPiSessionHistory(file);
    const markers = history.filter((m) => m.role === 'system');

    assert.equal(markers.length, 1);
    assert.equal(markers[0]!.compacted, true);
    assert.equal(markers[0]!.content, '旧对话摘要', '摘要内容保留在标记上，供 UI 折叠展示');
    assert.equal(markers[0]!.ts, '2026-01-01T00:00:03Z');
    // 标记的位置必须落在「压缩前」与「压缩后」之间：顺序错位会让分隔条本身变成误导
    const roles = history.map((m) => m.role);
    assert.deepEqual(roles, ['user', 'assistant', 'system', 'user', 'assistant']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 未压缩会话不产生任何 system 标记', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'session.jsonl');
    fs.writeFileSync(file, [
      { type: 'session', version: 3, id: 'pi-plain', timestamp: '2026-01-01T00:00:00Z', cwd: root },
      { type: 'message', id: 'm1', parentId: null, timestamp: '2026-01-01T00:00:01Z', message: { role: 'user', content: 'hi', timestamp: Date.parse('2026-01-01T00:00:01Z') } },
    ].map((entry) => JSON.stringify(entry)).join('\n') + '\n');

    const history = await loadPiSessionHistory(file);
    assert.equal(history.some((m) => m.role === 'system'), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('loadPiSessionHistory 损坏 JSONL 给出可读错误（P2-D 异常降级）', async () => {
  const root = makeTempDir();
  try {
    const file = path.join(root, 'corrupt.jsonl');
    fs.writeFileSync(file, '{not-valid-json\n{"type":"session"}\n', 'utf8');
    await assert.rejects(loadPiSessionHistory(file), /已损坏/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
