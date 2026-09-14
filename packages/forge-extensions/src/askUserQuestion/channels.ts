/**
 * ask_user_question 的 L3 传输契约（forge 自有，pi / rpiv 都没有）。
 *
 * 契约来源：docs/plan/ask-user-question-contract.md §4.2 / §4.3。
 *
 * 分工：
 * - **本文件**：会话事件总线上的通道名与载荷（extension ↔ 桥接层，均在 main 进程内）。
 * - forge-desktop `ipc-contract.ts`：ForgeEvent 名 + `FORGE_EVENTS` 白名单登记（WU-06）。
 * - forge-ui `bridge.ts`：renderer 侧事件名与 payload 类型（该包不依赖本包，按既有惯例独立声明）。
 *
 * 关键前提（已核实）：`DefaultResourceLoader` 位于**每会话** factory 闭包内，且
 * `createForgeCore` 未传 `eventBus` → 每会话一条私有总线，扩展拿到的 `pi.events`
 * 即该会话总线。故**通道名无需 sessionId 后缀**；但跨进程载荷**必须**带
 * `sessionId`，供 renderer 路由到正确窗格（契约 §4.4）。
 */

import type { QuestionAnswer } from './types.ts';
import type { QuestionData } from './schema.ts';

/** 会话总线上行通道：extension → 桥接层，投递一份问卷。 */
export const ASK_USER_REQUEST_CHANNEL = 'ask-user:request';

/** 会话总线下行通道：桥接层 → extension，回填某次问卷的作答。 */
export function askUserReplyChannel(requestId: string): string {
  return `ask-user:reply:${requestId}`;
}

/**
 * 面板倒计时时长（也是「用户未作答」的判定点）。此时刻 UI 应自行提交
 * **已答部分 + cancelled: true**，从而兑现契约「超时后保留超时前已答部分」。
 */
export const DEFAULT_ASK_USER_TIMEOUT_MS = 60_000;

/**
 * extension 侧安全网宽限：extension 的实际等待上限是
 * `timeoutMs + ASK_USER_REPLY_GRACE_MS`，比 UI 倒计时晚一点，确保「UI 在
 * 截止时刻提交部分答案」优先于「extension 超时返回空答案」被采纳。
 * 桥接缺失（无订阅者）时，这就是最终兜底路径。
 */
export const ASK_USER_REPLY_GRACE_MS = 1_500;

/** 上行载荷（会话总线）。 */
export interface AskUserRequestPayload {
  requestId: string;
  /** 完整问卷（含 preview / recommended），renderer 据此渲染原型形态面板。 */
  questions: QuestionData[];
  /** 面板倒计时时长（毫秒），使 UI 不必硬编码 60s。 */
  timeoutMs: number;
}

/** 下行载荷（会话总线）：UI 回填的作答。 */
export interface AskUserReplyPayload {
  requestId: string;
  /** 已作答题（取消 / 超时时**保留**，供「已答 n/N」与部分结果使用）。 */
  answers: QuestionAnswer[];
  cancelled: boolean;
  /** 条件展开：仅非空字符串时出现。 */
  globalNote?: string;
}

export function isAskUserReplyPayload(value: unknown): value is AskUserReplyPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return typeof v.requestId === 'string' && Array.isArray(v.answers) && typeof v.cancelled === 'boolean';
}
