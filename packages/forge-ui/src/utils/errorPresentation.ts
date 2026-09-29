/**
 * 对话错误横幅的展示映射（CV-ERR-01）
 *
 * 分类在 forge-core（classifyError），**文案与色调在这里**：因为「同一分类在明暗主题
 * 下该用哪档色、该不该给重试」是纯展示决策，不该污染主进程。
 *
 * 布局定稿（prototypes/error-banner-variants.html，两行）：
 *   第一行：结论句 + 原始错误原文（原文永远保留，不改写、不省略）
 *   第二行：解释句；仅当重试有意义时附加「↻ 立即重试」
 *
 * 色调三档：
 *   destructive 需用户处理（凭据/额度/上下文/本机依赖）——红色留给「你不动它就不行」
 *   warning     往往可自愈或未识别——不把红色当常态，否则红色就没有信号价值
 *   info        内容已完整、仅收尾异常——最轻的语气，避免误读成「对话断了」
 */
import { i18n, type MessageKey } from '../i18n/index.ts';
import type { ForgeErrorInfo } from '../types.ts';

export type ErrorBannerTone = 'destructive' | 'warning' | 'info';

export interface ErrorBannerModel {
  /** 第一行：结论（已含归因；原文另行拼接在其后） */
  title: string;
  /** 第一行冒号后的原始错误原文（可能为空——有结论就够读了） */
  raw: string;
  /** 第二行：解释 */
  detail: string;
  tone: ErrorBannerTone;
  /** 是否给「立即重试」：仅分类器判定可重试时为真 */
  showRetry: boolean;
}

/** provider 名可用的场景下带进结论句，让归因具体到“谁” */
export interface ErrorBannerContext {
  /** 当前模型所属 provider 的展示名（如 MiniMax），未知则不传 */
  providerName?: string;
}

const TONE_BY_CATEGORY: Record<ForgeErrorInfo['category'], ErrorBannerTone> = {
  auth: 'destructive',
  quota: 'destructive',
  context: 'destructive',
  'local-env': 'destructive',
  'rate-limit': 'warning',
  busy: 'warning',
  provider: 'warning',
  network: 'warning',
  unknown: 'warning',
};

function t(key: MessageKey, params?: Record<string, string | number>): string {
  return i18n.t(key, params);
}

/** provider 归因句：带名字时更具体（“模型服务（MiniMax）出错了”），否则用泛称 */
function providerSubject(ctx: ErrorBannerContext): string {
  return ctx.providerName !== undefined && ctx.providerName !== ''
    ? t('chat.errorSubjectProviderNamed', { name: ctx.providerName })
    : t('chat.errorSubjectProvider');
}

/** 把分类结果映射为横幅展示模型。纯函数（i18n 除外），无副作用 */
export function toErrorBannerModel(
  error: ForgeErrorInfo,
  ctx: ErrorBannerContext = {},
): ErrorBannerModel {
  // 降级优先于分类：内容已经完整输出时，任何分类都不该用报错语气
  if (error.degraded) {
    return {
      title: t('chat.errorTitleDegraded'),
      raw: error.raw,
      detail: t('chat.errorDetailDegraded'),
      tone: 'info',
      showRetry: false,
    };
  }

  switch (error.category) {
    case 'auth':
      return {
        title: t('chat.errorTitleAuth'),
        raw: error.raw,
        detail: t('chat.errorDetailAuth'),
        tone: TONE_BY_CATEGORY.auth,
        showRetry: false,
      };
    case 'quota':
      return {
        title: t('chat.errorTitleQuota'),
        raw: error.raw,
        detail: t('chat.errorDetailQuota'),
        tone: TONE_BY_CATEGORY.quota,
        showRetry: false,
      };
    case 'context':
      return {
        title: t('chat.errorTitleContext'),
        raw: error.raw,
        detail: t('chat.errorDetailContext'),
        tone: TONE_BY_CATEGORY.context,
        showRetry: false,
      };
    case 'local-env':
      return {
        title: t('chat.errorTitleLocalEnv'),
        raw: error.raw,
        detail: t('chat.errorDetailLocalEnv'),
        tone: TONE_BY_CATEGORY['local-env'],
        showRetry: false,
      };
    case 'busy':
      return {
        title: t('chat.errorTitleBusy'),
        raw: error.raw,
        detail: t('chat.errorDetailBusy'),
        tone: TONE_BY_CATEGORY.busy,
        showRetry: error.retryable,
      };
    case 'rate-limit':
      return {
        title: t('chat.errorTitleRateLimit', { subject: providerSubject(ctx) }),
        raw: error.raw,
        detail: t('chat.errorDetailRateLimit'),
        tone: TONE_BY_CATEGORY['rate-limit'],
        showRetry: error.retryable,
      };
    case 'network':
      return {
        title: t('chat.errorTitleNetwork'),
        raw: error.raw,
        detail: t('chat.errorDetailNetwork'),
        tone: TONE_BY_CATEGORY.network,
        showRetry: error.retryable,
      };
    case 'provider':
      return {
        title: t('chat.errorTitleProvider', { subject: providerSubject(ctx) }),
        raw: error.raw,
        detail: t('chat.errorDetailProvider'),
        tone: TONE_BY_CATEGORY.provider,
        showRetry: error.retryable,
      };
    case 'unknown':
    default:
      return {
        title: t('chat.errorTitleUnknown'),
        raw: error.raw,
        detail: t('chat.errorDetailUnknown'),
        tone: TONE_BY_CATEGORY.unknown,
        showRetry: error.retryable,
      };
  }
}
