/**
 * 模块 12：变更视图「级联模式」的目录树构建（纯函数）。
 *
 * 平铺清单 34 个文件时，同目录的文件散在一起、目录归属全靠右侧尾巴读——
 * 用户 2026-10-03 要求按目录分层展示（VSCode 源代码管理树视图同款）。
 * 这里把 GitStatusFile[] 组成目录树，并给每个目录节点算好两样渲染要用的东西：
 * - status：子树聚合状态（单文件透传自身状态、多文件聚合 M、冲突 U 压一切，
 *   与文件树的 aggregateGitDirStatus 同一条口径）；
 * - count：子树内变更文件数（目录行右侧的计数）。
 *
 * 排序口径：目录在前、文件在后，各自按名称字典序——与文件树的「目录优先」
 * 同一习惯，扫读时先看到结构。
 */
import type { GitStatusFile } from '../types.ts';

export interface ChangedDirNode {
  kind: 'dir';
  /** 目录末段名 */
  name: string;
  /** 目录相对路径（唯一键） */
  relPath: string;
  children: ChangedNode[];
  /** 子树聚合状态 */
  status: GitStatusFile['status'];
  /** 子树内变更文件数 */
  count: number;
}

export interface ChangedFileNode {
  kind: 'file';
  name: string;
  relPath: string;
  file: GitStatusFile;
}

export type ChangedNode = ChangedDirNode | ChangedFileNode;

/** 一棵子树的聚合：U 压一切；恰好一个文件 → 透传自身状态；多个 → M */
function aggregateOf(statuses: GitStatusFile['status'][]): {
  status: GitStatusFile['status'];
  count: number;
} {
  if (statuses.some((s) => s === 'U')) return { status: 'U', count: statuses.length };
  if (statuses.length === 1) return { status: statuses[0]!, count: 1 };
  return { status: 'M', count: statuses.length };
}

/** 目录在前、文件在后，各自按名称字典序 */
function sortNodes(nodes: ChangedNode[]): ChangedNode[] {
  return [...nodes].sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

export function buildChangedTree(files: GitStatusFile[]): ChangedNode[] {
  /** 虚拟根：收集顶层条目；dirNodes 缓存保证同一目录只建一个节点 */
  const root: ChangedDirNode = {
    kind: 'dir',
    name: '',
    relPath: '',
    children: [],
    status: 'M',
    count: 0,
  };
  const dirNodes = new Map<string, ChangedDirNode>([['', root]]);
  const ensureDir = (dirPath: string): ChangedDirNode => {
    const hit = dirNodes.get(dirPath);
    if (hit) return hit;
    const slash = dirPath.lastIndexOf('/');
    const parent = ensureDir(slash === -1 ? '' : dirPath.slice(0, slash));
    const node: ChangedDirNode = {
      kind: 'dir',
      name: dirPath.slice(slash + 1),
      relPath: dirPath,
      children: [],
      status: 'M',
      count: 0,
    };
    dirNodes.set(dirPath, node);
    parent.children.push(node);
    return node;
  };

  for (const f of files) {
    const slash = f.path.lastIndexOf('/');
    const dirPath = slash === -1 ? '' : f.path.slice(0, slash);
    const name = f.path.slice(slash + 1);
    ensureDir(dirPath).children.push({ kind: 'file', name, relPath: f.path, file: f });
  }

  /** 后序遍历：先算完子目录的聚合，再并入自己 */
  const fill = (node: ChangedDirNode): GitStatusFile['status'][] => {
    const statuses: GitStatusFile['status'][] = [];
    for (const c of node.children) {
      if (c.kind === 'file') {
        statuses.push(c.file.status);
      } else {
        statuses.push(...fill(c));
      }
    }
    const agg = aggregateOf(statuses);
    node.status = agg.status;
    node.count = agg.count;
    return statuses;
  };
  fill(root);
  return sortNodes(root.children);
}
