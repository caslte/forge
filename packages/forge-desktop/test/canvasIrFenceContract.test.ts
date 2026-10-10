/**
 * IR 围栏契约（阶段 1）。
 *
 * 借鉴 canvasFenceContract.test.ts 的教训：围栏名与校验器的一致性若无人看守，
 * 失效形式是**静默**的——模型照常输出 ```canvas-ir，校验层不认，于是静默降级，
 * 日志里没有任何报错。所以这类契约必须有测试。
 *
 * 本文件守三条：
 * 1. 提示词写给模型的围栏名 == 校验器/统计工具认的围栏名；
 * 2. 提示词声明的 schema 版本 == 校验器期望的版本；
 * 3. IR 契约里**不允许出现排版指导**——这是方案 A 的核心断言，
 *    一旦有人往契约里加回「用 flex/gap/颜色」这类规则，模型就会退回写 HTML。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IR_FENCE_LANGUAGE, IR_SPEC, IR_STANZA } from '../../forge-extensions/src/canvasIrHint/index.ts';
import {
  IR_DIAGRAM_TYPES,
  IR_MAX_LABEL_CHARS,
  IR_MAX_NODES,
  IR_NODE_KINDS,
  IR_SCHEMA_VERSION,
  judgeIr,
} from '@forge/core/markdown';

test('IR 围栏名与提示词一致（不一致则 IR 静默不被识别）', () => {
  assert.equal(IR_FENCE_LANGUAGE, 'canvas-ir');
});

test('IR 围栏名不得与既有 canvas 围栏相同（否则两套载荷混淆）', () => {
  assert.notEqual(IR_FENCE_LANGUAGE, 'canvas');
});

test('提示词声明的 schema 版本 == 校验器期望的版本', () => {
  const spec = IR_SPEC.join('\n');
  assert.ok(spec.includes(IR_SCHEMA_VERSION),
    '契约必须写出当前 schema 版本，否则模型写出别的版本会被判 IR001');
});

test('提示词声明的节点数与标签上限 == 校验器实际约束', () => {
  const spec = IR_SPEC.join('\n');
  assert.ok(spec.includes(String(IR_MAX_NODES)), '契约未声明节点上限');
  assert.ok(spec.includes(String(IR_MAX_LABEL_CHARS)), '契约未声明标签上限');
});

test('提示词列出的 node kind == 校验器白名单（模型照契约写就不会被判 IR009）', () => {
  const spec = IR_SPEC.join('\n');
  for (const k of IR_NODE_KINDS) {
    assert.ok(spec.includes('"' + k + '"'), '契约未列出 kind：' + k);
  }
});

test('提示词列出的 diagram_type == 校验器白名单', () => {
  const spec = IR_SPEC.join('\n');
  for (const t of IR_DIAGRAM_TYPES) {
    assert.ok(spec.includes('"' + t + '"'), '契约未列出 diagram_type：' + t);
  }
});

test('IR 契约不含排版指导 —— 这是方案 A 的核心断言', () => {
  const full = IR_SPEC.join('\n') + ' ' + IR_STANZA;

  // 关键：不能只检测「有没有排版词」——契约本来就要写禁令（"no margins"、
  // "Never compute pixel coordinates"），那是必需的，不是指导。
  // 只能检测**指导性句式**：某排版词被当作做法告诉模型去用。
  const GUIDANCE_PATTERNS: RegExp[] = [
    /\buse\s+(css\s+)?flex\b/,
    /\buse\s+(css\s+)?grid\b/,
    /\bset\s+(the\s+)?(padding|margin|color|font-size)\b/,
    /\badd\s+(a\s+)?(border-radius|z-index|padding|margin)\b/,
    /\bwith\s+(padding|margin)\s*:/,
    /\bflex-direction\s*:/,
    /\bgrid-template-columns\s*:/,
    /\bborder-radius\s*:\s*\d/,
    /\bfont-size\s*:\s*\d/,
    /\bcolor\s*:\s*#/,
    /\bbackground-color\s*:\s*#/,
    /\bposition\s*:\s*absolute/,
    /\bz-index\s*:/,
  ];
  for (const re of GUIDANCE_PATTERNS) {
    assert.ok(!re.test(full), 'IR 契约出现排版指导句式（匹配 ' + re + '）—— IR 链路不应教模型排版');
  }

  // 反向断言：禁令必须真的在位，否则等于没禁
  const lower = full.toLowerCase();
  for (const mustHave of ['no html', 'no css', 'no colors', 'no margins', 'no styling']) {
    assert.ok(lower.includes(mustHave), '契约缺少必需禁令：' + mustHave);
  }
  // 且必须禁止自己算像素
  assert.ok(/never compute pixel|do not .*pixel|pixel values/i.test(full),
    '契约应明确禁止模型自行计算像素坐标');
});

test('IR 契约明确禁止输出 HTML / CSS', () => {
  const spec = (IR_SPEC.join('\n') + ' ' + IR_STANZA);
  assert.ok(/no html|css/i.test(spec), '契约未明确禁止 HTML/CSS');
});

test('按契约产出的 IR 确实能通过校验（契约与校验器口径一致）', () => {
  const ir = {
    schema_version: IR_SCHEMA_VERSION,
    diagram_type: IR_DIAGRAM_TYPES[0],
    meta: { title: '契约样例' },
    nodes: [{ id: 'a', label: '节点A', kind: IR_NODE_KINDS[0], col: 0, row: 0 }],
    edges: [],
  };
  const r = judgeIr(JSON.stringify(ir));
  assert.equal(r.verdict, 'ok', '契约样例被判失败：' + JSON.stringify(r.diagnostics));
});

test('IR 契约要求原始 JSON，而校验器对代码围栏容忍（围栏剥离是宿主责任）', () => {
  const spec = (IR_SPEC.join('\n') + ' ' + IR_STANZA);
  assert.ok(/raw json/i.test(spec), '契约未强调「raw JSON only」');
});