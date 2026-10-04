/**
 * Git 状态字母 → 展示字形（模块 12 CE-S07）。
 *
 * 后端 porcelain 的 `?`（未跟踪）和 `U`（冲突）直接印在 15×15 的角标里没人认得，
 * 渲染层映射成 VSCode 口径：`U`=未跟踪、`!=冲突`，腾出字母位且含义自明。
 * 后端 `GitStatusFile['status']` 联合类型不动，只在展示层映射。
 *
 * 这张表是**唯一**的映射源：文件树角标（CodeTreePanel）和查看器面包屑旁的
 * 徽标（CodeViewer）都从这走——各写各的就会出现「树里绿 U、头部橙 ?」
 * 的两副面孔（用户 2026-10-03 报），冲突态更糟：头部印 `U` 恰好和
 * 树里「U=未跟踪」撞车，把冲突读成未跟踪。
 */
import type { GitStatusFile } from '../types.ts';

export interface GitStatusUi {
  /** 角标 class（小写拼进 `is-*`，配色随展示语义走：U/A 绿、D/X 红、M 橙） */
  cls: string;
  /** 角标上实际印的字形 */
  glyph: string;
  /** hover 提示（和文件树同一段话） */
  title: string;
  /** 文件名染色 class（只有文件树用） */
  nameCls: string;
}

const STATUS_UI: Record<GitStatusFile['status'], GitStatusUi> = {
  M: { cls: 'M', glyph: 'M', title: '已修改', nameCls: 'is-mod' },
  A: { cls: 'A', glyph: 'A', title: '已新增', nameCls: 'is-add' },
  D: { cls: 'D', glyph: 'D', title: '已删除', nameCls: 'is-del' },
  '?': { cls: 'U', glyph: 'U', title: '未跟踪', nameCls: 'is-new' },
  U: { cls: 'X', glyph: '!', title: '冲突（需手动处理）', nameCls: 'is-del' },
  R: { cls: 'R', glyph: 'R', title: '已重命名', nameCls: 'is-mod' },
  C: { cls: 'C', glyph: 'C', title: '已复制', nameCls: 'is-mod' },
};

export function gitStatusUi(st: GitStatusFile['status']): GitStatusUi {
  return STATUS_UI[st] ?? STATUS_UI.M;
}
