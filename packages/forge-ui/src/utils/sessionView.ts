/**
 * 会话列表视图纯函数（SM-S06 双视角共用，docs/prd/02_session_management.md）。
 *
 * 项目视角（按项目分组）与任务视角（平摊全部会话）的排序、
 * 收起/展开全部两态判定、任务视角行尾项目 tag 都收敛在这里，
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
