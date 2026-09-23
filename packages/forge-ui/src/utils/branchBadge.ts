/**
 * 分支徽标纯函数（PM-S05，AC-PM-013/014/017）。
 * 忙态口径（2026-09-23 修正）：只看当前会话自身 streaming，非项目级，故无项目忙纯函数。
 * 契约：docs/api/01_project.md §10/§11。
 */
import type { GitBranchInfo } from '../types';

/** 浮窗分支过滤：空查询返回全量；大小写不敏感子串匹配；不改入参 */
export function filterBranches(branches: string[], query: string): string[] {
  const q = query.trim().toLowerCase();
  if (q === '') return [...branches];
  return branches.filter((b) => b.toLowerCase().includes(q));
}

/** 未提交更改确认决策：dirty 且目标 ≠ 当前分支时需确认（AC-PM-017 前置） */
export function shouldAskConfirm(dirty: boolean, target: string, current: string): boolean {
  return dirty && target !== current;
}

/** 徽标显示文案：非 git 项目 null（不渲染徽标）；detached 时 branch 字段即短 SHA（§10） */
export function displayBranch(info: GitBranchInfo): string | null {
  if (!info.isGitRepo) return null;
  return info.branch;
}
