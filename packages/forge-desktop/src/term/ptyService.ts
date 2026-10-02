/**
 * 内嵌终端 pty 服务（模块 10，docs/prd/10_embedded_terminal.md）。
 *
 * 职责边界（PRD §1.3 安全红线）：
 * - pty 只在主进程 spawn；渲染进程零文件系统/进程权限，只经 term/* RPC 驱动。
 * - spawn 目标固定为**主进程解析的系统 shell**（Windows：pwsh → powershell →
 *   %COMSPEC% 优先级链；Unix `$SHELL` 回退 bash），不接受渲染层传入任何可执行路径
 *   （TD-TM-05，2026-10-02 修订）。
 * - cwd 必须存在于主进程已知的项目路径集合（containment 经注入端口强制，AC-10-06）
 *   且目录真实存在，否则拒绝。
 * - 数据通道（TD-TM-03）：下行事件 term:data / term:exit 经注入的 emit（= core eventBus）
 *   广播，上行输入/生命周期走本文件 methods（invoke 路由）。
 *
 * node-pty 不在模块顶层静态 import：默认 spawn 端口首次使用时才动态加载
 * （@lydell/node-pty N-API prebuilds，spike 2026-09-23 验证 Electron 主进程可直用；
 *   启动链纪律要求 main 装配路径不引入同步重活）。测试经 deps.spawnPty 注入 fake，
 * 无需原生模块。
 */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { normalizeProjectPath, type RpcResult } from '@forge/core';

/** node-pty IPty 的最小使用面（测试 fake 对齐此形状即可） */
export interface PtyLike {
  readonly pid: number;
  write(data: string): void;
  resize(columns: number, rows: number): void;
  kill(signal?: string): void;
  onData(listener: (data: string) => void): void;
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void;
}

/** spawn 参数（字段对齐 node-pty IBasePtyForkOptions 实际用到的子集） */
export interface PtySpawnOptions {
  name: string;
  cols: number;
  rows: number;
  cwd: string;
  env: { [key: string]: string | undefined };
}

export type SpawnPty = (file: string, args: string[], options: PtySpawnOptions) => PtyLike;

/** term 域事件名（与 ipc-contract ForgeEvent 登记一致） */
export type TermEventName = 'term:data' | 'term:exit';

export interface TermDataPayload {
  ptyId: string;
  data: string;
}

export interface TermExitPayload {
  ptyId: string;
  exitCode: number;
}

export interface TermServiceDeps {
  /** cwd containment：路径是否为已注册项目根（口径同 git 方法：normalize 后与项目列表比对） */
  isKnownProjectPath: (cwd: string) => boolean;
  /** 事件出口（createForgeCore 接 eventBus；FORGE_EVENTS 已登记 term:data/term:exit） */
  emit: (event: TermEventName, payload: TermDataPayload | TermExitPayload) => void;
  /** 测试接缝：替换 pty spawn（缺省动态加载 @lydell/node-pty） */
  spawnPty?: SpawnPty;
  /** 测试接缝：替换系统 shell 解析 */
  resolveShell?: () => string;
  /** 测试接缝：替换「钉住 shell id → 可执行路径」解析（缺省 resolveShellByPref + 真实 fs） */
  resolveShellByPref?: (pref: TerminalShellId) => string | null;
  /** 生命周期日志出口（缺省 console.log；英文，含 ptyId/cwd/shell，PRD §3.5 可观测性） */
  logger?: (line: string) => void;
}

export interface TermService {
  /** term/create|write|kill|resize 方法映射（合入 createForgeCore methodTable） */
  methods: Record<string, (params: unknown) => Promise<RpcResult>>;
  /** 全量回收：app before-quit 与渲染文档重载（孤儿对账，PRD TM-F03 异常边界） */
  killAll: () => void;
}

/** term/create 响应 data */
export interface TermCreateResult {
  ptyId: string;
  shell: string;
  pid: number;
}

const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

/** 临时诊断（模块10 断链排查，定位后删除） */
const diagChunks = new Map<string, number>();

function ok<T>(data: T): RpcResult<T> {
  return { code: 0, message: 'success', data };
}

function fail(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/**
 * 系统 shell（TD-TM-05 方案 A，2026-10-02 修订为优先级链，仍不做选择 UI）：
 * Windows 依次探测 pwsh（PowerShell 7，对齐用户独立终端体验——`./xxx.ps1` 直跑、
 * PSReadLine 补全）→ powershell（系统必装的 5.1）→ %COMSPEC%（cmd 兜底，不差于
 * 旧版）；Unix 取 $SHELL 回退 bash。探测 = PATH 逐目录 + 标准安装位的存在性检查，
 * 命中即返回绝对路径——把「shell 在不在」挡在 spawn 之前；全链未命中仍回落
 * %COMSPEC% 通用名，spawn 失败才以 5000 透传原因，不在这里造假路径。
 */
export function resolveSystemShell(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string {
  if (platform !== 'win32') {
    return process.env.SHELL ?? '/bin/bash';
  }
  for (const candidate of windowsShellCandidates(process.env)) {
    if (exists(candidate)) return candidate;
  }
  return process.env.COMSPEC ?? 'cmd.exe';
}

/** PATH 逐目录展开（去引号/去空项；Windows 分隔符 ';'） */
function pathDirs(env: NodeJS.ProcessEnv): string[] {
  return (env.PATH ?? env.Path ?? '')
    .split(';')
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter((dir) => dir !== '');
}

/** pwsh 档候选：PATH 逐目录优先，标准安装位补漏（MSI 默认 / Store 别名） */
export function pwshShellCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = pathDirs(env).map((dir) => join(dir, 'pwsh.exe'));
  for (const root of [env.ProgramFiles, env['ProgramFiles(x86)']]) {
    if (root) candidates.push(join(root, 'PowerShell', '7', 'pwsh.exe'));
  }
  if (env.LOCALAPPDATA) {
    candidates.push(join(env.LOCALAPPDATA, 'Microsoft', 'WindowsApps', 'pwsh.exe'));
  }
  return candidates;
}

/** powershell 档候选：PATH（System32\WindowsPowerShell\v1.0 常驻）+ SystemRoot 绝对路径兜底 */
export function powershellShellCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  const candidates = pathDirs(env).map((dir) => join(dir, 'powershell.exe'));
  if (env.SystemRoot) {
    candidates.push(join(env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
  }
  return candidates;
}

/** pwsh → powershell 的有序候选绝对路径（两档拼接） */
export function windowsShellCandidates(env: NodeJS.ProcessEnv = process.env): string[] {
  return [...pwshShellCandidates(env), ...powershellShellCandidates(env)];
}

/** 设置页「终端 Shell」的枚举 id（渲染层只传 id，可执行路径永远由主进程解析，TD-TM-05） */
export type TerminalShellId = 'auto' | 'pwsh' | 'powershell' | 'cmd';

export const TERMINAL_SHELL_IDS: readonly TerminalShellId[] = ['auto', 'pwsh', 'powershell', 'cmd'];

/**
 * 按设置钉住的 shell id 解析可执行路径（纯函数，exists 注入可测）：
 * 'auto' → 优先级链；'pwsh'/'powershell' → 档内第一个存在者，全缺返回 null（由调用方
 * 回退链）；'cmd' → %COMSPEC% ?? 'cmd.exe'（兜底分支永不为 null，与旧版口径一致）。
 * 非 Windows 钉任何档都回链——候选探测只覆盖 Windows。
 */
export function resolveShellByPref(
  pref: TerminalShellId,
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): string | null {
  if (pref === 'auto' || platform !== 'win32') {
    return resolveSystemShell(platform, exists);
  }
  if (pref === 'cmd') {
    return process.env.COMSPEC ?? 'cmd.exe';
  }
  const candidates = pref === 'pwsh' ? pwshShellCandidates() : powershellShellCandidates();
  return candidates.find((candidate) => exists(candidate)) ?? null;
}

/** 已安装终端 shell（设置页选项数据源）；形状对齐 shell/editorScan 的 InstalledEditor */
export interface InstalledShell {
  id: Exclude<TerminalShellId, 'auto'>;
  label: string;
  exe: string;
}

/** 档位 → 展示名（产品名，不本地化——同 editorScan 的 label 口径） */
const SHELL_LABELS: Record<InstalledShell['id'], string> = {
  pwsh: 'PowerShell 7',
  powershell: 'Windows PowerShell',
  cmd: 'cmd',
};

/**
 * 本机已安装的终端 shell 目录，档序即优先级序（pwsh → powershell → cmd；cmd 为
 * 兜底档恒在）。调用方（main）剥掉 exe 只回 {id,label}。Unix 返回空列表（设置页
 * 只剩「跟随系统默认」）。
 */
export function collectInstalledShells(
  platform: NodeJS.Platform = process.platform,
  exists: (path: string) => boolean = existsSync,
): InstalledShell[] {
  if (platform !== 'win32') return [];
  const out: InstalledShell[] = [];
  const pwsh = pwshShellCandidates().find((candidate) => exists(candidate));
  if (pwsh !== undefined) out.push({ id: 'pwsh', label: SHELL_LABELS.pwsh, exe: pwsh });
  const powershell = powershellShellCandidates().find((candidate) => exists(candidate));
  if (powershell !== undefined) {
    out.push({ id: 'powershell', label: SHELL_LABELS.powershell, exe: powershell });
  }
  out.push({ id: 'cmd', label: SHELL_LABELS.cmd, exe: process.env.COMSPEC ?? 'cmd.exe' });
  return out;
}

/**
 * spawn 参数随 shell 走：PowerShell 系带 -NoLogo（开 tab 不打版本 banner），cmd /
 * Unix shell 无参。-NoProfile 故意不加：内嵌终端要的就是用户独立终端的同一体验
 * （profile 里的别名与 PSReadLine 配置照常生效）。
 */
export function shellSpawnArgs(shell: string): string[] {
  switch (basename(shell).toLowerCase()) {
    case 'pwsh.exe':
    case 'pwsh':
    case 'powershell.exe':
      return ['-NoLogo'];
    default:
      return [];
  }
}

/** 动态加载 node-pty（只在首次真实 spawn 时发生，测试路径永不触达） */
async function defaultSpawnPty(): Promise<SpawnPty> {
  const pty = await import('@lydell/node-pty');
  return (file, args, options) =>
    pty.spawn(file, args, options) as unknown as PtyLike;
}

interface PtyRecord {
  pty: PtyLike;
  shell: string;
  cwd: string;
  exited: boolean;
}

/** 正整数参数（cols/rows）；缺失回 default，非法返回 null */
function readPositiveInt(value: unknown, fallback: number): number | null {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  const n = Math.floor(value);
  return n > 0 ? n : null;
}

function readStringParam(params: unknown, key: string): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
}

/**
 * 构造 term/* RPC 方法与事件汇。pty 注册表按 ptyId 索引；kill/exit 幂等。
 * 错误码沿用全局口径：1001 参数错误 / 1002 cwd 非已注册项目 / 5000 spawn 失败。
 */
export function createTermService(deps: TermServiceDeps): TermService {
  const ptys = new Map<string, PtyRecord>();
  const log = deps.logger ?? ((line: string) => console.log('[term]', line));
  // 缺省 shell 解析带缓存：探测是同步 fs 扫描（PATH + 标准安装位），一次会话算一遍就够
  let cachedShell: string | null = null;
  const resolveShell = deps.resolveShell ?? (() => {
    if (cachedShell === null) cachedShell = resolveSystemShell();
    return cachedShell;
  });
  const shellByPref = deps.resolveShellByPref ?? ((pref: TerminalShellId) => resolveShellByPref(pref));
  let injectedSpawn: SpawnPty | null = deps.spawnPty ?? null;

  const getSpawn = async (): Promise<SpawnPty> => {
    if (injectedSpawn !== null) return injectedSpawn;
    injectedSpawn = await defaultSpawnPty();
    return injectedSpawn;
  };

  const doKill = (id: string, record: PtyRecord, reason: string): void => {
    if (record.exited) return;
    try {
      record.pty.kill();
    } catch (err) {
      // kill 失败（进程已消失等）不改变记账：onExit 可能不再来，直接按退出处理
      log(`pty kill failed (id=${id}, reason=${reason}): ${err instanceof Error ? err.message : String(err)}`);
    }
    log(`pty killed (id=${id}, shell=${record.shell}, cwd=${record.cwd}, reason=${reason})`);
  };

  return {
    methods: {
      /** 参数：{ cwd: string; cols?: number; rows?: number; shellId?: 'auto'|'pwsh'|'powershell'|'cmd' } → { ptyId, shell, pid } */
      'term/create': async (params: unknown) => {
        const cwd = readStringParam(params, 'cwd');
        if (cwd === null) {
          return fail(1001, '参数错误：cwd 必须为非空字符串');
        }
        const cols = readPositiveInt((params as { cols?: unknown } | null)?.cols, DEFAULT_COLS);
        const rows = readPositiveInt((params as { rows?: unknown } | null)?.rows, DEFAULT_ROWS);
        if (cols === null || rows === null) {
          return fail(1001, '参数错误：cols/rows 必须为正整数');
        }
        // 设置页「终端 Shell」（可选，缺省 auto=优先级链）。渲染层只传枚举 id——可执行
        // 路径由主进程解析（TD-TM-05 红线）；id 合法但本机未装 → 回退链 + 留日志，不阻塞开 tab。
        const shellId = readStringParam(params, 'shellId') ?? 'auto';
        if (!(TERMINAL_SHELL_IDS as readonly string[]).includes(shellId)) {
          return fail(1001, `参数错误：shellId 必须是 ${TERMINAL_SHELL_IDS.join('/')} 之一`);
        }
        // containment（AC-10-06）：normalizeProjectPath 完成 resolve + realpath + 目录
        // 存在性校验（不存在/非目录抛错），再比对主进程项目路径集合——伪造路径/
        // 未注册目录/路径穿越一律拒绝。spawn 用归一后的真实路径。
        let normalized: string;
        try {
          normalized = normalizeProjectPath(cwd);
        } catch {
          return fail(1002, `工作目录不存在或不是目录: ${cwd}`);
        }
        if (!deps.isKnownProjectPath(normalized)) {
          return fail(1002, `工作目录不是已注册项目根: ${normalized}`);
        }
        const pref = shellId as TerminalShellId;
        let shell = pref === 'auto' ? resolveShell() : shellByPref(pref);
        if (shell === null) {
          log(`shell pref '${pref}' not installed, falling back to system default`);
          shell = resolveShell();
        }
        const id = randomUUID();
        try {
          const spawnPty = await getSpawn();
          const ptyProcess = spawnPty(shell, shellSpawnArgs(shell), {
            name: 'xterm-256color',
            cols,
            rows,
            cwd: normalized,
            env: { ...process.env, TERM: 'xterm-256color' },
          });
          const record: PtyRecord = { pty: ptyProcess, shell, cwd: normalized, exited: false };
          ptys.set(id, record);
          ptyProcess.onData((data) => {
            // 临时诊断（模块10 断链排查，定位后删除）：每个 pty 只报前 3 块
            diagChunks.set(id, (diagChunks.get(id) ?? 0) + 1);
            const n = diagChunks.get(id)!;
            if (n <= 3) console.log(`[term-diag] onData #${n} (id=${id.slice(0, 8)}, bytes=${data.length})`);
            if (n === 3) diagChunks.delete(id);
            if (record.exited) return;
            deps.emit('term:data', { ptyId: id, data });
          });
          ptyProcess.onExit(({ exitCode }) => {
            record.exited = true;
            log(`pty exited (id=${id}, shell=${record.shell}, cwd=${record.cwd}, code=${exitCode})`);
            deps.emit('term:exit', { ptyId: id, exitCode });
          });
          log(`pty spawned (id=${id}, shell=${shell}, cwd=${normalized}, pid=${ptyProcess.pid}, cols=${cols}, rows=${rows})`);
          return ok<TermCreateResult>({ ptyId: id, shell, pid: ptyProcess.pid });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          log(`pty spawn failed (shell=${shell}, cwd=${normalized}): ${message}`);
          return fail(5000, `终端启动失败: ${message}`);
        }
      },

      /** 参数：{ ptyId: string; data: string }；写已退出/未知 pty 静默丢弃返回 0（PRD F04） */
      'term/write': async (params: unknown) => {
        const id = readStringParam(params, 'ptyId');
        const data = (params as { data?: unknown } | null)?.data;
        if (id === null || typeof data !== 'string') {
          return fail(1001, '参数错误：ptyId 必须为非空字符串且 data 为字符串');
        }
        const record = ptys.get(id);
        if (record !== undefined && !record.exited) {
          try {
            record.pty.write(data);
          } catch (err) {
            // 写竞态（刚退出未及记账等）按静默丢弃口径处理，仅留日志
            log(`pty write dropped (id=${id}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return ok(null);
      },

      /** 参数：{ ptyId: string; cols: number; rows: number }；死 pty 同样静默 */
      'term/resize': async (params: unknown) => {
        const id = readStringParam(params, 'ptyId');
        if (id === null) {
          return fail(1001, '参数错误：ptyId 必须为非空字符串');
        }
        const cols = readPositiveInt((params as { cols?: unknown } | null)?.cols, NaN);
        const rows = readPositiveInt((params as { rows?: unknown } | null)?.rows, NaN);
        if (cols === null || rows === null) {
          return fail(1001, '参数错误：cols/rows 必须为正整数');
        }
        const record = ptys.get(id);
        if (record !== undefined && !record.exited) {
          try {
            record.pty.resize(cols, rows);
          } catch (err) {
            log(`pty resize dropped (id=${id}): ${err instanceof Error ? err.message : String(err)}`);
          }
        }
        return ok(null);
      },

      /** 参数：{ ptyId: string }；幂等（已退出/未知 id 返回 0，PRD TM-F03） */
      'term/kill': async (params: unknown) => {
        const id = readStringParam(params, 'ptyId');
        if (id === null) {
          return fail(1001, '参数错误：ptyId 必须为非空字符串');
        }
        const record = ptys.get(id);
        if (record !== undefined) {
          doKill(id, record, 'tab-closed');
        }
        return ok(null);
      },
    },

    killAll: () => {
      for (const [id, record] of ptys) {
        doKill(id, record, 'app-cleanup');
      }
      ptys.clear();
    },
  };
}
