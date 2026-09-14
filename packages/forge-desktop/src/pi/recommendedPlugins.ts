/**
 * 内置推荐组件清单（docs/prd/07_installer_update.md IN-F02 / TD-IN-03）。
 *
 * v1 = 当前 10 个（清单固化在 forge 包内，可随版本演进）；
 * 预装 = 与 ~/.pi/agent settings.packages 对比补缺（只增不删），经内置 CLI 逐项安装。
 *
 * Path 2（ask_user_question 自建内置扩展）：**已移除 `@juicesharp/rpiv-ask-user-question`**。
 * 该插件提供同名 `ask_user_question` 工具，与新自建扩展冲突（pi 的「先注册者胜」规则下
 * 加载顺序无保证，会出现谁生效不定的薛定谔状态）。运行时冲突由
 * `createPiAgentSessionFactory.ts` 的 `extensionsOverride` 纯代码过滤兜底
 * （不写用户 settings.json）；此处移除则进一步保证**不再给新用户主动预装**。
 * 已装用户的环境不变——系统 `pi` CLI 仍照常加载该插件（不同宿主，各自独立）。
 */
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
