/**
 * 代码浏览器「已打开文件」的磁盘变更监听（模块 12 自动刷新的核心）。
 *
 * 为什么监听**父目录**而不是文件本身：VS Code / Cursor / Trae 保存常用
 * 「写临时文件 + 原子替换」，文件级 fs.watch 在替换瞬间会失效（rename 后句柄悬空）；
 * 目录级 watcher 能扛住原子替换。同一目录多个打开文件共享一个 watcher——
 * 大仓库展开半层目录再开几个签，句柄数也不会跟着打开数走。
 *
 * 纯管理逻辑：目录集合的增减 diff、事件按「当前已打开集合」过滤、按 relPath 防抖。
 * fs.watch 通过 `watchDir` 注入（真实实现是 fs.watch 的薄包装；测试用 fake 手动触发）。
 * `watchDir` 抛错（打开后又被删的文件、权限）按「该目录没监听上」处理，不影响其余。
 */
import path from 'node:path';

export interface WatchEntry {
  /** 所属项目根（事件要带回去，渲染层按项目分流） */
  projectPath: string;
  /** 项目内 POSIX 相对路径（渲染层状态键） */
  relPath: string;
  /** 已解析好的绝对路径（调用方负责 containment 校验，本模块不做路径安全） */
  abs: string;
}

/** fs.watch 的形状：目录上有变化时以「文件基名或 null（目录事件）」回调 */
export type DirEventSink = (filename: string | null) => void;
export type DirWatcherFactory = (dir: string, sink: DirEventSink) => () => void;

import fs from 'node:fs';

/** 真实实现：fs.watch 的薄包装。persistent:false 不拖住进程退出；non-recursive。 */
export const fsDirWatcher: DirWatcherFactory = (dir, sink) => {
  const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
    sink(typeof filename === 'string' ? filename : null);
  });
  watcher.on('error', () => {
    /* 目录被删/权限变化：本次监听自然失效，等下次 sync 重建 */
  });
  return () => watcher.close();
};

export interface OpenFileWatcherDeps {
  watchDir: DirWatcherFactory;
  /** 同一文件连续变化合并为一轮刷新的窗口（编辑器一次保存常触发多轮事件） */
  debounceMs: number;
  onFileChanged: (projectPath: string, relPath: string) => void;
}

interface DirEntry {
  unwatch: () => void;
  /** 文件基名 → relPath（只收当前打开集合内的事件） */
  files: Map<string, { projectPath: string; relPath: string }>;
}

/** `${projectPath}\u0000${relPath}`：跨项目防抖与集合 diff 的稳定键 */
const keyOf = (projectPath: string, relPath: string): string => `${projectPath}\u0000${relPath}`;

export class OpenFileWatcher {
  private readonly dirs = new Map<string, DirEntry>();
  /** keyOf → timer：防抖在途的文件 */
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();

  private readonly deps: OpenFileWatcherDeps;

  constructor(deps: OpenFileWatcherDeps) {
    this.deps = deps;
  }

  /** 以传入集合为准对齐监听（渲染层每次打开/关闭文件后发一次全量） */
  sync(entries: readonly WatchEntry[]): void {
    const wanted = new Map<string, WatchEntry>();
    for (const e of entries) wanted.set(keyOf(e.projectPath, e.relPath), e);

    // 1. 现存目录：更新文件表；已无文件的目录顺带关闭（下面统一重建会重复，这里只摘除条目）
    for (const [dir, de] of this.dirs) {
      for (const [base, info] of [...de.files]) {
        if (!wanted.has(keyOf(info.projectPath, info.relPath))) de.files.delete(base);
      }
      if (de.files.size === 0) {
        de.unwatch();
        this.dirs.delete(dir);
      }
    }

    // 2. 新条目：目录已有 → 入表；没有 → 建 watcher（失败静默跳过该目录）
    for (const e of wanted.values()) {
      const dir = path.dirname(e.abs);
      const base = path.basename(e.abs);
      let de = this.dirs.get(dir);
      if (!de) {
        let unwatch: () => void;
        try {
          unwatch = this.deps.watchDir(dir, (filename) => this.onDirEvent(dir, filename));
        } catch {
          continue; // 目录没了 / 无权限：等下次 sync 或重读时自然暴露 6104
        }
        de = { unwatch, files: new Map() };
        this.dirs.set(dir, de);
      }
      de.files.set(base, { projectPath: e.projectPath, relPath: e.relPath });
    }
  }

  /** 释放全部监听与在途防抖（渲染层项目卸载 / 扩展停用时） */
  dispose(): void {
    for (const de of this.dirs.values()) de.unwatch();
    this.dirs.clear();
    for (const t of this.pending.values()) clearTimeout(t);
    this.pending.clear();
  }

  private onDirEvent(dir: string, filename: string | null): void {
    if (filename === null) return; // 目录自身事件（内容无名），无对应打开文件
    const de = this.dirs.get(dir);
    if (!de) return;
    const hit = de.files.get(filename);
    if (!hit) return;
    const key = keyOf(hit.projectPath, hit.relPath);
    const t = this.pending.get(key);
    if (t !== undefined) return; // 防抖窗口内：已有一次刷新在路上
    this.pending.set(
      key,
      setTimeout(() => {
        this.pending.delete(key);
        this.deps.onFileChanged(hit.projectPath, hit.relPath);
      }, this.deps.debounceMs),
    );
  }
}
