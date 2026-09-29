/**
 * AI 回复完成 · 系统级通知小窗（Windows 11 通知风格，方案 A 定稿）。
 * 交互原型：prototypes/ai-reply-toast-demo.html（用户选定 A 方案：Win11 原生观感）。
 *
 * 为什么不用 `new Notification()`：原生通知样式完全跟随系统且不可定制（Windows 上还
 * 需要 App User Model ID / 开始菜单快捷方式才带应用名与图标），无法保证与参考形态
 * （应用图标 + 应用名 + 标题 + 3 行正文摘要）一致——故用独立 BrowserWindow 自绘。
 *
 * 结构：每条通知一个透明无边框小窗（frame:false + transparent + focusable:false +
 * alwaysOnTop + skipTaskbar）。圆角、acrylic 质感、滑入滑出动效、hover 暂停倒计时、
 * 关闭按钮全部由页内 CSS/JS 负责；主进程只负责：堆叠定位（右下角，最多 3 条）、
 * 按页面上报的实测高度调整窗口尺寸、以及点击通知后关闭堆栈并聚焦主窗口。
 *
 * 焦点纪律：focusable:false + showInactive()——弹出与关闭全程不抢焦点（对齐系统通知）；
 * 只有用户主动点击通知才聚焦主窗口（activate 回执）。安全兜底：主进程侧超时强关，
 * 页面脚本因任何原因失联（executeJavaScript 失败等）通知也不会永久驻留。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BrowserWindow, ipcMain, screen } from 'electron';
import {
  IPC_NOTIFY_TOAST_READY,
  IPC_NOTIFY_TOAST_CLOSE,
  IPC_NOTIFY_TOAST_ACTIVATE,
} from './ipc-contract.ts';

/** 通知类别：done=回复完成；interrupt=被中断（含用户手动停止）；error=出错 */
export type NotifyToastKind = 'done' | 'interrupt' | 'error';

export interface NotifyToastPayload {
  kind: NotifyToastKind;
  /** 点击通知后要跳转的会话 */
  sessionId: string;
  /** 正文摘要（调用方已完成截断与文案拼装，如「任务：…」） */
  body: string;
}

export interface NotifyToastManager {
  /** 弹出一条通知。主窗口前台聚焦时调用方应先自行跳过（本模块不重复判断） */
  notify(payload: NotifyToastPayload): void;
  /** 关闭全部在屏通知（主窗口关闭/退出时调用，避免孤窗拖住进程退出） */
  disposeAll(): void;
}

export interface NotifyToastManagerOptions {
  getMainWindow: () => BrowserWindow | null;
  /** 通知标题文案语言（渲染进程经 forge:locale:set 回报，缺省 zh-CN） */
  getLocale: () => 'zh-CN' | 'en';
  /** 应用图标（data URI 或 URL）；null 时页面回退字母方块 */
  logoSrc: string | null;
}

/** 标题文案（按 getLocale() 取用） */
const TITLES: Record<NotifyToastKind, Record<'zh-CN' | 'en', string>> = {
  done: { 'zh-CN': '回复已完成', en: 'Reply completed' },
  interrupt: { 'zh-CN': '回复被中断', en: 'Reply interrupted' },
  error: { 'zh-CN': '回复出错', en: 'Reply failed' },
};

/** 通知卡片宽（对齐 Win11 通知 ~384px） */
const TOAST_WIDTH = 384;
/** 窗口四周留白：容纳 CSS 投影（透明窗无边框，投影画在窗口内） */
const MARGIN = 10;
/** 相邻窗口间距（窗口留白互相抵消后，卡片视觉间距 ≈ 10px） */
const WINDOW_GAP = -10;
/** 距屏幕工作区（避开任务栏）右/下边缘的距离 */
const EDGE_MARGIN = 16;
/** 堆叠上限：超过时最旧的通知立即让位（对齐系统通知行为） */
const STACK_MAX = 3;
/** 自动消失（毫秒）：与页面 hover 暂停倒计时同值；主进程侧另加余量强关兜底 */
const AUTO_DISMISS_MS = 6500;
/** 正文摘要硬上限（字符），超出截断加省略号 */
const BODY_MAX_CHARS = 160;

/** 页面实测高度到达前的临时高度（dom-ready 后即被真实值替换） */
const ESTIMATED_TOAST_HEIGHT = 140;

export function createNotifyToastManager(options: NotifyToastManagerOptions): NotifyToastManager {
  /** 单条在屏通知的登记项 */
  interface ToastEntry {
    win: BrowserWindow;
    toastHeight: number;
    sessionId: string;
  }
  /** 在屏通知（index 0 = 最新 = 最靠底部）；win 的 closed 事件会自行摘除并重排 */
  const active: ToastEntry[] = [];
  /** sessionId → 在屏通知：同会话新通知直接替换旧条（对齐系统通知的同应用合并行为，
   *  也兜住 cancel→done 连发、重复 done 等内核侧的多次终态事件） */
  const bySession = new Map<string, ToastEntry>();

  /** 右下角堆叠定位：index 0 贴工作区底边，其余向上排。
   *  显示器取主窗口当前所在屏（多显示器时弹在用户正看的那块屏，而不是固定主屏）。
   *  注意锚点是窗口**底边**（窗口高 = 卡片高 + 上下投影留白），从工作区底边向上累加。 */
  function layout(): void {
    const main = options.getMainWindow();
    const display =
      main && !main.isDestroyed() ? screen.getDisplayMatching(main.getBounds()) : screen.getPrimaryDisplay();
    const wa = display.workArea;
    const x = wa.x + wa.width - EDGE_MARGIN - MARGIN - TOAST_WIDTH;
    let bottomOffset = EDGE_MARGIN;
    for (const t of active) {
      const h = t.toastHeight + MARGIN * 2;
      t.win.setBounds({ x, y: wa.y + wa.height - bottomOffset - h, width: TOAST_WIDTH + MARGIN * 2, height: h });
      bottomOffset += h + WINDOW_GAP;
    }
  }

  function findBySender(sender: Electron.WebContents): ToastEntry | undefined {
    return active.find((t) => t.win.webContents === sender);
  }

  function closeAll(): void {
    for (const t of [...active]) {
      if (!t.win.isDestroyed()) t.win.close();
    }
    active.length = 0;
    bySession.clear();
  }

  // manager 在 main.ts 只创建一次；handler 用 e.sender 区分是哪条通知回的执
  ipcMain.on(IPC_NOTIFY_TOAST_READY, (e, height: unknown) => {
    const entry = findBySender(e.sender);
    if (!entry) return;
    const h = typeof height === 'number' && Number.isFinite(height) ? height : ESTIMATED_TOAST_HEIGHT;
    entry.toastHeight = Math.min(Math.max(Math.round(h), 80), 400);
    layout();
    // showInactive：出现但不抢焦点（focusable:false 的窗口本就不可聚焦，双保险）
    if (!entry.win.isVisible()) entry.win.showInactive();
  });
  ipcMain.on(IPC_NOTIFY_TOAST_CLOSE, (e) => {
    const entry = findBySender(e.sender);
    if (entry && !entry.win.isDestroyed()) entry.win.close();
  });
  ipcMain.on(IPC_NOTIFY_TOAST_ACTIVATE, (e) => {
    const entry = findBySender(e.sender);
    const sessionId = entry?.sessionId;
    closeAll();
    const main = options.getMainWindow();
    if (!main || main.isDestroyed()) return;
    if (main.isMinimized()) main.restore();
    if (!main.isVisible()) main.show();
    main.focus();
    if (sessionId !== undefined) {
      // 跳转会话走既有 forge:event 通道；'notify.focusSession' 由主进程直发，
      // 不经 core eventBus（见 ipc-contract.ts ForgeEvent 注释）
      main.webContents.send('forge:event', { event: 'notify.focusSession', payload: { sessionId } });
    }
  });

  /** 通知页模板（manager 生命周期内构建一次；logo 以 data URI 内联，37KB 级） */
  const pageHtml = buildPageHtml(options.logoSrc);

  return {
    notify(payload: NotifyToastPayload): void {
      // 同会话替换：旧通知立即移位登记并关闭（closed 回调只负责重排，见下）
      const existing = bySession.get(payload.sessionId);
      if (existing !== undefined) {
        bySession.delete(payload.sessionId);
        const i = active.indexOf(existing);
        if (i >= 0) active.splice(i, 1);
        if (!existing.win.isDestroyed()) existing.win.close();
      }
      while (active.length >= STACK_MAX) {
        const oldest = active.pop();
        if (oldest) bySession.delete(oldest.sessionId);
        if (oldest && !oldest.win.isDestroyed()) oldest.win.close();
      }
      const params = new URLSearchParams({
        kind: payload.kind,
        title: TITLES[payload.kind][options.getLocale()],
        body: payload.body,
      });
      const win = new BrowserWindow({
        width: TOAST_WIDTH + MARGIN * 2,
        height: ESTIMATED_TOAST_HEIGHT + MARGIN * 2,
        x: 0,
        y: 0, // 位置由 layout() 在 ready 回执时统一给（showInactive 之前）
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        minimizable: false,
        maximizable: false,
        fullscreenable: false,
        skipTaskbar: true,
        focusable: false,
        hasShadow: false,
        alwaysOnTop: true,
        webPreferences: {
          preload: path.join(__dirname, 'notifyToastPreload.js'),
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: false,
        },
      });
      win.setAlwaysOnTop(true, 'pop-up-menu');
      const entry: ToastEntry = { win, toastHeight: ESTIMATED_TOAST_HEIGHT, sessionId: payload.sessionId };
      active.unshift(entry);
      bySession.set(payload.sessionId, entry);
      // closed（含页面 close()/主进程强关/destroy）统一摘除并让余下通知下移补位
      win.on('closed', () => {
        const i = active.indexOf(entry);
        if (i >= 0) active.splice(i, 1);
        if (bySession.get(payload.sessionId) === entry) bySession.delete(payload.sessionId);
        layout();
      });
      // 主进程侧兜底强关：页面倒计时失联（脚本被拦、IPC 丢失）通知也不永久驻留
      const safety = setTimeout(() => {
        if (!win.isDestroyed()) win.close();
      }, AUTO_DISMISS_MS + 4000);
      safety.unref?.();
      void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(pageHtml)}?${params.toString()}`);
      layout();
    },
    disposeAll: closeAll,
  };
}

// notifyToast.ts 经 tsc 编译为 dist/*.js（ESM），__dirname 需自行计算
const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** HTML 转义（title/body 经 URLSearchParams 传入，页面 innerHTML 前仍转义一次，双保险） */
function escapeHtml(s: string): string {
  return s
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/**
 * 通知页（CSS/JS 与 prototypes/ai-reply-toast-demo.html 的 A 方案一致）。
 * 每条通知以 query 传 kind/title/body；结构：
 *   头部（logo + Forge + hover 出现的关闭钮）→ 标题 → 正文（3 行截断）
 * 交互：滑入 → hover 暂停 6.5s 倒计时 → 滑出后回报 close；点卡片回报 activate。
 */
function buildPageHtml(logoSrc: string | null): string {
  const logoTag = logoSrc
    ? `<img id="logo" class="appicon" alt="" src="${escapeHtml(logoSrc)}">`
    : `<span id="logo-fallback" class="appicon-fallback">F</span>`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { background: transparent; overflow: hidden; user-select: none; }
  body {
    font-family: "Noto Sans CJK SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif;
    padding: 10px; /* = 主进程 MARGIN，投影呼吸空间 */
  }
  .toast {
    position: relative; /* 中断/出错态顶部红细线（::before 绝对定位的锚点） */
    width: ${TOAST_WIDTH}px;
    border-radius: 8px;
    overflow: hidden;
    color: #fff;
    background: rgba(40, 42, 47, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.075);
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.38), 0 2px 8px rgba(0, 0, 0, 0.22);
    padding: 12px 14px 14px;
    cursor: pointer;
    transform: translateX(calc(100% + 24px));
    opacity: 0;
    transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1), opacity 320ms cubic-bezier(0.4, 0, 0.2, 1);
    /* 主进程 showInactive 与首个 rAF 之间的竞态余量：窗口未显示时动画不预演 */
    transition-delay: 60ms;
  }
  .toast.in { transform: translateX(0); opacity: 1; }
  .toast.out { transform: translateX(calc(100% + 24px)); opacity: 0; transition-delay: 0ms; }
  .head { display: flex; align-items: center; gap: 8px; }
  .appicon { width: 16px; height: 16px; border-radius: 4px; flex: none; object-fit: cover; display: block; }
  .appicon-fallback {
    width: 16px; height: 16px; border-radius: 4px; flex: none;
    background: linear-gradient(135deg, #3a3f47, #23262c);
    color: #dfe3e8; font-size: 10px; font-weight: 700;
    display: none; align-items: center; justify-content: center;
  }
  .appname { font-size: 12px; color: rgba(255, 255, 255, 0.63); }
  .actions { margin-left: auto; opacity: 0; transition: opacity 140ms ease; }
  .toast:hover .actions { opacity: 1; }
  .close {
    width: 26px; height: 26px; border: none; border-radius: 5px; padding: 0;
    background: transparent; color: rgba(255, 255, 255, 0.7);
    display: flex; align-items: center; justify-content: center; cursor: pointer;
  }
  .close:hover { background: rgba(255, 255, 255, 0.09); color: #fff; }
  .close svg { width: 14px; height: 14px; }
  .title { margin-top: 6px; font-size: 14px; font-weight: 600; letter-spacing: 0.1px; }
  .body {
    margin-top: 4px;
    font-size: 13px; line-height: 1.58; color: rgba(255, 255, 255, 0.76);
    display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden;
    overflow-wrap: anywhere;
  }
  /* 中断/出错：顶部红色细线 + 标题染红（对齐原型 interrupt 态） */
  .toast.interrupt .title, .toast.error .title { color: #f0b4ae; }
  .toast.interrupt::before, .toast.error::before {
    content: ""; position: absolute; left: 0; right: 0; top: 0; height: 3px;
    background: linear-gradient(90deg, rgba(224, 108, 96, 0.85), rgba(224, 108, 96, 0.15));
  }
  .toast:active { filter: brightness(1.12); }
</style>
</head>
<body>
<div class="toast" id="toast">
  <div class="head">
    ${logoTag}
    <span class="appname">Forge</span>
    <span class="actions">
      <button class="close" id="close" aria-label="关闭">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </span>
  </div>
  <div class="title" id="title"></div>
  <div class="body" id="body"></div>
</div>
<script>
  const q = new URLSearchParams(location.search);
  const toast = document.getElementById('toast');
  document.getElementById('title').textContent = q.get('title') ?? '';
  document.getElementById('body').textContent = q.get('body') ?? '';
  const kind = q.get('kind');
  if (kind === 'interrupt' || kind === 'error') toast.classList.add(kind);
  // fallback 字母方块：模板未注入 logo 时显示（img 缺省隐藏由模板结构保证）
  if (!document.getElementById('logo')) {
    const fb = document.getElementById('logo-fallback');
    if (fb) fb.style.display = 'flex';
  }

  function measuredHeight() { return toast.getBoundingClientRect().height; }
  window.notifyToast.ready(measuredHeight());

  // hover 暂停倒计时（对齐系统通知）；离开后按剩余时间续计
  let remain = ${AUTO_DISMISS_MS}, timer = null, last = 0;
  function start() { last = Date.now(); timer = setTimeout(dismiss, remain); }
  function stop() { if (timer === null) return; clearTimeout(timer); timer = null; remain -= Date.now() - last; }
  function dismiss() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    toast.classList.add('out');
    setTimeout(() => window.notifyToast.close(), 420);
  }
  toast.addEventListener('mouseenter', stop);
  toast.addEventListener('mouseleave', () => { if (!toast.classList.contains('out')) start(); });
  start();

  document.getElementById('close').addEventListener('click', (e) => { e.stopPropagation(); dismiss(); });
  toast.addEventListener('click', () => {
    if (toast.classList.contains('out')) return;
    window.notifyToast.activate();
  });
  // 进入动画：主进程 showInactive 已在 ready 回执里同步完成（或马上完成），
  // 双 rAF 后再入画，保证动画可见
  requestAnimationFrame(() => requestAnimationFrame(() => toast.classList.add('in')));
</script>
</body>
</html>`;
}
