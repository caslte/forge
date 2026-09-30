/**
 * 系统通知小窗（notifyToast.ts）的「弹 / 不弹」决策。纯逻辑，无 Electron 依赖，可单测。
 *
 * 为什么要独立成模块：main.ts 里这段原本是一坨 eventBus 回调里的 if，规则（冷却、
 * 前台判定、done 紧随中断、**出错宽限期**）只能靠人肉读。抽出来后按「输入状态事件 →
 * 输出决策」建模，规则改动都有测试兜着。
 *
 * 出错宽限期（本文件存在的核心理由，2026-09-30 用户反馈）：
 * pi 在 `message_end(stopReason=error)` 的瞬间就把状态打成 error，**之后**才判断该错误
 * 是否可重试——可重试就紧接着发 auto_retry_start（createForgeCore 随即把状态改回
 * streaming）。也就是说 status=error 到达时，「这一轮是否真的完了」还不知道。
 * 旧逻辑一见 error 就弹右下角「回复出错」，用户看到的便是：自己明明还在「正在自动重试
 * （第 1/3 次）」，失败通知先弹了出来。修法不是猜 pi 会不会重试（那是时序竞态），
 * 而是**宽限期复问**：error 先挂起，宽限期内状态回到 streaming（重试接管）就不弹；
 * 宽限期耗尽仍是 error（重试耗尽/不可重试，即真终态）才弹。
 *
 * 三个状态表：
 * - lastToastedAt：任意终态通知后的短冷却（重复终态只弹第一条）
 * - lastInterruptAt：cancel 编排（createForgeCore）会先 setStatus('canceled') 再经
 *   done 门控补发一次 'done'——该窗口内跟随中断/出错到达的 done 视为同一轮收尾，
 *   不用「回复已完成」覆盖「回复被中断/出错」
 * - lastStatus/pendingErrorAt：宽限期复问所需（当前状态 + 挂起时刻）
 */

/** 通知类别：done=回复完成；interrupt=被中断（含用户手动停止）；error=出错 */
export type NotifyKind = 'done' | 'interrupt' | 'error';

/** 决策输入的会话侧上下文 */
export interface NotifyGateContext {
  /** 主窗口是否前台聚焦（聚焦时不打扰；最小化视为离开） */
  focused: boolean;
  /** 当前时间戳（ms），冷却与宽限判定用（注入以便单测） */
  now: number;
}

/** 不弹的原因（仅日志用，不影响行为分支） */
export type NotifySkipReason =
  /** 非终态（streaming/idle 等），本就不该弹 */
  | 'not-terminal'
  /** 主窗口在前台，别打扰 */
  | 'focused'
  /** 冷却窗口内已有同类通知 */
  | 'cooldown'
  /** done 紧随中断/出错，属同一轮收尾 */
  | 'done-after-interrupt'
  /** 宽限期内状态已不是 error（= pi 接管去自动重试了） */
  | 'retry-resumed';

export type NotifyGateOutcome =
  /** 弹通知 */
  | { type: 'notify'; kind: NotifyKind }
  /** 出错但先别弹：等 errorGraceMs 后用 settle() 复问 */
  | { type: 'defer' }
  /** 不弹，附原因 */
  | { type: 'skip'; reason: NotifySkipReason };

export interface NotifyGateOptions {
  /**
   * 出错宽限期（ms）。需覆盖「message_end(error) → auto_retry_start」的到达间隔：
   * 两者同属一次 agent run 内的相邻事件，实践上是同一批 IPC 事件（毫秒级），
   * 留 1s 余量。代价是终态出错的通知晚 1s 出现——不可感知（横幅早已在界面上）。
   */
  errorGraceMs?: number;
  /** 任意终态通知后的冷却（ms），防重复终态连弹 */
  cooldownMs?: number;
  /** done 紧随中断/出错的抑制窗口（ms） */
  doneAfterInterruptMs?: number;
}

export interface NotifyGate {
  /** 宽限期长度：主进程据此设置复问定时器 */
  readonly errorGraceMs: number;
  /**
   * 喂入一次 conversation.statusChanged（含非终态：需要记录状态以便宽限期复问，
   * 也需要让「重试恢复 streaming」把挂起的错误作废）。
   */
  observe(sessionId: string, status: string, ctx: NotifyGateContext): NotifyGateOutcome;
  /** 宽限期到期复问：lastStatus 仍是 error 才算真终态 */
  settle(sessionId: string, ctx: NotifyGateContext): NotifyGateOutcome;
}

const DEFAULT_ERROR_GRACE_MS = 1000;
const DEFAULT_COOLDOWN_MS = 3000;
const DEFAULT_DONE_AFTER_INTERRUPT_MS = 5000;

export function createNotifyGate(options: NotifyGateOptions = {}): NotifyGate {
  const errorGraceMs = options.errorGraceMs ?? DEFAULT_ERROR_GRACE_MS;
  const cooldownMs = options.cooldownMs ?? DEFAULT_COOLDOWN_MS;
  const doneAfterInterruptMs = options.doneAfterInterruptMs ?? DEFAULT_DONE_AFTER_INTERRUPT_MS;

  const lastToastedAt = new Map<string, number>();
  const lastInterruptAt = new Map<string, number>();
  const lastStatus = new Map<string, string>();
  const pendingErrorAt = new Map<string, number>();

  /** 记一次「真的要弹了」：冷却与「done 紧随中断」门控只认已弹出的通知 */
  function commit(kind: NotifyKind, sessionId: string, now: number): void {
    lastToastedAt.set(sessionId, now);
    if (kind !== 'done') lastInterruptAt.set(sessionId, now);
  }

  function terminalKind(status: string): NotifyKind | null {
    if (status === 'done') return 'done';
    if (status === 'canceled') return 'interrupt';
    if (status === 'error') return 'error';
    return null;
  }

  return {
    errorGraceMs,

    observe(sessionId, status, ctx) {
      // 先记状态：settle() 靠它判断宽限期内是否被重试/别的状态接管
      lastStatus.set(sessionId, status);
      const kind = terminalKind(status);
      if (kind === null) return { type: 'skip', reason: 'not-terminal' };
      if (ctx.focused) return { type: 'skip', reason: 'focused' };
      // 冷却以「是否真的弹过」为准，不用 `?? 0` 兜底（那样首个时间戳小于 cooldownMs
      // 的时钟域会误判成冷却内）
      const lastToast = lastToastedAt.get(sessionId);
      if (lastToast !== undefined && ctx.now - lastToast < cooldownMs) {
        return { type: 'skip', reason: 'cooldown' };
      }
      const lastInterrupt = lastInterruptAt.get(sessionId);
      if (kind === 'done' && lastInterrupt !== undefined && ctx.now - lastInterrupt < doneAfterInterruptMs) {
        return { type: 'skip', reason: 'done-after-interrupt' };
      }
      if (kind === 'error') {
        // 挂起等复问：此刻还不知道 pi 会不会自动重试（见文件头）
        pendingErrorAt.set(sessionId, ctx.now);
        return { type: 'defer' };
      }
      commit(kind, sessionId, ctx.now);
      return { type: 'notify', kind };
    },

    settle(sessionId, ctx) {
      const deferredAt = pendingErrorAt.get(sessionId);
      pendingErrorAt.delete(sessionId);
      if (deferredAt === undefined) return { type: 'skip', reason: 'not-terminal' };
      // 状态已回到 streaming（pi 接管去自动重试）→ 这不是终态，别打扰
      if (lastStatus.get(sessionId) !== 'error') return { type: 'skip', reason: 'retry-resumed' };
      if (ctx.focused) return { type: 'skip', reason: 'focused' };
      commit('error', sessionId, ctx.now);
      return { type: 'notify', kind: 'error' };
    },
  };
}
