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
  | 'session/getSessionStatus'
  | 'session/attachSessionWindow'
  | 'session/detachSessionWindow'
  | 'conversation/sendMessage'
  | 'conversation/cancelStream'
  | 'conversation/queryHistory'
  | 'conversation/getContextUsage'
  | 'conversation/compact'
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
  | 'conversation.error'
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
    selectFiles(): Promise<AttachmentFile[]>;
  };
}

/** 附件文件（P3-B）：图片含 base64 data + mimeType，文本含 utf8 content */
export interface AttachmentFile {
  path: string;
  name: string;
  kind: 'image' | 'text';
  mimeType?: string;
  data?: string;
  content?: string;
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
