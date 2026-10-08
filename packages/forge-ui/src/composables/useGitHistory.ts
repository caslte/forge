/**
 * CE-S11 Git 提交历史 · 取数编排（PRD 12 §3.7）。
 *
 * 这里只管**什么时候取、缓存什么、谁覆盖谁**，不碰渲染。
 * 核心是一条契约（AC-CE-037，两级取数）：
 *
 *   选中提交 → 只取 meta+numstat（5.9KB）
 *   展开文件 → 才取那一个文件的 patch
 *
 * 合并成一次性取全量会让最坏情况把 1.6MB 塞进 IPC 再塞进 DOM
 * （实测 128 文件的 merge commit：全量 patch 1,595,751 bytes vs numstat 5,951 bytes）。
 * 换成**普通工厂函数**而不是 Vue composable，是为了能在 node:test 里直接驱动，
 * 不必挂载组件（项目无 vitest / @vue/test-utils，见 test 目录既有惯例）。
 */
import { call } from '../bridge.ts';

/** 与 core `GitCommitSummary` 对齐（ui 侧镜像，见 types.ts 同类做法） */
export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  parentCount: number;
  isMerge: boolean;
}

/** 与 core `GitCommitFileStat` 对齐 */
export interface CommitFileStat {
  path: string;
  oldPath: string | null;
  status: string;
  additions: number;
  deletions: number;
  binary: boolean;
}

/** 与 core `GitCommitDetailData` 对齐（**不含 diff**） */
export interface CommitDetail {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: number;
  committedAt: number;
  committerName: string;
  committerEmail: string;
  parentCount: number;
  isMerge: boolean;
  isRoot: boolean;
  files: CommitFileStat[];
}

/** 三个 git 方法的可注入形态（测试注入 fake，生产走 bridge.call） */
export interface GitHistoryBridge {
  getCommitLog(params: {
    path: string;
    limit?: number;
    skip?: number;
  }): Promise<{ commits: CommitSummary[]; hasMore: boolean }>;
  getCommitDetail(params: { path: string; sha: string }): Promise<CommitDetail>;
  getCommitFileDiff(params: {
    path: string;
    sha: string;
    file: string;
  }): Promise<{ diff: string | null }>;
}

/** 默认实现：走渲染层 bridge */
export const defaultBridge: GitHistoryBridge = {
  getCommitLog: (params) => call<{ commits: CommitSummary[]; hasMore: boolean }>('git/getCommitLog', params),
  getCommitDetail: (params) => call<CommitDetail>('git/getCommitDetail', params),
  getCommitFileDiff: (params) => call<{ diff: string | null }>('git/getCommitFileDiff', params),
};

type DetailState = 'idle' | 'loading' | 'ready' | 'fail';
type FileState = 'idle' | 'loading' | 'ready' | 'fail';

/** 取数编排器。每个项目路径一个实例，由调用方（CodeTreePanel）持有。 */
export function createGitHistoryLoader(bridge: GitHistoryBridge = defaultBridge) {
  let projectPath = '';
  let commits: CommitSummary[] = [];
  let hasMore = false;

  let selectedSha: string | null = null;
  let detail: CommitDetail | null = null;
  let detailStatus: DetailState = 'idle';

  /** 展开态 + patch 缓存。键是 `<sha>\0<file>` —— 带 sha 是为了切提交后不串台 */
  const expanded = new Map<string, string>();
  const diffCache = new Map<string, string | null>();
  const fileStatus = new Map<string, FileState>();

  /** 竞态防护：只有最后发起的请求允许写回 */
  let detailSeq = 0;
  let fileSeq = new Map<string, number>();

  function reset(): void {
    projectPath = '';
    commits = [];
    hasMore = false;
    selectedSha = null;
    detail = null;
    detailStatus = 'idle';
    expanded.clear();
    diffCache.clear();
    fileStatus.clear();
    detailSeq = 0;
    fileSeq = new Map();
  }

  function setProject(path: string): void {
    if (path !== projectPath) reset();
    projectPath = path;
  }

  /** 拉取历史列表；skip>0 时追加（按 sha 去重、保持顺序） */
  async function loadLog(opts: { limit?: number; skip?: number } = {}): Promise<void> {
    if (!projectPath) return;
    const limit = opts.limit ?? 100;
    const skip = opts.skip ?? 0;
    const res = await bridge.getCommitLog({ path: projectPath, limit, skip });
    if (skip === 0) {
      commits = res.commits;
    } else {
      const seen = new Set(commits.map((c) => c.sha));
      for (const c of res.commits) {
        if (!seen.has(c.sha)) {
          seen.add(c.sha);
          commits.push(c);
        }
      }
    }
    hasMore = res.hasMore;
  }

  /** 选中提交：只取详情（meta+numstat），**不取任何 patch** */
  async function selectCommit(sha: string): Promise<void> {
    if (!projectPath) return;
    selectedSha = sha;
    detailStatus = 'loading';
    // 展开态属于具体提交，换提交即清空（否则同名文件会命中上一提交的缓存）
    expanded.clear();
    fileStatus.clear();
    diffCache.clear();
    const seq = ++detailSeq;
    try {
      const res = await bridge.getCommitDetail({ path: projectPath, sha });
      if (seq !== detailSeq) return; // 已有更新的请求，丢弃本次结果
      detail = res;
      detailStatus = 'ready';
    } catch {
      if (seq !== detailSeq) return;
      detail = null;
      detailStatus = 'fail';
    }
  }

  function cacheKey(file: string): string {
    return `${selectedSha ?? ''}\u0000${file}`;
  }

  /** 展开文件块：此时才取该文件的 patch（两级取数的第二级） */
  async function expandFile(file: string): Promise<void> {
    if (!projectPath || !selectedSha) return;
    const key = cacheKey(file);
    expanded.set(key, file);
    if (diffCache.has(key)) return; // 已取过：只补展开态，不再发 IPC
    fileStatus.set(key, 'loading');
    const seq = (fileSeq.get(key) ?? 0) + 1;
    fileSeq.set(key, seq);
    try {
      const res = await bridge.getCommitFileDiff({ path: projectPath, sha: selectedSha, file });
      if (fileSeq.get(key) !== seq) return;
      diffCache.set(key, res.diff);
      fileStatus.set(key, 'ready');
    } catch {
      if (fileSeq.get(key) !== seq) return;
      fileStatus.set(key, 'fail');
    }
  }

  function collapseFile(file: string): void {
    if (!selectedSha) return;
    expanded.delete(cacheKey(file));
  }

  return {
    setProject,
    reset,
    loadLog,
    selectCommit,
    expandFile,
    collapseFile,
    commits: () => commits,
    hasMore: () => hasMore,
    selected: () => selectedSha,
    detail: () => detail,
    detailState: () => detailStatus,
    isFileExpanded: (file: string) => expanded.has(cacheKey(file)),
    fileDiff: (file: string) => diffCache.get(cacheKey(file)) ?? null,
    fileState: (file: string): FileState => fileStatus.get(cacheKey(file)) ?? 'idle',
  };
}

export type GitHistoryLoader = ReturnType<typeof createGitHistoryLoader>;