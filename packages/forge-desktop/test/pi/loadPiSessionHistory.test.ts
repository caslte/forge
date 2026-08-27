import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadPiSessionHistory } from '../../src/pi/loadPiSessionHistory.ts';

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
