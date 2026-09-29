/**
 * 内置推荐组件清单（docs/prd/07_installer_update.md IN-F02 / TD-IN-03）。
 *
 * 当前 7 个 = 清单 v2（清单固化在 forge 包内，增删项须递增 RECOMMENDED_LIST_VERSION）；
 * 预装 = 与 forge agent 目录（<userData>/agent）settings.packages 对比补缺（只增不删），经内置 CLI 逐项安装。
 *
 * 仅保留 forge 内核必备项（子代理编排 / 目标模式 / MCP 网关 / 网页访问 / 紧凑展示 / 任务列表 / 持久记忆）。
 * 清单项一律 **npm 裸包名**（与 readPiExtensionList 剥 npm: 前缀后的比对口径一致）；
 * 安装命令由 startupUpdate 统一加 `npm:` 前缀——引擎把裸名按本地路径解析，会直接失败。
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
  // 跨会话持久记忆（MEMORY.md/SCRATCHPAD.md/每日日志 + compaction 交接兜底）。
  // 注意：其记忆根只认 PI_MEMORY_DIR 环境变量、不读 PI_CODING_AGENT_DIR，
  // 发布前需在宿主侧钉根到 <userData>/agent/memory，否则违背 agentDir 隔离（写回 ~/.pi）。
  'pi-memory',
];

/**
 * 推荐清单版本号（升级补装判据，记入 updater-state.json 的 preinstallListVersion）：
 * v1 = 清单前 6 项定稿期的隐式版本（老状态文件缺该字段按 0 处理）；
 * v2 = 新增 pi-memory（记忆功能要求「更新到新版本就一定有」，不能只随新装出现）。
 * 任何增删清单项必须同步递增此号——它决定老用户升级后启动时是否再跑一轮补缺。
 */
export const RECOMMENDED_LIST_VERSION = 2;

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
