/**
 * ask_user_question 出参与应答类型。
 *
 * 契约来源：docs/plan/ask-user-question-contract.md §2.1 / §2.2。
 *
 * 形状照抄 rpiv 插件（`tool/types.ts:106-150`），因为 renderer 面板与模型
 * envelope 都按这套结构消费。注意本项目**不回流 preview**（契约 §2.3）：
 * `QuestionAnswer.preview` 照常填充供 UI 展示，但不进模型 envelope。
 */

/**
 * 单题作答。
 *
 * `kind` 是唯一判别式：
 * - `option`：用户点选了作者定义的选项，`answer` 为选项 label。
 * - `custom`：用户通过「Type something.」行自由输入，`answer` 为输入文本或 null。
 * - `multi`：多选提交，`selected` 为所选 label 数组，`answer` 恒为 null。
 */
export interface QuestionAnswer {
  questionIndex: number;
  question: string;
  kind: 'option' | 'custom' | 'multi';
  answer: string | null;
  selected?: string[];
  /** 每题备注（面板上每题独立输入）。 */
  notes?: string;
  /**
   * 命中「带 preview 的单选项」时填充，供 UI 面板展示。
   * **不进入模型 envelope**（契约 §2.3 偏离点一）。多选与自由输入恒为 undefined。
   */
  preview?: string;
}

/**
 * 校验拒绝码。后三项为 rpiv 内部码，forge 不可达（保留以对齐契约 §2.2 冻结的联合类型）。
 */
export type QuestionnaireError =
  | 'no_ui'
  | 'no_questions'
  | 'too_many_questions'
  | 'duplicate_question'
  | 'empty_options'
  | 'duplicate_option_label'
  | 'reserved_label'
  // 以下为 rpiv 内部实现码，forge 用不到：
  | 'no_custom_ui'
  | 'session_load_failed'
  | 'stale_module_cache';

export interface QuestionnaireResult {
  answers: QuestionAnswer[];
  cancelled: boolean;
  /**
   * Submit tab 上的全局备注。条件展开契约：仅当非空字符串时该键才出现，
   * 空/空白串不出现（`!("globalNote" in result)` 成立），与 `answers[].notes` 一致。
   */
  globalNote?: string;
  error?: QuestionnaireError;
}

export function isQuestionnaireResult(value: unknown): value is QuestionnaireResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v.answers) && typeof v.cancelled === 'boolean';
}
