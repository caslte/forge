/**
 * forge-extensions 扩展层入口。
 *
 * 按 docs/overview.md 四层架构，本包承载 forge 业务能力（pi 扩展，TS，jiti
 * 加载）。当前实现：命令上报扩展（slashCommandReporter，CV-S08）。
 */

export {
  slashCommandReporter,
  slashCommandReporterExtension,
  SLASH_COMMANDS_REPORTED_CHANNEL,
} from './slashCommandReporter.ts';
export type { ReportedSlashCommand } from './slashCommandReporter.ts';

/** forge-extensions 包版本号（骨架期占位导出） */
export const FORGE_EXTENSIONS_VERSION = '0.1.0';
