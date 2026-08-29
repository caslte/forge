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
  SubagentService,
  SUBAGENT_DONE_TIMEOUT_MS,
  type RpcResult,
  type ModelsFileAdapter,
  type KeychainAdapter,
  type TrustStorePort,
  type PiSessionAdapter as ForgePiSessionAdapter,
  type SubagentStopPort,
} from '@forge/core';
import {
  PiConversationAdapter,
  type MinimalPiSession,
  type PiAgentSessionFactory,
} from './pi/piConversationAdapter.ts';
import { PiSessionAdapter } from './pi/piSessionAdapter.ts';
import { createPiAgentSessionFactory } from './pi/createPiAgentSessionFactory.ts';
import { PiModelsFileAdapter, defaultPiModelsPath } from './pi/piModelsFileAdapter.ts';
import { getPiSupportedThinkingLevels, resolvePiModel } from './pi/piModelResolver.ts';
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
  /** wu-06：done 门控超时窗口（默认 30 分钟）。测试用小窗口验证兜底释放。 */
  subagentDoneTimeoutMs?: number;
  /**
   * wu-06：主轮看门狗窗口（默认 30 分钟）。主轮结束信号整体丢失（适配器 prompt
   * 永不返回）且窗口内无任何会话事件活动时，强制放行 done。测试用小窗口验证。
   */
  subagentMainTurnTimeoutMs?: number;
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
  // wu-06：声明 subagentService 以便 sessionService.deleteSession 闭包能提前引用，
  // // subagentService 实际初始化在 adapter 创建后（依赖 conversationAdapter stopSubagent）。
  let subagentServiceRef: SubagentService | undefined;

  // session（02）：删除会话时先释放对话侧运行资源（P2-D lease dispose + stop）
  const piSessionAdapter = new PiSessionAdapter();
  const sessionService = new SessionService(
    store,
    {
      createSession: (projectPath: string) => piSessionAdapter.createSession(projectPath),
      stopSession: (sessionId: string) => piSessionAdapter.stopSession(sessionId),
      deleteSession: async (sessionId: string) => {
        // wu-06：先清理子 agent 会话内存态与门控（时间坌需在 adapter removeSession 前清理，
        // // 避免迟到事件订阅退订前该 gate 被释放仍创建新状态）
        disarmMainTurnWatchdog(sessionId); // 会话删除同步撤防主轮看门狗
        subagentServiceRef?.disposeSession(sessionId);
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
  // 实时读取全局默认思考级别（MP-QA-G01 修复）：不保存启动快照，每次发送前
  // 经 store.getSetting('thinkingLevel') 实时读取，避免运行中 setSessionThinkingLevel
  // 同步全局后新会话仍用初始快照。setting 缺失（旧数据）时兜底 'off'（schema.md 兼容）。
  const readDefaultThinkingLevel = (): string => {
    const stored = store.getSetting('thinkingLevel');
    return typeof stored === 'string' && stored !== '' ? stored : 'off';
  };
  // wu-06：子 agent 管理服务 + 事件汇转发。sink 把 subagent.updated / subagent.removed
  // 接到 eventBus，把 conversation.statusChanged {status:'done'} 转到 conversationService
  // （经过 onStatusChange 回调→conversationApi.pushStatus→eventBus 链）。done 门控入口
  // （notifyMainTurnEnd）在 setCompletionHandler 调用；活跃计数>0 时延迟，超时兜底。
  let subagentService: SubagentService;
  const buildSubagentStopPort = (): SubagentStopPort => ({
    async stop(sessionId: string, agentId: string): Promise<void> {
      // 经适配器委托 lease 句柄的 cross-extension-rpc stop 通道（扩展缺失时抛错）
      await conversationAdapter.stopSubagent(sessionId, agentId);
    },
  });
  subagentService = new SubagentService({
    sink: {
      emit: (sessionId, event, payload): boolean => {
        if (event === 'conversation.statusChanged') {
          const status = (payload as { status?: string }).status;
          if (status === 'done') {
            // 门控收敛：仅转 'done'；其它状态（error/canceled 等）走原 cancelStream/错误路径
            conversationService.setStatus(sessionId, 'done');
          }
          return true;
        }
        if (event === 'subagent.updated') {
          eventBus.emit('subagent.updated', { sessionId, subagent: payload });
          pokeMainTurnActivity(sessionId); // 子 agent 事件也是会话活动，刷新看门狗
          return true;
        }
        if (event === 'subagent.removed') {
          eventBus.emit('subagent.removed', { sessionId, agentIds: (payload as { agentIds: string[] }).agentIds });
          pokeMainTurnActivity(sessionId);
          return true;
        }
        return false;
      },
    },
    timeoutMs: deps.subagentDoneTimeoutMs,
  });
  subagentServiceRef = subagentService;

  // wu-06 兜底②：主轮看门狗。done 门控以「适配器 prompt 返回」为主轮结束信号，
  // pi 侧 run 生命周期异常（扩展 followUp/triggerTurn 异步续跑竞态）可能使 prompt
  // 永不 resolve，信号整体丢失且 done 门控的子 agent 兜底（依赖 notifyMainTurnEnd
  // 先到达）不会启动。看门狗在 sendMessage 期间布防：窗口内无任何会话事件活动
  // （delta/消息/工具/子 agent）且会话仍处 streaming 时，经 forceDone 强制放行
  // done（PRD 1.3：信号丢失不得永久卡「运行中」）。
  const mainTurnWatchdogMs = deps.subagentMainTurnTimeoutMs ?? SUBAGENT_DONE_TIMEOUT_MS;
  const mainTurnLastActivity = new Map<string, number>();
  const mainTurnWatchdogs = new Map<string, ReturnType<typeof setInterval>>();
  const pokeMainTurnActivity = (sessionId: string): void => {
    mainTurnLastActivity.set(sessionId, Date.now());
  };
  const disarmMainTurnWatchdog = (sessionId: string): void => {
    const timer = mainTurnWatchdogs.get(sessionId);
    if (timer !== undefined) {
      clearInterval(timer);
      mainTurnWatchdogs.delete(sessionId);
    }
    mainTurnLastActivity.delete(sessionId);
  };
  const armMainTurnWatchdog = (sessionId: string): void => {
    disarmMainTurnWatchdog(sessionId);
    pokeMainTurnActivity(sessionId);
    // 轮询间隔 = min(30s, 窗口/4)：生产 30 分钟窗口 30s 一查；测试小窗口快速触发
    const tickMs = Math.min(30_000, Math.max(20, Math.floor(mainTurnWatchdogMs / 4)));
    const timer = setInterval(() => {
      const last = mainTurnLastActivity.get(sessionId);
      if (last === undefined || Date.now() - last < mainTurnWatchdogMs) return;
      disarmMainTurnWatchdog(sessionId);
      if (conversationService.getStatus(sessionId) !== 'streaming') {
        return; // 状态已收敛（done/canceled/error），无需兜底
      }
      console.warn(
        `[createForgeCore] main turn watchdog fired (session=${sessionId}, timeoutMs=${mainTurnWatchdogMs})`,
      );
      subagentService.forceDone(sessionId); // sink → conversationService.setStatus('done')
    }, tickMs);
    mainTurnWatchdogs.set(sessionId, timer);
  };

  conversationAdapter = new PiConversationAdapter(piAgentSessionFactory, {
    resolveSessionFile,
    resolveDefaultThinkingLevel: readDefaultThinkingLevel,
    subagentService,
    onMainTurnEnd: (sessionId: string) => subagentService.notifyMainTurnEnd(sessionId),
  });
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
    // MP-S05：思考级别能力来源 = pi SDK getSupportedThinkingLevels（TD-MP-04，不复制
    // 过滤规则）。模型解析失败时内部返回 null -> 服务层映射为 1004「模型未配置」。
    thinkLevels: {
      getSupportedThinkingLevels: (model: string) =>
        getPiSupportedThinkingLevels(model, deps.piModelsPath),
    },
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
      // MP-S05：会话生效思考级别 = session.thinkingLevel ?? 实时全局默认
      // （readDefaultThinkingLevel 每次读取 settings.thinkingLevel，含旧数据缺失时
      // 兜底 off），随 options 流入 pi 会话运行时。MP-QA-G01：不缓存启动快照。
      const sessionLevel = session?.thinkingLevel;
      const thinkingLevel =
        typeof sessionLevel === 'string' && sessionLevel !== '' ? sessionLevel : readDefaultThinkingLevel();
      return {
        sessionId,
        cwd: session?.projectPath,
        model: modelResult.ok ? modelResult.data.model ?? undefined : undefined,
        thinkingLevel,
      };
    },
    onStatusChange: (sid, status) => {
      conversationApi.pushStatus(sid, status);
      // 会话树状态圆点数据源：conversation 状态流转同步到 session 运行时表
      //（streaming→running，canceled/done→done），sessionApi 内部发射
      // session.statusChanged 触发 UI 会话树实时刷新
      const sessionStatus =
        status === 'streaming' ? 'running' : status === 'error' ? 'error' : status === 'idle' ? 'idle' : 'done';
      sessionApi.setSessionStatus(sid, sessionStatus);
    },
    onDelta: (sid, delta) => conversationApi.pushDelta(sid, delta.text),
    // 多模态门控：模型 input 能力含 "image" 才允许透传图片附件；解析失败按不支持
    // 降级（跳过图片仅发送文字），避免 pi 占位文本或对方 API 报错的不友好体验
    modelSupportsImages: async (model: string) => {
      try {
        const piModel = await resolvePiModel(model, deps.piModelsPath);
        return Array.isArray(piModel.input) && (piModel.input as string[]).includes('image');
      } catch {
        return false;
      }
    },
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
    onDelta: (sessionId, text) => {
      pokeMainTurnActivity(sessionId); // 流式增量刷新主轮看门狗
      conversationApi.pushDelta(sessionId, text);
    },
    onMessage: (sessionId, message) => {
      pokeMainTurnActivity(sessionId);
      conversationApi.emitMessage(sessionId, message);
    },
    onError: (sessionId, error) => {
      pokeMainTurnActivity(sessionId);
      conversationService.setStatus(sessionId, 'error');
      conversationApi.emitError(sessionId, 5000, error?.message ?? '对话处理失败');
    },
    onToolStarted: (sessionId, event) => {
      pokeMainTurnActivity(sessionId);
      toolApi.emitToolStarted(sessionId, event.toolEventId, event.tool);
    },
    onToolCompleted: (sessionId, event) => {
      pokeMainTurnActivity(sessionId);
      toolApi.emitToolCompleted(sessionId, event.toolEventId, event.result);
    },
    onToolError: (sessionId, event) => {
      pokeMainTurnActivity(sessionId);
      toolApi.emitToolError(sessionId, event.toolEventId, event.error);
    },
  });

  // setCompletionHandler 不再调用：done 由 subagentService.notifyMainTurnEnd 门控
  // （适配器构造已注入 onMainTurnEnd，见上面）。适配器仅在无 onMainTurnEnd 时
  // 退回到原 completionHandler 路径（保持旧路径兼容）。

  // model（05）：复用共享 ModelService（真实 pi models.json 双向同步；测试可注入 mock）
  const modelApi = createModelApi(modelService, eventBus);

  // wu-06：subagent/queryList | subagent/stop | subagent/clearFinished RPC 方法映射
  // 三个方法都委托 SubagentService，返回信封与错误码（1001/1002/5000）严格按 service 输出。
  // 取消 sendMessage 末尾的重复 pushStatus：onStatusChange 回调已处理状态推送（原 completionHandler
  // 调 setStatus('done') -> onStatusChange -> pushStatus），conversation/sendMessage RPC 末尾再调
  // pushStatus(getStatus()) 会重复发射 'done'（wu-06 done 门控语义下恰好一次）。以 per-session
  // 去重包装保证恰好一次，同会话重复发同一状态不需再次向渲染进程推送。
  const lastPushedStatus = new Map<string, string>();
  const originalPushStatus = conversationApi.pushStatus.bind(conversationApi);
  conversationApi.pushStatus = (sessionId: string, status: string): void => {
    if (lastPushedStatus.get(sessionId) === status) return;
    lastPushedStatus.set(sessionId, status);
    originalPushStatus(sessionId, status as Parameters<typeof originalPushStatus>[1]);
  };

  const subagentMethods: MethodTable = {
    'subagent/queryList': async (params: unknown) => {
      const sessionId = readStringParam(params, 'sessionId');
      if (sessionId === null) {
        return failEnvelope(1001, '参数错误：sessionId 必须为非空字符串');
      }
      const result = subagentService.queryList(sessionId);
      return result.ok
        ? { code: 0, message: 'success', data: { subagents: result.data } }
        : failEnvelope(result.code, result.message);
    },
    'subagent/stop': async (params: unknown) => {
      const sessionId = readStringParam(params, 'sessionId');
      const agentId = readStringParam(params, 'agentId');
      if (sessionId === null || agentId === null) {
        return failEnvelope(1001, '参数错误：sessionId/agentId 必须为非空字符串');
      }
      try {
        const result = await subagentService.stop(sessionId, agentId, buildSubagentStopPort());
        return result.ok
          ? { code: 0, message: 'success', data: null }
          : failEnvelope(result.code, result.message);
      } catch (err) {
        // 适配层错误（扩展缺失 / RPC 异常未被 service 重试覆盖时）映射为 5000
        const message = err instanceof Error ? err.message : String(err);
        return failEnvelope(5000, `终止失败: ${message}`);
      }
    },
    'subagent/clearFinished': async (params: unknown) => {
      const sessionId = readStringParam(params, 'sessionId');
      if (sessionId === null) {
        return failEnvelope(1001, '参数错误：sessionId 必须为非空字符串');
      }
      const result = subagentService.clearFinished(sessionId);
      return result.ok
        ? { code: 0, message: 'success', data: { removed: result.data } }
        : failEnvelope(result.code, result.message);
    },
  };

  // wu-06：conversation/sendMessage 看门狗布防——发送期间监视主轮结束信号；
  // prompt 返回（完成/中止/抛错）即信号已到，finally 撤防。prompt 永不返回时
  // 由 interval 检测无活动窗口后强制放行（见 armMainTurnWatchdog）。
  const originalSendMessage = conversationApi.methods['conversation/sendMessage'];
  const wrappedSendMessage: MethodTable['conversation/sendMessage'] = async (params: unknown) => {
    const sessionId = readStringParam(params, 'sessionId');
    if (sessionId !== null) armMainTurnWatchdog(sessionId);
    try {
      return await originalSendMessage!(params);
    } finally {
      if (sessionId !== null) disarmMainTurnWatchdog(sessionId);
    }
  };

  // wu-06：conversation/cancelStream 级联终止编排——原 cancel 后立刻 cascade stopAllActive。
  // 顺序：原 cancel（status=canceled + abort）→ notifyMainTurnEnd（设门）→ stopAllActive
  // （逐个调 stop RPC、ingest('stopped')）。最后一个 stop 使 activeCount=0 → sink 发 done。
  const originalCancelStream = conversationApi.methods['conversation/cancelStream'];
  const wrappedCancelStream: MethodTable['conversation/cancelStream'] = async (params: unknown) => {
    const sessionId = readStringParam(params, 'sessionId');
    if (sessionId !== null) disarmMainTurnWatchdog(sessionId); // 用户主动停止，撤防看门狗
    const baseResult = await originalCancelStream!(params);
    if (baseResult.code === 0 && sessionId !== null) {
      // 门控入口：set up gate（计数=0 立即 done；>0 启动超时兑底）
      subagentService.notifyMainTurnEnd(sessionId);
      // 级联终止活跃子 agent（逐个 stop + ingest('stopped')，最后使 activeCount=0 → sink 发 done）
      try {
        await subagentService.stopAllActive(sessionId, buildSubagentStopPort());
      } catch (err) {
        // 级联失败仅记日志，不影响 cancel 本身的成功响应（前端可重试）
        console.warn('[createForgeCore] cascade stopAllActive failed', err);
      }
    }
    return baseResult;
  };

  const methodTable: MethodTable = {
    ...projectApi.methods,
    ...sessionApi.methods,
    ...conversationApi.methods,
    ...toolApi.methods,
    ...modelApi.methods,
    ...subagentMethods,
    // 重写 cancelStream 为级联终止版本；sendMessage 加主轮看门狗布防
    'conversation/cancelStream': wrappedCancelStream,
    'conversation/sendMessage': wrappedSendMessage,
  };

  return { methodTable, eventBus };
}

/** 构造错误信封（wu-06 helper；与 conversationApi.fail 同样形态） */
function failEnvelope(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/** 从 params 读非空字符串；缺失/非字符串返回 null（与 conversationApi.requireString 语义一致） */
function readStringParam(params: unknown, key: string): string | null {
  if (typeof params !== 'object' || params === null) return null;
  const value = (params as Record<string, unknown>)[key];
  if (typeof value !== 'string' || value.trim() === '') return null;
  return value;
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
