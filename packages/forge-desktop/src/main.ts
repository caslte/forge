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
import { createForgeCore, invoke, type MethodTable } from './createForgeCore.ts';
import { createAppUpdaterPort, type AutoUpdaterLike } from './pi/appUpdater.ts';
import { warmPiResourceLoader } from './pi/createPiAgentSessionFactory.ts';
import { SafeStorageKeychainAdapter } from './pi/keychainAdapter.ts';
import { defaultPiAgentDir } from './pi/piRuntime.ts';
import { createStartupUpdate, touchLastUpdateCheckAt } from './pi/startupUpdate.ts';
import { defaultUpdaterStatePath } from './pi/updaterState.ts';
import { scanAttachments, savePasteImage, savePastedText, readImageDataUrl, listProjectFiles } from './attachments.ts';
import { ATTACHMENT_DIALOG_FILTER } from '@forge/core';
import { IPC_INVOKE, IPC_EVENT, FORGE_EVENTS, IPC_WINDOW_MINIMIZE, IPC_WINDOW_MAXIMIZE, IPC_WINDOW_CLOSE, IPC_WINDOW_IS_MAXIMIZED, IPC_DIALOG_OPEN_DIRECTORY, IPC_DIALOG_OPEN_FILE, IPC_SHELL_OPEN_PATH, IPC_ATTACHMENT_SCAN, IPC_CLIPBOARD_SAVE_IMAGE, IPC_CLIPBOARD_SAVE_TEXT, IPC_FILE_READ_IMAGE, IPC_FILE_LIST_PROJECT } from './ipc-contract.ts';
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
 * `project.opened` 到 pi 扩展预热的延后窗口（毫秒）。
 *
 * 预热本身的冷编译是主进程同步 CPU + stat 风暴（10 个扩展包实测 3~9s，占满事件
 * 循环）。若在 openProject 的 handler 内立即触发，会连该请求自身的 IPC 响应一起
 * 堵住：渲染进程卡在 await，紧随其后的 session/querySessionList 根本发不出去，
 * 表现为「项目已显示、会话树空白数秒」。延后到启动关键路径（项目/会话列表 IPC，
 * 毫秒级）之后再生效，代价是预热完成时刻推迟同样的时长（对首条发送无实质影响）。
 */
const PI_WARMUP_DEFER_MS = 1500;

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

/** 注册 IPC：invoke 路由 + 事件转发 + 窗口控制 */
function registerIpc(methodTable: MethodTable, eventBus: NodeJS.EventEmitter): void {
  ipcMain.handle(IPC_INVOKE, (_e, arg: { method: string; params?: Record<string, unknown> }) =>
    invoke(methodTable, arg.method, arg.params),
  );
  for (const event of FORGE_EVENTS) {
    const e: ForgeEvent = event;
    eventBus.on(e, (payload: unknown) => {
      mainWindow?.webContents.send(IPC_EVENT, { event: e, payload });
    });
  }
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

/** electron-updater autoUpdater 的最小端口适配（IN-S03）：方法/事件签名对齐 AutoUpdaterLike */
class ElectronUpdaterAdapter implements AutoUpdaterLike {
  checkForUpdates(): Promise<unknown> {
    return autoUpdater.checkForUpdates();
  }
  downloadUpdate(): Promise<unknown> {
    return autoUpdater.downloadUpdate();
  }
  quitAndInstall(): void {
    // Windows NSIS：非静默安装（isSilent=false）→ 更新时弹出安装器窗口显示安装进度，
    // 装完 --force-run 自动运行应用；成功则应用退出重启（不返回）
    autoUpdater.quitAndInstall(false, true);
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

app.whenReady().then(() => {
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
  registerIpc(methodTable, eventBus);

  // IN-S03：启动自动检查一次更新（fire-and-forget；失败静默，错误经 updater.stateChanged 传递）
  const updaterCheck = methodTable['updater/checkForUpdates'];
  if (updaterCheck) {
    void Promise.resolve()
      .then(() => updaterCheck({}))
      .catch(() => {});
  }

  // 首条消息卡顿修复：项目打开即后台预热 pi 扩展加载（jiti 冷编译 3~9s 不再落在
  // 首条发送路径上）；启动时自动打开首个项目也会触发 project.opened，单点覆盖。
  // 注意：不能在此同步触发——openProject 的 handler 尚未 return，冷编译的同步段会
  // 把该 IPC 响应自身堵住（详见 PI_WARMUP_DEFER_MS 注释），故延后一个窗口期。
  eventBus.on('project.opened', (payload) => {
    const opened = (payload as { path?: unknown }).path;
    if (typeof opened !== 'string' || opened === '') return;
    setTimeout(() => void warmPiResourceLoader(opened), PI_WARMUP_DEFER_MS);
  });

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
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
