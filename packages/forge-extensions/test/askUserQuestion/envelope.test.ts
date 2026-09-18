/**
 * 模型侧 envelope 三形态与序列化规则（契约 §2.3）。
 *
 * 重点守两条：
 * 1. **preview 不回流** —— envelope 不含 `selected preview:` 段，但
 *    `details.answers[].preview` 照常保留（本项目第一处有意偏离）。
 * 2. **cancelled 与「零段」共用 DECLINE_MESSAGE** —— 模型只看到单一「未作答」
 *    信号，原因保留在 details。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  DECLINE_MESSAGE,
  ENVELOPE_PREFIX,
  ENVELOPE_SUFFIX,
  buildAnswerSegment,
  buildQuestionnaireResponse,
} from '../../src/askUserQuestion/envelope.ts';
import { NO_INPUT_PLACEHOLDER } from '../../src/askUserQuestion/format-answer.ts';
import type { QuestionParams } from '../../src/askUserQuestion/schema.ts';
import type { QuestionAnswer, QuestionnaireResult } from '../../src/askUserQuestion/types.ts';

const params: QuestionParams = {
  questions: [
    { question: 'Q1', header: 'H1', options: [{ label: 'A1', description: '' }, { label: 'A2', description: '' }] },
    { question: 'Q2', header: 'H2', options: [{ label: 'A2', description: '' }, { label: 'A3', description: '' }] },
  ],
};

function answer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return { questionIndex: 0, question: 'Q1', kind: 'option', answer: 'A1', ...overrides };
}

test('单选作答 → "Q"="A" + 前后缀', () => {
  const text = buildAnswerSegment(answer());
  assert.equal(text, '"Q1"="A1".');
});

test('多选 → 逗号连接；空则 (no input)', () => {
  assert.equal(
    buildAnswerSegment(answer({ kind: 'multi', answer: null, selected: ['A2', 'A3'] })),
    '"Q1"="A2, A3".',
  );
  assert.equal(
    buildAnswerSegment(answer({ kind: 'multi', answer: null, selected: [] })),
    `"Q1"="${NO_INPUT_PLACEHOLDER}".`,
  );
});

test('自由输入空串 → (no input)', () => {
  assert.equal(buildAnswerSegment(answer({ kind: 'custom', answer: '' })), `"Q1"="${NO_INPUT_PLACEHOLDER}".`);
  assert.equal(buildAnswerSegment(answer({ kind: 'custom', answer: null })), `"Q1"="${NO_INPUT_PLACEHOLDER}".`);
});

test('每题备注 → user notes 段', () => {
  assert.equal(buildAnswerSegment(answer({ notes: 'prefer foo' })), '"Q1"="A1". user notes: prefer foo.');
});

test('★ preview 不进 envelope（第一处有意偏离），但保留在 details', () => {
  const seg = buildAnswerSegment(answer({ preview: 'GET /search?q=foo' }));
  assert.equal(seg, '"Q1"="A1".');
  assert.ok(!seg.includes('selected preview'));

  const result: QuestionnaireResult = {
    answers: [answer({ preview: 'GET /search?q=foo' })],
    cancelled: false,
  };
  const out = buildQuestionnaireResponse(result, params);
  assert.ok(!out.content[0].text.includes('selected preview'));
  assert.equal(out.details.answers[0]?.preview, 'GET /search?q=foo');
});

test('正常提交：段之间以空格连接，带前后缀', () => {
  const result: QuestionnaireResult = {
    answers: [answer(), answer({ questionIndex: 1, question: 'Q2', kind: 'multi', answer: null, selected: ['A2', 'A3'] })],
    cancelled: false,
  };
  const out = buildQuestionnaireResponse(result, params);
  assert.equal(out.content[0].text, `${ENVELOPE_PREFIX} "Q1"="A1". "Q2"="A2, A3". ${ENVELOPE_SUFFIX}`);
  assert.equal(out.details.cancelled, false);
});

test('globalNote 拼在末位', () => {
  const result: QuestionnaireResult = { answers: [answer()], cancelled: false, globalNote: 'heads up' };
  const out = buildQuestionnaireResponse(result, params);
  assert.equal(out.content[0].text, `${ENVELOPE_PREFIX} "Q1"="A1". global note: heads up. ${ENVELOPE_SUFFIX}`);
});

test('只有 globalNote、无任何作答 → 仍产出已作答 envelope', () => {
  const result: QuestionnaireResult = { answers: [], cancelled: false, globalNote: 'note only' };
  const out = buildQuestionnaireResponse(result, params);
  assert.equal(out.content[0].text, `${ENVELOPE_PREFIX} global note: note only. ${ENVELOPE_SUFFIX}`);
});

test('cancelled → DECLINE，但 details 保留已答部分', () => {
  const result: QuestionnaireResult = { answers: [answer()], cancelled: true };
  const out = buildQuestionnaireResponse(result, params);
  assert.equal(out.content[0].text, DECLINE_MESSAGE);
  assert.equal(out.details.cancelled, true);
  assert.equal(out.details.answers.length, 1);
});

test('cancelled 且带 error → error 透传到 details', () => {
  const result: QuestionnaireResult = { answers: [], cancelled: true, error: 'no_questions' };
  const out = buildQuestionnaireResponse(result, params);
  assert.equal(out.details.error, 'no_questions');
});

test('非 cancelled 但零段（无答案无备注）→ 落到 DECLINE 且 cancelled=true', () => {
  const out = buildQuestionnaireResponse({ answers: [], cancelled: false }, params);
  assert.equal(out.content[0].text, DECLINE_MESSAGE);
  assert.equal(out.details.cancelled, true);
});

test('null / undefined 结果 → DECLINE 且 cancelled=true', () => {
  for (const value of [null, undefined]) {
    const out = buildQuestionnaireResponse(value, params);
    assert.equal(out.content[0].text, DECLINE_MESSAGE);
    assert.equal(out.details.cancelled, true);
    assert.deepEqual(out.details.answers, []);
  }
});

test('cancelled 时空 globalNote 不出现在 details（条件展开契约）', () => {
  const out = buildQuestionnaireResponse({ answers: [], cancelled: true, globalNote: '' }, params);
  assert.ok(!('globalNote' in out.details));
});
