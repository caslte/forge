/**
 * goalBridge 公开出口。
 *
 * 目的：把 `@narumitw/pi-goal` 的宿主适配（交互 + 状态）接入 forge GUI，
 * 而**不改 pi-goal 源码**。设计见 docs/plan/goal-integration-20261010101023.md。
 *
 * 背景一句话：pi-goal 已进 forge 预装清单，但它按 TUI 宿主设计 —— 一切用户可见交互
 * 走 `ctx.ui`。forge 绑定扩展时未传 `uiContext`，pi 回落到 `noOpUIContext`
 * （confirm 恒 false / notify 空实现）⇒ 目标替换被静默拒绝、状态通知全部丢失。
 * 本包补上这层宿主能力，pi-goal 侧零改动。
 */

export {
  GOAL_RUN_CANCEL_CHANNEL,
  GOAL_RUN_START_CHANNEL,
  createGoalStateForwarder,
  goalBridgeExtension,
  goalRunEventChannel,
} from './extension.ts';
export type { GoalStateForwarder } from './extension.ts';

export { createForgeUiContext } from './uiContext.ts';
export type { ForgeUiContextOptions, GoalUiEventBus } from './uiContext.ts';

export {
  GOAL_STATE_CHANNEL,
  GOAL_STATUS_CHANNEL,
  GOAL_STATUSES,
  GOAL_UI_NOTIFY_CHANNEL,
  GOAL_UI_REQUEST_CHANNEL,
  GOAL_UI_REPLY_GRACE_MS,
  GOAL_UI_TIMEOUT_CHANNEL,
  goalUiReplyChannel,
  isGoalNeedsUser,
  isGoalStatePayload,
  isGoalTerminal,
  isGoalUiReplyPayload,
} from './channels.ts';
export type {
  GoalStatePayload,
  GoalStatePayloadStatus,
  GoalStatusPayload,
  GoalUiNotifyPayload,
  GoalUiReplyPayload,
  GoalUiRequestKind,
  GoalUiRequestPayload,
} from './channels.ts';
