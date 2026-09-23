/**
 * `suggest_next_steps` 内置扩展公开出口。
 *
 * 契约：docs/plan/suggest-next-steps.md
 */

export {
  SUGGEST_NEXT_STEPS_TOOL_NAME,
  SUGGEST_PROMPT_GUIDELINES,
  SUGGEST_PROMPT_SNIPPET,
  SUGGEST_TOOL_DESCRIPTION,
  registerSuggestNextStepsTool,
  suggestNextSteps,
  suggestNextStepsExtension,
  validateSteps,
} from './extension.ts';
export type { StepsValidation, SuggestToolResult } from './extension.ts';

export { MAX_STEP_LENGTH, MAX_STEPS, MIN_STEPS, SuggestParamsSchema } from './schema.ts';
export type { SuggestParams } from './schema.ts';
