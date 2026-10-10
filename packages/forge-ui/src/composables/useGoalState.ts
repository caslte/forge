/**
 * goal（pi-goal）状态的 UI 侧状态管理（goal 接入，2026-10-10）。
 *
 * 职责：
 * 1. 订阅 `goal.statusChanged` → 每会话一份紧凑状态串（喂给 GoalBadge）。
 * 2. 订阅 `goal.uiRequested` → 每会话一份待裁决请求（喂给 GoalDialog）+ 倒计时。
 * 3. 订阅 `goal.notified` / `goal.uiTimedOut` → 转发到 toast（用户可见）。
 * 4. 回填 `goal/uiReply` 并在超时/回填后清掉请求。
 *
 * 会话隔离：与 askQuestionStore 同一纪律 —— 按 sessionId 存 Map，
 * 多窗格各自订阅并按 sessionId 认领，避免「N 个窗格弹 N 份确认框」。
 *
 * 超时纪律（ask_user_question 同款，契约硬约束）：倒计时归零必须**主动回填**
 * `cancelled: true`，否则扩展侧只能看到空快照；且不能只回填不撤面板。
 * 宿主侧另有宽限兜底（GOAL_UI_REPLY_GRACE_MS），两侧独立收敛、幂等。
 */
import { onBeforeUnmount, ref } from 'vue';

import type { GoalUiReplyParams, GoalUiRequestedPayload } from '../bridge';
import { useToast } from './useToast.ts';

/** 单会话的 goal 状态 */
interface GoalSessionState {
  /** pi-goal 的紧凑状态串原文；null 表示无目标 */
  statusText: string | null;
  /** 待裁决请求；null 表示当前无请求 */
  request: GoalUiRequestedPayload | null;
  /** 倒计时截止时间戳（Date.now() 口径） */
  deadline: number;
}

/** 目标区状态（按 sessionId 隔离） */
const sessions = ref<Map<string, GoalSessionState>>(new Map());

/** 驱动倒计时的 tick（秒）；仅在有请求时递增，秒级粒度足够（不逐毫秒重渲染） */
const tick = ref(0);

function ensure(sessionId: string): GoalSessionState {
  const existing = sessions.value.get(sessionId);
  if (existing !== undefined) return existing;
  const created: GoalSessionState = { statusText: null, request: null, deadline: 0 };
  sessions.value.set(sessionId, created);
  return created;
}

/** 某会话的状态（不存在时返回 null，不创建 —— 渲染层不应因读而写） */
export function goalStatusOf(sessionId: string | null | undefined): string | null {
  if (!sessionId) return null;
  return sessions.value.get(sessionId)?.statusText ?? null;
}

/** 某会话的待裁决请求 */
export function goalRequestOf(sessionId: string | null | undefined): GoalUiRequestedPayload | null {
  if (!sessionId) return null;
  return sessions.value.get(sessionId)?.request ?? null;
}

/** 某会话的剩余秒数（无请求返回 0） */
export function goalRemainingOf(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  const state = sessions.value.get(sessionId);
  if (state === undefined || state.request === null) return 0;
  return Math.max(0, Math.ceil((state.deadline - Date.now()) / 1000));
}

/**
 * 处理目标状态行更新。
 *
 * 载荷 text 为 null 表示清除徽标（pi-goal 在无目标 / clear 时会这么调）。
 * 这里如实存 null —— 不做「保留旧值」兜底：那会让清除目标后徽标永久残留，
 * 是比「徽标消失」严重得多的错（用户会以为目标还在跑）。
 */
export function applyGoalStatus(sessionId: string, text: string | null): void {
  ensure(sessionId).statusText = text;
}

/**
 * 处理用户裁决请求。
 *
 * 同会话已有未决请求时**新请求覆盖旧的**：pi-goal 的 confirm/input 是串行的，
 * 真出现并发说明上游有异常；覆盖比排队更安全（避免旧的永远等不到、新的永远排不上）。
 */
export function applyGoalRequest(sessionId: string, payload: GoalUiRequestedPayload): void {
  const state = ensure(sessionId);
  state.request = payload;
  state.deadline = Date.now() + payload.timeoutMs;
}

/** 清掉某会话的待裁决请求（回填成功 / 会话切换后不再需要） */
export function clearGoalRequest(sessionId: string): void {
  const state = sessions.value.get(sessionId);
  if (state === undefined) return;
  state.request = null;
  state.deadline = 0;
}

/**
 * 回填裁决结果。
 *
 * 失败（delivered=false）不静默：会话可能已删或该请求已被宿主宽限收敛。
 * 这时清面板是安全的（请求已不存在），但要提示用户「没送出去」。
 * @returns 是否投递成功
 */
export async function replyGoalUi(
  sessionId: string,
  requestId: string,
  value: string | boolean | null,
  cancelled: boolean,
): Promise<boolean> {
  const params: GoalUiReplyParams = { sessionId, requestId, value, cancelled };
  try {
    const res = await window.forge.goal.uiReply(params);
    clearGoalRequest(sessionId);
    return res.code === 0 && res.data?.delivered === true;
  } catch {
    clearGoalRequest(sessionId);
    return false;
  }
}

/**
 * 订阅四条 goal 事件。返回退订函数。
 *
 * 在组件 setup 里调用（`onBeforeUnmount` 自动退订）。多条订阅互不干扰，
 * 重复调用会各自退订干净。
 */
export function useGoalEvents(): void {
  const unsubs: Array<() => void> = [];
  const toast = useToast();

  unsubs.push(
    window.forge.goal.onStatus((payload) => {
      applyGoalStatus(payload.sessionId, payload.text);
    }),
  );

  unsubs.push(
    window.forge.goal.onNotified((payload) => {
      // pi-goal 的原文是英文（"Goal started: …"）。这里原样透出：
      // 翻译会引入一张需要随上游文案更新而维护的表，且容易译错安全提示。
      // level 映射到 toast 的三档：warning→info（toast 无 warning 档），
      // error→error。真正的「预算耗尽」等关键提示另有 GoalBadge 的警示样式兜底。
      if (payload.level === 'error') toast.error(payload.message);
      else toast.info(payload.message);
    }),
  );

  unsubs.push(
    window.forge.goal.onUiRequested((payload) => {
      applyGoalRequest(payload.sessionId, payload);
    }),
  );

  unsubs.push(
    window.forge.goal.onUiTimedOut((payload) => {
      // 宿主宽限已把 confirm 当作「否」收敛 —— 必须让用户知道，
      // 否则就是「我明明看到弹窗了，但目标怎么没换」的静默拒绝。
      toast.info(`「${payload.title}」等待超时，已按取消处理`);
    }),
  );

  onBeforeUnmount(() => {
    for (const off of unsubs) {
      try { off(); } catch { /* 退订失败不影响卸载 */ }
    }
  });
}

/**
 * 倒计时心跳。
 *
 * 只做「到点回填」这一件事，不驱动重渲染倒计时数字本身（组件自带 remainingSec 计算）。
 * 用 1s 间隔轮询而非每请求一个 setInterval：请求数少、且会话切换后旧定时器要能自然失效。
 */
export function startGoalCountdown(): void {
  const timer = window.setInterval(() => {
    tick.value += 1;
    const now = Date.now();
    for (const [sessionId, state] of sessions.value) {
      const req = state.request;
      if (req === null) continue;
      if (state.deadline > now) continue;
      // 到点：先撤面板再回填，避免用户点到一个已失效的弹窗。
      clearGoalRequest(sessionId);
      void replyGoalUi(sessionId, req.requestId, null, true);
    }
  }, 1000);
  onBeforeUnmount(() => window.clearInterval(timer));
}
