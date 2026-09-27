/**
 * 上下文压缩横幅状态（按 sessionId 内存隔离，仅覆盖压缩中区间）。
 *
 * 设计（2026-09-27 用户反馈修正）：
 * - 压缩中 →「正在压缩上下文…」；完成即清除。完成后不再常驻提示：
 *   结果反馈由瞬时 toast（减少百分比 + token 变化）与消息流内联
 *   「上下文已压缩」分隔条（压缩点精确位置）承担，底部常驻横幅与之重复；
 * - 状态为模块级单例 Map：单/多窗口、会话切换来回均保持；不持久化。
 */
import { reactive } from 'vue';

/** 模块级横幅状态：sessionId → 压缩中（压缩结束即删除） */
const banners = reactive(new Map<string, true>());

/** 压缩减少百分比（before→after，如 40000→6000 = 85）；数据不足返回 null */
export function compactReductionPct(
  before: number | null | undefined,
  after: number | null | undefined,
): number | null {
  if (
    typeof before === 'number' &&
    typeof after === 'number' &&
    before > 0 &&
    after >= 0 &&
    after < before
  ) {
    return Math.round((1 - after / before) * 100);
  }
  return null;
}

export function useCompactBanner() {
  /** 标记会话进入压缩中（手动点击或收到 conversation.compacting 事件） */
  function markCompacting(sessionId: string): void {
    banners.set(sessionId, true);
  }

  /** 压缩结束（完成/失败/中止）：清除压缩中横幅 */
  function clear(sessionId: string): void {
    banners.delete(sessionId);
  }

  /** 会话是否处于压缩中（banners 为 reactive Map，可直接入 computed） */
  function isCompacting(sessionId: string | null | undefined): boolean {
    if (!sessionId) return false;
    return banners.has(sessionId);
  }

  return { markCompacting, clear, isCompacting };
}
