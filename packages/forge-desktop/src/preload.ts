/**
 * Electron preload 脚本：在隔离的渲染进程环境注入 `window.forge` 桥。
 *
 * - invoke：经 ipcRenderer.invoke 调主进程，返回 ForgeResult 信封
 * - on：订阅主进程转发的 forge:event，按 event 名过滤，返回取消订阅函数
 *
 * contextIsolation: true + nodeIntegration: false，渲染进程只能通过此桥访问 Node/IPC。
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_INVOKE,
  IPC_EVENT,
  IPC_WINDOW_MINIMIZE,
  IPC_WINDOW_MAXIMIZE,
  IPC_WINDOW_CLOSE,
  IPC_WINDOW_IS_MAXIMIZED,
  IPC_DIALOG_OPEN_DIRECTORY,
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
};

/** window.forge 桥实现 */
const forgeBridge = {
  invoke(method: ForgeMethod, params?: Record<string, unknown>) {
    return ipcRenderer.invoke(IPC_INVOKE, { method, params });
  },
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void {
    const handler = (_e: Electron.IpcRendererEvent, arg: { event: string; payload: unknown }) => {
      if (arg.event === event) {
        listener(arg.payload);
      }
    };
    ipcRenderer.on(IPC_EVENT, handler);
    return () => {
      ipcRenderer.removeListener(IPC_EVENT, handler);
    };
  },
  window: windowControl,
  dialog: dialogControl,
};

contextBridge.exposeInMainWorld('forge', forgeBridge);
