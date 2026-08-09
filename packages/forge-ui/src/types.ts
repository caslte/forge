/**
 * forge-ui 共享类型。
 * 与 @forge/core / @forge/desktop 的 ipc-contract 保持一致。
 */

export interface ProjectItem {
  path: string;
  alias: string | null;
  lastOpenedAt: string;
  trust: string;
  /** 前端本地状态：是否展开会话列表 */
  expanded?: boolean;
}

export type SessionStatus = 'idle' | 'streaming' | 'error' | 'done';

export interface SessionItem {
  sessionId: string;
  projectPath: string;
  alias: string | null;
  status: SessionStatus;
  lastActiveAt: string;
  /** 前端本地状态：是否有未读完成 */
  unread?: boolean;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  ts: string;
  id?: string;
  /** 工具调用附带（role=tool 时） */
  toolName?: string;
  toolEventId?: string;
  status?: 'started' | 'completed' | 'error';
}

export interface ToolEvent {
  toolEventId: string;
  sessionId: string;
  status: 'started' | 'completed' | 'error';
  toolName?: string;
  summary?: string;
  [k: string]: unknown;
}

export interface ProviderItem {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  models: string[];
  lastError: string | null;
}

export type ThemeMode = 'light' | 'dark';

export type PermissionLevel = 'default' | 'auto' | 'full-access';

/** 子 Agent（占位，forge-core 未实现，UI 预留） */
export interface Subagent {
  agentId: string;
  agentType: string;
  name: string;
  status: 'working' | 'finished' | 'error';
}

/** 任务清单项（占位，forge-core 未实现） */
export interface TaskItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

/** 消息队列项（占位，forge-core 未实现） */
export interface QueueItem {
  id: string;
  text: string;
  status: 'pending' | 'sending';
}
