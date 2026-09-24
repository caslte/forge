import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

import {
  createAgentSession,
  DefaultResourceLoader,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type CreateAgentSessionOptions,
} from '@earendil-works/pi-coding-agent';

import { askUserQuestionExtension, canvasHintExtension, slashCommandReporterExtension, suggestNextStepsExtension } from '@forge/extensions';

import type {
  MinimalPiSession,
  PiAgentSessionFactoryOptions,
} from './piConversationAdapter.ts';
import { resolvePiAgentDir, resolveProjectSessionDir, forgePiSessionId } from './piSessionPaths.ts';
import { resolvePiModel } from './piModelResolver.ts';

export interface PiSessionHandle {
  sessionFile: string | undefined;
  /** cross-extension-rpc 通道：向 pi-subagents 扩展发终止请求并等回复信封 */
  stopSubagent(agentId: string): Promise<void>;
}

export interface CreatePiAgentSessionFactoryOptions {
  agentDir?: string;
  /** pi models.json 路径（生产由 createForgeCore 注入 <agentDir>/models.json），用于模型字符串解析 */
  modelsPath?: string;
  /**
   * 子 agent 扩展事件总线（pi-subagents 在 pi.events 上的生命周期事件）。
   * 注入时：所有会话共享同一总线，扩展可观察到全部会话。
   * 未注入时：每会话创建独立总线（事件归组隔离）。
   */
  eventBus?: SubagentEventBus;
  /**
   * 跨扩展 RPC stop 回复超时（毫秒）。默认 10 秒；超时 reject 后由上层
   * SubagentService.stop 的「重试恰一次 → 5000」路径收敛，避免通道无响应时
   * 终止请求永久挂起。测试注入小窗口验证。
   */
  stopRpcTimeoutMs?: number;
}

/** 子 agent 扩展事件总线最小接口（forge-core / pi-subagents 都按此订阅） */
export interface SubagentEventBus {
  emit(channel: string, data: unknown): void;
  on(channel: string, handler: (data: unknown) => void): () => void;
}

type PiAgentSessionRuntimeFactory = (request: FactoryOptions) => Promise<{
  session: AgentSession & { setThinkingLevel(level: string): Promise<void> };
  dispose: () => void;
  /** 子 agent 扩展事件总线（lease 暴露供适配器订阅生命周期事件） */
  events: SubagentEventBus;
  /** 子 agent 句柄（暴露 sessionFile + cross-extension-rpc stop 通道） */
  handle: PiSessionHandle;
}>;

interface FactoryOptions extends PiAgentSessionFactoryOptions {
  sessionId?: string;
}

/** 创建默认子 agent 事件总线（per-session 独立总线） */
function createDefaultSubagentEventBus(): SubagentEventBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emit(channel: string, data: unknown): void {
      for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      let set = handlers.get(channel);
      if (set === undefined) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
  };
}

/** stop RPC 回复默认超时：10 秒（通道无响应时 reject，上层走重试→5000） */
export const DEFAULT_STOP_RPC_TIMEOUT_MS = 10_000;

/**
 * 构建 cross-extension-rpc 终止通道：
 * 1. 申请 requestId → emit('subagents:rpc:stop', { requestId, agentId })
 * 2. 订阅 reply channel → 收到 { success: true } resolve / { success: false, error } reject
 * 3. 超时无回复 → reject（扩展缺失/事件丢失时终止请求不得永久挂起）
 * 通道缺失（无 bus）时返回的 stopSubagent 直接 reject，保持上层 1002/5000 语义。
 */
function createStopSubagent(
  bus: SubagentEventBus | undefined,
  timeoutMs: number = DEFAULT_STOP_RPC_TIMEOUT_MS,
): (agentId: string) => Promise<void> {
  return (agentId: string): Promise<void> => {
    if (bus === undefined) {
      return Promise.reject(new Error('终止通道不可用'));
    }
    return new Promise<void>((resolve, reject) => {
      const requestId = randomUUID();
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        off();
        reject(new Error(`终止请求超时（${timeoutMs}ms 无回复）`));
      }, timeoutMs);
      const off = bus.on(`subagents:rpc:stop:reply:${requestId}`, (raw) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        off();
        const reply = raw as { success?: boolean; error?: string } | null;
        if (reply !== null && typeof reply === 'object' && reply.success === true) {
          resolve();
        } else {
          const message = reply !== null && typeof reply === 'object' && typeof reply.error === 'string'
            ? reply.error
            : '终止失败';
          reject(new Error(message));
        }
      });
      bus.emit('subagents:rpc:stop', { requestId, agentId });
    });
  };
}

export function createPiAgentSessionFactory(
  options: CreatePiAgentSessionFactoryOptions = {},
): PiAgentSessionRuntimeFactory {
  const stopRpcTimeoutMs = options.stopRpcTimeoutMs ?? DEFAULT_STOP_RPC_TIMEOUT_MS;
  const factory: PiAgentSessionRuntimeFactory = async (request) => {
    const cwd = request.cwd ?? process.cwd();
    const agentDir = resolvePiAgentDir(options.agentDir);
    const sessionDir = resolveProjectSessionDir(cwd, agentDir);
    // piSessionId = forge-<forgeSessionId>（建/读/删共用 piSessionPaths 单一定义源，
    // 非法 ID 早失败，避免建出删除时无法定位的文件）
    const piSessionId = forgePiSessionId(
      request.sessionId ?? crypto.randomUUID().replace(/-/g, ''),
    );

    const sessionFile = path.join(sessionDir, `${piSessionId}.jsonl`);
    const manager = fs.existsSync(sessionFile)
      ? SessionManager.open(sessionFile, sessionDir)
      : SessionManager.create(cwd, sessionDir);
    if (!fs.existsSync(sessionFile)) {
      const header = {
        type: 'session',
        version: 3,
        id: piSessionId,
        timestamp: new Date().toISOString(),
        cwd,
      };
      fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf8');
      manager.setSessionFile(sessionFile);
    }
    if (!fs.existsSync(sessionFile)) {
      const header = {
        type: 'session',
        version: 3,
        id: piSessionId,
        timestamp: new Date().toISOString(),
        cwd,
      };
      fs.writeFileSync(sessionFile, `${JSON.stringify(header)}\n`, 'utf8');
    }
    manager.setSessionFile(sessionFile);

    // P1-C：模型字符串解析为 pi Model 后注入新会话；解析失败抛稳定错误
    const createOptions: CreateAgentSessionOptions = {
      agentDir,
      cwd,
      sessionManager: manager,
    };
    if (typeof request.model === 'string') {
      createOptions.model = await resolvePiModel(request.model, options.modelsPath);
    } else if (request.model !== undefined) {
      createOptions.model = request.model as CreateAgentSessionOptions['model'];
    }
    // MP-S05：创建会话时应用生效思考级别（pi 内部按模型能力 clamp 就近收敛）
    if (typeof request.thinkingLevel === 'string' && request.thinkingLevel !== '') {
      createOptions.thinkingLevel = request.thinkingLevel as CreateAgentSessionOptions['thinkingLevel'];
    }

    // wu-06 总线桥接：把本会话的子 agent 总线注入 pi 扩展加载
    // （DefaultResourceLoader eventBus → loadExtensions → 扩展拿到的 pi.events），
    // 使 pi-subagents 的 subagents:* 生命周期事件与 cross-extension-rpc stop
    // 真正到达 forge。不注入则 pi 内部自建总线，forge 永远收不到扩展事件。
    // 装配与 createAgentSession 默认路径一致（cwd/agentDir/settingsManager），
    // 仅多传 eventBus，扩展发现逻辑（settings packages 等）不变。
    // CV-S08：同时经 extensionFactories 装载命令上报扩展（slash-commands:reported
    // 与 subagents:* 同构，session_start 时上报三类斜杠命令清单）。
    const subagentEventBus: SubagentEventBus = options.eventBus ?? createDefaultSubagentEventBus();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      eventBus: subagentEventBus,
      // CV-S08：命令上报扩展（slash-commands:reported）。
      // Path 2（ask_user_question 自建内置扩展，契约见 docs/plan/ask-user-question-contract.md）：
      // 与 rpiv 插件工具同名，靠下方 extensionsOverride 屏蔽插件本体，二者不共存。
      extensionFactories: [slashCommandReporterExtension, askUserQuestionExtension, suggestNextStepsExtension, canvasHintExtension],
      // 冲突处置（契约 §5 / 计划 §3.5）：agent 目录 settings.json 的 packages
      // 含 @juicesharp/rpiv-ask-user-question，DefaultResourceLoader.reload() 会经
      // packageManager.resolve() 把它也加载进来并注册同名 ask_user_question。
      // pi 的统一工具命名优先级的规则是「先注册者胜」但加载顺序无保证（runner.js:280），
      // 会出现「有时自建生效、有时插件生效」的薛定谔状态。
      // 这里在内存里直接过滤掉该扩展——纯代码，不写用户 settings.json；
      // 只屏蔽这一个包，pi-subagents / rpiv-todo 不受影响（TodoPanel 不回归）；
      // 系统 pi CLI 是另一个宿主，照常加载插件，左右分栏不受影响。
      extensionsOverride: (base) => ({
        ...base,
        extensions: base.extensions.filter(
          (ext) => !ext.path.includes('rpiv-ask-user-question'),
        ),
      }),
    });
    await resourceLoader.reload();
    createOptions.resourceLoader = resourceLoader;
    createOptions.settingsManager = settingsManager;

    const result = await createAgentSession(createOptions);

    // 真实 AgentSession.setThinkingLevel 为同步方法，而上层合约（MinimalPiSession）
    // 需要 async 形式的思考级别设置；用 Proxy 仅包装该方法为 Promise，其余能力
    // （prompt/subscribe/abort/setModel/getContextUsage/compact/modelRuntime 等）原样委托。
    const rawSession = result.session;

    // wu-06：绑定扩展运行时并触发 session_start（pi 宿主 TUI/RPC 模式创建会话后
    // 均如此；不绑定则 session_start 不发射）。pi-subagents 的跨扩展 RPC 处理器
    // （subagents:rpc:*）与会话级调度器都在 session_start 中注册，缺失时 forge 的
    // 终止 RPC 与扩展侧会话级行为永远不会激活。uiContext 缺省时 runner 使用 no-op。
    try {
      await rawSession.bindExtensions({
        mode: 'rpc',
        onError: (err) => {
          console.warn(
            `[createPiAgentSessionFactory] extension error (${err.extensionPath}) on ${err.event}: ${err.error}`,
          );
        },
      });
    } catch (err) {
      // 绑定失败不阻断会话创建（降级为扩展会话级行为不可用，事件仍可桥接）
      console.warn('[createPiAgentSessionFactory] bindExtensions failed', err);
    }
    const session = new Proxy(rawSession, {
      get(target, prop, receiver) {
        if (prop === 'setThinkingLevel') {
          return (level: string) => {
            target.setThinkingLevel(level as AgentSession['thinkingLevel']);
            return Promise.resolve();
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as AgentSession & { setThinkingLevel(level: string): Promise<void> };

    const stopSubagent = createStopSubagent(subagentEventBus, stopRpcTimeoutMs);

    return {
      session,
      dispose: () => rawSession.dispose(),
      events: subagentEventBus,
      handle: {
        get sessionFile() {
          return rawSession.sessionFile;
        },
        stopSubagent,
      },
    };
  };

  return factory;
}

/**
 * 预热 pi 扩展加载缓存（首条消息卡顿修复）。
 *
 * 会话工厂冷启动时 resourceLoader.reload() 经 jiti 现场编译 settings.packages 全部
 * npm 扩展（实测本机 10 个包 3~9s），同步占用 Electron 主进程事件循环 → 全 app IPC
 * 延迟、会话树刷新延迟。pi 扩展模块缓存按 cwd 记忆（进程内 Map），预热后同 cwd
 * 工厂 reload 仅需 ~100ms。在 project.opened 时对项目 cwd 后台预热，把冷编译
 * 从首条消息发送路径挪到打开项目时。
 * 同 cwd 只预热一次；失败仅告警（预热不能影响正常工厂创建）。
 * 已知边界：pi 缓存按 cwd 记忆，切换预热另一个项目会使上一项目缓存失效
 * （多项目轮流首发仍可能冷启动一次）。
 */
const warmedCwds = new Set<string>();
const warmingCwds = new Map<string, Promise<void>>();

export function warmPiResourceLoader(cwd: string, agentDir?: string): Promise<void> {
  if (warmedCwds.has(cwd)) return Promise.resolve();
  const inFlight = warmingCwds.get(cwd);
  if (inFlight !== undefined) return inFlight;
  const run = (async () => {
    try {
      const dir = resolvePiAgentDir(agentDir);
      const settingsManager = SettingsManager.create(cwd, dir);
      const resourceLoader = new DefaultResourceLoader({ cwd, agentDir: dir, settingsManager });
      await resourceLoader.reload();
      warmedCwds.add(cwd);
    } catch (err) {
      console.warn(`[createPiAgentSessionFactory] 扩展加载预热失败 (cwd=${cwd})`, err);
    } finally {
      warmingCwds.delete(cwd);
    }
  })();
  warmingCwds.set(cwd, run);
  return run;
}