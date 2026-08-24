/**
 * forge-desktop 内核组装：把 forge-core 5 个 service+api 与 mock pi/model 适配器
 * 接成统一的方法表 + 事件汇，供 Electron 主进程（main.ts）IPC 路由消费。
 *
 * 纯 TS（不 import Electron），可单测/集成测；main.ts 只做 Electron 装配。
 * - 5 个 Api 共享同一 eventBus，事件统一转发到渲染进程
 * - ConversationService 的 onStatusChange/onDelta 接到 ConversationApi 事件推送
 * - MockPiConversationAdapter.onReply 驱动会话状态 streaming→done 与 assistant 消息事件
 * - providerReady 恒 true（mock 永远就绪）
 */
import { EventEmitter } from 'node:events';
import {
  ForgeStore,
  ProjectService,
  createProjectApi,
  SessionService,
  createSessionApi,
  ConversationService,
  createConversationApi,
  createToolApi,
  ModelService,
  createModelApi,
  type RpcResult,
  type ModelsFileAdapter,
  type KeychainAdapter,
} from '@forge/core';
import { MockPiSessionAdapter, MockPiConversationAdapter } from './mock/mockAdapters.ts';
import { PiModelsFileAdapter, defaultPiModelsPath } from './pi/piModelsFileAdapter.ts';
import { EnvVarKeychainAdapter } from './pi/keychainAdapter.ts';

/** 方法表：方法名 -> handler(params) -> 统一信封（同步/异步） */
export type MethodTable = Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;

/** forge-desktop 内核组装产物 */
export interface ForgeCoreBundle {
  /** 5 个 Api 的 methods 合并查找表 */
  methodTable: MethodTable;
  /** 统一事件汇：所有 Api 事件在此发射，main.ts 转发到渲染进程 */
  eventBus: EventEmitter;
}

/** 可选注入依赖（测试可传 mock；缺省走真实 pi 对接） */
export interface ForgeCoreDeps {
  modelsFile?: ModelsFileAdapter;
  keychain?: KeychainAdapter;
  /** pi models.json 路径（默认 ~/.pi/agent/models.json） */
  piModelsPath?: string;
}

/**
 * 组装 forge-core 内核 + 适配器。
 * @param storePath forge-store.json 文件路径（主进程传 userData 目录下路径）
 * @param deps 可选注入依赖（测试传 mock；缺省走真实 pi models.json + env keychain 对接）
 * @returns 方法表 + 事件汇
 */
export function createForgeCore(storePath: string, deps: ForgeCoreDeps = {}): ForgeCoreBundle {
  const store = new ForgeStore(storePath);
  const eventBus = new EventEmitter();

  // project（01）
  const projectApi = createProjectApi(new ProjectService(store), eventBus);

  // session（02）
  const sessionService = new SessionService(store, new MockPiSessionAdapter());
  const sessionApi = createSessionApi(sessionService, eventBus);

  // conversation（03）：先声明 conversationApi 以便 onStatusChange 闭包引用，
  // createConversationApi 返回后赋值（闭包执行时已初始化）
  let conversationApi: ReturnType<typeof createConversationApi>;
  const conversationAdapter = new MockPiConversationAdapter();
  const conversationService = new ConversationService(conversationAdapter, {
    sessionExists: (id) => store.getSession(id) !== undefined,
    providerReady: () => true,
    onStatusChange: (sid, status) => conversationApi.pushStatus(sid, status),
    onDelta: (sid, delta) => conversationApi.pushDelta(sid, delta.text),
  });
  conversationApi = createConversationApi(conversationService, eventBus);
  // mock 异步回复驱动状态流转与 assistant 消息事件
  conversationAdapter.onReply = (sid, msg) => {
    conversationService.setStatus(sid, 'done');
    conversationApi.emitMessage(sid, msg);
  };

  // tool（04）
  const toolApi = createToolApi(eventBus);

  // model（05）：默认走真实 pi models.json 双向同步；测试可注入 mock
  const modelApi = createModelApi(
    new ModelService({
      modelsFile: deps.modelsFile ?? new PiModelsFileAdapter(deps.piModelsPath ?? defaultPiModelsPath()),
      keychain: deps.keychain ?? new EnvVarKeychainAdapter(),
      store,
    }),
    eventBus,
  );

  const methodTable: MethodTable = {
    ...projectApi.methods,
    ...sessionApi.methods,
    ...conversationApi.methods,
    ...toolApi.methods,
    ...modelApi.methods,
  };

  return { methodTable, eventBus };
}

/**
 * 路由一次 invoke 调用：查方法表并执行；未知方法返回 404 信封。
 * @param methodTable 方法表
 * @param method 方法名（ForgeMethod）
 * @param params 请求参数
 * @returns 统一信封
 */
export async function invoke(
  methodTable: MethodTable,
  method: string,
  params?: Record<string, unknown>,
): Promise<RpcResult> {
  const handler = methodTable[method];
  if (handler === undefined) {
    return { code: 404, message: `未知方法: ${method}`, data: null };
  }
  return handler(params ?? {});
}
