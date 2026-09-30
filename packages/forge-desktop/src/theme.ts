/**
 * 窗口底色主题（主进程侧，v3.78.6）。
 *
 * 问题：`BrowserWindow.backgroundColor` 只能在**建窗时刻**给，而那一刻早于任何渲染进程
 * 代码执行（v3.76「窗口先行」之后，这段底色就是用户看到的第一帧）。渲染进程的主题存在
 * `localStorage['forge:theme']`（forge-ui/src/composables/useTheme.ts），主进程在
 * `app.whenReady()` 里读不到——于是暗色主题下冷启动会先闪一帧窗口默认底色（白）。
 *
 * 解法：在 userData 下放一份 JSON 镜像。渲染进程每次解析/切换主题都经 IPC
 * （`forge:theme:set`）回写，主进程下次启动同步读回并作为建窗底色。
 *
 * 关键约定：
 * - **localStorage 仍是唯一事实来源**（它才是真正驱动 `data-theme` 的那个）。本文件只是
 *   一份缓存：渲染进程在模块链里解析出主题后会再回写一次，所以缓存被清/损坏会自愈。
 * - 命名空间刻意独立于 forge-store.json：主题是**壳层窗口属性**，不需要走 forge-core 的
 *   store 模块，也不该被 store 的 schema 与迁移牵连（同 updater-debug.json 的口径）。
 * - 本模块不 import electron，纯 fs/path —— 这样可以在 `node --test` 下直接跑单测。
 */
import fs from 'node:fs';
import path from 'node:path';

export type ThemeMode = 'light' | 'dark';

/**
 * 建窗底色（与 forge-ui/src/design-tokens.css 的 `--background` **逐位一致**）：
 * - light：`oklch(1 0 0)` = #ffffff
 * - dark ：`oklch(0.215 0.008 265)` = #18191d（v6.1 可读性调整：抬底+压字档，rgb(24 25 29)）
 *
 * 逐位一致是硬要求：这份底色是 splash 出现前的那一帧，只要与 splash 底色（同一令牌）
 * 有差，交接口就会看到一次色阶跳变。test/theme.test.ts 直接从 design-tokens.css 解析
 * 令牌并换算成 sRGB 做断言，改令牌不改这里会立刻红。
 */
export const THEME_BACKGROUND: Record<ThemeMode, string> = {
  light: '#ffffff',
  dark: '#18191d',
};

/** 缺省主题：与 useTheme.ts 的「无存储 = dark」、index.html 引导脚本同值 */
export const DEFAULT_THEME: ThemeMode = 'dark';

/** 主题镜像文件绝对路径（userData 目录由调用方传入，本模块不自取 app.getPath） */
export function themeFilePath(userDataDir: string): string {
  return path.join(userDataDir, 'forge-theme.json');
}

/** 取值守卫：IPC 载荷来自渲染进程，不接受 'light'/'dark' 之外的一切 */
export function isThemeMode(value: unknown): value is ThemeMode {
  return value === 'light' || value === 'dark';
}

export function backgroundFor(mode: ThemeMode): string {
  return THEME_BACKGROUND[mode];
}

/**
 * 同步读主题镜像。文件缺失 / JSON 损坏 / 取值非法一律回默认值——
 * 「读不到就用默认主题」不会让启动失败，与渲染进程的缺省行为一致。
 */
export function readThemeSync(userDataDir: string): ThemeMode {
  try {
    const raw = JSON.parse(fs.readFileSync(themeFilePath(userDataDir), 'utf8')) as {
      mode?: unknown;
    };
    return isThemeMode(raw?.mode) ? raw.mode : DEFAULT_THEME;
  } catch {
    return DEFAULT_THEME;
  }
}

/**
 * 原子写主题镜像（tmp + rename，同 forge-store / piModelsFileAdapter）：崩溃或断电
 * 不会留下半截 JSON 让下次启动读到损坏文件。
 *
 * @returns 是否落盘成功。失败仅意味着「下次冷启动底色回默认」，不影响本次会话
 *          （当前窗口底色由调用方就地 setBackgroundColor 更新），故调用方只记日志。
 */
export function writeTheme(userDataDir: string, mode: ThemeMode): boolean {
  const target = themeFilePath(userDataDir);
  const tmp = `${target}.tmp`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify({ mode }, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // 清理失败无所谓：tmp 文件不参与读取
    }
    return false;
  }
}
