import { buildSideBySideDiff } from '@forge/core/side-by-side-diff';
import type { ConversationMessage } from '../types';

/**
 * 改动文件解析纯函数域（无 Vue 依赖，风格对齐 useTurnFooter.ts）。
 *
 * 三处消费方共享 parseFileToolInput：
 * - 本模块 collectTurnChangedFiles（每轮「改动文件汇总卡片」数据源）
 * - useSessionConversation.toToolDiffs（工具组外挂 diff）
 * - ToolCallCard（单工具卡 diff）
 *
 * 入参形状判定（不依赖工具名，避免 mock 旧名与 pi 工具名漂移）：
 * - pi edit：{ path, edits: [{ oldText, newText }] }（同文件可多 hunk）
 * - pi write：{ path, content }
 * - 旧形状（mock/历史）：{ file_path, old_string?, new_string? }
 * - read{path}/bash{command} 等形状不命中返回 null
 */

/** 单个 diff 片段（edit 的一个 hunk / write 的整段新增 / 旧形状整段） */
export interface FileDiffPart {
  oldText: string | null;
  newText: string | null;
}

/** 单文件聚合条目（path 已反斜杠归一为 /） */
export interface ChangedFileEntry {
  path: string;
  /** 末段文件名 */
  name: string;
  added: number;
  removed: number;
  /** 聚合后全部片段（按到达顺序，行内展开渲染用） */
  parts: FileDiffPart[];
}

/** 一轮的改动汇总（displayItems 的 files-summary 项载荷） */
export interface ChangedFileSummary {
  /** 首条文件工具 toolEventId ?? ts + '-files'（流式期间稳定，组件状态不丢） */
  key: string;
  files: ChangedFileEntry[];
  totalAdded: number;
  totalRemoved: number;
}

const asString = (v: unknown): string | null => (typeof v === 'string' ? v : null);

const normalizePath = (p: string): string => p.replace(/\\/g, '/');

/** 解析工具入参为「文件路径 + diff 片段列表」；非修改文件类工具/不可解析 → null */
export function parseFileToolInput(input: unknown): { path: string; parts: FileDiffPart[] } | null {
  if (!input || typeof input !== 'object') return null;
  const rec = input as Record<string, unknown>;

  // pi edit：{ path, edits: [{ oldText, newText }] }
  if (typeof rec.path === 'string' && Array.isArray(rec.edits)) {
    const parts: FileDiffPart[] = [];
    for (const e of rec.edits) {
      if (!e || typeof e !== 'object') continue;
      const oldText = asString((e as Record<string, unknown>).oldText);
      const newText = asString((e as Record<string, unknown>).newText);
      if (oldText === null && newText === null) continue;
      parts.push({ oldText, newText });
    }
    if (parts.length === 0) return null;
    return { path: normalizePath(rec.path), parts };
  }

  // pi write：{ path, content }
  if (typeof rec.path === 'string' && typeof rec.content === 'string') {
    return { path: normalizePath(rec.path), parts: [{ oldText: null, newText: rec.content }] };
  }

  // 旧形状（mock/历史）：{ file_path, old_string?, new_string? }
  if (typeof rec.file_path === 'string') {
    const oldText = asString(rec.old_string);
    const newText = asString(rec.new_string);
    if (oldText === null && newText === null) return null;
    return { path: normalizePath(rec.file_path), parts: [{ oldText, newText }] };
  }

  return null;
}

/** 单片段行数统计：经 buildSideBySideDiff 数 added/removed 行（oldText=null 走纯增快速路径） */
export function countDiffLines(
  oldText: string | null,
  newText: string | null,
): { added: number; removed: number } {
  const rows = buildSideBySideDiff(oldText, newText);
  let added = 0;
  let removed = 0;
  for (const row of rows) {
    if (row.left?.type === 'removed') removed += 1;
    if (row.right?.type === 'added') added += 1;
  }
  return { added, removed };
}

/**
 * 按轮收集改动文件（分轮口径同 computeTurnFooters：user 消息为界）。
 *
 * 只收 role='tool' 且 status='completed' 的消息；同文件多次操作聚合
 * （行数求和、parts 按序拼接）。返回 Map<轮末位置, Summary>：key 为该轮
 * 末尾消息下标 +1（下一条 user 的下标；末轮 = messages.length），与
 * displayItems 单遍循环的插入点直接对齐。轮内无文件工具 → Map 无该键。
 */
export function collectTurnChangedFiles(
  messages: ConversationMessage[],
): Map<number, ChangedFileSummary> {
  const out = new Map<number, ChangedFileSummary>();

  // 当前轮聚合态：path → entry（保持首次出现顺序）；key 取首条文件工具
  let entries = new Map<string, ChangedFileEntry>();
  let firstTool: ConversationMessage | null = null;

  const hasFiles = (): boolean => entries.size > 0;

  const flushTurn = (endPos: number): void => {
    if (!hasFiles()) {
      entries = new Map();
      firstTool = null;
      return;
    }
    const files = [...entries.values()];
    const totalAdded = files.reduce((a, f) => a + f.added, 0);
    const totalRemoved = files.reduce((a, f) => a + f.removed, 0);
    const key = `${firstTool?.toolEventId ?? firstTool?.ts ?? ''}-files`;
    out.set(endPos, { key, files, totalAdded, totalRemoved });
    entries = new Map();
    firstTool = null;
  };

  for (let i = 0; i < messages.length; i += 1) {
    const msg = messages[i]!;
    if (msg.role === 'user') {
      flushTurn(i);
      continue;
    }
    if (msg.role !== 'tool' || msg.status !== 'completed') continue;
    const parsed = parseFileToolInput(msg.input);
    if (!parsed) continue;
    if (!firstTool) firstTool = msg;
    const existing = entries.get(parsed.path);
    if (existing) {
      for (const part of parsed.parts) existing.parts.push(part);
      for (const part of parsed.parts) {
        const lines = countDiffLines(part.oldText, part.newText);
        existing.added += lines.added;
        existing.removed += lines.removed;
      }
    } else {
      let added = 0;
      let removed = 0;
      for (const part of parsed.parts) {
        const lines = countDiffLines(part.oldText, part.newText);
        added += lines.added;
        removed += lines.removed;
      }
      entries.set(parsed.path, {
        path: parsed.path,
        name: parsed.path.split('/').pop() ?? parsed.path,
        added,
        removed,
        parts: [...parsed.parts],
      });
    }
  }
  flushTurn(messages.length);
  return out;
}
