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
 * 7. 斜杠命令清单（docs/api/03_conversation.md §9，扩展 CV-S08）：会话级内存缓存
 *    （reportedCommands Map，无持久化）。会话模式命中缓存返回三类全量，上报未到降级
 *    注入的 slashCommandResources port 轻量查询（skills+模板）；草稿态 port 直查。
 *    port 未注入 / 抛错 / 查询失败一律返回空清单不报错（AC-CV-033）；仅参数非法
 *    （1001）与未知会话（1002）报错。会话删除清理由 desktop 层调用
 *    clearSessionCommands 接线（本服务不参与会话删除流程）。
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
 * @param images 可选：消息附带图片（P3-B 用户粘贴截图，base64 数据，渲染由前端完成）
 * @param files 可选：消息附带文本文件的文件名列表（P3-B；内容已随 prompt 进入模型上下文，展示只留占位）
 */
export interface ConversationMessage {
  role: ConversationRole;
  content: string;
  ts: string;
  id?: string;
  images?: Array<{ data: string; mimeType: string }>;
  files?: string[];
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
/** 发送运行时选项（附件统一给路径后仅剩 cwd / model） */
export type ConversationRuntimeOptions = {
  sessionId?: string;
  cwd?: string;
  model?: string;
};

/** 上下文压缩触发来源：manual = 用户点击压缩；auto = 运行时按阈值/溢出自动触发 */
export type CompactReason = 'manual' | 'auto';

/**
 * 斜杠命令清单项（docs/api/03_conversation.md §9，扩展 CV-S08）。
 * @param name 原始命令名（skill 命令带 skill: 前缀；插入输入框时补 / 前缀）
 * @param description 命令描述；缺失归一为 null（UI 副文本留空）
 * @param source 来源：extension = 扩展命令；skill = 技能；prompt = prompt 模板
 */
export interface SlashCommand {
  name: string;
  description: string | null;
  source: 'extension' | 'skill' | 'prompt';
}

/**
 * 斜杠命令资源轻量查询 port（可注入 mock，desktop 层注入真实实现）。
 * 只覆盖 skills + prompt 模板（不加载扩展、不创建会话，TD-CV-08）；
 * 会话模式上报未到时降级、草稿态模式直查均经此 port。
 */
export interface SlashCommandResources {
  /** 枚举可用命令（projectPath 定位项目级资源；省略仅发现全局 agentDir 资源） */
  listCommands(projectPath?: string): Promise<SlashCommand[]>;
}

/** getSlashCommands 请求参数（两种模式：提供 sessionId 为会话模式，省略为草稿态） */
export interface GetSlashCommandsParams {
  /** 会话 ID：提供时返回该会话缓存/降级清单；省略为草稿态查询 */
  sessionId?: string;
  /** 草稿态项目工作目录（定位项目级 skills/模板；省略仅发现全局资源） */
  projectPath?: string;
}

/** 斜杠命令 description 归一（缺失/undefined -> null，契约禁止 undefined 出现） */
function normalizeSlashCommand(command: SlashCommand): SlashCommand {
  return {
    name: command.name,
    description: command.description ?? null,
    source: command.source,
  };
}

/**
 * 手动压缩结果（P3-A）。
 * 压缩成功时 ok=true 并携带压缩前后 token 数（未知为 null）；失败时 ok=false 且
 * message 为原因（如「会话未激活」「Nothing to compact」）。
 */
export interface ConversationCompactResult {
  ok: boolean;
  /** 失败原因（成功时缺省） */
  message?: string;
  /** 压缩前 token 数；未知为 null */
  tokensBefore?: number | null;
  /** 压缩后估算 token 数；未知为 null */
  tokensAfter?: number | null;
  /** 压缩摘要；未知为 null */
  summary?: string | null;
}

/**
 * conversation.compacting 事件载荷：一次上下文压缩开始（手动或自动）。
 * UI 据此锁定输入框并显示"正在压缩"横幅；与 compacted 成对出现。
 */
export interface ConversationCompactingPayload {
  sessionId: string;
  reason: CompactReason;
}

/**
 * conversation.compacted 事件载荷：一次压缩完成（手动或自动）。
 * 自动压缩没有 RPC 入口，UI 只能靠本事件感知并刷新消息列表。
 */
export interface ConversationCompactedPayload {
  sessionId: string;
  reason: CompactReason;
  tokensBefore: number | null;
  tokensAfter: number | null;
  summary: string | null;
}

/**
 * 上下文用量快照（P3-A）：tokens/percent 未知为 null；
 * 查询整体返回 null 表示无法得知（UI 显示 —）。
 */
export type ConversationUsageSnapshot = {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
};

export interface PiConversationAdapter {
  sendMessage(sessionId: string, content: string, options?: ConversationRuntimeOptions): Promise<void>;
  loadHistory(sessionId: string): Promise<ConversationMessage[]>;
  /**
   * 取消当前轮（CV-S04/CV-S09）：中止运行并清空待发队列（pi TUI ESC 语义），
   * 返回被清空的队列文本（FIFO 序，供 UI 回填输入框）；无队列返回空数组。
   */
  cancelStream(sessionId: string): Promise<string[]>;
  /** 上下文用量查询（P3-A）；无数据返回 null；允许异步实现（无 lease 时磁盘估算） */
  getContextUsage?(sessionId: string): Promise<ConversationUsageSnapshot | null> | ConversationUsageSnapshot | null;
  /** 手动压缩（P3-A） */
  compact?(sessionId: string): Promise<ConversationCompactResult>;
}

/** 会话流式状态（每会话内存态，含内存累积文本） */
export interface StreamState {
  status: ConversationStatus;
  /** 流式增量累积文本（取消/中断时保留，不丢弃已生成内容） */
  lastDeltaText?: string;
  /**
   * 最近一次轮次错误信息（error 状态期间保留）：
   * 前端 errorMsg 横幅是瞬态内存态，切走再切回/后台会话出错后丢失——
   * 会话树红点（session.status='error'）持久，横幅数据源必须同样可回查。
   * 新轮次（streaming）与正常终态（done/canceled/idle）清除。
   */
  lastError?: string | null;
}

/** 状态驱动选项（setStatus 内部辅助：携带/清空增量累积文本） */
export interface ConversationStatusOptions {
  /** 增量累积文本；提供该选项时按值设置（undefined 清空），省略时保持当前值 */
  lastDeltaText?: string;
  /**
   * 轮次错误信息；error 状态时提供则记录，省略时保留已记录值；
   * 非 error 状态忽略（lastError 一律清除）
   */
  lastError?: string;
}

/** 服务构造选项（校验解析器 + 事件回调注入点） */
export interface ConversationServiceOptions {
  /** 会话存在性校验（未注入则跳过校验） */
  sessionExists?: (sessionId: string) => boolean;
  /** 会话是否尚未设置别名（第一条用户消息的判定条件；未注入则跳过自动命名） */
  sessionAliasMissing?: (sessionId: string) => boolean;
  /** provider 就绪校验（未注入视为已配置）；支持异步（P2-D：真实 models 可用性检查） */
  providerReady?: () => boolean | Promise<boolean>;
  /** 状态变化回调（rpc 层接到 conversation.statusChanged 事件） */
  onStatusChange?: (sessionId: string, status: ConversationStatus) => void;
  /** 流式增量回调（预留注入点；本 WU 无增量来源，rpc 层接线用） */
  onDelta?: (sessionId: string, delta: ConversationDelta) => void;
  /** 发送前解析会话生效模型和项目 cwd（rpc 层透传给 pi runtime） */
  resolveSendOptions?: (
    sessionId: string,
  ) => Promise<ConversationRuntimeOptions>;
  /** 首条用户消息发送后触发：基于首条问题自动设置会话别名 */
  onFirstUserMessage?: (sessionId: string, firstUserContent: string) => void;
  /**
   * 斜杠命令资源轻量查询 port（只覆盖 skills+模板，不加载扩展）。
   * 会话模式上报未到时降级、草稿态模式直查均经此 port；
   * 未注入 / 抛错 / 查询失败一律返回空清单不报错（AC-CV-033）。
   */
  slashCommandResources?: SlashCommandResources;
}

/** 提取异常消息（5000 错误联合用） */
function toMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  /** 会话级命令上报缓存（sessionId -> 上报清单，来自命令上报扩展；内存态无持久化） */
  private readonly reportedCommands: Map<string, SlashCommand[]> = new Map();

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
  async sendMessage(
    sessionId: string,
    content: string,
    runtimeOptions: ConversationRuntimeOptions = {},
  ): Promise<ConversationResult<null>> {
    if (typeof content !== 'string' || content.trim() === '') {
      return { ok: false, code: 1001, message: '消息不能为空' };
    }
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.options.sessionExists !== undefined && !this.options.sessionExists(sessionId)) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    if (this.options.providerReady !== undefined) {
      const ready = await this.options.providerReady();
      if (!ready) {
        return { ok: false, code: 1004, message: 'provider 未配置' };
      }
    }
    if (this.getStatus(sessionId) === 'streaming') {
      // CV-S09 消息队列：忙时发送 = 入队（pi followUp，收尾自动投递）。
      // 不重置流式状态/不重做首条命名/不重解析模型覆盖（在途轮次不因入队改变），
      // 入队失败（如扩展命令不能排队）只报错不影响在途轮次状态。
      try {
        await this.adapter.sendMessage(sessionId, content, runtimeOptions);
      } catch (err) {
        return { ok: false, code: 5000, message: toMessage(err) };
      }
      return { ok: true, data: null };
    }
    const resolvedOptions =
      this.options.resolveSendOptions !== undefined
        ? { ...runtimeOptions, ...(await this.options.resolveSendOptions(sessionId)) }
        : runtimeOptions;
    // 首条用户消息自动命名：若会话别名缺失，基于问题内容生成会话名
    if (
      this.options.sessionAliasMissing !== undefined &&
      this.options.onFirstUserMessage !== undefined &&
      this.options.sessionAliasMissing(sessionId)
    ) {
      this.options.onFirstUserMessage(sessionId, content);
    }
    // 附件统一给路径：内容已含路径行原样透传；非视觉模型遇图片由 pi-ai 传输层
    // 自动降级为占位文本（transform-messages.downgradeUnsupportedImages），无需门控
    // 新流开始：发送前先进入 streaming（真实 pi 适配器 await 完整轮次，
    // 完成后由事件接线驱动 done / error，不能在 await 之后覆盖状态）
    this.setStatus(sessionId, 'streaming', { lastDeltaText: undefined });
    try {
      await this.adapter.sendMessage(sessionId, content, resolvedOptions);
    } catch (err) {
      const message = toMessage(err);
      // 事件路径（adapter onError → setStatus error + lastError）先于 throw 触发时
      // 保留其友好信息；本轮无事件记录时兜底记录原始错误
      const current = this.streamStates.get(sessionId);
      this.setStatus(sessionId, 'error', { lastError: current?.lastError ?? message });
      return { ok: false, code: 5000, message };
    }
    return { ok: true, data: null };
  }

  /**
   * 取消响应（CV-S04/CV-S09）：仅 streaming 状态调用 adapter.cancelStream
   * （中止 + 清空待发队列）并置为 canceled；非 streaming 取消为幂等成功
   * （重复取消 / 空闲取消无副作用）。已生成内容保留（lastDeltaText 不清空）。
   * @param sessionId 会话 ID
   * @returns 成功返回 { clearedMessages }（被清空的队列文本，FIFO 序，供 UI 回填输入框）；
   *          会话 ID 为空返回 1001；adapter 异常向上抛出（rpc 层映射 5000）
   */
  async cancelStream(sessionId: string): Promise<ConversationResult<{ clearedMessages: string[] }>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.getStatus(sessionId) !== 'streaming') {
      // 幂等：非 streaming 取消为无操作成功（重复取消不产生副作用；无队列可清）
      return { ok: true, data: { clearedMessages: [] } };
    }
    const cleared = await this.adapter.cancelStream(sessionId);
    this.setStatus(sessionId, 'canceled'); // 保留 lastDeltaText（已生成内容不丢弃）
    return { ok: true, data: { clearedMessages: cleared } };
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
   * 查询会话上下文用量（P3-A，CV-S06）：委托注入 adapter；适配器不支持时返回
   * null 数据（UI 显示未知用量，不视为错误）。
   * @param sessionId 会话 ID
   * @returns { ok: true, data: usage|null }；会话不存在 1002；adapter 异常 5000
   */
  async getContextUsage(
    sessionId: string,
  ): Promise<ConversationResult<{ usage: ConversationUsageSnapshot | null }>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.options.sessionExists !== undefined && !this.options.sessionExists(sessionId)) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    try {
      const usage =
        this.adapter.getContextUsage !== undefined
          ? await this.adapter.getContextUsage(sessionId)
          : null;
      return { ok: true, data: { usage } };
    } catch (err) {
      return { ok: false, code: 5000, message: `查询上下文用量失败: ${toMessage(err)}` };
    }
  }

  /**
   * 手动压缩上下文（P3-A，CV-S07）：委托注入 adapter；压缩失败返回明确信息且
   * 不破坏会话历史。
   * @param sessionId 会话 ID
   * @returns { ok: true, data: { result } }；会话不存在 1002；adapter 异常 5000
   */
  async compact(sessionId: string): Promise<ConversationResult<{ result: ConversationCompactResult }>> {
    if (typeof sessionId !== 'string' || sessionId.trim() === '') {
      return { ok: false, code: 1001, message: '会话 ID 不能为空' };
    }
    if (this.options.sessionExists !== undefined && !this.options.sessionExists(sessionId)) {
      return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
    }
    if (this.adapter.compact === undefined) {
      return { ok: true, data: { result: { ok: false, message: '当前环境不支持手动压缩' } } };
    }
    try {
      const result = await this.adapter.compact(sessionId);
      return { ok: true, data: { result } };
    } catch (err) {
      return { ok: false, code: 5000, message: `压缩失败: ${toMessage(err)}` };
    }
  }

  /**
   * 查询斜杠命令清单（扩展 CV-S08，docs/api/03_conversation.md §9）。
   * - 会话模式（提供 sessionId）：命中会话级上报缓存返回三类全量；上报未到降级
   *   轻量资源查询（skills+模板，无扩展命令）。
   * - 草稿态模式（省略 sessionId）：port 直查（projectPath 可选透传），无扩展命令。
   * - 枚举失败语义：port 未注入 / 抛错 / 查询失败一律返回 commands: [] 不报错
   *   （AC-CV-033，输入与消息发送不受阻塞）。
   * @param params 查询参数（sessionId / projectPath 均可选）
   * @returns { ok: true, data: { commands } }；sessionId/projectPath 非法类型 1001；
   *          会话模式未知会话 1002
   */
  async getSlashCommands(
    params: GetSlashCommandsParams = {},
  ): Promise<ConversationResult<{ commands: SlashCommand[] }>> {
    const sessionId = params?.sessionId;
    const projectPath = params?.projectPath;
    if (sessionId !== undefined && (typeof sessionId !== 'string' || sessionId.trim() === '')) {
      return { ok: false, code: 1001, message: '参数错误：sessionId 必须为非空字符串' };
    }
    if (projectPath !== undefined && typeof projectPath !== 'string') {
      return { ok: false, code: 1001, message: '参数错误：projectPath 必须为字符串' };
    }
    // projectPath 空白无定位意义，归一为省略（仅发现全局资源）
    const normalizedPath =
      typeof projectPath === 'string' && projectPath.trim() !== '' ? projectPath : undefined;

    if (sessionId !== undefined) {
      // 会话模式：未知会话 1002（校验失败即短路，不触发降级查询）
      if (this.options.sessionExists !== undefined && !this.options.sessionExists(sessionId)) {
        return { ok: false, code: 1002, message: `会话不存在: ${sessionId}` };
      }
      const cached = this.reportedCommands.get(sessionId);
      if (cached !== undefined) {
        return { ok: true, data: { commands: cached.map((c) => ({ ...c })) } };
      }
      // 上报未到：降级轻量资源查询（skills+模板）
      return { ok: true, data: { commands: await this.querySlashCommandResources(normalizedPath) } };
    }

    // 草稿态模式：port 直查（不加载扩展、不创建会话）
    return { ok: true, data: { commands: await this.querySlashCommandResources(normalizedPath) } };
  }

  /**
   * 命令上报入口（扩展 CV-S08，A-CV-013）：命令上报扩展经 desktop 桥接注入会话级
   * 内存缓存（无持久化）。幂等覆盖（后一次上报整体覆盖前一次）；未注册会话静默
   * 忽略不抛错（不崩不泄漏）。
   * @param sessionId 会话 ID
   * @param commands 扩展上报的命令清单（三类全量；description 缺失归一 null）
   */
  ingestReportedCommands(sessionId: string, commands: SlashCommand[]): void {
    if (this.options.sessionExists !== undefined && !this.options.sessionExists(sessionId)) {
      return;
    }
    this.reportedCommands.set(sessionId, commands.map(normalizeSlashCommand));
  }

  /**
   * 清理会话命令上报缓存（会话删除路径）。
   * forge-core 内本服务不参与会话删除流程（删除在 SessionService.deleteSession），
   * 由 desktop 层在会话删除路径接线调用（对齐 SubagentService.disposeSession 模式）；
   * 清理后该会话查询降级回轻量资源查询。
   * @param sessionId 会话 ID
   */
  clearSessionCommands(sessionId: string): void {
    this.reportedCommands.delete(sessionId);
  }

  /**
   * 轻量资源查询（内部辅助）：port 未注入 / 抛错 / 查询失败一律返回空清单
   * 不报错（AC-CV-033 枚举失败降级）。
   * @param projectPath 项目工作目录（可选，定位项目级 skills/模板）
   */
  private async querySlashCommandResources(projectPath: string | undefined): Promise<SlashCommand[]> {
    const port = this.options.slashCommandResources;
    if (port === undefined) {
      return [];
    }
    try {
      const commands = await port.listCommands(projectPath);
      return commands.map(normalizeSlashCommand);
    } catch (err) {
      console.error('[getSlashCommands] resource query failed', err);
      return [];
    }
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
   * 查询会话最近一次轮次错误信息（error 状态期间保留；新轮次/正常终态清除）。
   * 前端切换/挂载到 status='error' 的会话时经 RPC 拉取，恢复错误横幅显示。
   * @param sessionId 会话 ID
   * @returns 错误信息；未记录/未知会话返回 null
   */
  getLastError(sessionId: string): string | null {
    return this.streamStates.get(sessionId)?.lastError ?? null;
  }

  /**
   * 会话状态驱动（内部辅助，供测试 / rpc 层模拟适配器驱动的状态流转）。
   * 写入内存状态表并触发 onStatusChange 回调（事件接线在 rpc 层）。
   * @param sessionId 会话 ID
   * @param status 目标状态
   * @param opts 可选：携带/清空增量累积文本（省略时保持当前值）；
   *             error 状态可携带 lastError（省略时保留已记录值），非 error 状态清除
   */
  setStatus(sessionId: string, status: ConversationStatus, opts?: ConversationStatusOptions): void {
    const current = this.streamStates.get(sessionId);
    this.streamStates.set(sessionId, {
      status,
      lastDeltaText: opts !== undefined ? opts.lastDeltaText : current?.lastDeltaText,
      lastError: this.resolveLastError(status, current, opts),
    });
    this.options.onStatusChange?.(sessionId, status);
  }

  /** lastError 状态规则：非 error 状态清除；error 时 opts 提供则记录，否则保留已记录值 */
  private resolveLastError(
    status: ConversationStatus,
    current: StreamState | undefined,
    opts: ConversationStatusOptions | undefined,
  ): string | null {
    if (status !== 'error') return null;
    if (opts !== undefined && opts.lastError !== undefined) return opts.lastError;
    return current?.lastError ?? null;
  }
}
