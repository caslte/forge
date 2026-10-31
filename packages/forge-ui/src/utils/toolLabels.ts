/**
 * 工具名 → 本地化文案的唯一映射表（v6.37 从 ToolCallCard 抽出）。
 *
 * 抽出原因：子 Agent 改成消息流里的一行后，Agent 行也要把子 agent 内部正在跑的
 * 工具名翻译成中文（「正在执行 grep…」），两处各抄一张表必然漂移。
 *
 * key 是与后端工具名比对的逻辑串，**不动**；展示值进 i18n 字典；未知工具回退原名。
 */
import type { MessageKey } from '../i18n/index.ts';

export const TOOL_LABELS: Record<string, MessageKey> = {
  ask_user_question: 'tool.askUser',
  read: 'tool.readFile',
  view: 'tool.readFile',
  write: 'tool.writeFile',
  apply_patch: 'tool.writeFile',
  edit: 'tool.editFile',
  multi_edit: 'tool.editFile',
  bash: 'tool.runCommand',
  powershell: 'tool.runCommand',
  shell: 'tool.runCommand',
  grep: 'tool.searchContent',
  find: 'tool.findFile',
  glob: 'tool.findFile',
  ls: 'tool.listDir',
  websearch: 'tool.webSearch',
  web_search: 'tool.webSearch',
  webfetch: 'tool.webFetch',
  web_fetch: 'tool.webFetch',
  todo: 'tool.updateTodo',
  agent: 'tool.spawnAgent',
  get_subagent_result: 'tool.waitAgentResult',
  steer_subagent: 'tool.steerAgent',
  subagentworkflow: 'tool.runAgentWorkflow',
  // goal 接入：pi-goal 的三个终局工具。用户会在消息流里看到它们，
  // 不加映射就显示裸英文工具名（goal_complete / goal_blocked / goal_wait）。
  goal_complete: 'tool.goalComplete',
  goal_blocked: 'tool.goalBlocked',
  goal_wait: 'tool.goalWait',
};

/** 展示用工具名：有中文映射用中文，否则回退原始工具名 */
export function toolLabelKey(name: string | undefined | null): MessageKey | null {
  if (!name) return null;
  return TOOL_LABELS[name.toLowerCase()] ?? null;
}
