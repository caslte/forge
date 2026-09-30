/**
 * 内嵌终端 pty 服务（模块 10，docs/prd/10_embedded_terminal.md）。
 *
 * 职责边界（PRD §1.3 安全红线）：
 * - pty 只在主进程 spawn；渲染进程零文件系统/进程权限，只经 term/* RPC 驱动。
 * - spawn 目标固定为**系统 shell**（Windows `%COMSPEC%`，Unix `$SHELL` 回退 bash），
 *   不接受渲染层传入任何可执行路径（TD-TM-05）。
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
 * 系统默认 shell（TD-TM-05 方案 A，不做选择 UI）：
 * Windows 取 %COMSPEC%（即 pwsh/cmd 由系统定），Unix 取 $SHELL 回退 bash。
 * 变量缺失时仍回落到通用名——spawn 失败会以 5000 透传原因，不在这里造假路径。
 */
export function resolveSystemShell(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') {
    return process.env.COMSPEC ?? 'cmd.exe';
  }
  return process.env.SHELL ?? '/bin/bash';
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
  const resolveShell = deps.resolveShell ?? (() => resolveSystemShell());
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
      /** 参数：{ cwd: string; cols?: number; rows?: number } → { ptyId, shell, pid } */
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
        const shell = resolveShell();
        const id = randomUUID();
        try {
          const spawnPty = await getSpawn();
          const ptyProcess = spawnPty(shell, [], {
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
