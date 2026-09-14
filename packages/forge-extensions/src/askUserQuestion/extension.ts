/**
 * `ask_user_question` 内置扩展（Path 2 的落地实现）。
 *
 * 契约来源：docs/plan/ask-user-question-contract.md §1.3 / §3 / §4。
 *
 * 形态照抄 forge 首个真实扩展 `slashCommandReporter.ts`：
 * `InlineExtension` + `factory(pi)`，由 `DefaultResourceLoaderOptions.extensionFactories`
 * 直装（每会话一次，故可安全闭包持有 pi）。
 *
 * 不实现 `renderCall` / `renderResult` —— 那两个钩子只对 pi 的 TUI 有意义；
 * forge 桌面端走自己的事件总线渲染，用了反而增加耦合（契约 §3）。
 */

import { randomUUID } from 'node:crypto';
import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import {
  ASK_USER_REQUEST_CHANNEL,
  ASK_USER_REPLY_GRACE_MS,
  DEFAULT_ASK_USER_TIMEOUT_MS,
  askUserReplyChannel,
  isAskUserReplyPayload,
} from './channels.ts';
import { buildQuestionnaireResponse, buildToolResult } from './envelope.ts';
import type { AskUserToolResult } from './envelope.ts';
import { QuestionParamsSchema } from './schema.ts';
import type { QuestionParams } from './schema.ts';
import type { QuestionnaireResult } from './types.ts';
import { validateQuestionnaire } from './validate.ts';

export const ASK_USER_QUESTION_TOOL_NAME = 'ask_user_question';

/** 工具列表里的一行摘要（照抄 rpiv，`ask-user-question.ts:275`）。 */
export const DEFAULT_PROMPT_SNIPPET =
  'Ask the user up to 4 structured questions (2-4 options each) when requirements are ambiguous';

/**
 * 系统提示 Guidelines 里的 4 条规则。
 *
 * ⚠️ 与 rpiv 的唯一差异在 guideline 3 末句：原文为
 * `append "(Recommended)" to its label`，forge 改为 `set \`recommended: true\` on it`
 * （契约 §1.4）。其余逐字照抄 —— 一字之差会影响模型是否/如何调用本工具。
 */
export const DEFAULT_PROMPT_GUIDELINES: readonly string[] = [
  "Use ask_user_question whenever the user's request is underspecified and you cannot proceed without concrete decisions — you can ask up to 4 questions per invocation.",
  'Each question MUST have 2-4 options. Every option requires a concise label (1-5 words) and a description explaining what the choice means or its trade-offs. The user can additionally type a custom answer via the automatically appended "Type something." row on every question, or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.',
  'Set multiSelect: true when multiple answers are valid. Provide an options[].preview markdown string when an option benefits from richer side-by-side context (mockups, code snippets, diagrams, configs) — single-select only. The "Type something." row is appended to every question; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column. If you recommend a specific option, make that the first option and set `recommended: true` on it.',
  'Do not stack multiple ask_user_question calls back-to-back — group all clarifying questions into one invocation.',
];

/** 工具详情页描述（照抄 rpiv `ask-user-question.ts:284-301`，含 Preview feature 小节）。 */
export const DEFAULT_TOOL_DESCRIPTION = `Ask the user one or more structured questions during execution. Use when you need to:
1. Gather user preferences or requirements
2. Clarify ambiguous instructions
3. Get decisions on implementation choices as you work
4. Offer choices to the user about what direction to take

Usage notes:
- Users can type a custom answer via the automatically appended "Type something." row on every question or press Esc to abandon the questionnaire. Do NOT author "Other" or "Type something." labels yourself — reserved labels are rejected at runtime.
- Use multiSelect: true when multiple answers are valid. The "Type something." row is available on every question, including when options carry a \`preview\`; in preview mode it expands to the full pane width while typing so the custom answer is not cramped into the narrow options column.
- If you recommend a specific option, make that the first option in the list and add "(Recommended)" at the end of the label.

Preview feature:
Use the optional \`preview\` field on options when presenting concrete artifacts that users need to visually compare:
- ASCII mockups of UI layouts or components
- Code snippets showing different implementations
- Diagram variations
- Configuration examples

Preview content is rendered as markdown in a monospace box. Multi-line text with newlines is supported. When any option has a preview, the UI switches to a side-by-side layout with a vertical option list on the left and preview on the right. Do not use previews for simple preference questions where labels and descriptions suffice. Note: previews are only supported for single-select questions (not multiSelect).`;

/** 会话事件总线的最小子集（`EventBus` 的结构子类型，便于测试替身）。 */
export interface AskUserEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

export interface AskUserQuestionOptions {
  /** 面板倒计时时长，默认 {@link DEFAULT_ASK_USER_TIMEOUT_MS}。 */
  timeoutMs?: number;
  /** 安全网宽限，默认 {@link ASK_USER_REPLY_GRACE_MS}。 */
  graceMs?: number;
  /** requestId 生成器（测试注入）。 */
  generateRequestId?: () => string;
}

/**
 * 纯逻辑核心：投递问卷 → 等待作答 → 组装工具返回。
 *
 * 与 pi 解耦，便于单测（契约 §4.1 流程）。
 *
 * 流程：
 * 1. `validateQuestionnaire` 拒绝 → 直接返回 `cancelled:true` + `error`
 * 2. 生成 requestId，**先订阅**下行通道再 `emit` 上行请求（避免竞态丢包）
 * 3. await 应答；`timeoutMs + graceMs` 兜底超时，`signal` 中止亦返回 cancelled
 * 4. `buildQuestionnaireResponse` 组装 envelope + details
 */
export async function askUserQuestion(
  params: QuestionParams,
  bus: AskUserEventBus,
  options?: AskUserQuestionOptions,
  signal?: AbortSignal,
): Promise<AskUserToolResult> {
  const validation = validateQuestionnaire(params);
  if (!validation.ok) {
    return buildToolResult(validation.message, {
      answers: [],
      cancelled: true,
      error: validation.error,
    });
  }

  const requestId = (options?.generateRequestId ?? randomUUID)();
  const timeoutMs = options?.timeoutMs ?? DEFAULT_ASK_USER_TIMEOUT_MS;
  const graceMs = options?.graceMs ?? ASK_USER_REPLY_GRACE_MS;

  const result = await new Promise<QuestionnaireResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => {};

    function finish(value: QuestionnaireResult): void {
      if (settled) return;
      settled = true;
      if (timer !== undefined) clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      unsubscribe();
      resolve(value);
    }

    function onAbort(): void {
      finish({ answers: [], cancelled: true });
    }

    if (signal?.aborted) {
      finish({ answers: [], cancelled: true });
      return;
    }

    // 必须先订阅再 emit：同会话总线同步派发，emit 前订阅才接得住即时回填。
    unsubscribe = bus.on(askUserReplyChannel(requestId), (data) => {
      if (!isAskUserReplyPayload(data)) return;
      finish({
        answers: data.answers,
        cancelled: data.cancelled,
        ...(data.globalNote && data.globalNote.length > 0 ? { globalNote: data.globalNote } : {}),
      });
    });

    timer = setTimeout(() => finish({ answers: [], cancelled: true }), timeoutMs + graceMs);

    if (signal) signal.addEventListener('abort', onAbort, { once: true });

    bus.emit(ASK_USER_REQUEST_CHANNEL, {
      requestId,
      questions: params.questions,
      timeoutMs,
    });
  });

  return buildQuestionnaireResponse(result, params);
}

/**
 * 注册 `ask_user_question` 工具到 pi。
 *
 * 支持运行时注册、即时生效（`types.d.ts:927`），无需 `/reload`。
 */
export function registerAskUserQuestionTool(pi: ExtensionAPI, options?: AskUserQuestionOptions): void {
  pi.registerTool({
    name: ASK_USER_QUESTION_TOOL_NAME,
    label: 'Ask User Question',
    description: DEFAULT_TOOL_DESCRIPTION,
    promptSnippet: DEFAULT_PROMPT_SNIPPET,
    promptGuidelines: [...DEFAULT_PROMPT_GUIDELINES],
    parameters: QuestionParamsSchema,
    async execute(_toolCallId, params, signal) {
      return askUserQuestion(
        params,
        {
          emit: (channel, data) => pi.events.emit(channel, data),
          on: (channel, handler) => pi.events.on(channel, handler),
        },
        options,
        signal,
      );
    },
  });
}

/** InlineExtension 形态（`DefaultResourceLoaderOptions.extensionFactories` 直装）。 */
export const askUserQuestionExtension: InlineExtension = {
  name: 'forge-ask-user-question',
  factory: (pi: ExtensionAPI) => registerAskUserQuestionTool(pi),
};
