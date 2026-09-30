/**
 * 「用浏览器打开」通道的目标校验（主进程侧，CV-TRUST-02 同款红线）。
 *
 * 为什么单独一条通道、而不是复用 IPC_SHELL_OPEN_PATH：
 * openPath 语义上只服务「打开目录」（恒校验目标是真实存在的目录），这是 CV-TRUST-02 的
 * 硬约束——Windows 上 ShellExecuteEx 指向 .exe/.bat/.lnk 即「打开 = 运行」，渲染层任意
 * 字符串直传就等于给 XSS 面配了一条 RCE 链。本模块在**放行文件**之前先把这条链掐窄：
 * 只有「已存在的普通文件 + 白名单扩展名」能过，其余（可执行文件、.js/.url 协议关联、
 * 目录、软链、设备）一律 null。
 *
 * 扩展名白名单与渲染层 `ChangedFilesCard.vue` 的菜单项判定是同一份口径
 * （.html/.htm）——渲染层只负责「显不显示」，主进程才是「能不能开」的唯一裁决者。
 */
import fs from 'node:fs';
import path from 'node:path';

/** 可交给系统默认浏览器打开的扩展名（小写，含点）。刻意只收 html/htm。 */
export const BROWSER_OPENABLE_EXT: readonly string[] = ['.html', '.htm'];

/** 纯判定：路径扩展名是否在白名单内（大小写不敏感；不做 fs 访问） */
export function hasBrowserOpenableExt(p: string): boolean {
  return BROWSER_OPENABLE_EXT.includes(path.extname(p).toLowerCase());
}

/**
 * 校验并归一「用浏览器打开」的目标路径。
 *
 * 依次：非空串 → 词法归一（渲染层拼接的路径可能残留 ./ 与 .. 中间段，ShellExecuteEx
 * 不归一会弹「找不到文件」，与 openPath 同款处理）→ 扩展名白名单 → lstat 必须是
 * **普通文件**。
 *
 * 用 `lstat` 而非 `stat` 是有意的：lstat 不跟随软链，指向 .exe 的 `x.html` 软链因此
 * `isFile()` 为 false 被拒——否则系统可能按软链目标判类型，扩展名白名单形同虚设。
 * （硬链不在此列：它必须与目标同卷、且系统按**我们给的那个路径的扩展名**派发 handler，
 * `x.html` 硬链到 cmd.exe 也只会让浏览器去渲染这个二进制，不会执行它。）
 *
 * @returns 可安全交给 shell.openPath 的绝对路径；不满足任一条件返回 null
 */
export function resolveBrowserOpenTarget(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw === '') return null;
  const normalized = path.normalize(raw);
  if (!hasBrowserOpenableExt(normalized)) return null;
  let st: fs.Stats;
  try {
    st = fs.lstatSync(normalized);
  } catch {
    // 不存在 / 无权限 / 路径含非法字符：一律按「打不开」处理，不把原因透给渲染层
    return null;
  }
  if (!st.isFile()) return null;
  return normalized;
}
