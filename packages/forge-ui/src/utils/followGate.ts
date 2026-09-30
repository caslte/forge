/**
 * 自动跟随门控（Issue1：auto-scroll 打断用户上滚）。
 *
 * 问题：原实现靠 scroll 事件的像素增量反推「用户是否在上滚」
 * （ConversationView.vue 中 `scrolledUpBy > 2 && 距底 > 40px`），两头都不可靠：
 * - **假阴性**：触控板/滚轮的第一下常常只有 1~2px，落在阈值内不 detach；
 *   用户刚抬手，流式 delta 的钉底就把视口拽回底部 —— 即「打断用户上滚」。
 * - **假阳性**：内容收缩（Todo 面板折叠、历史窗口回收）触发浏览器 clamp scrollTop，
 *   同样表现为 scrollTop 变小，凭空 detach 并弹出「回到底部」。
 *
 * 方案：滚动**意图**由输入事件（wheel/touch/pointer/key）打时间戳标记，
 * scroll 事件只在意图仍然新鲜（USER_SCROLL_INTENT_MS 内）时才判方向。
 * 没有输入事件却出现的 scrollTop 减少一律视为程序性位移，不暂停跟随。
 *
 * 设计约束（沿用 reviewMode.ts 先例）：纯 TS、零 import、零 DOM 接触；
 * 时钟由调用方注入（now 参数），便于 node --test 覆盖时间窗边界。
 */

/** 输入事件后的意图保鲜期：覆盖惯性滚动/连续滚轮的间隔，超时则不信任无输入的位移 */
export const USER_SCROLL_INTENT_MS = 400;

/** 距底小于此值视为「已在底部」，不进入回看态 */
export const NEAR_BOTTOM_PX = 40;

export interface FollowGateOptions {
  /** 距底阈值（px），默认 NEAR_BOTTOM_PX */
  nearBottomPx?: number;
  /** 意图保鲜期（ms），默认 USER_SCROLL_INTENT_MS */
  intentWindowMs?: number;
}

export interface FollowGate {
  /** 记录一次用户滚动输入（wheel/touchmove/touchstart/pointerdown/滚动按键），now 为当前时刻 */
  markUserIntent(now: number): void;
  /** 意图是否仍新鲜（现在是否还在保鲜期内） */
  isUserIntentFresh(now: number): boolean;
  /** 显式作废意图（会话切换、程序性定位钉底后调用），避免陈旧输入误判后续位移 */
  clearUserIntent(): void;
  /**
   * 一次 scroll 事件的判定：是否应脱离自动跟随（= 进入回看态）。
   * @param now 当前时刻（注入时钟）
   * @param scrolledUpBy 上次 scrollTop - 本次 scrollTop，>0 表示视口上移
   * @param distanceFromBottom scrollHeight - scrollTop - clientHeight
   */
  onScroll(now: number, scrolledUpBy: number, distanceFromBottom: number): boolean;
}

/** 键盘滚动意图键：其余按键（输入、Esc 等）不表达滚动意图 */
const SCROLL_KEYS = new Set([
  'ArrowUp',
  'ArrowDown',
  'PageUp',
  'PageDown',
  'Home',
  'End',
  ' ',
  'Spacebar',
]);

/** 该 keydown 是否构成滚动意图（供 DOM 层决定要不要 markUserIntent） */
export function isScrollIntentKey(key: string): boolean {
  return SCROLL_KEYS.has(key);
}

export function createFollowGate(options: FollowGateOptions = {}): FollowGate {
  const nearBottomPx = options.nearBottomPx ?? NEAR_BOTTOM_PX;
  const intentWindowMs = options.intentWindowMs ?? USER_SCROLL_INTENT_MS;
  let intentUntil = Number.NEGATIVE_INFINITY;

  function isUserIntentFresh(now: number): boolean {
    return now < intentUntil;
  }

  return {
    markUserIntent(now: number): void {
      intentUntil = now + intentWindowMs;
    },

    isUserIntentFresh,

    clearUserIntent(): void {
      intentUntil = Number.NEGATIVE_INFINITY;
    },

    onScroll(now: number, scrolledUpBy: number, distanceFromBottom: number): boolean {
      // 无新鲜输入意图的 scrollTop 减少 = 程序性位移（smooth 滚动被打断、布局 clamp、扩窗锚定）
      if (!isUserIntentFresh(now)) return false;
      // 视口必须真的上移，且确实离开底部；阈值取 >0：1px 也算用户意图，不设 2px 最小量
      if (!(scrolledUpBy > 0)) return false;
      return distanceFromBottom > nearBottomPx;
    },
  };
}
