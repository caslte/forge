/**
 * 内置代码浏览器 · 文件系统服务（模块 12，docs/prd/12_code_explorer.md §5）。
 *
 * 职责：为渲染进程的「项目视角代码树 + 只读查看器」提供三条只读能力：
 * - listDir：列单层目录（懒加载口径，展开节点才读）
 * - readFile：读文本文件（含截断与二进制降级）
 * - searchFiles：按**文件名**过滤（本期明确不做内容搜索）
 *
 * 安全边界（本文件的核心，也是这个服务唯一的存在理由）：
 * 渲染进程传来的 `relPath` 一律视为**不可信输入**。任何一次触碰磁盘前都过
 * `resolveInside()`：先 `path.resolve` 做词法包含判定，再用 `fs.realpath` 解析
 * 符号链接后**再做一次**包含判定。两道判定缺一不可——只做前者，符号链接能直接
 * 把读取引到项目外（`ln -s /etc/passwd project/secret`）；只做后者，中途不存在
 * 的路径与 `../` 会在 realpath 处以 ENOENT 抛出，错误码与语义都不对。
 *
 * 只读：本服务不提供任何写入方法，写入能力（另存/保存）走独立通道且需用户确认。
 *
 * 纯 Node，不 import Electron / Vue / pi。
 */

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

// ── 阈值与错误码 ────────────────────────────────────────────────────────────

/** 读取体积上限：超过则只返回前段字节并标记 truncatedBy='bytes' */
export const MAX_READ_BYTES = 2 * 1024 * 1024;
/** 读取行数上限：超过则只返回前 N 行并标记 truncatedBy='lines' */
export const MAX_READ_LINES = 50_000;
/** 二进制嗅探取样字节数 */
export const BINARY_SNIFF_BYTES = 8_000;
/** searchFiles 单次返回条数上限 */
export const MAX_SEARCH_RESULTS = 300;
/** searchFiles 遍历深度上限（相对项目根） */
export const MAX_SEARCH_DEPTH = 12;
/** searchFiles 访问节点上限（防超大仓库把主进程转满 CPU） */
export const MAX_SEARCH_NODES = 20_000;

/** file 域错误码（顺延 git 600x / pi 60xx 之后的 61xx 段） */
export const FILE_ERROR = {
  /** 6101 参数错误 */
  INVALID_PARAMS: 6101,
  /** 6102 项目未注册 */
  PROJECT_NOT_FOUND: 6102,
  /** 6103 路径越界（安全拒绝，绝不落到磁盘） */
  PATH_ESCAPE: 6103,
  /** 6104 目标不存在 */
  NOT_FOUND: 6104,
  /** 6105 类型不符（对目录 listDir / 对文件 readFile） */
  NOT_A_DIRECTORY: 6105,
  NOT_A_FILE: 6106,
  /** 6107 读取失败（IO / 权限） */
  READ_FAILED: 6107,
} as const;

/** file 域服务返回信封：与 RpcResult 同构，但 data 有类型 */
export type FileResult<T> = { ok: true; data: T } | { ok: false; code: number; message: string };

function fail(code: number, message: string): { ok: false; code: number; message: string } {
  return { ok: false, code, message };
}

// ── 忽略规则 ────────────────────────────────────────────────────────────────

/**
 * 内置忽略项（不经 .gitignore 也永远不出现）。
 * 这些目录体量大且对「读代码」零价值：node_modules 单目录就能塞进几十万文件，
 * 一次 readdir 就能把主进程 IO 队列堵住。dist/release 同理（构建产物，与源码重复）。
 */
export const DEFAULT_IGNORES: readonly string[] = [
  'node_modules',
  '.git',
  '.sisyphus',
  'dist',
  'release',
  'out',
  'coverage',
  'test-results',
  'playwright-report',
  '.next',
  '.nuxt',
  '.turbo',
  '.cache',
  '.venv',
  '__pycache__',
  '.DS_Store',
  'Thumbs.db',
];

/**
 * 编译一条 gitignore 行为正则。
 *
 * 只实现本项目实际会用到的子集（够用且可预测 > 全量且易错）：
 * - 前导 `!` 取反
 * - 尾随 `/` 仅目录
 * - 前导 `/` 锚定到项目根
 * - 中部 `/` 锚定（否则 basename 匹配）
 * - 通配 `*`（不跨 `/`）、`?`、`**`（跨 `/`）
 * - 尾随 `/**` = 匹配目录内全部内容
 *
 * 语义遵循 gitignore「最后一条命中者生效」：调用方按 pattern 顺序累积，
 * 每次匹配都覆盖上一条的结果（取反项因此天然正确）。
 */
function compileIgnorePattern(raw: string): IgnoreRule | null {
  let pat = raw.trim();
  if (pat === '' || pat.startsWith('#')) return null;
  const negated = pat.startsWith('!');
  if (negated) pat = pat.slice(1);
  const dirOnly = pat.endsWith('/');
  if (dirOnly) pat = pat.slice(0, -1);
  if (pat === '') return null;

  // 锚定判定必须在剥掉尾部 `/**` 之前做：gitignore 规定「除尾随 / 外，含 / 即锚定」，
  // 而 `docs/**` 的 `/` 在中部 → 锚定到根。先剥再去判会把 docs/** 误当成 basename 规则。
  const anchored = pat.startsWith('/') || pat.slice(0, -1).includes('/');
  if (pat.startsWith('/')) pat = pat.slice(1);

  // 尾随 `/**`：目录本身及其下全部内容都命中
  const underOnly = pat.endsWith('/**');
  if (underOnly) pat = pat.slice(0, -3);
  if (pat === '') return null;

  let body = '';
  for (let i = 0; i < pat.length; i += 1) {
    const ch = pat[i] as string;
    if (ch === '*') {
      if (pat[i + 1] === '*') {
        // `**/` 跨目录；`**` 结尾已在上面处理
        if (pat[i + 2] === '/') {
          body += '(?:.*/)?';
          i += 2;
        } else {
          body += '.*';
          i += 1;
        }
      } else {
        body += '[^/]*';
      }
      continue;
    }
    if (ch === '?') {
      body += '[^/]';
      continue;
    }
    body += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  if (underOnly) body += '(?:/.*)?';

  // anchored：整条路径必须匹配；非 anchored：任意一层目录名/文件名匹配即可
  const prefix = anchored ? '^' : '^(?:.*/)?';
  return { re: new RegExp(`${prefix}${body}$`), negated, dirOnly };
}
export interface IgnoreMatcher {
  /** relPath 用 POSIX 分隔符；isDir 参与 dirOnly 判定 */
  ignores(relPath: string, isDir: boolean): boolean;
  /** 目录剪枝：命中即整棵子树不进（比逐文件判断省一个数量级的 stat） */
  prunesDir(relPath: string): boolean;
}

/** 编译后的 ignore 规则 */
type IgnoreRule = { re: RegExp; negated: boolean; dirOnly: boolean };

/** 类型守卫：过滤掉未编译成功的 pattern */
function isIgnoreRule(v: IgnoreRule | null): v is IgnoreRule {
  return v !== null;
}

/**
 * 构建忽略匹配器：内置表 + 项目根 .gitignore。
 * @param patterns 额外 pattern（已在 service 内部从 .gitignore 读出并 trim）
 */
export function compileIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const rules: IgnoreRule[] = DEFAULT_IGNORES.map((name) => compileIgnorePattern(name)).filter(isIgnoreRule);
  for (const p of patterns) {
    const rule = compileIgnorePattern(p);
    if (rule !== null) rules.push(rule);
  }

  const match = (relPath: string, isDir: boolean): boolean | null => {
    let hit: boolean | null = null;
    for (const rule of rules) {
      if (rule.dirOnly && !isDir) {
        // 目录专属规则（如 build/）：文件不参与，但要让文件路径去命中祖先目录
        // —— 由 callers 通过 prunesDir 在遍历期剪枝，这里跳过避免误伤同名文件。
        continue;
      }
      if (rule.re.test(relPath)) hit = !rule.negated;
    }
    return hit;
  };

  return {
    ignores(relPath, isDir) {
      if (relPath === '') return false;
      return match(relPath, isDir) === true;
    },
    prunesDir(relPath) {
      if (relPath === '') return false;
      return match(relPath, true) === true;
    },
  };
}

/** 读项目根 .gitignore（不存在/读失败一律按空处理，不影响主流程） */
export function readGitignorePatterns(root: string): string[] {
  try {
    const raw = fs.readFileSync(path.join(root, '.gitignore'), 'utf8');
    return raw.split(/\r?\n/);
  } catch {
    return [];
  }
}

// ── 路径安全 ────────────────────────────────────────────────────────────────

/** 归一为 POSIX 分隔符的相对路径（'' 表示项目根自身） */
export function toPosixRel(root: string, abs: string): string {
  const rel = path.relative(root, abs);
  return rel === '' ? '' : rel.split(path.sep).join('/');
}

/** 从磁盘分隔符形态（Windows 上可能是 `packages\forge-ui`）归一为 POSIX */
export function normalizeRelPath(input: string): string {
  return input
    .split(/[\\/]+/)
    .filter((seg) => seg !== '' && seg !== '.')
    .join('/');
}

/** 判断 child 是否等于 root 或位于 root 之内（已归一，无 realpath 语义） */
function isInside(root: string, child: string): boolean {
  if (child === root) return true;
  const rel = path.relative(root, child);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * 相对项目根路径 → 绝对路径，两道 containment 校验。
 *
 * 失败时返回具体错误码，让调用方能区分「越界」（安全事件，值得记日志）
 * 与「不存在」（正常业务）。**任何 ENOENT 都不在此函数内吞**——调用方据此映射 6104。
 */
export function resolveInside(
  root: string,
  relPath: string,
): { ok: true; abs: string; rel: string } | { ok: false; code: number; message: string } {
  const rel = normalizeRelPath(relPath);

  // 第一道：纯词法。挡掉绝对路径、盘符、`../` 穿越（C:/foo、D:\foo、/etc/passwd）
  if (/^[A-Za-z]:/.test(relPath) || relPath.startsWith('/') || relPath.startsWith('\\')) {
    return fail(FILE_ERROR.PATH_ESCAPE, `路径必须是项目内的相对路径: ${relPath}`);
  }
  const abs = path.resolve(root, rel);
  if (!isInside(root, abs)) {
    return fail(FILE_ERROR.PATH_ESCAPE, `路径越界: ${relPath}`);
  }

  // 第二道：realpath。挡掉符号链接逃逸。目录不存在的情形归 6104 而非 6103。
  let real: string;
  try {
    real = fs.realpathSync.native(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') {
      return fail(FILE_ERROR.NOT_FOUND, `路径不存在: ${rel || '.'}`);
    }
    return fail(FILE_ERROR.READ_FAILED, `无法解析路径: ${rel || '.'}`);
  }
  if (!isInside(root, real)) {
    return fail(FILE_ERROR.PATH_ESCAPE, `路径经符号链接后越界: ${relPath}`);
  }
  return { ok: true, abs: real, rel: toPosixRel(root, real) };
}

// ── 二进制 / 编码判定 ───────────────────────────────────────────────────────

/** 常见二进制扩展名（不读全文件就能下结论，省一次 IO） */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.avif', '.tiff',
  '.pdf', '.zip', '.gz', '.tar', '.bz2', '.xz', '.7z', '.rar', '.jar', '.war',
  '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.class', '.pyc', '.wasm',
  '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mov', '.mkv', '.webm',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.db', '.sqlite', '.sqlite3', '.mdb', '.dat', '.pack', '.idx',
  '.psd', '.ai', '.sketch', '.fig',
]);

/**
 * 二进制嗅探：NUL 字节 + 非法 UTF-8 序列。
 *
 * 只查 NUL 会漏掉一部分无 NUL 的二进制（部分图片/压缩流），所以再跑一次 UTF-8
 * 合法性校验：非法字节占比超过 5% 即判二进制。取样上限 BINARY_SNIFF_BYTES，
 * 避免为判定读完整个 2MB 文件。
 */
export function looksBinary(head: Buffer, ext: string): boolean {
  if (BINARY_EXTENSIONS.has(ext.toLowerCase())) return true;
  if (head.length === 0) return false;
  if (head.includes(0)) return true;
  const text = head.toString('utf8');
  // U+FFFD = 非法序列被替换后的产物
  let bad = 0;
  for (const ch of text) {
    if (ch === '�') bad += 1;
  }
  return bad / text.length > 0.05;
}

// ── 类型 ────────────────────────────────────────────────────────────────────

export interface FileNode {
  /** 文件/目录名（单段，不含路径） */
  name: string;
  /** 相对项目根的 POSIX 路径 */
  relPath: string;
  kind: 'file' | 'dir';
  /** 字节数（目录为 0） */
  size: number;
  /** 修改时间（ms，目录为 0） */
  mtimeMs: number;
}

export interface ListDirData {
  /** 本次列举的目录相对路径（'' = 项目根） */
  relPath: string;
  nodes: FileNode[];
  /** 过滤前实际条目数（UI 可显示「已隐藏 N 项」） */
  hidden: number;
}

export type TruncatedBy = 'bytes' | 'lines' | null;

export interface ReadFileData {
  /** 相对项目根的 POSIX 路径（与请求一致，realpath 归一后） */
  relPath: string;
  /** 文件名（UI 标签页用） */
  name: string;
  /** 正文（binary=true 时为 ''） */
  content: string;
  /** 实际返回行数 */
  lineCount: number;
  /** 换行符类型（按全文采样判定） */
  eol: 'lf' | 'crlf' | 'mixed';
  /** 文件总字节数 */
  size: number;
  mtimeMs: number;
  /** 是否二进制（二进制时 content 为空串，由 UI 渲染降级态） */
  binary: boolean;
  /** 是否截断 */
  truncated: boolean;
  truncatedBy: TruncatedBy;
  /** 截断前的总行数（未截断时等于 lineCount） */
  totalLines: number;
}

export interface SearchFilesData {
  /** 命中的文件（按路径深度、再按字典序） */
  files: string[];
  /** 因触达上限而提前停止 */
  limitReached: boolean;
}

// ── 服务 ────────────────────────────────────────────────────────────────────

export interface FileServiceOptions {
  /**
   * 项目注册判定：返回 true 表示 path 已是 forge 中注册的项目。
   * 由 RPC 层注入（与 gitMethods 同口径，AC-10-06 的 cwd containment 复用同一判断）。
   */
  isProjectRegistered: (projectPath: string) => boolean;
}

/**
 * 文件系统服务。三个方法全部同步（小规模只读 IO，Electron 主进程侧无阻塞顾虑），
 * 返回 FileResult 而非直接抛错——错误码是契约的一部分。
 */
export class FileService {
  private readonly isProjectRegistered: (projectPath: string) => boolean;
  /** 每项目的 ignore 匹配器缓存（.gitignore 内容按项目缓存，不重复读盘） */
  private readonly matcherCache = new Map<string, IgnoreMatcher>();

  constructor(options: FileServiceOptions) {
    this.isProjectRegistered = options.isProjectRegistered;
  }

  /** 项目根 + ignore 匹配器（缓存） */
  private rootGuard(projectPath: string): { ok: true; root: string; matcher: IgnoreMatcher } | { ok: false; code: number; message: string } {
    let root: string;
    try {
      root = fs.realpathSync.native(projectPath);
    } catch {
      return fail(FILE_ERROR.PROJECT_NOT_FOUND, `项目路径不可达: ${projectPath}`);
    }
    if (!this.isProjectRegistered(root)) {
      return fail(FILE_ERROR.PROJECT_NOT_FOUND, `项目未注册: ${projectPath}`);
    }
    let matcher = this.matcherCache.get(root);
    if (matcher === undefined) {
      matcher = compileIgnoreMatcher(readGitignorePatterns(root));
      this.matcherCache.set(root, matcher);
    }
    return { ok: true, root, matcher };
  }

  /** 丢弃某项目的 ignore 缓存（.gitignore 改动后由 UI 重新进入代码态时调用） */
  invalidate(projectPath: string): void {
    try {
      this.matcherCache.delete(fs.realpathSync.native(projectPath));
    } catch {
      this.matcherCache.delete(projectPath);
    }
  }

  /**
   * 列单层目录。目录优先、组内按名称本地化排序（'a' < 'B' 的 ASCII 序对用户是噪音）。
   */
  listDir(projectPath: string, relPath: string): FileResult<ListDirData> {
    const guard = this.rootGuard(projectPath);
    if (!guard.ok) return guard;
    const resolved = resolveInside(guard.root, relPath);
    if (!resolved.ok) return resolved;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved.abs, { withFileTypes: true });
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOTDIR') return fail(FILE_ERROR.NOT_A_DIRECTORY, `不是目录: ${resolved.rel || '.'}`);
      if (code === 'ENOENT') return fail(FILE_ERROR.NOT_FOUND, `路径不存在: ${resolved.rel || '.'}`);
      return fail(FILE_ERROR.READ_FAILED, `无法读取目录: ${resolved.rel || '.'}`);
    }

    const nodes: FileNode[] = [];
    let hidden = 0;
    for (const entry of entries) {
      const childRel = resolved.rel === '' ? entry.name : `${resolved.rel}/${entry.name}`;
      const isDir = entry.isDirectory();
      // 目录剪枝：命中即整棵子树不进，节省 stat 与后续 readdir
      if (isDir ? guard.matcher.prunesDir(childRel) : guard.matcher.ignores(childRel, false)) {
        hidden += 1;
        continue;
      }
      let size = 0;
      let mtimeMs = 0;
      try {
        const st = fs.statSync(path.join(resolved.abs, entry.name));
        size = st.size;
        mtimeMs = st.mtimeMs;
      } catch {
        // 断链 / 权限 / 竞态删除：仍然展示条目（用户能看到「有个文件但读不了」），
        // 只是拿不到大小。code tree 里的 broken-symlink 正是这种形态。
      }
      nodes.push({ name: entry.name, relPath: childRel, kind: isDir ? 'dir' : 'file', size, mtimeMs });
    }

    nodes.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
    });
    return { ok: true, data: { relPath: resolved.rel, nodes, hidden } };
  }

  /**
   * 读文本文件。
   *
   * 降级口径（对应 PRD §5.3 / §5.4）：
   * - 二进制 → content='' + binary=true，UI 渲染「不支持预览」并给外部编辑器入口
   * - > 2MB 或 > 5 万行 → 截断 + truncated=true，底栏显示实际/总行数
   * - 路径已删 → 6104，UI 渲染「文件已删除」并把标签页标记失效
   */
  readFile(projectPath: string, relPath: string): FileResult<ReadFileData> {
    const guard = this.rootGuard(projectPath);
    if (!guard.ok) return guard;
    const resolved = resolveInside(guard.root, relPath);
    if (!resolved.ok) return resolved;

    let st: fs.Stats;
    try {
      st = fs.statSync(resolved.abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return fail(FILE_ERROR.NOT_FOUND, `文件不存在: ${resolved.rel}`);
      return fail(FILE_ERROR.READ_FAILED, `无法访问文件: ${resolved.rel}`);
    }
    if (st.isDirectory()) return fail(FILE_ERROR.NOT_A_FILE, `是目录而非文件: ${resolved.rel}`);

    let buf: Buffer;
    try {
      buf = fs.readFileSync(resolved.abs);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EISDIR') return fail(FILE_ERROR.NOT_A_FILE, `是目录而非文件: ${resolved.rel}`);
      return fail(FILE_ERROR.READ_FAILED, `读取失败: ${resolved.rel}`);
    }

    const name = resolved.rel.slice(resolved.rel.lastIndexOf('/') + 1);
    const ext = path.extname(name);
    const base: ReadFileData = {
      relPath: resolved.rel,
      name,
      content: '',
      lineCount: 0,
      eol: 'lf',
      size: st.size,
      mtimeMs: st.mtimeMs,
      binary: false,
      truncated: false,
      truncatedBy: null,
      totalLines: 0,
    };

    if (looksBinary(buf.subarray(0, BINARY_SNIFF_BYTES), ext)) {
      return { ok: true, data: { ...base, binary: true } };
    }

    // 字节超限：先切字节再解码，避免为 500MB 文件分配等量字符串
    let work = buf;
    let truncatedBy: TruncatedBy = null;
    if (buf.length > MAX_READ_BYTES) {
      work = buf.subarray(0, MAX_READ_BYTES);
      truncatedBy = 'bytes';
    }
    let text = work.toString('utf8');
    let totalLines = 0;

    if (truncatedBy === null) {
      totalLines = countLines(text);
      if (totalLines > MAX_READ_LINES) {
        truncatedBy = 'lines';
        // 行截断：按行边界切，避免把第 N 行腰斩成半个 token
        const cut = text.split('\n', MAX_READ_LINES).join('\n');
        text = cut;
      }
    } else {
      // 字节截断下的 totalLines 只作参考：至少给出已读部分的行数
      totalLines = countLines(text);
    }

    const eol = detectEol(text);
    return {
      ok: true,
      data: {
        ...base,
        content: text,
        lineCount: countLines(text),
        eol,
        truncated: truncatedBy !== null,
        truncatedBy,
        totalLines: truncatedBy === 'lines' ? totalLines : countLines(text),
      },
    };
  }

  /**
   * 按文件名过滤（子串，大小写不敏感）。
   *
   * 只搜文件名是**刻意的范围裁剪**：内容搜索要处理大小文件、编码、ignore 语义与
   * 结果排序，成本与风险都高一个量级，而本期用户诉求是「找到那个文件并打开」，
   * 不是「找到那句话在哪」。空 query 返回空数组（不扫盘）。
   */
  searchFiles(projectPath: string, query: string): FileResult<SearchFilesData> {
    const guard = this.rootGuard(projectPath);
    if (!guard.ok) return guard;
    const q = query.trim().toLowerCase();
    if (q === '') return { ok: true, data: { files: [], limitReached: false } };

    const files: string[] = [];
    let limitReached = false;
    let visited = 0;

    const walk = (dirAbs: string, dirRel: string, depth: number): void => {
      if (limitReached || depth > MAX_SEARCH_DEPTH || visited >= MAX_SEARCH_NODES) {
        if (visited >= MAX_SEARCH_NODES) limitReached = true;
        return;
      }
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dirAbs, { withFileTypes: true });
      } catch {
        return; // 权限/断链：静默跳过，不让单个坏目录废掉整次搜索
      }
      for (const entry of entries) {
        if (limitReached) return;
        visited += 1;
        if (visited >= MAX_SEARCH_NODES) {
          limitReached = true;
          return;
        }
        const childRel = dirRel === '' ? entry.name : `${dirRel}/${entry.name}`;
        if (entry.isDirectory()) {
          if (guard.matcher.prunesDir(childRel)) continue;
          walk(path.join(dirAbs, entry.name), childRel, depth + 1);
          continue;
        }
        if (!entry.isFile()) continue;
        if (guard.matcher.ignores(childRel, false)) continue;
        if (entry.name.toLowerCase().includes(q)) files.push(childRel);
      }
    };

    walk(guard.root, '', 0);
    files.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b, 'zh-CN'));
    const capped = files.slice(0, MAX_SEARCH_RESULTS);
    return { ok: true, data: { files: capped, limitReached: limitReached || files.length > MAX_SEARCH_RESULTS } };
  }
}

/** 行数：末尾有换行时不额外计一个空行（编辑器口径） */
function countLines(text: string): number {
  if (text === '') return 0;
  let n = 1;
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) n += 1;
  }
  return text.endsWith('\n') ? n - 1 : n;
}

/** 换行符判定：全 LF / 全 CRLF / 混用 */
function detectEol(text: string): 'lf' | 'crlf' | 'mixed' {
  const sample = text.length > 8192 ? text.slice(0, 8192) : text;
  let lf = 0;
  let crlf = 0;
  for (let i = 0; i < sample.length; i += 1) {
    if (sample.charCodeAt(i) === 10) {
      if (i > 0 && sample.charCodeAt(i - 1) === 13) crlf += 1;
      else lf += 1;
    }
  }
  if (lf === 0 && crlf === 0) return 'lf';
  if (lf === 0) return 'crlf';
  if (crlf === 0) return 'lf';
  return 'mixed';
}

/** 供 UI 复用：把绝对路径转成展示用相对 POSIX 路径（截断超长前缀） */
export function displayRelPath(root: string, abs: string, maxSegments = 4): string {
  const rel = toPosixRel(root, abs);
  const segs = rel.split('/');
  if (segs.length <= maxSegments) return rel;
  return `…/${segs.slice(-maxSegments).join('/')}`;
}

/** 异步 stat 的薄封装（UI 预览图片大小时用，避免同步 IO 阻塞事件循环） */
export async function statSize(abs: string): Promise<number> {
  try {
    return (await fsp.stat(abs)).size;
  } catch {
    return 0;
  }
}
