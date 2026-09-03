/**
 * Electron preload 脚本：在隔离的渲染进程环境注入 `window.forge` 桥。
 *
 * - invoke：经 ipcRenderer.invoke 调主进程，返回 ForgeResult 信封
 * - on：订阅主进程转发的 forge:event，按 event 名过滤，返回取消订阅函数
 *
 * contextIsolation: true + nodeIntegration: false，渲染进程只能通过此桥访问 Node/IPC。
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron';
import {
  IPC_INVOKE,
  IPC_EVENT,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_MAXIMIZE,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_IS_MAXIMIZED,
  IPC_DIALOG_OPEN_DIRECTORY,
  IPC_DIALOG_OPEN_FILE,
  IPC_SHELL_OPEN_PATH,
  IPC_ATTACHMENT_SCAN,
  IPC_CLIPBOARD_SAVE_IMAGE,
  IPC_FILE_READ_IMAGE,
  IPC_FILE_LIST_PROJECT,
  type ForgeMethod,
  type ForgeEvent,
} from './ipc-contract.ts';

/** window.forge.window 窗口控制实现 */
const windowControl = {
  minimize(): void {
    ipcRenderer.send(IPC_WINDOW_MINIMIZE);
  },
  toggleMaximize(): void {
    ipcRenderer.send(IPC_WINDOW_MAXIMIZE);
  },
  close(): void {
    ipcRenderer.send(IPC_WINDOW_CLOSE);
  },
  async isMaximized(): Promise<boolean> {
    return ipcRenderer.invoke(IPC_WINDOW_IS_MAXIMIZED);
  },
};

/** window.forge.dialog 原生对话框实现 */
const dialogControl = {
  async selectDirectory(): Promise<string | null> {
    return ipcRenderer.invoke(IPC_DIALOG_OPEN_DIRECTORY) as Promise<string | null>;
  },
  async selectFiles(): Promise<string[]> {
    return ipcRenderer.invoke(IPC_DIALOG_OPEN_FILE) as Promise<string[]>;
  },
};

/** window.forge.file 附件能力：路径解析 / 密钥嗅探 / 截图落盘（统一给路径） */
const fileControl = {
  getPathForFile(file: File): string {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      return '';
    }
  },
  async scanAttachments(paths: string[]): Promise<Array<{ path: string; name: string; flagged: boolean }>> {
    return ipcRenderer.invoke(IPC_ATTACHMENT_SCAN, paths) as Promise<Array<{ path: string; name: string; flagged: boolean }>>;
  },
  async savePasteImage(base64Data: string, ext?: string): Promise<{ path: string; name: string } | null> {
    return ipcRenderer.invoke(IPC_CLIPBOARD_SAVE_IMAGE, base64Data, ext) as Promise<{ path: string; name: string } | null>;
  },
  async readImage(p: string): Promise<string | null> {
    return ipcRenderer.invoke(IPC_FILE_READ_IMAGE, p) as Promise<string | null>;
  },
  async listProjectFiles(root: string): Promise<string[]> {
    return ipcRenderer.invoke(IPC_FILE_LIST_PROJECT, root) as Promise<string[]>;
  },
};

/** window.forge.shell 系统能力：文件管理器打开目录 */
const shellControl = {
  async openPath(path: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_SHELL_OPEN_PATH, path) as Promise<boolean>;
  },
};

/** forge:event 多路复用：单条 ipcRenderer 监听分发到多类 ForgeEvent */
const eventListeners = new Map<ForgeEvent, Set<(payload: unknown) => void>>();
let ipcEventListening = false;

function ensureIpcEventListening(): void {
  if (ipcEventListening) return;
  ipcEventListening = true;
  // 单例监听，避免每个 window.forge.on 都往 IpcRenderer 追加监听导致 MaxListenersExceededWarning（10 上限）
  ipcRenderer.on(IPC_EVENT, (_e: Electron.IpcRendererEvent, arg: { event: string; payload: unknown }) => {
    const listeners = eventListeners.get(arg.event as ForgeEvent);
    if (listeners === undefined || listeners.size === 0) return;
    for (const fn of listeners) {
      try {
        fn(arg.payload);
      } catch {
        // 单个监听异常不影响其他订阅者
      }
    }
  });
}

/** window.forge 桥实现 */
const forgeBridge = {
  invoke(method: ForgeMethod, params?: Record<string, unknown>) {
    return ipcRenderer.invoke(IPC_INVOKE, { method, params });
  },
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void {
    ensureIpcEventListening();
    let set = eventListeners.get(event);
    if (set === undefined) {
      set = new Set();
      eventListeners.set(event, set);
    }
    set.add(listener);
    return () => {
      const current = eventListeners.get(event);
      if (current === undefined) return;
      current.delete(listener);
      if (current.size === 0) {
        eventListeners.delete(event);
      }
    };
  },
  window: windowControl,
  dialog: dialogControl,
  shell: shellControl,
  file: fileControl,
};

contextBridge.exposeInMainWorld('forge', forgeBridge);
