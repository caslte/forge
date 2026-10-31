/**
 * Agent 行绑定（v6.37 子 Agent「工具行化」改造）。
 *
 * 背景：子 agent 原先靠输入框上方 Tab 栏 + 独立结果视图呈现。黑盒开发下用户不看
 * agent 内容，常驻 Tab 栏只在抢输入区空间。改造后子 agent 变成消息流里的**一行**
 * （`.agent-row`），与工具行同族、不受工具组折叠影响、并发每个一行。
 *
 * 一行需要把两路数据缝合起来：
 * - 主 agent 的 `agent` 工具调用（消息流里的 role=tool 条目，带 description/prompt 入参）
 * - pi-subagents 派生的子 agent 记录（subagent.updated 事件，带 agentId/描述/状态）
 *
 * 两路到达顺序不定（created 可能先于或晚于 tool.started），也没有共享 ID，所以这里
 * 做一次**纯函数**配对：先按描述精确匹配，余下的按派发顺序（startedAt asc）一一对应。
 * 纯函数的好处是「绑定」不需要任何可变状态，displayItems 每次重算都自洽，切会话/重拉
 * 历史不会残留脏绑定。
 */

/** 一条 `agent` 工具调用（配对输入侧） */
export interface AgentCallRef {
  toolEventId: string;
  /** 工具入参里的任务描述（缺省为 null） */
  description: string | null;
}

/** 一条子 agent 记录（配对输出侧的最小投影） */
export interface SubagentRef {
  agentId: string;
  description: string;
  startedAt: string;
}

/** `agent` 工具调用的展示描述：description 优先，回退 prompt 首行，再回退空串 */
export function agentCallDescription(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const rec = input as Record<string, unknown>;
  const desc = rec['description'];
  if (typeof desc === 'string' && desc.trim() !== '') return desc.trim();
  const prompt = rec['prompt'];
  if (typeof prompt === 'string' && prompt.trim() !== '') {
    const firstLine = prompt.trim().split('\n')[0] ?? '';
    return firstLine.length > 60 ? `${firstLine.slice(0, 59)}…` : firstLine;
  }
  return '';
}

/**
 * 配对 agent 调用 ↔ 子 agent 记录。
 *
 * 规则（确定性、无副作用）：
 * 1. 描述精确相等优先（同名多开时按 startedAt asc 依次吃掉）；
 * 2. 剩余调用与剩余记录按各自顺序一一对应（`agent` 工具是同步派发的，顺序即队列序）；
 * 3. 记录多于调用时多出的记录算「孤儿」，由调用方补一行渲染（见 displayItems）。
 *
 * @returns toolEventId → agentId
 */
export function reconcileAgentBindings(
  calls: AgentCallRef[],
  subagents: SubagentRef[],
): Map<string, string> {
  const out = new Map<string, string>();
  const freeSubs = [...subagents].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
  const taken = new Set<string>();
  const pending: AgentCallRef[] = [];

  // 第一轮：描述精确匹配
  for (const call of calls) {
    const desc = call.description?.trim() ?? '';
    if (desc === '') {
      pending.push(call);
      continue;
    }
    const hit = freeSubs.find((s) => !taken.has(s.agentId) && s.description.trim() === desc);
    if (hit === undefined) {
      pending.push(call);
      continue;
    }
    taken.add(hit.agentId);
    out.set(call.toolEventId, hit.agentId);
  }

  // 第二轮：按顺序兜底（描述被模型改写/截断时仍能配上）
  const rest = freeSubs.filter((s) => !taken.has(s.agentId));
  for (let i = 0; i < pending.length && i < rest.length; i += 1) {
    const call = pending[i]!;
    const sub = rest[i]!;
    out.set(call.toolEventId, sub.agentId);
    taken.add(sub.agentId);
  }

  return out;
}

/** 未被任何调用认领的子 agent（消息流里没有对应工具行时补一行，避免「看不见」） */
export function unboundSubagents(
  subagents: SubagentRef[],
  bindings: Map<string, string>,
): SubagentRef[] {
  const bound = new Set(bindings.values());
  return subagents.filter((s) => !bound.has(s.agentId));
}
