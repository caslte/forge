/**
 * 内置推荐组件清单（docs/prd/07_installer_update.md IN-F02 / TD-IN-03）。
 *
 * v1 = 当前 10 个（清单固化在 forge 包内，可随版本演进）；
 * 预装 = 与 ~/.pi/agent settings.packages 对比补缺（只增不删），经内置 CLI 逐项安装。
 */

/** 推荐组件清单（v1 固化 10 项，顺序即预装顺序） */
export const RECOMMENDED_PLUGINS: string[] = [
  '@tintinweb/pi-subagents',
  '@narumitw/pi-goal',
  '@vndv/pi-codegraph',
  'pi-mcp-adapter',
  'pi-web-access',
  'pi-compact-display',
  'pi-image-view',
  'pi-tool-display',
  '@juicesharp/rpiv-todo',
  '@dietrichgebert/ponytail',
];

/**
 * 计算缺失推荐项（纯函数）：保持推荐顺序，只增不删——
 * installed 为已装包名数组（npm: 前缀应由调用方剥离），返回其中缺失的推荐项。
 */
export function missingRecommended(
  installed: string[],
  recommended: string[] = RECOMMENDED_PLUGINS,
): string[] {
  const have = new Set(installed);
  return recommended.filter((name) => !have.has(name));
}
