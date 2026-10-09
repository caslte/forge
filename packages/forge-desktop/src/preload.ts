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
  IPC_SESSION_EXPORT_BUNDLE,
  IPC_SHELL_OPEN_EXTERNAL,
  IPC_SHELL_PROBE,
  IPC_SHELL_OPEN_PATH,
  IPC_SHELL_OPEN_IN_BROWSER,
  IPC_SHELL_OPEN_IN_EDITOR,
  IPC_SHELL_LIST_EDITORS,
  IPC_SHELL_LIST_TERMINAL_SHELLS,
  IPC_THEME_SET,
  IPC_LOCALE_SET,
  IPC_ATTACHMENT_SCAN,
  IPC_CLIPBOARD_SAVE_IMAGE,
  IPC_CLIPBOARD_SAVE_TEXT,
  IPC_FILE_READ_IMAGE,
  IPC_FILE_LIST_PROJECT,
  IPC_BOOT_SPLASH_READY,
  IPC_BOOT_STATE,
  IPC_STARTUP_FLAGS,
  type ForgeMethod,
  type ForgeEvent,
  type ForgeResult,
  type BootState,
  type StartupFlags,
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
  /** 另存对话框：返回用户选定的绝对路径，取消返回 null。kind='canvas'（默认，HTML）| 'session'（ZIP，SM-S08） */
  async saveFile(defaultName: string, kind?: 'canvas' | 'session'): Promise<string | null> {
    return ipcRenderer.invoke(IPC_DIALOG_SAVE_FILE, { name: defaultName, kind }) as Promise<string | null>;
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

/** window.forge.shell 系统能力：文件管理器打开目录 / 默认浏览器打开本地 HTML / 外部编辑器打开文件 / 系统浏览器打开外链 */
const shellControl = {
  async openPath(path: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_SHELL_OPEN_PATH, path) as Promise<boolean>;
  },
  /** 用系统默认浏览器打开本地 HTML；主进程校验（普通文件 + 扩展名白名单），失败 false */
  async openInBrowser(path: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_SHELL_OPEN_IN_BROWSER, path) as Promise<boolean>;
  },
  /**
   * 扫描本机已安装的外部编辑器，回 [{id,label}]（代码树右键菜单按结果分项）。
   * exe 路径不回渲染层——主进程从白名单解析，渲染层只拿 id 和展示名。
   */
  async listEditors(): Promise<{ id: string; label: string }[]> {
    return ipcRenderer.invoke(IPC_SHELL_LIST_EDITORS) as Promise<{ id: string; label: string }[]>;
  },
  /**
   * 探测本机可用的内嵌终端 shell（设置 → 个性化 → 终端 Shell 选项源，TD-TM-05 方案 B）。
   * exe 路径不回渲染层——只回 {id,label}；选定值经 term/create 的 shellId（同一枚举）
   * 下发，由主进程解析成真实 shell。
   */
  async listTerminalShells(): Promise<{ id: string; label: string }[]> {
    return ipcRenderer.invoke(IPC_SHELL_LIST_TERMINAL_SHELLS) as Promise<{ id: string; label: string }[]>;
  },
  /**
   * 用指定编辑器（id 必须来自 listEditors 的白名单）打开一个文件；
   * 主进程校验（普通文件 + 文件名不得以 `-` 开头）并自行解析 exe，失败 false。
   * 只传文件路径 + id——命令名与参数由主进程决定，不接受渲染层指定。
   */
  async openInEditor(path: string, editorId: string): Promise<boolean> {
    return ipcRenderer.invoke(IPC_SHELL_OPEN_IN_EDITOR, { path, editorId }) as Promise<boolean>;
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
    // 临时诊断（模块10 term:data 断链排查，定位后删除）
    if (arg.event === 'term:data') console.log('[term-diag] preload received IPC_EVENT');
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

/**
 * window.forge.session 会话导出（SM-S08）：走 shell 级通道而非 forge-core RPC。
 *
 * 包在主进程就地读盘打包直写目标路径（转录里图片是 base64 内嵌，包体可达数百 MB，
 * 穿 IPC 会再复制两份内存），故不经 IPC_INVOKE 的 core 分发。targetPath 必须是用户
 * 刚在 saveFile 对话框里选定的路径，否则主进程围栏会拒。
 */
const sessionExportControl = {
  /** 导出结果：ok=false 时 reason 说明失败原因，供 UI 就地提示 */
  async exportBundle(sessionId: string, targetPath: string): Promise<{ ok: boolean; reason?: string; bytes?: number }> {
    return ipcRenderer.invoke(IPC_SESSION_EXPORT_BUNDLE, { sessionId, targetPath }) as Promise<{
      ok: boolean;
      reason?: string;
      bytes?: number;
    }>;
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
  /** 启动特征查询（首次使用指引门闩）：主进程同步快照的结论，handler 不依赖 core */
  startupFlags(): Promise<StartupFlags> {
    return ipcRenderer.invoke(IPC_STARTUP_FLAGS) as Promise<StartupFlags>;
  },
  /** splash 上屏回执（v3.78.7）：由 index.html 内联脚本在双 rAF 后调用，供主进程决定何时
   *  把窗口显示出来。单向无返回；即便丢失也不影响功能（主进程有超时兜底）。 */
  splashReady(): void {
    ipcRenderer.send(IPC_BOOT_SPLASH_READY);
  },
  /**
   * v3.87：订阅「窗口已显示」发令（splash 字标入场动效的起跑信号）。
   * 与 splashReady 相反方向：那条是渲染→主（我准备好了），这条是主→渲染（你该演了）。
   * 渲染端带超时兑底，所以本事件丢失不会让字标永久停在起点。
   */
  onSplashShown(listener: () => void): () => void {
    return subscribeEvent('boot.splashShown', listener);
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
  session: sessionExportControl,
};

contextBridge.exposeInMainWorld('forge', forgeBridge);
