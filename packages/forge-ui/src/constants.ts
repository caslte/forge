/**
 * forge-ui 渲染层常量。
 *
 * 与 forge-extensions 的工具名按既有惯例（bridge.ts 同款）**独立声明**——
 * UI 包不依赖扩展包，此处字面量即两侧契约，改名必须两侧同步。
 */

/** suggest_next_steps 工具名（对应 forge-extensions SUGGEST_NEXT_STEPS_TOOL_NAME） */
export const SUGGEST_NEXT_STEPS_TOOL_NAME = 'suggest_next_steps';

/**
 * pi-subagents 注册的派生子 agent 工具名（v6.37 Agent 行改版）。
 *
 * 该工具调用本身不再渲染成工具卡，而是绑定到对应的子 agent 记录、
 * 渲染成消息流里的一行 Agent 行（见 utils/subagentRow.ts）。
 */
export const AGENT_TOOL_NAME = 'agent';

