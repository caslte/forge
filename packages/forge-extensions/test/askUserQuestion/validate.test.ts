/**
 * `validateQuestionnaire` 运行时校验（契约 §1.2 / §2.2）。
 *
 * schema 层（TypeBox）已在工具调用入参阶段拦一层；本层是第二层兜底，且是
 * 唯一能判定「同调用内 question 文本唯一」「同题内 label 唯一」「保留标签」
 * 这些结构性约束的地方。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RESERVED_LABELS } from '../../src/askUserQuestion/schema.ts';
import type { QuestionData, QuestionParams } from '../../src/askUserQuestion/schema.ts';
import { validateQuestionnaire } from '../../src/askUserQuestion/validate.ts';

function q(overrides: Partial<QuestionData> = {}): QuestionData {
  return {
    question: 'Which library should we use?',
    header: 'Library',
    options: [
      { label: 'Foo', description: 'foo lib' },
      { label: 'Bar', description: 'bar lib' },
    ],
    ...overrides,
  };
}

function params(questions: QuestionData[]): QuestionParams {
  return { questions };
}

test('合法入参通过校验', () => {
  assert.deepEqual(validateQuestionnaire(params([q()])), { ok: true });
});

test('0 题 → no_questions', () => {
  const r = validateQuestionnaire(params([]));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'no_questions');
});

test('5 题 → too_many_questions', () => {
  const five = Array.from({ length: 5 }, (_, i) => q({ question: `Q${i}?` }));
  const r = validateQuestionnaire(params(five));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'too_many_questions');
});

test('4 题是上限内', () => {
  const four = Array.from({ length: 4 }, (_, i) => q({ question: `Q${i}?` }));
  assert.deepEqual(validateQuestionnaire(params(four)), { ok: true });
});

test('重复 question 文本 → duplicate_question', () => {
  const r = validateQuestionnaire(params([q(), q()]));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'duplicate_question');
});

test('某题选项少于 2 个 → empty_options', () => {
  const r = validateQuestionnaire(params([q({ options: [{ label: 'Only', description: 'x' }] })]));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'empty_options');
});

test('同题内 label 重复 → duplicate_option_label', () => {
  const r = validateQuestionnaire(
    params([
      q({
        options: [
          { label: 'Same', description: 'a' },
          { label: 'Same', description: 'b' },
        ],
      }),
    ]),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'duplicate_option_label');
});

for (const reserved of RESERVED_LABELS) {
  test(`保留标签「${reserved}」被拒 → reserved_label`, () => {
    const r = validateQuestionnaire(
      params([
        q({
          options: [
            { label: reserved, description: 'reserved' },
            { label: 'Fine', description: 'ok' },
          ],
        }),
      ]),
    );
    assert.equal(r.ok, false);
    assert.equal(r.ok === false && r.error, 'reserved_label');
  });
}

test('reserved_label 先于 duplicate_option_label 短路', () => {
  // 两个同为保留标签的选项：只能报 reserved_label，不能报 duplicate_option_label
  const r = validateQuestionnaire(
    params([
      q({
        options: [
          { label: 'Other', description: 'a' },
          { label: 'Other', description: 'b' },
        ],
      }),
    ]),
  );
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.error, 'reserved_label');
});

test('错误文案与 rpiv 保持一致', () => {
  const r = validateQuestionnaire(params([]));
  assert.equal(r.ok === false && r.message, 'Error: At least one question is required');
});
