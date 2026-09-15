/**
 * 内置推荐组件清单（docs/prd/07_installer_update.md IN-F02 / TD-IN-03）。
 *
 * v1 = 当前 6 个（清单固化在 forge 包内，可随版本演进）；
 * 预装 = 与 ~/.pi/agent settings.packages 对比补缺（只增不删），经内置 CLI 逐项安装。
 *
 * 仅保留 forge 内核必备项（子代理编排 / 目标模式 / MCP 网关 / 网页访问 / 紧凑展示 / 任务列表）。
 * 其余扩展（`@vndv/pi-codegraph` / `pi-image-view` / `pi-tool-display` / `@dietrichgebert/ponytail`）
 * 由宿主 `pi` CLI 自带 / 用户按需安装 —— forge 不再代为预装，避免双份装载与版本漂移。
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
  'pi-mcp-adapter',
  'pi-web-access',
  'pi-compact-display',
  '@juicesharp/rpiv-todo',
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
