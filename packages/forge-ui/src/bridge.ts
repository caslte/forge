/**
 * forge-ui ↔ forge-desktop IPC 桥封装。
 *
 * 类型与 @forge/desktop src/ipc-contract.ts 保持一致（事实来源在那，冒烟阶段本地声明
 * 避免 forge-ui 依赖 forge-desktop/electron）。契约变更时两边同步。
 */

/** 全部可调用方法（= forge-core 各 Api 的 methods map 键并集） */
export type ForgeMethod =
  | 'project/addProject'
  | 'project/removeProject'
  | 'project/queryProjectList'
  | 'project/openProject'
  | 'project/updateProjectAlias'
  | 'project/reorderProjects'
  | 'project/setTrust'
  | 'session/createSession'
  | 'session/querySessionList'
  | 'session/deleteSession'
  | 'session/updateSessionAlias'
  | 'session/markSessionRead'
  | 'session/getSessionStatus'
  | 'session/attachSessionWindow'
  | 'session/detachSessionWindow'
  | 'conversation/sendMessage'
  | 'conversation/cancelStream'
  | 'conversation/queryHistory'
  | 'conversation/getLastError'
  | 'conversation/getContextUsage'
  | 'conversation/compact'
  | 'conversation/getSlashCommands'
  | 'tool/queryToolEvents'
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
  | 'subagent/queryList'
  | 'subagent/stop'
  | 'subagent/clearFinished'
  | 'subagent/queryOutput';

/** 全部事件名 */
export type ForgeEvent =
  | 'project.opened'
  | 'project.removed'
  | 'session.statusChanged'
  | 'session.removed'
  | 'session.updated'
  | 'conversation.statusChanged'
  | 'conversation.delta'
  | 'conversation.message'
  | 'conversation.queueUpdated'
  | 'conversation.error'
  | 'conversation.compacting'
  | 'conversation.compacted'
  | 'conversation.slashCommandsUpdated'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.error'
  | 'model.providersChanged'
  | 'subagent.updated'
  | 'subagent.removed';

/** IPC invoke 返回信封（透传 forge-core RpcResult） */
export interface ForgeResult<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}

/**
 * 上下文压缩触发来源：manual = 用户点击压缩；auto = 运行时按阈值/溢出自动触发。
 * 与 @forge/core CompactReason 一致（本地声明避免浏览器打包引入 node:events）。
 */
export type CompactReason = 'manual' | 'auto';

/**
 * conversation/compact 的压缩结果（P3-A）。
 * 成功时 ok=true 并携带压缩前后 token 数（未知为 null）；失败时 ok=false 且 message
 * 为原因。与 @forge/core ConversationCompactResult 一致。
 */
export interface ConversationCompactResult {
  ok: boolean;
  /** 失败原因（成功时缺省） */
  message?: string;
  tokensBefore?: number | null;
  tokensAfter?: number | null;
  summary?: string | null;
}

/**
 * conversation.compacting 事件 payload：一次上下文压缩开始（手动或自动）。
 * UI 据此锁定输入框并显示"正在压缩"横幅；与 compacted 成对出现。
 * 与 @forge/core ConversationCompactingPayload 一致。
 */
export interface ConversationCompactingPayload {
  sessionId: string;
  reason: CompactReason;
}

/**
 * conversation.compacted 事件 payload（P3-A）：一次上下文压缩完成（手动或自动）。
 * 自动压缩没有 RPC 入口，UI 靠本事件感知并重拉会话历史。
 * 与 @forge/core ConversationCompactedPayload 一致。
 */
export interface ConversationCompactedPayload {
  sessionId: string;
  reason: CompactReason;
  tokensBefore: number | null;
  tokensAfter: number | null;
  summary: string | null;
}

/**
 * conversation/getSlashCommands 的命令条目（CV-S08，AC-CV-026~030）。
 * name 为原始命令名（skill 命令带 `skill:` 前缀）；插入输入框时补 `/` 前缀。
 * 与 docs/api/03_conversation.md §9 一致。
 */
export interface SlashCommand {
  name: string;
  /** 命令描述；缺失为 null（UI 副文本留空） */
  description: string | null;
  /** extension = 扩展命令；skill = 技能；prompt = prompt 模板 */
  source: 'extension' | 'skill' | 'prompt';
}

/** conversation/getSlashCommands 请求参数（省略 sessionId = 草稿态查询） */
export interface GetSlashCommandsParams {
  /** 会话 ID：提供时返回该会话的上报清单（三类全量）；省略时为草稿态（skills + 模板） */
  sessionId?: string;
  /** 草稿态时的项目工作目录（发现项目级 skills/模板）；省略时仅发现全局资源 */
  projectPath?: string;
}

/** conversation/getSlashCommands 响应 data */
export interface GetSlashCommandsResult {
  commands: SlashCommand[];
}

/**
 * conversation.slashCommandsUpdated 事件 payload（CV-S08）：命令上报扩展的上报
 * 到达（会话激活后覆盖降级清单）；UI 据此失效该会话命令清单缓存并重拉。
 */
export interface SlashCommandsUpdatedPayload {
  sessionId: string;
}

/** preload 注入的 window.forge 桥 */
export interface ForgeBridge {
  invoke(method: ForgeMethod, params?: Record<string, unknown>): Promise<ForgeResult>;
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void;
  window: {
    minimize(): void;
    toggleMaximize(): void;
    close(): void;
    isMaximized(): Promise<boolean>;
  };
  dialog: {
    selectDirectory(): Promise<string | null>;
    selectFiles(): Promise<string[]>;
  };
  shell: {
    /** 系统文件管理器打开目录（项目右键"打开项目所在目录"）；失败返回 false */
    openPath(path: string): Promise<boolean>;
  };
  file: {
    /** 拖拽/粘贴 File 对象 → 磁盘绝对路径；无盘文件（剪贴板截图）返回空串 */
    getPathForFile(file: File): string;
    /** 附件密钥嗅探：文本文件命中凭据特征 → flagged=true */
    scanAttachments(paths: string[]): Promise<Array<{ path: string; name: string; flagged: boolean }>>;
    /** 粘贴截图落盘到系统临时目录，返回真实路径；失败返回 null */
    savePasteImage(base64Data: string, ext?: string): Promise<{ path: string; name: string } | null>;
    /** 磁盘图片读为 data URL（仅缩略图/预览用）；缺失/超大/非图片返回 null */
    readImage(path: string): Promise<string | null>;
    /** @ 补全候选：项目内白名单文件绝对路径（BFS 浅层优先，上限 2000）；项目缺失/不可读返回 [] */
    listProjectFiles(projectPath: string): Promise<string[]>;
  };
}

/** 待发附件（统一给路径）：只持路径与嗅探标记，不读内容 */
export interface PendingAttachment {
  path: string;
  name: string;
  /** 命中疑似密钥/凭据：发送前需用户确认 */
  flagged: boolean;
  /** 图片缩略图 data URL（仅图片附件，加载后填充；预览/放大用） */
  dataUrl?: string;
}

/**
 * 调用主进程方法，code !== 0 抛错，成功返回 data。
 * @param method 方法名
 * @param params 请求参数
 * @returns data（已断言非 null）
 */
export async function call<T>(
  method: ForgeMethod,
  params?: Record<string, unknown>,
): Promise<T> {
  const res = await window.forge.invoke(method, params);
  if (res.code !== 0) {
    throw new Error(`${method} 失败（${res.code}）: ${res.message}`);
  }
  return res.data as T;
}

/** 订阅主进程事件，返回取消订阅函数 */
export function subscribe(
  event: ForgeEvent,
  listener: (payload: unknown) => void,
): () => void {
  return window.forge.on(event, listener);
}
