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
  FILE_ERR,
  type FileNode,
  type ListDirData,
  type ReadFileData,
} from '../bridge';
import type { GitStatusFile } from '../types';

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
  hiddenCount: number;
  openFiles: OpenFile[];
  activeRel: string | null;
  /** 打开历史：relPath，最新的在前。**与 openFiles 解耦**——
   * 关掉标签页不摘历史，所以「刚看过但已经关掉」的文件还能从左栏点回来。 */
  history: string[];
  query: string;
  searchResults: string[] | null;
  searchLimit: boolean;
  searching: boolean;
}

function freshState(): ProjectCodeState {
  return {
    expanded: new Set(),
    children: new Map(),
    hiddenCount: 0,
    openFiles: [],
    activeRel: null,
    history: [],
    query: '',
    searchResults: null,
    searchLimit: false,
    searching: false,
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

/** 代码树与查看器对外的全部动作 */
export function useCodeExplorer() {
  /** 全部项目状态（组件里用 computed 派生出自己那份） */
  const allStates = computed(() => states.value);

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
      hiddenCount: d.hidden,
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
   */
  async function openFile(projectPath: string, relPath: string, name: string): Promise<void> {
    const s = stateOf(projectPath);
    const history = withHistory(s.history, relPath);
    const existing = s.openFiles.find((f) => f.relPath === relPath);
    if (existing) {
      // 已打开：只切激活态，不重复读盘
      const openFiles = s.openFiles.map((f) => (f.relPath === relPath ? { ...f, error: null } : f));
      commit(projectPath, { ...s, openFiles, activeRel: relPath, history });
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
    commit(projectPath, { ...s, openFiles, activeRel: relPath, history });
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
    if (activeRel === relPath) {
      activeRel = openFiles[Math.min(idx, openFiles.length - 1)]?.relPath ?? null;
    }
    commit(projectPath, { ...s, openFiles, activeRel });
  }

  /** 切换激活标签 */
  function setActive(projectPath: string, relPath: string | null): void {
    commit(projectPath, { ...stateOf(projectPath), activeRel: relPath });
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

  /** 载入/刷新 Git 状态（徽标用）；失败静默——徽标是锦上添花，不该报障 */
  async function loadGitStatus(projectPath: string): Promise<GitStatusFile[]> {
    try {
      const st = await call<{ files?: GitStatusFile[] }>('git/getStatus', { cwd: projectPath });
      return st.files ?? [];
    } catch {
      return [];
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
    search,
    loadGitStatus,
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
