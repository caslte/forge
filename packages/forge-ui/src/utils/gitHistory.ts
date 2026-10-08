/**
 * CE-S11 Git 提交历史 · 纯逻辑（PRD 12 §3.7）。
 *
 * 只放无副作用的纯函数，供 CodeTreePanel 历史视图与单测共用：
 * 头像派生 / 列表筛选 / 日期分组。取数与缓存编排不在这里（见 composables/useGitHistory.ts）。
 */

/** 头像派生结果：首字母 + 色相 */
export interface AvatarInfo {
  /** 首字母：中西文统一取**首字** */
  initial: string;
  /** 0~359 的整数色相，直接喂给 oklch */
  hue: number;
}

/**
 * email → 稳定色相。
 *
 * 纯本地派生、**零网络请求**（不引 gravatar：桌面应用常离线，且提交邮箱属隐私）。
 * 用 31 进制滚动哈希而不是 `hashCode & 0xff` 一类窄映射——后者会把不同 email
 * 压到同一档，视觉区分度不够。
 */
function hueOf(email: string): number {
  let h = 0;
  for (let i = 0; i < email.length; i++) {
    h = (h * 31 + email.charCodeAt(i)) % 360;
  }
  return h;
}

/**
 * 头像：首字母 + 色相。
 *
 * **首字而非末字**（原型实测的反例）：中文姓氏的辨识度远高于名——取末字会让
 * 「王工」「李工」双双渲染成「工」，两个人在列表里长得完全一样，恰好毁掉
 * 「同一作者的提交视觉成串」这个设计意图。中西文统一取 `name[0]`。
 */
export function avatarOf(name: string, email: string): AvatarInfo {
  const n = (name ?? '').trim();
  // toUpperCase 对 CJK 是恒等操作，中西文可共用一条路径
  return { initial: n.charAt(0).toUpperCase(), hue: hueOf(email ?? '') };
}

/** 筛选所需的最小提交字段（结构化子集，便于单测构造） */
export interface FilterableCommit {
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
}

/**
 * 按关键词过滤**已加载**的提交：说明 / 作者姓名 / email / 短 SHA 任一命中即保留。
 *
 * 只过滤已加载列表（不上服务端）——历史面板首屏 100 条，深翻页是懒加载，
 * 全量检索是另一个需求（PRD §3.7.4 明确本期不做）。
 * 空查询等价全量：不是「匹配空串得 0 条」。
 */
export function filterCommits<T extends FilterableCommit>(commits: T[], query: string): T[] {
  const q = (query ?? '').trim().toLowerCase();
  if (q === '') return commits;
  return commits.filter((c) =>
    (c.subject ?? '').toLowerCase().includes(q) ||
    (c.authorName ?? '').toLowerCase().includes(q) ||
    (c.authorEmail ?? '').toLowerCase().includes(q) ||
    (c.shortSha ?? '').toLowerCase().includes(q),
  );
}

const DAY_MS = 86_400_000;

/**
 * 契约：入参是 **epoch 秒**（git `%at`，见 api/11 §6），
 * 不是 JS 的毫秒。直接 new Date(秒) 会得到 1970 年——已踩过，
 * 所以统一在这里转毫秒，调用方一律传秒。
 */
function msOf(timestampSeconds: number): number {
  return timestampSeconds * 1000;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 日期标签：今天 / 昨天 / M 月 D 日（跨年补年份）。
 *
 * 未来时间戳（后端时钟超前）归到「今天」而不是产生「明天」这类不存在的标签。
 */
export function dayLabel(timestampSeconds: number, nowSeconds: number): string {
  const d = new Date(msOf(timestampSeconds));
  const t = new Date(msOf(nowSeconds));
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(t) - startOf(d)) / DAY_MS);
  if (diffDays <= 0) return '今天';
  if (diffDays === 1) return '昨天';
  const md = `${d.getMonth() + 1} 月 ${d.getDate()} 日`;
  return d.getFullYear() === t.getFullYear() ? md : `${d.getFullYear()} 年 ${md}`;
}

/** 按天分组的结果 */
export interface DayGroup<T> {
  label: string;
  commits: T[];
}

/**
 * 提交列表按天分组，**保持传入顺序**（上游已是时间倒序，组内顺序不应被重排）。
 *
 * 为什么要有分组条：Zed 没有这个设计，但 forge 的提交密度高（当天多条），
 * 没有分隔条时列表会读成一条平铺的灰带，扫不出「这段是今天的」。
 */
export function groupCommitsByDay<T extends { authoredAt: number }>(
  commits: T[],
  nowSeconds: number,
): Array<DayGroup<T>> {
  const out: Array<DayGroup<T>> = [];
  let currentLabel: string | null = null;
  for (const c of commits) {
    const label = dayLabel(c.authoredAt, nowSeconds);
    if (label !== currentLabel) {
      currentLabel = label;
      out.push({ label, commits: [] });
    }
    out[out.length - 1]!.commits.push(c);
  }
  return out;
}

/** 相对时间（列表行展示）。入参均为 epoch **秒**。 */
export function relativeTimeOf(timestampSeconds: number, nowSeconds: number): string {
  const now = msOf(nowSeconds);
  const diff = now - msOf(timestampSeconds);
  const MIN = 60_000;
  const HOUR = 60 * MIN;
  if (diff < MIN) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MIN)} 分钟前`;
  if (diff < DAY_MS) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 30 * DAY_MS) return `${Math.floor(diff / DAY_MS)} 天前`;
  const d = new Date(msOf(timestampSeconds));
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

/** 绝对时间（详情头部）：本地时区、零填充。入参为 epoch **秒**。 */
export function absoluteTimeOf(timestampSeconds: number): string {
  const d = new Date(msOf(timestampSeconds));
  return (
    `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}