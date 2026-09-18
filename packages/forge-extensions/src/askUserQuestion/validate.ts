/**
 * `QuestionParams` 运行时校验（第二层兜底；第一层是 TypeBox schema）。
 *
 * 契约来源：docs/plan/ask-user-question-contract.md §1.2 / §2.2。
 * 错误文案照抄 rpiv（`tool/validate-questionnaire.ts:3-8`）——模型看到的
 * 文案保持一致，行为不漂移。
 *
 * 注意：不覆盖 `no_ui`。forge 不依赖 `ctx.hasUI`（自建工具不走 pi 的 UI 协
 * 议），故 `no_ui` 在 forge 路径下不可达。
 */

import {
  MAX_QUESTIONS,
  MIN_OPTIONS,
  RESERVED_LABELS,
} from './schema.ts';
import type { QuestionnaireError } from './types.ts';
import type { QuestionParams } from './schema.ts';

export const ERROR_NO_QUESTIONS = 'Error: At least one question is required';
export const ERROR_TOO_MANY_QUESTIONS = `Error: At most ${MAX_QUESTIONS} questions are allowed per invocation`;
export const ERROR_DUPLICATE_QUESTION = 'Error: Question text must be unique within an invocation';
export const ERROR_TOO_FEW_OPTIONS = `Error: Each question requires at least ${MIN_OPTIONS} options`;
export const ERROR_RESERVED_LABEL = `Error: Option label is reserved (${RESERVED_LABELS.join(', ')})`;
export const ERROR_DUPLICATE_OPTION_LABEL = 'Error: Option labels must be unique within a question';

const RESERVED_LABEL_SET: ReadonlySet<string> = new Set<string>(RESERVED_LABELS);

export type ValidationResult =
  | { ok: true }
  | { ok: false; error: QuestionnaireError; message: string };

/**
 * 纯函数校验。`reserved_label` 必须先于 `duplicate_option_label` 短路
 * （与 rpiv 一致：保留标签的判定优先级更高）。
 */
export function validateQuestionnaire(typed: QuestionParams): ValidationResult {
  if (typed.questions.length === 0) {
    return { ok: false, error: 'no_questions', message: ERROR_NO_QUESTIONS };
  }
  if (typed.questions.length > MAX_QUESTIONS) {
    return { ok: false, error: 'too_many_questions', message: ERROR_TOO_MANY_QUESTIONS };
  }

  const seenQuestions = new Set<string>();
  for (const q of typed.questions) {
    if (seenQuestions.has(q.question)) {
      return { ok: false, error: 'duplicate_question', message: ERROR_DUPLICATE_QUESTION };
    }
    seenQuestions.add(q.question);
  }

  for (const q of typed.questions) {
    if (q.options.length < MIN_OPTIONS) {
      return { ok: false, error: 'empty_options', message: ERROR_TOO_FEW_OPTIONS };
    }
    const seenLabels = new Set<string>();
    for (const o of q.options) {
      if (RESERVED_LABEL_SET.has(o.label)) {
        return { ok: false, error: 'reserved_label', message: ERROR_RESERVED_LABEL };
      }
      if (seenLabels.has(o.label)) {
        return {
          ok: false,
          error: 'duplicate_option_label',
          message: ERROR_DUPLICATE_OPTION_LABEL,
        };
      }
      seenLabels.add(o.label);
    }
  }

  return { ok: true };
}
