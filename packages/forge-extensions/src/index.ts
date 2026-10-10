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

/** ask_user_question 自建内置扩展（Path 2，契约见 docs/plan/ask-user-question-contract.md） */
export * from './askUserQuestion/index.ts';

/** suggest_next_steps 下一步建议工具（契约见 docs/plan/suggest-next-steps.md） */
export * from './suggestNextSteps/index.ts';

/** canvas_hint：按轮次注入「画图偏好 + 画布输出契约」（契约见 docs/plan/canvas-card.md） */
export * from './canvasHint/index.ts';

/**
 * goalBridge：把 pi-goal 的宿主适配（交互 + 状态）接入 forge GUI，不改 pi-goal 源码。
 * 设计与实测结论见 docs/plan/goal-integration-20261010101023.md。
 */
export * from './goalBridge/index.ts';

/** forge-extensions 包版本号（骨架期占位导出） */
export const FORGE_EXTENSIONS_VERSION = '0.1.0';

/**
 * 画布 IR 提示词契约（阶段 1，**默认关闭**）。
 * 由环境变量 FORGE_IR_CANVAS=1 开启；关闭时不注入任何内容，
 * 以保证阶段 1 的通过率验证不影响现有用户。详见 canvasIrHint/extension.ts。
 */
export * from './canvasIrHint/index.ts';

/** 画布 IR 修复回路：校验失败自动回灌回执（预算 1 次），闭环的最后一块。 */
export * from './canvasIrRepair/index.ts';
