/**
 * `suggest_next_steps` 内置扩展。
 *
 * 契约来源：docs/plan/suggest-next-steps.md。
 *
 * 形态照抄 askUserQuestion（InlineExtension + factory(pi)，经 extensionFactories
 * 直装），但**更简单**：无事件总线通道、无下行回填——execute 校验后立即返回
 * （不变式 I2），UI 直接从消息流的 tool call `input.steps` 渲染芯片（I1）。
 * 不实现 `renderCall` / `renderResult`（同 askUserQuestion，桌面端自渲染）。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import { MAX_STEP_LENGTH, SuggestParamsSchema } from './schema.ts';
import type { SuggestParams } from './schema.ts';

export const SUGGEST_NEXT_STEPS_TOOL_NAME = 'suggest_next_steps';

/** 工具列表里的一行摘要。 */
export const SUGGEST_PROMPT_SNIPPET =
  'Offer the user 1-3 clickable next-step suggestions as the final action of your reply';

/** 系统提示 Guidelines（引导模型何时调用/如何填参；v2 翻转为默认调用+禁正文复述）。 */
export const SUGGEST_PROMPT_GUIDELINES: readonly string[] = [
  'Call suggest_next_steps by DEFAULT at the end of every substantive reply, as your final action — skip it ONLY when the task is fully concluded with nothing meaningful left to do. Do not be shy: if you would otherwise write "如果需要我接下来做…", that IS a trigger.',
  `Each step is one complete instruction phrased in the user's voice (e.g. "落设计文档并评审", not "I will write the doc"), MAX ${MAX_STEP_LENGTH} CHARACTERS, 1-3 steps, most valuable first.`,
  'NEVER enumerate next steps or follow-up options as prose/bullets in the reply body, and never restate the suggestions after the call — the chips already show them. Clarifying questions go to ask_user_question, not this tool.',
  'Call it as the LAST action of the turn; after it, output no further text or tool calls.',
];

/** 工具详情页描述。 */
export const SUGGEST_TOOL_DESCRIPTION = `Offer the user 1-3 short clickable next-step suggestions. The UI renders them as buttons under your reply; clicking one sends that exact text as the user's next message.

Usage notes:
- Call by DEFAULT when wrapping up a substantive reply; skip only when the task is fully concluded — do not instead list next steps as prose in the reply body.
- Write each step as a complete instruction in the user's voice, self-contained (no "继续上面的" references), MAX ${MAX_STEP_LENGTH} characters.
- At most one call per reply, made as your final action; do not restate the suggestions in text afterward.`;

/** 工具返回值形态（与 pi 的 `AgentToolResult` 结构兼容）。 */
export interface SuggestToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: { steps: string[]; error?: string };
}

/** 二层校验结果。 */
export type StepsValidation = { ok: true; steps: string[] } | { ok: false; message: string };

/**
 * 语义校验（schema 已挡形状，这里挡内容）：
 * - 每条 trim 后非空
 * - 去重（trim 后相同的条目视为模型失误，整体拒绝让模型重试）
 */
export function validateSteps(params: SuggestParams): StepsValidation {
  const steps = params.steps.map((s) => s.trim());
  if (steps.length === 0) {
    return { ok: false, message: 'steps must contain at least 1 entry' };
  }
  if (steps.some((s) => s === '')) {
    return { ok: false, message: 'steps must not contain blank entries' };
  }
  if (new Set(steps).size !== steps.length) {
    return { ok: false, message: 'steps must be distinct' };
  }
  return { ok: true, steps };
}

export function suggestNextSteps(params: SuggestParams): SuggestToolResult {
  const validation = validateSteps(params);
  if (!validation.ok) {
    return {
      content: [{ type: 'text', text: `Rejected: ${validation.message}. Fix the arguments or skip the call.` }],
      details: { steps: [], error: validation.message },
    };
  }
  return {
    content: [{ type: 'text', text: 'Next-step suggestions displayed to the user.' }],
    details: { steps: validation.steps },
  };
}

/** 注册 `suggest_next_steps` 工具到 pi。 */
export function registerSuggestNextStepsTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: SUGGEST_NEXT_STEPS_TOOL_NAME,
    label: 'Suggest Next Steps',
    description: SUGGEST_TOOL_DESCRIPTION,
    promptSnippet: SUGGEST_PROMPT_SNIPPET,
    promptGuidelines: [...SUGGEST_PROMPT_GUIDELINES],
    parameters: SuggestParamsSchema,
    async execute(_toolCallId, params) {
      return suggestNextSteps(params);
    },
  });
}

/** InlineExtension 形态（`DefaultResourceLoaderOptions.extensionFactories` 直装）。 */
export const suggestNextStepsExtension: InlineExtension = {
  name: 'forge-suggest-next-steps',
  factory: (pi: ExtensionAPI) => registerSuggestNextStepsTool(pi),
};
