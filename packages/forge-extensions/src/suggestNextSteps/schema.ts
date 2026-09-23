/**
 * suggest_next_steps 工具入参 schema（TypeBox）。
 *
 * 契约来源：docs/plan/suggest-next-steps.md §2 I6 / §4。
 *
 * 硬限制（schema 第一层，超限被 pi 拒绝）：
 * - steps：1–3 条
 * - 每条 ≤ 80 字符
 * trim 后为空等语义校验在 validateSteps（第二层）。
 */

import { Type } from 'typebox';
import type { Static } from 'typebox';

export const MIN_STEPS = 1;
export const MAX_STEPS = 3;
export const MAX_STEP_LENGTH = 80;

export const SuggestParamsSchema = Type.Object({
  steps: Type.Array(
    Type.String({
      maxLength: MAX_STEP_LENGTH,
      description: `MAX ${MAX_STEP_LENGTH} CHARACTERS — hard limit, requests over the limit are rejected. One complete instruction the user can send as-is, phrased in the user's voice (e.g. "落设计文档并评审").`,
    }),
    {
      minItems: MIN_STEPS,
      maxItems: MAX_STEPS,
      description: `1-${MAX_STEPS} next-step suggestions, most valuable first. Only include steps that are clearly actionable; omit the call entirely if there is no obvious next step.`,
    },
  ),
});

export type SuggestParams = Static<typeof SuggestParamsSchema>;
