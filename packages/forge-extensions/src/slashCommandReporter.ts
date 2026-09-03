import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

/**
 * 命令上报 channel（forge-desktop 桥接契约，冻结于 docs/api/03_conversation.md
 * 「桥接约定」：与 pi-subagents 的 subagents:* 生命周期事件同构）。
 */
export const SLASH_COMMANDS_REPORTED_CHANNEL = 'slash-commands:reported';

/** 上报载荷中的命令条目（纯数据，三字段；description 缺失为 null） */
export interface ReportedSlashCommand {
  name: string;
  description: string | null;
  source: 'extension' | 'prompt' | 'skill';
}

/**
 * 命令上报扩展（CV-S08 / TD-CV-07，forge-extensions 首个真实 pi 扩展）。
 *
 * session_start 时调用 pi.getCommands() 枚举当前会话可用的斜杠命令
 * （extension / prompt / skill 三类，skill 名自带 skill: 前缀），映射为
 * { name, description: description ?? null, source } 纯数据载荷，经
 * pi.events.emit('slash-commands:reported', { commands }) 上报到会话
 * 事件总线，由 forge-desktop 桥接为会话级缓存与 conversation.slashCommandsUpdated。
 *
 * 失败语义：getCommands 抛错时静默（console.warn 英文日志），不上报、
 * 不阻断 session_start；扩展缺失/上报失败时上层降级为轻量资源查询。
 * 模块级不持有可变状态（多会话并发安全）。
 */
export function slashCommandReporter(pi: ExtensionAPI): void {
  pi.on('session_start', () => {
    try {
      const commands = pi.getCommands();
      pi.events.emit(SLASH_COMMANDS_REPORTED_CHANNEL, {
        commands: commands.map((command) => ({
          name: command.name,
          description: command.description ?? null,
          source: command.source,
        })),
      });
    } catch (err) {
      console.warn('[forge slashCommandReporter] failed to enumerate slash commands:', err);
    }
  });
}

/** InlineExtension 形态（DefaultResourceLoaderOptions.extensionFactories 直装） */
export const slashCommandReporterExtension: InlineExtension = {
  name: 'forge-slash-command-reporter',
  factory: slashCommandReporter,
};
