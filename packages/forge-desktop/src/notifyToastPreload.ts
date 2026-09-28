/**
 * 通知小窗专用 preload：给 notifyToast.ts 的 data: URL 页面暴露最小桥。
 *
 * 与主窗口 preload.ts 分离的原因：通知页只需要「上报实测高度 / 关闭 / 激活」三个
 * 单向动作，不复用 window.forge——一是避免通知页拿到整套 forge IPC 能力（最小暴露），
 * 二是主窗口 preload 的 invoke/on 语义对通知页毫无意义。
 *
 * contextIsolation: true；页面侧通过 window.notifyToast 调用。
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  IPC_NOTIFY_TOAST_READY,
  IPC_NOTIFY_TOAST_CLOSE,
  IPC_NOTIFY_TOAST_ACTIVATE,
} from './ipc-contract.ts';

contextBridge.exposeInMainWorld('notifyToast', {
  /** 页面渲染完成并量得通知卡片实际高度（主进程据此调整窗口尺寸并 showInactive） */
  ready(height: number): void {
    ipcRenderer.send(IPC_NOTIFY_TOAST_READY, height);
  },
  /** 页面倒计时到点 / 用户点关闭：滑出动画播完由页面调用 */
  close(): void {
    ipcRenderer.send(IPC_NOTIFY_TOAST_CLOSE);
  },
  /** 用户点击通知正文：主进程关闭堆栈、聚焦主窗口并跳转对应会话 */
  activate(): void {
    ipcRenderer.send(IPC_NOTIFY_TOAST_ACTIVATE);
  },
});
