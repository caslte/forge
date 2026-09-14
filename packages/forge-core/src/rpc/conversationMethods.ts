/**
 * 对话与消息 RPC 方法层（wu-03-rpc）。
 *
 * 职责：把 ConversationService 的业务方法包装为传输无关的方法映射（method -> handler），
 * 统一返回 `{ code, message, data }` 信封（docs/api/index.md 响应格式），供任意传输
 * 层（Electron IPC / headless HTTP）直接调用。本模块是纯 Node，不 import
 * Electron / Vue / pi。
 *
 * 设计决策：
 * 1. 信封格式：成功 `{ code: 0, message: "success", data }`；失败 `{ code, message,
 *    data: null }`。错误码与 docs/api/03_conversation.md §5 一致：1001 参数错误 /
 *    1002 会话不存在 / 1004 provider 未配置 / 5000 内部错误。
 * 2. 参数校验：每个 handler 先校验 params（sessionId/content 必须为非空字符串），
 *    非法输入直接返回 1001，不进入服务层。
 * 3. 异常隔离：服务层意外抛错（如 adapter 异常）被捕获并返回 5000，不向调用方
 *    泄漏异常细节；错误日志用英文 + `[方法名]` 前缀（docs/specs/common/coding-style.md）。
 * 4. 事件：conversation.statusChanged 在 sendMessage 成功后发射（取服务层当前状态）；
 *    conversation.delta / conversation.message / conversation.error 由本层公开方法
 *    pushDelta / emitMessage / emitError 驱动 —— v1 无真实流式来源，UI 层 / 后续模块
 *    直接调用这些公开方法模拟流式推送（文档化流式接缝）。事件汇（EventSink）为
 *    EventEmitter 兼容接口（仅需 emit），默认使用 node:events EventEmitter；调用方
 *    可注入自定义汇（如跨进程转发）。
 * 5. 异步方法统一经 call 包装，返回 Promise<RpcResult>；方法映射签名兼容同步/异步
 *    handler。
 */

import { EventEmitter } from 'node:events';
import type { RpcResult, EventSink } from './projectMethods.ts';
import type {
  ConversationService,
  ConversationResult,
  ConversationStatus,
  ConversationMessage,
  ConversationDelta,
  CompactReason,
  ConversationCompactingPayload,
  ConversationCompactedPayload,
  GetSlashCommandsParams,
  AskUserQuestionRequestPayload,
  AskUserQuestionReplyParams,
  AskUserQuestionAnswer,
} from '../conversation/conversationService.ts';

/** 构造成功信封 */
function ok<T>(data: T): RpcResult<T> {
  return { code: 0, message: 'success', data };
}

/** 构造失败信封（data 恒为 null） */
function fail(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/** 类型守卫：params 是否为普通对象 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 从 params 中取非空字符串参数。
 * @param params 请求参数（未知类型，来自传输层）
 * @param key 参数名
 * @returns 非空字符串；缺失/非字符串/空白返回 null
 */
function requireString(params: unknown, key: string): string | null {
  if (!isRecord(params)) {
    return null;
  }
  const value = params[key];
  if (typeof value !== 'string' || value.trim() === '') {
    return null;
  }
  return value;
}

/**
 * 对话与消息 RPC 方法层：方法映射 + 事件发射。
 * @param service ConversationService 业务实例
 * @param events 事件汇（默认新建 EventEmitter；可注入自定义汇）
 */
export class ConversationApi {
  /** 方法映射：方法名 -> handler(params) -> 统一信封（可同步/异步） */
  readonly methods: Record<string, (params: unknown) => RpcResult | Promise<RpcResult>>;
  /** 事件汇：conversation.statusChanged / conversation.delta / conversation.message / conversation.error 在此发射 */
  readonly events: EventSink;
  private readonly service: ConversationService;

  constructor(service: ConversationService, events?: EventSink) {
    this.service = service;
    this.events = events ?? new EventEmitter();
    this.methods = {
      'conversation/sendMessage': (params) => this.sendMessage(params),
      'conversation/cancelStream': (params) => this.cancelStream(params),
      'conversation/queryHistory': (params) => this.queryHistory(params),
      'conversation/getLastError': (params) => this.getLastError(params),
      'conversation/getContextUsage': (params) => this.getContextUsage(params),
      'conversation/compact': (params) => this.compact(params),
      'conversation/getSlashCommands': (params) => this.getSlashCommands(params),
      // Path 2 ask_user_question 回填：renderer → main 只能走方法调用（不是事件），
      // 故必须落在这里（契约 §4.2.1 ③）。
      'askUserQuestion/reply': (params) => this.replyAskUserQuestion(params),
    };
  }

  /**
   * 通用调用包装：执行服务方法并映射为信封；意外异常捕获为 5000。
   * @param method 方法名（日志前缀）
   * @param fn 服务调用（同步或异步）
   * @returns 统一信封
   */
  private async call<T>(
    method: string,
    fn: () => ConversationResult<T> | Promise<ConversationResult<T>>,
  ): Promise<RpcResult> {
    try {
      const result = await fn();
      if (result.ok) {
        return ok(result.data);
      }
      return fail(result.code, result.message);
    } catch (err) {
      console.error(`[${method}] internal error`, err);
      return fail(5000, 'internal error');
    }
  }

  /** conversation/sendMessage：发送消息（CV-S01），成功后发射 conversation.statusChanged */
  private async sendMessage(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    const content = requireString(params, 'content');
    if (content === null) {
      return fail(1001, '参数错误：content 必须为非空字符串');
    }
    const options: Record<string, unknown> = {};
    if (typeof params === 'object' && params !== null && 'projectPath' in params) {
      const projectPath = (params as { projectPath?: unknown }).projectPath;
      if (typeof projectPath === 'string' && projectPath.trim() !== '') {
        options.cwd = projectPath;
      }
    }
    if (typeof params === 'object' && params !== null && 'model' in params) {
      const model = (params as { model?: unknown }).model;
      if (typeof model === 'string' && model.trim() !== '') {
        options.model = model;
      }
    }
    // 附件统一给路径：路径行已随 content 由 UI 拼好，此处不再读取/拼接任何附件参数

    // CV-S09：忙时发送 = 入队（service 内部分流），不推 statusChanged——
    // 入队不改变在途轮次状态，重推 streaming 会重置 UI 的流式读秒/阶段显示
    const wasStreaming = this.service.getStatus(sessionId) === 'streaming';
    const result = await this.call('sendMessage', () =>
      this.service.sendMessage(sessionId, content, options),
    );
    if (result.code === 0 && !wasStreaming) {
      this.pushStatus(sessionId, this.service.getStatus(sessionId));
    }
    return result;
  }

  /** conversation/cancelStream：取消当前处理（CV-S04），幂等 */
  private cancelStream(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('cancelStream', () => this.service.cancelStream(sessionId));
  }

  /** conversation/queryHistory：查询消息历史（CV-S05），按 ts 升序 */
  private queryHistory(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('queryHistory', () => this.service.queryHistory(sessionId));
  }

  /**
   * conversation/getLastError：查询会话最近一次轮次错误信息。
   * 前端 errorMsg 横幅是瞬态内存态，切走再切回/后台会话出错后丢失；红点
   * （session.status='error'）持久——切到 error 会话时经本方法拉取横幅数据。
   * 无错误记录返回 message=null（不报错）。
   */
  private getLastError(params: unknown): RpcResult {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return fail(1001, '参数错误：sessionId 必须为非空字符串');
    }
    return ok({ message: this.service.getLastError(sessionId) });
  }

  /** conversation/getContextUsage：查询上下文用量（P3-A，CV-S06） */
  private getContextUsage(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('getContextUsage', () => this.service.getContextUsage(sessionId));
  }

  /** conversation/compact：手动压缩上下文（P3-A，CV-S07） */
  private compact(params: unknown): Promise<RpcResult> {
    const sessionId = requireString(params, 'sessionId');
    if (sessionId === null) {
      return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
    }
    return this.call('compact', () => this.service.compact(sessionId));
  }

  /**
   * conversation/getSlashCommands：查询斜杠命令清单（扩展 CV-S08，A-CV-011/012）。
   * sessionId/projectPath 均可选——省略 sessionId 为草稿态查询；资源查询失败在
   * 服务层降级为空清单（code 0），仅参数非法（1001）与未知会话（1002）报错。
   */
  private getSlashCommands(params: unknown): Promise<RpcResult> {
    const request: GetSlashCommandsParams = {};
    if (isRecord(params)) {
      const sessionId = params.sessionId;
      if (sessionId !== undefined) {
        if (typeof sessionId !== 'string' || sessionId.trim() === '') {
          return Promise.resolve(fail(1001, '参数错误：sessionId 必须为非空字符串'));
        }
        request.sessionId = sessionId;
      }
      const projectPath = params.projectPath;
      if (projectPath !== undefined) {
        if (typeof projectPath !== 'string') {
          return Promise.resolve(fail(1001, '参数错误：projectPath 必须为字符串'));
        }
        if (projectPath.trim() !== '') {
          request.projectPath = projectPath;
        }
      }
    }
    return this.call('getSlashCommands', () => this.service.getSlashCommands(request));
  }

  /**
   * askUserQuestion/reply：问卷回填（Path 2，契约 §4.2.1 ③ / §4.4 ③）。
   * renderer→main 只能是方法调用，故本方法是问卷作答的唯一上行入口。
   * 参数校验交给服务层（1001/1002），异常捕获为 5000；
   * `delivered=false` 属正常降级（会话无 lease），仍返回 code 0。
   */
  private replyAskUserQuestion(params: unknown): Promise<RpcResult> {
    const request: AskUserQuestionReplyParams = {
      sessionId: (isRecord(params) ? params.sessionId : undefined) as string,
      requestId: (isRecord(params) ? params.requestId : undefined) as string,
      answers: (isRecord(params) ? params.answers : undefined) as AskUserQuestionAnswer[],
      cancelled: (isRecord(params) ? params.cancelled : undefined) as boolean,
    };
    if (isRecord(params) && typeof params.globalNote === 'string') {
      request.globalNote = params.globalNote;
    }
    return this.call('askUserQuestion/reply', () => this.service.replyAskUserQuestion(request));
  }

  /**
   * 会话状态驱动（非 RPC 方法）：发射 conversation.statusChanged。
   * 供 sendMessage 成功后自动调用，也供 UI 层 / 测试直接驱动状态流转。
   * @param sessionId 会话 ID
   * @param status 目标状态（idle/streaming/done/canceled/error）
   * @returns 无返回值；触发事件 conversation.statusChanged { sessionId, status }
   */
  pushStatus(sessionId: string, status: ConversationStatus): void {
    this.events.emit('conversation.statusChanged', { sessionId, status });
  }

  /**
   * 流式增量推送（非 RPC 方法）：发射 conversation.delta。
   * v1 无真实流式来源，由 UI 层 / 后续模块直接驱动以模拟流式推送。
   * @param sessionId 会话 ID
   * @param text 增量文本
   * @returns 无返回值；触发事件 conversation.delta { sessionId, delta: { text, kind: 'text' } }
   */
  pushDelta(sessionId: string, text: string): void {
    const delta: ConversationDelta = { text, kind: 'text' };
    this.events.emit('conversation.delta', { sessionId, delta });
  }

  /**
   * 完整消息推送（非 RPC 方法）：发射 conversation.message。
   * @param sessionId 会话 ID
   * @param message 完整消息（assistant 或 user）
   * @returns 无返回值；触发事件 conversation.message { sessionId, message }
   */
  emitMessage(sessionId: string, message: ConversationMessage): void {
    this.events.emit('conversation.message', { sessionId, message });
  }

  /**
   * 队列变更推送（非 RPC 方法，CV-S09）：发射 conversation.queueUpdated。
   * pi followUp 队列每次变化（入队/派发/清空）全量推送当前待发文本列表，
   * UI 据此渲染输入框上方的待发送徽标/浮窗。
   * @param sessionId 会话 ID
   * @param followUp 当前待发队列文本（FIFO 序，[0] 最先派发）
   * @returns 无返回值；触发事件 conversation.queueUpdated { sessionId, followUp }
   */
  emitQueueUpdated(sessionId: string, followUp: string[]): void {
    this.events.emit('conversation.queueUpdated', { sessionId, followUp });
  }

  /**
   * 错误推送（非 RPC 方法）：发射 conversation.error。
   * @param sessionId 会话 ID
   * @param code 错误码（如 5000）
   * @param message 错误信息
   * @returns 无返回值；触发事件 conversation.error { sessionId, code, message }
   */
  emitError(sessionId: string, code: number, message: string): void {
    this.events.emit('conversation.error', { sessionId, code, message });
  }

  /**
   * 压缩开始推送（非 RPC 方法）：发射 conversation.compacting。
   * 手动与自动压缩开始都经此通知 UI——锁定输入框并显示"正在压缩"横幅。
   * @param sessionId 会话 ID
   * @param reason 触发来源（manual / auto）
   * @returns 无返回值；触发事件 conversation.compacting { sessionId, reason }
   */
  emitCompacting(sessionId: string, reason: CompactReason): void {
    const payload: ConversationCompactingPayload = { sessionId, reason };
    this.events.emit('conversation.compacting', payload);
  }

  /**
   * 压缩完成推送（非 RPC 方法）：发射 conversation.compacted。
   * 手动与自动压缩都经此通知 UI——自动压缩（运行时按阈值/溢出触发）没有 RPC 入口，
   * UI 只能靠本事件感知并重拉历史，否则会看到历史被摘要替换却毫无提示。
   * @param sessionId 会话 ID
   * @param info 压缩详情（触发来源 + 压缩前后 token 数 + 摘要）
   * @returns 无返回值；触发事件 conversation.compacted { sessionId, reason, tokensBefore, tokensAfter, summary }
   */
  emitCompacted(sessionId: string, info: Omit<ConversationCompactedPayload, 'sessionId'>): void {
    const payload: ConversationCompactedPayload = { sessionId, ...info };
    this.events.emit('conversation.compacted', payload);
  }

  /**
   * 斜杠命令清单更新推送（非 RPC 方法，扩展 CV-S08）：发射
   * conversation.slashCommandsUpdated。命令上报扩展的上报到达 forge（desktop
   * 桥接 channel）后，desktop 层先调 service.ingestReportedCommands 更新会话缓存，
   * 再经此转发事件——UI 收到后失效该会话缓存、下次触发浮窗重拉（AC-CV-032）。
   * @param sessionId 会话 ID
   * @returns 无返回值；触发事件 conversation.slashCommandsUpdated { sessionId }
   */
  emitSlashCommandsUpdated(sessionId: string): void {
    this.events.emit('conversation.slashCommandsUpdated', { sessionId });
  }

  /**
   * 问卷请求推送（非 RPC 方法，Path 2 ask_user_question）：发射
   * conversation.askUserQuestionRequested。模型调用 ask_user_question 后，扩展经
   * 会话事件总线投递问卷，desktop 桥接层按会话订阅并补齐 sessionId，再经此转发
   * 渲染进程——UI 在**发起会话所属窗格**内渲染面板（契约 §4.4 会话隔离）。
   * @param payload 问卷请求载荷（sessionId + requestId + questions + timeoutMs）
   * @returns 无返回值；触发事件 conversation.askUserQuestionRequested
   */
  emitAskUserQuestionRequested(payload: AskUserQuestionRequestPayload): void {
    this.events.emit('conversation.askUserQuestionRequested', payload);
  }
}

/**
 * 创建 ConversationApi 实例（工厂）。
 * @param service 对话与消息业务服务
 * @param events 事件汇（可选，默认新建 EventEmitter）
 * @returns ConversationApi 实例
 */
export function createConversationApi(service: ConversationService, events?: EventSink): ConversationApi {
  return new ConversationApi(service, events);
}
