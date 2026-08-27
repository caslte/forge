/**
 * forge-desktop 内核组装：把 forge-core 5 个 service+api 与 mock pi/model 适配器
 * 接成统一的方法表 + 事件汇，供 Electron 主进程（main.ts）IPC 路由消费。
 *
 * 纯 TS（不 import Electron），可单测/集成测；main.ts 只做 Electron 装配。
 * - 5 个 Api 共享同一 eventBus，事件统一转发到渲染进程
 * - ConversationService 的 onStatusChange/onDelta 接到 ConversationApi 事件推送
 * - PiConversationAdapter 事件经 setEventHandlers 驱动 streaming→done/error 与消息推送
 * - providerReady 恒 true（凭据校验由 pi 运行时反馈）
 */
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
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
  type TrustStorePort,
  type PiSessionAdapter as ForgePiSessionAdapter,
} from '@forge/core';
import {
  PiConversationAdapter,
  type MinimalPiSession,
  type PiAgentSessionFactory,
} from './pi/piConversationAdapter.ts';
import { PiSessionAdapter } from './pi/piSessionAdapter.ts';
import { createPiAgentSessionFactory } from './pi/createPiAgentSessionFactory.ts';
import { PiModelsFileAdapter, defaultPiModelsPath } from './pi/piModelsFileAdapter.ts';
import { EnvVarKeychainAdapter } from './pi/keychainAdapter.ts';
import { PiTrustStoreAdapter } from './pi/piTrustStoreAdapter.ts';

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
  /** 项目信任权威端口（P2-A）；缺省接真实 pi trust store（agentDir 下 trust.json） */
  trustStore?: TrustStorePort;
  /** pi models.json 路径（默认 ~/.pi/agent/models.json） */
  piModelsPath?: string;
  /** pi agent 目录（默认 ~/.pi/agent）；测试指向空目录可隔离真实凭据 */
  piAgentDir?: string;
  /** 可注入 pi 会话工厂；缺省时使用真实 pi 会话工厂 */
  piAgentSessionFactory?: PiAgentSessionFactory<MinimalPiSession>;
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

  // project（01）：信任权威交给 pi（P2-A），forge store 只缓存展示状态
  const projectApi = createProjectApi(
    new ProjectService(
      store,
      deps.trustStore ??
        new PiTrustStoreAdapter(
          deps.piAgentDir ??
            path.join(
              process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(),
              '.pi',
              'agent',
            ),
        ),
    ),
    eventBus,
  );

  // conversation adapter 先行声明（sessionService 删除钩子闭包引用；实际初始化在下方）
  let conversationAdapter: PiConversationAdapter;

  // session（02）：删除会话时先释放对话侧运行资源（P2-D lease dispose + stop）
  const piSessionAdapter = new PiSessionAdapter();
  const sessionService = new SessionService(
    store,
    {
      createSession: (projectPath: string) => piSessionAdapter.createSession(projectPath),
      stopSession: (sessionId: string) => piSessionAdapter.stopSession(sessionId),
      deleteSession: async (sessionId: string) => {
        await conversationAdapter.removeSession(sessionId);
        await piSessionAdapter.deleteSession(sessionId);
      },
    },
  );
  const sessionApi = createSessionApi(sessionService, eventBus);

  // conversation（03）：先声明 conversationApi 以便 onStatusChange 闭包引用，
  // createConversationApi 返回后赋值（闭包执行时已初始化）
  let conversationApi: ReturnType<typeof createConversationApi>;
  const piAgentSessionFactory =
    deps.piAgentSessionFactory ?? createPiAgentSessionFactory({ agentDir: deps.piAgentDir });
  // P2-D 重启恢复：由 forge sessionId 推导 pi 会话文件（agentDir/sessions/<cwd>/forge-<id>.jsonl）
  const agentDir =
    deps.piAgentDir ??
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.pi', 'agent');
  const resolveSessionFile = (sessionId: string): string | undefined => {
    const session = store.getSession(sessionId);
    if (session === undefined) return undefined;
    const dir = path.join(agentDir, 'sessions', encodeURIComponent(session.projectPath));
    const file = path.join(dir, `forge-${sessionId}.jsonl`);
    try {
      return fs.existsSync(file) ? file : undefined;
    } catch {
      return undefined;
    }
  };
  conversationAdapter = new PiConversationAdapter(piAgentSessionFactory, { resolveSessionFile });
  // model（05）共享实例：提供真实 provider 就绪检查（models 非空）与会话模型解析
  const modelService = new ModelService({
    modelsFile: deps.modelsFile ?? new PiModelsFileAdapter(deps.piModelsPath ?? defaultPiModelsPath()),
    keychain: deps.keychain ?? new EnvVarKeychainAdapter(),
    store,
    // P3-D：配置变更审计日志（追加写 store 同目录，载荷仅动作标识 + providerId，无密钥）
    audit: (event) => {
      try {
        fs.appendFileSync(
          path.join(path.dirname(storePath), 'forge-audit.log'),
          `${event.ts} [${event.action}] provider=${event.providerId}\n`,
          'utf8',
        );
      } catch {
        // 审计日志写入失败不影响主流程
      }
    },
    // provider 增删改后刷新模型运行时（清缓存 + 活跃会话重读 models.json），
    // 使新保存的 API Key 立即生效，无需重启应用
    onConfigChanged: () => conversationAdapter.refreshModelConfig(),
  });
  const conversationService = new ConversationService(conversationAdapter, {
    sessionExists: (id: string) => store.getSession(id) !== undefined,
    // 会话别名缺失判断：未设置 alias 视为第一条消息尚未自动命名
    sessionAliasMissing: (id: string) => {
      const s = store.getSession(id);
      return s !== undefined && (s.alias === null || s.alias.trim() === '');
    },
    // P2-D：provider 未配置（models 为空）时禁止发送并返回 1004，前端引导设置页
    providerReady: async () => {
      try {
        const models = await modelService.queryModels();
        return models.ok && models.data.models.length > 0;
      } catch {
        return false;
      }
    },
    resolveSendOptions: async (sessionId) => {
      const session = store.getSession(sessionId);
      const modelResult = await modelService.getSessionModel(sessionId);
      return {
        sessionId,
        cwd: session?.projectPath,
        model: modelResult.ok ? modelResult.data.model ?? undefined : undefined,
      };
    },
    onStatusChange: (sid, status) => conversationApi.pushStatus(sid, status),
    onDelta: (sid, delta) => conversationApi.pushDelta(sid, delta.text),
    // 首条用户消息：从问题内容生成标题并写入会话 alias
    onFirstUserMessage: (sid: string, content: string) => {
      const alias = generateSessionTitle(content);
      if (!alias) return;
      const result = sessionService.updateSessionAlias(sid, alias);
      if (result.ok) {
        eventBus.emit('session.updated', { session: result.data.session });
      }
    },
  });
  conversationApi = createConversationApi(conversationService, eventBus);

  // tool（04）：真实 pi 工具事件经适配器回调喂入 ToolApi（状态机 + 事件汇）
  const toolApi = createToolApi(eventBus);

  // 真实 pi 事件接线：增量推送、assistant 消息 + done、错误状态 + error 事件
  conversationAdapter.setEventHandlers({
    onDelta: (sessionId, text) => conversationApi.pushDelta(sessionId, text),
    onMessage: (sessionId, message) => {
      conversationApi.emitMessage(sessionId, message);
    },
    onError: (sessionId) => {
      conversationService.setStatus(sessionId, 'error');
      conversationApi.emitError(sessionId, 5000, '对话处理失败');
    },
    onToolStarted: (sessionId, event) => {
      toolApi.emitToolStarted(sessionId, event.toolEventId, event.tool);
    },
    onToolCompleted: (sessionId, event) => {
      toolApi.emitToolCompleted(sessionId, event.toolEventId, event.result);
    },
    onToolError: (sessionId, event) => {
      toolApi.emitToolError(sessionId, event.toolEventId, event.error);
    },
  });

  conversationAdapter.setCompletionHandler((sessionId) => {
    conversationService.setStatus(sessionId, 'done');
  });

  // model（05）：复用共享 ModelService（真实 pi models.json 双向同步；测试可注入 mock）
  const modelApi = createModelApi(modelService, eventBus);

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
 * 从首条用户消息生成会话标题。
 * 规则：去除换行与首尾空白，按句号/问号/感叹号/分号截断第一句，
 * 超过 30 字符截断并加省略号，全空则回退为「新会话」。
 */
export function generateSessionTitle(rawContent: string): string {
  const cleaned = rawContent.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '新会话';
  const firstSentenceMatch = cleaned.match(/^(.+?)[。！？!?.;；]/);
  const firstSentence = firstSentenceMatch && firstSentenceMatch[1] !== undefined
    ? firstSentenceMatch[1].trim()
    : cleaned;
  if (firstSentence.length === 0) return cleaned.length > 30 ? cleaned.slice(0, 30) + '…' : cleaned;
  return firstSentence.length > 30 ? firstSentence.slice(0, 30) + '…' : firstSentence;
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
