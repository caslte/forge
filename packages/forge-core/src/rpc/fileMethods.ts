/**
 * 文件 RPC 方法层（模块 12，docs/prd/12_code_explorer.md §5）。
 *
 * 三个只读方法，把 FileService 包装成传输无关的方法映射：
 * - file/listDir     列单层目录（代码树懒加载）
 * - file/readFile    读文本文件（只读查看器）
 * - file/searchFiles 按文件名过滤（代码树顶栏搜索框）
 *
 * 本层只做三件事，**不含任何业务判断**：
 * 1. 参数校验（path 必填非空；relPath 缺省 ''= 项目根；query 必填非空）
 * 2. FileService 的 FileResult → 统一 RpcResult 信封映射
 * 3. 异常隔离（意外抛错 → 5000，不泄漏细节）
 *
 * 越界判定（6103）**不在本层**：它由 FileService 的 resolveInside 产出，本层原样
 * 透传错误码。这样做的意义是安全规则只有一个事实来源——将来若要加审计日志/告警，
 * 只改 fileService 一处。6103 额外打一条 warn 级日志：它是安全事件而非普通 404。
 *
 * 纯 Node，不 import Electron / Vue / pi。
 */

import type { RpcResult, EventSink } from './projectMethods.ts';
import { FileService, resolveInside, type FileServiceOptions } from '../file/fileService.ts';
import {
  OpenFileWatcher,
  fsDirWatcher,
  type WatchEntry,
  type OpenFileWatcherDeps,
} from '../file/watcher.ts';

/** 构造成功信封 */
function ok<T>(data: T): RpcResult<T> {
  return { code: 0, message: 'success', data };
}

/** 构造失败信封（data 恒为 null） */
function fail(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/** 类型守卫：params 是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 取非空字符串参数。
 * @returns 缺失/非字符串/纯空白时返回 null
 */
function requireString(params: unknown, key: string): string | null {
  if (!isRecord(params)) return null;
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/**
 * 取相对路径参数，缺省/空串视为项目根。
 * 与 requireString 的区别：这里**允许**空串——列项目根是合法且高频的操作。
 */
function optionalRelPath(params: unknown, key: string): string | null {
  if (!isRecord(params)) return null;
  const value = params[key];
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') return null;
  return value;
}

/** FileApi 依赖 */
export interface FileApiDeps extends FileServiceOptions {
  /** 可注入服务实例（测试接替身用） */
  fileService?: FileService;
  /**
   * 事件汇（与 git/term 同款）：`file/watchSync` 监听的文件在磁盘上变化时，
   * 经此发射 `code.fileChanged`（payload {projectPath, relPath}），createForgeCore
   * 传共享 eventBus，主进程按 FORGE_EVENTS 登记转发渲染层。缺省 = 不发事件。
   */
  events?: EventSink;
  /** 目录监听工厂（测试接替身用）；缺省真实 fs.watch */
  watchDirFactory?: OpenFileWatcherDeps['watchDir'];
  /** 防抖窗口（测试用小值）；缺省 300ms */
  watchDebounceMs?: number;
}

/** 同一文件连续变化合并为一轮刷新的窗口：编辑器一次保存常触发多轮 fs 事件 */
export const FILE_WATCH_DEBOUNCE_MS = 300;

/**
 * 文件 RPC 方法层。
 */
export class FileApi {
  readonly methods: Record<string, (params: unknown) => RpcResult>;
  private readonly fileService: FileService;
  private readonly watcher: OpenFileWatcher;

  constructor(deps: FileApiDeps) {
    this.fileService = deps.fileService ?? new FileService({ isProjectRegistered: deps.isProjectRegistered });
    this.watcher = new OpenFileWatcher({
      watchDir: deps.watchDirFactory ?? fsDirWatcher,
      debounceMs: deps.watchDebounceMs ?? FILE_WATCH_DEBOUNCE_MS,
      onFileChanged: (projectPath, relPath) => deps.events?.emit('code.fileChanged', { projectPath, relPath }),
    });
    this.methods = {
      'file/listDir': (params) => this.listDir(params),
      'file/readFile': (params) => this.readFile(params),
      'file/searchFiles': (params) => this.searchFiles(params),
      'file/watchSync': (params) => this.watchSync(params),
    };
  }

  /** 统一的服务结果 → 信封映射；6103 补打安全告警日志 */
  private wrap<T>(method: string, result: { ok: true; data: T } | { ok: false; code: number; message: string }): RpcResult {
    if (result.ok) return ok(result.data);
    if (result.code === 6103) {
      // 越界是安全事件而非普通失败：留痕，但不把栈或内部路径丢给渲染进程
      console.warn(`[${method}] 路径越界已被拒绝`, result.message);
    }
    return fail(result.code, result.message);
  }

  /** file/listDir：列单层目录。relPath 缺省 ''= 项目根 */
  private listDir(params: unknown): RpcResult {
    const projectPath = requireString(params, 'path');
    if (projectPath === null) {
      return fail(6101, '参数错误：path 必须为非空字符串');
    }
    const relPath = optionalRelPath(params, 'relPath');
    if (relPath === null) {
      return fail(6101, '参数错误：relPath 必须为字符串');
    }
    try {
      return this.wrap('file/listDir', this.fileService.listDir(projectPath, relPath));
    } catch (err) {
      console.error('[file/listDir] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** file/readFile：读文本文件。relPath 缺省视为 ''= 目录 → 6106 */
  private readFile(params: unknown): RpcResult {
    const projectPath = requireString(params, 'path');
    if (projectPath === null) {
      return fail(6101, '参数错误：path 必须为非空字符串');
    }
    const relPath = optionalRelPath(params, 'relPath');
    if (relPath === null || relPath.trim() === '') {
      return fail(6101, '参数错误：relPath 必须为非空字符串');
    }
    try {
      return this.wrap('file/readFile', this.fileService.readFile(projectPath, relPath));
    } catch (err) {
      console.error('[file/readFile] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /** file/searchFiles：按文件名过滤。空 query 不进服务层（不扫盘） */
  private searchFiles(params: unknown): RpcResult {
    const projectPath = requireString(params, 'path');
    if (projectPath === null) {
      return fail(6101, '参数错误：path 必须为非空字符串');
    }
    const query = requireString(params, 'query');
    if (query === null) {
      return fail(6101, '参数错误：query 必须为非空字符串');
    }
    try {
      return this.wrap('file/searchFiles', this.fileService.searchFiles(projectPath, query));
    } catch (err) {
      console.error('[file/searchFiles] internal error', err);
      return fail(5000, 'internal error');
    }
  }

  /**
   * file/watchSync：以传入集合为准对齐「已打开文件」的磁盘监听。
   *
   * 渲染层在打开/关闭文件后发**该项目**的全量 relPaths；本方法逐条过 resolveInside
   * （与 readFile 同一道越界校验，6103/6104 的条目静默剔除——读的时刻会自然暴露），
   * 然后交 OpenFileWatcher 做目录级 diff。磁盘变化经 deps.events 发
   * `code.fileChanged` {projectPath, relPath}。空 relPaths = 该项目全部关闭监听。
   */
  private watchSync(params: unknown): RpcResult {
    const projectPath = requireString(params, 'path');
    if (projectPath === null) {
      return fail(6101, '参数错误：path 必须为非空字符串');
    }
    const relPathsRaw = isRecord(params) ? params['relPaths'] : undefined;
    if (!Array.isArray(relPathsRaw) || relPathsRaw.some((r) => typeof r !== 'string')) {
      return fail(6101, '参数错误：relPaths 必须为字符串数组');
    }
    const entries: WatchEntry[] = [];
    for (const rel of relPathsRaw as string[]) {
      try {
        const r = resolveInside(projectPath, rel);
        if (r.ok) entries.push({ projectPath, relPath: r.rel, abs: r.abs });
        // 解析失败（文件已删/越界）：跳过。重读时 readFile 会给出确定的错误码。
      } catch (err) {
        console.error('[file/watchSync] internal error', err);
        return fail(5000, 'internal error');
      }
    }
    try {
      this.watcher.sync(entries);
      return ok({});
    } catch (err) {
      console.error('[file/watchSync] internal error', err);
      return fail(5000, 'internal error');
    }
  }
}

/**
 * 创建 FileApi 实例（工厂）。
 * @param deps 项目注册判定 + 可选服务替身
 */
export function createFileApi(deps: FileApiDeps): FileApi {
  return new FileApi(deps);
}
