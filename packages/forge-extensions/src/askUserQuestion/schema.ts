/**
 * ask_user_question 工具入参 schema（TypeBox）。
 *
 * 契约来源：docs/plan/ask-user-question-contract.md §1。
 *
 * 字段与描述文案照抄 rpiv 插件（`~/.pi/agent/npm/node_modules/@juicesharp/
 * rpiv-ask-user-question/tool/types.ts:40-89`），目的是让模型在 forge 里看到
 * 与 CLI 一致的 prompt，行为不发生漂移。唯一有意偏离：`options[].recommended`
 * —— rpiv 没有这个字段（CLI 靠 label 追加 "(Recommended)" 约定），forge 新增
 * 可选 boolean 以还原原型的「推荐」标记（契约 §1.4）。
 *
 * 硬限制（超限即拒，由 validateQuestionnaire 兜第二层）：
 * - questions：1–4 题
 * - options：每题 2–4 个
 * - label：≤ 60 字符
 * - header：≤ 16 字符
 */

import { Type } from 'typebox';
import type { Static } from 'typebox';

export const MAX_QUESTIONS = 4;
export const MIN_OPTIONS = 2;
export const MAX_OPTIONS = 4;
export const MAX_HEADER_LENGTH = 16;
export const MAX_LABEL_LENGTH = 60;

/**
 * 保留标签：模型不得自行编写这些 label，运行时拒绝（`reserved_label`）。
 * 与 rpiv 一致，顺序固定为 `["Other", <自动追加的自由输入行>, <多选确认行>]`
 * （rpiv 侧顺序由 `types.test.ts:292` 钉死）。
 */
export const RESERVED_LABELS = ['Other', 'Type something.', 'Next'] as const;
export type ReservedLabel = (typeof RESERVED_LABELS)[number];

export const OptionSchema = Type.Object({
  label: Type.String({
    maxLength: MAX_LABEL_LENGTH,
    description: `MAX ${MAX_LABEL_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.`,
  }),
  description: Type.String({
    description:
      'Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.',
  }),
  preview: Type.Optional(
    Type.String({
      description:
        'Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons that help users compare options. See the tool description for the expected content format.',
    }),
  ),
  // ★ forge 扩展字段（rpiv 无）。见契约 §1.4。
  recommended: Type.Optional(
    Type.Boolean({
      description:
        'Set to true to mark this option as your recommendation; the UI renders a "Recommended" badge. Mark at most one option per question, and place it first.',
    }),
  ),
});

export const QuestionSchema = Type.Object({
  question: Type.String({
    description:
      'The complete question to ask the user. Should be clear, specific, and end with a question mark. Example: "Which library should we use for date formatting?" If multiSelect is true, phrase it accordingly, e.g. "Which features do you want to enable?"',
  }),
  header: Type.String({
    maxLength: MAX_HEADER_LENGTH,
    description: `MAX ${MAX_HEADER_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. Very short chip/tag shown next to the question. Examples: "Auth method", "Library", "Approach".`,
  }),
  options: Type.Array(OptionSchema, {
    minItems: MIN_OPTIONS,
    maxItems: MAX_OPTIONS,
    description:
      "The available choices for this question. Must have 2-4 options. Each option should be a distinct, mutually exclusive choice (unless multiSelect is enabled). The 'Type something.' row is appended automatically — do NOT author it.",
  }),
  multiSelect: Type.Optional(
    Type.Boolean({
      default: false,
      description:
        'Set to true to allow the user to select multiple options instead of just one. Use when choices are not mutually exclusive.',
    }),
  ),
});

export const QuestionsSchema = Type.Array(QuestionSchema, {
  minItems: 1,
  maxItems: MAX_QUESTIONS,
  description: 'Questions to ask the user (1-4 questions)',
});

export const QuestionParamsSchema = Type.Object({
  questions: QuestionsSchema,
});

export type OptionData = Static<typeof OptionSchema>;
export type QuestionData = Static<typeof QuestionSchema>;
export type QuestionParams = Static<typeof QuestionParamsSchema>;
