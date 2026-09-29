/**
 * 对话错误分类器（CV-ERR-01）
 *
 * 目标：把 provider / 网络 / 本机 / 配置各类原始错误收敛成**一个结构化**结论，
 * 让 UI 能回答三个问题——发生了什么、是谁的锅、重试有没有用。
 *
 * 设计约束（与 prototypes/error-banner-variants.html 定稿一致）：
 * 1. `raw` 原文永不丢失、永不被加工：分类只读不改，UI 把它跟在结论句冒号后原样展示。
 * 2. 分类是**纯函数**、无 IO、可表驱动测试：规则表就是实现，新增 provider 错误码只改一处。
 * 3. 归因（source）与可重试（retryable）分开表达：「不是 forge 的锅」是 source 的职责，
 *    「点一下会不会好」是 retryable 的职责，两者互不推导。
 * 4. `degraded`（本轮已有可见内容、只是收尾报错）单独标记：这类的 UI 语气必须最轻，
 *    否则用户会把「回复已完整」误读成「forge 断了」，这是最伤信任的一类。
 */

/** 错误分类：UI 依此选色调与结论句 */
export type ForgeErrorCategory =
  | 'auth' // 凭据缺失/无效 —— 你的配置
  | 'quota' // 余额/额度耗尽 —— 你的账户
  | 'context' // 上下文超限 —— 这个会话
  | 'local-env' // 本机缺依赖/命令 —— 你的机器
  | 'rate-limit' // 限流 —— 模型服务
  | 'busy' // 上一轮还在跑（并发撞车）—— 会话状态
  | 'provider' // 服务商 5xx/内部错误/流尾错误 —— 模型服务
  | 'network' // 连不上 —— 本机网络
  | 'unknown'; // 兜底：未判定

/** 归因：谁的锅。UI 写进结论句（「模型服务（MiniMax）出错了」「本机找不到 git」） */
export type ForgeErrorSource =
  | 'user-config'
  | 'user-account'
  | 'session-state'
  | 'host-environment'
  | 'model-provider'
  | 'local-network'
  | 'undetermined';

/** 分类结果 */
export interface ClassifiedError {
  category: ForgeErrorCategory;
  source: ForgeErrorSource;
  /** provider / 底层原始错误文本，原样透传，永不加工 */
  raw: string;
  /** 重试是否可能成功：UI 据此决定是否给「立即重试」 */
  retryable: boolean;
  /** 本轮已产出可见内容、仅收尾报错：UI 降级为最轻的语气 */
  degraded: boolean;
  /** HTTP 状态码（能取到时） */
  httpStatus?: number;
  /** provider 侧错误码（能取到时，如 1000 / rate_limit_error） */
  providerCode?: string;
}

/** 分类上下文：分类器自身无法得知的信息由调用方提供 */
export interface ClassifyErrorContext {
  /** 已知 HTTP 状态码；缺省时尝试从原文里解析 */
  httpStatus?: number;
  /** 已知 provider 错误码；缺省时尝试从原文里解析 */
  providerCode?: string;
  /** 本轮是否已产出可见内容（thinking/text/工具结果） */
  hasVisibleContent?: boolean;
}

interface Rule {
  category: ForgeErrorCategory;
  source: ForgeErrorSource;
  retryable: boolean;
  test: RegExp;
}

/**
 * 规则表。顺序即优先级：先判「用户自己的问题」（更具体、可操作），
 * 再判「服务商/网络」（更宽泛），兜底 unknown。
 * 新增 provider 错误码只在此表追加一行。
 */
const RULES: Rule[] = [
  {
    category: 'local-env',
    source: 'host-environment',
    retryable: false,
    // spawn ENOENT / EACCES / command not found：工具阶段根本没跑起来
    test: /\bspawn\s+\S+\s+(ENOENT|EACCES)\b|\bENOENT\b|\bEACCES\b|command not found|不是内部或外部命令|is not recognized as an internal or external command/i,
  },
  {
    category: 'context',
    source: 'session-state',
    retryable: false,
    test: /context_length_exceeded|maximum context length|context window (?:is|exceeded)|too many tokens|上下文.{0,4}(?:超|溢出|过长)/i,
  },
  {
    category: 'auth',
    source: 'user-config',
    retryable: false,
    // 含 pi 自身的 "No API key found"（provider 未配置）与 401/invalid key
    test: /no api key found|invalid[_\s-]?api[_\s-]?key|incorrect api key|authentication[_\s-]?error|\bunauthorized\b|\b401\b|api[_\s-]?key.{0,20}(?:missing|not found|invalid)/i,
  },
  {
    category: 'quota',
    source: 'user-account',
    retryable: false,
    test: /insufficient[_\s-]?(?:balance|quota|credit)|billing|arrears?|exceeded your current quota|账户余额|余额不足|\b402\b|payment required/i,
  },
  {
    category: 'busy',
    source: 'session-state',
    retryable: true,
    // pi 拒绝并发轮次：上一轮还在跑（adapter 会先 abort 掉僵尸轮，所以重发有意义）
    test: /already processing|上一轮任务仍在后台执行/i,
  },
  {
    category: 'rate-limit',
    source: 'model-provider',
    retryable: true,
    test: /rate[_\s-]?limit|too many requests|\b429\b|请求过于频繁|限流/i,
  },
  {
    category: 'network',
    source: 'local-network',
    retryable: true,
    test: /\bENOTFOUND\b|\bECONNREFUSED\b|\bECONNRESET\b|\bETIMEDOUT\b|\bEAI_AGAIN\b|\bEPIPE\b|socket hang up|fetch failed|api[_\s]?connection[_\s-]?error|connection error|network error|getaddrinfo/i,
  },
  {
    category: 'provider',
    source: 'model-provider',
    retryable: true,
    // 5xx / 网关 / 上游内部错误 / 流内未知错误帧（含 MiniMax 的 "unknown error, NNN (1000)"）
    // 以及 OpenRouter 把上游错误**注入 SSE 流**的三种原文（真机 2026-09-29 stealth/space-bunny-alpha）：
    //   - "JSON error injected into SSE stream"（流被注入 JSON 错误帧）
    //   - "Provider returned an empty response"（上游返回空补全，OpenRouter 错误码 1001）
    //   - "Stream ended without finish_reason"（流提前断开）
    test: /\b5\d\d\b|internal (?:server )?error|unknown error|bad gateway|service unavailable|gateway timeout|upstream[_\s-]?error|overloaded|server_error|api_error|error code:?\s*\d+|json error injected into sse stream|provider returned an empty response|stream ended without finish_reason/i,
  },
];

/** 从原文里取 HTTP 状态码：`401 ...` / `HTTP 429` / `status: 500` */
function extractHttpStatus(raw: string): number | undefined {
  const m =
    raw.match(/\b(?:http|status(?:\s*code)?)\D{0,3}(\d{3})\b/i) ??
    raw.match(/(?:^|\s)(\d{3})\s*(?:error|:\s)/i);
  if (m === null) return undefined;
  const code = Number(m[1]);
  return Number.isInteger(code) && code >= 100 && code <= 599 ? code : undefined;
}

/** 从原文里取 provider 错误码：
 *  `rate_limit_error`（具名） → `1000`（括号尾码，MiniMax 式） → `1008`（行首数字） */
function extractProviderCode(raw: string): string | undefined {
  const m =
    raw.match(/\b([a-z][a-z0-9_]*_error)\b/i) ?? // rate_limit_error / server_error / api_error
    raw.match(/\(([0-9]{3,5})\)\s*$/) ?? // unknown error, 722 (1000)
    raw.match(/\berror(?:\s*code)?\D{0,3}([0-9]{3,5})\b/i) ??
    raw.match(/(?:^|\s)([0-9]{3,5})\s+[a-z_]+/i) ?? // 1008 insufficient balance
    raw.match(/\b([0-9]{3,5})\b(?=\s*$)/); // 尾部裸码
  return m?.[1];
}

/** HTTP 状态码 → 分类/归因/可重试。仅列有确定语义的码 */
function classifyByHttpStatus(httpStatus: number): Pick<ClassifiedError, 'category' | 'source' | 'retryable'> | undefined {
  if (httpStatus === 401 || httpStatus === 403) {
    return { category: 'auth', source: 'user-config', retryable: false };
  }
  if (httpStatus === 402) {
    return { category: 'quota', source: 'user-account', retryable: false };
  }
  if (httpStatus === 429) {
    return { category: 'rate-limit', source: 'model-provider', retryable: true };
  }
  if (httpStatus >= 500) {
    return { category: 'provider', source: 'model-provider', retryable: true };
  }
  return undefined;
}

/**
 * 分类入口。
 *
 * @param raw provider / 底层原始错误文本（空串按 unknown 处理，raw 归一为原值）
 * @param ctx 分类器无法自行得知的上下文（HTTP 码、provider 码、本轮是否已有内容）
 * @returns 分类结果；**不抛异常**（分类失败必须降级为 unknown，不能把错误处理本身变成故障）
 */
export function classifyError(raw: string, ctx: ClassifyErrorContext = {}): ClassifiedError {
  const text = typeof raw === 'string' ? raw : String(raw);
  const haystack = text.toLowerCase();

  const matched = RULES.find((r) => r.test.test(haystack));
  const httpStatus = ctx.httpStatus ?? extractHttpStatus(text);

  // 状态码兜底：正文未命中规则时直接用；正文只给出「泛化」描述（provider/network 类）
  // 而状态码更具体时（401 盖过 unknown error、429 盖过 5xx）以状态码为准。
  // 但正文明确说的是本机/上下文/凭据（local-env/context/auth/quota）时以正文为准 ——
  // 那类错误往往没有 HTTP 语义（spawn 失败、上下文超限），状态码不能推翻。
  const byStatus = httpStatus !== undefined ? classifyByHttpStatus(httpStatus) : undefined;
  const isVague =
    matched === undefined ||
    matched.category === 'provider' ||
    matched.category === 'network' ||
    matched.category === 'rate-limit' ||
    matched.category === 'unknown';

  const category = byStatus !== undefined && isVague ? byStatus.category : matched?.category;
  const source = byStatus !== undefined && isVague ? byStatus.source : matched?.source;
  const retryable = byStatus !== undefined && isVague ? byStatus.retryable : matched?.retryable;
  const providerCode = ctx.providerCode ?? extractProviderCode(text);

  const result: ClassifiedError = {
    category: category ?? 'unknown',
    source: source ?? 'undetermined',
    raw: text,
    // 未识别按可重试处理：未知错误多半是 provider 的瞬时怪象，先让用户能试一次
    retryable: retryable ?? true,
    degraded: (ctx.hasVisibleContent ?? false) && (category ?? 'unknown') === 'provider',
    ...(httpStatus !== undefined ? { httpStatus } : {}),
    ...(providerCode !== undefined ? { providerCode } : {}),
  };
  return result;
}
