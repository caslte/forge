/**
 * 会话作用域的 ask_user_question 状态仓（Path 2，契约 §4.4）。
 *
 * 为什么单独成文件：这组状态里藏着一个**静默失败**的坑 —— 倒计时表若写成普通
 * `Map`，`deadline` computed 会在面板首屏（`v-if="!showResultView"` 常驻挂载、
 * 尚无问卷）就求值并把 `undefined → null` **缓存**下来；此后 `set` 不产生依赖变更，
 * computed 永不重算，面板拿到的 `deadline` 恒为 `null` → `tick()` 直接 return →
 * **右上角读秒一直是 0**（真机曾如此）。
 *
 * 组件层（forge-ui）没有组件测试设施，只有纯逻辑测试 —— 把这个状态仓做成
 * 「不依赖 Vue 组件上下文、也不依赖 IPC 桥运行时」的单元，就能用 `node:test`
 * 直接锁住这类响应式回归（见 `test/askQuestionStore.test.ts` 首例）。
 * 故本文件**只 import `vue` 的响应式原语与类型**，`bridge` 仅作类型引用（会被擦除）。
 */

import { computed, reactive, type ComputedRef } from 'vue';
import type { AskUserQuestionItem, AskUserQuestionRequestPayload } from '../bridge.ts';
import { applyAskUserCompletion, type AskUserAnsweredState } from '../utils/askUserQuestion.ts';

export interface AskQuestionStore {
  /** 当前会话待作答问卷；null = 无进行中的问卷 */
  request: ComputedRef<AskUserQuestionRequestPayload | null>;
  /** 当前会话倒计时绝对截止时刻（epoch ms）；null = 无进行中倒计时 */
  deadline: ComputedRef<number | null>;
  /** 当前会话最近一次已答结果（request 为空时渲染折叠摘要） */
  answered: ComputedRef<AskUserAnsweredState | null>;
  /** 认领一份新问卷（调用方已完成载荷校验与会话归属过滤） */
  accept(payload: AskUserQuestionRequestPayload): void;
  /** 提交 / 取消后落已答摘要，并释放进行中请求与倒计时 */
  settle(sessionId: string, state: AskUserAnsweredState): void;
  /**
   * 消费 `tool.completed` 的 `details`：权威摘要覆盖乐观摘要 + 释放请求与倒计时。
   * `details` 非法（`applyAskUserCompletion` 返回 null）时**不覆盖**摘要，但照样释放 ——
   * 工具已返回，面板不能继续停在交互态。
   */
  applyCompletion(sessionId: string, details: unknown): void;
  /** 用户发了新消息：清掉「已答摘要」（不动进行中的请求） */
  clearAnswered(sessionId: string): void;
  /** 已答摘要自动收起（面板折叠关闭）：清摘要并**抑制该轮**后续再显示 */
  dismissAnswered(sessionId: string): void;
  /** 取该会话最近一次问卷的题目（折叠摘要回显「已答 n/N」用） */
  questionsOf(sessionId: string): AskUserQuestionItem[] | undefined;
  /** 取该会话进行中问卷（提交时需要它的 requestId） */
  requestOf(sessionId: string): AskUserQuestionRequestPayload | undefined;
}

/** 状态仓底层表组（五个，键均为 sessionId） */
export interface AskQuestionTables {
  requests: Map<string, AskUserQuestionRequestPayload>;
  deadlines: Map<string, number>;
  answeredStates: Map<string, AskUserAnsweredState>;
  questionSets: Map<string, AskUserQuestionItem[]>;
  suppressed: Set<string>;
}

/**
 * 新建一组空表。
 *
 * ⚠️ 五个表**必须** reactive：任一为普通 Map/Set，其对应 computed 就会缓存首屏的空值
 *（`deadline` 的这个坑已在真机出现过）。
 */
export function createAskQuestionTables(): AskQuestionTables {
  return {
    requests: reactive(new Map<string, AskUserQuestionRequestPayload>()),
    deadlines: reactive(new Map<string, number>()),
    answeredStates: reactive(new Map<string, AskUserAnsweredState>()),
    questionSets: reactive(new Map<string, AskUserQuestionItem[]>()),
    /**
     * 「已收起」的会话：该轮问答的摘要**永不再展示**（新问卷 `accept` 时解除）。
     *
     * 为什么需要它，而不是删掉摘要就完事：收尾是**乐观**的 —— `settle` 先落摘要，
     * 权威的 `tool.completed`（`applyCompletion`）随后才到。用户答完 → 面板自动收起
     * → 若此时 `applyCompletion` 才抵达并写回摘要，面板就会**重新弹出来**。
     * 「用户发下一条消息」清摘要（`clearAnswered`）有同一个 race。
     * 故这两个入口都要把会话标记为已收起，由 `answered` computed 统一兜住。
     */
    suppressed: reactive(new Set<string>()),
  };
}

/**
 * 生产路径共用的表组（模块级，跨视图实例共享）。
 *
 * 必须是共享的：进设置页时 App.vue 用 v-if 整块卸载 ConversationView，实例级表随
 * 组件一起被 GC —— 若问卷正等着用户回答，回来时面板连同已渲染的题目一起消失，
 * 而助手仍在等待。表按 sessionId 隔离，多窗格并排时互不串。
 *
 * 生命周期 = 渲染进程；无上限增长由 useSessionConversation 的 session.removed 订阅兜底。
 */
const sharedTables = createAskQuestionTables();

/**
 * 清空某会话的全部共享表条目（会话被删除时由 useSessionConversation 调用）。
 *
 * 模块级表不会随组件 GC 回收，长会话开着会累积，故删会话必须显式清。
 * 只清该会话，其它会话的进行中问卷互不影响。
 */
export function clearAskQuestionSession(sessionId: string): void {
  sharedTables.requests.delete(sessionId);
  sharedTables.deadlines.delete(sessionId);
  sharedTables.answeredStates.delete(sessionId);
  sharedTables.questionSets.delete(sessionId);
  sharedTables.suppressed.delete(sessionId);
}

/**
 * @param getSessionId 当前会话 id 取值器（**必须读响应式源**，否则切换会话时
 *   `request` / `deadline` / `answered` 三个 computed 不会跟随刷新）
 * @param now 取当前时刻（测试注入用，默认 `Date.now`）
 * @param tables 底层表组（默认跨实例共享；**测试必须传入独立表组**，否则用例间串状态）
 */
export function createAskQuestionStore(
  getSessionId: () => string | null,
  now: () => number = Date.now,
  tables: AskQuestionTables = sharedTables,
): AskQuestionStore {
  const { requests, deadlines, answeredStates, questionSets, suppressed } = tables;

  const request = computed<AskUserQuestionRequestPayload | null>(() => {
    const sid = getSessionId();
    return sid === null ? null : (requests.get(sid) ?? null);
  });
  const deadline = computed<number | null>(() => {
    const sid = getSessionId();
    return sid === null ? null : (deadlines.get(sid) ?? null);
  });
  const answered = computed<AskUserAnsweredState | null>(() => {
    const sid = getSessionId();
    if (sid === null) return null;
    // 已收起的摘要不得被迟到的 tool.completed / 新的 set 重新点亮
    if (suppressed.has(sid)) return null;
    return answeredStates.get(sid) ?? null;
  });

  /** 释放进行中请求与倒计时（幂等） */
  function release(sessionId: string): void {
    requests.delete(sessionId);
    deadlines.delete(sessionId);
  }

  function accept(payload: AskUserQuestionRequestPayload): void {
    const sid = payload.sessionId;
    // 题目先于 request 落表：request 一变真，面板就会渲染并读 questionsOf。
    questionSets.set(sid, payload.questions);
    answeredStates.delete(sid); // 新一轮问卷：上一轮摘要让位
    suppressed.delete(sid); // 新问卷要能重新显示自己的已答摘要
    deadlines.set(sid, now() + payload.timeoutMs);
    requests.set(sid, payload);
  }

  function settle(sessionId: string, state: AskUserAnsweredState): void {
    answeredStates.set(sessionId, state);
    release(sessionId);
  }

  function applyCompletion(sessionId: string, details: unknown): void {
    const authoritative = applyAskUserCompletion(questionSets.get(sessionId) ?? [], details);
    if (authoritative !== null) {
      // `deliveryFailed` 是**本地判定**（reply 是否送达），权威 `details` 里没有也管不着它。
      // 不保留的话，回填失败的面板会等来一份「普通取消」摘要，把「答案没送出去」这个
      // 事实抹掉 —— 那正是这个标记存在的意义。
      const prev = answeredStates.get(sessionId);
      answeredStates.set(
        sessionId,
        prev?.deliveryFailed === true ? { ...authoritative, deliveryFailed: true } : authoritative,
      );
    }
    release(sessionId);
  }

  return {
    request,
    deadline,
    answered,
    accept,
    settle,
    applyCompletion,
    clearAnswered(sessionId) {
      answeredStates.delete(sessionId);
      // 抑制而非仅删除：清掉后迟到的 tool.completed 仍会写回摘要（乐观收尾的固有顺序），
      // 标记住才能挡住它把摘要重新点亮。
      suppressed.add(sessionId);
    },
    dismissAnswered(sessionId) {
      answeredStates.delete(sessionId);
      suppressed.add(sessionId);
    },
    questionsOf(sessionId) {
      return questionSets.get(sessionId);
    },
    requestOf(sessionId) {
      return requests.get(sessionId);
    },
  };
}
