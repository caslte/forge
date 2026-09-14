/**
 * ask_user_question 面板的纯逻辑（Path 2，契约 docs/plan/ask-user-question-contract.md）。
 *
 * 与 Vue 解耦，便于单测：推荐标记双通道识别、草稿→details.answers 的确定性转化、
 * 已答摘要文本。组件只负责把这些纯函数接到渲染与事件上。
 */

import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionOption,
} from '../bridge';

/**
 * 已答态：面板折叠摘要的数据源（composable 持有，按 sessionId 隔离）。
 * 交互态（`request`）清空后渲染它。
 */
export interface AskUserAnsweredState {
  answers: AskUserQuestionAnswer[];
  cancelled: boolean;
  globalNote?: string;
  /** 原问卷（「已答 n/N」计数与标题回显需要；`details` 本身不含 questions） */
  questions: AskUserQuestionItem[];
  /**
   * 用户点了提交、答案却**没送达**扩展侧（IPC 失败 / 无 lease / 扩展已不在等待）。
   *
   * 必须与「取消 / 超时」区分开 —— 那两种是交互正常结束（超时还会主动回填已答部分），
   * 而这一种是**答案真的丢了**：模型只能等到超时拿 `DECLINE`。
   * 两者在 `cancelled ⇔ true` 上完全重合，所以只能用显式标记区分（不能靠
   * `cancelled && answers 非空` 推断 —— 超时时已答部分同样非空）。
   */
  deliveryFailed?: boolean;
}

/** 单题草稿（面板内存态；切题/换 requestId 不丢，提交/超时后随 request 清除） */
export interface AskDraft {
  /** 选中选项下标（单选至多 1 个；多选可多个） */
  selected: number[];
  /**
   * 自定义答案文本。
   * - 单题单选：与选项**互斥**（输入即清空选项，选选项即清空文本）
   * - 多选：与选项**并列**（文本作为 `selected` 数组的末位一项，见 `buildAskUserAnswers`）
   */
  custom: string;
}

/** 空草稿 */
export function emptyDraft(): AskDraft {
  return { selected: [], custom: '' };
}

/**
 * 模型旧习惯的后缀（CLI 版 guideline 教它 `append "(Recommended)"`）。
 * forge 的 guideline 改为 `set recommended: true`，但模型很可能**两条都做**，
 * 故 UI 必须双通道识别（契约 §1.4）。
 */
export const RECOMMENDED_SUFFIX = '(Recommended)';

/**
 * 是否推荐项——**双通道识别**（契约 §1.4）：
 * 1. 显式字段 `recommended === true`（forge 新约定）
 * 2. label 尾部 `(Recommended)` 后缀（模型旧习惯兼容兜底）
 */
export function isRecommendedOption(option: Pick<AskUserQuestionOption, 'label' | 'recommended'>): boolean {
  return option.recommended === true || option.label.trimEnd().endsWith(RECOMMENDED_SUFFIX);
}

/**
 * 显示用 label：剥离尾部 `(Recommended)` 后缀（避免与「推荐」标记重复展示）。
 * ⚠️ 只影响**显示**——回填给模型的 `details.answers` 仍用原始 label（契约 §1.4）。
 */
export function displayLabel(label: string): string {
  const trimmed = label.trimEnd();
  if (!trimmed.endsWith(RECOMMENDED_SUFFIX)) return label;
  return trimmed.slice(0, -RECOMMENDED_SUFFIX.length).trimEnd();
}

/** 草稿是否已作答（选了选项或有自定义文本） */
export function isDraftAnswered(draft: AskDraft | undefined): boolean {
  if (draft === undefined) return false;
  return draft.selected.length > 0 || draft.custom.trim() !== '';
}

/** 已作答题数（用于「已答 n/N」与 tab 完成点） */
export function countAnswered(
  questions: AskUserQuestionItem[],
  drafts: Record<number, AskDraft>,
): number {
  let n = 0;
  questions.forEach((_q, i) => {
    if (isDraftAnswered(drafts[i])) n += 1;
  });
  return n;
}

/**
 * 草稿 → `details.answers[]`（契约 §2.1）——确定性转化，**只收已作答的题**：
 * - `multiSelect` → `{ kind:'multi', answer:null, selected:[原始 label...] }`
 * - 自定义文本 → `{ kind:'custom', answer:<文本> }`
 * - 命中选项 → `{ kind:'option', answer:<原始 label>, preview? }`（preview 仅当该选项带）
 *
 * 未作答的题**不产出条目**（与 rpiv 一致）：部分作答时 answers 只含已答部分，
 * UI 由数组长度推导「已答 n/N」。
 * label 一律用**原始值**（含可能存在的 `(Recommended)` 后缀），剥离只发生在显示层。
 *
 * **多选里的自定义文本**：多选的 `custom` 不与选项互斥，而是**并入 `selected` 末位**
 * （与「自己答」行排在选项列表末尾的视觉顺序一致）。这样模型侧仍是「一个多选答案」，
 * 不会多出一个 `kind='custom'` 条目；契约 §2.1 的 `selected` 本就是 string[]，
 * 未限定只能是选项 label。单选下 `custom` 仍走 `kind='custom'` 分支（互斥）。
 */
export function buildAskUserAnswers(
  questions: AskUserQuestionItem[],
  drafts: Record<number, AskDraft>,
): AskUserQuestionAnswer[] {
  const out: AskUserQuestionAnswer[] = [];
  questions.forEach((question, questionIndex) => {
    const draft = drafts[questionIndex];
    if (!isDraftAnswered(draft)) return;
    const current = draft as AskDraft;

    if (question.multiSelect === true) {
      const selected = current.selected
        .map((idx) => question.options[idx])
        .filter((option): option is AskUserQuestionOption => option !== undefined)
        .map((option) => option.label);
      const custom = current.custom.trim();
      if (custom !== '') selected.push(custom);
      if (selected.length === 0) return;
      out.push({
        questionIndex,
        question: question.question,
        kind: 'multi',
        answer: null,
        selected,
      });
      return;
    }

    const custom = current.custom.trim();
    if (custom !== '') {
      out.push({
        questionIndex,
        question: question.question,
        kind: 'custom',
        answer: custom,
      });
      return;
    }

    const option = question.options[current.selected[0] ?? -1];
    if (option === undefined) return;
    const preview = option.preview;
    out.push({
      questionIndex,
      question: question.question,
      kind: 'option',
      answer: option.label,
      ...(typeof preview === 'string' && preview !== '' ? { preview } : {}),
    });
  });
  return out;
}

/**
 * 已答摘要文本（面板折叠态 / 已答 pill 展示）：各题答案以 ` · ` 连接。
 * kind='multi' 取 `selected`（顿号连接），其余取 `answer`；空值统一 `（无输入）`。
 * 无任何条目返回 `（已答）`（与原型一致）。
 */
export function summarizeAskAnswers(answers: AskUserQuestionAnswer[]): string {
  const parts: string[] = [];
  for (const answer of answers) {
    if (answer.kind === 'multi') {
      const selected = answer.selected ?? [];
      parts.push(selected.length > 0 ? selected.join('、') : '（无输入）');
      continue;
    }
    const text = answer.answer;
    parts.push(typeof text === 'string' && text.trim() !== '' ? text.trim() : '（无输入）');
  }
  return parts.length > 0 ? parts.join(' · ') : '（已答）';
}

/** tab 标题截断（原型：超 14 字符截 12 + 省略号） */
export function tabLabel(header: string, max = 14): string {
  return header.length > max ? `${header.slice(0, max - 2)}…` : header;
}

// ===== 提交可用性 / 已答后自动收起 =====

/**
 * 提交后保留「已答摘要」的时长，之后面板自动折叠关闭（对齐 TodoPanel 的自动收起节奏）。
 * 保留一小段是为了让「已答 n/N」这行反馈能被看到，而不是一点就消失。
 */
export const ASK_ANSWERED_AUTO_CLOSE_MS = 1500;

/**
 * 「提交答案」是否可用 —— **以真正会发出去的 payload 是否为空为准**。
 *
 * 为什么不用「已答 n/N > 0」判断：`countAnswered` 数的是"草稿有内容"，而
 * `buildAskUserAnswers` 才决定最终条目。用 payload 长度做判据可让二者永不分叉
 *（例如越界下标这类只在理论上的草稿，计数会算 1 但 payload 是空）。
 *
 * **为什么 0 条要禁用**：空 payload 在扩展侧落到 `DECLINE_MESSAGE`
 *（`User declined to answer questions` + `details.cancelled = true`），与用户点
 *「取消」给模型的信号**完全一致**。放行的话，用户以为「提交了一份只有备注的问卷」，
 *模型收到的却是「用户拒绝作答」—— 禁用后，产出这条信号的唯一入口就是显式点「取消」。
 */
export function canSubmitAnswers(answers: AskUserQuestionAnswer[]): boolean {
  return answers.length > 0;
}

/**
 * 已答态是否应**自动关闭**面板（而不是停在折叠摘要上）。
 *
 * 用户要的是「答完就收」：答案已经回填给模型，摘要在消息流里也有工具卡片承载，
 * 没必要再占着输入框上方。
 *
 * 唯一的例外是 `deliveryFailed`（**答案没送出去**）：这种情况必须留在界面上让人看见，
 * 否则面板静默消失、用户以为已经答完，实际模型一直等到超时才拿到 DECLINE，答案丢了。
 *
 * ⚠️ 不要用 `cancelled && answers 非空` 近似这个判断 —— 超时归零时已答部分同样非空
 * 且 `cancelled` 为真（那条路径答案**已经**回填成功），会误判成「送达失败」而留下
 * 一张永远不走的过期卡片。
 */
export function shouldAutoCloseAnswered(state: AskUserAnsweredState): boolean {
  return state.deliveryFailed !== true;
}

// ===== 步骤导航（多题时的「上一题 / 下一题」）=====

/**
 * 步骤序列 = 题目 `0..N-1` + 末位「备注」tab，共 `N+1` 步。
 *
 * 单题场景没有 tab 栏（备注卡片直接跟在选项下方），不存在步骤概念 → 返回 1，
 * 于是 `isLastStep(0, 1)` 为真、`canStepNext` 为假：只剩「提交答案」，与改造前一致。
 *
 * **为什么不把备注 tab 排除在步序外**：tab 栏本来就把它排在最右，用户心智里它
 * 就是最后一屏；把它算作末步顺带让「填完备注正好提交」，不用回头找按钮。
 */
export function stepCount(questionCount: number): number {
  return questionCount > 1 ? questionCount + 1 : 1;
}

/**
 * 是否处于最后一步 —— **只有末步渲染「提交答案」**（改造后的向导式语义）。
 *
 * 代价是部分作答的用户要走到末步才能提交，收益是堵住「在中间某题误点提交 →
 * 模型收到 DECLINE」这条歧义路径。
 */
export function isLastStep(index: number, questionCount: number): boolean {
  return index >= stepCount(questionCount) - 1;
}

/** 上一步可用（首步不可用，用于「上一题」按钮的渲染条件） */
export function canStepPrev(index: number): boolean {
  return index > 0;
}

/** 下一步可用（末步不可用，用于「下一题」按钮的渲染条件） */
export function canStepNext(index: number, questionCount: number): boolean {
  return index < stepCount(questionCount) - 1;
}

/**
 * 选中某个**普通选项**后是否自动前进到下一步。
 *
 * 三条不前进的情形（第三条由调用方保证，不在本函数里）：
 * 1. 多选 —— 前进等于打断继续勾选；
 * 2. 末步 —— 无路可走（`canStepNext` 已覆盖）；
 * 3. 点的是「自己答」选项 —— 需要留时间输入，故 `selectCustom` 根本不调本函数。
 *
 * 抽成纯函数是为了让这条规则可单测：组件层没有组件测试设施，规则写在
 * `selectOption` 里就只能靠 E2E 兜。
 */
export function shouldAutoAdvance(
  multiSelect: boolean,
  index: number,
  questionCount: number,
): boolean {
  if (multiSelect) return false;
  return canStepNext(index, questionCount);
}

/**
 * 归约 `tool.completed` 的 `result.details` → 已答态（面板折叠摘要）。
 *
 * 与 `applyTodoCompletion` 同策略：**结构非法一律静默返回 null**（不抛错、不污染面板）。
 *
 * `details` 由扩展侧产出（契约 §2.1）：`{ answers, cancelled, globalNote?, error? }`。
 * `questions` **不在** details 里 —— 由调用方用该会话最近一次请求的题目补齐（用于
 * 「已答 n/N」与标题回显）。
 *
 * 三种「不该弹摘要」的情形返回 null：
 * 1. details 非对象 / 非数组 answers → 畸形载荷；
 * 2. `details.error` 存在 → 工具在校验阶段就被拒（问卷从未投递到面板，无「已答」可言）；
 * 3. 无任何题目上下文（questions 为空）→ 面板无法回显，弹一个空壳摘要不如不弹。
 */
export function applyAskUserCompletion(
  questions: AskUserQuestionItem[],
  details: unknown,
): AskUserAnsweredState | null {
  if (details === null || typeof details !== 'object' || Array.isArray(details)) return null;
  const d = details as Record<string, unknown>;
  if (typeof d.error === 'string' && d.error !== '') return null;
  if (!Array.isArray(d.answers)) return null;
  if (questions.length === 0) return null;
  const globalNote = typeof d.globalNote === 'string' && d.globalNote.trim() !== '' ? d.globalNote : undefined;
  return {
    answers: d.answers as AskUserQuestionAnswer[],
    cancelled: d.cancelled === true,
    questions,
    ...(globalNote !== undefined ? { globalNote } : {}),
  };
}

/** 该题是否进入「左右分栏」预览态（任一选项带非空 preview；多选不提供预览，契约 §1.1） */
export function questionHasPreview(question: AskUserQuestionItem): boolean {
  if (question.multiSelect === true) return false;
  return question.options.some((o) => typeof o.preview === 'string' && o.preview !== '');
}

/** 倒计时秒数（向上取整，最小 0） */
export function remainingSeconds(deadline: number, now: number): number {
  return Math.max(0, Math.ceil((deadline - now) / 1000));
}
