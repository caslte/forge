import type { AgentSession } from '@earendil-works/pi-coding-agent';
import type { ConversationAttachment, ConversationMessage } from '@forge/core';

export interface PiAgentSessionLease<TSession> {
  session: TSession;
  dispose: () => void;
}

export interface PiAgentSessionFactoryOptions {
  sessionId?: string;
  cwd?: string;
  /** forge 模型 ID 字符串，或已解析的 pi Model 对象（热切换时由适配器解析后传入） */
  model?: unknown;
  /** 附件（P3-B）：与 core ConversationAttachment 结构一致，adapter 转 pi image content */
  attachments?: ConversationAttachment[];
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
  /**
   * 模型运行时刷新（provider 配置变更用）：重读 models.json 重组 providers，
   * 使已保存的 API Key 引用立即生效；真实 AgentSession 经 modelRuntime 暴露。
   */
  modelRuntime?: { refresh(options?: unknown): Promise<unknown> };
};

/** pi 图片附件最小结构（真实 ImageContent 兼容：{ type:'image', data, mimeType }） */
export type MinimalImageContent = {
  type: 'image';
  data: string;
  mimeType: string;
};

/** 适配器构造选项（模型解析器可注入；缺省走真实 pi models.json 解析） */
export interface PiConversationAdapterOptions {
  resolveModel?: (model: string) => Promise<unknown>;
  /**
   * 由 forge sessionId 定位 pi 会话文件（P2-D 重启恢复）：
   * 重启后内存 sessionFiles 为空，命中磁盘 JSONL 时据此恢复历史。
   */
  resolveSessionFile?: (sessionId: string) => string | undefined;
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
  onToolStarted?: (sessionId: string, event: PiToolStartedPayload) => void;
  onToolCompleted?: (sessionId: string, event: PiToolCompletedPayload) => void;
  onToolError?: (sessionId: string, event: PiToolErrorPayload) => void;
}

type TurnCompletionHandler = (sessionId: string) => void;

type MinimalPiEvent = {
  type: string;
  message?: {
    role?: string;
    /** pi AssistantMessage.content：字符串或内容块数组（{type:'text',text}） */
    content?: string | Array<{ type?: string; text?: string }>;
  };
  /** pi AssistantMessageEvent：仅 text_delta 携带文本增量 */
  assistantMessageEvent?: { type?: string; delta?: string };
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
};

export class PiConversationAdapter {  private readonly leases = new Map<string, PiAgentSessionLease<MinimalPiSession>>();
  private readonly callbacks = new Map<string, SessionCallbacks>();
  private readonly partialContent = new Map<string, string>();
  private readonly errorListeners = new Map<string, (error: PiConversationError) => void>();
  private readonly sessionFiles = new Map<string, string>();
  /** 内存会话记录（无 pi session 文件时的历史回退，含 user 与 assistant） */
  private readonly transcripts = new Map<string, ConversationMessage[]>();
  /** 会话当前生效模型字符串（热切换差异比较用） */
  private readonly leaseModels = new Map<string, string | undefined>();
  /** 每会话在底层 AgentSession 上的单次订阅取消函数（防重复订阅） */
  private readonly unsubs = new Map<string, () => void>();
  private eventHandlers: PiConversationEventHandlers = {};
  private completionHandler: TurnCompletionHandler | undefined;

  private readonly factory: PiAgentSessionFactory<MinimalPiSession>;
  private readonly resolveModel: (model: string) => Promise<unknown>;
  private readonly resolveSessionFile: ((sessionId: string) => string | undefined) | undefined;

  constructor(
    factory: PiAgentSessionFactory<MinimalPiSession>,
    options: PiConversationAdapterOptions = {},
  ) {
    this.factory = factory;
    this.resolveSessionFile = options.resolveSessionFile;
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
    this.transcripts.set(sessionId, [
      ...(this.transcripts.get(sessionId) ?? []),
      { role: 'user', content, ts: new Date().toISOString() },
    ]);
    const handle = (lease as PiAgentSessionLease<MinimalPiSession> & {
      handle?: { sessionFile?: string };
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
    try {
      // P3-B：附件图片随 prompt 透传（pi prompt 第二参为 PromptOptions.images）
      const images = normalizeImages(options.attachments);
      if (images.length > 0) {
        await lease.session.prompt(content, { images });
      } else {
        await lease.session.prompt(content);
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      // 保留 pi 原始错误的 provider 名（便于定位是哪条配置缺凭据）
      const message = /No API key found/i.test(error.message)
        ? `模型凭据未配置（${error.message}）：请在设置中为对应模型填写并保存 API Key 后重试`
        : error.message;
      this.errorListeners.get(sessionId)?.({ message });
      this.eventHandlers.onError?.(sessionId, { message });
      throw new Error(message);
    }

    this.completionHandler?.(sessionId);
  }

  async cancelStream(sessionId: string): Promise<void> {
    await this.leases.get(sessionId)?.session.abort();
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
      return await loadPiSessionHistory(sessionFile);
    }
    const messages = [...(this.transcripts.get(sessionId) ?? [])];
    if (!messages.some((message) => message.role === 'assistant')) {
      const content = this.partialContent.get(sessionId);
      if (content) {
        messages.push({ role: 'assistant', content, ts: new Date().toISOString() });
      }
    }
    return messages;
  }

  /**
   * 查询会话上下文用量（P3-A）：委托会话 getContextUsage()；无 lease / 不支持时
   * 返回 null（UI 显示未知，不报错）。
   */
  getContextUsage(
    sessionId: string,
  ): { tokens: number | null; contextWindow: number; percent: number | null } | null {
    const lease = this.leases.get(sessionId);
    if (lease === undefined || typeof lease.session.getContextUsage !== 'function') {
      return null;
    }
    const raw = lease.session.getContextUsage();
    if (raw === null || raw === undefined) return null;
    const usage = raw as { tokens?: number | null; contextWindow?: number; percent?: number | null };
    return {
      tokens: typeof usage.tokens === 'number' ? usage.tokens : null,
      contextWindow: typeof usage.contextWindow === 'number' ? usage.contextWindow : 0,
      percent: typeof usage.percent === 'number' ? usage.percent : null,
    };
  }

  /**
   * 手动压缩上下文（P3-A）：委托会话 compact()；无 lease / 不支持时返回
   * 明确失败信息（不破坏会话历史）。
   */
  async compact(sessionId: string): Promise<{ ok: boolean; message?: string }> {
    const lease = this.leases.get(sessionId);
    if (lease === undefined) {
      return { ok: false, message: '会话未激活，无法压缩' };
    }
    if (typeof lease.session.compact !== 'function') {
      return { ok: false, message: '当前会话不支持手动压缩' };
    }
    try {
      const result = (await lease.session.compact()) as { message?: string } | undefined;
      return { ok: true, message: result?.message };
    } catch (err) {
      const message = err instanceof Error ? err.message : '压缩失败';
      return { ok: false, message };
    }
  }

  /**
   * 删除会话时释放运行资源（P2-D）：停止执行、dispose lease、清理内存态。
   * 幂等：未知会话无操作。磁盘文件删除由 PiSessionAdapter 负责。
   */
  async removeSession(sessionId: string): Promise<void> {
    const unsub = this.unsubs.get(sessionId);
    if (unsub !== undefined) {
      try {
        unsub();
      } catch {}
      this.unsubs.delete(sessionId);
    }
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
    this.transcripts.delete(sessionId);
    this.sessionFiles.delete(sessionId);
    this.leaseModels.delete(sessionId);
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
      this.partialContent.set(sessionId, `${this.partialContent.get(sessionId) ?? ''}${delta}`);
      if (callback) {
        callback.onDelta(delta);
      } else {
        this.eventHandlers.onDelta?.(sessionId, delta);
      }
      return;
    }

    if (
      event.type === 'message_end' &&
      event.message?.role === 'assistant'
    ) {
      // pi AssistantMessage.content 为内容块数组（或字符串），提取纯文本
      const content = extractAssistantText(event.message.content);
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

/** 从 pi assistant 消息 content 提取纯文本（字符串透传；块数组取 type==='text' 的 text 拼接） */
function extractAssistantText(content: unknown): string {
  if (typeof content === 'string') {
    return content;
  }
  if (Array.isArray(content)) {
    return content
      .map((part) =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string' ? part.text : '',
      )
      .join('');
  }
  return '';
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

/** 从附件中提取图片内容（P3-B）：仅 kind=image 的附件转 pi image content */
function normalizeImages(
  attachments: ConversationAttachment[] | undefined,
): MinimalImageContent[] {
  if (!Array.isArray(attachments)) {
    return [];
  }
  return attachments
    .filter((a): a is { kind: 'image'; name: string; mimeType: string; data: string } => a.kind === 'image')
    .map((a) => ({
      type: 'image' as const,
      data: a.data,
      mimeType: a.mimeType,
    }))
    .filter((a) => a.data.length > 0);
}
