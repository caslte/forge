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

import type {
  MinimalPiSession,
  PiAgentSessionFactoryOptions,
} from './piConversationAdapter.ts';
import { resolvePiModel } from './piModelResolver.ts';

export interface PiSessionHandle {
  sessionFile: string | undefined;
  /** cross-extension-rpc 通道：向 pi-subagents 扩展发终止请求并等回复信封 */
  stopSubagent(agentId: string): Promise<void>;
}

export interface CreatePiAgentSessionFactoryOptions {
  agentDir?: string;
  /** pi models.json 路径（默认 ~/.pi/agent/models.json），用于模型字符串解析 */
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
    const agentDir = resolveAgentDir(options.agentDir);
    const sessionDir = getDefaultSessionDir(cwd, agentDir);
    const forgeSessionId = assertValidSessionId(
      request.sessionId ?? crypto.randomUUID().replace(/-/g, ''),
    );
    const piSessionId = `forge-${forgeSessionId}`;
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(piSessionId)) {
      throw new Error(`非法 pi 会话 ID: ${piSessionId}`);
    }

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
    const subagentEventBus: SubagentEventBus = options.eventBus ?? createDefaultSubagentEventBus();
    const settingsManager = SettingsManager.create(cwd, agentDir);
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir,
      settingsManager,
      eventBus: subagentEventBus,
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

/** 解析 pi agent 目录（未指定时默认 ~/.pi/agent） */
function resolveAgentDir(agentDir?: string): string {
  return (
    agentDir ??
    path.join(process.env.USERPROFILE ?? process.env.HOME ?? process.cwd(), '.pi', 'agent')
  );
}

function getDefaultSessionDir(cwd: string, agentDir?: string): string {
  const root = resolveAgentDir(agentDir);
  return path.join(root, 'sessions', encodeURIComponent(cwd));
}

function assertValidSessionId(sessionId?: string): string {
  if (!sessionId || !/^[A-Za-z0-9_-]+$/.test(sessionId)) {
    throw new Error(`非法 forge 会话 ID: ${sessionId ?? '(空)'}`);
  }
  return sessionId;
}