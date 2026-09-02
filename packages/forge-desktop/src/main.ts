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
import { app, BrowserWindow, ipcMain, dialog, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createForgeCore, invoke, type MethodTable } from './createForgeCore.ts';
import { SafeStorageKeychainAdapter } from './pi/keychainAdapter.ts';
import { scanAttachments, savePasteImage, readImageDataUrl } from './attachments.ts';
import { IPC_INVOKE, IPC_EVENT, FORGE_EVENTS, IPC_WINDOW_MINIMIZE, IPC_WINDOW_MAXIMIZE, IPC_WINDOW_CLOSE, IPC_WINDOW_IS_MAXIMIZED, IPC_DIALOG_OPEN_DIRECTORY, IPC_DIALOG_OPEN_FILE, IPC_ATTACHMENT_SCAN, IPC_CLIPBOARD_SAVE_IMAGE, IPC_FILE_READ_IMAGE } from './ipc-contract.ts';
import type { ForgeEvent } from './ipc-contract.ts';

/** ESM 下 __dirname 不可用，从 import.meta.url 计算 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
      filters: [
        { name: '图片与文本', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'txt', 'md', 'json', 'log', 'csv', 'yaml', 'yml', 'toml', 'xml', 'html', 'css', 'js', 'ts', 'py', 'java', 'go', 'rs', 'c', 'cpp', 'h'] },
      ],
    } as Electron.OpenDialogOptions;
    const res = mainWindow
      ? await dialog.showOpenDialog(mainWindow, options)
      : await dialog.showOpenDialog(options);
    if (res.canceled) {
      return [];
    }
    return res.filePaths;
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
  // 缩略图读取：磁盘图片 → data URL（仅输入框缩略图/预览用）
  ipcMain.handle(IPC_FILE_READ_IMAGE, (_e, p: unknown) => {
    if (typeof p !== 'string' || p === '') {
      return null;
    }
    return readImageDataUrl(p);
  });
}

app.whenReady().then(() => {
  const storePath = path.join(app.getPath('userData'), 'forge-store.json');
  // P3-D：Windows 下优先用 safeStorage（DPAPI）持久化密钥；不可用时回退环境变量适配器
  const keychain = new SafeStorageKeychainAdapter(
    path.join(app.getPath('userData'), 'forge-keyvault.json'),
    () => safeStorage,
  );
  keychain.restoreEnv();
  const { methodTable, eventBus } = createForgeCore(storePath, { keychain });
  registerIpc(methodTable, eventBus);

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
