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
  IPC_DIALOG_SAVE_FILE,
  IPC_FILE_WRITE_TEXT,
  IPC_SHELL_OPEN_EXTERNAL,
  IPC_SHELL_PROBE,
  IPC_SHELL_OPEN_PATH,
  IPC_THEME_SET,
  IPC_LOCALE_SET,
  IPC_ATTACHMENT_SCAN,
  IPC_CLIPBOARD_SAVE_IMAGE,
  IPC_CLIPBOARD_SAVE_TEXT,
  IPC_FILE_READ_IMAGE,
  IPC_FILE_LIST_PROJECT,
  IPC_BOOT_SPLASH_READY,
  IPC_BOOT_STATE,
  type ForgeMethod,
  type ForgeEvent,
  type ForgeResult,
  type BootState,
  type ShellProbeResult,
  type ForgeAskUserQuestion,
  type AskUserQuestionRequestPayload,
  type AskUserQuestionReplyParams,
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
  /** 另存对话框：返回用户选定的绝对路径，取消返回 null */
  async saveFile(defaultName: string): Promise<string | null> {
    return ipcRenderer.invoke(IPC_DIALOG_SAVE_FILE, defaultName) as Promise<string | null>;
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
  async savePastedText(text: string): Promise<{ path: string; name: string } | null> {
    return ipcRenderer.invoke(IPC_CLIPBOARD_SAVE_TEXT, text) as Promise<{ path: string; name: string } | null>;
  },
  async readImage(p: string): Promise<string | null> {
    return ipcRenderer.invoke(IPC_FILE_READ_IMAGE, p) as Promise<string | null>;
  },
  async listProjectFiles(root: string): Promise<string[]> {
    return ipcRenderer.invoke(IPC_FILE_LIST_PROJECT, root) as Promise<string[]>;
  },
  /** 写 UTF-8 文本（画布卡片另存用，仅 .html/.htm）；失败返回 false */
  async writeText(path: string, text: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_FILE_WRITE_TEXT, { path, text }) as Promise<boolean>;
  },
};

/** window.forge.shell 系统能力：文件管理器打开目录 / 系统浏览器打开外链 */
const shellControl = {
  async openPath(path: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_SHELL_OPEN_PATH, path) as Promise<boolean>;
  },
  async openExternal(url: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_SHELL_OPEN_EXTERNAL, url) as Promise<boolean>;
  },
  async shellProbe(): Promise<ShellProbeResult> {
    return ipcRenderer.invoke(IPC_SHELL_PROBE) as Promise<ShellProbeResult>;
  },
};

/**
 * window.forge.theme 主题回写（v3.78.6）：把当前主题告知主进程。
 * 单向 fire-and-forget——主进程落盘供下次冷启动建窗取用（建窗时刻读不到 localStorage），
 * 并就地刷新窗口底色。无返回值：回写失败只影响下次启动的底色，渲染进程无需感知。
 */
const themeControl = {
  set(mode: 'light' | 'dark'): void {
    ipcRenderer.send(IPC_THEME_SET, mode);
  },
};

/**
 * window.forge.locale 生效语言回报：与主题通道同构（localStorage 唯一事实来源）。
 * 主进程持镜像仅为系统通知小窗（notifyToast.ts）标题文案取词；fire-and-forget。
 */
const localeControl = {
  set(mode: 'zh-CN' | 'en'): void {
    ipcRenderer.send(IPC_LOCALE_SET, mode);
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

/** 事件订阅内部实现（forge.on 与 forge.askUserQuestion.onRequest 共用同一多路复用） */
function subscribeEvent(event: ForgeEvent, listener: (payload: unknown) => void): () => void {
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
}

/**
 * window.forge.askUserQuestion（Path 2）：
 * - onRequest：复用事件多路复用订阅 conversation.askUserQuestionRequested（收窄类型）
 * - reply：经 IPC_INVOKE 调 askUserQuestion/reply 方法（renderer→main 的唯一上行路径）
 */
const askUserQuestionControl: ForgeAskUserQuestion = {
  onRequest(listener: (payload: AskUserQuestionRequestPayload) => void): () => void {
    return subscribeEvent('conversation.askUserQuestionRequested', (payload) =>
      listener(payload as AskUserQuestionRequestPayload),
    );
  },
  reply(params: AskUserQuestionReplyParams): Promise<ForgeResult<{ delivered: boolean }>> {
    return ipcRenderer.invoke(IPC_INVOKE, {
      method: 'askUserQuestion/reply' satisfies ForgeMethod,
      params,
    }) as Promise<ForgeResult<{ delivered: boolean }>>;
  },
};

/** window.forge 桥实现 */
const forgeBridge = {
  /**
   * 运行平台（主进程 process.platform）。渲染层无法直接读 Node 环境，且 contextIsolation
   * 下 navigator.platform 在 mac/Windows 上都不够可靠判定，故由 preload 静态注入一标量。
   * TitleBar 据此在 macOS 隐藏自定义窗口三键并为 traffic lights 让位。
   */
  platform: process.platform,
  invoke(method: ForgeMethod, params?: Record<string, unknown>) {
    return ipcRenderer.invoke(IPC_INVOKE, { method, params });
  },
  /** 启动状态查询（v3.76 欢迎页门闩「拉」通道；handler 不依赖 core，窗口建好即用） */
  bootState(): Promise<BootState> {
    return ipcRenderer.invoke(IPC_BOOT_STATE) as Promise<BootState>;
  },
  /** splash 上屏回执（v3.78.7）：由 index.html 内联脚本在双 rAF 后调用，供主进程决定何时
   *  把窗口显示出来。单向无返回；即便丢失也不影响功能（主进程有超时兜底）。 */
  splashReady(): void {
    ipcRenderer.send(IPC_BOOT_SPLASH_READY);
  },
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void {
    return subscribeEvent(event, listener);
  },
  askUserQuestion: askUserQuestionControl,
  window: windowControl,
  dialog: dialogControl,
  shell: shellControl,
  theme: themeControl,
  locale: localeControl,
  file: fileControl,
};

contextBridge.exposeInMainWorld('forge', forgeBridge);
