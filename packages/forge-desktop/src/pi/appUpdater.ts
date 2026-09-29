/**
 * 应用自更新端口（IN-S03 后端，docs/api/07_pi.md §3-5 / PRD 07 IN-F03）。
 *
 * 职责：
 * - 维护自更新状态机 idle → checking → found → downloading → downloaded → installing，
 *   任一失败回 idle（静默，error 字段供 UI 展示，不弹窗）。
 * - 订阅注入的 autoUpdaterLike（main.ts 用 ElectronUpdaterAdapter 包装真实 electron-updater）
 *   的事件（update-available / update-not-available / download-progress / update-downloaded /
 *   error）并映射状态跃迁；每次跃迁（含下载进度步进）经 deps.emit 发 updater.stateChanged。
 * - feed 未配置（null）时 checkForUpdates 直接 6003，不触碰 autoUpdaterLike（不发起网络）。
 * - createUpdaterMethods 把端口包装成 updater/* 四个 RPC 方法（统一信封 + 错误码），由
 *   createForgeCore 直接展开合并进方法表；端口经 deps.appUpdater 注入，测试可传 fake。
 *
 * 纯 TS（不 import Electron / electron-updater），全部可注入单测。
 */
import type { RpcResult } from '@forge/core';

/** 自更新状态机：idle → checking → found → downloading → downloaded → installing；失败回 idle */
export type UpdaterStatus =
  | 'idle'
  | 'checking'
  | 'found'
  | 'downloading'
  | 'downloaded'
  | 'installing';

/** 状态快照（updater/getState data 与 updater.stateChanged payload 同构） */
export interface AppUpdaterSnapshot {
  status: UpdaterStatus;
  currentVersion: string;
  latestVersion: string | null;
  downloadProgress: number | null;
  error: string | null;
}

/** electron-updater autoUpdater 的最小端口接口（main.ts 用适配器包装真实实现） */
export interface AutoUpdaterLike {
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(): void;
  on(event: string, listener: (info: unknown) => void): unknown;
}

/**
 * `quitAndInstall` 启动参数策略（main.ts 的 ElectronUpdaterAdapter 使用；抽成常量是为了让
 * 这条不可见的体验决策可被单测守住）。
 *
 * - `isSilent: false` —— 安装器走**非静默**分支。配合 electron-builder.yml 的向导模式
 *   （`oneClick: false` + `allowToChangeInstallationDirectory: true`），更新时 electron-updater
 *   恒传的 --updated 让模板跳过「选择安装位置」页，只剩可见的进度页；build/installer.nsh 的
 *   customInstall 在 --updated + --force-run 时复刻 oneClick 收尾（拉起应用 + Quit），
 *   全程零点击、不进结束页。
 *   **不要改成 true**：静默安装期间不显示任何窗口，用户只看到应用消失、过一会儿又突然跳出来
 *   （2026-09-14 反馈明确否定该体验，要求「一定要有进度条让用户可以看到」）。
 * - `forceRunAfter: true` —— 安装完成后自动启动新版本。
 */
export const QUIT_AND_INSTALL_OPTIONS = { isSilent: false, forceRunAfter: true } as const;

/** createAppUpdaterPort 可注入依赖 */
export interface AppUpdaterPortDeps {
  /** 当前 forge 产品版本（app.getVersion()） */
  getCurrentVersion(): string;
  /** electron-updater 包装端口；未装配时检查一律 6003（dev 无 feed 场景）。
   * 装配后 feed 来源：main.ts 已按需 setFeedURL（env 覆盖），未覆盖时 electron-updater
   * 回退打包内置 app-update.yml 的 publish 配置——端口本身不区分显式/内置 feed */
  autoUpdaterLike?: AutoUpdaterLike | null;
  /** 事件出口（createForgeCore 接 eventBus → 渲染进程 updater.stateChanged） */
  emit(event: string, payload: unknown): void;
  /** 可选日志（失败/装配信息） */
  logger?: (line: string) => void;
  /** QA-G4：检查成功完成（实际执行了检查且 code 0）后的回调——createForgeCore/main.ts
   * 注入，内部回写 updater-state.json 的 lastUpdateCheckAt；忙时幂等返回与 6003 不回调 */
  onCheckComplete?: () => void;
}

/** 端口操作结果：ok 携带快照；失败携带错误码（6003/6004/6005）与失败后快照 */
export type AppUpdaterResult =
  | { ok: true; snapshot: AppUpdaterSnapshot }
  | { ok: false; code: number; message: string; snapshot: AppUpdaterSnapshot };

export interface AppUpdaterPort {
  getState(): AppUpdaterSnapshot;
  checkForUpdates(): Promise<AppUpdaterResult>;
  downloadUpdate(): Promise<AppUpdaterResult>;
  quitAndInstall(): Promise<AppUpdaterResult>;
}

/** updater.stateChanged：与 getState.data 同构（无 sessionId，全局单例状态） */
export type UpdaterStateChangedPayload = AppUpdaterSnapshot;

/** 从 electron-updater UpdateInfo 取 version */
function readVersion(info: unknown): string | null {
  if (typeof info === 'object' && info !== null) {
    const v = (info as { version?: unknown }).version;
    if (typeof v === 'string' && v !== '') return v;
  }
  return null;
}

/** 从 electron-updater ProgressInfo 取 percent（clamp 0-100，保留两位小数） */
function readPercent(info: unknown): number | null {
  if (typeof info === 'object' && info !== null) {
    const p = (info as { percent?: unknown }).percent;
    if (typeof p === 'number' && Number.isFinite(p)) {
      return Math.min(100, Math.max(0, Math.round(p * 100) / 100));
    }
  }
  return null;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err ?? '更新失败');
}

/**
 * 创建应用自更新端口。
 * @param deps 可注入依赖（测试传 fake autoUpdaterLike + fake emit；dev 不注入=6003 静默降级）
 */
export function createAppUpdaterPort(deps: AppUpdaterPortDeps): AppUpdaterPort {
  const au = deps.autoUpdaterLike ?? null;
  const currentVersion = deps.getCurrentVersion();

  // 状态机可变态。注意：status 经 readStatus() 读取——该变量由事件回调/跃迁闭包改写，
  // 直读会触发 TS 控制流把字面量联合收窄成误报（TS2367），函数取值保持完整联合类型。
  let status: UpdaterStatus = 'idle';
  let latestVersion: string | null = null;
  let downloadProgress: number | null = null;
  let error: string | null = null;

  const readStatus = (): UpdaterStatus => status;

  const snapshot = (): AppUpdaterSnapshot => ({
    status,
    currentVersion,
    latestVersion,
    downloadProgress,
    error,
  });

  /** 任意跃迁（含进度步进）都发 updater.stateChanged */
  const emitState = (): void => {
    deps.emit('updater.stateChanged', snapshot());
  };

  /** 进入新状态（仅状态字段跃迁） */
  const transition = (next: UpdaterStatus): void => {
    status = next;
    emitState();
  };

  /** 操作失败收敛：回 idle 静默（progress 清空、error 记录供展示），返回失败结果 */
  const fail = (code: 6003 | 6004 | 6005, message: string): AppUpdaterResult => {
    status = 'idle';
    downloadProgress = null;
    error = message;
    emitState();
    deps.logger?.(`[appUpdater] ${message}`);
    return { ok: false, code, message, snapshot: snapshot() };
  };

  // 订阅 electron-updater 事件 → 状态机跃迁。守卫当前状态，避免竞态双收敛。
  if (au) {
    au.on('update-available', (info) => {
      if (readStatus() !== 'checking') return;
      latestVersion = readVersion(info);
      downloadProgress = null;
      transition('found');
    });
    au.on('update-not-available', () => {
      if (readStatus() !== 'checking') return;
      latestVersion = null;
      transition('idle');
    });
    au.on('download-progress', (info) => {
      if (readStatus() !== 'downloading') return;
      const percent = readPercent(info);
      if (percent === null) return;
      downloadProgress = percent;
      emitState(); // 百分比步进也推送（PRD 3.4 进度条数据源）
    });
    au.on('update-downloaded', (info) => {
      if (readStatus() !== 'downloading') return;
      downloadProgress = 100;
      latestVersion = readVersion(info) ?? latestVersion;
      transition('downloaded');
    });
    au.on('error', (err) => {
      const message = errorMessage(err);
      // 真实 electron-updater 失败时 promise 拒绝 + error 事件双通道；
      // 谁先到达谁收敛（fail 回 idle），后者经状态守卫短路不重复跃迁。
      if (readStatus() === 'checking') {
        fail(6003, message);
        return;
      }
      if (readStatus() === 'downloading') {
        fail(6004, message);
      }
    });
  }

  return {
    getState(): AppUpdaterSnapshot {
      return snapshot();
    },

    async checkForUpdates(): Promise<AppUpdaterResult> {
      // 未装配更新器（dev 无 feed 场景）：不触碰库/网络，直接 6003（UI 静默处理）。
      // 已装配时（打包产物或 env 覆盖 feed）：放行——electron-updater 用内置 app-update.yml
      // 或 main.ts setFeedURL 的 feed；底层无 feed 抛错由下方 catch 映射 6003。
      if (!au) {
        return fail(6003, '更新源未配置');
      }
      // 忙时（checking/found/downloading/downloaded）幂等返回当前快照，不重复检查
      if (readStatus() !== 'idle') {
        return { ok: true, snapshot: snapshot() };
      }
      latestVersion = null;
      downloadProgress = null;
      error = null;
      transition('checking');
      try {
        await au.checkForUpdates();
      } catch (err) {
        // error 事件未先行时在此收敛；已收敛（idle+error）则复用其结果
        if (readStatus() === 'checking') {
          return fail(6003, errorMessage(err));
        }
      }
      // 事件驱动跃迁应已完成（found / idle）；fake/异常时序未发事件则兜底回 idle
      if (readStatus() === 'checking') {
        transition('idle');
      }
      if (readStatus() === 'idle' && error !== null) {
        return { ok: false, code: 6003, message: error, snapshot: snapshot() };
      }
      // 检查成功完成（code 0）：回写 lastUpdateCheckAt（QA-G4）；忙时幂等/6003 不回调
      deps.onCheckComplete?.();
      return { ok: true, snapshot: snapshot() };
    },

    async downloadUpdate(): Promise<AppUpdaterResult> {
      // 幂等：下载中重复调用返回当前快照（不重复触发）
      if (readStatus() === 'downloading') {
        return { ok: true, snapshot: snapshot() };
      }
      // 契约：仅 found 时有效；前置不满足返回 6004，状态机不跃迁
      if (readStatus() !== 'found' || !au) {
        return { ok: false, code: 6004, message: '当前没有可下载的更新', snapshot: snapshot() };
      }
      downloadProgress = 0;
      error = null;
      transition('downloading');
      try {
        await au.downloadUpdate();
      } catch (err) {
        if (readStatus() === 'downloading') {
          return fail(6004, errorMessage(err));
        }
      }
      // error 事件先行收敛（idle+error）→ 6004；已 downloaded → 成功；仍 downloading → 等事件
      if (readStatus() === 'downloading') {
        return { ok: true, snapshot: snapshot() };
      }
      if (readStatus() === 'idle' && error !== null) {
        return { ok: false, code: 6004, message: error, snapshot: snapshot() };
      }
      return { ok: true, snapshot: snapshot() };
    },

    async quitAndInstall(): Promise<AppUpdaterResult> {
      // 契约：仅 downloaded 时有效；前置不满足返回 6005，状态机不跃迁
      if (readStatus() !== 'downloaded' || !au) {
        return { ok: false, code: 6005, message: '当前没有已下载待安装的更新', snapshot: snapshot() };
      }
      error = null;
      transition('installing');
      try {
        au.quitAndInstall(); // 成功则应用退出重启（本调用正常不再返回）
      } catch (err) {
        if (readStatus() === 'installing') {
          return fail(6005, errorMessage(err));
        }
      }
      return { ok: true, snapshot: snapshot() };
    },
  };
}

/**
 * updater/* 四方法映射（updater/getState | checkForUpdates | downloadUpdate | quitAndInstall）。
 * 返回类型与 createForgeCore 的 MethodTable 兼容（直接展开合并）。
 */
export function createUpdaterMethods(
  port: AppUpdaterPort,
): Record<string, (params: unknown) => Promise<RpcResult>> {
  const okEnvelope = (snapshot: AppUpdaterSnapshot): RpcResult<AppUpdaterSnapshot> => ({
    code: 0,
    message: 'success',
    data: snapshot,
  });
  const toEnvelope = (result: AppUpdaterResult): RpcResult<AppUpdaterSnapshot> =>
    result.ok ? okEnvelope(result.snapshot) : { code: result.code, message: result.message, data: result.snapshot };
  return {
    'updater/getState': async () => okEnvelope(port.getState()),
    'updater/checkForUpdates': async () => toEnvelope(await port.checkForUpdates()),
    'updater/downloadUpdate': async () => toEnvelope(await port.downloadUpdate()),
    'updater/quitAndInstall': async () => toEnvelope(await port.quitAndInstall()),
  };
}
