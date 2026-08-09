/**
 * 对话与消息服务（wu-03-conversation-service）。
 *
 * 职责：实现 docs/api/03_conversation.md 的对话方法契约（sendMessage /
 * cancelStream / queryHistory / getStatus / setStatus），是 forge-core 纯 Node
 * 业务层，不 import Electron / Vue / pi —— pi 会话消息操作经构造注入的
 * PiConversationAdapter 适配器完成，测试注入 mock。
 *
 * 设计决策：
 * 1. 错误码映射（docs/api/03_conversation.md §5）：
 *    - 1001 参数错误：消息内容为空 / 会话 ID 为空。
 *    - 1002 会话不存在：注入的 sessionExists 校验失败。
 *    - 1004 provider 未配置：注入的 providerReady 校验失败。
 *    - 5000 内部错误：queryHistory 将 adapter 异常捕获为 5000 错误联合（rpc 层
 *      透传）；sendMessage / cancelStream 的 adapter 异常向上抛出，由 rpc 层统一
 *      映射 5000（与 sessionService「adapter 异常向上抛」一致，本服务不吞异常）。
 * 2. 会话执行状态（docs/api/03_conversation.md §3 statusChanged）：
 *    idle / streaming / done / canceled / error，存于内存表 streamStates
 *    （Map<sessionId, { status, lastDeltaText? }>），默认 idle。多会话并行
 *    （TD-CV-01）：各会话独立状态键，无模块级可变会话数据。
 * 3. 取消语义（TD-CV-03）：cancelStream 仅当状态为 streaming 时调用 adapter
 *    cancelStream 并置为 canceled；非 streaming 取消为幂等成功（重复取消无副作用）。
 *    已生成内容保留：lastDeltaText 在取消时不清空（内存累积文本，取消不丢弃）。
 * 4. 事件接线：本层不发射事件（事件接线在 rpc 层），通过构造选项暴露
 *    onStatusChange / onDelta 注入回调，rpc 层将其接到 IPC 事件。本 WU 无流式
 *    增量来源，onDelta 为预留注入点。
 * 5. 会话存在性 / provider 就绪：由上层注入 sessionExists / providerReady 解析器
 *    （会话存储与 provider 在其它层）；未注入时跳过对应校验（视为通过）。
 * 6. 所有方法返回判别联合 `{ ok: true, data } | { ok: false, code, message }`，
 *    调用方无需 try/catch 即可映射错误码。
 */

/** 会话执行状态（docs/api/03_conversation.md §5：streaming/done/canceled/error，加 idle 默认态） */
export type ConversationStatus = 'idle' | 'streaming' | 'done' | 'canceled' | 'error';

/** 消息角色（docs/prd/03_conversation.md §3.1：user/assistant/tool） */
export type ConversationRole = 'user' | 'assistant' | 'tool';

/**
 * 消息（复用 pi session 消息，forge 不重造消息存储）。
 * @param role 消息角色
 * @param content 消息内容（原始 markdown 字符串，渲染由前端白名单完成）
 * @param ts 时间戳（ISO8601，历史排序键）
 * @param id 可选消息 ID
 */
export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  ts: string;
  id?: string;
}

/** 流式增量（docs/api/03_conversation.md §3 conversation.delta：kind=text） */
export interface ConversationDelta {
  text: string;
  kind: 'text';
}

/**
 * pi 会话适配器（可注入 mock）。
 * 隔离 pi 会话消息操作，服务层不直接 import pi。
 * @param sendMessage 向 pi session 追加用户消息并触发处理
 * @param loadHistory 从 pi session JSONL 全量加载消息历史
 * @param cancelStream 停止当前处理，保留已生成内容
 */
export interface PiConversationAdapter {
  sendMessage(sessionId: string, content: string): Promise<void>;
  loadHistory(sessionId: string): Promise<ConversationMessage[]>;
  cancelStream(sessionId: string): Promise<void>;
}

/** 会话流式状态（每会话内存态，含内存累积文本） */
export interface StreamState {
  status: ConversationStatus;
  /** 流式增量累积文本（取消/中断时保留，不丢弃已生成内容） */
  lastDeltaText?: string;
}

/** 状态驱动选项（setStatus 内部辅助：携带/清空增量累积文本） */
export interface ConversationStatusOptions {
  /** 增量累积文本；提供该选项时按值设置（undefined 清空），省略时保持当前值 */
  lastDeltaText?: string;
}

/** 服务构造选项（校验解析器 + 事件回调注入点） */
export interface ConversationServiceOptions {
  /** 会话存在性校验（未注入则跳过校验） */
  sessionExists?: (sessionId: string) => boolean;
  /** provider 就绪校验（未注入视为已配置） */
  providerReady?: () => boolean;
  /** 状态变化回调（rpc 层接到 conversation.statusChanged 事件） */
  onStatusChange?: (sessionId: string, status: ConversationStatus) => void;
  /** 流式增量回调（预留注入点；本 WU 无增量来源，rpc 层接线用） */
  onDelta?: (sessionId: string, delta: ConversationDelta) => void;
}

/**
 * 通用方法结果（判别联合）。
 * - `{ ok: true, data }`：成功
 * - `{ ok: false, code, message }`：失败，code 为 API 错误码（1001/1002/1004/5000）
 */
export type ConversationResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: 1001 | 1002 | 1004 | 5000; message: string };

/**
 * 对话与消息服务：发送/取消/历史查询/状态，消费注入的 pi 适配器。
 * @param adapter pi 会话适配器（测试注入 mock，生产注入真实 pi 实现）
 * @param options 构造选项（会话存在性 / provider 就绪 / 事件回调注入点）
 */
export class ConversationService {
  private readonly adapter: PiConversationAdapter;
  private readonly options: ConversationServiceOptions;
  /** 会话流式状态表（sessionId -> StreamState），默认 idle；无模块级可变会话数据 */
  private readonly streamStates: Map<string, StreamState> = new Map();

  constructor(adapter: PiConversationAdapter, options: ConversationServiceOptions = {}) {
    this.adapter = adapter;
    this.options = options;
  }

  /**
   * 发送消息（CV-S01）：校验消息非空 / 会话存在 / provider 就绪 → adapter 追加
   * 用户消息并触发处理 → 进入 streaming。
   * @param sessionId 会话 ID
   * @param content 消息内容（非空）
   * @returns 成功返回 null；消息为空 / 会话 ID 为空返回 1001；会话不存在返回 1002；
   *          provider 未配置返回 1004；adapter 异常向上抛出（rpc 层映射 5000）
   */
  async sendMessage(sessionId: string, content: string): Promise<ConversationResult<null>> {
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, code: 1001, message: '消息不能为空' };
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.options.sessionExists !== undefined && !this.options.sessionExists(sessionId)) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    if (this.options.providerReady !== undefined && !this.options.providerReady()) {
      return { ok: false, code: 1004, message: 'provider 未配置' };
    }
    await this.adapter.sendMessage(sessionId, content);
    // 新流开始：清空上一轮累积文本
    this.setStatus(sessionId, 'streaming', { lastDeltaText: undefined });
    return { ok: true, data: null };
  }

  /**
   * 取消响应（CV-S04）：仅 streaming 状态调用 adapter.cancelStream 并置为 canceled；
   * 非 streaming 取消为幂等成功（重复取消 / 空闲取消无副作用）。已生成内容保留
   * （lastDeltaText 不清空）。
   * @param sessionId 会话 ID
   * @returns 成功返回 null；会话 ID 为空返回 1001；adapter 异常向上抛出（rpc 层映射 5000）
   */
  async cancelStream(sessionId: string): Promise<ConversationResult<null>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.getStatus(sessionId) !== 'streaming') {
      // 幂等：非 streaming 取消为无操作成功（重复取消不产生副作用）
      return { ok: true, data: null };
    }
    await this.adapter.cancelStream(sessionId);
    this.setStatus(sessionId, 'canceled'); // 保留 lastDeltaText（已生成内容不丢弃）
    return { ok: true, data: null };
  }

  /**
   * 查询消息历史（CV-S05）：全量加载 pi session 消息，按 ts 升序，角色保留。
   * @param sessionId 会话 ID
   * @returns 成功返回按时间升序的消息列表；会话 ID 为空返回 1001；adapter 异常
   *          捕获为 5000 错误联合（不崩溃）
   */
  async queryHistory(
    sessionId: string,
  ): Promise<ConversationResult<{ messages: ConversationMessage[] }>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    try {
      const messages = await this.adapter.loadHistory(sessionId);
      const sorted = [...messages].sort((a, b) => a.ts.localeCompare(b.ts));
      return { ok: true, data: { messages: sorted } };
    } catch (err) {
      return {
        ok: false,
        code: 5000,
        message: err instanceof Error ? err.message : '历史加载失败',
      };
    }
  }

  /**
   * 查询会话执行状态（内部状态读）。
   * @param sessionId 会话 ID
   * @returns 当前状态（未记录会话默认 idle）
   */
  getStatus(sessionId: string): ConversationStatus {
    return this.streamStates.get(sessionId)?.status ?? 'idle';
  }

  /**
   * 查询会话流式状态（含内存累积文本，供测试 / 上层验证已生成内容保留）。
   * @param sessionId 会话 ID
   * @returns 状态副本（未记录会话返回 { status: 'idle' }）
   */
  getStreamState(sessionId: string): StreamState {
    const state = this.streamStates.get(sessionId);
    return state === undefined ? { status: 'idle' } : { ...state };
  }

  /**
   * 会话状态驱动（内部辅助，供测试 / rpc 层模拟适配器驱动的状态流转）。
   * 写入内存状态表并触发 onStatusChange 回调（事件接线在 rpc 层）。
   * @param sessionId 会话 ID
   * @param status 目标状态
   * @param opts 可选：携带/清空增量累积文本（省略时保持当前值）
   */
  setStatus(sessionId: string, status: ConversationStatus, opts?: ConversationStatusOptions): void {
    const current = this.streamStates.get(sessionId);
    this.streamStates.set(sessionId, {
      status,
      lastDeltaText: opts !== undefined ? opts.lastDeltaText : current?.lastDeltaText,
    });
    this.options.onStatusChange?.(sessionId, status);
  }
}