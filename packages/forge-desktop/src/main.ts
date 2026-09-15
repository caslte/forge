/**
 * Electron 主进程入口。
 *
 * 职责：
 * 1. app.whenReady 创建主 BrowserWindow（contextIsolation + preload）
 * 2. createForgeCore 组装内核（forge-core 5 Api + mock adapter + 统一 eventBus）
 * 3. ipcMain.handle('forge:invoke') 路由到 methodTable
 * 4. eventBus 事件转发到渲染进程 'forge:event' { event, payload }
 * 5. dev 加载 Vite dev server（FORGE_DEV_SERVER_URL），prod 加载打包 UI
 *
 * 单窗口（v1 MVP）；多窗口多会话为后续迭代。
 */
import { app, BrowserWindow, ipcMain, dialog, shell, safeStorage } from 'electron';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// v3.76 欢迎页启动链：createForgeCore（连带整个 pi SDK，静态 import 实测 2.4s）不再
// 顶层静态加载——whenReady 先建窗口显示欢迎页，再动态 import 组装 core，完成后推
// boot.ready（见 app.whenReady 内注释）。此处仅保留纯类型 import（零运行时代价）。
import type { MethodTable } from './createForgeCore.ts';
import {
  createAppUpdaterPort,
  QUIT_AND_INSTALL_OPTIONS,
  type AutoUpdaterLike,
} from './pi/appUpdater.ts';
import { SafeStorageKeychainAdapter } from './pi/keychainAdapter.ts';
import { defaultPiAgentDir } from './pi/piRuntime.ts';
import { createStartupUpdate, touchLastUpdateCheckAt } from './pi/startupUpdate.ts';
import { defaultUpdaterStatePath } from './pi/updaterState.ts';
import { scanAttachments, savePasteImage, savePastedText, readImageDataUrl, listProjectFiles } from './attachments.ts';
import { ATTACHMENT_DIALOG_FILTER } from '@forge/core';
import { IPC_INVOKE, IPC_EVENT, FORGE_EVENTS, IPC_WINDOW_MINIMIZE, IPC_WINDOW_MAXIMIZE, IPC_WINDOW_CLOSE, IPC_WINDOW_IS_MAXIMIZED, IPC_DIALOG_OPEN_DIRECTORY, IPC_DIALOG_OPEN_FILE, IPC_SHELL_OPEN_PATH, IPC_ATTACHMENT_SCAN, IPC_CLIPBOARD_SAVE_IMAGE, IPC_CLIPBOARD_SAVE_TEXT, IPC_FILE_READ_IMAGE, IPC_FILE_LIST_PROJECT, IPC_BOOT_STATE, type BootState } from './ipc-contract.ts';
import type { ForgeEvent } from './ipc-contract.ts';

/** ESM 下 __dirname 不可用，从 import.meta.url 计算 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
/**
 * electron-updater 是 CJS 且 autoUpdater 经 Object.defineProperty(getter) 导出，
 * Node ESM 的 cjs-module-lexer 无法静态识别该命名导出（SyntaxError: Named export not found）。
 * 经 createRequire 取真实 CJS 导出对象；类型仍以声明文件为准（typeof import）。
 */
const require = createRequire(import.meta.url);
const { autoUpdater } = require('electron-updater') as typeof import('electron-updater');
/**
 * forge 产品版本：读包内 package.json（dist/../package.json）。
 * 不能用 app.getVersion()——dev 未打包时 app 路径解析到 dist/（无 package.json），
 * 会回退成 Electron 自身版本（如 40.9.3），导致关于页与更新器 currentVersion 错乱。
 */
const appVersion = (require('../package.json') as { version: string }).version;

/**
 * pi 扩展预热的兜底触发时刻（毫秒）。预热本身是主进程同步 CPU + stat 风暴
 * （10 个扩展包实测 4.4~6s，期间事件循环 100% 停摆——实测 10ms 定时器一次都不触发），
 * 任何落在预热窗口内的 IPC 都会排队。
 *
 * v3.78 起主路径是「boot 门闩前预热」：core 组装完成后立即用 store 里最近打开的
 * 项目路径预热，boot.ready 等预热完成（受 PI_WARMUP_MAX_WAIT_MS 上限保护）——
 * 冻结全程被欢迎页盖住，用户进入正式界面后点会话/切会话不再撞冻结。
 * v3.75 的「首个 queryHistory 后触发」降级为 fallback（覆盖 store 无项目的
 * 首次启动场景），本兜底保留兜住「用户不点会话直接发消息」的路径。
 */
const PI_WARMUP_FALLBACK_MS = 15000;

/**
 * boot.ready 等待预热的上限。预热实测 4.4~6s（慢机器可能更久），到点即放行
 * boot.ready（预热继续在后台跑）——宁可让用户进界面后偶撞冻结，也不许欢迎页
 * 无限等待。上限必须小于渲染进程的门闩逃生超时（App.vue BOOT_GATE_TIMEOUT_MS
 * =10s），保证正常路径下主进程先放行。
 */
const PI_WARMUP_MAX_WAIT_MS = 9000;

/**
 * 同步读 store 里「最近打开的项目」路径，作为 boot 前预热的 cwd。
 * store 尚未创建/解析失败/无项目（首次启动）一律返回 null（调用方跳过预热，
 * 交给 fallback 触发链）。仅此一处轻量 JSON.parse，不引入 store 模块依赖。
 */
function readLastProjectPathSync(storePath: string): string | null {
  try {
    const raw = JSON.parse(fs.readFileSync(storePath, 'utf8')) as {
      projects?: Array<{ path?: unknown; lastOpenedAt?: unknown }>;
    };
    const projects = Array.isArray(raw.projects) ? raw.projects : [];
    let best: { path: string; at: number } | null = null;
    for (const p of projects) {
      if (typeof p.path !== 'string' || p.path === '') continue;
      const parsed = typeof p.lastOpenedAt === 'string' ? Date.parse(p.lastOpenedAt) : NaN;
      const at = Number.isNaN(parsed) ? -1 : parsed;
      if (best === null || at > best.at) best = { path: p.path, at };
    }
    return best?.path ?? null;
  } catch {
    return null;
  }
}

/**
 * 等 splash 文档提交 + 上屏的最长等待（毫秒）。超时照常继续，绝不让启动卡死。
 * dev 冷启动实测 loadURL → 文档提交 <1s，2.5s 足够宽裕。
 */
const SPLASH_PAINT_MAX_WAIT_MS = 2500;

/** 导航提交后留给 splash 解析 + 布局 + 上屏的宽限期（毫秒）。splash 是内联样式的
 *  几十行 HTML，实测提交后约百毫秒即出现在画面上，200ms 足够且不拖慢启动。 */
const SPLASH_PAINT_GRACE_MS = 200;

/**
 * 等渲染进程把静态 splash 真正画上屏，再让主进程去做同步重活（v3.78.2）。
 *
 * 背景：Electron 的 Node 事件循环与 Chromium UI 线程**是同一个线程**。loadURL 之后
 * 紧跟着的 core 组装（pi SDK 同步求值 ~1.2s）+ 预热（jiti 同步编译 ~2.4s）会把
 * 渲染进程的创建与导航提交一起卡住——实测窗口从 0.6s 就存在、splash 却到 4.7s 才
 * 提交，中间 4s 窗口里只有 BrowserWindow 底色（用户看到的「白屏」）。根因是：
 * v3.78.1 内联在 index.html 的 splash 在「文档提交」前根本不存在，光写 HTML
 * 盖不住这段——必须先给主线程留出把渲染进程拉起来、把 HTML 提交并合成一帧的窗口。
 *
 * 信号只用**浏览器进程侧**的导航提交事件（did-navigate）：渲染进程此刻正忙于执行
 * Vite dev 的整条模块链，任何渲染进程侧信号都不可用——实测 dom-ready 被
 * DOMContentLoaded 拖到 10.5s，executeJavaScript 的一次 evaluate 被拖到 5.9s。
 * 提交后再留 SPLASH_PAINT_GRACE_MS 的绘制窗口（splash 体积极小、样式内联，
 * 提交后约百毫秒即上屏）。超时照常继续，绝不让启动卡死。
 */
async function waitForSplashPainted(win: BrowserWindow, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const wc = win.webContents;
  const yieldFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const committed = new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    wc.once('did-navigate', () => done(true));
    // 防御：监听前已完成提交（loadURL 是异步的，理论上不会）
    if (!wc.isLoading() && wc.getURL() !== '') done(true);
  });
  const ok = await Promise.race([committed, yieldFor(timeoutMs).then(() => false)]);
  if (!ok) {
    console.log(`[boot] splash 导航未在 ${timeoutMs}ms 内提交，放弃等待（照常继续启动）`);
    return;
  }
  await yieldFor(SPLASH_PAINT_GRACE_MS);
  console.log(
    `[boot] splash 已提交并留出绘制窗口（${Date.now() - startedAt}ms），主进程开始同步重活`,
  );
}

let mainWindow: BrowserWindow | null = null;

/** 创建主窗口（无边框，自定义标题栏）；dev 模式自动挂 DevTools + F12/Ctrl+Shift+I 快捷键 */
function createWindow(isDev: boolean): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    // 与欢迎页底色一致：v3.76 窗口先行后，loadURL 渲染完成前显示底色而非白屏
    backgroundColor: '#f6f8fa',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow = win;
  win.on('closed', () => {
    mainWindow = null;
  });

  if (isDev) {
    // 不自动弹出 DevTools，仅保留 F12 / Ctrl+Shift+I 手动切换
    win.webContents.on('before-input-event', (_event, input) => {
      const f12 = input.key === 'F12' && input.type === 'keyDown';
      const ctrlShiftI =
        input.key.toLowerCase() === 'i' &&
        input.control &&
        input.shift &&
        input.type === 'keyDown';
      if (f12 || ctrlShiftI) {
        if (win.webContents.isDevToolsOpened()) {
          win.webContents.closeDevTools();
        } else {
          win.webContents.openDevTools({ mode: 'detach' });
        }
      }
    });
  }

  return win;
}

/**
 * 注册与 forge-core 无关的 IPC：启动状态查询 + 窗口控制 / 对话框 / 附件 / 文件。
 * v3.76 欢迎页启动链：窗口创建后立即注册（core 组装是异步的，这批 handler 不等它），
 * 保证欢迎页期间窗口最小化/关闭/文件选择等都可用。
 */
function registerShellIpc(bootState: BootState): void {
  // 启动状态查询（欢迎页门闩「拉」通道）：handler 引用 bootState 对象本身，
  // core 组装完成后原地改写字段即可，无需重注册 handler
  ipcMain.handle(IPC_BOOT_STATE, () => bootState);
  // 窗口控制
  ipcMain.on(IPC_WINDOW_MINIMIZE, () => mainWindow?.minimize());
  ipcMain.on(IPC_WINDOW_MAXIMIZE, () => {
    const w = mainWindow;
    if (!w) return;
    if (w.isMaximized()) {
      w.unmaximize();
    } else {
      w.maximize();
    }
  });
  ipcMain.on(IPC_WINDOW_CLOSE, () => mainWindow?.close());
  ipcMain.handle(IPC_WINDOW_IS_MAXIMIZED, () => mainWindow?.isMaximized() ?? false);
  // 原生目录选择：返回选中的目录绝对路径；取消/失败返回 null
  ipcMain.handle(IPC_DIALOG_OPEN_DIRECTORY, async () => {
    const options = {
      title: '选择项目目录',
      properties: ['openDirectory', 'createDirectory'],
    } as Electron.OpenDialogOptions;
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (res.canceled || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0] ?? null;
  });
  // 附件统一给路径：文件选择只返回绝对路径，不读内容（模型自行 read）；取消返回空数组
  ipcMain.handle(IPC_DIALOG_OPEN_FILE, async () => {
    const options = {
      title: '选择附件',
      properties: ['openFile', 'multiSelections'],
      filters: [ATTACHMENT_DIALOG_FILTER],
    } as Electron.OpenDialogOptions;
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (res.canceled) {
      return [];
    }
    return res.filePaths;
  });
  // 系统文件管理器打开目录（PM 侧栏右键“打开项目所在目录”）；成功 true，失败 false
  ipcMain.handle(IPC_SHELL_OPEN_PATH, (_e, p: unknown) => {
    if (typeof p !== 'string' || p === '') return false;
    return shell.openPath(p).then((err) => err === '');
  });
  // 附件密钥嗅探：文本文件命中凭据特征 → flagged（发送前 UI 弹确认，出域防线）
  ipcMain.handle(IPC_ATTACHMENT_SCAN, (_e, paths: unknown) => {
    if (!Array.isArray(paths)) {
      return [];
    }
    return scanAttachments(paths.filter((p): p is string => typeof p === 'string' && p !== ''));
  });
  // 粘贴截图落盘：剪贴板图片不在盘上，给路径前先写成临时文件
  ipcMain.handle(IPC_CLIPBOARD_SAVE_IMAGE, (_e, base64Data: unknown, ext: unknown) => {
    if (typeof base64Data !== 'string' || base64Data === '') {
      return null;
    }
    try {
      return savePasteImage(base64Data, typeof ext === 'string' ? ext : 'png');
    } catch {
      return null;
    }
  });
  // 超长粘贴文本落盘：大文本不进输入框，先写成临时 txt 再给路径
  ipcMain.handle(IPC_CLIPBOARD_SAVE_TEXT, (_e, text: unknown) => {
    if (typeof text !== 'string' || text === '') {
      return null;
    }
    try {
      return savePastedText(text);
    } catch {
      return null;
    }
  });
  // 缩略图读取：磁盘图片 → data URL（仅输入框缩略图/预览用）
  ipcMain.handle(IPC_FILE_READ_IMAGE, (_e, p: unknown) => {
    if (typeof p !== 'string' || p === '') {
      return null;
    }
    return readImageDataUrl(p);
  });
  // @ 补全候选：项目内白名单文件绝对路径（BFS 浅层优先，上限 2000）
  ipcMain.handle(IPC_FILE_LIST_PROJECT, (_e, root: unknown) =>
    typeof root === 'string' && root !== '' ? listProjectFiles(root) : [],
  );
}

/**
 * forge-core 组装完成后注册：invoke 路由 + eventBus → 渲染进程事件转发。
 * 与 registerShellIpc 分离的原因：invoke/eventBus 来自动态 import 的 core 模块，
 * 就绪前渲染进程的 forge:invoke 请求由欢迎页门闩挡住（App.vue bootReady），
 * 本函数注册完成后才放行正式 UI。
 */
function registerCoreIpc(
  invokeFn: (t: MethodTable, m: string, p?: Record<string, unknown>) => Promise<unknown>,
  methodTable: MethodTable,
  eventBus: NodeJS.EventEmitter,
): void {
  ipcMain.handle(IPC_INVOKE, (_e, arg: { method: string; params?: Record<string, unknown> }) =>
    invokeFn(methodTable, arg.method, arg.params),
  );
  for (const event of FORGE_EVENTS) {
    const e: ForgeEvent = event;
    eventBus.on(e, (payload: unknown) => {
      mainWindow?.webContents.send(IPC_EVENT, { event: e, payload });
    });
  }
}

/** electron-updater autoUpdater 的最小端口适配（IN-S03）：方法/事件签名对齐 AutoUpdaterLike */
class ElectronUpdaterAdapter implements AutoUpdaterLike {
  checkForUpdates(): Promise<unknown> {
    return autoUpdater.checkForUpdates();
  }
  downloadUpdate(): Promise<unknown> {
    return autoUpdater.downloadUpdate();
  }
  quitAndInstall(): void {
    // 更新安装策略见 QUIT_AND_INSTALL_OPTIONS：非静默（isSilent=false）→ 安装器显示带应用图标
    // 与「正在安装」文案的进度窗口，用户可见进度且无需点击；forceRunAfter=true 装完自动重开应用。
    // 配合 electron-builder.yml 的 nsis.oneClick=true，更新路径全程无向导页、零点击。
    autoUpdater.quitAndInstall(
      QUIT_AND_INSTALL_OPTIONS.isSilent,
      QUIT_AND_INSTALL_OPTIONS.forceRunAfter,
    );
  }
  on(event: string, listener: (info: unknown) => void): unknown {
    // electron-updater 的 on 收窄了事件名联合；端口侧放宽为 string，经断言对齐签名
    type AutoUpdaterEvent = Parameters<typeof autoUpdater.on>[0];
    return autoUpdater.on(event as AutoUpdaterEvent, listener as never);
  }
}

/** 更新源（GitHub Releases）：FORGE_GH_OWNER/FORGE_GH_REPO 均存在才返回显式覆盖，
 *  否则 null——打包产物回退 app-update.yml 内置 feed，dev 不装配（6003 静默） */
function resolveUpdaterFeed(): { owner: string; repo: string } | null {
  const owner = process.env.FORGE_GH_OWNER;
  const repo = process.env.FORGE_GH_REPO;
  return owner && repo ? { owner, repo } : null;
}

/** 更新调试开关：userData/updater-debug.json 存在且 enabled=true 才开启（仅维护者本地排查用，
 *  普通用户不创建该文件即不可见）。每次调用实时读取，改文件后无需重启应用 */
function readUpdateDebugEnabled(userDataPath: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(userDataPath, 'updater-debug.json'), 'utf8');
    const value = JSON.parse(raw) as { enabled?: unknown };
    return value?.enabled === true;
  } catch {
    return false;
  }
}

app.whenReady().then(async () => {
  const storePath = path.join(app.getPath('userData'), 'forge-store.json');
  // QA-G1/G4：updater-state.json（手动更新 components 快照 + lastUpdateCheckAt 持久化路径）
  const updaterStatePath = defaultUpdaterStatePath(app.getPath('userData'));
  // P3-D：Windows 下优先用 safeStorage（DPAPI）持久化密钥；不可用时回退环境变量适配器
  const keychain = new SafeStorageKeychainAdapter(
    path.join(app.getPath('userData'), 'forge-keyvault.json'),
    () => safeStorage,
  );
  keychain.restoreEnv();
  // IN-S03：真实 electron-updater 装配。feed 来源两路：
  // - env（FORGE_GH_OWNER/FORGE_GH_REPO）→ setFeedURL 显式覆盖（发版/测试可指定仓库）；
  // - env 未配置但为打包产物（app.isPackaged）→ 不 setFeedURL，electron-updater 回退
  //   app-update.yml 内置 publish 配置（即 electron-builder.yml 填的仓库）；
  // - dev（未打包且无 env）→ 不装配 adapter，checkForUpdates 一律 6003 由 UI 静默处理。
  // 手动下载模式：checkForUpdates 只发现，下载由 updater/downloadUpdate 触发（进度经事件推送）。
  const updaterFeed = resolveUpdaterFeed();
  autoUpdater.autoDownload = false;
  if (updaterFeed) {
    autoUpdater.setFeedURL({
      provider: 'github',
      owner: updaterFeed.owner,
      repo: updaterFeed.repo,
      // 当前默认私有仓库：electron-updater 仅在此开关下读取 GH_TOKEN/GITHUB_TOKEN 并走
      // PrivateGitHubProvider（GitHub API 带认证）；公开后移除 private 字段回退公开 feed。
      // 注：打包产物未设 env 时回退 app-update.yml 内置 publish（electron-builder.yml 同样
      // 带 private: true），两条路径行为一致。
      private: true,
    });
  }
  // ===== v3.76 欢迎页启动链 =====
  // 1) 窗口先行：createWindow + loadURL 立即执行，渲染进程马上显示欢迎页（App.vue
  //    bootReady 门闩），不再等 pi SDK 的 ~2.4s 静态 import（实测占启动卡顿大头）。
  // 2) core 后台组装：动态 import createForgeCore（连带 pi SDK），完成后注册 invoke
  //    路由与事件转发，改写 bootState 并向渲染进程推 boot.ready。
  //    推（事件）+ 拉（IPC_BOOT_STATE）双通道：渲染进程可能尚未订阅事件（Vite 加载中），
  //    mount 时会主动拉一次 bootState 兜底，不依赖单一方向。
  // 3) updater / 预热 / 首启预装全部顺延到 core 就绪之后（原本就依赖 methodTable/eventBus）。
  const bootState: BootState = { ready: false, startedAt: Date.now(), durationMs: null };
  const win = createWindow(!!process.env.FORGE_DEV_SERVER_URL);
  const devUrl = process.env.FORGE_DEV_SERVER_URL;
  if (devUrl) {
    const expectedOrigin = process.env.FORGE_DEV_SERVER_ORIGIN;
    const loadedUrl = new URL(devUrl);
    if (!expectedOrigin || loadedUrl.origin !== expectedOrigin) {
      throw new Error(`FORGE_DEV_SERVER_URL origin mismatch: ${loadedUrl.origin}`);
    }
    win.loadURL(devUrl);
  } else {
    // prod：UI 在 @forge/ui/dist，从本包 dist 回退两级再进 forge-ui/dist
    win.loadFile(path.join(__dirname, '../../forge-ui/dist/index.html'));
  }
  registerShellIpc(bootState);

  // ===== v3.78.2：先让静态 splash 上屏，再放开主进程做同步重活 =====
  // core 组装（pi SDK 同步求值）与预热（jiti 同步编译）跑在 Node 事件循环上，而该
  // 循环与 Chromium UI 线程是同一个线程——若紧接着 loadURL 就开跑，渲染进程的创建
  // 与导航提交会一起被卡住，用户看到数秒纯底色白屏（实测 0.6s→4.7s，详见
  // waitForSplashPainted 注释）。此处让主线程先空转等 splash 提交并合成一帧。
  await waitForSplashPainted(win, SPLASH_PAINT_MAX_WAIT_MS);

  // eventBus 由 createForgeCore 返回，端口 emit 先以闭包晚绑定（跃迁都发生在组装完成之后）
  let coreEventBus: NodeJS.EventEmitter | null = null;
  const appUpdater = createAppUpdaterPort({
    getCurrentVersion: () => appVersion,
    autoUpdaterLike: updaterFeed || app.isPackaged ? new ElectronUpdaterAdapter() : null,
    emit: (event, payload) => coreEventBus?.emit(event, payload),
    logger: (line) => console.log('[updater]', line),
    // QA-G4：检查成功（code 0）后回写 updater-state.json 的 lastUpdateCheckAt（观测字段）
    onCheckComplete: () => touchLastUpdateCheckAt(updaterStatePath),
  });

  const { createForgeCore, invoke } = await import('./createForgeCore.ts');
  const { methodTable, eventBus } = createForgeCore(storePath, {
    keychain,
    // 设置页「版本更新」展示用产品版本
    forgeVersion: appVersion,
    // IN-S03：应用自更新端口（updater/* RPC + updater.stateChanged 事件）
    appUpdater,
    // QA-G1：手动组件更新成功后刷新 updater-state components 快照（缺省 null=跳过持久化）
    updaterStatePath,
    // 更新调试开关（userData/updater-debug.json，实时读取；false=普通用户不可见调试控制台）
    getUpdateDebugEnabled: () => readUpdateDebugEnabled(app.getPath('userData')),
  });
  coreEventBus = eventBus;
  registerCoreIpc(invoke, methodTable, eventBus);

  // ===== 预热入口（v3.78 上移到 boot.ready 之前；boot 前主路径 + boot 后 fallback 共用）=====
  let warmCwd: string | null = null;
  let warmupStarted = false;
  let warmupPromise: Promise<void> | null = null;
  /** 一次性闸门：已启动/无 cwd 返回既有 promise（或 null），不重复预热 */
  const startWarmupOnce = (reason: string): Promise<void> | null => {
    const cwd = warmCwd;
    if (warmupStarted || cwd === null) return warmupPromise;
    warmupStarted = true;
    console.log(`[warmup] 开始预热 pi 扩展加载（触发：${reason}）`);
    // 动态 import：createPiAgentSessionFactory.ts 顶层 import pi SDK（欢迎页启动链
    // 要求 main.ts 顶层不静态依赖它）；此处到达时 SDK 本就已被 core 组装加载进
    // 模块缓存，二次 import 零成本。warmPiResourceLoader 内部已 catch 全部异常
    // （仅告警后正常 resolve），promise 不会 reject，下方 Promise.race 安全。
    warmupPromise = import('./pi/createPiAgentSessionFactory.ts').then((m) => m.warmPiResourceLoader(cwd));
    return warmupPromise;
  };

  // ===== v3.78：预热挪进欢迎页窗口期 =====
  // core 组装完成即预热：cwd 取 store 里最近打开的项目。此刻渲染端还在欢迎页
  // （bootReady 门闩挡住一切 forge:invoke），主进程 4.4~6s 冻结没有任何可感知面。
  // boot.ready 等预热完成或 PI_WARMUP_MAX_WAIT_MS 超时，保证渲染端进入正式界面
  // 时扩展加载已暖——点会话/切会话不再撞 v3.75 遗留的冻结窗（当时「与渲染重叠」
  // 的假设在窗口化后只覆盖 0.5s，剩余 ~4.5s 暴露给切换会话操作）。
  warmCwd = readLastProjectPathSync(storePath);
  const bootWarmup = startWarmupOnce('boot 门闩前（store 最近项目）');
  if (bootWarmup !== null) {
    await Promise.race([
      bootWarmup,
      new Promise<void>((resolve) => setTimeout(resolve, PI_WARMUP_MAX_WAIT_MS)),
    ]);
  }

  bootState.ready = true;
  bootState.durationMs = Date.now() - bootState.startedAt;
  console.log(`[boot] forge-core 就绪（${bootState.durationMs}ms），通知渲染进程进入正式界面`);
  mainWindow?.webContents.send(IPC_EVENT, { event: 'boot.ready', payload: { ...bootState } });

  // IN-S03：启动自动检查一次更新（fire-and-forget；失败静默，错误经 updater.stateChanged 传递）
  const updaterCheck = methodTable['updater/checkForUpdates'];
  if (updaterCheck) {
    void Promise.resolve()
      .then(() => updaterCheck({}))
      .catch(() => {});
  }

  // ===== 预热 fallback 注册（v3.78 起主路径在 boot 门闩前，定义见上）=====
  // 覆盖 boot 前预热跳过的场景：store 无项目（首次启动）→ warmCwd=null 时闸门
  // 不置位，project.opened 后由 queryHistory/兜底触发首次预热。
  eventBus.on('project.opened', (payload) => {
    const opened = (payload as { path?: unknown }).path;
    if (typeof opened === 'string' && opened !== '') warmCwd = opened;
  });
  setTimeout(() => void startWarmupOnce(`${PI_WARMUP_FALLBACK_MS}ms 兜底`), PI_WARMUP_FALLBACK_MS);

  // 包装 queryHistory：历史数据已发给渲染进程 → 渲染进程将忙于渲染（数百 ms 起），
  // 主进程此刻空闲，正好承接预热的同步阻塞，两个成本重叠而非叠加。
  const origQueryHistory = methodTable['conversation/queryHistory'];
  if (origQueryHistory) {
    methodTable['conversation/queryHistory'] = async (params: unknown) => {
      const result = await origQueryHistory(params);
      void startWarmupOnce('首个会话历史已下发');
      return result;
    };
  }

  // 模块 07：首启静默预装推荐组件 + 版本变化联动更新（IN-F02/IN-F04）
  // 后台 fire-and-forget，不阻塞启动；编排内部绝不抛出，仅结构化日志（无 UI 提示）
  void createStartupUpdate({
    statePath: updaterStatePath,
    agentDir: defaultPiAgentDir(),
    currentVersion: appVersion,
    logger: (line) => console.log('[startup-update]', line),
  })
    .run()
    .catch(() => {});
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
