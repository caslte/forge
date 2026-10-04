/**
 * 内置代码浏览器状态（模块 12）。
 *
 * 设计取舍：不做虚拟滚动树组件，而是把「哪些目录展开了」直接展平成一个
 * `Set<relPath>` + 每层节点的子项缓存。理由是**懒加载的粒度本来就是按目录的**——
 * 一旦展开就拿到了整层子项，再为它做一个虚拟列表既没省 IO（数据已在内存），
 * 只增加了滚动同步的复杂度。真实仓库一层最多几千项，DOM 量可接受。
 *
 * 状态归这个 composable 管，组件只管渲染；这样布局 A/B 两个挂载点能共用同一份状态，
 * 切布局时展开态、打开的文件、滚动位置都不会丢。
 */
import { computed, ref, shallowRef } from 'vue';
import {
  call,
  fileListDir,
  fileReadFile,
  fileSearchFiles,
  fileWatchSync,
  subscribe,
  FILE_ERR,
  type FileNode,
  type ListDirData,
  type ReadFileData,
} from '../bridge.ts';
import type { GitFileDiffData, GitStatusFile, GitStatusInfo } from '../types.ts';
import { usePreferences, type CodeDiffDefaultMode } from './usePreferences.ts';

/** 单个已打开文件的查看器状态 */
export interface OpenFile {
  /** 相对项目根的 POSIX 路径（唯一键） */
  relPath: string;
  /** 文件名（面包屑末段与标签页标题） */
  name: string;
  data: ReadFileData | null;
  /** 加载中 */
  loading: boolean;
  /** 读失败（6104 路径失效 / 6107 读失败）；不因失败清空已载入的 data */
  error: string | null;
  /** 路径失效（6104）：UI 在标签上打「已删除」并给出刷新入口 */
  missing: boolean;
}

/** 树节点：FileNode 加上「是否已加载 / 加载中 / 出错」 */
export interface TreeRow extends FileNode {
  loading: boolean;
  /** 懒加载失败（该层不可读，如权限不足）；不阻断整棵树 */
  error: string | null;
}

/** 每个项目独立保存的 UI 状态（CE-S05） */
export interface ProjectCodeState {
  expanded: Set<string>;
  /** relPath -> 该层子项 */
  children: Map<string, TreeRow[]>;
  openFiles: OpenFile[];
  activeRel: string | null;
  /** 打开历史：relPath，最新的在前。**与 openFiles 解耦**——
   * 关掉标签页不摘历史，所以「刚看过但已经关掉」的文件还能从左栏点回来。 */
  history: string[];
  query: string;
  searchResults: string[] | null;
  searchLimit: boolean;
  searching: boolean;
  /**
   * 代码纸正文形态（模块 12 P2）：`file`=只读正文，`inline`=行内高亮，
   * `side`=并排对比。挂在项目级（不挂组件）的理由：左栏「变更视图」点文件要能
   * 把右侧切到对比——两个组件没有直连通道，共用状态是唯一不打结的路。
   * **换文件即重置**（applyModeFor）：有变更的文件按**个性化偏好**直接进
   * side/inline（默认 side），无变更的落文件正文——切换器只在当前文件上生效，
   * 不做跨文件记忆（用户 2026-10-03 定稿：默认有修改就展示 diff）。
   */
  viewerMode: 'file' | 'inline' | 'side';
  /**
   * 整份 Git 状态（角标/变更视图/底栏提交条/**右侧 diff 模式判定**共用这一份）。
   * 挂在项目状态里而不是各组件自己拉：组件各拉各的会有「切了文件、状态还在路上」
   * 的窗口期，右侧就会先闪一帧旧模式再跳正确的（用户报的「先跳文件再跳 diff /
   * 未变更文件先弹空态页」即此）。同步可查，模式判定零延迟。
   */
  gitInfo: GitStatusInfo | null;
}

function freshState(): ProjectCodeState {
  return {
    expanded: new Set(),
    children: new Map(),
    openFiles: [],
    activeRel: null,
    history: [],
    query: '',
    searchResults: null,
    searchLimit: false,
    searching: false,
    viewerMode: 'file',
    gitInfo: null,
  };
}

/** 每项目一份状态；用 shallowRef 装 Map，避免深层响应式代理带来的开销 */
const states = shallowRef(new Map<string, ProjectCodeState>());

function stateOf(projectPath: string): ProjectCodeState {
  let s = states.value.get(projectPath);
  if (!s) {
    s = freshState();
    states.value.set(projectPath, s);
    // 触发 shallowRef：换 Map 而非改 Map，shallow 代理才认得出
    states.value = new Map(states.value);
  }
  return s;
}

/** 浅拷贝后回写，让浅层 ref 能感知内部变化 */
function commit(projectPath: string, s: ProjectCodeState): void {
  states.value.set(projectPath, s);
  states.value = new Map(states.value);
}

/** 切换项目时丢弃该项目的缓存（文件可能已被外部改动） */
export function invalidateProjectState(projectPath: string): void {
  if (!states.value.has(projectPath)) return;
  states.value.delete(projectPath);
  states.value = new Map(states.value);
  // 项目缓存没了 = 它的打开集合也没了：把主进程侧的监听一并撤掉
  syncWatchers(projectPath);
}

/**
 * 把主进程侧的磁盘监听对齐到当前打开集合（自动刷新，CE-S10）。
 * 打开/关闭文件后调用；主进程按目录做增量 diff，重复全量同步代价可忽略。
 * 旧 preload / 浏览器 mock 没有这个方法时静默跳过。
 */
function syncWatchers(projectPath: string): void {
  const s = states.value.get(projectPath);
  const relPaths = [...new Set(s?.openFiles.map((f) => f.relPath) ?? [])];
  try {
    void fileWatchSync(projectPath, relPaths).catch(() => {});
  } catch {
    /* 旧 bridge 无此方法：自动刷新不可用，不影响其余功能 */
  }
}

/**
 * 磁盘上该文件被外部修改（agent 写入 / 用户在外部编辑器保存）：静默重读。
 * 只读查看器没有 dirty 态，直接覆盖 data 即可，无需「文件已更改」确认弹窗；
 * 失败不清空已载入的 data（与首读同语义：missing 打「已删除」标，data 留底）。
 */
async function refreshOpenFile(projectPath: string, relPath: string): Promise<void> {
  const s = stateOf(projectPath);
  const cur = s.openFiles.find((f) => f.relPath === relPath);
  if (!cur || cur.loading) return; // 没开着 / 首读还在路上：避免竞态覆盖
  const res = await fileReadFile(projectPath, relPath);
  const latest = stateOf(projectPath);
  const idx = latest.openFiles.findIndex((f) => f.relPath === relPath);
  if (idx === -1) return; // 重读期间被关掉了
  const old = latest.openFiles[idx];
  if (!old) return; // 与 idx === -1 同义（noUncheckedIndexedAccess 口径下仍需显式守卫）
  const next: OpenFile =
    res.code === 0 && res.data
      ? { ...old, data: res.data, loading: false, error: null, missing: false }
      : { ...old, loading: false, missing: res.code === FILE_ERR.NOT_FOUND, error: describe(res.code, res.message) };
  const openFiles = [...latest.openFiles];
  openFiles[idx] = next;
  commit(projectPath, { ...latest, openFiles });
}

// 订阅主进程的磁盘变化事件（模块内一次性；payload 按项目分流到对应的打开签）
if (typeof window !== 'undefined' && typeof window.forge?.on === 'function') {
  subscribe('code.fileChanged', (payload) => {
    const p = payload as { projectPath?: unknown; relPath?: unknown };
    if (typeof p?.projectPath !== 'string' || typeof p?.relPath !== 'string') return;
    void refreshOpenFile(p.projectPath, p.relPath);
  });
}

/**
 * 打开历史的容量上限。一个会话里能翻到的文件通常就在最近十几个里；
 * 留得比展示上限（面板的 5 个）宽，是为了「历史」这个语义真的成立，
 * 而不是把左栏那一行直接当存储用。不封顶则一个长会话会把它涨到成百上千条。
 */
const HISTORY_LIMIT = 20;

/** 把 relPath 提到历史头部（去重），并封顶。返回新数组，不改原数组。 */
function withHistory(history: string[], relPath: string): string[] {
  return [relPath, ...history.filter((p) => p !== relPath)].slice(0, HISTORY_LIMIT);
}

/**
 * 切文件时的正文形态默认值（用户 2026-10-03 定稿「默认有修改就展示 diff」）：
 * 目标文件在变更集里 → 按个性化偏好进 side/inline；不在 → 文件正文。判定读的是
 * 项目状态里的 gitInfo（同步），所以切换零闪烁——这也是空态页能整个取消的前提。
 */
function applyModeFor(
  gitInfo: GitStatusInfo | null,
  relPath: string,
  diffDefault: CodeDiffDefaultMode,
): 'file' | 'inline' | 'side' {
  const changed = gitInfo?.files.some((f) => f.path === relPath) ?? false;
  return changed ? diffDefault : 'file';
}

/** 代码树与查看器对外的全部动作 */
export function useCodeExplorer() {
  /** 全部项目状态（组件里用 computed 派生出自己那份） */
  const allStates = computed(() => states.value);
  /** 有修改的文件默认进哪种对比（个性化偏好，模块级单例 ref） */
  const { codeDiffDefaultMode } = usePreferences();

  /** 取某项目状态（不存在则创建） */
  function getState(projectPath: string): ProjectCodeState {
    return stateOf(projectPath);
  }

  /** 列目录（懒加载单层）；已加载过则直接走缓存，除非 force */
  async function loadDir(
    projectPath: string,
    relPath: string,
    force = false,
  ): Promise<{ ok: boolean; message?: string }> {
    const s = stateOf(projectPath);
    if (!force && s.children.has(relPath)) return { ok: true };
    const res = await fileListDir(projectPath, relPath);
    if (res.code !== 0 || !res.data) {
      return { ok: false, message: describe(res.code, res.message) };
    }
    const d: ListDirData = res.data;
    const next: ProjectCodeState = {
      ...s,
      children: new Map(s.children).set(relPath, toRows(d.nodes)),
    };
    commit(projectPath, next);
    return { ok: true };
  }

  /** 展开/折叠一个目录；展开时按需加载 */
  async function toggleDir(projectPath: string, relPath: string): Promise<void> {
    const s = stateOf(projectPath);
    const expanded = new Set(s.expanded);
    if (expanded.has(relPath)) {
      expanded.delete(relPath);
      commit(projectPath, { ...s, expanded });
      return;
    }
    expanded.add(relPath);
    // 只提交 expanded，**不**往 children 里塞占位数组。
    // 缓存判定是 `children.has(relPath)`，塞了空数组就等于宣告「这一层已加载」，
    // 下面的 loadDir 会直接 early-return，目录永远点不开（E2E 实测踩过）。
    // 点开时的等待反馈由 CodeTreePanel 改 TreeRow.loading 表达，不污染缓存。
    commit(projectPath, { ...s, expanded });
    await loadDir(projectPath, relPath);
  }

  /** 打开文件（切到该标签）；同时把它插到「最近打开」头部
   *
   *  两种路径都要记历史：已打开的走「切激活态」分支也得记，
   *  否则「打开时间最晚的在前」在反复点同一个签时会失真。
   *
   *  正文形态按 applyModeFor 重置：有变更的文件直接进 diff（点当前已激活的
   *  文件除外——那是原地重开，不该把用户手动切到的「文件」视图打掉）。
   */
  async function openFile(projectPath: string, relPath: string, name: string): Promise<void> {
    const s = stateOf(projectPath);
    const history = withHistory(s.history, relPath);
    const viewerMode =
      relPath === s.activeRel ? s.viewerMode : applyModeFor(s.gitInfo, relPath, codeDiffDefaultMode.value);
    const existing = s.openFiles.find((f) => f.relPath === relPath);
    if (existing) {
      // 已打开：只切激活态，不重复读盘
      const openFiles = s.openFiles.map((f) => (f.relPath === relPath ? { ...f, error: null } : f));
      commit(projectPath, { ...s, openFiles, activeRel: relPath, history, viewerMode });
      return;
    }
    const file: OpenFile = {
      relPath,
      name,
      data: null,
      loading: true,
      error: null,
      missing: false,
    };
    // 新文件置顶：让标签栏保持“刚点的在最前”（历史由上面的 withHistory 负责）
    const openFiles = [file, ...s.openFiles];
    commit(projectPath, { ...s, openFiles, activeRel: relPath, history, viewerMode });
    syncWatchers(projectPath); // 打开集合变了：主进程侧补上这个文件的磁盘监听
    const res = await fileReadFile(projectPath, relPath);
    const cur = stateOf(projectPath);
    const idx = cur.openFiles.findIndex((f) => f.relPath === relPath);
    if (idx === -1) {
      return; // 读盘期间被关闭了（历史里仍然留着它，这正是解耦的意义）
    }
    const done: OpenFile =
      res.code === 0 && res.data
        ? { ...file, data: res.data, loading: false, error: null, missing: false }
        : {
            ...file,
            loading: false,
            missing: res.code === FILE_ERR.NOT_FOUND,
            error: describe(res.code, res.message),
          };
    const openFiles2 = [...cur.openFiles];
    openFiles2[idx] = done;
    commit(projectPath, { ...cur, openFiles: openFiles2 });
  }

  /** 关闭标签（关闭当前则落到相邻标签）
   *
   *  **不动 history**：关签只是不看了，不是没打开过。左栏「最近打开」读的是
   *  history，所以关掉的文件仍留在那儿，再点一下就重新打开。 */
  function closeFile(projectPath: string, relPath: string): void {
    const s = stateOf(projectPath);
    const idx = s.openFiles.findIndex((f) => f.relPath === relPath);
    if (idx === -1) return;
    const openFiles = s.openFiles.filter((f) => f.relPath !== relPath);
    let activeRel = s.activeRel;
    let viewerMode = s.viewerMode;
    if (activeRel === relPath) {
      activeRel = openFiles[Math.min(idx, openFiles.length - 1)]?.relPath ?? null;
      // 落到的相邻签按同一套默认规则给正文形态（有变更 → diff）
      viewerMode =
        activeRel === null ? 'file' : applyModeFor(s.gitInfo, activeRel, codeDiffDefaultMode.value);
    }
    commit(projectPath, { ...s, openFiles, activeRel, viewerMode });
    syncWatchers(projectPath); // 关掉的文件撤掉磁盘监听
  }

  /** 切换激活标签；正文形态按「有变更 → diff」重置（与 openFile 同一口径） */
  function setActive(projectPath: string, relPath: string | null): void {
    const s = stateOf(projectPath);
    const viewerMode =
      relPath === null ? 'file' : applyModeFor(s.gitInfo, relPath, codeDiffDefaultMode.value);
    commit(projectPath, { ...s, activeRel: relPath, viewerMode });
  }

  /** 切代码纸正文形态（文件 / 行内 / 并排）；由 CodeViewer 的切换器回写 */
  function setViewerMode(projectPath: string, mode: 'file' | 'inline' | 'side'): void {
    commit(projectPath, { ...stateOf(projectPath), viewerMode: mode });
  }

  /**
   * 把某个签移到新位置（拖拽排序 / 左移右移共用）。
   *
   * **不碰 activeRel**：拖动一个未激活的签不应该顺手切换激活签（和中键关闭同一个原则：
   * 手势只做手势那一件事）。位置参数用「目标下标」而不是「位移量」——拖拽过程中每帧
   * 都会拿当前布局重新算目标下标，用位移量会在跨过半个签宽时抖动。
   *
   * @param toIndex 目标下标；越界会被夹到 [0, openFiles.length-1]
   * @returns 是否真的移动了（已在目标位置时返回 false，调用方据此决定要不要收尾）
   */
  function moveFile(projectPath: string, relPath: string, toIndex: number): boolean {
    const s = stateOf(projectPath);
    const from = s.openFiles.findIndex((f) => f.relPath === relPath);
    if (from === -1) return false;
    const to = Math.max(0, Math.min(Math.round(toIndex), s.openFiles.length - 1));
    if (to === from) return false;
    const openFiles = [...s.openFiles];
    const removed = openFiles.splice(from, 1);
    const moved = removed[0];
    if (!moved) return false;
    openFiles.splice(to, 0, moved);
    commit(projectPath, { ...s, openFiles });
    return true;
  }

  /** 按文件名过滤（CE-S06：只搜文件名，不做内容搜索） */
  async function search(projectPath: string, query: string): Promise<void> {
    const s = stateOf(projectPath);
    const q = query.trim();
    commit(projectPath, { ...s, query, searching: q !== '', searchResults: q === '' ? null : [] });
    if (q === '') return;
    const res = await fileSearchFiles(projectPath, q);
    const cur = stateOf(projectPath);
    // 防止慢响应覆盖新输入：查询词已变就丢弃这次结果
    if (cur.query.trim() !== q) return;
    commit(projectPath, {
      ...cur,
      searching: false,
      searchResults: res.code === 0 && res.data ? res.data.files : null,
      searchLimit: res.code === 0 && res.data ? res.data.limitReached : false,
    });
  }

  /**
   * 拉取 Git 状态（角标 + 变更视图 + 底栏提交条 + **右侧 diff 模式判定**共用）。
   *
   *  返回整份 `GitStatusInfo` 并**写进项目状态**：左栏和右侧消费同一份，
   *  切文件时模式判定同步可得（组件各拉各的会有一段「状态在路上」的窗口，
   *  右侧就会闪错帧）。失败静默（角标是锦上添花，不该报障）→ 状态置 `null`。
   */
  async function loadGitStatus(projectPath: string): Promise<GitStatusInfo | null> {
    let info: GitStatusInfo | null = null;
    try {
      info = await call<GitStatusInfo>('git/getStatus', { path: projectPath });
    } catch {
      info = null;
    }
    commit(projectPath, { ...stateOf(projectPath), gitInfo: info });
    return info;
  }

  /**
   * 拉取单文件相对基线的 unified diff（并排 diff 数据源，模块 12 P2）。
   *
   * 返回口径与 core `GitFileDiffData.diff` 一致：`''`=无差异、`null`=拉不到
   * （未跟踪文件不该走到这——调用方先用 gitStatus.status==='?' 分流去合成
   * 「全新增」视角；走到这里仍为 null 就是真失败）。
   */
  async function getFileDiff(projectPath: string, relPath: string): Promise<string | null> {
    try {
      const res = await call<GitFileDiffData>('git/getFileDiff', { path: projectPath, relPath });
      return res.diff ?? null;
    } catch {
      return null;
    }
  }

  return {
    allStates,
    getState,
    loadDir,
    toggleDir,
    openFile,
    closeFile,
    setActive,
    setViewerMode,
    moveFile,
    search,
    loadGitStatus,
    getFileDiff,
    invalidateProjectState,
  };
}

function toRows(nodes: FileNode[]): TreeRow[] {
  return nodes.map((n) => ({ ...n, loading: false, error: null }));
}

/** 错误码 → 面向人的提示；6103 不弹窗（安全事件静默记录） */
function describe(code: number, fallback: string): string {
  switch (code) {
    case FILE_ERR.PATH_ESCAPE:
      return '路径超出项目范围';
    case FILE_ERR.PROJECT_NOT_FOUND:
      return '项目已不可用';
    case FILE_ERR.NOT_FOUND:
      return '文件已删除';
    case FILE_ERR.NOT_A_DIRECTORY:
      return '不是目录';
    case FILE_ERR.NOT_A_FILE:
      return '不是文件';
    case FILE_ERR.READ_FAILED:
      return '读取失败';
    default:
      return fallback || '未知错误';
  }
}
