/**
 * pi-goal 宿主适配的通道契约（forge 自有）。
 *
 * 背景：`@narumitw/pi-goal` 已在 forge 预装清单内（recommendedPlugins.ts），其状态机、
 * 工具与提示词契约均已可用，但它按 TUI 宿主设计 —— 一切用户可见交互都走 `ctx.ui`
 * （`confirm` / `input` / `editor` / `notify`）。forge 绑定扩展时未传 `uiContext`
 * （createPiAgentSessionFactory.ts），pi 回落到 `noOpUIContext`
 * （pi-coding-agent/dist/core/extensions/runner.js:88）：`confirm` 恒 false、`notify` 空实现。
 * ⇒ 目标替换被静默拒绝、全部状态通知丢失。
 *
 * 本模块提供两条通路，把 pi-goal 的交互与状态接入 forge：
 * 1. **UI 请求/回填**（双向）：`goal-ui:request` / `goal-ui:reply:{requestId}`。
 *    pi-goal 通过 `ctx.ui` 发出的确认/输入请求，经此投递给 renderer 并等回填。
 * 2. **状态上行**（单向）：pi-goal 把自己在 `pi.events` 上的状态事件转发到
 *    `goal:state`，由 forge 桥接为会话级事件推送 UI。
 *
 * 与 ask-user 通道同构（channels.ts），故通道名无需 sessionId 后缀（每会话私有总线），
 * 但跨进程载荷必须带 sessionId。
 */

/** 会话总线上行通道：宿主 UI 适配层 → renderer，投递一个待用户裁决的交互请求。 */
export const GOAL_UI_REQUEST_CHANNEL = 'goal-ui:request';

/** 会话总线下行通道：renderer → 宿主 UI 适配层，回填用户的选择/输入。 */
export function goalUiReplyChannel(requestId: string): string {
  return `goal-ui:reply:${requestId}`;
}

/**
 * pi-goal 请求的交互经 {@link GOAL_UI_REQUEST_CHANNEL} 投递；下列两个是它的伴生通道：
 * - notify：pi-goal 的全部状态播报（errors.ts 的 notifyTerminal）。
 * - timeout：适配层宽限到期仍未收到回填时的告警（避免「静默拒绝」无迹可寻）。
 */
export const GOAL_UI_NOTIFY_CHANNEL = 'goal-ui:notify';
export const GOAL_UI_TIMEOUT_CHANNEL = 'goal-ui:timeout';

/** 通知载荷（会话总线）。level 对齐 pi 的 info/warning/error。 */
export interface GoalUiNotifyPayload {
  message: string;
  level: 'info' | 'warning' | 'error';
}

/** 会话总线上行通道：pi-goal 状态行 → forge 桥接 → renderer。 */
export const GOAL_STATUS_CHANNEL = 'goal:status';

/**
 * 状态行载荷（会话总线）。
 *
 * **这是 goal 状态徽标的唯一完整数据源**，比 RPC 通道更可靠：
 * - pi-goal 每次状态变化都调 `ctx.ui.setStatus("goal", <紧凑状态串>)`（runtime.ts:567），
 *   覆盖 active / waiting / paused / blocked / usage / budget / complete 全部形态，
 *   且带 `automatic 已用/上限` 与 token 预算用量。
 * - 而 `pi-goal:event:*`（RPC）**只在受管运行模式下**发事件，且只有 start/cancel 能力。
 *
 * `text` 即 pi-goal 原样给出的紧凑状态串（如 `active 3m · automatic 12/25`），
 * UI 直接展示即可，无需二次拼装 —— 避免与 pi-goal 的格式逻辑重复实现后漂移。
 * `text` 为 undefined 表示清除徽标（pi-goal 在无目标 / clear 时会这么调）。
 */
export interface GoalStatusPayload {
  /** pi-goal 的固定 status key（`runtime.ts:113` `STATUS_KEY = "goal"`）。 */
  key: string;
  text: string | undefined;
}

/** 会话总线上行通道：pi-goal 状态 → forge 桥接 → renderer。 */
export const GOAL_STATE_CHANNEL = 'goal:state';

/** pi-goal 请求的交互种类。 */
export type GoalUiRequestKind = 'confirm' | 'input' | 'editor' | 'select';

/**
 * 上行载荷（会话总线 → renderer）。
 *
 * requestId 由宿主侧生成（crypto.randomUUID），回填时按它配对。
 * timeoutMs 是宿主侧的兜底宽限：到期仍未回填即按 kind 的缺省语义收敛，
 * 避免 pi-goal 的 Promise 永久悬挂（pi-goal 自身也有宽限期，见下）。
 */
export interface GoalUiRequestPayload {
  requestId: string;
  kind: GoalUiRequestKind;
  /** 弹窗标题（pi-goal 的 `title` 参数，英文）。 */
  title: string;
  /** 正文（`confirm` / `input` 的提示语）。可能很长，UI 需自行截断展示。 */
  message: string;
  /** `input` / `editor` 的占位符。 */
  placeholder?: string;
  /** `select` 的候选项（有序数组，UI 原样渲染）。 */
  options?: string[];
  /** 宿主侧兜底宽限（毫秒）。 */
  timeoutMs: number;
}

/** 下行载荷（renderer → 宿主 UI 适配层）。 */
export interface GoalUiReplyPayload {
  requestId: string;
  /**
   * 用户选择：
   * - confirm → true=确定 / false=取消
   * - select → 选中的项原文（未选视为取消）
   * - input / editor → 文本（空串视为取消）
   */
  value: string | boolean | null;
  /** 用户是否显式取消（confirm 点了取消、或关闭了弹窗）。 */
  cancelled: boolean;
}

/**
 * 宿主侧兜底宽限（毫秒）。
 *
 * 取 10 分钟：与 ask_user_question 同量级（DEFAULT_ASK_USER_TIMEOUT_MS = 600_000），
 * 覆盖「用户长时间离开后回来仍能作答」。注意 pi-goal 侧的 confirm 是在
 * `ctx.ui.confirm(...)` 上 await 的 —— 宿主宽限到期后必须以**合法值**收敛，
 * 否则 pi-goal 的替换流程会因拿到非法值而报错。
 */
export const GOAL_UI_REPLY_GRACE_MS = 600_000;

export function isGoalUiReplyPayload(value: unknown): value is GoalUiReplyPayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.requestId !== 'string') return false;
  if (typeof v.cancelled !== 'boolean') return false;
  return v.value === null || typeof v.value === 'string' || typeof v.value === 'boolean';
}

/**
 * pi-goal 状态上行载荷（纯数据）。
 *
 * 字段与 pi-goal `run-protocol.ts` 的 GoalRunEvent 对齐：`status` 取值
 * `active | complete | blocked | paused | usage_limited | budget_limited | cleared`。
 */
export interface GoalStatePayload {
  /** pi-goal 的目标实例 id（stale-turn 守卫的凭据，UI 展示用）。 */
  goalId: string;
  status: GoalStatePayloadStatus;
  /** complete 时 pi-goal 给的完成证据摘要（Markdown）。 */
  summary?: string;
  /** 其他终局的停机原因。 */
  reason?: string;
}

export type GoalStatePayloadStatus =
  | 'active'
  | 'complete'
  | 'blocked'
  | 'paused'
  | 'usage_limited'
  | 'budget_limited'
  | 'cleared';

export function isGoalStatePayload(value: unknown): value is GoalStatePayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.goalId !== 'string' || v.goalId.length === 0) return false;
  if (typeof v.status !== 'string') return false;
  return GOAL_STATUSES.has(v.status);
}

/** pi-goal 的全部合法状态（用于载荷校验，避免脏状态进 UI）。 */
export const GOAL_STATUSES: ReadonlySet<string> = new Set<GoalStatePayloadStatus>([
  'active',
  'complete',
  'blocked',
  'paused',
  'usage_limited',
  'budget_limited',
  'cleared',
]);

/**
 * 终局判定（纯函数，供 UI 与测试共用）。
 *
 * 语义与 pi-goal `run-protocol.ts` 的 `isTerminalGoalStatus` 一致：只有 `complete`
 * 是成功终局，其余终局都需要用户介入（resume / clear / 抬高预算）。
 */
export function isGoalTerminal(status: GoalStatePayloadStatus): boolean {
  return status !== 'active';
}

/** 是否为「因外部限制而停下、需要用户处理」的一类终局。 */
export function isGoalNeedsUser(status: GoalStatePayloadStatus): boolean {
  return (
    status === 'blocked' ||
    status === 'usage_limited' ||
    status === 'budget_limited'
  );
}
