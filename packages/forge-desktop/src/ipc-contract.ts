/**
 * forge-desktop ←→ forge-ui IPC 契约（唯一事实来源）。
 *
 * 本文件定义渲染进程（forge-ui）通过 preload 暴露的 `window.forge` 完整接口，
 * 以及主进程（forge-desktop）如何把方法调用路由到 forge-core 的 Api 方法映射、
 * 如何把 Api 事件转发到渲染进程。UI 侧与主进程侧都引用同一组方法名/事件名，
 * 避免两边漂移。
 *
 * 使用方式：
 * - UI 侧：`window.forge.invoke('project/queryProjectList')` / `window.forge.on('tool.started', fn)`
 * - 主进程侧：见 `preload.ts`（bridge）与 `main.ts`（路由 + 事件转发）
 */
import type { RpcResult, ConversationCompactedPayload } from '@forge/core';

/** 全部可调用方法（= forge-core 各 Api 的 methods map 键并集） */
export type ForgeMethod =
  // project（01）
  | 'project/addProject'
  | 'project/removeProject'
  | 'project/queryProjectList'
  | 'project/openProject'
  | 'project/updateProjectAlias'
  | 'project/reorderProjects'
  | 'project/setTrust'
  // session（02）
  | 'session/createSession'
  | 'session/querySessionList'
  | 'session/deleteSession'
  | 'session/updateSessionAlias'
  | 'session/getSessionStatus'
  | 'session/attachSessionWindow'
  | 'session/detachSessionWindow'
  // conversation（03）
  | 'conversation/sendMessage'
  | 'conversation/cancelStream'
  | 'conversation/queryHistory'
  | 'conversation/getContextUsage'
  | 'conversation/compact'
  // tool（04）
  | 'tool/queryToolEvents'
  // model（05）
  | 'model/queryProviderList'
  | 'model/saveProvider'
  | 'model/deleteProvider'
  | 'model/queryModels'
  | 'model/setDefault'
  | 'model/getSessionModel'
  | 'model/setSessionModel'
  | 'model/getModelThinkingLevels'
  | 'model/getSessionThinkingLevel'
  | 'model/setSessionThinkingLevel'
  // subagent（06）
  | 'subagent/queryList'
  | 'subagent/stop'
  | 'subagent/clearFinished'
  | 'subagent/queryOutput';

/** preload ↔ main 窗口控制通道 */
export const IPC_WINDOW_MINIMIZE = 'forge:window:minimize';
export const IPC_WINDOW_MAXIMIZE = 'forge:window:maximize';
export const IPC_WINDOW_CLOSE = 'forge:window:close';
export const IPC_WINDOW_IS_MAXIMIZED = 'forge:window:isMaximized';

/** preload ↔ main 原生对话框通道 */
export const IPC_DIALOG_OPEN_DIRECTORY = 'forge:dialog:openDirectory';
export const IPC_DIALOG_OPEN_FILE = 'forge:dialog:openFile';

/** preload ↔ main 附件通道（统一给路径：嗅探 + 截图落盘 + 缩略图读取） */
export const IPC_ATTACHMENT_SCAN = 'forge:attachment:scan';
export const IPC_CLIPBOARD_SAVE_IMAGE = 'forge:clipboard:saveImage';
export const IPC_FILE_READ_IMAGE = 'forge:file:readImage';

/** 全部事件名（与 forge-core 各 Api events.emit 的 channel 一致） */
export type ForgeEvent =
  | 'project.opened'
  | 'project.removed'
  | 'session.statusChanged'
  | 'session.removed'
  | 'session.updated'
  | 'conversation.statusChanged'
  | 'conversation.delta'
  | 'conversation.message'
  | 'conversation.error'
  | 'conversation.compacting'
  | 'conversation.compacted'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.error'
  | 'model.providersChanged'
  | 'subagent.updated'
  | 'subagent.removed';

/** 全部事件名运行时数组（主进程遍历注册转发，避免遗漏事件） */
export const FORGE_EVENTS: readonly ForgeEvent[] = [
  'project.opened',
  'project.removed',
  'session.statusChanged',
  'session.removed',
  'session.updated',
  'conversation.statusChanged',
  'conversation.delta',
  'conversation.message',
  'conversation.error',
  'conversation.compacting',
  'conversation.compacted',
  'tool.started',
  'tool.completed',
  'tool.error',
  'model.providersChanged',
  'subagent.updated',
  'subagent.removed',
];

/** 子 Agent 信息（API 06 §0 业务对象；与 forge-ui types.ts 的 Subagent 字段一致） */
export interface SubagentInfo {
  /** 扩展派生的子 agent 唯一 ID（幂等合并键） */
  agentId: string;
  /** agent 类型（如 general-purpose / Explore） */
  agentType: string;
  /** 描述（Tab 显示名，截断由前端处理） */
  description: string;
  /** 状态机：queued → running → completed / failed / stopped；终态不可逆 */
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

/** subagent/queryList 请求参数 */
export interface SubagentQueryListParams {
  sessionId: string;
}

/** subagent/stop 请求参数 */
export interface SubagentStopParams {
  sessionId: string;
  agentId: string;
}

/** subagent/clearFinished 请求参数 */
export interface SubagentClearFinishedParams {
  sessionId: string;
}

/** subagent/queryOutput 请求参数（wu-06 v1.1 实时过程查看） */
export interface SubagentQueryOutputParams {
  sessionId: string;
  agentId: string;
  /** 单次读取尾部字节上限（默认/上限 64KB） */
  maxBytes?: number;
}

/** subagent/queryOutput 响应 data（扩展任务输出文件只读 tail） */
export interface SubagentQueryOutputResult {
  /** 输出文件是否存在（false = 无过程记录） */
  exists: boolean;
  /** 文件总字节数（exists 时有效） */
  size: number;
  /** 尾部内容（UTF-8，多字节边界安全截断） */
  chunk: string;
}

/** subagent/queryList 响应 data（运行中在前，终态按 finishedAt 倒序；无子 agent 时空数组） */
export interface SubagentQueryListResult {
  subagents: SubagentInfo[];
}

/** subagent/clearFinished 响应 data（被移除的终态子 agent ID 列表） */
export interface SubagentClearFinishedResult {
  removed: string[];
}

/** subagent.updated 事件 payload（携带完整记录，前端按 agentId 幂等 upsert） */
export interface SubagentUpdatedPayload {
  sessionId: string;
  subagent: SubagentInfo;
}

/** subagent.removed 事件 payload（清除已完成后被移除的子 agent ID 列表） */
export interface SubagentRemovedPayload {
  sessionId: string;
  agentIds: string[];
}

/**
 * conversation.compacted 事件 payload（P3-A）：一次上下文压缩完成。
 * 手动压缩与运行时自动压缩都会发射；UI 收到后应重拉会话历史并提示用户。
 */
export type { ConversationCompactedPayload };

/** IPC 主通道：渲染进程发起方法调用 */
export const IPC_INVOKE = 'forge:invoke';

/** IPC 主通道：主进程向渲染进程推送事件 */
export const IPC_EVENT = 'forge:event';

/**
 * window.forge 全局（preload 注入）。
 * UI 侧通过 `window.forge` 调用方法并订阅事件。
 */
export interface ForgeBridge {
  /**
   * 调用方法层：params 直接透传给 forge-core 对应 handler，
   * 返回统一信封 `{ code, message, data }`（code=0 成功）。
   */
  invoke(method: ForgeMethod, params?: Record<string, unknown>): Promise<ForgeResult>;
  /**
   * 订阅引擎事件。返回取消订阅函数。
   * 事件 payload 结构 = 各 Api events.emit(channel, …) 的载荷：
   * - project.opened/removed: { path }
   * - session.statusChanged: { sessionId, status }
   * - session.removed: { sessionId }
   * - conversation.statusChanged: { sessionId, status }
   * - conversation.delta: { sessionId, delta }
   * - conversation.message: { sessionId, message }
   * - conversation.error: { sessionId, code, message }
   * - conversation.compacted: ConversationCompactedPayload（{ sessionId, reason, tokensBefore, tokensAfter, summary }）
   * - tool.started: ToolDescriptor / tool.completed: ToolResult / tool.error: ToolErrorInfo
   * - model.providersChanged: { providers }
   * - subagent.updated: SubagentUpdatedPayload（{ sessionId, subagent } 完整记录）
   * - subagent.removed: SubagentRemovedPayload（{ sessionId, agentIds }）
   */
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void;
  /** 原生对话框（目录选择等） */
  dialog: ForgeDialog;
}

/**
 * window.forge.dialog 原生对话框能力
 */
export interface ForgeDialog {
  /**
   * 打开系统目录选择框。
   * @returns 用户选中的目录绝对路径；取消/失败返回 null。
   */
  selectDirectory(): Promise<string | null>;
  /**
   * 打开系统文件选择框（多选，图片 + 文本过滤，附件）。
   * @returns 选中文件的绝对路径数组（不读内容，模型自行 read）；取消返回空数组。
   */
  selectFiles(): Promise<string[]>;
}

/** window.forge.file：附件统一给路径能力 */
export interface ForgeFile {
  /** 解析拖拽/粘贴的 File 对象对应磁盘绝对路径（剪贴板截图等无盘文件返回空串） */
  getPathForFile(file: File): string;
  /** 附件密钥嗅探：文本文件命中凭据特征 → flagged=true，发送前需用户确认 */
  scanAttachments(paths: string[]): Promise<Array<{ path: string; name: string; flagged: boolean }>>;
  /** 粘贴截图落盘：base64 图片写入系统临时目录，返回真实路径；失败返回 null */
  savePasteImage(base64Data: string, ext?: string): Promise<{ path: string; name: string } | null>;
  /** 磁盘图片读为 data URL（仅输入框缩略图/预览用）；缺失/超大/非图片返回 null */
  readImage(path: string): Promise<string | null>;
}

/** IPC invoke 的返回信封（透传 forge-core RpcResult） */
export interface ForgeResult<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}