/**
 * goal 状态的展示解析（纯函数，可单测）。
 *
 * 数据源是 pi-goal 的 `ctx.ui.setStatus("goal", <紧凑状态串>)`（runtime.ts:1392
 * `formatStatus`），形如：
 * - `active 3m · automatic 12/25`
 * - `active 18k/100k · automatic 12/25`      （带 token 预算）
 * - `active 3m · automatic Unlimited`         （显式无限）
 * - `waiting review monitor · automatic 12/25`
 * - `paused · automatic limit 25/25`
 * - `paused · automatic 12/25`
 * - `blocked · automatic 12/25`
 * - `usage · automatic 12/25`
 * - `budget 100k/100k · automatic 12/25`
 * - `complete`
 *
 * 解析而非二次拼装的理由：格式由 pi-goal 定义，改版时会变；自己拼一套必然漂移。
 * 这里只做「拆出可高亮的片段」，语义仍以 pi-goal 的原文为准。
 */

export type GoalVisualState =
  | 'active'
  | 'waiting'
  | 'paused'
  | 'blocked'
  | 'usage'
  | 'budget'
  | 'complete'
  | 'unknown';

export interface GoalBadgeView {
  /** 徽标主文案（状态词，已本地化） */
  label: string;
  /** 视觉档位：决定配色与徽标形态 */
  state: GoalVisualState;
  /** 已自动轮次（数字）；解析不出为 null */
  usedTurns: number | null;
  /** 轮次上限；`Unlimited` 时为 null */
  limitTurns: number | null;
  /** 是否为无限轮次模式 */
  unlimited: boolean;
  /** 轮次展示文本，如 `12/25` 或 `12/∞` */
  turnLabel: string;
  /** token 用量文本（仅 budget 形态有），如 `100k/100k` */
  budgetLabel: string | null;
  /** 等待原因（仅 waiting 形态有；pi-goal 已做 sanitize + 截断） */
  waitingReason: string | null;
  /** pi-goal 原文（悬浮提示用，避免二次加工丢失信息） */
  raw: string;
}

/** `·` 分隔符两侧可有空白，统一裁剪。 */
function splitSegments(text: string): string[] {
  return text
    .split('·')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

/**
 * 取 `automatic 12/25` / `automatic Unlimited` 里的数字部分。
 *
 * 注意两种形态的结构差异（pi-goal runtime.ts:1398）：
 * - 有限上限：`automatic 12/25` —— 有已用数 + `/` + 上限
 * - Unlimited：`automatic Unlimited` —— **裸词，既无已用数也无斜杠**
 * 故必须先判 Unlimited，不能指望 `(\d+)` 前缀把它匹配进来。
 */
function parseAutomatic(segment: string): { used: number | null; limit: number | null; unlimited: boolean } {
  if (/^automatic\s+Unlimited$/i.test(segment)) {
    return { used: null, limit: null, unlimited: true };
  }
  const match = /^automatic\s+(\d+)\s*\/\s*(.+)$/.exec(segment);
  if (match === null) {
    return { used: null, limit: null, unlimited: false };
  }
  const used = Number.parseInt(match[1]!, 10);
  const limitRaw = match[2]!;
  if (limitRaw === 'Unlimited') {
    return { used, limit: null, unlimited: true };
  }
  const limit = Number.parseInt(limitRaw, 10);
  return {
    used,
    limit: Number.isFinite(limit) ? limit : null,
    unlimited: false,
  };
}

/** pi-goal 的 token 格式化用 k/m 后缀（`formatTokenCount`，runtime.ts accounting.ts）。 */
const TOKEN_BUDGET_RE = /^(\d+(?:\.\d+)?)\s*([km])?\s*\/\s*(\d+(?:\.\d+)?)\s*([km])?$/i;

/**
 * 判定 `active` 后的形态是「token 预算」还是「耗时」。
 *
 * pi-goal 两种形态都可能带单位：`active 18k/100k`（token 预算）与 `active 3m`（耗时）。
 * 判据用**带 k/m 后缀的数值对**而不是裸数字：`3m` 不含 `/`，天然排除；
 * `1.5m/2m` 这类小数预算也能识别。
 */
function parseTokenBudget(rest: string): string | null {
  return TOKEN_BUDGET_RE.test(rest) ? rest : null;
}

/**
 * 解析 pi-goal 的状态串。
 *
 * 空串 / null（清除徽标）返回 null——UI 据此隐藏徽标。
 * 无法识别的形态返回 `state: 'unknown'` 并原样展示 raw，
 * **不猜测**语义：pi-goal 改版时宁可显示原文，也不要给用户一个错的进度。
 */
export function parseGoalStatus(text: string | null | undefined): GoalBadgeView | null {
  if (text === null || text === undefined) return null;
  const raw = text.trim();
  if (raw === '') return null;

  // complete 是唯一没有 `·` 分段的形态
  if (raw === 'complete') {
    return {
      label: '已完成',
      state: 'complete',
      usedTurns: null,
      limitTurns: null,
      unlimited: false,
      turnLabel: '',
      budgetLabel: null,
      waitingReason: null,
      raw,
    };
  }

  const segments = splitSegments(raw);
  const head = segments[0] ?? raw;
  const tail = segments.slice(1);
  const automaticSegment = tail.find((part) => part.startsWith('automatic'));

  // `paused · automatic limit 25/25` 的形态（runtime.ts:1408）里，上限数字跟在
  // `automatic limit` 之后而不在 `automatic <used>/<limit>` 的位置上——用另一条正则取。
  let { used, limit, unlimited } = parseAutomatic(automaticSegment ?? '');
  if (used === null && automaticSegment !== undefined) {
    const limitOnly = /^automatic\s+limit\s+(\d+)\s*\/\s*(\d+)$/.exec(automaticSegment);
    if (limitOnly !== null) {
      used = Number.parseInt(limitOnly[1]!, 10);
      limit = Number.parseInt(limitOnly[2]!, 10);
    }
  }

  // pi-goal 的 Unlimited 形态是裸的 `automatic Unlimited`，**不带已用轮数**
  // （runtime.ts:1398：只有有限上限才拼 `${used}/${limit}`）。故此时 turnLabel
  // 只能给「∞」——不能把缺失的 used 渲染成 `null/∞` 或 `/∞`。
  const turnLabel = used === null
    ? unlimited
      ? '∞'
      : ''
    : unlimited
      ? `${used}/∞`
      : limit === null
        ? String(used)
        : `${used}/${limit}`;

  // head 形态：`active [3m | 18k/100k]` / `waiting <reason>` / `paused [· ...]` / `blocked` / `usage` / `budget 100k/100k`
  if (head.startsWith('waiting')) {
    return {
      label: '等待中',
      state: 'waiting',
      usedTurns: used,
      limitTurns: limit,
      unlimited,
      turnLabel,
      budgetLabel: null,
      // `waiting review monitor` → reason = `review monitor`；`waiting · automatic…` → 空
      waitingReason: head.slice('waiting'.length).trim() || null,
      raw,
    };
  }

  if (head.startsWith('paused')) {
    return {
      label: '已暂停',
      state: 'paused',
      usedTurns: used,
      limitTurns: limit,
      unlimited,
      turnLabel,
      budgetLabel: null,
      waitingReason: null,
      raw,
    };
  }

  if (head.startsWith('blocked')) {
    return {
      label: '受阻',
      state: 'blocked',
      usedTurns: used,
      limitTurns: limit,
      unlimited,
      turnLabel,
      budgetLabel: null,
      waitingReason: null,
      raw,
    };
  }

  if (head.startsWith('usage')) {
    return {
      label: '额度用尽',
      state: 'usage',
      usedTurns: used,
      limitTurns: limit,
      unlimited,
      turnLabel,
      budgetLabel: null,
      waitingReason: null,
      raw,
    };
  }

  if (head.startsWith('budget')) {
    return {
      label: '预算用尽',
      state: 'budget',
      usedTurns: used,
      limitTurns: limit,
      unlimited,
      turnLabel,
      // `budget 100k/100k` → `100k/100k`
      budgetLabel: head.slice('budget'.length).trim() || null,
      waitingReason: null,
      raw,
    };
  }

  if (head.startsWith('active')) {
    const rest = head.slice('active'.length).trim();
    return {
      label: '进行中',
      state: 'active',
      usedTurns: used,
      limitTurns: limit,
      unlimited,
      turnLabel,
      // `active 18k/100k` 是 token 预算形态；`active 3m` 是耗时形态。
      budgetLabel: parseTokenBudget(rest),
      waitingReason: null,
      raw,
    };
  }

  // 未知形态：原样展示，不猜测
  return {
    label: raw,
    state: 'unknown',
    usedTurns: used,
    limitTurns: limit,
    unlimited,
    turnLabel,
    budgetLabel: null,
    waitingReason: null,
    raw,
  };}

/**
 * 是否为「用户需要介入」的终局（UI 决定是否强调提示）。
 *
 * 与 `@forge/extensions` 的 `isGoalNeedsUser` 同语义，但判定输入是**状态串**
 * （UI 侧拿不到 GoalStatePayload，只有这个），故独立实现一份纯函数版本。
 */
export function goalStateNeedsUser(view: GoalBadgeView | null): boolean {
  if (view === null) return false;
  return view.state === 'blocked' || view.state === 'usage' || view.state === 'budget';
}
