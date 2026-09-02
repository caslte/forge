/**
 * 子 agent 实时过程解析（wu-06 v1.1 UI 改版）。
 *
 * pi-subagents 把每个子 agent 的会话按 JSONL 追加写到任务输出文件
 * （output-file.ts 约定）：每行一个 JSON 条目，type = user | assistant |
 * toolResult，message.content 为块数组（text / thinking / toolCall）。
 *
 * 本模块把 queryOutput 返回的文件尾部（纯文本 chunk）解析成可渲染的时间线：
 * - assistant 文本块 → markdown 正文条目（按主会话样式渲染）
 * - toolCall / toolResult → 工具摘要行（名称 + 参数预览 + 运行中/完成/失败）
 * - thinking 块、user 条目跳过（用户只关心"干了什么"）
 *
 * 尾部起点可能切断首行：按行解析、解析失败的行静默跳过。
 */

export interface SubagentTextItem {
  kind: 'text';
  text: string;
}

export interface SubagentToolItem {
  kind: 'tool';
  toolCallId: string;
  name: string;
  args: string;
  status: 'running' | 'ok' | 'error';
}

export type SubagentStreamItem = SubagentTextItem | SubagentToolItem;

// ===== 渲染节点分组（与主会话工具组折叠同一交互）=====

export interface SubagentToolGroupNode {
  kind: 'tool-group';
  /** 组内首个工具在 streamItems 中的下标（作展开状态 key，追加稳定） */
  start: number;
  items: SubagentToolItem[];
  counts: Array<{ name: string; count: number }>;
  total: number;
}

export type SubagentStreamNode =
  | SubagentTextItem
  | { kind: 'tool'; item: SubagentToolItem }
  | SubagentToolGroupNode;

/** 连续 ≥2 个工具项聚为可折叠组（默认收起），单工具与文本项原样透传（纯函数） */
export function groupStreamNodes(items: SubagentStreamItem[]): SubagentStreamNode[] {
  const nodes: SubagentStreamNode[] = [];
  let i = 0;
  while (i < items.length) {
    const it = items[i]!;
    if (it.kind !== 'tool') {
      nodes.push(it);
      i += 1;
      continue;
    }
    const start = i;
    const run: SubagentToolItem[] = [];
    while (i < items.length && items[i]!.kind === 'tool') {
      run.push(items[i] as SubagentToolItem);
      i += 1;
    }
    if (run.length >= 2) {
      const counts = new Map<string, number>();
      for (const t of run) counts.set(t.name, (counts.get(t.name) ?? 0) + 1);
      nodes.push({
        kind: 'tool-group',
        start,
        items: run,
        counts: Array.from(counts.entries()).map(([name, count]) => ({ name, count })),
        total: run.length,
      });
    } else {
      nodes.push({ kind: 'tool', item: run[0]! });
    }
  }
  return nodes;
}

/**
 * 清理尾部悬挂围栏：模型嵌套代码块时常把围栏写不配平（收尾少一个或多个 ```），
 * 消息以未闭合围栏收尾会把后续内容渲染进代码框。按 CommonMark 语义模拟开合
 * （带 info string 的行不闭合外层围栏，纯围栏字符行才闭合）；结尾仍开放时丢弃
 * 那行围栏，其后内容按普通文本渲染（符合模型本意：收尾语而非代码）。
 */
export function stripDanglingFence(text: string): string {
  const lines = text.split('\n');
  let openIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (m === null) continue;
    if (openIdx === -1) {
      openIdx = i;
    } else if ((m[2] ?? '').trim() === '') {
      openIdx = -1;
    }
  }
  if (openIdx !== -1) {
    lines.splice(openIdx, 1);
    while (lines.length > 0 && lines[lines.length - 1]!.trim() === '') lines.pop();
    return lines.join('\n');
  }
  return text;
}

/** 把 queryOutput 返回的输出文件尾部解析为渲染时间线（纯函数） */
export function parseSubagentStream(chunk: string): SubagentStreamItem[] {
  const items: SubagentStreamItem[] = [];
  const byCallId = new Map<string, SubagentToolItem>();
  for (const line of chunk.split('\n')) {
    const t = line.trim();
    // 非 JSON 行（尾部切断的首行残片）直接跳过
    if (!t.startsWith('{')) continue;
    let entry: {
      type?: unknown;
      message?: {
        role?: unknown;
        content?: unknown;
        toolCallId?: unknown;
        toolName?: unknown;
        isError?: unknown;
      };
    };
    try {
      entry = JSON.parse(t);
    } catch {
      continue;
    }
    if (entry.type === 'assistant') {
      const content = entry.message?.content;
      if (!Array.isArray(content)) continue;
      let text = '';
      const flush = () => {
        text = stripDanglingFence(text);
        if (text.trim()) {
          items.push({ kind: 'text', text });
          text = '';
        }
      };
      for (const block of content) {
        if (
          block !== null && typeof block === 'object' &&
          (block as { type?: unknown }).type === 'text' &&
          typeof (block as { text?: unknown }).text === 'string'
        ) {
          const t = (block as { text?: string }).text;
          if (t) text += text ? `\n\n${t}` : t;
          continue;
        }
        if (
          block !== null && typeof block === 'object' &&
          (block as { type?: unknown }).type === 'toolCall' &&
          typeof (block as { name?: unknown }).name === 'string'
        ) {
          flush();
          const b = block as { id?: unknown; name: string; arguments?: unknown };
          const item: SubagentToolItem = {
            kind: 'tool',
            toolCallId: typeof b.id === 'string' ? b.id : '',
            name: b.name,
            args: summarizeArgs(b.arguments),
            status: 'running',
          };
          items.push(item);
          if (item.toolCallId) byCallId.set(item.toolCallId, item);
        }
        // thinking 等其他块跳过
      }
      flush();
    } else if (entry.type === 'toolResult') {
      const msg = entry.message ?? {};
      const isError = msg.isError === true;
      const callId = typeof msg.toolCallId === 'string' ? msg.toolCallId : '';
      const hit = callId ? byCallId.get(callId) : undefined;
      if (hit) {
        hit.status = isError ? 'error' : 'ok';
      } else {
        // 尾部切掉了对应的 toolCall 行：从 result 本身合成一行
        items.push({
          kind: 'tool',
          toolCallId: callId,
          name: typeof msg.toolName === 'string' ? msg.toolName : 'tool',
          args: '',
          status: isError ? 'error' : 'ok',
        });
      }
    }
    // user 条目（初始 prompt）跳过
  }
  return items;
}

/** 工具参数预览：序列化截断到 ~80 字符 */
function summarizeArgs(args: unknown): string {
  if (args === null || args === undefined) return '';
  if (typeof args === 'string') return truncate(args);
  try {
    return truncate(JSON.stringify(args));
  } catch {
    return '';
  }
}

function truncate(s: string, max = 80): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}
