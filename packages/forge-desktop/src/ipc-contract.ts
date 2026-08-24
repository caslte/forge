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
import type { RpcResult } from '@forge/core';

/** 全部可调用方法（= forge-core 各 Api 的 methods map 键并集） */
export type ForgeMethod =
  // project（01）
  | 'project/addProject'
  | 'project/removeProject'
  | 'project/queryProjectList'
  | 'project/openProject'
  | 'project/updateProjectAlias'
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
  // tool（04）
  | 'tool/queryToolEvents'
  // model（05）
  | 'model/queryProviderList'
  | 'model/saveProvider'
  | 'model/deleteProvider'
  | 'model/queryModels'
  | 'model/setDefault'
  | 'model/getSessionModel'
  | 'model/setSessionModel';

/** preload ↔ main 窗口控制通道 */
export const IPC_WINDOW_MINIMIZE = 'forge:window:minimize';
export const IPC_WINDOW_MAXIMIZE = 'forge:window:maximize';
export const IPC_WINDOW_CLOSE = 'forge:window:close';
export const IPC_WINDOW_IS_MAXIMIZED = 'forge:window:isMaximized';

/** preload ↔ main 原生对话框通道 */
export const IPC_DIALOG_OPEN_DIRECTORY = 'forge:dialog:openDirectory';

/** 全部事件名（与 forge-core 各 Api events.emit 的 channel 一致） */
export type ForgeEvent =
  | 'project.opened'
  | 'project.removed'
  | 'session.statusChanged'
  | 'session.removed'
  | 'conversation.statusChanged'
  | 'conversation.delta'
  | 'conversation.message'
  | 'conversation.error'
  | 'tool.started'
  | 'tool.completed'
  | 'tool.error'
  | 'model.providersChanged';

/** 全部事件名运行时数组（主进程遍历注册转发，避免遗漏事件） */
export const FORGE_EVENTS: readonly ForgeEvent[] = [
  'project.opened',
  'project.removed',
  'session.statusChanged',
  'session.removed',
  'conversation.statusChanged',
  'conversation.delta',
  'conversation.message',
  'conversation.error',
  'tool.started',
  'tool.completed',
  'tool.error',
  'model.providersChanged',
];

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
   * - tool.started: ToolDescriptor / tool.completed: ToolResult / tool.error: ToolErrorInfo
   * - model.providersChanged: { providers }
   */
  on(event: ForgeEvent, listener: (payload: unknown) => void): () => void;
  /** 原生对话框（目录选择等） */
  dialog: ForgeDialog;
}

/** window.forge.dialog 原生对话框能力 */
export interface ForgeDialog {
  /**
   * 打开系统目录选择框。
   * @returns 用户选中的目录绝对路径；取消/失败返回 null。
   */
  selectDirectory(): Promise<string | null>;
}

/** IPC invoke 的返回信封（透传 forge-core RpcResult） */
export interface ForgeResult<T = unknown> {
  code: number;
  message: string;
  data: T | null;
}