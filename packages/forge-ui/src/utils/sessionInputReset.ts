/**
 * 切会话时输入框状态重置策略纯函数（InstructionInput.vue 会话 watcher 用）。
 *
 * 背景：原 watcher 仅在 `historyCursor.value >= 0`（用户正用 ↑↓ 翻历史）时才清输入框，
 * 普通"输入但未发送就切会话"路径会留下残留文本，导致跨会话串味。
 * 草稿态（无 sessionId）切会话不重置。
 *
 * 纯 TS 零依赖（Node type stripping 可直跑，先例 utils/pasteText.ts）。
 */

export interface SessionInputResetInput {
  /** 当前输入框文本 */
  currentText: string;
  /** 进入历史翻阅前暂存的草稿 */
  pendingDraft: string;
  /** 当前历史翻阅 cursor：-1=未在翻阅；>=0=在翻历史第 N 条 */
  historyCursor: number;
  /** 是否草稿态（无 sessionId） */
  isDraft: boolean;
}

export interface SessionInputReset {
  text: string;
  pendingDraft: string;
  historyCursor: number;
}

/**
 * 决定切会话后输入相关三个状态（text / pendingDraft / historyCursor）的新值。
 * 草稿态保留一切；已激活会话清空 text + pendingDraft 并把 cursor 复位为 -1。
 */
export function computeSessionInputReset(input: SessionInputResetInput): SessionInputReset {
  if (input.isDraft) {
    return {
      text: input.currentText,
      pendingDraft: input.pendingDraft,
      historyCursor: input.historyCursor,
    };
  }
  return {
    text: '',
    pendingDraft: '',
    historyCursor: -1,
  };
}