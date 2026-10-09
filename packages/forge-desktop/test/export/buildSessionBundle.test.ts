/**
 * 会话导出包构建单测（SM-S08）。
 *
 * 包内现在**只有 transcript.jsonl 一份**（用户裁定去掉 meta：会话身份信息本来就在
 * 原生首行 `{type:'session', version, id, timestamp, cwd}` 里，再平行造一份是冗余 +
 * 必然漂移的维护债）。
 *
 * 重点是三条业务红线：
 *  1. **转录与磁盘原文件逐字节一致** —— TD-SM-06 硬约束。一旦有人在这条链上
 *     "顺手 trim 一下空行"，AI 思考链与被压缩的早期上下文就永久丢了。
 *  2. **失败不留任何残件** —— 不产出半成品包去误导接手方（AC-SM-039）。
 *  3. **不含源码/图片实体**。
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { exportSessionBundle, TRANSCRIPT_ENTRY_NAME } from '../../src/export/buildSessionBundle.ts';

/** 独立读 ZIP（只按格式解，不复用 zipWriter —— 字段错位会互相抵消） */
function readZip(buf: Buffer): Map<string, Buffer> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, '未找到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  let p = cdOffset;
  for (let i = 0; i < count; i += 1) {
    assert.equal(buf.readUInt32LE(p), 0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const localOffset = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    const dataStart = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
    const compSize = buf.readUInt32LE(p + 20);
    const body = buf.subarray(dataStart, dataStart + compSize);
    out.set(name, method === 8 ? inflateRawSync(body) : body);
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/**
 * 造一条"真会长成什么样"的转录：按 pi 原生格式 —— 首行会话头（含 cwd/timestamp）、
 * model_change 行、thinking 块、空行、toolCall块、非ASCII 混排。
 */
function makeRawTranscript(): string {
  return [
    JSON.stringify({
      type: 'session',
      version: 3,
      id: 'forge-sess_1',
      timestamp: '2026-10-01T10:00:00.000Z',
      cwd: 'C:/works/ai_work/forge',
    }),
    JSON.stringify({ type: 'model_change', id: 'm1', parentId: null, timestamp: '2026-10-01T10:00:00.050Z', provider: 'deepseek', modelId: 'deepseek-chat' }),
    JSON.stringify({ type: 'message', id: 'u1', parentId: 'm1', timestamp: '2026-10-01T10:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '帮我排查白屏' }] } }),
    // thinking 块 —— 界面加载链路会丢弃它，导出必须原样保留
    JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-01T10:00:02.000Z', message: { role: 'assistant', content: [{ type: 'thinking', thinking: '内部推理不该丢🧠' }] } }),
    '',
    // toolCall 原始入参 —— 同样会被界面链路重建而非原样
    JSON.stringify({ type: 'message', id: 'a2', parentId: 'a1', timestamp: '2026-10-01T10:00:03.000Z', message: { role: 'assistant', content: [{ type: 'toolCall', id: 't1', name: 'edit', arguments: { file_path: 'C:/x/a.ts', old_string: 'a', new_string: 'b' } }] } }),
  ].join('\n');
}

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-bundle-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test('exportSessionBundle 包内只有 transcript.jsonl 一份，且与磁盘原文件逐字节一致', () => {
  withTempDir((dir) => {
    const raw = makeRawTranscript();
    const src = path.join(dir, 'forge-sess_1.jsonl');
    fs.writeFileSync(src, raw, 'utf8');
    const out = path.join(dir, 'out.zip');

    const res = exportSessionBundle('sess_1', out, { resolveSessionFile: () => src });
    assert.equal(res.ok, true);

    const files = readZip(fs.readFileSync(out));
    // 用户裁定：去掉 meta，包内只有转录
    assert.deepEqual([...files.keys()], [TRANSCRIPT_ENTRY_NAME]);

    const got = files.get(TRANSCRIPT_ENTRY_NAME);
    assert.ok(got !== undefined);
    assert.deepEqual(got, Buffer.from(raw, 'utf8'));

    // 逐点名关键内容都在（防止将来有人"清理"这些行）
    const text = got.toString('utf8');
    assert.match(text, /"cwd":"C:\/works\/ai_work\/forge"/, '会话头（cwd）必须保留');
    assert.match(text, /"modelId":"deepseek-chat"/, '模型信息行必须保留');
    assert.match(text, /内部推理不该丢/, 'thinking 块必须保留');
    assert.match(text, /"old_string":"a"/, '工具原始入参必须保留');
    assert.match(text, /\n\n/, '空行必须保留');
  });
});

test('exportSessionBundle 不含项目源码与图片附件实体', () => {
  withTempDir((dir) => {
    const src = path.join(dir, 'a.jsonl');
    fs.writeFileSync(src, makeRawTranscript(), 'utf8');
    const out = path.join(dir, 'out.zip');
    assert.equal(exportSessionBundle('s', out, { resolveSessionFile: () => src }).ok, true);
    const names = [...readZip(fs.readFileSync(out)).keys()];
    for (const n of names) {
      assert.doesNotMatch(n, /\.(ts|js|png|jpe?g|svg)$/i, '不得出现源码/图片实体条目');
      assert.ok(!n.includes('/'), '条目名不带目录层级，避免把项目结构带出去');
    }
  });
});

test('exportSessionBundle 会话无磁盘记录时失败且不产出任何文件', () => {
  withTempDir((dir) => {
    const out = path.join(dir, 'out.zip');
    const res = exportSessionBundle('ghost', out, { resolveSessionFile: () => undefined });
    assert.deepEqual(res, { ok: false, reason: 'session-not-found' });
    assert.equal(fs.existsSync(out), false);
  });
});

test('exportSessionBundle 转录缺失/目标不可写时失败且不留残件', () => {
  withTempDir((dir) => {
    const out1 = path.join(dir, 'o1.zip');
    const r1 = exportSessionBundle('s', out1, {
      resolveSessionFile: () => path.join(dir, 'nope.jsonl'),
    });
    assert.deepEqual(r1, { ok: false, reason: 'transcript-missing' });
    assert.equal(fs.existsSync(out1), false, '不得产出残缺包让接手方误判记录完整');

    const src = path.join(dir, 'a.jsonl');
    fs.writeFileSync(src, makeRawTranscript(), 'utf8');
    const bad = path.join(dir, 'no-such-dir', 'o2.zip');
    const r2 = exportSessionBundle('s', bad, { resolveSessionFile: () => src });
    assert.deepEqual(r2, { ok: false, reason: 'target-unwritable' });
  });
});

test('exportSessionBundle 同一会话重复导出得到等价包（幂等）', () => {
  withTempDir((dir) => {
    const src = path.join(dir, 'a.jsonl');
    fs.writeFileSync(src, makeRawTranscript(), 'utf8');
    const deps = { resolveSessionFile: () => src };
    const a = path.join(dir, 'a.zip');
    const b = path.join(dir, 'b.zip');
    assert.equal(exportSessionBundle('s', a, deps).ok, true);
    assert.equal(exportSessionBundle('s', b, deps).ok, true);
    assert.deepEqual(fs.readFileSync(a), fs.readFileSync(b));
  });
});

test('exportSessionBundle 对非 ASCII 内容按字节处理（不被编码转换破坏）', () => {
  withTempDir((dir) => {
    const raw = [
      JSON.stringify({ type: 'message', message: { role: 'user', content: [{ type: 'text', text: '中文 🌍 émoji' }] } }),
      JSON.stringify({ type: 'message', message: { role: 'assistant', content: [{ type: 'text', text: '第二行\ttab' }] } }),
    ].join('\n');
    const src = path.join(dir, 'a.jsonl');
    fs.writeFileSync(src, raw, 'utf8');
    const out = path.join(dir, 'o.zip');
    assert.equal(exportSessionBundle('s', out, { resolveSessionFile: () => src }).ok, true);
    const got = readZip(fs.readFileSync(out)).get(TRANSCRIPT_ENTRY_NAME)!;
    assert.equal(got.toString('utf8'), raw);
    assert.ok(got.includes(Buffer.from('🌍', 'utf8')));
  });
});

test('exportSessionBundle 空会话（0 字节转录）也能产出结构合法的包', () => {
  withTempDir((dir) => {
    const src = path.join(dir, 'a.jsonl');
    fs.writeFileSync(src, '', 'utf8');
    const out = path.join(dir, 'o.zip');
    const res = exportSessionBundle('s', out, { resolveSessionFile: () => src });
    assert.equal(res.ok, true);
    const got = readZip(fs.readFileSync(out)).get(TRANSCRIPT_ENTRY_NAME);
    assert.ok(got !== undefined);
    assert.equal(got.length, 0);
  });
});