/**
 * goal 状态转发扩展（内建于 forge，不改 pi-goal 源码）。
 *
 * pi-goal 有两条状态出口，forge 两条都要接：
 * 1. `ctx.ui.setStatus("goal", <紧凑状态串>)` —— 由 {@link createForgeUiContext} 转发到
 *    `goal:status`。**覆盖全部形态且带用量，是徽标的主数据源。**
 * 2. `pi.events.emit("pi-goal:event:${runId}", ...)` —— 受管运行通道，**仅当**
 *    `pi-goal.json` 的 `rpc.enabled = true` 且经 RPC 启动的目标才有事件，
 *    但它带 `summary`（完成证据摘要）/`reason`（停机原因），是状态行里没有的信息。
 *
 * 本扩展订阅第2 条并转发到 `goal:state`；第 1 条已在 uiContext 内转发，无需重复订阅。
 *
 * 注意：pi-goal 的 RPC 事件 channel 名含 runId（动态），无法用 `bus.on` 逐个订阅。
 * pi 的 `events.on` 不支持前缀通配，故本扩展改为**在宿主侧主动 start 时代为订阅**：
 * 由 forge-desktop 在通过 RPC 启动目标时拿到 runId，再调本扩展登记的注册表。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import {
  GOAL_STATE_CHANNEL,
  GOAL_STATUSES,
  type GoalStatePayload,
  type GoalStatePayloadStatus,
} from './channels.ts';

export const GOAL_RUN_START_CHANNEL = 'pi-goal:start';
export const GOAL_RUN_CANCEL_CHANNEL = 'pi-goal:cancel';

/** pi-goal 事件 channel 名（run-protocol.ts `goalRunEventChannel`）。 */
export function goalRunEventChannel(runId: string): string {
  return `pi-goal:event:${runId}`;
}

function isGoalStatePayload(value: unknown): value is GoalStatePayload {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  if (typeof v.goalId !== 'string' || v.goalId.length === 0) return false;
  if (typeof v.status !== 'string') return false;
  if (!GOAL_STATUSES.has(v.status)) return false;
  if (v.summary !== undefined && typeof v.summary !== 'string') return false;
  if (v.reason !== undefined && typeof v.reason !== 'string') return false;
  return true;
}

/**
 * 每个会话一份：登记该会话「当前活跃的受管 run」，收到其状态事件即转发。
 *
 * 不做全局单例的原因：pi-goal 的受管运行同时只允许一个（`GOAL_ALREADY_EXISTS`），
 * 但 forge 是**多会话并发**的（每会话一条私有总线，见 askUserQuestion 通道注释），
 * 故状态必须按总线隔离，否则 A 会话的目标状态会串到 B 会话的 UI。
 */
export interface GoalStateForwarder {
  /** 登记某 runId 的事件订阅（启动受管目标后调用）。返回退订函数。 */
  watchRun(runId: string): () => void;
}

/**
 * 创建状态转发器。
 *
 * @param pi forge 注入的 ExtensionAPI（其 `events` 即该会话总线）
 */
export function createGoalStateForwarder(pi: ExtensionAPI): GoalStateForwarder {
  return {
    watchRun(runId: string): () => void {
      return pi.events.on(goalRunEventChannel(runId), (raw) => {
        // pi-goal 的事件有两类：state / error。这里只转发 state（error 是启动失败的诊断，
        // 由启动方的 RPC 回执直接拿到，不必占用 UI 状态通道）。
        if (!raw || typeof raw !== 'object') return;
        const v = raw as Record<string, unknown>;
        if (v.type !== 'state') return;
        if (!isGoalStatePayload(v)) return;
        const payload: GoalStatePayload = {
          goalId: v.goalId,
          status: v.status as GoalStatePayloadStatus,
          ...(v.summary !== undefined ? { summary: v.summary } : {}),
          ...(v.reason !== undefined ? { reason: v.reason } : {}),
        };
        pi.events.emit(GOAL_STATE_CHANNEL, payload);
      });
    },
  };
}

/**
 * InlineExtension 形态。
 *
 * 本身不做任何事（订阅在宿主侧按 runId 动态建立），存在的意义是：
 * - 让 forge 有了一个明确的「goal 能力」扩展位，便于将来挂更多钩子；
 * - 承载 tool_policy 的存在性检查（pi-goal 的 `assertGoalToolsAvailable` 依赖
 *   `goal_complete` / `goal_blocked` / `goal_wait` 三个工具已注册）。
 *
 * 真正的接入点在 createPiAgentSessionFactory（注入 uiContext）。
 */
export const goalBridgeExtension: InlineExtension = {
  name: 'forge-goal-bridge',
  factory: () => {
    // 无副作用：goal 的交互与状态转发都不依赖扩展注册，见 createGoalStateForwarder。
  },
};
