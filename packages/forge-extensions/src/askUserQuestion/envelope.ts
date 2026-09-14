/**
 * 模型侧 envelope 构造（`content.text`）与工具返回组装。
 *
 * 契约来源：docs/plan/ask-user-question-contract.md §2.1 / §2.3。
 *
 * ⚠️ 本项目第一处有意偏离：**preview 不回流**。rpiv 会在单段里拼
 * `selected preview: <preview>`（因为 CLI 没有面板，只能靠回流让模型看见）；
 * forge 有独立 preview 面板 → envelope 不含该段，省 token。但
 * `details.answers[].preview` 照常填充供 UI 展示。
 */

import { formatAnswerScalar } from './format-answer.ts';
import type { QuestionParams } from './schema.ts';
import type { QuestionAnswer, QuestionnaireResult } from './types.ts';

export const DECLINE_MESSAGE = 'User declined to answer questions';
export const ENVELOPE_PREFIX = 'User has answered your questions:';
export const ENVELOPE_SUFFIX = "You can now continue with the user's answers in mind.";

/** 工具返回值形态（与 pi 的 `AgentToolResult` 结构兼容）。 */
export interface AskUserToolResult {
  content: Array<{ type: 'text'; text: string }>;
  details: QuestionnaireResult;
}

export function buildToolResult(text: string, details: QuestionnaireResult): AskUserToolResult {
  return {
    content: [{ type: 'text' as const, text }],
    details,
  };
}

/**
 * 单段格式（forge 版，无 `selected preview:` 段）：
 * `"<question>"="<scalar>"[. user notes: <notes>].`
 */
export function buildAnswerSegment(a: QuestionAnswer): string {
  const parts: string[] = [`"${a.question}"="${formatAnswerScalar(a)}"`];
  if (a.notes && a.notes.length > 0) parts.push(`user notes: ${a.notes}`);
  return `${parts.join('. ')}.`;
}

/**
 * 把 `QuestionnaireResult`（或 null / cancelled）映射为模型侧 envelope。
 *
 * 纯函数。cancelled 与「无任何段」两条路径都落到 `DECLINE_MESSAGE`，让模型
 * 只看到一个规范的「未作答」信号，不区分原因；原因保留在 `details` 里（含
 * `cancelled`、部分 `answers`、`error`）供 UI 与回放消费。
 *
 * `global note:` 段在「零段检查」之前压入，所以「只填了全局备注、没答任何题」
 * 仍产出已作答 envelope（与 rpiv 一致）。
 */
export function buildQuestionnaireResponse(
  result: QuestionnaireResult | null | undefined,
  params: QuestionParams,
): AskUserToolResult {
  if (!result || result.cancelled) {
    return buildToolResult(DECLINE_MESSAGE, {
      answers: result?.answers ?? [],
      cancelled: true,
      ...(result?.globalNote && result.globalNote.length > 0
        ? { globalNote: result.globalNote }
        : {}),
      ...(result?.error ? { error: result.error } : {}),
    });
  }

  const segments: string[] = [];
  for (let i = 0; i < params.questions.length; i++) {
    const a = result.answers.find((x) => x.questionIndex === i);
    if (a) segments.push(buildAnswerSegment(a));
  }
  if (result.globalNote && result.globalNote.length > 0) {
    segments.push(`global note: ${result.globalNote}.`);
  }
  if (segments.length === 0) {
    return buildToolResult(DECLINE_MESSAGE, { answers: result.answers, cancelled: true });
  }
  return buildToolResult(
    `${ENVELOPE_PREFIX} ${segments.join(' ')} ${ENVELOPE_SUFFIX}`,
    result,
  );
}
