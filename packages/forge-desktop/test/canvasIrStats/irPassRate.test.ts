/**
 * 通过率统计的测试。
 *
 * 为什么统计工具也要测：它就是阶段 1 的「裁判」。
 * 裁判算错通过率 ⇒ 阶段 1 结论错 ⇒ 后面所有投入都建立在错误前提上。
 * **这比校验器本身更不能出错。**
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  STAGE1_PASS_THRESHOLD,
  formatPassRateReport,
  reportSamples,
  type IrSample,
} from '../../src/canvasIrStats/irPassRate.ts';

const IR = (n = 3) => JSON.stringify({
  schema_version: 'forge-ir/1',
  diagram_type: 'architecture',
  meta: { title: 't' },
  nodes: Array.from({ length: n }, (_, i) => ({
    id: 'n' + i, label: '节点' + i, kind: 'process', col: i, row: 0,
  })),
  edges: n > 1 ? [{ from: 'n0', to: 'n1' }] : [],
});

const BAD_NO_VERSION = (() => {
  const ir = JSON.parse(IR());
  delete ir.schema_version;
  return JSON.stringify(ir);
})();

const BAD_GHOST_EDGE = JSON.stringify({
  schema_version: 'forge-ir/1',
  diagram_type: 'architecture',
  meta: {},
  nodes: [{ id: 'a', label: 'A', kind: 'process', col: 0, row: 0 }],
  edges: [{ from: 'a', to: 'ghost' }],
});

function sample(id: string, source: string, model = 'm1'): IrSample {
  return { id, prompt: '画个图 ' + id, source, model };
}

test('空样本集通过率为 0 且判定 fail', () => {
  const r = reportSamples([]);
  assert.equal(r.total, 0);
  assert.equal(r.passed, 0);
  assert.equal(r.firstPassRate, 0);
  assert.equal(r.verdict, 'fail');
});

test('全通过的样本集判定 pass', () => {
  const r = reportSamples([sample('s1', IR()), sample('s2', IR(4))]);
  assert.equal(r.passed, 2);
  assert.equal(r.verdict, 'pass');
});

test('通过率按总样本数计算，不因部分失败而稀释分母', () => {
  const r = reportSamples([sample('ok', IR()), sample('bad', BAD_GHOST_EDGE)]);
  assert.equal(r.total, 2);
  assert.equal(r.passed, 1);
  assert.equal(r.firstPassRate, 0.5);
});

test('门槛为 80%', () => {
  assert.equal(STAGE1_PASS_THRESHOLD, 0.8);
});

test('恰好 80% 判pass，79% 判 fail（边界必须明确）', () => {
  const mk = (passCount: number, total: number) => reportSamples(
    Array.from({ length: total }, (_, i) =>
      sample('s' + i, i < passCount ? IR() : BAD_GHOST_EDGE)),
  );
  assert.equal(mk(16, 20).firstPassRate, 0.8);
  assert.equal(mk(16, 20).verdict, 'pass');
  assert.equal(mk(15, 20).firstPassRate, 0.75);
  assert.equal(mk(15, 20).verdict, 'fail');
});

test('缺陷码按出现次数汇总，可定位最常犯的错', () => {
  const r = reportSamples([
    sample('s1', BAD_GHOST_EDGE),
    sample('s2', BAD_GHOST_EDGE),
    sample('s3', BAD_NO_VERSION),
  ]);
  assert.equal(r.codeHistogram['IR002'], 2);
  assert.equal(r.codeHistogram['IR001'], 1);
});

test('按模型分组统计，单模型模型名不出现分组键', () => {
  const r = reportSamples([
    sample('a1', IR(), 'model-A'),
    sample('a2', BAD_GHOST_EDGE, 'model-A'),
    sample('b1', IR(), 'model-B'),
  ]);
  assert.equal(r.byModel['model-A'].total, 2);
  assert.equal(r.byModel['model-A'].passed, 1);
  assert.equal(r.byModel['model-A'].rate, 0.5);
  assert.equal(r.byModel['model-B'].rate, 1);
});

test('未标注模型的样本归入(未标注)而非被丢弃', () => {
  const s = sample('x', IR());
  delete s.model;
  const r = reportSamples([s]);
  assert.equal(r.byModel['(未标注)'].total, 1);
});

test('失败样本逐条列出，含 request 上下文与诊断，便于人工回看', () => {
  const r = reportSamples([sample('f1', BAD_GHOST_EDGE, 'm1')]);
  const f = r.perSample.find((x) => x.sample.id === 'f1');
  assert.ok(f);
  assert.equal(f.judgement.verdict, 'fail');
  assert.ok(f.judgement.diagnostics.length > 0);
});

test('judgement 失败时 ir 字段为 null，调用方不得误用', () => {
  const r = reportSamples([sample('f', BAD_GHOST_EDGE)]);
  assert.equal(r.perSample[0].judgement.ir, null);
});

test('judgement 通过时 ir 字段非 null', () => {
  const r = reportSamples([sample('p', IR())]);
  assert.notEqual(r.perSample[0].judgement.ir, null);
});

test('报告文本含通过率、门槛、结论三要素', () => {
  const r = reportSamples([sample('a', IR()), sample('b', IR()), sample('c', BAD_GHOST_EDGE)]);
  const txt = formatPassRateReport(r);
  assert.match(txt, /2\/3/);
  assert.match(txt, /80%/);
  assert.match(txt, /不通过|通过/);
});

test('报告文本在失败时给出失败样本明细', () => {
  const r = reportSamples([sample('f1', BAD_GHOST_EDGE)]);
  const txt = formatPassRateReport(r);
  assert.match(txt, /失败样本/);
  assert.match(txt, /f1/);
  assert.match(txt, /IR002/);
});