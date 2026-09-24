/**
 * 草稿态斜杠命令轻量资源查询（WU-CV08-05，docs/api/03_conversation.md §9 桥接约定）。
 *
 * 职责：提供 SlashCommandResources port（forge-core ConversationService 注入用）——
 * 只枚举 skills + prompt 模板，不加载扩展、不创建会话（TD-CV-08）。会话模式上报未到
 * 时降级、草稿态模式直查均经此 port。
 *
 * 实现：每个查询用真实 pi DefaultResourceLoader（cwd=projectPath ?? process.cwd()，
 * agentDir 由工厂解析，noExtensions/noThemes/noContextFiles 轻量化）reload 后映射：
 * - skills -> name=`skill:<name>`，source='skill'
 * - prompts -> name=模板名，source='prompt'
 * 任何失败（loader 创建、reload、getSkills/getPrompts 抛错）console.warn 英文日志后
 * 返回 []（不抛错，AC-CV-033：枚举失败不阻塞输入）。
 *
 * SettingsManager 在 DefaultResourceLoader 构造中可选，loader 不依赖注入也可工作。
 */
import { DefaultResourceLoader } from '@earendil-works/pi-coding-agent';
import type { SlashCommand } from '@forge/core';
import { resolvePiAgentDir } from './piSessionPaths.ts';

/** 草稿态资源查询 port（与 forge-core SlashCommandResources 同构） */
export interface SlashCommandResources {
  listCommands(projectPath?: string): Promise<SlashCommand[]>;
}

/** loader 可注入的最小形态（生产走真实 pi DefaultResourceLoader；测试可传 fake） */
export interface FakeResourceLoader {
  reload(): Promise<void>;
  getSkills(): {
    skills: Array<{ name: string; description: string }>;
    diagnostics: unknown[];
  };
  getPrompts(): {
    prompts: Array<{ name: string; description: string }>;
    diagnostics: unknown[];
  };
}

/** createSlashCommandResources 选项（loader 工厂为内部测试接缝） */
export interface SlashCommandResourceOptions {
  /** pi agent 目录（生产由工厂注入；未注入回退 resolvePiAgentDir 缺省，仅 dev/测试） */
  agentDir?: string;
  /** 测试接缝：替换 loader 创建逻辑（缺省走真实 DefaultResourceLoader） */
  loaderFactory?: (cwd: string, agentDir: string) => FakeResourceLoader;
}

/** 生产 loader：真实 pi DefaultResourceLoader，轻量化装配（不加载扩展/主题/上下文文件） */
function defaultLoaderFactory(cwd: string, agentDir: string): FakeResourceLoader {
  return new DefaultResourceLoader({
    cwd,
    agentDir,
    noExtensions: true,
    noThemes: true,
    noContextFiles: true,
  });
}

/**
 * 创建草稿态斜杠命令资源查询 port。
 * @param agentDir pi agent 目录（生产恒由 createForgeCore 注入）；也可传选项对象（含内部测试接缝）
 * @returns SlashCommandResources（listCommands）
 */
export function createSlashCommandResources(agentDir?: string): SlashCommandResources;
export function createSlashCommandResources(
  options: SlashCommandResourceOptions,
): SlashCommandResources;
export function createSlashCommandResources(
  arg?: string | SlashCommandResourceOptions,
): SlashCommandResources {
  const options: SlashCommandResourceOptions =
    typeof arg === 'string' ? { agentDir: arg } : (arg ?? {});
  const agentDir = options.agentDir ?? resolvePiAgentDir();
  const loaderFactory = options.loaderFactory ?? defaultLoaderFactory;

  return {
    async listCommands(projectPath?: string): Promise<SlashCommand[]> {
      const cwd = projectPath ?? process.cwd();
      try {
        const loader = loaderFactory(cwd, agentDir);
        await loader.reload();
        const skills: SlashCommand[] = loader
          .getSkills()
          .skills.map((s) => ({
            name: `skill:${s.name}`,
            description: s.description && s.description.trim() !== '' ? s.description : null,
            source: 'skill' as const,
          }));
        const prompts: SlashCommand[] = loader
          .getPrompts()
          .prompts.map((p) => ({
            name: p.name,
            description: p.description && p.description.trim() !== '' ? p.description : null,
            source: 'prompt' as const,
          }));
        return [...skills, ...prompts];
      } catch (err) {
        console.warn('[slashCommandResources] failed to enumerate slash commands:', err);
        return [];
      }
    },
  };
}
