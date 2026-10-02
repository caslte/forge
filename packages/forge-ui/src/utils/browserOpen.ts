/**
 * 「用浏览器打开」的渲染层判定（菜单项显不显示用）。
 *
 * 与主进程 `packages/forge-desktop/src/shell/openTarget.ts` 的
 * `BROWSER_OPENABLE_EXT` 是**同一份口径**（.html/.htm）：
 * 渲染层只决定「显不显示」，主进程才是「能不能开」的唯一裁决者
 * （那里还要 lstat 拒软链）。两边必须同步改，否则表现是
 * 「菜单里能点、点了没反应」或反过来「文件能开但没有菜单项」。
 */
const BROWSER_OPEN_EXT = /\.html?$/i;

/** 路径是否可交给「用浏览器打开」（只做扩展名判定，不访问文件系统） */
export function hasBrowserOpenableExt(p: string): boolean {
  return BROWSER_OPEN_EXT.test(p.trim());
}
