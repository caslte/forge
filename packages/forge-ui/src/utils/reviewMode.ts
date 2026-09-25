/**
 * 回看模式状态机纯函数（CV-S06，AC-CV-016，TD-CV-06）。
 *
 * 设计约束（docs/prd/03_conversation.md「CV-S06 会话历史导航（扩展）」）：
 * - 纯 TS、零运行时依赖（无任何 import），Node type stripping 直跑，不碰 DOM；
 * - 状态：{ mode:'browse'|'review', targetIndex, autoFollow }；
 * - 转移语义（U-CV-008 / AC-CV-016 / TD-CV-06）：
 *   1. browse 下 enter(index) → review：autoFollow=false、targetIndex=index；
 *      review 下重复 enter（同/异条目）等价一次定位语义：仅更新 targetIndex，
 *      autoFollow 保持 false，无其他状态副作用；
 *   2. review 期间任何流式 delta 不得产生自动滚底输出：状态机层面**没有 delta 事件入口**
 *      （不暴露 onDelta/applyDelta 之类方法），autoFollow 在 review 期间恒为 false，
 *      直到退出才恢复 true——「delta 不强制滚底」由状态机结构性保证；
 *   3. review 下 nearBottom()（滚动触底信号）或显式 exit() → browse（autoFollow=true）
 *      **恰好一次**：browse 下重复 exit()/nearBottom() 均无副作用；
 *   3.5 detach()（流式期间用户手动上滚翻阅历史）：browse → review（targetIndex=null，
 *      无定位目标）；review 下无副作用（重复上滚/与 enter 共存都不覆盖已有定位目标）；
 *   4. reset()（会话切换）→ browse 初始态（autoFollow=true、targetIndex=null）；
 *   5. enter 的 index 非法（非有限数/非整数/负数）→ 无副作用，不产生 NaN/undefined 泄漏。
 * - 派生：提示条可见性 showBackdownHint =（mode === 'review'）。
 */

export type ReviewMode = 'browse' | 'review';

export interface ReviewModeState {
  /** 浏览模式 / 回看模式 */
  readonly mode: ReviewMode;
  /** 回看态的定位目标消息索引（messages 数组索引）；browse 态为 null */
  readonly targetIndex: number | null;
  /** true = 自动跟随流式滚底；review 态恒 false */
  readonly autoFollow: boolean;
}

export interface ReviewModeController {
  /** 当前状态快照（只读） */
  getState(): ReviewModeState;
  /** 时间线条目点击：browse → review；review 中重复点击仅更新目标 */
  enter(index: number): ReviewModeState;
  /** 流式期间用户手动向上滚动翻阅历史：browse → review（无定位目标，targetIndex=null）；review 下无副作用 */
  detach(): ReviewModeState;
  /** 显式退出回看（"回到底部"提示条点击）：review → browse，恰好一次 */
  exit(): ReviewModeState;
  /** 滚动触底信号：与 exit 同一转移；browse 下无副作用 */
  nearBottom(): ReviewModeState;
  /** 会话切换重置 → browse 初始态 */
  reset(): ReviewModeState;
  /** 派生：底部"回到底部"提示条可见性（仅 review 态可见） */
  showBackdownHint(): boolean;
}

/** browse 初始态（也是 reset 目标态） */
export function createInitialReviewModeState(): ReviewModeState {
  return { mode: 'browse', targetIndex: null, autoFollow: true };
}

/** 定位目标索引合法性：非有限数/非整数/负数一律视为非法（不进入/不更新回看态） */
function isValidIndex(index: number): boolean {
  return typeof index === 'number' && Number.isFinite(index) && Number.isInteger(index) && index >= 0;
}

/** 创建回看模式状态机（纯状态，不碰 DOM；UI 层自行订阅/映射到视图） */
export function createReviewModeController(): ReviewModeController {
  let state: ReviewModeState = createInitialReviewModeState();

  function exitInternal(): ReviewModeState {
    // 恰好一次：browse 下重复退出信号无副作用
    if (state.mode !== 'review') return state;
    state = createInitialReviewModeState();
    return state;
  }

  return {
    getState(): ReviewModeState {
      return state;
    },

    enter(index: number): ReviewModeState {
      if (!isValidIndex(index)) return state; // 非法索引：无副作用
      if (state.mode === 'review') {
        // 重复定位：同条目状态不变；异条目仅更新 target（autoFollow 保持 false）
        if (state.targetIndex === index) return state;
        state = { mode: 'review', targetIndex: index, autoFollow: false };
        return state;
      }
      state = { mode: 'review', targetIndex: index, autoFollow: false };
      return state;
    },

    exit: exitInternal,

    detach(): ReviewModeState {
      if (state.mode !== 'browse') return state; // review 下重复上滚无副作用
      state = { mode: 'review', targetIndex: null, autoFollow: false };
      return state;
    },

    nearBottom: exitInternal,

    reset(): ReviewModeState {
      state = createInitialReviewModeState();
      return state;
    },

    showBackdownHint(): boolean {
      return state.mode === 'review';
    },
  };
}
