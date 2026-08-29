/**
 * 会话时间线派生纯函数（CV-S06，AC-CV-014/015/019）。
 *
 * 设计约束（docs/prd/03_conversation.md「CV-S06 会话历史导航」）：
 * - 时间线/浮窗均由当前会话已加载的消息流派生，零新增接口、零新增存储；
 * - 纯 TS、零运行时依赖（仅 `import type` 导入 ../types），Node type stripping 可直跑；
 * - 所有截断按码点（Array.from 展开），绝不产生半个代理对；
 * - 畸形消息（content 非字符串等）按空串处理，不抛异常。
 */
import type { ConversationMessage } from '../types';

/** 时间线条目：当前会话一条用户消息的派生展示 */
export interface TimelineEntry {
  /** 该消息在原 messages 数组中的索引（点击定位用） */
  index: number;
  /** 消息时间戳（透传） */
  ts: string;
  /** 单行展示文本（截断后） */
  text: string;
}

/** 一轮对话快照：该条用户消息 + 其后最后一条助手回复（纯文本截断） */
export interface RoundSnapshot {
  userText: string;
  /** null = 该轮暂无助手回复（等待中/出错，状态提示文案由组件处理） */
  assistantText: string | null;
}

/** 时间线条目单行截断上限（码点） */
const ENTRY_MAX_CODE_POINTS = 40;
/** 快照用户消息截断上限（码点，AC-CV-015） */
const SNAPSHOT_USER_MAX_CODE_POINTS = 120;
/** 快照助手回复截断上限（码点，AC-CV-015） */
const SNAPSHOT_ASSISTANT_MAX_CODE_POINTS = 200;
const ELLIPSIS = '…';

/** 畸形内容按空串处理（content 非字符串不抛异常） */
function safeText(content: unknown): string {
  return typeof content === 'string' ? content : '';
}

/** 单行展示文本：换行/制表等连续空白折叠为单个空格并去首尾 */
function toSingleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * 按码点截断：超上限取前 max 个码点并追加省略号；
 * 恰好等于上限不追加（AC-CV-019「恰等不加」）；
 * Array.from 按 Unicode 码点展开，代理对（emoji 等）保持完整。
 */
function truncateByCodePoints(text: string, max: number): string {
  if (max <= 0) return '';
  const points = Array.from(text);
  if (points.length <= max) return text;
  return points.slice(0, max).join('') + ELLIPSIS;
}

/**
 * 派生时间线条目（AC-CV-014）：仅取 role==='user' 的消息，按数组顺序（时间正序）
 * 生成条目；条目文本为 content 的单行展示文本，按码点截断。
 * tool/assistant/system 消息不进条目；images 字段忽略。
 */
export function buildTimelineEntries(messages: ConversationMessage[]): TimelineEntry[] {
  if (!Array.isArray(messages)) return [];
  const entries: TimelineEntry[] = [];
  for (let i = 0; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || m.role !== 'user') continue;
    entries.push({
      index: i,
      ts: typeof m.ts === 'string' ? m.ts : '',
      text: truncateByCodePoints(toSingleLine(safeText(m.content)), ENTRY_MAX_CODE_POINTS),
    });
  }
  return entries;
}

/**
 * 派生一轮对话快照（AC-CV-015/019）：messages[userIndex] 的用户消息文本
 * （≤120 码点截断 + 省略号）+ 其后（到下一条 user 消息为止）最后一条 assistant
 * 回复（≤200 码点截断 + 省略号）；中间 tool/system 消息跳过。
 *
 * 边界：
 * - 空数组 / 索引越界 / 该索引非 user 消息 → 空会话态（userText 空且 assistantText null）；
 * - 该轮无 assistant → assistantText 为 null（状态提示由组件处理）；
 * - assistant 存在但 content 畸形 → assistantText 为空串（非 null）。
 */
export function buildRoundSnapshot(messages: ConversationMessage[], userIndex: number): RoundSnapshot {
  const empty: RoundSnapshot = { userText: '', assistantText: null };
  if (!Array.isArray(messages)) return empty;
  if (!Number.isInteger(userIndex) || userIndex < 0 || userIndex >= messages.length) return empty;
  const userMsg = messages[userIndex];
  if (!userMsg || userMsg.role !== 'user') return empty;

  let assistantText: string | null = null;
  for (let i = userIndex + 1; i < messages.length; i += 1) {
    const m = messages[i];
    if (!m || m.role === 'user') break; // 下一条 user 即新一轮边界
    if (m.role === 'assistant') {
      assistantText = truncateByCodePoints(safeText(m.content), SNAPSHOT_ASSISTANT_MAX_CODE_POINTS);
    }
  }

  return {
    userText: truncateByCodePoints(safeText(userMsg.content), SNAPSHOT_USER_MAX_CODE_POINTS),
    assistantText,
  };
}
