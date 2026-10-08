/**
 * CE-S11 Git 提交历史 · 纯逻辑（PRD 12 §3.7）。
 *
 * 只放无副作用的纯函数，供 CodeTreePanel 历史视图与单测共用：
 * 头像派生 / 列表筛选 / 日期分组 / 时间文案。取数与缓存编排不在这里
 *（见 composables/useGitHistory.ts）。
 *
 * **时间文案一律「返回 i18n key + 参数」**（2026-10-08 修正，原实现硬编码中文）：
 * 组件模板必须用 `t(spec.key, spec.params)` 渲染，否则切 en 时
 * 「今天 / 3 小时前」整片不变。两个 `*Of()` 成串出口只留给单测与日志。
 */
import { relativeTimeParts } from './sessionView.ts';
// type-only：只借 MessageKey 做键的类型约束，运行时不引入 vue（见 LabelSpec 注释）。
import type { MessageKey } from '../i18n/index.ts';

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
 * 一条待本地化的文案：i18n key + 插值参数。
 *
 * `key` 用 `MessageKey` 约束而不是裸 string：新增时间文案时若忘了在
 * `i18n/domains/code.ts` 落字典，typecheck 就会红，而不是运行时才发现
 * 界面回退成键名。**type-only 导入**，不会把 vue 拖进纯逻辑层。
 */
export interface LabelSpec {
  key: MessageKey;
  params?: Record<string, string | number>;
}

/**
 * 纯逻辑层自用的最小字典（**只覆盖 zh-CN**）。
 *
 * 为什么不直接 import 应用字典：`utils/` 是无 Vue 依赖的纯模块，
 * 而 `i18n/domains/code.ts` 会经 `i18n/index.ts` 引入 `vue`——在 node:test
 * 里加载这个工具函数会连带拖进 Vue 运行时。
 *
 * 存在的意义是让 `dayLabel()` / `relativeTimeOf()` 这两个「成串」出口继续存在
 * （单测与日志需要），同时**组件模板一律走 `t()`**，语言切换即时生效。
 * 两份字面量必须与 `i18n/domains/code.ts` 保持一致，改一处要改两处。
 */
const ZH_LABELS: Record<string, string> = {
  'code.historyDayToday': '今天',
  'code.historyDayYesterday': '昨天',
  'code.historyDayMonthDay': '{month} 月 {day} 日',
  'code.historyDayFull': '{year} 年 {month} 月 {day} 日',
  'code.historyTimeJustNow': '刚刚',
  'code.historyTimeMinutes': '{count} 分钟前',
  'code.historyTimeHours': '{count} 小时前',
  'code.historyTimeDays': '{count} 天前',
  'code.historyTimeMonthDay': '{month} 月 {day} 日',
  'code.historyTimeFull': '{year}/{month}/{day}',
};

/** 按 {name} 插值；字典缺 key 时回退成 key 本身（与 i18n 层同口径，不静默空白）。 */
function formatLabel(spec: LabelSpec, dict: Record<string, string>): string {
  const text = dict[spec.key] ?? spec.key;
  if (!spec.params) return text;
  return text.replace(/\{(\w+)\}/g, (m, name: string) =>
    name in spec.params! ? String(spec.params![name]) : m,
  );
}

/**
 * 日期标签：今天 / 昨天 / M 月 D 日（跨年补年份）。
 *
 * **返回 i18n key 而非成串**（2026-10-08 修正）：原实现硬编码中文，
 * 切到 en 时日期分隔条整片不变——与 AC-CE-031「i18n 无硬编码文案」相抵。
 * 分档口径（今天/昨天/具体日期）与文案无关，留在本函数；具体措辞交给字典。
 *
 * 未来时间戳（后端时钟超前）归到「今天」而不是产生「明天」这类不存在的标签。
 */
export function dayLabelSpec(timestampSeconds: number, nowSeconds: number): LabelSpec {
  const d = new Date(msOf(timestampSeconds));
  const t = new Date(msOf(nowSeconds));
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(t) - startOf(d)) / DAY_MS);
  if (diffDays <= 0) return { key: 'code.historyDayToday' };
  if (diffDays === 1) return { key: 'code.historyDayYesterday' };
  // 跨年补年份：同年只显示月日，字典用 {year} 决定是否留空
  return {
    key: d.getFullYear() === t.getFullYear() ? 'code.historyDayMonthDay' : 'code.historyDayFull',
    params: { year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() },
  };
}

/**
 * 日期标签的**已本地化**成串（默认 zh-CN 口径）。
 *
 * 只给纯逻辑层与单测用；组件模板里请走 `t(dayLabelSpec(...).key, ...)`，
 * 否则又会在模板里写死一种语言。
 */
export function dayLabel(timestampSeconds: number, nowSeconds: number): string {
  return formatLabel(dayLabelSpec(timestampSeconds, nowSeconds), ZH_LABELS);
}

/** 按天分组的结果。label 是 spec——组件用 `t()` 渲染，不要当字符串用。 */
export interface DayGroup<T> {
  label: LabelSpec;
  commits: T[];
}

/**
 * 提交列表按天分组，**保持传入顺序**（上游已是时间倒序，组内顺序不应被重排）。
 *
 * 为什么要有分组条：Zed 没有这个设计，但 forge 的提交密度高（当天多条），
 * 没有分隔条时列表会读成一条平铺的灰带，扫不出「这段是今天的」。
 *
 * 分组键取 **spec 的 key + 参数**（而非本地化成串）：跨语言下同一天仍然同组，
 * 且「今天 / 昨天」跨档时 key 天然不同，不必再比字符串。
 */
export function groupCommitsByDay<T extends { authoredAt: number }>(
  commits: T[],
  nowSeconds: number,
): Array<DayGroup<T>> {
  const out: Array<DayGroup<T>> = [];
  let currentKey: string | null = null;
  for (const c of commits) {
    const label = dayLabelSpec(c.authoredAt, nowSeconds);
    const groupKey = `${label.key}:${JSON.stringify(label.params ?? {})}`;
    if (groupKey !== currentKey) {
      currentKey = groupKey;
      out.push({ label, commits: [] });
    }
    out[out.length - 1]!.commits.push(c);
  }
  return out;
}

/**
 * 相对时间（列表行展示）。入参均为 epoch **秒**。
 *
 * **复用 `relativeTimeParts` 的分档**（PRD 12 §3.7 要求）——历史视图与会话树
 * 的「3 小时前 / 3h」是同一语义，不该有两套档位边界。此处只做
 * 秒→毫秒 + ISO 的入参转换，再把 parts 转成 `LabelSpec` 交给字典拼装。
 *
 * 与 `project.time*` 的差别：历史视图给提交时间额外保留了「前 / ago」的语感，
 * 因此用自己的 key（`code.historyTime*`）而非直接用 project 域的。
 */
export function relativeTimeSpec(timestampSeconds: number, nowSeconds: number): LabelSpec {
  const parts = relativeTimeParts(new Date(msOf(timestampSeconds)).toISOString(), msOf(nowSeconds));
  if (!parts) return { key: 'code.historyTimeJustNow' };
  switch (parts.key) {
    case 'project.timeJustNow':
      return { key: 'code.historyTimeJustNow' };
    case 'project.timeMonthDay':
      return { key: 'code.historyTimeMonthDay', params: { month: parts.month, day: parts.day } };
    case 'project.timeFull':
      return { key: 'code.historyTimeFull', params: { year: parts.year, month: parts.month, day: parts.day } };
    // 三档计数：显式列举而非 replace 拼串——`project.timeHours` 直接替换会
    // 拼出 `code.historyTimetimeHours` 这种错 key，且字典缺键只在运行时露出来。
    case 'project.timeMinutes':
      return { key: 'code.historyTimeMinutes', params: { count: parts.count } };
    case 'project.timeHours':
      return { key: 'code.historyTimeHours', params: { count: parts.count } };
    case 'project.timeDays':
      return { key: 'code.historyTimeDays', params: { count: parts.count } };
    default:
      return { key: 'code.historyTimeJustNow' };
  }
}

/**
 * 相对时间的**已本地化**成串（默认 zh-CN 口径），仅供纯逻辑层与单测。
 * 组件模板里请走 `t(relativeTimeSpec(...).key, ...)`。
 */
export function relativeTimeOf(timestampSeconds: number, nowSeconds: number): string {
  return formatLabel(relativeTimeSpec(timestampSeconds, nowSeconds), ZH_LABELS);
}

/** 绝对时间（详情头部）：本地时区、零填充。入参为 epoch **秒**。 */
export function absoluteTimeOf(timestampSeconds: number): string {
  const d = new Date(msOf(timestampSeconds));
  return (
    `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ` +
    `${pad2(d.getHours())}:${pad2(d.getMinutes())}`
  );
}