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
  /** 最近查看完成结果时间（已读落盘，来自 forge-store）；空=完成结果未读，绿点显示依据 */
  doneReadAt?: string | null;
}

/** git/getBranchInfo 响应 data（PM-S05，docs/api/01_project.md §10） */
export interface GitBranchInfo {
  isGitRepo: boolean;
  /** 当前分支名；detached 时为短 SHA；空仓库（unborn）为分支名 */
  branch: string;
  /** 本地分支列表（git 默认字典序）；不含远程分支 */
  branches: string[];
  /** 是否有未提交更改（git status 非空） */
  dirty: boolean;
  detached: boolean;
}

/** 输入框项目选择器描述（SM-S01 v3.21）：单视图/多窗口均传入；无归属项目（currentPath=null）则不渲染 */
export interface ProjectPickerDescriptor {
  /** draft=新建会话可选归属；session=会话中只读信息（归属不可换） */
  mode: 'draft' | 'session';
  /** 当前项目路径：草稿=目标项目；会话=归属项目 */
  currentPath: string | null;
  /** 显示名（别名优先，回退路径末段） */
  currentName: string;
  /** 已打开项目列表（按后端序） */
  items: Array<{ path: string; name: string }>;
}

export interface ConversationMessage {
  role: 'user' | 'assistant' | 'tool' | 'system';
  content: string;
  ts: string;
  id?: string;
  /** 消息附带图片（旧会话历史：P3-B 时代的 base64 图片；新会话附件走路径+read，不再产生） */
  images?: Array<{ data: string; mimeType: string }>;
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
  /** 首模型是否启用思考（MP-S07）：reasoning:true */
  reasoning?: boolean;
  /** 首模型启用的思考等级白名单（MP-S07）：由 thinkingLevelMap 非 null 项推导 */
  thinkingLevels?: ThinkingLevel[];
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

/**
 * 子 Agent（API 06 §0 业务对象）。
 * forge-core 内存态（按 sessionId 隔离，不持久化，应用重启后为空）；
 * 终态不可逆（finishedAt/result 一经设置不变）。
 */
export interface Subagent {
  /** 扩展派生的子 agent 唯一 ID（幂等合并键） */
  agentId: string;
  /** agent 类型（如 general-purpose / Explore） */
  agentType: string;
  /** 描述（Tab 显示名，截断由前端处理） */
  description: string;
  /** 状态机：queued → running → completed / failed / stopped */
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  /** 开始时间（ISO 8601） */
  startedAt: string;
  /** 结束时间（终态才有，否则 null） */
  finishedAt: string | null;
  /** 结果全文（completed 才有；failed 时为 null，错误信息走 error 字段） */
  result: string | null;
  /** 失败/终止原因（终态非 completed 时有值） */
  error: string | null;
  /** Token 用量（lifetime 累计；无产出时缺省） */
  usage?: { inputTokens: number; outputTokens: number };
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
