import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import { call, subscribe, type ConversationCompactedPayload } from '../bridge.ts';
import type { ConversationMessage, SessionStatus, Subagent } from '../types.ts';
import type { DisplayItem, ToolDiff } from '../components/MessageListItem.vue';
import { computeTurnFooters } from './useTurnFooter.ts';
import { useStreamPhase } from './useStreamPhase.ts';

/** 各会话当前轮次起点（模块级，跨视图实例共享）：切走会话不丢，轮次终态才删 */
const turnStartAt = new Map<string, number>();

/**
 * 单会话对话状态机（单视图 ConversationView 与多窗口 MultiWindowConversation 共用）。
 *
 * 职责：消息流加载/追加、流式状态与阶段指示（思考/输出/工具）、工具事件 started→completed
 * 聚合与工具组折叠、子 Agent 内存态与操作、conversation/tool/subagent 事件订阅。
 * 视图只保留壳层差异：单视图的时间线/回看/历史浮窗/草稿建会话，多窗口的画布窗口布局。
 * 会话行为只此一份实现，避免两视图各自漂移（思考指示器/工具卡两处 bug 均源于漂移）。
 */
export function useSessionConversation(options: {
  /** 当前会话 id（草稿态 null；事件过滤、RPC、子 Agent 全部经它取值） */
  getSessionId: () => string | null;
  /** 会话列表状态提示（App 随 session.statusChanged 刷新）：加入已在流式的会话时恢复指示器 */
  getStatusHint?: () => SessionStatus | undefined;
  /** 滚动到底部（单视图注入回看门控版，多窗口注入直接版）；缺省 no-op */
  scrollToBottom?: () => void;
}) {
  const scroll = options.scrollToBottom ?? (() => {});
  const scheduleScroll = (): void => {
    nextTick(scroll);
  };

  const messages = ref<ConversationMessage[]>([]);
  const isStreaming = ref(false);
  const loadingHistory = ref(false);
  const errorMsg = ref<string | null>(null);

  /** toolEventId -> messages 数组索引，用于 started→completed 聚合 */
  const toolEventIndex = new Map<string, number>();

  /** 工具组折叠状态：key 为工具组稳定 id（首条工具 toolEventId/ts，聚组边界变化不漂移） */
  const toolGroupCollapsed = reactive(new Map<string, boolean>());

  /** 流式阶段指示（方案 A）：按 delta/工具事件推断当前动作文案（思考/输出/写入/读取/执行命令…） */
  const { streamPhaseText, reset: resetStreamPhase, markOutputting, markTool, markToolEnd } = useStreamPhase();

  /** 流式读秒：起点按 sessionId 存模块级表（跨视图实例共享），切走再切回不丢真实起点；
   *  用显式 start/stop 而非 watch(isStreaming)：会话切换在同 tick 内 false→true，
   *  watch 去重后视为无变化不触发，计时器会沿用上个会话的起点（多会话读秒全同的 bug） */
  const streamElapsedSec = ref(0);
  let elapsedTimer: ReturnType<typeof setInterval> | null = null;
  let elapsedStartAt = 0;

  function startElapsed(sid: string): void {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
    const recorded = turnStartAt.get(sid);
    elapsedStartAt = recorded ?? Date.now();
    if (recorded === undefined) turnStartAt.set(sid, elapsedStartAt);
    streamElapsedSec.value = Math.floor((Date.now() - elapsedStartAt) / 1000);
    elapsedTimer = setInterval(() => {
      streamElapsedSec.value = Math.floor((Date.now() - elapsedStartAt) / 1000);
    }, 1000);
  }

  /** 停表不删起点：切走会话（resetForSession）用；真正终态由各终态分支另删起点 */
  function stopElapsed(): void {
    if (elapsedTimer) {
      clearInterval(elapsedTimer);
      elapsedTimer = null;
    }
  }

  /** 会话切换时恢复/清除流式态（ConversationView 切会话调用）：一并接管读秒启停 */
  function restoreStreaming(active: boolean): void {
    const sid = options.getSessionId();
    isStreaming.value = active;
    if (active && sid !== null) startElapsed(sid);
    else stopElapsed();
  }

  // ===== 子 Agent 内存态（按 sessionId 隔离） =====
  const subagents = ref<Subagent[]>([]);
  /** 当前激活的 Tab；null = 主会话 */
  const activeAgentId = ref<string | null>(null);
  /** 待二次确认的停止请求（结果视图头部"终止"） */
  const pendingStopAgentId = ref<string | null>(null);

  const isEmpty = computed(() => messages.value.length === 0 && !isStreaming.value && !loadingHistory.value);

  const activeAssistantIndex = computed(() => messages.value.map((m) => m.role).lastIndexOf('assistant'));

  function isMessageStreaming(index: number): boolean {
    return isStreaming.value && index === activeAssistantIndex.value;
  }

  const sessionStatus = computed<SessionStatus>(() =>
    isStreaming.value ? 'streaming' : (options.getStatusHint?.() ?? 'idle'),
  );

  const activeSubagent = computed<Subagent | null>(() => {
    if (activeAgentId.value === null) return null;
    return subagents.value.find((s) => s.agentId === activeAgentId.value) ?? null;
  });

  const showResultView = computed(() => activeSubagent.value !== null);

  // ===== 展示项组装（消息 / 连续 ≥2 工具聚组） =====

  /** 从 ConversationMessage（role=tool）构造 ToolDiff（Edit 类含 file_path/old_string/new_string） */
  function toToolDiff(message: ConversationMessage): ToolDiff | null {
    const input = message.input;
    if (!input || typeof input !== 'object') return null;
    if (!('old_string' in input) && !('new_string' in input)) return null;
    const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
    return {
      id: message.toolEventId ?? `${message.ts}-${input.file_path ?? ''}`,
      filePath: text(input.file_path),
      oldString: text(input.old_string),
      newString: text(input.new_string),
    };
  }

  function groupDiffs(tools: ConversationMessage[]): ToolDiff[] {
    return tools.flatMap((tool) => {
      const diff = toToolDiff(tool);
      return diff ? [diff] : [];
    });
  }

  /**
   * 稳定唯一 key：
   * - 消息：id ?? toolEventId ?? `ts-role`（不依赖列表位置，避免 idx 漂移导致 patch 错位）
   * - 工具组：首条工具 toolEventId ?? ts 加 `-group` 后缀（与消息 key 永不冲突）
   */
  function itemKey(m: ConversationMessage): string {
    return m.id ?? m.toolEventId ?? `${m.ts}-${m.role}`;
  }

  const displayItems = computed(() => {
    const out: DisplayItem[] = [];
    const msgs = messages.value;
    // 轮次 footer：一次回复被工具调用拆成多张 assistant 卡片时，仅末卡显示复制+时间
    const footers = computeTurnFooters(msgs);
    let i = 0;
    while (i < msgs.length) {
      const cur = msgs[i]!;
      if (cur.role !== 'tool') {
        const footer = footers.get(i);
        out.push({
          key: itemKey(cur),
          kind: 'message',
          msg: cur,
          idx: i,
          ...(footer ? { showFooter: footer.showFooter, copyText: footer.copyText } : {}),
        });
        i += 1;
      } else {
        const start = i;
        const tools: ConversationMessage[] = [];
        while (i < msgs.length && msgs[i]!.role === 'tool') {
          tools.push(msgs[i]!);
          i += 1;
        }
        if (tools.length >= 2) {
          const first = tools[0]!;
          const groupKey = `${first.toolEventId ?? first.ts}-group`;
          const counts = new Map<string, number>();
          for (const t of tools) counts.set(t.toolName ?? 'tool', (counts.get(t.toolName ?? 'tool') ?? 0) + 1);
          const toolCounts = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
          // 折叠状态只跟随用户操作；新增工具仅更新头部计数和外部 Diff。
          const collapsed = toolGroupCollapsed.get(groupKey) ?? true;
          out.push({
            key: groupKey,
            kind: 'tool-group',
            tools,
            toolCounts,
            totalCount: tools.length,
            collapsed,
            diffs: groupDiffs(tools),
          });
        } else {
          for (let j = 0; j < tools.length; j += 1) {
            const tm = tools[j]!;
            out.push({ key: itemKey(tm), kind: 'message', msg: tm, idx: start + j });
          }
        }
      }
    }
    return out;
  });

  function toggleGroup(key: string): void {
    const cur = toolGroupCollapsed.get(key);
    toolGroupCollapsed.set(key, !(cur ?? true));
  }

  // ===== 历史加载 / 会话切换 =====

  /** 加载历史消息 */
  async function loadHistory(): Promise<void> {
    const sid = options.getSessionId();
    if (sid === null) return; // 草稿态无会话，无需加载
    loadingHistory.value = true;
    errorMsg.value = null;
    try {
      const res = await call<{ messages: ConversationMessage[] }>('conversation/queryHistory', {
        sessionId: sid,
      });
      // 仅在仍停留于发起会话时应用结果（切走后丢弃过期响应）
      if (sid === options.getSessionId()) {
        // 拷贝为本地数组：mock-backend 的 queryHistory 返回内部数组引用，
        // 直接持有会被 mock 后续写入原地污染，出现重复消息
        messages.value = [...(res.messages ?? [])];
        toolEventIndex.clear();
        toolGroupCollapsed.clear();
        // 重建工具事件索引
        messages.value.forEach((m, i) => {
          if (m.role === 'tool' && m.toolEventId) {
            toolEventIndex.set(m.toolEventId, i);
          }
        });
        scheduleScroll();
      }
    } catch (e) {
      // 过期请求的错误不显示（属于已离开的会话）
      if (sid === options.getSessionId()) {
        errorMsg.value = e instanceof Error ? e.message : String(e);
      }
    } finally {
      if (sid === options.getSessionId()) {
        loadingHistory.value = false;
        scheduleScroll();
      }
    }
    // 红点会话切回恢复：errorMsg 横幅是瞬态内存态，错误发生在本会话之外时
    //（切走再切回/后台会话出错）已被清空或从未设置，而会话树红点
    //（session.status='error'）持久——此时拉取后端记录的 lastError 恢复横幅；
    // 拉取失败静默降级（横幅非关键路径，不阻塞历史加载）
    if (sid === options.getSessionId() && options.getStatusHint?.() === 'error') {
      try {
        const res = await call<{ message: string | null }>('conversation/getLastError', {
          sessionId: sid,
        });
        if (sid === options.getSessionId() && res.message) errorMsg.value = res.message;
      } catch {
        // 静默降级：不显示横幅即可
      }
    }
  }

  /** 会话切换：重置状态（视图侧的回看模式/高亮等由视图自理）；
   * queueBySession 不清：队列镜像按事件全量维护，切走再切回徽标不丢（CV-S09） */
  function resetForSession(): void {
    messages.value = [];
    toolEventIndex.clear();
    toolGroupCollapsed.clear();
    isStreaming.value = false;
    loadingHistory.value = false;
    errorMsg.value = null;
    stopElapsed();
  }

  // ===== 发送 / 取消 =====

  /** 发送消息：本地追加 user 消息 + 调后端（附件统一给路径：路径行已在 content 内）。
   *  CV-S09：忙时（isStreaming）改为入队——不本地 push 气泡（派发时由后端
   *  conversation.message(user) 事件渲染），不重置流式读秒。 */
  async function send(text: string): Promise<void> {
    const t = text.trim();
    const sid = options.getSessionId();
    if (!t || sid === null) return;
    if (isStreaming.value) {
      try {
        await call<null>('conversation/sendMessage', { sessionId: sid, content: t });
      } catch (e) {
        errorMsg.value = e instanceof Error ? e.message : String(e);
      }
      return;
    }
    errorMsg.value = null;
    messages.value.push({ role: 'user', content: t, ts: new Date().toISOString() });
    isStreaming.value = true;
    startElapsed(sid);
    resetStreamPhase();
    scheduleScroll();
    try {
      await call<null>('conversation/sendMessage', { sessionId: sid, content: t });
    } catch (e) {
      if (sid !== null) turnStartAt.delete(sid);
      stopElapsed();
      isStreaming.value = false;
      errorMsg.value = e instanceof Error ? e.message : String(e);
    }
  }

  /** 取消流式（CV-S09）：返回被清空的待发队列文本（FIFO 序），供输入框回填 */
  async function cancel(): Promise<string[]> {
    let clearedMessages: string[] = [];
    try {
      const res = await call<{ clearedMessages?: string[] }>('conversation/cancelStream', {
        sessionId: options.getSessionId(),
      });
      clearedMessages = res?.clearedMessages ?? [];
    } catch {
      // 取消失败不阻塞，仍允许 UI 停止
    }
    const sid = options.getSessionId();
    if (sid !== null) turnStartAt.delete(sid);
    stopElapsed();
    isStreaming.value = false;
    return clearedMessages;
  }

  // ===== 会话/工具事件处理 =====

  /** 当前会话待发送队列（CV-S09）：pi followUp 队列快照（FIFO 序，[0] 最先派发）。
   * 按会话镜像全部 queueUpdated 事件（不过滤当前会话）：切走再切回时徽标不丢，
   * 否则切换清空 + 非当前会话事件被丢弃后无查询接口可恢复（徽标永久丢失） */
  const queueBySession = reactive(new Map<string, string[]>());
  const queueItems = computed(() => queueBySession.get(options.getSessionId() ?? '') ?? []);

  function onQueueUpdated(payload: unknown): void {
    const p = payload as { sessionId: string; followUp?: string[] };
    queueBySession.set(p.sessionId, Array.isArray(p.followUp) ? p.followUp : []);
  }

  function onMessage(payload: unknown): void {
    const p = payload as { sessionId: string; message: ConversationMessage };
    if (p.sessionId !== options.getSessionId()) return;
    // CV-S09：排队消息派发到达的 user 气泡：直接 push（不套用 assistant 覆盖逻辑，
    // 否则会把 user 文本写进在途 assistant 占位）
    if (p.message.role === 'user') {
      messages.value.push(p.message);
      scheduleScroll();
      return;
    }
    // 流式阶段已通过 delta 构建了 assistant 占位消息，最终 message 到达时以其为权威内容覆盖，
    // 避免"delta 累积 + 完整消息再推一条"成双
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === 'assistant') {
      last.content = p.message.content;
      last.ts = p.message.ts ?? last.ts;
      scheduleScroll();
      return;
    }
    messages.value.push(p.message);
    scheduleScroll();
  }

  function onDelta(payload: unknown): void {
    // 契约：delta 为 { text, kind: 'text' }（docs/api/03_conversation.md §3）
    const p = payload as { sessionId: string; delta: { text?: string } | string };
    if (p.sessionId !== options.getSessionId()) return;
    const text = typeof p.delta === 'string' ? p.delta : (p.delta.text ?? '');
    if (text !== '') markOutputting();
    // 流式追加到最后一条 assistant 消息；无则新建
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === 'assistant') {
      last.content += text;
    } else {
      messages.value.push({ role: 'assistant', content: text, ts: new Date().toISOString() });
    }
    scheduleScroll();
  }

  function onStatus(payload: unknown): void {
    const p = payload as { sessionId: string; status: string };
    if (p.sessionId !== options.getSessionId()) return;
    if (p.status === 'streaming') {
      // 新轮次起点：无条件刷新（防上一轮终态在切走期间被过滤后残留旧起点串入新轮次）
      turnStartAt.set(p.sessionId, Date.now());
      isStreaming.value = true;
      startElapsed(p.sessionId);
      resetStreamPhase();
    } else if (p.status === 'done' || p.status === 'idle' || p.status === 'canceled' || p.status === 'error') {
      turnStartAt.delete(p.sessionId);
      stopElapsed();
      isStreaming.value = false;
      // done/idle/canceled 后清错误横幅：自动重试提示（经 conversation.error 展示）在
      // 轮次正常结束时自动消失；error 横幅保留到下次发送/重试再替换
      if (p.status !== 'error') errorMsg.value = null;
    }
  }

  function onError(payload: unknown): void {
    const p = payload as { sessionId: string; code?: number; message?: string };
    if (p.sessionId !== options.getSessionId()) return;
    // 不在此处置 isStreaming=false：终态错误必伴随 status='error' 事件收尾；
    // conversation.error 还承载自动重试提示（轮次仍在 streaming），此处置假会误断进行中状态
    errorMsg.value = p.message ?? `对话错误（${p.code ?? 'unknown'}）`;
  }

  /**
   * 上下文压缩完成（P3-A）：重拉历史。压缩会把 transcript 替换为摘要，不重拉则界面显示
   * 压缩前旧内容。自动压缩没有 RPC 入口，本事件是 UI 感知它的唯一通道。
   * 持久横幅（压缩中→已完成）由 InstructionInput 的事件订阅统一维护，此处不重复。
   */
  function onCompacted(payload: unknown): void {
    const p = payload as ConversationCompactedPayload;
    if (p.sessionId !== options.getSessionId()) return;
    void loadHistory();
  }

  function onToolStarted(payload: unknown): void {
    const p = payload as {
      toolEventId: string;
      sessionId?: string;
      tool?: { name?: string; input?: Record<string, unknown> };
      toolName?: string;
    };
    // tool 事件可能不带 sessionId（按 ToolDescriptor 结构），保守处理：无 sessionId 归当前会话
    if (p.sessionId !== undefined && p.sessionId !== options.getSessionId()) return;
    if (toolEventIndex.has(p.toolEventId)) return;
    // 真实后端载荷为 tool:{name,input}（docs/api/04_tool.md §1），toolName 为 mock/旧格式兼容
    markTool(p.toolEventId, p.tool?.name ?? p.toolName ?? null);
    const msg: ConversationMessage = {
      role: 'tool',
      content: '',
      ts: new Date().toISOString(),
      toolEventId: p.toolEventId,
      toolName: p.tool?.name ?? p.toolName,
      status: 'started',
      input: p.tool?.input,
    };
    messages.value.push(msg);
    toolEventIndex.set(p.toolEventId, messages.value.length - 1);
    scheduleScroll();
  }

  function onToolCompleted(payload: unknown): void {
    const p = payload as {
      toolEventId: string;
      sessionId?: string;
      result?: { text: string | null };
      summary?: string;
    };
    if (p.sessionId !== undefined && p.sessionId !== options.getSessionId()) return;
    const idx = toolEventIndex.get(p.toolEventId);
    if (idx === undefined) return;
    markToolEnd(p.toolEventId);
    const msg = messages.value[idx];
    if (!msg) return;
    msg.status = 'completed';
    // 真实后端为 result:{text}，summary 为 mock/旧格式兼容
    const text = p.result?.text ?? p.summary;
    if (text) msg.content = text;
  }

  function onToolError(payload: unknown): void {
    const p = payload as {
      toolEventId: string;
      sessionId?: string;
      error?: { message: string };
      summary?: string;
      message?: string;
    };
    if (p.sessionId !== undefined && p.sessionId !== options.getSessionId()) return;
    const idx = toolEventIndex.get(p.toolEventId);
    if (idx === undefined) return;
    markToolEnd(p.toolEventId);
    const msg = messages.value[idx];
    if (!msg) return;
    msg.status = 'error';
    // 真实后端为 error:{message}，summary/message 为 mock/旧格式兼容
    const text = p.error?.message ?? p.summary ?? p.message;
    if (text) msg.content = text;
  }

  // ===== 子 Agent 处理 =====

  /** 加载会话的子 agent 内存态（queryList） */
  async function loadSubagents(): Promise<void> {
    const sid = options.getSessionId();
    if (sid === null) {
      subagents.value = [];
      return;
    }
    try {
      const res = await call<{ subagents: Subagent[] }>('subagent/queryList', { sessionId: sid });
      subagents.value = res.subagents ?? [];
    } catch {
      subagents.value = [];
    }
  }

  /** 终态字段不可逆：终态记录的 finishedAt/result 一经设置不得回退 */
  function applySubagentUpsert(sa: Subagent): void {
    const idx = subagents.value.findIndex((s) => s.agentId === sa.agentId);
    if (idx === -1) {
      subagents.value.push({ ...sa });
      return;
    }
    const cur = subagents.value[idx]!;
    subagents.value[idx] = {
      ...cur,
      ...sa,
      finishedAt: cur.finishedAt ?? sa.finishedAt,
      result: cur.result ?? sa.result,
      error: cur.error ?? sa.error,
    };
  }

  function onSubagentUpdated(payload: unknown): void {
    const p = payload as { sessionId: string; subagent: Subagent };
    if (p.sessionId !== options.getSessionId()) return;
    applySubagentUpsert(p.subagent);
  }

  function onSubagentRemoved(payload: unknown): void {
    const p = payload as { sessionId: string; agentIds: string[] };
    if (p.sessionId !== options.getSessionId()) return;
    const removed = new Set(p.agentIds);
    subagents.value = subagents.value.filter((s) => !removed.has(s.agentId));
    // 若被移除者正在激活，切回主会话
    if (activeAgentId.value !== null && removed.has(activeAgentId.value)) {
      activeAgentId.value = null;
    }
  }

  function onSelectTab(agentId: string | null): void {
    activeAgentId.value = agentId;
  }

  /** 单个终态 Tab 关闭：本地移除（mock 不区分单删与批量清除，二者语义一致） */
  function onCloseTab(agentId: string): void {
    subagents.value = subagents.value.filter((s) => s.agentId !== agentId);
    if (activeAgentId.value === agentId) activeAgentId.value = null;
  }

  /** 清除已完成：批量移除终态 → 调 subagent/clearFinished（mock 也会 emit subagent.removed） */
  async function onClearFinished(): Promise<void> {
    const sid = options.getSessionId();
    if (sid === null) return;
    try {
      await call('subagent/clearFinished', { sessionId: sid });
      // mock 已 emit subagent.removed 同步了本地状态；防御性主动清一次
      subagents.value = subagents.value.filter((s) => s.status === 'queued' || s.status === 'running');
    } catch {
      // 静默失败：本地乐观更新已落
      subagents.value = subagents.value.filter((s) => s.status === 'queued' || s.status === 'running');
    }
  }

  /** 结果视图头部"终止"按钮点击：进入二次确认（不可逆） */
  function onSubagentStopRequest(agentId: string): void {
    pendingStopAgentId.value = agentId;
  }

  async function confirmSubagentStop(): Promise<void> {
    const agentId = pendingStopAgentId.value;
    pendingStopAgentId.value = null;
    if (agentId === null) return;
    const sid = options.getSessionId();
    if (sid === null) return;
    try {
      await call('subagent/stop', { sessionId: sid, agentId });
    } catch (e) {
      console.warn('[subagent] 终止失败', e);
    }
  }

  function cancelSubagentStop(): void {
    pendingStopAgentId.value = null;
  }

  // ===== 加入已在流式的会话：恢复流式标记 =====
  // 后端不会对进行中的轮次重发 conversation.statusChanged(streaming)。会话列表状态
  // （App 随 session.statusChanged 刷新）是唯一兜底通道，持续单向跟随：列表若显示
  // streaming 而本地未流式（窗口挂载晚于轮次开始 / 列表刷新晚于挂载的竞态）则置 true。
  // 只单向置 true：列表刷新有延迟，不能反向依赖它关流式（终态以 statusChanged 事件为准）。
  watch(
    () => options.getStatusHint?.(),
    (st) => {
      if (st === 'streaming' && !isStreaming.value) restoreStreaming(true);
    },
    { immediate: true },
  );

  // ===== 事件订阅 =====
  let unsubs: Array<(() => void) | null> = [];

  onMounted(() => {
    if (options.getSessionId() !== null) {
      void loadHistory();
      void loadSubagents();
    }
    unsubs = [
      subscribe('conversation.message', onMessage),
      subscribe('conversation.delta', onDelta),
      subscribe('conversation.statusChanged', onStatus),
      subscribe('conversation.error', onError),
      subscribe('conversation.compacted', onCompacted),
      subscribe('conversation.queueUpdated', onQueueUpdated),
      subscribe('tool.started', onToolStarted),
      subscribe('tool.completed', onToolCompleted),
      subscribe('tool.error', onToolError),
      subscribe('subagent.updated', onSubagentUpdated),
      subscribe('subagent.removed', onSubagentRemoved),
    ];
  });

  onUnmounted(() => {
    unsubs.forEach((u) => u?.());
    unsubs = [];
    stopElapsed();
  });

  return {
    // 状态
    messages,
    isStreaming,
    loadingHistory,
    errorMsg,
    isEmpty,
    displayItems,
    isMessageStreaming,
    toggleGroup,
    sessionStatus,
    streamPhaseText,
    streamElapsedSec,
    restoreStreaming,
    queueItems,
    // 会话操作
    loadHistory,
    resetForSession,
    send,
    cancel,
    // 子 Agent
    subagents,
    activeAgentId,
    activeSubagent,
    showResultView,
    pendingStopAgentId,
    loadSubagents,
    onSelectTab,
    onCloseTab,
    onClearFinished,
    onSubagentStopRequest,
    confirmSubagentStop,
    cancelSubagentStop,
  };
}
