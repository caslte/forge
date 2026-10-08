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
  normalizeProjectPath,
  ProjectService,
  createProjectApi,
  createGitApi,
  GitService,
  SessionService,
  createSessionApi,
  ConversationService,
  createConversationApi,
  classifyError,
  createToolApi,
  ModelService,
  createModelApi,
  SubagentService,
  SUBAGENT_DONE_TIMEOUT_MS,
  createFileApi,
  type RpcResult,
  type ModelsFileAdapter,
  type KeychainAdapter,
  type TrustStorePort,
  type ProjectSessionsPort,
  type PiSessionAdapter as ForgePiSessionAdapter,
  type SubagentStopPort,
  type SlashCommand,
} from '@forge/core';
import {
  PiConversationAdapter,
  type MinimalPiSession,
  type PiAgentSessionFactory,
} from './pi/piConversationAdapter.ts';
import { PiSessionAdapter } from './pi/piSessionAdapter.ts';
import {
  ensureFreeWorkspaceDir,
  resolvePiAgentDir,
  resolveSessionCwd,
  tryResolveForgeSessionFile,
} from './pi/piSessionPaths.ts';
import { createPiAgentSessionFactory } from './pi/createPiAgentSessionFactory.ts';
import { createSlashCommandResources } from './pi/slashCommandResources.ts';
import { PiModelsFileAdapter } from './pi/piModelsFileAdapter.ts';
import {
  SUBAGENT_OUTPUT_TAIL_BYTES,
  readTail,
  resolveSubagentOutputFile,
} from './pi/subagentOutput.ts';
import { getPiSupportedThinkingLevels, probePiModel, resolvePiModel } from './pi/piModelResolver.ts';
import { EnvVarKeychainAdapter } from './pi/keychainAdapter.ts';
import { PiTrustStoreAdapter } from './pi/piTrustStoreAdapter.ts';
import {
  updatePiExtensions,
  type PiUpdateResult,
} from './pi/piRuntime.ts';
import {
  createAppUpdaterPort,
  createUpdaterMethods,
  type AppUpdaterPort,
} from './pi/appUpdater.ts';
import { createReleaseNotesMethods } from './pi/releaseNotes.ts';
import { createSkillMethods, type SkillLoaderLike } from './pi/skillService.ts';
import { createCommitMessageMethods } from './git/commitMessageService.ts';
import { createModelTestMethods } from './model/modelTestService.ts';
import { createTermService } from './term/ptyService.ts';
import { recordManualComponentUpdate, touchLastUpdateCheckAt } from './pi/startupUpdate.ts';

/** 方法表：方法名 -> handler(params) -> 统一信封（同步/异步） */
export type MethodTable = Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;

/** forge-desktop 内核组装产物 */
export interface ForgeCoreBundle {
  /** 5 个 Api 的 methods 合并查找表 */
  methodTable: MethodTable;
  /** 统一事件汇：所有 Api 事件在此发射，main.ts 转发到渲染进程 */
  eventBus: EventEmitter;
  /** 模块 10：全量回收存活 pty（main.ts 在 before-quit 与渲染文档重载时调用） */
  killAllPtys: () => void;
}

/** 可选注入依赖（测试可传 mock；缺省走真实 pi 对接） */
export interface ForgeCoreDeps {
  modelsFile?: ModelsFileAdapter;
  keychain?: KeychainAdapter;
  /** 项目信任权威端口（P2-A）；缺省接真实 pi trust store（agentDir 下 trust.json） */
  trustStore?: TrustStorePort;
  /** pi models.json 路径（缺省派生自 piAgentDir：<agentDir>/models.json） */
  piModelsPath?: string;
  /** pi agent 目录（生产由 main.ts 注入 <userData>/agent；缺省回退 ~/.pi/agent，
   * 测试指向空目录可隔离真实凭据） */
  piAgentDir?: string;
  /** 可注入 pi 会话工厂；缺省时使用真实 pi 会话工厂 */
  piAgentSessionFactory?: PiAgentSessionFactory<MinimalPiSession>;
  /** wu-06：done 门控超时窗口（默认 30 分钟）。测试用小窗口验证兜底释放。 */
  subagentDoneTimeoutMs?: number;
  /** wu-06：主轮看门狗窗口（默认 30 分钟）。主轮结束信号整体丢失（适配器 prompt
   * 永不返回）且窗口内无任何会话事件活动时，强制放行 done。测试用小窗口验证。
   */
  subagentMainTurnTimeoutMs?: number;
  /** forge 产品版本（设置页「版本更新」展示）；main.ts 传 app.getVersion()，缺省 0.0.0-dev */
  forgeVersion?: string;
  /** 更新共享扩展的可注入端口（测试 mock）；缺省跑内置引擎 CLI 的 pi update --extensions */
  piUpdateExtensions?: () => Promise<PiUpdateResult>;
  /** wu-07 IN-S03：应用自更新端口（main.ts 组装真实 electron-updater 注入）；
   * 缺省 feed=null 的降级端口（updater/* 检查一律 6003，不触碰网络） */
  appUpdater?: AppUpdaterPort;
  /** QA-G1/G4：updater-state.json 路径（userData 目录下，main.ts 注入）。缺省 null=
   * 手动更新成功后跳过 components 快照持久化、lastUpdateCheckAt 不回写，仅输出结构化日志
   * （既有单测未注入该路径，行为保持兼容） */
  updaterStatePath?: string;
  /** 版本更新说明：安装包内 release-notes.md 路径（main.ts 按打包/dev 注入）。缺省 null=
   * 说明不可用（updater/getReleaseNotes markdown=null，关于页入口隐藏） */
  releaseNotesPath?: string | null;
  /** 版本更新说明：本次启动是否「升级启动」（main.ts whenReady 同步采集 lastRunForgeVersion
   * 快照——startupUpdate 联动阶段会异步回写，RPC 时刻再读有竞态）。缺省 false=不自动弹 */
  isUpgradeRun?: boolean;
  /** 更新调试开关（main.ts 读 userData/updater-debug.json，enabled=true 时前端显示调试控制台）。
   * 缺省 false=普通用户不可见 */
  getUpdateDebugEnabled?: () => boolean;
  /** 模块 09（skill 管理）：移入系统回收站端口（main.ts 注入 Electron shell.trashItem，
   * 纯 TS 内核不 import Electron）。缺省/失败时删除与覆盖导入回退永久删除（TD-SK-04） */
  trashItem?: (targetPath: string) => Promise<void>;
  /** 模块 09：测试接缝——替换 skill 枚举用的 pi DefaultResourceLoader 装配 */
  skillLoaderFactory?: (cwd: string, agentDir: string) => SkillLoaderLike;
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

  // project（01）：信任权威交给 pi（P2-A），forge store 只缓存展示状态；
  // 级联删会话端口晚绑定引用 sessionService（v3.32：移除项目连同名下会话一并删除）
  let sessionServiceRef: SessionService | undefined;
  const projectSessionsPort: ProjectSessionsPort = {
    deleteSession: async (sessionId) => {
      const result = await sessionServiceRef!.deleteSession(sessionId);
      if (!result.ok) {
        throw new Error(result.message);
      }
    },
  };
  // agentDir 单点解析（生产 = <userData>/agent，main.ts 注入）：trust store、会话转录、
  // models.json、skill 写入根全部从这一根派生，杜绝多处各自缺省造成读写裂脑。
  const agentDir = resolvePiAgentDir(deps.piAgentDir);
  const piModelsPath = deps.piModelsPath ?? path.join(agentDir, 'models.json');
  const projectService = new ProjectService(
    store,
    deps.trustStore ?? new PiTrustStoreAdapter(agentDir),
    projectSessionsPort,
  );
  const projectApi = createProjectApi(projectService, eventBus);

  // git（wu-02）：与 project 共享同一事件汇，switchBranch 分支变化经 eventBus 转发渲染进程
  // gitService 提升为共享实例：gitApi（查询/切换）与 generateCommitMessage（diff 收集）复用
  const gitService = new GitService();
  const gitApi = createGitApi({ gitService, projectService, events: eventBus });

  // conversation adapter 先行声明（sessionService 删除钩子闭包引用；实际初始化在下方）
  let conversationAdapter: PiConversationAdapter;
  // wu-06：声明 subagentService 以便 sessionService.deleteSession 闭包能提前引用，
  // // subagentService 实际初始化在 adapter 创建后（依赖 conversationAdapter stopSubagent）。
  let subagentServiceRef: SubagentService | undefined;

  // session（02）：删除会话时先释放对话侧运行资源（P2-D lease dispose + stop）。
  // 会话删除按同一 agentDir 推导 pi 转录文件路径
  //（与 createPiAgentSessionFactory 的建文件路径必须逐字节一致，否则删不掉）。
  const piSessionAdapter = new PiSessionAdapter({ agentDir });
  const sessionService = new SessionService(
    store,
    {
      createSession: (projectPath: string | null) => piSessionAdapter.createSession(projectPath),
      stopSession: (sessionId: string) => piSessionAdapter.stopSession(sessionId),
      deleteSession: async (sessionId: string, projectPath: string | null) => {
        // wu-06：先清理子 agent 会话内存态与门控（时间坌需在 adapter removeSession 前清理，
        // // 避免迟到事件订阅退订前该 gate 被释放仍创建新状态）
        disarmMainTurnWatchdog(sessionId); // 会话删除同步撤防主轮看门狗
        subagentServiceRef?.disposeSession(sessionId);
        await conversationAdapter.removeSession(sessionId);
        // 真删磁盘残留（pi 转录 JSONL + 子 agent 输出目录）。projectPath 由服务层
        // 从 store 记录取出后透传（null = 自由会话，adapter 映射 free-workspace）——
        // 仅凭 sessionId 推不出路径。
        // 此处抛错会让 SessionService 保留会话记录（不吞异常），故"删除成功"即磁盘已清。
        await piSessionAdapter.deleteSession(sessionId, projectPath);
      },
    },
  );
  sessionServiceRef = sessionService;
  const sessionApi = createSessionApi(sessionService, eventBus);

  // conversation（03）：先声明 conversationApi 以便 onStatusChange 闭包引用，
  // createConversationApi 返回后赋值（闭包执行时已初始化）
  let conversationApi: ReturnType<typeof createConversationApi>;
  // 自动重试恢复标记：adapter onAutoRetryStart 置位，onStatusChange('streaming') 消费。
  // 区分「重试恢复的 streaming」（主轮仍在进行，不得重置 done 门控）与「新发送的
  // streaming」（照常 notifyMainTurnStart）。非 streaming 状态统一清理防标记泄漏到下一轮。
  const retryRestorePending = new Set<string>();
  const piAgentSessionFactory =
    deps.piAgentSessionFactory ??
    createPiAgentSessionFactory({
      agentDir,
      modelsPath: piModelsPath,
      // CV-TRUST-01：执行链信任门——pi 持久决策 ∨ trustOnce 会话内放行，
      // 由 ProjectService.isTrustedForExecution 统一口径（会话创建与预热共用）
      projectTrustedFor: (cwd) => projectService.isTrustedForExecution(cwd),
    });
  // P2-D 重启恢复：由 forge sessionId 推导 pi 会话文件
  // （agentDir/sessions/<encodeURIComponent(cwd)>/forge-<id>.jsonl，见 piSessionPaths）
  // 多候选解析：自由会话（projectPath=null）只有 free-workspace 一个候选；
  // 项目会话先按当前归属找，找不到回落 free-workspace —— 覆盖「自由会话移入项目后
  // 继续对话」：转录文件留在创建时的目录，归属变更只改元数据不迁移文件。
  const resolveSessionFile = (sessionId: string): string | undefined => {
    const session = store.getSession(sessionId);
    if (session === undefined) return undefined;
    const cwds =
      session.projectPath === null
        ? [resolveSessionCwd(null, agentDir)]
        : [session.projectPath, resolveSessionCwd(null, agentDir)];
    for (const cwd of cwds) {
      const file = tryResolveForgeSessionFile(sessionId, cwd, agentDir);
      if (file === null) continue; // 历史脏数据：ID 推不出路径，视为无磁盘历史
      try {
        if (fs.existsSync(file)) return file;
      } catch {
        return undefined;
      }
    }
    return undefined;
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
  // （notifyMainTurnEnd）由适配器在 prompt 返回时经 onMainTurnEnd 调用；活跃计数>0 时
  // 延迟，超时兜底。每轮开始（状态转 streaming）由 onStatusChange 调
  // notifyMainTurnStart 重置门控（每轮恰好一次，见下方 onStatusChange）。
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
  // （delta/消息/工具/子 agent）且会话仍处 streaming 时，经 conversationService.cancelStream
  // 真正 abort pi 侧 run 并置 canceled（PRD 1.3：信号丢失不得永久卡「运行中」）。
  // 判死必须即真中断：此前经 forceDone 只把 forge 状态打成 done（假结束），pi run
  // 仍挂着，下一次发送会被 pi 以 "Agent is already processing" 拒绝且无法自愈。
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
      void conversationService.cancelStream(sessionId); // 真中断：abort pi run + 状态置 canceled
    }, tickMs);
    mainTurnWatchdogs.set(sessionId, timer);
  };

  conversationAdapter = new PiConversationAdapter(piAgentSessionFactory, {
    // 模型解析与 session factory 的 modelsPath 同源（userData/agent/models.json）：
    // 热切换 applyModelChange 与重启后磁盘用量估算都经此解析，不注入则回退
    // defaultPiModelsPath（~/.pi/agent/models.json，终端 pi CLI 的配置），
    // 导致仅在 Forge 内配置的模型报「模型未配置或不可用」（回归：热切换）
    resolveModel: (model) => resolvePiModel(model, piModelsPath),
    resolveSessionFile,
    // P3-A 重启恢复：无 lease 时磁盘估算用量需要会话模型（DB 持久化）解析 contextWindow
    resolveSessionModel: async (sessionId) => {
      const modelResult = await modelService.getSessionModel(sessionId);
      return modelResult.ok ? modelResult.data.model ?? undefined : undefined;
    },
    resolveDefaultThinkingLevel: readDefaultThinkingLevel,
    subagentService,
    onMainTurnEnd: (sessionId: string) => subagentService.notifyMainTurnEnd(sessionId),
  });
  // model（05）共享实例：提供真实 provider 就绪检查（models 非空）与会话模型解析
  const modelService = new ModelService({
    modelsFile: deps.modelsFile ?? new PiModelsFileAdapter(piModelsPath),
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
        getPiSupportedThinkingLevels(model, piModelsPath),
    },
  });
  // 悬空模型 ID 自愈（回归：改完模型后发消息报「模型未配置或不可用: MiniMax M3.1-Flash-Preview」，
  // 且该会话此后每条消息都报同一个错）。
  //
  // 根因链：设置里手打错的 ID（或改名/删掉的旧 ID）被原样存进 settings.defaultModel
  // 与会话 modelOverride，而真正的解析发生在 pi 会话工厂创建时——即每条消息都重新
  // 失败一次，会话树上却没有任何入口能看出坏在哪，用户在 UI 上的唯一出路是进去重选模型。
  //
  // 自愈只在有确凿证据时动手（probePiModel 返回 'not-found'）：
  //   1) 会话生效模型已不存在 → 改用全局默认（用户在设置里修好后，旧会话立刻跟着好）；
  //   2) 顺带清掉该会话的悬空覆盖，让它回到「跟全局走」，而不是永远卡在坏值上；
  //   3) 探测本身失败（models.json 读不到 / runtime 建不起来）时一律不动——「探不到」
  //      不等于「模型没了」，此时若当坏值处理就是误伤用户好端端的设置；
  //   4) 全局默认同样不存在时不擅自清空它（破坏性且非用户所求），而是放行原值，
  //      由工厂抛出原本那条信息量足够的错误。
  const resolveEffectiveModel = async (
    sessionId: string,
    model: string | undefined,
  ): Promise<string | undefined> => {
    if (model === undefined || model === '') return undefined;
    if ((await probePiModel(model, piModelsPath)) !== 'not-found') return model;

    const fallback = store.getSetting('defaultModel');
    const fallbackModel = typeof fallback === 'string' && fallback.trim() !== '' ? fallback.trim() : undefined;
    if (
      fallbackModel === undefined ||
      fallbackModel === model ||
      (await probePiModel(fallbackModel, piModelsPath)) !== 'ok'
    ) {
      return model; // 无可退：保持原值，让工厂按原路径报「模型未配置或不可用: <id>」
    }
    console.warn(
      `[createForgeCore] model ${model} no longer exists (session=${sessionId}), falling back to ${fallbackModel}`,
    );
    if (store.getSession(sessionId)?.modelOverride !== null) {
      await modelService.setSessionModel(sessionId, null);
    }
    return fallbackModel;
  };

  const conversationService = new ConversationService(conversationAdapter, {
    // CV-S08：会话模式上报未到 / 草稿态模式直查的轻量资源 port（skills+模板，不加载扩展）
    slashCommandResources: createSlashCommandResources(agentDir),
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
      // 自由会话（projectPath=null）没有项目 cwd，pi 又不接受空 cwd（落到
      // process.cwd() 兜底 = Electron 主进程目录，转录散落不可预测）——统一映射到
      // userData/free-workspace 专用目录并确保存在（转录目录名因此恒定，可恢复可删除）
      let cwd: string | undefined;
      if (session) {
        cwd = resolveSessionCwd(session.projectPath, agentDir);
        if (session.projectPath === null) {
          ensureFreeWorkspaceDir(agentDir);
        }
      }
      return {
        sessionId,
        cwd,
        model: await resolveEffectiveModel(
          sessionId,
          modelResult.ok ? modelResult.data.model ?? undefined : undefined,
        ),
        thinkingLevel,
      };
    },
    onStatusChange: (sid, status) => {
      // wu-06 done 门控按轮生效：新一轮发送进入 streaming 时重置门控（清上一轮
      // doneSent / 主轮结束标记 / 兜底计时器与未终态孤儿记录）。不重置则第二轮起
      // notifyMainTurnEnd 被 doneSent 短路，done 永不发射，状态卡在「进行中」。
      // 选在 onStatusChange('streaming') 而非 sendMessage RPC 入口重置：被校验
      // 拒绝的发送（如流式中重复发送 1001）不会误清仍在等待中的门控。
      if (status === 'streaming') {
        // 自动重试恢复的 streaming 不走 notifyMainTurnStart：主轮仍在进行，重置会
        // 清掉未终态子 agent 记录（removeActive），done 门控计数提前归零会提前发 done
        if (!retryRestorePending.delete(sid)) {
          subagentService.notifyMainTurnStart(sid);
        }
      } else {
        retryRestorePending.delete(sid);
      }
      conversationApi.pushStatus(sid, status);
      // 会话树状态圆点数据源：conversation 状态流转同步到 session 运行时表
      //（streaming→running，canceled/done→done），sessionApi 内部发射
      // session.statusChanged 触发 UI 会话树实时刷新
      const sessionStatus =
        status === 'streaming' ? 'running' : status === 'error' ? 'error' : status === 'idle' ? 'idle' : 'done';
      sessionApi.setSessionStatus(sid, sessionStatus);
    },
    onDelta: (sid, delta) => conversationApi.pushDelta(sid, delta.text),
    // 附件统一给路径：非视觉模型遇图片由 pi-ai 传输层降级占位，无需门控端口
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
      // CV-ERR-01：归因与文案生成收口到分类器。本层只做「原文 + 本轮是否已有内容」的
      // 传递，不再各自加工文案（旧逻辑散在 adapter 4 处，导致同一错误在不同路径下说法不一）。
      const raw = error?.raw ?? error?.message ?? '对话处理失败';
      const classified = classifyError(raw, {
        hasVisibleContent: error?.hasVisibleContent ?? false,
      });
      // lastError/lastErrorInfo 随 error 状态记录（红点会话切回后错误横幅的数据源）
      conversationService.setStatus(sessionId, 'error', {
        lastError: raw,
        lastErrorInfo: classified,
      });
      conversationApi.emitError(sessionId, 5000, raw, { error: classified });
    },
    onAutoRetryStart: (sessionId, info) => {
      pokeMainTurnActivity(sessionId); // 重试等待期也是会话活动，刷新看门狗
      // 先恢复 streaming（红点回进行中、composer 恢复、取消/重复发送门禁重新生效；
      // pi 的 abort() 会连带取消挂起重试，停止按钮全程有效），再推提示条：
      // status 事件不清提示条，顺序不能反
      retryRestorePending.add(sessionId);
      conversationService.setStatus(sessionId, 'streaming');
      // retry 字段标明「这不是终态错误」（CV-ERR-01）：UI 据此显示重试进度而非错误横幅
      conversationApi.emitError(
        sessionId,
        5000,
        `模型连接中断，正在自动重试（第 ${info.attempt}/${info.maxAttempts} 次）…`,
        { retry: { attempt: info.attempt, maxAttempts: info.maxAttempts } },
      );
    },
    // CV-S09：队列变更 → conversation.queueUpdated，UI 据此渲染待发送徽标/浮窗。
    // 派发时 user 气泡由 onMessage（role=user，经 pendingDelivery 确认）驱动。
    onQueueUpdated: (sessionId, followUp) => {
      conversationApi.emitQueueUpdated(sessionId, followUp);
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
    // P3-A：压缩开始（手动 + 运行时自动）→ conversation.compacting，
    // UI 据此锁定输入框并显示"正在压缩"横幅。
    onCompacting: (sessionId, info) => {
      pokeMainTurnActivity(sessionId); // 压缩也是会话活动，避免看门狗误判卡死
      conversationApi.emitCompacting(sessionId, info.reason);
    },
    // P3-A：压缩完成（手动 + 运行时自动）→ conversation.compacted，UI 据此重拉历史。
    // 自动压缩没有 RPC 入口，这是 UI 感知它的唯一通道。
    onCompacted: (sessionId, info) => {
      pokeMainTurnActivity(sessionId); // 压缩也是会话活动，避免看门狗误判卡死
      conversationApi.emitCompacted(sessionId, info);
    },
    // CV-S08：命令上报扩展的上报到达（slash-commands:reported → onSlashCommandsReported）。
    // 幂等：后一次上报整体覆盖会话缓存（ingestReportedCommands 内部 sessionExists 守卫，
    // 未注册会话静默忽略不崩）；再转发 conversation.slashCommandsUpdated 让 UI 失效
    // 缓存、下次触发浮窗重拉（AC-CV-032）。扩展缺失/上报失败时该回调不触发，
    // 会话模式回落轻量资源查询（WU-CV08-01 已实现，初始空缓存 getSlashCommands 走 port 降级）。
    onSlashCommandsReported: (sessionId, commands) => {
      conversationService.ingestReportedCommands(sessionId, commands as SlashCommand[]);
      conversationApi.emitSlashCommandsUpdated(sessionId);
    },
    // Path 2 ask_user_question：模型调用工具后扩展经会话总线投递问卷，适配器按会话
    // 订阅并补齐 sessionId 后上抛；此处转发 conversation.askUserQuestionRequested
    // （已登记 FORGE_EVENTS 白名单，main.ts 才转发到渲染进程）。
    // 载荷带必需 sessionId，多窗格各窗格按它认领，只在发起会话的窗格弹面板（契约 §4.4）。
    // 问卷请求也是会话活动，刷新主轮看门狗避免长等待被误判定死。
    onAskUserQuestionRequested: (_sessionId, payload) => {
      pokeMainTurnActivity(payload.sessionId);
      conversationApi.emitAskUserQuestionRequested(payload);
    },
  });

  // setCompletionHandler 不再调用：done 由 subagentService.notifyMainTurnEnd 门控
  // （适配器构造已注入 onMainTurnEnd，见上面）。适配器仅在无 onMainTurnEnd 时
  // 退回到原 completionHandler 路径（保持旧路径兼容）。

  // model（05）：复用共享 ModelService（真实 pi models.json 双向同步；测试可注入 mock）
  const modelApi = createModelApi(modelService, eventBus);

  // generateCommitMessage（模块 11 GC-F05）：单次 chat/completions 调用（不起 agent）。
  // provider 解析口径：会话模型（session→global 回退在 getSessionModel 内）→ 缺省退
  // 全局默认模型 → models.json 归属 provider → apiKey 明文（queryProviderList 已经
  // keychain.readKey 尝试解析 $VAR/!cmd 引用；仍为引用时按 $VAR 兜底查一次进程环境变量，
  // 未命中即视为无法解析）。错误码 6008（git 域顺延）；apiKey 绝不入日志。
  const commitMessageMethods = createCommitMessageMethods({
    gitService,
    isProjectRegistered: (targetPath) => {
      const r = projectService.queryProjectList();
      if (!r.ok) {
        return false;
      }
      let key: string;
      try {
        key = normalizeProjectPath(targetPath);
      } catch {
        key = path.resolve(targetPath);
      }
      return r.data.projects.some((p) => p.path === key);
    },
    resolveChatTarget: async (sessionId) => {
      let model: string | null = null;
      if (sessionId !== null) {
        const r = await modelService.getSessionModel(sessionId);
        if (r.ok) {
          model = r.data.model;
        }
      }
      if (model === null) {
        const r = await modelService.queryModels();
        if (r.ok) {
          model = r.data.defaultModel;
        }
      }
      if (model === null || model.trim() === '') {
        return { ok: false, code: 6008, message: '未配置模型：请先在设置页配置 provider 与默认模型' };
      }
      const pr = await modelService.queryProviderList();
      if (!pr.ok) {
        return { ok: false, code: 6008, message: pr.message };
      }
      const provider = pr.data.providers.find((p) => p.models.includes(model));
      if (provider === undefined) {
        return { ok: false, code: 6008, message: `模型未归属任何已配置 provider: ${model}` };
      }
      if (provider.baseUrl === null || provider.baseUrl.trim() === '') {
        return { ok: false, code: 6008, message: `provider「${provider.id}」缺少 baseUrl，无法调用` };
      }
      if (!provider.type.startsWith('openai')) {
        return { ok: false, code: 6008, message: `暂不支持 ${provider.type} 协议的 AI 生成提交说明` };
      }
      let apiKey = provider.apiKey ?? null;
      const envRef = apiKey !== null ? /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(apiKey) : null;
      if (envRef !== null) {
        apiKey = process.env[envRef[1] as string] ?? null;
      }
      if (apiKey === null || apiKey === '' || apiKey.startsWith('!')) {
        return { ok: false, code: 6008, message: 'API Key 无法解析，请在设置页重新保存该 provider' };
      }
      return { ok: true, target: { baseUrl: provider.baseUrl, apiKey, model } };
    },
  });

  // model/testProvider（模型连通性测试）：设置页表单「测试」按钮——用表单当前值（可未保存）
  // 单次 chat/completions 探活。与 generateCommitMessage 同一 fetch 口径，不经
  // resolveChatTarget（那里解析的是「已保存」provider，测试恰恰要验未保存的输入）。
  const modelTestMethods = createModelTestMethods();

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
    // wu-06 v1.1（PRD 06 SA-F04 / AC-SA-025/026）：只读子 agent 执行过程
    // （扩展任务输出文件尾部）。文件由 pi-subagents 写入，forge 不写不解析格式。
    'subagent/queryOutput': async (params: unknown) => {
      const sessionId = readStringParam(params, 'sessionId');
      const agentId = readStringParam(params, 'agentId');
      if (sessionId === null || agentId === null) {
        return failEnvelope(1001, '参数错误：sessionId/agentId 必须为非空字符串');
      }
      // CV-TRUST-04：agentId 直拼 tasks/${agentId}.output，../ 或分隔符可跳出 tmp 目录。
      // 白名单放行扩展实际生成的 ID 形态（UUID/nanoid/sub-agent-N），路径分隔符不存在
      // 即无从遍历。
      if (!/^[A-Za-z0-9._-]+$/.test(agentId)) {
        return failEnvelope(1001, '参数错误：agentId 含非法字符');
      }
      const session = store.getSession(sessionId);
      if (session === undefined) {
        return failEnvelope(1002, `会话不存在: ${sessionId}`);
      }
      const maxBytesRaw = (params as { maxBytes?: unknown } | null)?.maxBytes;
      const maxBytes =
        typeof maxBytesRaw === 'number' && Number.isFinite(maxBytesRaw) && maxBytesRaw > 0
          ? Math.min(Math.floor(maxBytesRaw), SUBAGENT_OUTPUT_TAIL_BYTES)
          : SUBAGENT_OUTPUT_TAIL_BYTES;
      const file = resolveSubagentOutputFile(
        resolveSessionCwd(session.projectPath, agentDir),
        sessionId,
        agentId,
      );
      const tail = readTail(file, maxBytes);
      return { code: 0, message: 'success', data: tail };
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

  // pi（07）：设置页「关于」Tab——forge 版本 + 更新组件。
  // 组件明细不回传 UI（原型确认 2026-09-08）：变更走结构化日志 + updater-state components 快照。
  // readPiExtensionList 保留在 piRuntime，供 IN-F02/F04 预装与联动更新使用。
  const piMethods: MethodTable = {
    'pi/getInfo': async () => ({
      code: 0,
      message: 'success',
      data: { forgeVersion: deps.forgeVersion ?? '0.0.0-dev' },
    }),
    'pi/updatePlugins': async () => {
      const result = await (deps.piUpdateExtensions ?? (() => updatePiExtensions(agentDir)))();
      if (!result.ok) {
        return { code: 6002, message: '组件更新失败', data: { output: result.output } };
      }
      // QA-G1（AC-PI-005）：手动更新成功 → 读快照比对输出「来源=手动」结构化日志，
      // 并以 readPiExtensionList 最新实体版本整体刷新 updater-state components 快照
      //（recordManualComponentUpdate 绝不抛出；updaterStatePath 缺省 null=跳过持久化仅输出日志）
      recordManualComponentUpdate({
        statePath: deps.updaterStatePath ?? null,
        agentDir,
        logger: (line) => console.log('[startup-update]', line),
      });
      return { code: 0, message: 'success', data: { output: result.output } };
    },
  };

  // updater（07 IN-S03）：应用自更新 RPC（updater/getState | checkForUpdates | downloadUpdate |
  // quitAndInstall，错误码 6003/6004/6005）。端口可注入（main.ts 组装真实 electron-updater 端口，
  // feed 取 FORGE_GH_OWNER/FORGE_GH_REPO）；缺省（不注入 autoUpdaterLike）降级端口——
  // 检查一律 6003，不触碰网络（dev 无 feed 场景）。状态跃迁（含下载进度步进）经共享
  // eventBus 发 updater.stateChanged（FORGE_EVENTS 白名单已登记，主进程转发渲染进程）。
  const updaterMethods: MethodTable = createUpdaterMethods(
    deps.appUpdater ??
      createAppUpdaterPort({
        getCurrentVersion: () => deps.forgeVersion ?? '0.0.0-dev',
        emit: (event, payload) => eventBus.emit(event, payload),
        // QA-G4：检查成功完成回写 lastUpdateCheckAt（观测字段）；statePath 未注入则跳过
        onCheckComplete: () => touchLastUpdateCheckAt(deps.updaterStatePath ?? null),
      }),
  );

  // 版本更新说明（升级后首启弹一次 + 关于页回看）：文件来自安装包 resources/（dev 回退
  // 仓库内文件），展示状态记 updater-state.json lastShownNotesVersion（pi/releaseNotes.ts）。
  // isUpgradeRun 由 main.ts 启动链早期同步采集后注入；缺省 false=不自动弹。
  const releaseNotesMethods: MethodTable = createReleaseNotesMethods({
    currentVersion: deps.forgeVersion ?? '0.0.0-dev',
    isUpgradeRun: deps.isUpgradeRun ?? false,
    notesFilePath: deps.releaseNotesPath ?? null,
    statePath: deps.updaterStatePath ?? null,
  });

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

  // skill（09）：skill 管理 RPC（list/import/create/delete）。枚举复用 pi loader；
  // 回收站能力经 deps.trashItem 端口（main.ts 注入 shell.trashItem，缺省回退永久删除）。
  const skillMethods: MethodTable = createSkillMethods({
    agentDir,
    trashItem: deps.trashItem,
    loaderFactory: deps.skillLoaderFactory,
  });

  // term（10：内嵌终端）：pty 注册表在主进程闭包；cwd containment 与 git 方法同口径
  // （归一后比对已注册项目列表，AC-10-06）；下行事件走共享 eventBus（term:data/term:exit
  // 已登记 FORGE_EVENTS）。node-pty 由 ptyService 首次 spawn 时动态加载，组装零成本。
  const termService = createTermService({
    isKnownProjectPath: (normalized) => {
      const r = projectService.queryProjectList();
      return r.ok && r.data.projects.some((p) => p.path === normalized);
    },
    emit: (event, payload) => eventBus.emit(event, payload),
  });

  // file（12：内置代码浏览器）：三个只读方法。projectRegistered 判定与 git/term 同口径
  // （归一后比对已注册项目列表）；真正的越界防护在 FileService.resolveInside 内，
  // 不在这里重复实现——安全规则保持单一事实来源。
  const fileApi = createFileApi({
    isProjectRegistered: (targetPath) => {
      const r = projectService.queryProjectList();
      if (!r.ok) return false;
      let key: string;
      try {
        key = normalizeProjectPath(targetPath);
      } catch {
        key = path.resolve(targetPath);
      }
      return r.data.projects.some((p) => p.path === key);
    },
    // 磁盘变化事件汇：file/watchSync 监听的文件变化 → code.fileChanged → 渲染层刷新签条
    events: eventBus,
  });

  const methodTable: MethodTable = {
    ...projectApi.methods,
    ...gitApi.methods,
    ...sessionApi.methods,
    ...conversationApi.methods,
    ...toolApi.methods,
    ...modelApi.methods,
    ...modelTestMethods,
    ...commitMessageMethods,
    ...subagentMethods,
    ...skillMethods,
    ...termService.methods,
    ...fileApi.methods,
    ...piMethods,
    ...updaterMethods,
    ...releaseNotesMethods,
    // 更新调试开关（main.ts 读 userData/updater-debug.json；enabled=true 时前端显示调试控制台）
    'app/getUpdateDebug': async () => ({
      code: 0,
      message: 'success',
      data: { enabled: deps.getUpdateDebugEnabled?.() ?? false },
    }),
    // 重写 cancelStream 为级联终止版本；sendMessage 加主轮看门狗布防
    'conversation/cancelStream': wrappedCancelStream,
    'conversation/sendMessage': wrappedSendMessage,
  };

  return { methodTable, eventBus, killAllPtys: termService.killAll };
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
 * 规则：取首行（附件统一给路径后，路径行随正文换行追加，天然不进标题），
 * 去除首尾空白，按句号/问号/感叹号/分号截断第一句，
 * 超过 30 字符截断并加省略号，全空则回退为「新会话」。
 */
export function generateSessionTitle(rawContent: string): string {
  const firstLine = rawContent.split('\n', 1)[0] ?? rawContent;
  const cleaned = firstLine.replace(/\s+/g, ' ').trim();
  if (cleaned.length === 0) return '新会话';
  // 首句切分：英文句点后跟字母/数字时不切（路径 a.ts、版本号 1.2 不被腰斩）
  const firstSentenceMatch = cleaned.match(/^(.+?)[。！？!?.;；](?![A-Za-z0-9_])/);
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
