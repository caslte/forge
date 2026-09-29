/**
 * 待办面板的 UI 态表（折叠 / 自动隐藏），模块级，跨组件实例共享。
 *
 * 为什么单独成文件而不是放在 TodoPanel.vue 里：数据侧（todoSnapshots）提到模块级是
 * 为了「进设置页 → ConversationView 整块卸载 → 回来不丢」。UI 态表若留在实例里，
 * 视图重建后它们回到初值，方向相反地丢状态 —— 用户手动折叠的待办会弹开、
 * 「全部完成自动隐藏」的待办会重新出现。
 *
 * 同 askQuestionStore 的约束：本文件**只 import `vue` 的响应式原语**，
 * 供 node:test 直接跑（组件层没有组件测试设施）。因此 useSessionConversation 也只
 * 从这里 import，绝不 import TodoPanel.vue —— 否则会把 .vue 拖进纯逻辑测试的加载链。
 */

import { ref } from 'vue';

/** 折叠态：true = 已折叠（用户手动或自动流程置起） */
export const collapsedBySession = ref<Map<string, boolean>>(new Map());

/** 自动隐藏态：true = 已播完隐藏动画并从 DOM 卸载 */
export const dismissedBySession = ref<Map<string, boolean>>(new Map());

/** 由自动流程置起折叠的会话（用于区分手动折叠：仅自动折叠在新任务到达时自动展开） */
export const autoFoldedSessions = new Set<string>();

/**
 * 清空某会话的全部 UI 态（会话被删除时由 useSessionConversation 调用）。
 *
 * 与数据侧（todoSnapshots / askQuestionStore 共享表）在同一个 session.removed
 * 回调里清理，避免删掉的会话在模块级表里留下永久条目。
 */
export function clearTodoPanelSessionState(sessionId: string): void {
  collapsedBySession.value.delete(sessionId);
  dismissedBySession.value.delete(sessionId);
  autoFoldedSessions.delete(sessionId);
}
