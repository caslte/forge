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
  /** 消息附带图片（P3-B：用户粘贴截图/上传图片，base64 数据） */
  images?: Array<{ data: string; mimeType: string }>;
  /** 前端本地标记：该用户消息的图片因当前模型不支持图片输入而未发送（多模态门控） */
  imageSkipped?: boolean;
  /** 工具调用附带（role=tool 时） */
  toolName?: string;
  toolEventId?: string;
  status?: 'started' | 'completed' | 'error';
  /** 工具入参（edit 类含 file_path/old_string/new_string） */
  input?: Record<string, unknown>;
}

export interface ToolEvent {
  toolEventId: string;
  sessionId: string;
  status: 'started' | 'completed' | 'error';
  toolName?: string;
  summary?: string;
  /** 工具入参（edit 类含 file_path/old_string/new_string，供 DiffView 渲染） */
  input?: Record<string, unknown>;
  [k: string]: unknown;
}

export interface ProviderItem {
  id: string;
  name: string;
  type: string;
  baseUrl: string | null;
  models: string[];
  /** 首个模型的上下文窗口（token 数，MP-S06）；未配置为 null（回退 pi 默认） */
  contextWindow?: number | null;
  /** 首模型是否支持图片输入（多模态） */
  vision?: boolean;
  lastError: string | null;
  /** apiKey 安全引用/原值（回显用途，可能为空） */
  apiKey?: string;
}

/** 模型思考级别（模块 05 MP-S05；顺序固定 off→minimal→low→medium→high→xhigh→max） */
export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** 思考级别切换器候选级别（空/缺省时 UI 隐藏切换入口） */
export interface ModelThinkingLevels {
  levels: ThinkingLevel[];
}

/** 会话思考级别查询返回（AC-MP-010，UI 切换器回显） */
export interface SessionThinkingLevel {
  level: ThinkingLevel;
  effective: 'session' | 'global';
}

export type ThemeMode = 'light' | 'dark';

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
