/**
 * 目录行的 Git 状态聚合（模块 12 CE-S07「目录角标表示子树里有改动」）。
 *
 * 口径与原型一致（prototypes/code-tree-git-demo.html 的 dirBadge）：
 * - 子树里有冲突（U）→ U：冲突是最高优先级，别让 M 把它盖住；
 * - 恰好一个变更文件 → **透传它自己的状态**（A/?/D 一眼读得出目录里发生了什么，
 *   与原型 `hit.length > 1 ? 'M' : hit[0].st` 同款）；
 * - 多个变更文件 → M：聚合态只承诺「有改动」，不逐个报。
 *
 * 只线性扫 git status 的 files[]（变更集通常几十条）；父目录着色（名字 + 角标
 * 同色）由 CodeTreePanel 用同一张 STATUS_UI 表消费，两处各写各的就会出现
 * 「名字绿的、角标橙的」。
 */
import type { GitStatusFile } from '../types.ts';

export function aggregateGitDirStatus(
  files: GitStatusFile[],
  dirRelPath: string,
): GitStatusFile['status'] | null {
  const prefix = `${dirRelPath}/`;
  let single: GitStatusFile['status'] | null = null;
  let multiple = false;
  for (const f of files) {
    if (!f.path.startsWith(prefix)) continue;
    if (f.status === 'U') return 'U';
    if (single === null) {
      single = f.status;
    } else {
      multiple = true;
    }
  }
  return multiple ? 'M' : single;
}
