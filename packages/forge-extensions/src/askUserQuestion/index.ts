/**
 * `ask_user_question` 自建内置扩展（Path 2）公开出口。
 *
 * 契约：docs/plan/ask-user-question-contract.md
 * 计划：docs/plan/ask-user-question-extension.md
 */

export {
  ASK_USER_QUESTION_TOOL_NAME,
  DEFAULT_PROMPT_GUIDELINES,
  DEFAULT_PROMPT_SNIPPET,
  DEFAULT_TOOL_DESCRIPTION,
  askUserQuestion,
  askUserQuestionExtension,
  registerAskUserQuestionTool,
} from './extension.ts';
export type { AskUserEventBus, AskUserQuestionOptions } from './extension.ts';

export {
  ASK_USER_REPLY_GRACE_MS,
  ASK_USER_REQUEST_CHANNEL,
  DEFAULT_ASK_USER_TIMEOUT_MS,
  askUserReplyChannel,
  isAskUserReplyPayload,
} from './channels.ts';
export type { AskUserReplyPayload, AskUserRequestPayload } from './channels.ts';

export {
  MAX_HEADER_LENGTH,
  MAX_LABEL_LENGTH,
  MAX_OPTIONS,
  MAX_QUESTIONS,
  MIN_OPTIONS,
  OptionSchema,
  QuestionParamsSchema,
  QuestionSchema,
  QuestionsSchema,
  RESERVED_LABELS,
} from './schema.ts';
export type { OptionData, QuestionData, QuestionParams, ReservedLabel } from './schema.ts';

export {
  DECLINE_MESSAGE,
  ENVELOPE_PREFIX,
  ENVELOPE_SUFFIX,
  buildAnswerSegment,
  buildQuestionnaireResponse,
  buildToolResult,
} from './envelope.ts';
export type { AskUserToolResult } from './envelope.ts';

export { NO_INPUT_PLACEHOLDER, formatAnswerScalar } from './format-answer.ts';

export {
  ERROR_DUPLICATE_OPTION_LABEL,
  ERROR_DUPLICATE_QUESTION,
  ERROR_NO_QUESTIONS,
  ERROR_RESERVED_LABEL,
  ERROR_TOO_FEW_OPTIONS,
  ERROR_TOO_MANY_QUESTIONS,
  validateQuestionnaire,
} from './validate.ts';
export type { ValidationResult } from './validate.ts';

export { isQuestionnaireResult } from './types.ts';
export type { QuestionAnswer, QuestionnaireError, QuestionnaireResult } from './types.ts';
