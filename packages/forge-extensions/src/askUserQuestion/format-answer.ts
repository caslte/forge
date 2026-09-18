/**
 * `QuestionAnswer` → 标量字符串。
 *
 * 契约来源：docs/plan/ask-user-question-contract.md §2.3「`<scalar>` 的序列化规则」。
 *
 * 与 rpiv 的 `tool/format-answer.ts` 等价，但去掉了 rpiv 已废弃的 `variant`
 * 参数（其注释自陈「currently unused across all branches」），分支语义完全一致。
 */

import type { QuestionAnswer } from './types.ts';

/** 空 / null 答案的统一占位符（rpiv 早期 summary 分支的 `(no answer)` 属意外漂移，已废弃）。 */
export const NO_INPUT_PLACEHOLDER = '(no input)';

export function formatAnswerScalar(a: QuestionAnswer): string {
  switch (a.kind) {
    case 'multi':
      return a.selected && a.selected.length > 0 ? a.selected.join(', ') : NO_INPUT_PLACEHOLDER;
    case 'custom':
      return a.answer && a.answer.length > 0 ? a.answer : NO_INPUT_PLACEHOLDER;
    case 'option':
      return a.answer ?? NO_INPUT_PLACEHOLDER;
  }
}
