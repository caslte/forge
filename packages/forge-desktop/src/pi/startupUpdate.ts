/**
 * 首启静默预装 + 版本变化联动更新编排（docs/prd/07_installer_update.md IN-F02/IN-F04）。
 *
 * 由 main.ts 在 app.whenReady 内 fire-and-forget 挂接（后台静默，不阻塞启动）：
 * - 预装（AC-IN-004/005/006/007）：preinstallDone=false 时对比推荐清单与
 *   forge agent 目录（<userData>/agent）settings.packages 补缺（只增不删，不动用户已装/自装项），
 *   逐项经内置 CLI `pi install <pkg>`；全部成功置 preinstallDone=true；
 *   任一失败保持 false，下次启动重试（幂等）
 * - 联动（AC-IN-012/013/014）：lastRunForgeVersion ≠ 当前版本 → 后台静默
 *   `pi update --extensions`（复用 piRuntime.updatePiExtensions），成功回写
 *   lastRunForgeVersion + components 快照 + lastUpdateCheckAt；失败/离线/CLI 缺失
 *   静默保留旧标志；首次运行（null）只回写不触发联动
 * - 全程无 UI、绝不抛出：异常记入结构化日志后吞掉
 * - 所有 updater-state 读写均走 updaterState.ts，本编排不直接 fs
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  PI_UPDATE_TIMEOUT_MS,
  type PiUpdateResult,
  buildPiCliEnv,
  readPiExtensionList,
  resolveBundledPiCli,
  updatePiExtensions,
} from './piRuntime.ts';
import { missingRecommended } from './recommendedPlugins.ts';
import { readUpdaterState, updateComponents, writeUpdaterState } from './updaterState.ts';

const execFileAsync = promisify(execFile);

/** 输出尾部上限（与 piRuntime 手动更新一致） */
const OUTPUT_TAIL_CHARS = 4000;

function tail(s: string): string {
  const t = s.trim();
  return t.length > OUTPUT_TAIL_CHARS ? t.slice(-OUTPUT_TAIL_CHARS) : t;
}

export interface StartupUpdateDeps {
  /** updater-state.json 绝对路径（userData 目录下） */
  statePath: string;
  /** forge agent 目录（<userData>/agent，与 createForgeCore 注入同一根） */
  agentDir: string;
  /** 当前 forge 版本（main.ts 注入 app.getVersion()） */
  currentVersion: string;
  /** 内置 CLI 执行端口（默认 resolveBundledPiCli + ELECTRON_RUN_AS_NODE 子进程） */
  runCli?: (args: string[]) => Promise<{ ok: boolean; output: string }>;
  /** 组件联动更新端口（默认 piRuntime.updatePiExtensions，等价 `pi update --extensions`） */
  extensionUpdater?: () => Promise<PiUpdateResult>;
  now?: () => Date;
  /** 结构化日志出口（main.ts 接 console.log 前缀 [startup-update]） */
  logger?: (line: string) => void;
}

export interface StartupUpdate {
  /** 一次性顺序执行预装检查与联动检查；绝不抛出 */
  run(): Promise<void>;
}

/** 默认 CLI 执行：经 ELECTRON_RUN_AS_NODE 以 node 模式跑内置引擎 CLI（不依赖全局 pi）；
 * env 经 buildPiCliEnv 注入 PI_CODING_AGENT_DIR，组件装到 forge 自有 agent 目录 */
async function defaultRunCli(args: string[], agentDir: string): Promise<{ ok: boolean; output: string }> {
  const cli = resolveBundledPiCli();
  if (cli === null) {
    return { ok: false, output: '内置引擎 CLI 不存在，无法执行组件命令' };
  }
  try {
    const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
      windowsHide: true,
      timeout: PI_UPDATE_TIMEOUT_MS,
      maxBuffer: 4 * 1024 * 1024,
      env: buildPiCliEnv(agentDir),
    });
    return { ok: true, output: tail(stdout) };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    const output = [e.stderr, e.stdout].filter((x) => typeof x === 'string' && x !== '').join('\n');
    return { ok: false, output: tail(output || e.message || '未知错误') };
  }
}

/**
 * 组件版本快照（实体已安装项；清单已列但实体未安装的不入快照）。
 * 启动编排（createStartupUpdate）与手动更新路径（pi/updatePlugins → recordManualComponentUpdate）
 * 共用同一口径，保证 components 快照与「旧 → 新」日志的基准一致。
 */
export function snapshotComponents(agentDir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of readPiExtensionList(agentDir)) {
    if (p.version !== null) out[p.name] = p.version;
  }
  return out;
}

export function createStartupUpdate(deps: StartupUpdateDeps): StartupUpdate {
  const runCli = deps.runCli ?? ((args: string[]) => defaultRunCli(args, deps.agentDir));
  const extensionUpdater = deps.extensionUpdater ?? (() => updatePiExtensions(deps.agentDir));
  const now = deps.now ?? (() => new Date());
  const log = (line: string): void => {
    try {
      (deps.logger ?? (() => {}))(line);
    } catch {
      /* 日志出口异常不影响编排 */
    }
  };

  /** 组件版本快照（实体已安装项；清单已列但实体未安装的不入快照） */
  const snapshot = (): Record<string, string> => snapshotComponents(deps.agentDir);

  /** 预装（IN-F02）：补缺只增不删；全部成功置标志，任一失败保持 false 下次重试 */
  const runPreinstall = async (): Promise<void> => {
    const state = readUpdaterState(deps.statePath);
    if (state.preinstallDone) return; // AC-IN-006：已执行预装，幂等跳过
    const installed = readPiExtensionList(deps.agentDir).map((p) => p.name);
    const missing = missingRecommended(installed);
    if (missing.length === 0) {
      log('[静默] 推荐组件无缺失');
    }
    let allOk = true;
    for (const pkg of missing) {
      const res = await runCli(['install', pkg, '--no-approve']);
      if (res.ok) {
        const version = readPiExtensionList(deps.agentDir).find((p) => p.name === pkg)?.version;
        log(`[预装] ${pkg} ${version ?? '未知'} (来源=预装)`);
      } else {
        allOk = false;
        log(`[静默] 预装失败：${pkg} ${tail(res.output)}`);
      }
    }
    if (!allOk) return; // 保持 preinstallDone=false，下次启动重试（AC-IN-007）
    const next = readUpdaterState(deps.statePath);
    next.preinstallDone = true;
    next.preinstallDoneAt = now().toISOString();
    next.components = snapshot(); // 补装明细入 components 快照（IN-F02）
    writeUpdaterState(deps.statePath, next);
  };

  /** 联动（IN-F04）：forge 版本变化 → 静默更新组件并回写；失败保留旧标志 */
  const runLinkedUpdate = async (): Promise<void> => {
    const state = readUpdaterState(deps.statePath);
    if (state.lastRunForgeVersion === deps.currentVersion) return; // 版本未变：跳过（AC-IN-013）
    if (state.lastRunForgeVersion !== null) {
      // 版本变化 → 后台静默联动更新（AC-IN-012）；失败保留旧标志下次重试
      const res = await extensionUpdater();
      if (!res.ok) {
        log(`[静默] 联动更新失败，保留旧标志：${tail(res.output)}`);
        return;
      }
      const before = state.components;
      const fresh = snapshot();
      for (const [name, version] of Object.entries(fresh)) {
        if (before[name] !== version) {
          log(`[组件更新] ${name} ${before[name] ?? '未安装'} → ${version} (来源=联动)`);
        }
      }
      const next = readUpdaterState(deps.statePath);
      next.components = fresh;
      next.lastUpdateCheckAt = now().toISOString();
      next.lastRunForgeVersion = deps.currentVersion;
      writeUpdaterState(deps.statePath, next);
      return;
    }
    // 首次运行（lastRunForgeVersion=null）：无「版本变化」语义，只回写不触发联动
    const next = readUpdaterState(deps.statePath);
    next.lastRunForgeVersion = deps.currentVersion;
    writeUpdaterState(deps.statePath, next);
  };

  async function safePhase(phase: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log(`[静默] ${phase}阶段异常：${message}`);
    }
  }

  return {
    async run(): Promise<void> {
      // 一次性顺序执行；预装失败不阻断后续联动检查，任何异常均不外抛
      await safePhase('预装', runPreinstall);
      await safePhase('联动', runLinkedUpdate);
    },
  };
}

/**
 * 手动组件更新（pi/updatePlugins 成功）后的 components 快照刷新 + 结构化日志（QA-G1）。
 * - 日志格式与联动路径对齐：`[组件更新] 包名 旧 → 新 (来源=手动)`（旧值取自刷新前的快照，
 *   快照未记录过的包记为「未安装」），由调用方注入 logger（main.ts/createForgeCore 加
 *   `[startup-update]` console 前缀）
 * - statePath=null（缺省）跳过持久化、仅输出日志（无旧值基线，按空快照比对）
 * - 绝不抛出：快照读写/日志失败不影响手动更新 RPC 的成功语义
 */
export function recordManualComponentUpdate(deps: {
  statePath: string | null;
  agentDir: string;
  logger?: (line: string) => void;
}): void {
  try {
    const fresh = snapshotComponents(deps.agentDir);
    const before = deps.statePath !== null ? readUpdaterState(deps.statePath).components : {};
    for (const [name, version] of Object.entries(fresh)) {
      if (before[name] === version) continue;
      try {
        (deps.logger ?? (() => {}))(
          `[组件更新] ${name} ${before[name] ?? '未安装'} → ${version} (来源=手动)`,
        );
      } catch {
        /* 单条日志出口异常不影响其余明细与快照持久化 */
      }
    }
    if (deps.statePath !== null) {
      // 写前重读再合并：缩小与启动编排并发时的丢失窗口（同 schema.md 单写者约定）
      writeUpdaterState(deps.statePath, updateComponents(readUpdaterState(deps.statePath), fresh));
    }
  } catch (err) {
    console.warn('[startup-update] 手动更新 components 快照刷新失败', err);
  }
}

/**
 * 应用更新检查成功后回写 lastUpdateCheckAt（QA-G4，观测字段，schema.md「最近一次检查
 * 应用更新时间」）。statePath=null（缺省）跳过；绝不抛出（观测字段写失败不影响检查主流程）。
 */
export function touchLastUpdateCheckAt(
  statePath: string | null,
  now: () => Date = () => new Date(),
): void {
  if (statePath === null) return;
  try {
    const state = readUpdaterState(statePath);
    state.lastUpdateCheckAt = now().toISOString();
    writeUpdaterState(statePath, state);
  } catch {
    /* 观测字段写失败静默 */
  }
}
