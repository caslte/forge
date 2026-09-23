/**
 * 上下文压缩横幅状态（按 sessionId 内存隔离，App 生命周期内持久）。
 *
 * 设计：
 * - 压缩中 →「正在压缩上下文…」；完成 →「上下文已压缩（减少 x%）」，
 *   百分比对用户更可感知（token 绝对值无感）；
 * - 状态为模块级单例 Map：单/多窗口、会话切换来回均保持；不持久化，
 *   重启 App 自然丢失（产品确认：只需在本次运行期知道"这里压缩过"）。
 */
import { reactive } from 'vue';

import { i18n } from '../i18n/index.ts';

export interface CompactBannerState {
  phase: 'compacting' | 'done';
  /** 完成横幅文案（含减少百分比）；压缩中为 null */
  text: string | null;
}

/** 模块级横幅状态：sessionId → 横幅（App 运行期持久） */
const banners = reactive(new Map<string, CompactBannerState>());

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
    banners.set(sessionId, { phase: 'compacting', text: null });
  }

  /** 标记压缩完成：能算出比例则显示「减少 x%」，否则退回纯文字 */
  function markDone(
    sessionId: string,
    tokensBefore?: number | null,
    tokensAfter?: number | null,
  ): void {
    const pct = compactReductionPct(tokensBefore, tokensAfter);
    banners.set(sessionId, {
      phase: 'done',
      text:
        pct !== null
          ? i18n.t('chat.contextCompactedReduction', { pct })
          : i18n.t('chat.contextCompacted'),
    });
  }

  /** 清除横幅（压缩失败/中止时回退） */
  function clear(sessionId: string): void {
    banners.delete(sessionId);
  }

  /** 读取会话横幅（无会话/无记录返回 null；banners 为 reactive Map，可直接入 computed） */
  function getBanner(sessionId: string | null | undefined): CompactBannerState | null {
    if (!sessionId) return null;
    return banners.get(sessionId) ?? null;
  }

  return { markCompacting, markDone, clear, getBanner };
}
