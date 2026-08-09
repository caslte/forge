/**
 * forge-core 引擎层公开入口。
 *
 * 按 docs/overview.md 四层架构，forge-core 为纯 Node 引擎层。本入口对外暴露
 * forge-store 持久化、项目管理服务与传输无关的 RPC 方法层，供 forge-desktop /
 * forge-ui / 测试直接消费。不引入任何 Electron / Vue / pi 依赖。
 */

// forge-store 持久化层（wu-1-store）
export { ForgeStore, ForgeStoreError, normalizeProjectPath, CURRENT_SCHEMA_VERSION } from './store/index.ts';
export type { AddProjectResult, UpdateProjectResult, RemoveProjectResult } from './store/index.ts';

// 项目管理服务（wu-01-project-service）
export { ProjectService } from './project/projectService.ts';
export type {
  TrustDecision,
  TrustPrompt,
  ProjectResult,
  OpenProjectResult,
} from './project/projectService.ts';

// 项目管理 RPC 方法层（wu-01-rpc）
export { ProjectApi, createProjectApi } from './rpc/projectMethods.ts';
export type { RpcResult, EventSink } from './rpc/projectMethods.ts';

// 会话管理服务（wu-02-session-service）
export { SessionService } from './session/sessionService.ts';
export type {
  SessionStatus,
  SessionStatusOptions,
  PiSessionAdapter,
  SessionResult,
  SessionListItem,
} from './session/sessionService.ts';

// 会话管理 RPC 方法层（wu-02-rpc）
export { SessionApi, createSessionApi } from './rpc/sessionMethods.ts';

// 对话与消息服务（wu-03-conversation-service）
export { ConversationService } from './conversation/conversationService.ts';
export type {
  ConversationStatus,
  ConversationRole,
  ConversationMessage,
  ConversationDelta,
  PiConversationAdapter,
  StreamState,
  ConversationStatusOptions,
  ConversationServiceOptions,
  ConversationResult,
} from './conversation/conversationService.ts';

// 对话与消息 RPC 方法层（wu-03-rpc）
export { ConversationApi, createConversationApi } from './rpc/conversationMethods.ts';

// 工具事件服务（wu-04-tool-service）
export { ToolEventService } from './tool/toolService.ts';
export type {
  ToolStatus,
  ToolEventBase,
  ToolStartedEvent,
  ToolCompletedEvent,
  ToolErrorEvent,
  ToolEvent,
  ToolStatusExtra,
  ToolStatusResult,
  DiffData,
} from './tool/toolService.ts';

// 工具事件 RPC 方法层（wu-04-rpc）
export { ToolApi, createToolApi } from './rpc/toolMethods.ts';
export type { ToolDescriptor, ToolResult, ToolErrorInfo, ToolEmitResult } from './rpc/toolMethods.ts';

// 模型与 Provider 配置服务（wu-05-model-service）
export { ModelService } from './model/modelService.ts';
export type {
  ProviderConfig,
  ProviderFileRecord,
  ModelRegistry,
  SessionModelInfo,
  SaveProviderInput,
  ModelsFileAdapter,
  KeychainAdapter,
  ModelStorePort,
  ModelServiceDeps,
  ModelResult,
} from './model/modelService.ts';

// 模型与 Provider 配置 RPC 方法层（wu-05-rpc）
export { ModelApi, createModelApi } from './rpc/modelMethods.ts';

// forge-store 类型（docs/db/forge-store/schema.md）
export type {
  TrustState,
  ProjectRecord,
  SessionRecord,
  StoreKey,
  SettingsRecord,
  ForgeStoreData,
} from './types/forge-store.ts';

/** forge-core 当前版本号（骨架期固定为 0.1.0） */
export const FORGE_CORE_VERSION = '0.1.0';