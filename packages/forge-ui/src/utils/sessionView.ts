/**
 * 会话列表视图纯函数（SM-S06 双视角共用，docs/prd/02_session_management.md）。
 *
 * 项目视角（按项目分组）与任务视角（平摊全部会话）的排序、
 * 收起/展开全部两态判定、任务视角行尾项目 tag、行尾相对活跃时间都收敛在这里，
 * 便于单测（U-SM-005）并保证两视角规则一致。
 */
import type { ProjectItem, SessionItem } from '../types';

/**
 * 按激活序排序：激活过的在前（运行中会话进入激活序即置顶，完成后保留位置，
 * 语义由调用方维护 activatedOrder），从未激活的保持后端原序（Array.sort 稳定）。
 */
export function sortSessionsByActivation(
  sessions: SessionItem[],
  activatedOrder: string[],
): SessionItem[] {
  const rank = (id: string): number => {
    const i = activatedOrder.indexOf(id);
    return i === -1 ? Number.MAX_SAFE_INTEGER : i;
  };
  return [...sessions].sort((a, b) => rank(a.sessionId) - rank(b.sessionId));
}

/**
 * 收起/展开全部两态判定：存在任一展开项目 → 'collapse'（收起全部）；
 * 全部已折叠（含空列表，无项目可收起）→ 'expand'（展开全部）。
 */
export function nextFoldAllAction(paths: string[], collapsed: Set<string>): 'collapse' | 'expand' {
  return paths.some((p) => !collapsed.has(p)) ? 'collapse' : 'expand';
}

/** 任务视角行尾项目 tag：项目别名优先，无别名/项目不在列表（脏数据）回退路径末段。 */
export function projectTagOf(projectPath: string, projects: ProjectItem[]): string {
  const p = projects.find((x) => x.path === projectPath);
  if (p?.alias) return p.alias;
  const segs = projectPath.replace(/\\/g, '/').split('/');
  return segs[segs.length - 1] || projectPath;
}

/** 判别联合：按 key 收窄后，对应字段一定是 number，不用 `?? 0` 猜。
 *  key 同时是 i18n 字典键，单位与标点留给字典（en 下是 `3h` 而不是 `3小时`）。 */
export type RelativeTimeParts =
  | { key: 'project.timeJustNow' }
  | { key: 'project.timeMinutes' | 'project.timeHours' | 'project.timeDays'; count: number }
  | { key: 'project.timeMonthDay'; month: number; day: number }
  | { key: 'project.timeFull'; year: number; month: number; day: number };

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 会话行尾相对活跃时间（SM-S06 补充）：<1 分钟「刚刚」，<1 小时 N 分钟，
 * <24 小时 N 小时，<30 天 N 天，再往远退化为日期。
 * 返回键+参数而不是成串，交给 i18n 拼装——en 下是 `3h` 而不是 `3小时`。
 * 非法/空时间戳返回 null（调用方整块不渲染，不显示空白占位）。
 */
export function relativeTimeParts(iso: string | null | undefined, now: number): RelativeTimeParts | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;

  // 未来时间（后端时钟超前）不当成负数小时，按「刚刚」处理
  const diff = now - t;
  if (diff < MINUTE) return { key: 'project.timeJustNow' };
  if (diff < HOUR) return { key: 'project.timeMinutes', count: Math.floor(diff / MINUTE) };
  if (diff < DAY) return { key: 'project.timeHours', count: Math.floor(diff / HOUR) };
  if (diff < 30 * DAY) return { key: 'project.timeDays', count: Math.floor(diff / DAY) };

  const d = new Date(t);
  return d.getFullYear() === new Date(now).getFullYear()
    ? { key: 'project.timeMonthDay', month: d.getMonth() + 1, day: d.getDate() }
    : { key: 'project.timeFull', year: d.getFullYear(), month: d.getMonth() + 1, day: d.getDate() };
}

const pad2 = (n: number): string => String(n).padStart(2, '0');

/** 相对时间的绝对值注脚（title 提示）：`2026/10/04 09:16`，本地时区、零填充。 */
export function formatAbsoluteTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
