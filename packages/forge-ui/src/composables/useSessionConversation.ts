import { computed, nextTick, onMounted, onUnmounted, reactive, ref, watch } from 'vue';
import {
  call,
  onAskUserQuestionRequest,
  replyAskUserQuestion,
  subscribe,
  type AskUserQuestionAnswer,
  type AskUserQuestionRequestPayload,
  type ConversationCompactedPayload,
} from '../bridge.ts';
import type { ConversationMessage, SessionStatus, Subagent } from '../types.ts';
import type { DisplayItem, ToolDiff } from '../components/MessageListItem.vue';
import { computeTurnFooters } from './useTurnFooter.ts';
import { collectTurnChangedFiles, parseFileToolInput } from './useChangedFiles.ts';
import { useStreamPhase } from './useStreamPhase.ts';
import { applyTodoCompletion, type TodoSnapshot } from '../utils/todoPanel.ts';
import { createAskQuestionStore } from './askQuestionStore.ts';

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

  // ===== Todo 面板快照（CV-S11；按 sessionId 内存隔离，切走再切回不丢，关闭 APP 随进程消失） =====
  // Map 替代单 ref：切会话不清空，切换回历史会话时还原上次的 todo 视图。
  // "会话自己清理" 不需要主动 GC —— 自然清空（所有 task 被删）时 shouldRenderPanel=false 面板自动卸载。
const todoSnapshots = reactive(new Map<string, TodoSnapshot | null>());
/** 当前会话 todo 快照（模板 v-bind 自动解包，外部消费接口不变） */
const todoSnapshot = computed<TodoSnapshot | null>(() => {
  const sid = options.getSessionId();
  return sid === null ? null : (todoSnapshots.get(sid) ?? null);
});

// ===== ask_user_question 面板（Path 2；按 sessionId 内存隔离，与 todo 同策略）=====
// 契约 docs/plan/ask-user-question-contract.md §4.4：面板必须挂在**会话作用域**内
// （本 composable 每个窗格一份实例），载荷强制带 sessionId，各窗格按它认领 ——
// 避免单 webContents 广播导致「N 个窗格同时弹出 N 份问卷」与错窗格回填。
// 四个会话级表 + 三个 computed 由 `askQuestionStore` 持有：那组状态里有一个**静默失败**
// 的响应式坑（倒计时表写成普通 Map → deadline computed 缓存首屏空值 → 读秒恒为 0，
// 真机出现过），抽成不依赖组件上下文与 IPC 运行时的单元后可用 node:test 直接上锁。
// 注意 getSessionId 必须读响应式源，否则切换会话时三个 computed 不会跟随刷新。
const askStore = createAskQuestionStore(() => options.getSessionId());
const { request: askRequest, deadline: askDeadline, answered: askAnswered } = askStore;

/**
 * 用户在本会话发了新消息 → 清掉「已答摘要」（对话已推进，记录已沉淀进消息流的工具卡片）。
 * **不动**进行中的请求：那会孤儿化扩展侧仍在等待的 Promise（只能等满超时拿 DECLINE）。
 */
function clearAskAnswered(sid: string): void {
  askStore.clearAnswered(sid);
}

/**
 * 已答摘要自动收起（面板折叠关闭）—— `AskUserQuestionPanel` 在摘要亮完后
 * `emit('dismiss')` 请求执行。收起后该轮摘要不会再显示（含迟到的 `tool.completed`）。
 */
function dismissAskAnswered(): void {
  const sid = options.getSessionId();
  if (sid === null) return;
  askStore.dismissAnswered(sid);
}

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

  /** 从 ConversationMessage（role=tool）构造 ToolDiff 列表（edit 多 hunk 逐块一项；
   *  入参形状判定共享 parseFileToolInput：pi 真实 {path,edits}/{path,content} 与旧形状全兼容） */
  function toToolDiffs(message: ConversationMessage): ToolDiff[] {
    const parsed = parseFileToolInput(message.input);
    if (!parsed) return [];
    const idBase = message.toolEventId ?? message.ts;
    return parsed.parts.map((part, i) => ({
      id: `${idBase}-${i}`,
      filePath: parsed.path,
      oldString: part.oldText,
      newString: part.newText,
    }));
  }

  function groupDiffs(tools: ConversationMessage[]): ToolDiff[] {
    return tools.flatMap(toToolDiffs);
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
    // 改动文件汇总：按轮收集成功的 edit/write 工具（键位 = 轮末位置，见 collectTurnChangedFiles）
    const turnFiles = collectTurnChangedFiles(msgs);
    const pushFilesSummary = (pos: number): void => {
      const summary = turnFiles.get(pos);
      if (summary) out.push({ key: summary.key, kind: 'files-summary', summary });
    };
    let i = 0;
    while (i < msgs.length) {
      const cur = msgs[i]!;
      if (cur.role !== 'tool') {
        // 轮末插入点：上一轮的汇总卡片排在下一条 user 消息之前
        if (cur.role === 'user') pushFilesSummary(i);
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
    // 轮末插入点（末轮）：流式中轮未结束时汇总卡片始终位于消息流末尾
    pushFilesSummary(msgs.length);
    return out;
  });

  function toggleGroup(key: string): void {
    const cur = toolGroupCollapsed.get(key);
    toolGroupCollapsed.set(key, !(cur ?? true));
  }

  // ===== 历史窗口化（v3.74 首帧卡顿：点大会话 221 项全量挂载 ≈ 4.3s 冻结主线程） =====
  //
  // 策略：点击会话后用户第一眼在**底部**（最新消息），故首帧只挂载尾部若干展示项，
  // 上方向上滚动时按批补挂（配合 scrollHeight 锚定，见 ConversationView.maybeExpandHistoryWindow）。
  // 聚合结构（工具组 / 轮次 footer / 改动文件汇总）都在 displayItems 内基于**完整** msgs
  // 计算完成，窗口只在展示层截断，不会拆散任何组。被窗口滑出再滚回的消息重挂载时，
  // renderMarkdown 内容寻址缓存命中（≈0ms），不会二次付出解析成本。
  // 流式新消息天然落在窗口尾（slice 取尾部），无需特殊处理。
  const HISTORY_INITIAL_ITEMS = 24;
  const HISTORY_STEP_ITEMS = 16;

  const historyWindow = ref<number>(HISTORY_INITIAL_ITEMS);
  /** 尾部窗口化后的展示项；窗口盖满时与 displayItems 同一引用（避免多余 patch） */
  const windowedItems = computed<DisplayItem[]>(() => {
    const items = displayItems.value;
    if (items.length <= historyWindow.value) return items;
    return items.slice(items.length - historyWindow.value);
  });
  /** 窗口外的起始位置（displayItems 索引）：小于它的展示项尚未挂载 */
  const windowStartIndex = computed(() =>
    displayItems.value.length <= historyWindow.value ? 0 : displayItems.value.length - historyWindow.value,
  );
  /** 仍有展示项被截断在窗口外（向上滚动扩展的依据；false 后可移除滚动监听分支） */
  const historyWindowTruncated = computed(() => displayItems.value.length > historyWindow.value);

  /** 向上触顶时扩一批；返回是否有变化（供视图决定是否做滚动锚定） */
  function expandHistoryWindow(): boolean {
    if (!historyWindowTruncated.value) return false;
    historyWindow.value += HISTORY_STEP_ITEMS;
    return true;
  }

  /**
   * 时间轴定位目标在窗口外时，扩窗到「该消息起往后全挂载」。
   * 目标 user 消息及其后的内容都要可见（回看模式向上翻页需要）。
   * @returns 窗口是否发生变化（调用方据此等待 patch 后再查 DOM）
   */
  function expandHistoryWindowTo(index: number): boolean {
    if (index >= windowStartIndex.value) return false;
    const remaining = displayItems.value.length - index;
    if (remaining > historyWindow.value) historyWindow.value = remaining + 8;
    return true;
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
        // 窗口重置：新加载的历史首帧只挂尾部（首帧卡顿优化）
        historyWindow.value = HISTORY_INITIAL_ITEMS;
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
   * queueBySession 不清：队列镜像按事件全量维护，切走再切回徽标不丢（CV-S09）；
   * todoSnapshots 不清：按 sessionId 隔离，切回历史会话还原上次的 todo 视图（CV-S11 修正） */
  function resetForSession(): void {
    messages.value = [];
    toolEventIndex.clear();
    toolGroupCollapsed.clear();
    historyWindow.value = HISTORY_INITIAL_ITEMS;
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
    clearAskAnswered(sid);
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
      clearAskAnswered(p.sessionId);
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

  // ===== 问卷（Path 2 ask_user_question）=====

  /**
   * 问卷请求到达（`conversation.askUserQuestionRequested`，契约 §4.4）。
   *
   * 会话隔离（三条硬约束之一）：**载荷必须带 `sessionId`**，且只有与本窗格会话一致
   * 才认领 —— 缺 sessionId 一律忽略，**不做**「无 sessionId 归当前会话」的兜底
   * （tool 事件的兜底在这里会变成「多窗格各弹一份问卷」）。
   *
   * 倒计时记**绝对截止时刻**而非让面板自己起算：面板随会话切换会重新挂载，若每次
   * 重新起算，切走再切回会把倒计时拉长到超过扩展侧 `timeoutMs + graceMs` 真超时，
   * 归零回填时 extension 早已收敛（作答被丢弃）。绝对时刻下剩余秒数连续。
   */
  function onAskUserQuestionRequested(payload: unknown): void {
    const p = payload as AskUserQuestionRequestPayload;
    if (typeof p?.sessionId !== 'string' || p.sessionId === '') return;
    if (typeof p.requestId !== 'string' || p.requestId === '') return;
    if (!Array.isArray(p.questions) || p.questions.length === 0) return;
    if (typeof p.timeoutMs !== 'number' || !Number.isFinite(p.timeoutMs) || p.timeoutMs <= 0) return;
    if (p.sessionId !== options.getSessionId()) return;
    askStore.accept(p);
  }

  /**
   * 面板提交（用户点提交 / 取消 / 倒计时归零自查）：回填 extension 侧等待中的 Promise。
   *
   * 回填带 `sessionId + requestId`，main 侧以二者匹配该会话的 lease（契约 §4.4 ③）。
   * `delivered=false`（会话已删 / 无 lease / 请求已超时收敛）表示作答被丢弃、模型将收到
   * `DECLINE` —— 此时摘要**据实标「已取消」**，不显示一个并不存在的成功。
   *
   * 收尾是**乐观**的：先本地折成已答摘要（面板立刻从交互态切走），`tool.completed`
   * 到达后再用权威 `details` 覆盖。
   */
  async function submitAskUserAnswers(payload: {
    answers: AskUserQuestionAnswer[];
    cancelled: boolean;
    globalNote?: string;
  }): Promise<void> {
    const sid = options.getSessionId();
    if (sid === null) return;
    const current = askStore.requestOf(sid);
    if (current === undefined) return; // 已被 tool.completed 收尾 / 非本会话
    const questions = askStore.questionsOf(sid) ?? current.questions;
    let delivered = false;
    try {
      const res = await replyAskUserQuestion({
        sessionId: sid,
        requestId: current.requestId,
        answers: payload.answers,
        cancelled: payload.cancelled,
        ...(payload.globalNote !== undefined ? { globalNote: payload.globalNote } : {}),
      });
      delivered = res.delivered;
    } catch (e) {
      console.warn('[ask_user_question] 回填失败', e);
    }
    // 「用户点了提交、答案却没送到」才算失败。用户自己点取消、或倒计时归零（那条路径
    // 也会主动回填已答部分）都属于交互正常结束，不能混为一谈 —— 后者若被判成失败，
    // 面板会留下永不自动收起的过期卡片。
    const deliveryFailed = !payload.cancelled && !delivered;
    askStore.settle(sid, {
      answers: payload.answers,
      cancelled: payload.cancelled || !delivered,
      deliveryFailed,
      questions,
      ...(payload.globalNote !== undefined ? { globalNote: payload.globalNote } : {}),
    });
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
      tool?: { name?: string };
      result?: { text: string | null; details?: unknown };
      summary?: string;
    };
    if (p.sessionId !== undefined && p.sessionId !== options.getSessionId()) return;
    // CV-S11：仅识别 tool.name === 'todo' 才消费 details（TE-S05 透传）；
    // 非法 details 由 reducer 静默忽略；不依赖 toolEventIndex —— todo 工具可能只发 completed 无 started
    // 按当前 sessionId 读写：切到其他会话不影响本会话 todo，本会话 todo 也不会串到其他会话
    if (p.tool?.name === 'todo') {
      const sid = options.getSessionId();
      if (sid !== null) {
        const prev = todoSnapshots.get(sid) ?? null;
        const next = applyTodoCompletion(prev, {
          toolName: 'todo',
          details: p.result?.details,
        });
        if (next !== prev) todoSnapshots.set(sid, next);
      }
    }
    // Path 2 ask_user_question：工具返回的 details（{answers,cancelled,globalNote?,error?}）
    // 是「已答摘要」的权威来源。收口三件事：①用 details 覆盖乐观摘要；②清掉进行中
    // 请求（工具已返回 —— 覆盖「面板未挂载/窗口挂载晚」等未走 submit 的路径，避免面板
    // 永久停在交互态）；③释放倒计时。
    if (p.tool?.name === 'ask_user_question') {
      const sid = options.getSessionId();
      if (sid !== null) askStore.applyCompletion(sid, p.result?.details);
    }
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
      // Path 2：问卷请求（载荷带必需 sessionId，本窗格按它认领）
      onAskUserQuestionRequest(onAskUserQuestionRequested),
    ];
  });

  onUnmounted(() => {
    unsubs.forEach((u) => u?.());
    unsubs = [];
    stopElapsed();
  });

  return {
    todoSnapshot,
    // 问卷（Path 2）
    askRequest,
    askDeadline,
    askAnswered,
    submitAskUserAnswers,
    dismissAskAnswered,
    // 状态
    messages,
    isStreaming,
    loadingHistory,
    errorMsg,
    isEmpty,
    displayItems,
    windowedItems,
    historyWindowTruncated,
    expandHistoryWindow,
    expandHistoryWindowTo,
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
