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
import { fileURLToPath, pathToFileURL } from 'node:url';
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
import { ensurePiShellPath } from './pi/shellProbe.ts';
import { createStartupUpdate, touchLastUpdateCheckAt } from './pi/startupUpdate.ts';
import { defaultUpdaterStatePath } from './pi/updaterState.ts';
import { scanAttachments, savePasteImage, savePastedText, readImageDataUrl, listProjectFiles } from './attachments.ts';
import { backgroundFor, isThemeMode, readThemeSync, writeTheme, type ThemeMode } from './theme.ts';
import { statsFromBitmap, FRAME_CONTENT_RATIO_MIN, type FrameStats } from './bootFrame.ts';
import { ATTACHMENT_DIALOG_FILTER } from '@forge/core';
import { IPC_INVOKE, IPC_EVENT, FORGE_EVENTS, IPC_WINDOW_MINIMIZE, IPC_WINDOW_MAXIMIZE, IPC_WINDOW_CLOSE, IPC_WINDOW_IS_MAXIMIZED, IPC_DIALOG_OPEN_DIRECTORY, IPC_DIALOG_OPEN_FILE, IPC_SHELL_OPEN_PATH, IPC_SHELL_OPEN_EXTERNAL, IPC_SHELL_PROBE, IPC_THEME_SET, IPC_ATTACHMENT_SCAN, IPC_CLIPBOARD_SAVE_IMAGE, IPC_CLIPBOARD_SAVE_TEXT, IPC_FILE_READ_IMAGE, IPC_FILE_LIST_PROJECT, IPC_DIALOG_SAVE_FILE, IPC_FILE_WRITE_TEXT, IPC_BOOT_STATE, IPC_BOOT_SPLASH_READY, type BootState } from './ipc-contract.ts';
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
 * 等 splash 真正上屏的最长等待（毫秒）。超时照常继续并显示窗口，绝不让启动卡死。
 * 正常路径由 ready-to-show（Chromium 首次非空绘制）驱动，实测数百毫秒即到；这个上限
 * 只兜「页面始终画不出东西」的极端情况。
 */
const SPLASH_PAINT_MAX_WAIT_MS = 2500;

/**
 * 等一次「合成帧呈出」（presentation）事件的最长等待（毫秒）。超时一律照常继续——
 * 这是纯优化信号，绝不拿它当启动前置条件（宁可少等，不可卡住）。
 */
const FRAME_PRESENT_MAX_WAIT_MS = 700;

/** 显示前已拿到合成帧时，显示后只需等很短的一拍（多数路径下一帧就到）。
 *  取 400ms：足够覆盖「show() 触发一次新合成」的往返，又不至于在最坏路径上白等。 */
const FRAME_PRESENT_AFTER_SHOW_MAX_MS = 400;

/** 显示之后再留的一拍（毫秒，不阻塞）。presentation 事件代表帧已呈出到窗口表面，
 *  但「出现在屏幕上」还要系统合成器走完 swap；紧接着的同步重活会把它压住，故留余量。 */
const SPLASH_PAINT_SETTLE_MS = 300;

/**
 * 等渲染进程把静态 splash 真正画上屏，再显示窗口、让主进程去做同步重活（v3.78.2）。
 *
 * 背景：Electron 的 Node 事件循环与 Chromium UI 线程**是同一个线程**。loadURL 之后
 * 紧跟着的 core 组装（pi SDK 同步求值 ~1.2s）+ 预热（jiti 同步编译 ~2.4s）会把渲染进程
 * 的绘制一起卡住。v3.78.7 实测：HTML 提交（did-navigate）仅 ~77ms，但主进程一占住事件
 * 循环，渲染进程的 first-contentful-paint 就被推到 **5024ms**——此刻窗口若已可见，用户
 * 看到的就是近 5 秒空白（即用户报的「启动闪一秒白」）。所以顺序必须是
 * 「**splash 上屏 → 显示窗口 → 才做重活**」。
 *
 * 信号只用**浏览器进程侧**的 ready-to-show（= 首次非空绘制）：渲染进程此刻正忙于执行
 * Vite dev 的整条模块链，任何渲染进程侧信号都不可用——实测 dom-ready 被
 * DOMContentLoaded 拖到 10.5s，executeJavaScript 的一次 evaluate 被拖到 5.9s。
 * 刻意**不**用 did-navigate 兜底：提交 ≠ 绘制（两者实测差约 5 秒，见上）。
 *
 * v3.78.7 起本函数还承担第二件事：**显示窗口**（createWindow 用 show:false 建窗）。
 * 窗口从建立到 splash 上屏之间必须不可见，否则 Chromium 会用「尚未解析出 HTML 的
 * 空文档」绘制，而空文档的默认底色是纯白——与建窗底色是否取对无关。超时照常 show，
 * 绝不让窗口永不出现。
 *
 * v3.78.8 起再加一层**实测校验**：显示前后各取一次合成帧，用像素统计判断这一帧上有无内容
 * （见 bootFrame.ts）。这层校验同时纠正了 v3.78.7 把宽限放在 show() 之前的顺序错误——详见
 * 函数尾部的说明。
 */
async function waitForSplashPainted(win: BrowserWindow, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  const yieldFor = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const painted = new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    // 首选信号：渲染进程的双 rAF 回执（index.html 内联脚本 → IPC_BOOT_SPLASH_READY）。
    // 它代表「渲染进程已绘制两帧」，是**渲染进程侧**最强的信号（比 ready-to-show 准）。
    // 注意它的上限：rAF 只能说「画了」，说不了「呈到窗口表面了」——后者由函数尾部的
    // 合成帧订阅（presentation 事件）负责，两者互补。
    //
    // 为什么不用 Electron 自带的 ready-to-show / did-navigate：v3.78.7 实测 ready-to-show
    // 在 1206ms 就触发，而页面的 first-contentful-paint 到 6872ms 才出现——主进程紧接着的
    // 同步重活（pi SDK 求值 + jiti 预热）与 Chromium 的合成是同一个线程，把「已渲染」到
    // 「已提交」拖出了 5.6s。拿那两个信号当「已上屏」，都会放出一个内容空白的可见窗口。
    void splashReady.then(() => done(true));
    // 退路：万一渲染进程的脚本没执行（被拦截等），仍以 Chromium 的首个可见绘制兜底
    win.once('ready-to-show', () => done(true));
  });
  const ok = await Promise.race([painted, yieldFor(timeoutMs).then(() => false)]);
  if (!ok) {
    console.log(`[boot] splash 未在 ${timeoutMs}ms 内就绪，放弃等待（照常显示窗口）`);
  }
  // v3.78.7 关键一步：ready-to-show 只表示「页面已渲染出内容」，而「渲染」到「帧真正提交到
  // 窗口表面」还需要浏览器进程参与一次合成——若紧接着就做同步重活，这步会被一起卡住。
  // 实测证据：窗口在 1206ms 显示，但页面的 first-contentful-paint 直到 5716ms 才出现，
  // 中间窗口内容是空白的。
  //
  // v3.78.8：把「窗口上到底有没有内容」从推断改成实测，并纠正 v3.78.7 的顺序错误。
  // v3.78.7 是在 show() **之前**空等 300ms —— 那段宽限给了尚未显示的窗口，而真正需要落地的
  // 那次合成发生在 show() **之后**：show() 只让窗口可见，「屏幕上出现 splash」由其后的下一次
  // 合成决定。若 show() 之后立刻做同步重活，这次合成就地卡住，窗口停在一块空底色上
  // （用户报「一开始没有字，只有白板」）。现改为：
  //   隐藏期确认已有合成帧 → show → 等显示后的合成帧 → 再留一拍 → 才做重活。
  // 只认「有内容」的帧：纯底色帧（白板）不算数，继续等下一帧（超时才带着最后一帧放行）
  const preFrame = await waitForPresentedFrame(win, FRAME_PRESENT_MAX_WAIT_MS, hasContent);
  logPresentedFrame('显示前', preFrame);
  win.show();
  const postFrame = await waitForPresentedFrame(
    win,
    preFrame === null ? FRAME_PRESENT_MAX_WAIT_MS : FRAME_PRESENT_AFTER_SHOW_MAX_MS,
    hasContent,
  );
  logPresentedFrame('显示后', postFrame);
  await yieldFor(SPLASH_PAINT_SETTLE_MS);
  const shownAt = Date.now();
  console.log(
    `[boot] 窗口已显示（splash 就绪 ${shownAt - startedAt}ms, at ${shownAt}），主进程开始同步重活`,
  );
}

/**
 * 等一帧「合成帧呈出」（presentation）事件（v3.78.8）。
 *
 * 信号强度阶梯（v3.78.2 → v3.78.7 → v3.78.8 一路试出来的）：
 *   did-navigate  <  ready-to-show  <  渲染进程 rAF 回执  <  **presentation 事件**
 * 前三个是「已提交 / 已渲染 / 渲染进程画了」，只有 presentation 是浏览器进程侧
 * 「这一帧已经从合成器呈出到窗口表面」——也就是唯一能回答「窗口上是 splash 还是白板」的信号。
 *
 * accept 谓词决定「哪一帧算数」：默认任何一帧都算；启动路径传入「必须有内容」的谓词
 * （纯底色帧即白板，不算数，继续等下一帧）。
 *
 * 超时返回**最后见到的那一帧**（没有则 null），绝不抛错：调用方一律照常继续
 * （宁可少等，不可让窗口不出现）。订阅在拿到合格帧或超时后立即退订——它每帧都拷一张
 * 位图，常开会白白吃掉合成带宽。
 */
function waitForPresentedFrame(
  win: BrowserWindow,
  timeoutMs: number,
  accept: (stats: FrameStats | null) => boolean = () => true,
): Promise<{ ms: number; stats: FrameStats | null } | null> {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let settled = false;
    let last: { ms: number; stats: FrameStats | null } | null = null;
    const finish = (value: { ms: number; stats: FrameStats | null } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        win.webContents.endFrameSubscription();
      } catch {
        /* 订阅未建立或已退订，无需处理 */
      }
      resolve(value);
    };
    // 超时把「最后见到的那一帧」交出去：日志里能看出等不到合格帧时窗口上到底是什么
    const timer = setTimeout(() => finish(last), timeoutMs);
    const onFrame = (image: Electron.NativeImage): void => {
      let stats: FrameStats | null = null;
      try {
        const size = image.getSize();
        // toBitmap()（getBitmap 是它的废弃别名，类型为 void）：原始像素，Windows 上为 BGRA
        stats = statsFromBitmap(image.toBitmap(), size.width, size.height);
      } catch {
        /* 位图读不出时只报时序，不影响启动 */
      }
      last = { ms: Date.now() - startedAt, stats };
      if (stats !== null) dumpBootFrame(image, stats);
      if (accept(stats)) finish(last);
    };
    try {
      win.webContents.beginFrameSubscription(false, onFrame);
    } catch {
      finish(null);
    }
  });
}

/** 「这一帧上有内容」的谓词：位图读不出时不敢下结论，一律放行（宁可少等）。 */
function hasContent(stats: FrameStats | null): boolean {
  return stats === null || stats.contentRatio >= FRAME_CONTENT_RATIO_MIN;
}

/** 帧转储文件序号（一次进程内自增，避免同毫秒覆盖） */
let bootFrameSeq = 0;

/** 单次启动最多转储的帧数：正常路径 1~2 张，上限只防「一直等不到合格帧」时刷爆磁盘 */
const FRAME_DUMP_MAX = 6;

/**
 * 帧转储（维护者诊断，opt-in）：`FORGE_BOOT_FRAME_DUMP=<目录>` 时把启动首帧写成 PNG。
 *
 * 存在理由：白屏这类问题「我这边不白」无法自证，而像素统计只能给出「有没有内容」，
 * 给不出「内容对不对」。转储把现场留成图片，是唯一能事后核对画面本身的证据。
 * 默认不生效（普通用户与环境变量无关），故不构成启动期开销。
 */
function dumpBootFrame(image: Electron.NativeImage, stats: FrameStats): void {
  const dir = process.env.FORGE_BOOT_FRAME_DUMP;
  if (dir === undefined || dir === '' || bootFrameSeq >= FRAME_DUMP_MAX) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    bootFrameSeq += 1;
    const name = `${bootFrameSeq}-${Date.now()}.png`;
    const png = image.toPNG();
    fs.writeFileSync(path.join(dir, name), png);
    console.log(
      `[boot] 首帧转储 ${name}（${png.length}B 内容占比=${(stats.contentRatio * 100).toFixed(2)}%）`,
    );
  } catch (err) {
    console.log(`[boot] 首帧转储失败：${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 一行可 grep 的首帧诊断：窗口上那一刻那一帧，到底是 splash 还是白板。
 * contentRatio 为 0 即「纯底色帧」——正是用户报的「没有字，只有白板」。
 */
function logPresentedFrame(
  stage: string,
  frame: { ms: number; stats: FrameStats | null } | null,
): void {
  if (frame === null) {
    console.log(`[boot] ${stage}合成帧：等待窗口内未呈出（不影响启动）`);
    return;
  }
  const s = frame.stats;
  if (s === null) {
    console.log(`[boot] ${stage}合成帧 at ${frame.ms}ms（位图不可读，仅时序）`);
    return;
  }
  const empty = s.contentRatio < FRAME_CONTENT_RATIO_MIN ? ' ⚠ 纯底色帧（白板）' : '';
  console.log(
    `[boot] ${stage}合成帧 at ${frame.ms}ms ${s.width}x${s.height} ` +
      `内容占比=${(s.contentRatio * 100).toFixed(2)}% 标志块=${(s.brandRatio * 100).toFixed(2)}% ` +
      `底色=${s.background}${empty}`,
  );
}

/**
 * splash 上屏回执的兑现器（v3.78.7）。渲染进程经 IPC_BOOT_SPLASH_READY 触发；模块级单次
 * promise（一次进程只建一个主窗口）。监听在 registerShellIpc 里注册——它发生在 loadURL
 * 之后、页面脚本执行之前，所以回执不会早于监听而丢失。
 */
let notifySplashReady: (() => void) | null = null;
const splashReady = new Promise<void>((resolve) => {
  notifySplashReady = resolve;
});

let mainWindow: BrowserWindow | null = null;

/** 创建主窗口（无边框，自定义标题栏）；dev 模式自动挂 DevTools + F12/Ctrl+Shift+I 快捷键 */
function createWindow(isDev: boolean, theme: ThemeMode): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 900,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: 12, y: 12 },
    // show:false（v3.78.7）：窗口建立后**先不显示**，等 splash 真正上屏再 show（见
    // waitForSplashPainted）。backgroundColor 只能盖住「窗口创建 → 渲染进程首次合成」
    // 这一小段；之后 Chromium 会改用「尚未解析出 HTML 的空文档」绘制，而空文档的默认
    // 底色是**纯白**——暗色主题下这就是用户看到的「启动闪一秒白」，且它与主题取值是否
    // 正确无关（镜像缺失、dev 与 prod 的 userData/localStorage 不同源时同样会白）。
    // 隐藏窗口到 splash 上屏，是唯一不依赖「底色恰好取对」的消除方式。
    // 隐藏期间渲染不受影响：Electron 的 paintWhenInitiallyHidden 默认为 true。
    show: false,
    // 建窗底色（v3.78.6）：窗口建立到首次合成之间唯一的画面，必须与 splash 底色
    // （= 设计令牌 --background，分主题）逐位一致，否则交接口有色阶跳变。主题从
    // userData/forge-theme.json 同步读回（渲染进程每次解析/切换都回写，见 theme.ts 顶部），
    // 读不到时回默认主题（dark）。
    backgroundColor: backgroundFor(theme),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // 隐藏窗口（show:false 到 splash 上屏之间）默认会被 Chromium 节流定时器与 rAF，
      // 而 splash 的上屏回执正是在 rAF 里发出的（见 index.html 内联脚本）——节流会让
      // 回执迟迟不来，窗口就只能等超时兜底才显示。
      backgroundThrottling: false,
    },
  });
  mainWindow = win;
  // 底色与主题是否一致曾被重复投诉（暗色主题下先闪一帧亮底），故留一行可 grep 的启动诊断；
  // getBackgroundColor 回读的是 Electron 实际接受的值，避免「传了但没生效」无人察觉。
  console.log(`[boot] 建窗底色 theme=${theme} bg=${win.getBackgroundColor()}`);
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
 * 建窗并载入 UI（dev 走 Vite dev server，prod 走打包产物）。
 * 首次启动（app.whenReady）与 macOS「点 Dock 图标重开窗口」（app.activate）共用同一条
 * 路径，保证两者的 UI 来源与 dev origin 校验完全一致。
 *
 * 刻意不含两件事：registerShellIpc（ipcMain.handle 对同一 channel 二次注册会抛错，全进程
 * 只注册一次）与 waitForSplashPainted（首次启动需等 splash 上屏，由调用方决定是否等待）。
 */
function createAndLoadWindow(isDev: boolean, themeMode: ThemeMode): BrowserWindow {
  const win = createWindow(isDev, themeMode);
  const devUrl = process.env.FORGE_DEV_SERVER_URL;
  // 导航守卫（Electron 安全清单）：window.forge 桥绑在 webContents 上，跟加载哪个
  // URL 无关——一旦消息里的投毒链接把窗口导航走，攻击者页面就拿到整套 IPC 能力。
  // 故只放行应用自身文档：dev 限 dev server 同源，prod 限 index.html 本体；
  // window.open（target=_blank / JS）一律 deny。
  const allowedOrigin = devUrl ? new URL(devUrl).origin : null;
  const appFileUrl = pathToFileURL(path.join(__dirname, '../../forge-ui/dist/index.html')).href;
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e, target) => {
    let ok = false;
    try {
      ok = allowedOrigin !== null
        ? new URL(target).origin === allowedOrigin
        : target === appFileUrl;
    } catch {
      ok = false;
    }
    if (!ok) e.preventDefault();
  });
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
  return win;
}

/**
 * 注册与 forge-core 无关的 IPC：启动状态查询 + 窗口控制 / 对话框 / 附件 / 文件。
 * v3.76 欢迎页启动链：窗口创建后立即注册（core 组装是异步的，这批 handler 不等它），
 * 保证欢迎页期间窗口最小化/关闭/文件选择等都可用。
 * @param agentDir pi 数据域根（<userData>/agent），shell 健康探测据此解析
 */
function registerShellIpc(bootState: BootState, agentDir: string): void {
  // 启动状态查询（欢迎页门闩「拉」通道）：handler 引用 bootState 对象本身，
  // core 组装完成后原地改写字段即可，无需重注册 handler
  ipcMain.handle(IPC_BOOT_STATE, () => bootState);
  // shell 健康探测（对话区横幅数据源）：与 pi 会话同口径解析 bash，命中 WSL 占位/
  // 三级落空时先自动定位 Git Bash 写配置再复探，只有本机确实没有可用 bash 才回异常，
  // 见 pi/shellProbe.ts（横幅上的「重新检测」也走这条通道：装完 Git 点一下即自愈）
  ipcMain.handle(IPC_SHELL_PROBE, () => ensurePiShellPath(agentDir));
  // splash 上屏回执（v3.78.7）：渲染进程报「已绘制并提交两帧」，主进程据此显示窗口。
  // 监听在这里注册（loadURL 之后、页面脚本执行之前），回执不会早于监听而丢失。
  ipcMain.on(IPC_BOOT_SPLASH_READY, () => notifySplashReady?.());
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
  // 系统文件管理器打开目录（PM 侧栏右键“打开项目所在目录”）；成功 true，失败 false。
  // CV-TRUST-02：这条通道语义上只服务「打开目录」。Windows 上 shell.openPath 指向
  // .exe/.bat/.lnk 即「打开=运行」，渲染层任意字符串不得直传（与 XSS 面组合成 RCE 链）
  // ——恒校验目标必须是真实存在的目录，文件/不存在的路径一律拒绝。
  ipcMain.handle(IPC_SHELL_OPEN_PATH, (_e, p: unknown) => {
    if (typeof p !== 'string' || p === '') return false;
    try {
      if (!fs.statSync(p).isDirectory()) return false;
    } catch {
      return false;
    }
    return shell.openPath(p).then((err) => err === '');
  });
  // 系统浏览器/邮件客户端打开外链（消息正文链接拦截）：只收 http/https/mailto 绝对
  // URL，其余协议一律拒绝——这条通道绝不能转交 openPath（.exe 会被“打开”=运行）。
  ipcMain.handle(IPC_SHELL_OPEN_EXTERNAL, (_e, u: unknown) => {
    if (typeof u !== 'string' || u === '') return false;
    let parsed: URL;
    try {
      parsed = new URL(u);
    } catch {
      return false;
    }
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) return false;
    return shell.openExternal(u).then(() => true).catch(() => false);
  });
  // 画布卡片另存：原生保存对话框选位置，取消返回 null。
  // defaultPath 只取 basename——渲染进程给的是模型起的标题，含 ../ 会把对话框
  // 初始位置带出预期目录，这里一次性掐掉（用户仍可在对话框里自行改文件名）。
  // CV-TRUST-03：对话框返回的路径记入 allowlist，IPC_FILE_WRITE_TEXT 仅放行
  // 与之相等的路径——写盘通道与「用户亲手选定」绑定，渲染进程伪造的其他路径不生效。
  let lastDialogSavePath: string | null = null;
  ipcMain.handle(IPC_DIALOG_SAVE_FILE, async (_e, name: unknown) => {
    const safeName = typeof name === 'string' && name !== '' ? path.basename(name) : 'canvas.html';
    const options = {
      title: '另存为',
      defaultPath: safeName,
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    } as Electron.SaveDialogOptions;
    const res = mainWindow
      ? await dialog.showSaveDialog(mainWindow, options)
      : await dialog.showSaveDialog(options);
    if (res.canceled || !res.filePath) {
      lastDialogSavePath = null;
      return null;
    }
    lastDialogSavePath = res.filePath;
    return res.filePath;
  });
  // 写文本：仅服务「用户刚在保存对话框里亲手选定的路径」这一场景，故限定 .html/.htm；
  // CV-TRUST-03：路径必须与最近一次保存对话框的实际返回相等（见 IPC_DIALOG_SAVE_FILE
  // 处注释）——「对话框挑的」这个威胁模型由 allowlist 强制成立，渲染进程伪造的其他
  // 路径（如启动目录投持久化）在此被拒。
  ipcMain.handle(IPC_FILE_WRITE_TEXT, (_e, args: unknown) => {
    const p = (args as { path?: unknown } | null)?.path;
    const text = (args as { text?: unknown } | null)?.text;
    if (typeof p !== 'string' || p === '' || typeof text !== 'string') return false;
    if (!/\.html?$/i.test(p)) return false;
    if (p !== lastDialogSavePath) return false;
    try {
      fs.writeFileSync(p, text, 'utf8');
      return true;
    } catch {
      return false;
    }
  });
  // 主题回写（v3.78.6）：渲染进程解析/切换主题时告知主进程——落盘供下次冷启动建窗
  // 取用（消除暗色主题下先闪一帧亮底色的现象），并就地刷新当前窗口底色，使
  // 「窗口底色 == 当前主题」在运行期也恒成立（改完不重启也不会有残留旧底色）。
  ipcMain.on(IPC_THEME_SET, (_e, mode: unknown) => {
    if (!isThemeMode(mode)) return; // IPC 载荷来自渲染进程，非 'light'/'dark' 一律忽略
    if (!writeTheme(app.getPath('userData'), mode)) {
      console.log(`[theme] 主题镜像落盘失败（${mode}），下次冷启动底色回默认`);
    }
    mainWindow?.setBackgroundColor(backgroundFor(mode));
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
    // 更新安装策略见 QUIT_AND_INSTALL_OPTIONS：非静默（isSilent=false）→ 安装器显示可见进度页；
    // forceRunAfter=true 配合 build/installer.nsh 的 customInstall（--updated 时拉起应用 + Quit），
    // 向导模式下更新路径依旧零点击、不进结束页（配置详见 electron-builder.yml nsis 块）。
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
  // 建窗底色主题（v3.78.6）：必须在 createWindow 之前同步读回——窗口底色只能在建窗时刻给，
  // 而那一刻渲染进程尚未执行（拿不到 localStorage）。缺省 dark（同 useTheme.ts）。
  const themeMode = readThemeSync(app.getPath('userData'));
  // QA-G1/G4：updater-state.json（手动更新 components 快照 + lastUpdateCheckAt 持久化路径）
  const updaterStatePath = defaultUpdaterStatePath(app.getPath('userData'));
  // pi 数据域根（skills/sessions/models.json/trust.json/settings.json 全部派生于此）：
  // 产品上与终端 pi 的 ~/.pi/agent 隔离，落 forge userData，卸载即随目录清理。
  // 单一注入点——createForgeCore/预热/预装更新共用，内置 CLI 子进程经 PI_CODING_AGENT_DIR 同根。
  const forgeAgentDir = path.join(app.getPath('userData'), 'agent');
  // pi-memory 钉根：该扩展记忆根只认 PI_MEMORY_DIR、不读 PI_CODING_AGENT_DIR，
  // 不钉则记忆文件写回 ~/.pi/agent/memory、破坏上方与终端 pi 的隔离。in-process 扩展
  // 直接读 process.env；内置 CLI 子进程经 buildPiCliEnv 展开 process.env 同源继承。
  // ??= 保留维护者用外部 env 指向自定义记忆根的调试口子。
  process.env.PI_MEMORY_DIR ??= path.join(forgeAgentDir, 'memory');
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
  const win = createAndLoadWindow(!!process.env.FORGE_DEV_SERVER_URL, themeMode);
  registerShellIpc(bootState, forgeAgentDir);

  // ===== v3.78.2：先让静态 splash 上屏，再放开主进程做同步重活 =====
  // core 组装（pi SDK 同步求值）与预热（jiti 同步编译）跑在 Node 事件循环上，而该
  // 循环与 Chromium UI 线程是同一个线程——若紧接着 loadURL 就开跑，渲染进程的创建
  // 与导航提交会一起被卡住，用户看到数秒纯底色白屏（实测 0.6s→4.7s，详见
  // waitForSplashPainted 注释）。此处让主线程先空转等 splash 提交并合成一帧。
  await waitForSplashPainted(win, SPLASH_PAINT_MAX_WAIT_MS);

  // ===== shell 自愈（2026-09）：把「用户自己去 settings.json 填 shellPath」变成自动动作 =====
  // 时机选在这里的理由：splash 已上屏（spawn where/reg 的几十毫秒不会卡首帧），而
  // createForgeCore 还没组装（首个 pi 会话尚未创建）——写进 settings.json 的 shellPath
  // 对之后所有会话立即生效，用户全程无感。
  // 成本可控：probePiShell 先读 settings.json，解析成功（绝大多数机器）直接返回；
  // 只有真不可用才 spawn where git.exe / reg query 找 Git Bash。
  // 失败（本机无 Git）不拦启动：异常留给对话区横幅，用户装完 Git 可点「重新检测」自愈。
  await ensurePiShellPath(forgeAgentDir).catch(() => {});

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
    // pi 数据域根注入（缺省会回退 ~/.pi/agent，生产禁止依赖缺省）
    piAgentDir: forgeAgentDir,
    // 设置页「版本更新」展示用产品版本
    forgeVersion: appVersion,
    // IN-S03：应用自更新端口（updater/* RPC + updater.stateChanged 事件）
    appUpdater,
    // QA-G1：手动组件更新成功后刷新 updater-state components 快照（缺省 null=跳过持久化）
    updaterStatePath,
    // 更新调试开关（userData/updater-debug.json，实时读取；false=普通用户不可见调试控制台）
    getUpdateDebugEnabled: () => readUpdateDebugEnabled(app.getPath('userData')),
    // 模块 09：skill 删除/覆盖导入的回收站能力（Electron Shell API；失败由 skillService 回退永久删除）
    trashItem: (targetPath) => shell.trashItem(targetPath),
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
    warmupPromise = import('./pi/createPiAgentSessionFactory.ts').then((m) =>
      m.warmPiResourceLoader(cwd, forgeAgentDir),
    );
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
    agentDir: forgeAgentDir,
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

/**
 * macOS：关掉最后一个窗口后进程按平台惯例继续驻留（见上方 window-all-closed），此时点
 * Dock 图标须重建窗口。缺此监听时应用会停在「进程活着但没有窗口」的僵尸态——点 Dock 图标
 * 没有任何反应，用户只能 Cmd+Q 退出再重开。
 *
 * 重建复用首次启动同一条路径（createAndLoadWindow）与同一套上屏时序
 * （waitForSplashPainted 内部负责 show()，故此处不再手动 show）：
 * - splashReady 是一次性 promise，届时已 resolved，该函数会跳过等待、直接走合成帧校验；
 * - registerShellIpc 不重复调用（ipcMain.handle 二次注册同一 channel 会抛错）；
 * - bootState 仍是原对象且 ready 通常已为 true，渲染进程加载后直接进主界面。
 * 仅 darwin 需要：其余平台的 window-all-closed 已经退出进程。
 */
app.on('activate', () => {
  if (process.platform !== 'darwin') return;
  if (mainWindow !== null) {
    // 窗口已存在（含被最小化的情况）：恢复可见并聚焦，不重建
    if (!mainWindow.isVisible()) mainWindow.show();
    mainWindow.focus();
    return;
  }
  const win = createAndLoadWindow(
    !!process.env.FORGE_DEV_SERVER_URL,
    readThemeSync(app.getPath('userData')),
  );
  void waitForSplashPainted(win, SPLASH_PAINT_MAX_WAIT_MS);
});
