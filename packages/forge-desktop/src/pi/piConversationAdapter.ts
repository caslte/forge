import fs from 'node:fs';

import {
  SessionManager,
  calculateContextTokens,
  estimateTokens,
  type AgentSession,
} from '@earendil-works/pi-coding-agent';
import type {
  ConversationMessage,
  ConversationCompactResult,
  ConversationCompactedPayload,
} from '@forge/core';
import { stripThinkingContent } from './thinkingFilter.ts';
import type { SubagentEventBus } from './createPiAgentSessionFactory.ts';

export interface PiAgentSessionLease<TSession> {
  session: TSession;
  dispose: () => void;
  /** 子 agent 扩展事件总线（生命周期事件订阅源；扩展缺失时可缺省） */
  events?: SubagentEventBus;
  /** 句柄：暴露 sessionFile + cross-extension-rpc stop 通道 */
  handle?: {
    sessionFile?: string;
    stopSubagent?: (agentId: string) => Promise<void>;
  };
}

export interface PiAgentSessionFactoryOptions {
  sessionId?: string;
  cwd?: string;
  /** forge 模型 ID 字符串，或已解析的 pi Model 对象（热切换时由适配器解析后传入） */
  model?: unknown;
  /** 会话生效思考级别（MP-S05）：创建会话时应用；与当前已应用级别不同时运行时调整 */
  thinkingLevel?: string;
}

/** 结构化最小 pi 会话接口（真实 AgentSession 与测试 fake 共同满足） */
export type MinimalPiSession = {
  subscribe(listener: (event: unknown) => void): () => void;
  /** prompt：第二参为图片附件（真实 AgentSession 收 PromptOptions，fake 收图片数组） */
  prompt(text: string, imagesOrOptions?: unknown): Promise<void>;
  abort(): Promise<void>;
  /** 运行中热切换模型（真实 AgentSession 支持；fake 可选实现） */
  setModel?(model: unknown): Promise<void>;
  /** 上下文用量查询（P3-A）；真实 AgentSession 支持，fake 可选；结构兼容 ContextUsage */
  getContextUsage?(): unknown;
  /** 手动压缩（P3-A）；真实 AgentSession 支持，fake 可选；返回压缩结果 */
  compact?(customInstructions?: string): Promise<unknown>;
  /** 思考级别设置（默认关闭策略）；真实 AgentSession 为同步，适配层 async 包装 */
  setThinkingLevel?(level: string): Promise<void>;
  /**
   * 模型运行时刷新（provider 配置变更用）：重读 models.json 重组 providers，
   * 使已保存的 API Key 引用立即生效；真实 AgentSession 经 modelRuntime 暴露。
   */
  modelRuntime?: { refresh(options?: unknown): Promise<unknown> };
};

/** 适配器构造选项（模型解析器可注入；缺省走真实 pi models.json 解析） */
export interface PiConversationAdapterOptions {
  resolveModel?: (model: string) => Promise<unknown>;
  /**
   * 由 forge sessionId 定位 pi 会话文件（P2-D 重启恢复）：
   * 重启后内存 sessionFiles 为空，命中磁盘 JSONL 时据此恢复历史。
   */
  resolveSessionFile?: (sessionId: string) => string | undefined;
  /**
   * 由 forge sessionId 解析会话模型字符串（P3-A 重启恢复）：无 lease 时磁盘估算
   * 用量需要模型元数据（contextWindow）。数据源为 DB 持久化的会话模型，
   * 由 createForgeCore 注入（modelService.getSessionModel）。
   */
  resolveSessionModel?: (sessionId: string) => Promise<string | undefined>;
  /**
 * 全局默认思考级别（默认 'off'：thinking 内容默认不产生不展示）。
 * 每次发送前应用到会话（幂等；pi 内部按模型能力 clamp，级别未变化不写
 * transcript）。改为其它级别时，思考内容仍会被展示层过滤，仅影响模型是否思考。
 */
defaultThinkingLevel?: string;
/**
 * 实时读取全局默认思考级别（MP-QA-G01 修复）：运行中 `model/setSessionThinkingLevel`
 * 会同步全局 settings.thinkingLevel，须每次发送前实时读取，消除「启动快照 vs
 * 实时全局」不一致。缺省时不注入，退化为 defaultThinkingLevel 常量兜底。
 */
resolveDefaultThinkingLevel?: () => string;
  /**
   * 子 agent 管理服务（wu-06）。未注入时适配器静默降级：忽略 lease.events、
   * stopSubagent 直接 reject（适配器层错误，createForgeCore 映射 1002）。
   */
  subagentService?: SubagentServiceLike;
  /**
   * 主轮完成回调（wu-06 done 门控入口）：prompt 解析（成功/中止）后触发，
   * 由上层（createForgeCore）转发到 subagentService.notifyMainTurnEnd
   * 实现「活跃子 agent 全部完成才发 done」的语义。
   */
  onMainTurnEnd?: (sessionId: string) => void;
}

/** SubagentService 适配子集（仅消费 ingest/notifyMainTurnEnd/disposeSession；解耦 @forge/core 强依赖） */
export interface SubagentServiceLike {
  ingest(sessionId: string, event: SubagentAdapterEvent): void;
  notifyMainTurnEnd(sessionId: string): void;
  disposeSession(sessionId: string): void;
}

/** 适配层喂入的子 agent 事件（与 forge-core SubagentEventInput 字段对齐） */
export interface SubagentAdapterEvent {
  agentId: string;
  status: 'queued' | 'running' | 'completed' | 'failed' | 'stopped';
  agentType?: string;
  description?: string;
  result?: string;
  error?: string;
  usage?: { inputTokens: number; outputTokens: number };
}

export type PiAgentSessionFactory<TSession = AgentSession> = (
  options: PiAgentSessionFactoryOptions,
) => Promise<PiAgentSessionLease<TSession>>;

interface SessionCallbacks {
  onDelta: (text: string) => void;
  onMessage: (message: ConversationMessage) => void;
  onError?: (error: PiConversationError) => void;
}

export interface PiConversationError {
  message: string;
}

/** pi 自动重试开始事件载荷（attempt/maxAttempts 由 pi 提供，每轮独立计数） */
export interface PiAutoRetryInfo {
  attempt: number;
  maxAttempts: number;
  errorMessage: string;
}

/**
 * 压缩完成回调载荷（P3-A）：复用 core 契约，去掉事件层才有的 sessionId。
 */
export type CompactionInfo = Omit<ConversationCompactedPayload, 'sessionId'>;

/**
 * 手动压缩返回（P3-A）：与 core `ConversationCompactResult` 同构。
 * 注意 pi CompactionResult 本身不含 message 字段，该字段只在失败时由适配层填充。
 */
export type CompactOutcome = ConversationCompactResult;

/** 工具开始事件载荷（映射 pi tool_execution_start） */
export interface PiToolStartedPayload {
  toolEventId: string;
  tool: { name: string; input: Record<string, unknown> };
}

/** 工具完成事件载荷（映射 pi tool_execution_end 且 isError=false） */
export interface PiToolCompletedPayload {
  toolEventId: string;
  result: { text: string | null; image: string | null };
}

/** 工具错误事件载荷（映射 pi tool_execution_end 且 isError=true） */
export interface PiToolErrorPayload {
  toolEventId: string;
  error: { message: string };
}

/** 实例级事件处理器：按 sessionId 回调，供内核统一接线（未注册会话级监听时生效） */
export interface PiConversationEventHandlers {
  onDelta?: (sessionId: string, text: string) => void;
  onMessage?: (sessionId: string, message: ConversationMessage) => void;
  onError?: (sessionId: string, error: PiConversationError) => void;
  /**
   * pi 自动重试开始（可重试错误后触发）：轮次仍在运行。此前 message_end(error)
   * 已把会话置为 error（红点），上层应恢复 streaming 并提示，否则红点永不恢复、
   * UI 与真实轮次脱节（重试成功后轮次继续跑，界面却显示已断）。
   */
  onAutoRetryStart?: (sessionId: string, info: PiAutoRetryInfo) => void;
  onToolStarted?: (sessionId: string, event: PiToolStartedPayload) => void;
  onToolCompleted?: (sessionId: string, event: PiToolCompletedPayload) => void;
  onToolError?: (sessionId: string, event: PiToolErrorPayload) => void;
  /**
   * 上下文压缩开始（P3-A）：手动与自动压缩均回调，UI 据此锁定输入框并
   * 显示"正在压缩"横幅（与 onCompacted 成对，压缩失败时以 onError 收尾）。
   */
  onCompacting?: (sessionId: string, info: { reason: 'manual' | 'auto' }) => void;
  /**
   * 上下文压缩完成（P3-A）：手动与自动压缩均回调，UI 据此刷新消息列表。
   * 自动压缩（pi 按阈值/溢出触发）没有 RPC 入口，只能靠本回调让 UI 感知，
   * 否则用户会看到历史被摘要替换却毫无提示。
   */
  onCompacted?: (sessionId: string, info: CompactionInfo) => void;
}

type TurnCompletionHandler = (sessionId: string) => void;

type MinimalPiEvent = {
  type: string;
  message?: {
    role?: string;
    /** pi AssistantMessage.content：字符串或内容块数组（{type:'text',text}） */
    content?: string | Array<{ type?: string; text?: string }>;
    stopReason?: string;
    errorMessage?: string;
    error?: string;
  };
  /** pi AssistantMessageEvent：仅 text_delta 携带文本增量 */
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  // agent_end / turn_end 可能携带错误
  errorMessage?: string;
  willRetry?: boolean;
  // auto_retry_start / auto_retry_end：pi 自动重试事件（可重试错误如 network_error/429/5xx）
  attempt?: number;
  maxAttempts?: number;
  success?: boolean;
  finalError?: string;
  // compaction_start / compaction_end：触发原因（manual / threshold / overflow）
  reason?: string;
  // compaction_end：是否被中止
  aborted?: boolean;
};

export class PiConversationAdapter {  private readonly leases = new Map<string, PiAgentSessionLease<MinimalPiSession>>();
  private readonly callbacks = new Map<string, SessionCallbacks>();
  private readonly partialContent = new Map<string, string>();
  /** 当前未完成 assistant 消息的清洗后累计文本（message_end/轮次结束即清空）。
   *  pi 仅在 message_end 时把 assistant 消息写入会话 JSONL，流式进行中切回会话时
   *  loadHistory 从磁盘读不到这条消息，后续 delta 会失去追加基点（界面内容截断，
   *  直到 message_end 才被完整消息覆盖自愈）。loadHistory 用它补上未完成快照。 */
  private readonly livePartial = new Map<string, string>();
  /** 流式清洗后已转发的累计文本（供增量求差，思考块剥除后仍能正确续传） */
  private readonly forwardedClean = new Map<string, string>();
  private readonly errorListeners = new Map<string, (error: PiConversationError) => void>();
  private readonly sessionFiles = new Map<string, string>();
  /** 本轮 prompt 已通过 handleEvent 触发过错误，避免 catch 重复上报 */
  private readonly errorEmittedThisTurn = new Set<string>();
  /** 内存会话记录（无 pi session 文件时的历史回退，含 user 与 assistant） */
  private readonly transcripts = new Map<string, ConversationMessage[]>();
  /** 每会话最近一次压缩后的估算 token 数（pi 在压缩边界后返回 null 用量时合成百分比） */
  private readonly lastCompactTokensAfter = new Map<string, number>();
  /** 会话当前生效模型字符串（热切换差异比较用） */
  private readonly leaseModels = new Map<string, string | undefined>();
  /** 每会话最后应用/已生效的思考级别（差异比较用；未应用过则为 undefined） */
  private readonly appliedThinkingLevels = new Map<string, string>();
  /** 每会话在底层 AgentSession 上的单次订阅取消函数（防重复订阅） */
  private readonly unsubs = new Map<string, () => void>();
  /** 每会话在子 agent 扩展事件总线上的订阅取消函数（removeSession 时释放） */
  private readonly subagentUnsubs = new Map<string, () => void>();
  private eventHandlers: PiConversationEventHandlers = {};
  private completionHandler: TurnCompletionHandler | undefined;
  /** 主轮完成回调（wu-06 done 门控）：prompt 解析后调用，转发到 subagentService.notifyMainTurnEnd */
  private mainTurnEndHandler: ((sessionId: string) => void) | undefined;

  private readonly factory: PiAgentSessionFactory<MinimalPiSession>;
  private readonly resolveModel: (model: string) => Promise<unknown>;
  private readonly resolveSessionFile: ((sessionId: string) => string | undefined) | undefined;
  /** 会话模型解析（P3-A 磁盘估算用量用）；未注入时无 lease 会话返回未知用量 */
  private readonly resolveSessionModel: ((sessionId: string) => Promise<string | undefined>) | undefined;
  /** 全局默认思考级别；缺省 'off'（thinking 内容默认不产生不展示） */
  private readonly defaultThinkingLevel: string;
  /** 实时读取全局默认思考级别（MP-QA-G01 修复）；未注入则用 defaultThinkingLevel 常量兜底 */
  private readonly resolveDefaultThinkingLevel: (() => string) | undefined;
  /** 子 agent 管理服务（wu-06）：生命周期事件喂入入口；缺省静默降级 */
  private readonly subagentService: SubagentServiceLike | undefined;

  constructor(
    factory: PiAgentSessionFactory<MinimalPiSession>,
    options: PiConversationAdapterOptions = {},
  ) {
    this.factory = factory;
    this.defaultThinkingLevel = options.defaultThinkingLevel ?? 'off';
    this.resolveDefaultThinkingLevel = options.resolveDefaultThinkingLevel;
    this.resolveSessionFile = options.resolveSessionFile;
    this.resolveSessionModel = options.resolveSessionModel;
    this.subagentService = options.subagentService;
    this.mainTurnEndHandler = options.onMainTurnEnd;
    this.resolveModel =
      options.resolveModel ??
      (async (model: string) => {
        const { resolvePiModel } = await import('./piModelResolver.ts');
        return resolvePiModel(model);
      });
  }

  onDelta(sessionId: string, listener: (text: string) => void): void {
    this.callbacks.set(sessionId, {
      ...(this.callbacks.get(sessionId) ?? { onMessage: () => undefined }),
      onDelta: listener,
    });
  }

  onMessage(sessionId: string, listener: (message: ConversationMessage) => void): void {
    this.callbacks.set(sessionId, {
      ...(this.callbacks.get(sessionId) ?? { onDelta: () => undefined }),
      onMessage: listener,
    });
  }

  onError(sessionId: string, listener: (error: PiConversationError) => void): void {
    this.errorListeners.set(sessionId, listener);
    const callback = this.callbacks.get(sessionId);
    if (callback) {
      callback.onError = listener;
    }
  }

  getPartialContent(sessionId: string): string {
    return this.partialContent.get(sessionId) ?? '';
  }

  setEventHandlers(handlers: PiConversationEventHandlers): void {
    this.eventHandlers = handlers;
  }

  setCompletionHandler(handler: TurnCompletionHandler): void {
    this.completionHandler = handler;
  }

  async sendMessage(
    sessionId: string,
    content: string,
    options: PiAgentSessionFactoryOptions = {},
  ): Promise<void> {
    // P1-D：同一会话复用已持有的 AgentSession lease，避免每轮重建上下文
    const existing = this.leases.get(sessionId);
    let lease: PiAgentSessionLease<MinimalPiSession>;
    if (existing === undefined) {
      lease = await this.factory(options);
      this.leases.set(sessionId, lease);
      this.leaseModels.set(sessionId, typeof options.model === 'string' ? options.model : undefined);
    } else {
      lease = existing;
      await this.applyModelChange(sessionId, lease, options);
    }
    this.partialContent.set(sessionId, '');
    this.forwardedClean.set(sessionId, '');
    this.livePartial.set(sessionId, '');
    this.errorEmittedThisTurn.delete(sessionId);
    // 思考级别应用（MP-S05）：目标级别 = options.thinkingLevel（会话生效级别，
    // 由上层 resolveSendOptions 计算：session.thinkingLevel ?? settings，兜底 off），
    // 缺省降级 defaultThinkingLevel。仅当目标级别与当前已应用级别不同时才调用
    // setThinkingLevel（幂等：未变化不打断/不写 transcript）。clamp 收敛由上层/
    // 服务保证，此处不得越权扩容；lease 无此能力则忽略不报错。
    const targetLevel = options.thinkingLevel ?? this.getDefaultThinkingLevel();
    if (targetLevel !== this.appliedThinkingLevels.get(sessionId)) {
      try {
        lease.session.setThinkingLevel?.(targetLevel);
      } catch (err) {
        console.warn(`[piConversationAdapter] 设置思考级别 ${targetLevel} 失败`, err);
      }
      this.appliedThinkingLevels.set(sessionId, targetLevel);
    }
    this.transcripts.set(sessionId, [
      ...(this.transcripts.get(sessionId) ?? []),
      { role: 'user', content, ts: new Date().toISOString() },
    ]);
    const handle = (lease as PiAgentSessionLease<MinimalPiSession> & {
      handle?: { sessionFile?: string; stopSubagent?: (agentId: string) => Promise<void> };
    }).handle;
    if (handle?.sessionFile) {
      this.sessionFiles.set(sessionId, handle.sessionFile);
    }
    // 每会话在底层 AgentSession 上仅订阅一次，避免同一会话重复 subscribe 导致增量成倍重复
    if (!this.unsubs.has(sessionId)) {
      const unsub = lease.session.subscribe((event) => this.handleEvent(sessionId, event));
      this.unsubs.set(sessionId, unsub);
    } else if (this.leases.get(sessionId) !== lease) {
      // 模型热切换重建了 lease（旧 lease 已 dispose），需要换订阅到新 session 对象
      const prev = this.unsubs.get(sessionId);
      try {
        prev?.();
      } catch {}
      const unsub = lease.session.subscribe((event) => this.handleEvent(sessionId, event));
      this.unsubs.set(sessionId, unsub);
    }
    // wu-06：订阅子 agent 扩展事件总线（created/started/completed/failed）→ SubagentService.ingest
    // lease.events 缺失（扩展未激活）时跳过；每个会话独立订阅，removeSession 时退订。
    this.bindSubagentBus(sessionId, lease as PiAgentSessionLease<MinimalPiSession>);
    try {
      // 附件统一给路径：路径行已随 content 发送，模型自行 read；
      // 非视觉模型遇图片时 pi-ai 传输层自动降级占位，adapter 恒单参调用
      await lease.session.prompt(content);
    } catch (err) {
      // 轮次已结束（无论成败）：进行中快照不再需要，避免与已落盘消息重复
      this.livePartial.delete(sessionId);
      const error = err instanceof Error ? err : new Error(String(err));
      // 撞车自愈：forge 状态已收敛但 pi run 仍挂着（如看门狗前的竞态窗口）时，
      // prompt 会被 pi 以 "Agent is already processing" 拒绝。abort 掉僵尸轮，
      // 会话即恢复可用，再报错提示重发。
      if (/already processing/i.test(error.message)) {
        try {
          await lease.session.abort();
        } catch {}
      }
      // 保留 pi 原始错误的 provider 名（便于定位是哪条配置缺凭据）
      const message = /already processing/i.test(error.message)
        ? '上一轮任务仍在后台执行，已将其结束，请重新发送'
        : /No API key found/i.test(error.message)
          ? `模型凭据未配置（${error.message}）：请在设置中为对应模型填写并保存 API Key 后重试`
          : error.message;
      // 若本轮已通过 handleEvent 上报过同类错误（如 message_end error），避免重复
      if (!this.errorEmittedThisTurn.has(sessionId)) {
        this.errorListeners.get(sessionId)?.({ message });
        this.eventHandlers.onError?.(sessionId, { message });
      }
      this.errorEmittedThisTurn.delete(sessionId);
      throw new Error(message);
    }
    // 轮次正常结束：进行中快照不再需要（终态消息已由 message_end 清理/落盘）
    this.livePartial.delete(sessionId);
    const hadError = this.errorEmittedThisTurn.has(sessionId);
    this.errorEmittedThisTurn.delete(sessionId);

    if (!hadError) {
      // wu-06 done 门控：prompt 解析后转发到 subagentService.notifyMainTurnEnd，
      // 由服务层决策「计数=0 立即 done / >0 延迟 + 超时兜底」。completionHandler 保留
      // 给旧路径兼容（与 onMainTurnEnd 二选一，优先 onMainTurnEnd）。
      if (this.mainTurnEndHandler !== undefined) {
        this.mainTurnEndHandler(sessionId);
      } else {
        this.completionHandler?.(sessionId);
      }
    }
  }

  async cancelStream(sessionId: string): Promise<void> {
    await this.leases.get(sessionId)?.session.abort();
  }

  /**
   * 读取回退默认思考级别（MP-QA-G01 修复）：优先调用注入的实时 getter
   * （每次发送前读取 settings.thinkingLevel），否则退化为构造时默认常量。
   */
  private getDefaultThinkingLevel(): string {
    if (this.resolveDefaultThinkingLevel !== undefined) {
      return this.resolveDefaultThinkingLevel();
    }
    return this.defaultThinkingLevel;
  }

  /**
   * 会话复用时的模型热切换（P1-C）：模型字符串变化才切换；解析失败抛稳定
   * 错误且不破坏已有会话。会话不支持 setModel 时降级为销毁重建（下一轮生效）。
   */
  private async applyModelChange(
    sessionId: string,
    lease: PiAgentSessionLease<MinimalPiSession>,
    options: PiAgentSessionFactoryOptions,
  ): Promise<void> {
    const { model } = options;
    if (typeof model !== 'string') {
      return;
    }
    const previous = this.leaseModels.get(sessionId);
    if (previous === model) {
      return;
    }
    const piModel = await this.resolveModel(model);
    if (typeof lease.session.setModel === 'function') {
      await lease.session.setModel(piModel);
      this.leaseModels.set(sessionId, model);
      return;
    }
    // 不支持热切换：释放旧会话并按新模型重建（等价于下一轮生效）
    // 先清理旧订阅
    const prevUnsub = this.unsubs.get(sessionId);
    try {
      prevUnsub?.();
    } catch {}
    this.unsubs.delete(sessionId);
    lease.dispose();
    const created = await this.factory({ ...options, model: piModel });
    this.leases.set(sessionId, created);
    this.leaseModels.set(sessionId, model);
  }

  async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    let sessionFile = this.sessionFiles.get(sessionId);
    // P2-D 重启恢复：内存无记录时经注入解析器定位磁盘 JSONL（重启后历史不丢）
    if (sessionFile === undefined && this.resolveSessionFile !== undefined) {
      sessionFile = this.resolveSessionFile(sessionId);
      if (sessionFile !== undefined) {
        this.sessionFiles.set(sessionId, sessionFile);
      }
    }
    if (sessionFile) {
      const { loadPiSessionHistory } = await import('./loadPiSessionHistory.ts');
      const messages = await loadPiSessionHistory(sessionFile);
      // 流式进行中切回：磁盘还没有这条未完成消息，补上快照作为后续 delta 的追加基点
      const partial = this.livePartial.get(sessionId);
      if (partial) {
        messages.push({ role: 'assistant', content: partial, ts: new Date().toISOString() });
      }
      return messages;
    }
    const messages = [...(this.transcripts.get(sessionId) ?? [])];
    if (!messages.some((message) => message.role === 'assistant')) {
      // 优先用清洗后的进行中快照（partialContent 为未清洗原始累计，混流思考未剥除）
      const content = this.livePartial.get(sessionId) || this.partialContent.get(sessionId);
      if (content) {
        messages.push({ role: 'assistant', content, ts: new Date().toISOString() });
      }
    }
    return messages;
  }

  /**
   * 查询会话上下文用量（P3-A）：优先委托活跃 lease 的 getContextUsage()；
   * 无 lease（重启后仅加载历史）时回落磁盘估算——pi 的用量本身就是「最后一条
   * 有效 assistant usage + 尾部字符估算」，会话 JSONL 里都有，不必激活运行时。
   * 无文件/无模型元数据/无法解析时返回 null（UI 显示未知，不报错）。
   */
  async getContextUsage(
    sessionId: string,
  ): Promise<{ tokens: number | null; contextWindow: number; percent: number | null } | null> {
    const lease = this.leases.get(sessionId);
    let usage: { tokens: number | null; contextWindow: number; percent: number | null } | null = null;
    if (lease !== undefined && typeof lease.session.getContextUsage === 'function') {
      const raw = lease.session.getContextUsage();
      if (raw !== null && raw !== undefined) {
        const u = raw as { tokens?: number | null; contextWindow?: number; percent?: number | null };
        usage = {
          tokens: typeof u.tokens === 'number' ? u.tokens : null,
          contextWindow: typeof u.contextWindow === 'number' ? u.contextWindow : 0,
          percent: typeof u.percent === 'number' ? u.percent : null,
        };
      }
    }
    if (usage === null) usage = await this.estimateUsageFromDisk(sessionId);
    // 压缩边界后 pi 返回 null 用量（边界前 usage 只会虚报）：用最近一次压缩的
    // tokensAfter 合成百分比，让 UI 压缩后立即显示新的上下文占用而非"? tokens"
    if (usage !== null && usage.percent === null) {
      const after = this.lastCompactTokensAfter.get(sessionId);
      const tokens = usage.tokens ?? (typeof after === 'number' ? after : null);
      if (typeof tokens === 'number' && usage.contextWindow > 0) {
        return { tokens, contextWindow: usage.contextWindow, percent: (tokens / usage.contextWindow) * 100 };
      }
    }
    return usage;
  }

  /**
   * 无活跃 lease 时的磁盘用量估算（P3-A 重启恢复）：读会话 JSONL 分支条目，
   * 按 pi AgentSession.getContextUsage 同一规则计算——最后一条有效 assistant
   * 用量（totalTokens）+ 之后消息的字符估算；全无用量时逐条估算。压缩边界
   * 之后没有新 assistant 用量时 tokens 不可信（pi 同样返回 null）。
   * 解析失败静默降级为 null：用量查询不能破坏历史加载主流程。
   */
  private async estimateUsageFromDisk(
    sessionId: string,
  ): Promise<{ tokens: number | null; contextWindow: number; percent: number | null } | null> {
    let sessionFile = this.sessionFiles.get(sessionId);
    if (sessionFile === undefined && this.resolveSessionFile !== undefined) {
      sessionFile = this.resolveSessionFile(sessionId);
    }
    if (sessionFile === undefined || !fs.existsSync(sessionFile)) return null;
    const modelString = this.leaseModels.get(sessionId) ?? (await this.resolveSessionModel?.(sessionId));
    if (typeof modelString !== 'string' || modelString === '') return null;

    try {
      // 模型解析也在 try 内：会话模型可能已从 models.json 删除，解析失败降级为
      // 未知用量而非 5000 错误（用量查询不能比历史加载更躁）
      const piModel = (await this.resolveModel(modelString)) as { contextWindow?: unknown } | undefined;
      const contextWindow = typeof piModel?.contextWindow === 'number' ? piModel.contextWindow : 0;
      if (contextWindow <= 0) return null;
      const entries = SessionManager.open(sessionFile, undefined, undefined).getBranch();
      // 最后一条有效 assistant（stopReason 非 aborted/error 且 usage>0）的真实用量
      let usageTokens = 0;
      let usageIndex = -1;
      for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i];
        if (entry?.type !== 'message' || entry.message.role !== 'assistant') continue;
        const assistant = entry.message;
        if (assistant.stopReason === 'aborted' || assistant.stopReason === 'error') continue;
        if (!assistant.usage || calculateContextTokens(assistant.usage) <= 0) continue;
        usageTokens = calculateContextTokens(assistant.usage);
        usageIndex = i;
        break;
      }
      // 压缩边界守卫（与 pi 一致）：压缩后上下文已重建，边界前的 usage 只会虚报；
      // 边界之后没有新 assistant 用量则视为未知
      for (let i = entries.length - 1; i >= 0; i--) {
        if (entries[i]?.type === 'compaction') {
          if (usageIndex < i) return { tokens: null, contextWindow, percent: null };
          break;
        }
      }
      // 尾部消息（最后真实用量之后）按字符估算；无任何用量时全量估算
      let trailing = 0;
      for (let i = usageIndex + 1; i < entries.length; i++) {
        const entry = entries[i];
        if (entry?.type !== 'message') continue;
        trailing += estimateTokens(entry.message);
      }
      const tokens = usageIndex >= 0 ? usageTokens + trailing : trailing;
      return { tokens, contextWindow, percent: (tokens / contextWindow) * 100 };
    } catch {
      // 损坏/无法解析的会话文件：用量未知（历史加载已有稳定错误提示，此处不重复报错）
      return null;
    }
  }

  /**
   * 手动压缩上下文（P3-A）：委托会话 compact()；无 lease / 不支持时返回
   * 明确失败信息（不破坏会话历史）。
   */
  async compact(sessionId: string): Promise<CompactOutcome> {
    const lease = this.leases.get(sessionId);
    if (lease === undefined) {
      return { ok: false, message: '会话未激活，无法压缩' };
    }
    if (typeof lease.session.compact !== 'function') {
      return { ok: false, message: '当前会话不支持手动压缩' };
    }
    try {
      // pi CompactionResult 为 { summary, firstKeptEntryId, tokensBefore,
      // estimatedTokensAfter, usage, details }，不含 message 字段——详情必须从这里取，
      // 否则 UI 只能显示「压缩完成」而丢失压缩前后的 token 变化。
      const raw = await lease.session.compact();
      return { ok: true, ...extractCompactionDetails(raw) };
    } catch (err) {
      const message = err instanceof Error ? err.message : '压缩失败';
      return { ok: false, message };
    }
  }

  /**
   * 删除会话时释放运行资源（P2-D）：停止执行、dispose lease、清理内存态。
   * 幂等：未知会话无操作。磁盘文件删除由 PiSessionAdapter 负责。
   * wu-06：同时退订该会话在子 agent 扩展事件总线上的订阅，避免迟到事件误处理。
   */
  async removeSession(sessionId: string): Promise<void> {
    const unsub = this.unsubs.get(sessionId);
    if (unsub !== undefined) {
      try {
        unsub();
      } catch {}
      this.unsubs.delete(sessionId);
    }
    const subagentUnsub = this.subagentUnsubs.get(sessionId);
    if (subagentUnsub !== undefined) {
      try {
        subagentUnsub();
      } catch {}
      this.subagentUnsubs.delete(sessionId);
    }
    // wu-06：退订后清空子 agent 会话内存态（会话删除是子 agent 注销的最终时机）
    this.subagentService?.disposeSession(sessionId);
    const lease = this.leases.get(sessionId);
    if (lease !== undefined) {
      try {
        await lease.session.abort();
      } catch {
        // 停止失败不阻断删除
      }
      lease.dispose();
      this.leases.delete(sessionId);
    }
    this.callbacks.delete(sessionId);
    this.errorListeners.delete(sessionId);
    this.partialContent.delete(sessionId);
    this.livePartial.delete(sessionId);
    this.forwardedClean.delete(sessionId);
    this.transcripts.delete(sessionId);
    this.sessionFiles.delete(sessionId);
    this.leaseModels.delete(sessionId);
    this.appliedThinkingLevels.delete(sessionId);
    this.lastCompactTokensAfter.delete(sessionId);
  }

  /**
   * 委托 lease 句柄的 cross-extension-rpc stop 通道终止单个子 agent。
   * lease 缺失/无 stopSubagent 通道（扩展未激活）时抛错，上层映射 1002。
   */
  async stopSubagent(sessionId: string, agentId: string): Promise<void> {
    const lease = this.leases.get(sessionId);
    if (lease === undefined) {
      throw new Error('终止通道不可用');
    }
    const handle = (lease as PiAgentSessionLease<MinimalPiSession> & {
      handle?: { stopSubagent?: (agentId: string) => Promise<void> };
    }).handle;
    if (handle?.stopSubagent === undefined) {
      throw new Error('终止通道不可用');
    }
    await handle.stopSubagent(agentId);
  }

  /**
   * wu-06：按 lease 的扩展事件总线订阅生命周期事件，喂入 SubagentService.ingest。
   * 每个 channel 独立绑定，便于 removeSession 时统一退订；总线/服务缺失时静默跳过。
   */
  private bindSubagentBus(
    sessionId: string,
    lease: PiAgentSessionLease<MinimalPiSession>,
  ): void {
    if (this.subagentService === undefined) {
      return;
    }
    const bus = lease.events;
    if (bus === undefined) {
      return;
    }
    // 重建 lease 时退订旧订阅（适配器持有 lease 引用，旧 bus 可能被 dispose）
    const prev = this.subagentUnsubs.get(sessionId);
    if (prev !== undefined) {
      try { prev(); } catch {}
      this.subagentUnsubs.delete(sessionId);
    }
    const channels = ['subagents:created', 'subagents:started', 'subagents:completed', 'subagents:failed'];
    const offs: Array<() => void> = [];
    for (const channel of channels) {
      offs.push(
        bus.on(channel, (raw) => {
          this.subagentService!.ingest(sessionId, mapSubagentExtensionEvent(channel, raw));
        }),
      );
    }
    this.subagentUnsubs.set(sessionId, () => {
      for (const off of offs) {
        try { off(); } catch {}
      }
    });
  }

  /**
   * 刷新模型配置（provider 增删改后调用）：
   * 1. 清空模型解析缓存（下次 resolvePiModel 重读 models.json）；
   * 2. 对每个活跃会话 lease 调用底层 modelRuntime.refresh()（重读 models.json
   *    重组 providers），使新保存的 API Key 引用立即生效，无需重启会话/应用。
   * 单个会话刷新失败不影响其余（该会话下次重建时自然用新配置）。
   */
  async refreshModelConfig(): Promise<void> {
    const { clearPiModelRuntimeCache } = await import('./piModelResolver.ts');
    clearPiModelRuntimeCache();
    for (const [sessionId, lease] of this.leases) {
      const runtime = lease.session.modelRuntime;
      if (runtime === undefined || typeof runtime.refresh !== 'function') continue;
      try {
        await runtime.refresh({ allowNetwork: false });
      } catch (err) {
        console.error(`[refreshModelConfig] session ${sessionId} refresh failed`, err);
      }
    }
  }

  private handleEvent(sessionId: string, rawEvent: unknown): void {
    const event = rawEvent as MinimalPiEvent;
    const callback = this.callbacks.get(sessionId);

    // 仅转发 text_delta（thinking/toolcall 增量不进正文，避免污染回答）
    const delta =
      event.type === 'message_update' &&
      event.assistantMessageEvent?.type === 'text_delta' &&
      typeof event.assistantMessageEvent.delta === 'string'
        ? event.assistantMessageEvent.delta
        : undefined;

    if (typeof delta === 'string') {
      // 仅转发 text_delta（thinking/toolcall 增量本身已丢弃）。MiniMax 等模型会把
      // 思考以「正文混流」形式输出（thinking…response），此处对整条累计文本做
      // 展示层清洗，转发「清洗后相对已转发部分的新增增量」：思考块剥除时本次
      // 不发（"助手正在思考"占位保持可见），收尾标记一出现即一次性补发正式回答。
      const raw = `${this.partialContent.get(sessionId) ?? ''}${delta}`;
      this.partialContent.set(sessionId, raw);
      const clean = stripThinkingContent(raw);
      const prev = this.forwardedClean.get(sessionId) ?? '';
      this.forwardedClean.set(sessionId, clean);
      // 维护未完成快照（loadHistory 切回补齐用）；值为清洗后全文，与持续挂载的
      // UI 收到的内容严格一致（增量 = clean 相对 prev 的新增部分）
      this.livePartial.set(sessionId, clean);
      if (prev === clean) return;
      const inc = clean.length >= prev.length ? clean.slice(prev.length) : '';
      if (inc === '') return;
      if (callback) {
        callback.onDelta(inc);
      } else {
        this.eventHandlers.onDelta?.(sessionId, inc);
      }
      return;
    }

    if (
      event.type === 'message_end' &&
      event.message?.role === 'assistant'
    ) {
      const rawMsg: unknown = event.message as unknown;
      const stopReason = (rawMsg as { stopReason?: string }).stopReason;
      const errMsgRaw =
        (rawMsg as { errorMessage?: string }).errorMessage ??
        (rawMsg as { error?: string }).error;
      // 关键修复：stopReason === 'error' 时必须透传错误到对话框（超时/拒绝连接/鉴权失败等）
      if (stopReason === 'error') {
        const content = extractAssistantText(event.message.content);
        const raw = errMsgRaw || content || '对话处理失败';
        const message = /No API key found/i.test(raw)
          ? `模型凭据未配置（${raw}）：请在设置中为对应模型填写并保存 API Key 后重试`
          : raw;
        if (content !== '') this.partialContent.set(sessionId, content);
        this.livePartial.delete(sessionId);
        this.errorEmittedThisTurn.add(sessionId);
        this.errorListeners.get(sessionId)?.({ message });
        this.eventHandlers.onError?.(sessionId, { message });
        return;
      }
      // pi AssistantMessage.content 为内容块数组（或字符串），提取纯文本
      const content = extractAssistantText(event.message.content);
      this.forwardedClean.set(sessionId, content);
      // 消息已终态落盘：清掉进行中快照，避免 loadHistory 与文件内容重复
      this.livePartial.delete(sessionId);
      if (content !== '') {
        this.partialContent.set(sessionId, content);
        const message: ConversationMessage = {
          role: 'assistant',
          content,
          ts: new Date().toISOString(),
        };
        this.transcripts.set(sessionId, [...(this.transcripts.get(sessionId) ?? []), message]);
        if (callback) {
          callback.onMessage(message);
        } else {
          this.eventHandlers.onMessage?.(sessionId, message);
        }
      }
      return;
    }

    // 兜底：agent/turn 级错误（超时/网络拒绝等）也需透传
    if (
      (event.type === 'agent_end' || event.type === 'turn_end') &&
      typeof (event as { errorMessage?: unknown }).errorMessage === 'string' &&
      ((event as { errorMessage: string }).errorMessage.length > 0)
    ) {
      const raw = (event as { errorMessage: string }).errorMessage;
      const message = /No API key found/i.test(raw)
        ? `模型凭据未配置（${raw}）：请在设置中为对应模型填写并保存 API Key 后重试`
        : raw;
      this.errorEmittedThisTurn.add(sessionId);
      this.errorListeners.get(sessionId)?.({ message });
      this.eventHandlers.onError?.(sessionId, { message });
      return;
    }
    if (event.type === 'error') {
      const raw = event as unknown as { error?: unknown; message?: unknown };
      const rawMsg =
        typeof raw.error === 'string'
          ? raw.error
          : typeof raw.message === 'string'
            ? raw.message
            : undefined;
      if (typeof rawMsg === 'string' && rawMsg.length > 0) {
        const message = /No API key found/i.test(rawMsg)
          ? `模型凭据未配置（${rawMsg}）：请在设置中为对应模型填写并保存 API Key 后重试`
          : rawMsg;
        this.errorEmittedThisTurn.add(sessionId);
        this.errorListeners.get(sessionId)?.({ message });
        this.eventHandlers.onError?.(sessionId, { message });
        return;
      }
    }

    // pi 自动重试开始：可重试错误后 pi 内部自动重试，轮次并未终止。此前
    // message_end(stopReason=error) 已把状态打成 error（红点），这里做两件事：
    // 1) 清 errorEmittedThisTurn——重试成功后 prompt 正常返回时 hadError 必须为
    //    false，done 门控（notifyMainTurnEnd）才能照常触发，否则 done 被跳过、
    //    会话卡死到看门狗兜底；
    // 2) 通知上层恢复 streaming（红点回进行中）。
    if (event.type === 'auto_retry_start') {
      this.errorEmittedThisTurn.delete(sessionId);
      this.eventHandlers.onAutoRetryStart?.(sessionId, {
        attempt: typeof event.attempt === 'number' ? event.attempt : 0,
        maxAttempts: typeof event.maxAttempts === 'number' ? event.maxAttempts : 0,
        errorMessage: typeof event.errorMessage === 'string' ? event.errorMessage : '未知错误',
      });
      return;
    }
    // 重试耗尽：终态错误，走既有错误上报（最后一次 message_end(error) 已上报过
    // 则跳过，避免重复推送）
    if (event.type === 'auto_retry_end' && event.success === false) {
      if (!this.errorEmittedThisTurn.has(sessionId)) {
        const raw =
          typeof event.finalError === 'string' && event.finalError !== ''
            ? event.finalError
            : '对话处理失败';
        const message = /No API key found/i.test(raw)
          ? `模型凭据未配置（${raw}）：请在设置中为对应模型填写并保存 API Key 后重试`
          : raw;
        this.errorEmittedThisTurn.add(sessionId);
        this.errorListeners.get(sessionId)?.({ message });
        this.eventHandlers.onError?.(sessionId, { message });
      }
      return;
    }

    // 上下文压缩开始（P3-A）：转发 UI 锁定输入框 / 显示"正在压缩"横幅；
    // pi reason（manual / threshold / overflow）归一为 manual / auto
    if (event.type === 'compaction_start') {
      this.eventHandlers.onCompacting?.(sessionId, {
        reason: event.reason === 'manual' ? 'manual' : 'auto',
      });
      return;
    }

    // 上下文压缩收敛（P3-A）：手动与自动压缩都在此汇合。自动压缩（reason 为
    // threshold / overflow）没有 RPC 入口，UI 只能靠本回调感知——否则历史被摘要
    // 替换却毫无提示；压缩失败必须上报，不能静默。
    if (event.type === 'compaction_end') {
      const failure =
        typeof event.errorMessage === 'string' && event.errorMessage.length > 0
          ? event.errorMessage
          : undefined;
      if (failure !== undefined) {
        this.errorEmittedThisTurn.add(sessionId);
        this.errorListeners.get(sessionId)?.({ message: failure });
        this.eventHandlers.onError?.(sessionId, { message: failure });
        return;
      }
      // 被中止（用户取消 / 无可压缩内容）既不算完成也不算错误
      if (event.aborted === true || !isRecord(event.result)) return;
      const info = normalizeCompactionInfo(event.reason, event.result);
      // 记录压缩后估算 token：pi 在压缩边界之后无新 assistant 用量时返回 null
      // 用量，据此合成"压缩后百分比"（否则 UI 只能显示"? tokens"）
      if (typeof info.tokensAfter === 'number') {
        this.lastCompactTokensAfter.set(sessionId, info.tokensAfter);
      }
      this.eventHandlers.onCompacted?.(sessionId, info);
      return;
    }

    if (event.type === 'tool_execution_start' && typeof event.toolCallId === 'string') {
      this.eventHandlers.onToolStarted?.(sessionId, {
        toolEventId: event.toolCallId,
        tool: {
          name: typeof event.toolName === 'string' ? event.toolName : 'unknown',
          input: isRecord(event.args) ? event.args : {},
        },
      });
      return;
    }

    if (event.type === 'tool_execution_end' && typeof event.toolCallId === 'string') {
      const text = extractToolResultText(event.result);
      if (event.isError === true) {
        this.eventHandlers.onToolError?.(sessionId, {
          toolEventId: event.toolCallId,
          error: { message: text ?? '工具执行失败' },
        });
      } else {
        this.eventHandlers.onToolCompleted?.(sessionId, {
          toolEventId: event.toolCallId,
          result: { text, image: null },
        });
      }
    }
  }
}

/** 类型守卫：对象（含数组） */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 从 pi 压缩载荷提取展示用详情。
 * pi CompactionResult 形如 `{ summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter,
 * usage, details }`；缺失字段归一为 null，避免 UI 出现 undefined。
 */
function extractCompactionDetails(raw: unknown): {
  tokensBefore: number | null;
  tokensAfter: number | null;
  summary: string | null;
} {
  if (!isRecord(raw)) return { tokensBefore: null, tokensAfter: null, summary: null };
  return {
    tokensBefore: typeof raw.tokensBefore === 'number' ? raw.tokensBefore : null,
    tokensAfter: typeof raw.estimatedTokensAfter === 'number' ? raw.estimatedTokensAfter : null,
    summary: typeof raw.summary === 'string' ? raw.summary : null,
  };
}

/**
 * 归一化 pi `compaction_end` 载荷为 CompactionInfo。
 * @param reason pi 触发原因：manual / threshold / overflow；非 manual 一律归为 auto
 * @param result pi CompactionResult
 */
function normalizeCompactionInfo(reason: string | undefined, result: unknown): CompactionInfo {
  return {
    reason: reason === 'manual' ? 'manual' : 'auto',
    ...extractCompactionDetails(result),
  };
}

/**
 * 从 pi assistant 消息 content 提取纯文本（字符串透传；块数组取 type==='text'
 * 的 text 拼接），并按需要剥离混入正文的 thinking/reasoning 包裹块（兜底展示过滤）。
 */
function extractAssistantText(content: unknown): string {
  const raw =
    typeof content === 'string'
      ? content
      : Array.isArray(content)
        ? content
            .map((part) =>
              isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
            )
            .join('')
        : '';
  return stripThinkingContent(raw);
}

/** 从 pi 工具结果提取文本（content[].text 拼接；空内容返回 null） */
function extractToolResultText(result: unknown): string | null {
  if (typeof result === 'string') {
    return result === '' ? null : result;
  }
  if (!isRecord(result)) {
    return null;
  }
  const content = result.content;
  if (!Array.isArray(content)) {
    return null;
  }
  const text = content
    .map((part) => (isRecord(part) && typeof part.text === 'string' ? part.text : ''))
    .filter((t) => t !== '')
    .join('\n');
  return text === '' ? null : text;
}

/**
 * 映射 pi-subagents 扩展事件 → SubagentService.ingest 入参（wu-06）。
 * - subagents:created → status='queued'（首次建档）
 * - subagents:started → status='running'（推进状态机）
 * - subagents:completed → status='completed' + result + usage（按 tokens 转换）
 * - subagents:failed：按 payload.status 子状态映射：
 *   error → 'failed'；stopped/aborted → 'stopped'（统一终态语义）
 */
function mapSubagentExtensionEvent(
  channel: string,
  raw: unknown,
): SubagentAdapterEvent {
  const payload = (raw ?? {}) as {
    id?: unknown;
    type?: unknown;
    description?: unknown;
    status?: unknown;
    result?: unknown;
    error?: unknown;
    tokens?: unknown;
  };
  const agentId = typeof payload.id === 'string' && payload.id !== '' ? payload.id : '';
  const agentType = typeof payload.type === 'string' ? payload.type : undefined;
  const description = typeof payload.description === 'string' ? payload.description : undefined;
  const errorMessage = typeof payload.error === 'string' && payload.error !== '' ? payload.error : undefined;
  const resultText = typeof payload.result === 'string' && payload.result !== '' ? payload.result : undefined;
  let status: SubagentAdapterEvent['status'];
  if (channel === 'subagents:created') {
    status = 'queued';
  } else if (channel === 'subagents:started') {
    status = 'running';
  } else if (channel === 'subagents:completed') {
    status = 'completed';
  } else {
    // subagents:failed（status: error/stopped/aborted → 映射为失败/停止）
    const subStatus = typeof payload.status === 'string' ? payload.status : 'error';
    status = subStatus === 'stopped' || subStatus === 'aborted' ? 'stopped' : 'failed';
  }
  const event: SubagentAdapterEvent = {
    agentId,
    status,
  };
  if (agentType !== undefined) event.agentType = agentType;
  if (description !== undefined) event.description = description;
  if (resultText !== undefined) event.result = resultText;
  if (errorMessage !== undefined) event.error = errorMessage;
  if (isRecord(payload.tokens)) {
    const t = payload.tokens as { input?: unknown; output?: unknown };
    if (typeof t.input === 'number' && typeof t.output === 'number') {
      event.usage = { inputTokens: t.input, outputTokens: t.output };
    }
  }
  return event;
}
