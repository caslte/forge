/**
 * 采样通道（转录 → IrSample[]）的测试。
 *
 * 为什么测试用「构造的转录文件」不算自证：阶段 1 的纪律禁止**自造样本去算通过率**，
 * 因为那是拿自己出的题考自己。而这里测的是**解析器**——转录长什么样是既成事实
 * （结构抄自真实文件），构造出来只是为了让解析器有确定的输入。两件事不能混为一谈。
 *
 * 重点覆盖「首次通过率」的口径：一个请求的修复轮不能进分母。这条错了，
 * 算出来的通过率会系统性偏低，阶段 1 的结论就跟着错。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractFromTranscript,
  extractIrSamples,
  findTranscripts,
} from '../../src/canvasIrStats/extractIrSamples.ts';

const IR_JSON = JSON.stringify({
  schema_version: 'forge-ir/2',
  diagram_type: 'architecture',
  meta: { title: 't' },
  nodes: [{ id: 'a', label: 'A', kind: 'process', col: 0, row: 0 }],
  edges: [],
});

/** 一条合规的 IR 围栏（含换行，与模型真实产出同形）。 */
const fence = (json: string = IR_JSON): string => '```canvas-ir\n' + json + '\n```';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-ir-samples-'));
}

function writeTranscript(dir: string, name: string, lines: unknown[]): string {
  const file = path.join(dir, name);
  fs.writeFileSync(file, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
  return file;
}

const sessionLine = (cwd = 'C:\\proj') => ({ type: 'session', version: 3, id: 's1', timestamp: 't', cwd });

const modelChange = (provider: string, modelId: string) => ({
  type: 'model_change', id: 'mc1', parentId: null, timestamp: 't', provider, modelId,
});

const userLine = (text: string, id = 'u1') => ({
  type: 'message', id, parentId: null, timestamp: 't',
  message: { role: 'user', content: [{ type: 'text', text }] },
});

const assistantLine = (text: string, opts: { id?: string; model?: string; provider?: string } = {}) => ({
  type: 'message', id: opts.id ?? 'a1', parentId: null, timestamp: 't',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text }],
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.provider ? { provider: opts.provider } : {}),
  },
});

test('从转录抽出围栏内容作为样本，并带上 prompt', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-aaa.jsonl', [
    sessionLine(),
    modelChange('mx', 'Model-X'),
    userLine('画一个分层架构图'),
    assistantLine('好的：\n' + fence()),
  ]);

  const r = extractFromTranscript(file);
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0]!.source.trim(), IR_JSON);
  assert.equal(r.samples[0]!.prompt, '画一个分层架构图');
  assert.equal(r.samples[0]!.model, 'mx/Model-X');
  assert.equal(r.badLines, 0);
  assert.equal(r.skippedRepairs, 0);
});

test('首次通过率口径：同一请求的第二个围栏算修复轮，不进分母', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-bbb.jsonl', [
    userLine('画架构图'),
    assistantLine(fence(), { id: 'a1' }),
    assistantLine(fence(), { id: 'a2' }), // 被打回后重出
    assistantLine(fence(), { id: 'a3' }),
  ]);

  const r = extractFromTranscript(file);
  assert.equal(r.samples.length, 1, '只保留首轮');
  assert.equal(r.fenceMessages, 3, '围栏消息数要如实记录，便于对账');
  assert.equal(r.skippedRepairs, 2);
});

test('新的用户消息重置「首次」计数（每个请求各取首轮）', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-ccc.jsonl', [
    userLine('第一个请求', 'u1'),
    assistantLine(fence(), { id: 'a1' }),
    assistantLine(fence(), { id: 'a2' }),
    userLine('第二个请求', 'u2'),
    assistantLine(fence(), { id: 'a3' }),
  ]);

  const r = extractFromTranscript(file);
  assert.equal(r.samples.length, 2);
  assert.equal(r.samples[0]!.prompt, '第一个请求');
  assert.equal(r.samples[1]!.prompt, '第二个请求');
  assert.equal(r.skippedRepairs, 1);
});

test('firstAttemptOnly=false 时修复轮也计入', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-ddd.jsonl', [
    userLine('画架构图'),
    assistantLine(fence(), { id: 'a1' }),
    assistantLine(fence(), { id: 'a2' }),
  ]);

  const r = extractFromTranscript(file, { firstAttemptOnly: false });
  assert.equal(r.samples.length, 2);
  assert.equal(r.skippedRepairs, 0);
});

test('围栏开口被思考标记劈开：修回后样本照常进分母，且计数单列', () => {
  // 2026-10-13 门禁实测 flow-ci：正文里混进了 reasoning 块的闭合标记，落在
  // ```canvas-ir 开口行内，把语言名劈成「canvas + 标记 + 空行 + -ir」。
  // 不修的话这条**合格**样本会被当成「模型没画」静默挤出分母，首次通过率虚低，
  // 而报告上看不出任何迹象——所以修好后必须把「修过几次」显式记出来。
  const leak = '</' + 'thi' + 'nk>';
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-leak.jsonl', [
    userLine('画 CI 流程图'),
    assistantLine('Let me finalize.```canvas' + leak + '\n\n-ir\n' + IR_JSON + '\n```'),
  ]);

  const r = extractFromTranscript(file);
  assert.equal(r.samples.length, 1, '修好开口后这条合格样本必须进分母');
  assert.equal(r.samples[0]!.source.trim(), IR_JSON);
  assert.equal(r.repairedOpeners, 1, '修过几次要记账，不能让「无围栏」单独撒谎');
});

test('模型优先取消息自带，缺失时回退最近一次 model_change', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-eee.jsonl', [
    modelChange('mx', 'Fallback'),
    userLine('q1', 'u1'),
    assistantLine(fence(), { id: 'a1', provider: 'anthropic', model: 'Inline' }),
    userLine('q2', 'u2'),
    assistantLine(fence(), { id: 'a2' }), // 无 model → 回退到 model_change
  ]);

  const r = extractFromTranscript(file);
  assert.equal(r.samples.length, 2);
  assert.equal(r.samples[0]!.model, 'anthropic/Inline');
  assert.equal(r.samples[1]!.model, 'mx/Fallback');
});

test('content 为纯字符串的消息同样能抽出', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-fff.jsonl', [
    { type: 'message', id: 'u1', parentId: null, timestamp: 't', message: { role: 'user', content: '直接问' } },
    { type: 'message', id: 'a1', parentId: null, timestamp: 't', message: { role: 'assistant', content: fence() } },
  ]);

  const r = extractFromTranscript(file);
  assert.equal(r.samples.length, 1);
  assert.equal(r.samples[0]!.prompt, '直接问');
});

test('损坏行跳过并计数，不影响同文件其它样本', () => {
  const dir = tmpDir();
  const file = writeTranscript(dir, 'forge-ggg.jsonl', [
    userLine('q'),
    '{ 这不是合法 JSON',
    assistantLine(fence()),
  ]);

  const r = extractFromTranscript(file);
  assert.equal(r.badLines, 1);
  assert.equal(r.samples.length, 1);
});

test('没有围栏的文件进 filesWithoutIr（回答「是不是根本没触发」）', () => {
  const dir = tmpDir();
  const withIr = writeTranscript(dir, 'forge-h1.jsonl', [userLine('q'), assistantLine(fence())]);
  writeTranscript(dir, 'forge-h2.jsonl', [userLine('q'), assistantLine('只是聊了两句，没有画图')]);

  const r = extractIrSamples([dir]);
  assert.equal(r.files.length, 2);
  assert.equal(r.samples.length, 1);
  assert.equal(r.filesWithoutIr.length, 1);
  assert.ok(r.filesWithoutIr[0]!.endsWith('forge-h2.jsonl'));
  assert.ok(r.files.some((f) => f === withIr));
});

test('旧版 canvas（HTML）围栏不会被误当 IR 样本', () => {
  const dir = tmpDir();
  writeTranscript(dir, 'forge-i1.jsonl', [
    userLine('画个图'),
    assistantLine('```canvas\n<div>旧链路</div>\n```'),
  ]);

  const r = extractIrSamples([dir]);
  assert.equal(r.samples.length, 0);
  assert.equal(r.filesWithoutIr.length, 1);
});

test('findTranscripts 递归且只认 forge-*.jsonl', () => {
  const dir = tmpDir();
  const sub = path.join(dir, 'C%3A%5Cproj');
  fs.mkdirSync(sub, { recursive: true });
  writeTranscript(sub, 'forge-real.jsonl', [userLine('q')]);
  writeTranscript(sub, '2026-07-21T03-28-14-610Z_019f82b7.jsonl', [userLine('q')]); // pi CLI 原生
  writeTranscript(sub, 'notes.txt', [userLine('q')]);

  const found = findTranscripts(dir);
  assert.equal(found.length, 1);
  assert.ok(found[0]!.endsWith('forge-real.jsonl'));
});

test('路径不存在时返回空结果而不抛错', () => {
  const r = extractIrSamples([path.join(os.tmpdir(), 'forge-ir-does-not-exist-xyz')]);
  assert.deepEqual(r.files, []);
  assert.deepEqual(r.samples, []);
});

test('model 过滤在汇总阶段生效，且不干扰首轮判定', () => {
  const dir = tmpDir();
  writeTranscript(dir, 'forge-j1.jsonl', [
    userLine('q'),
    assistantLine(fence(), { id: 'a1', provider: 'mx', model: 'A' }),
    assistantLine(fence(), { id: 'a2', provider: 'mx', model: 'B' }),
  ]);

  const r = extractIrSamples([dir], { model: 'mx/B' });
  assert.equal(r.samples.length, 0, '首轮是 mx/A，按 mx/B 过滤后无样本');
  assert.equal(r.skippedRepairs, 1, '被过滤掉的首轮仍应让后续轮算作修复轮');
});
