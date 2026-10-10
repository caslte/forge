/**
 * 画布 IR 校验器（阶段 1 · 对标 Archify 的 schema validation）。
 *
 * 阶段 1 的目的是回答唯一真风险问题：「模型能否稳定产出合规 IR」。
 * 本文件就是那个判定的执行者——它必须能机械回答「这份 IR 合不合格」，
 * 结论不经过任何模型判断。
 *
 * 与 canvasSandbox.ts 的分工（勿混淆）：
 * - canvasSandbox：现状「模型直出 HTML」的事后形态判决（像不像图 / 是不是散文）
 * - canvasIr：对 IR 的**事前**结构校验，是本轮新增的唯一模块
 *
 * 本文件只做 schema 层 + 引用完整性，不含布局计算（那是阶段 2）。
 * 阶段 1 不做布局是有意的：先确认模型能稳定产出结构，再谈把结构排好。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  IR_SCHEMA_VERSION,
  IR_MAX_NODES,
  judgeIr,
  parseIr,
} from '../../src/markdown/canvasIr.ts';

/** 最小合规样例：3 节点 2 边，architecture 类。 */
function validIr(): string {
  return JSON.stringify({
    schema_version: IR_SCHEMA_VERSION,
    diagram_type: 'architecture',
    meta: { title: 'forge 请求链路', quality_profile: 'showcase' },
    nodes: [
      { id: 'ui', label: '渲染进程', kind: 'component', col: 0, row: 0 },
      { id: 'ipc', label: 'IPC 边界', kind: 'boundary', col: 1, row: 0 },
      { id: 'main', label: '主进程', kind: 'process', col: 2, row: 0 },
    ],
    edges: [
      { from: 'ui', to: 'ipc' },
      { from: 'ipc', to: 'main' },
    ],
  });
}

function withIr(mutate: (ir: any) => void): string {
  const ir = JSON.parse(validIr());
  mutate(ir);
  return JSON.stringify(ir);
}

// ---------------------------------------------------------------- schema 完整性

test('合规 IR 返回 ok', () => {
  const r = judgeIr(validIr());
  assert.equal(r.verdict, 'ok');
  assert.deepEqual(r.diagnostics, []);
});

test('缺 schema_version 报 IR001', () => {
  const r = judgeIr(withIr((ir) => { delete ir.schema_version; }));
  assert.equal(r.verdict, 'fail');
  assert.equal(r.diagnostics[0].code, 'IR001');
  assert.equal(r.diagnostics[0].subject, 'schema_version');
});

test('schema_version 不匹配当前版本报 IR001并给出期望值', () => {
  const r = judgeIr(withIr((ir) => { ir.schema_version = 'forge-ir/999'; }));
  assert.equal(r.verdict, 'fail');
  assert.equal(r.diagnostics[0].code, 'IR001');
  assert.match(r.diagnostics[0].evidence, /forge-ir\/1/);
});

test('未知 diagram_type 报 IR003', () => {
  const r = judgeIr(withIr((ir) => { ir.diagram_type = 'orgchart'; }));
  assert.equal(r.verdict, 'fail');
  assert.equal(r.diagnostics[0].code, 'IR003');
});

test('nodes 非数组报 IR004', () => {
  const r = judgeIr(withIr((ir) => { ir.nodes = {}; }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.diagnostics.some((d) => d.code === 'IR004'));
});

test('边缺 from 或 to 报 IR005', () => {
  const r = judgeIr(withIr((ir) => { delete ir.edges[0].from; }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.diagnostics.some((d) => d.code === 'IR005'));
});

// ---------------------------------------------------------------- 引用完整性

test('edge 指向不存在的节点报 IR002', () => {
  const r = judgeIr(withIr((ir) => { ir.edges.push({ from: 'ui', to: 'nosuch' }); }));
  assert.equal(r.verdict, 'fail');
  const d = r.diagnostics.find((x) => x.code === 'IR002');
  assert.ok(d);
  assert.equal(d.subject, 'nosuch');
});

test('节点 id 重复报 IR006', () => {
  const r = judgeIr(withIr((ir) => {
    ir.nodes.push({ id: 'ui', label: '重复', kind: 'process', col: 9, row: 9 });
  }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.diagnostics.some((d) => d.code === 'IR006'));
});

test('自环边报 IR007', () => {
  const r = judgeIr(withIr((ir) => { ir.edges.push({ from: 'ui', to: 'ui' }); }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.diagnostics.some((d) => d.code === 'IR007'));
});

// ---------------------------------------------------------------- 内容约束

test('节点缺 label 报 IR008', () => {
  const r = judgeIr(withIr((ir) => { delete ir.nodes[0].label; }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.diagnostics.some((d) => d.code === 'IR008'));
});

test('未知 node kind 报 IR009', () => {
  const r = judgeIr(withIr((ir) => { ir.nodes[0].kind = 'rainbow'; }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.diagnostics.some((d) => d.code === 'IR009'));
});

test('非整数 col 或 row 报 IR010', () => {
  const r = judgeIr(withIr((ir) => { ir.nodes[0].col = 1.5; }));
  assert.equal(r.verdict, 'fail');
  assert.ok(r.diagnostics.some((d) => d.code === 'IR010'));
});

test('节点数超过上限报 IR011并给出上限值', () => {
  const r = judgeIr(withIr((ir) => {
    ir.nodes = Array.from({ length: IR_MAX_NODES + 1 }, (_, i) => ({
      id: 'n' + i, label: '节点' + i, kind: 'process', col: i, row: 0,
    }));
  }));
  assert.equal(r.verdict, 'fail');
  const d = r.diagnostics.find((x) => x.code === 'IR011');
  assert.ok(d);
  assert.match(d.evidence, new RegExp(String(IR_MAX_NODES)));
});

test('label 超长报 IR012并给出实测宽度', () => {
  const r = judgeIr(withIr((ir) => { ir.nodes[0].label = '超'.repeat(40); }));
  assert.equal(r.verdict, 'fail');
  const d = r.diagnostics.find((x) => x.code === 'IR012');
  assert.ok(d);
  assert.match(d.evidence, /40/);
});

// ---------------------------------------------------------------- 解析与诊断契约

test('非法 JSON 返回 fail 且 code IR000，不抛异常', () => {
  const r = judgeIr('{ 这不是 JSON');
  assert.equal(r.verdict, 'fail');
  assert.equal(r.diagnostics[0].code, 'IR000');
});

test('空字符串返回 fail', () => {
  const r = judgeIr('');
  assert.equal(r.verdict, 'fail');
});

test('诊断带 supportedFixes，供模型按可用控件修复', () => {
  const r = judgeIr(withIr((ir) => { ir.edges.push({ from: 'ui', to: 'ghost' }); }));
  for (const d of r.diagnostics) {
    assert.ok(Array.isArray(d.supportedFixes), 'supportedFixes 必须是数组');
    assert.ok(d.supportedFixes.length > 0, '每个诊断至少给一个可用修复控件');
  }
});

test('多个缺陷一次性全部报出，不短路', () => {
  const r = judgeIr(withIr((ir) => {
    delete ir.schema_version;
    ir.nodes.push({ id: 'ui', label: 'dup', kind: 'process', col: 5, row: 5 });
    ir.edges.push({ from: 'ui', to: 'ghost' });
  }));
  const codes = new Set(r.diagnostics.map((d) => d.code));
  assert.ok(codes.has('IR001'), '应报 schema 缺失');
  assert.ok(codes.has('IR002'), '应报悬空边');
  assert.ok(codes.has('IR006'), '应报 id 重复');
  assert.ok(r.diagnostics.length >= 3, '不应短路，至少 3 条');
});

test('parseIr 对合规 IR 返回对象，对非法返回 null', () => {
  assert.equal(typeof parseIr(validIr()), 'object');
  assert.equal(parseIr('not json'), null);
});