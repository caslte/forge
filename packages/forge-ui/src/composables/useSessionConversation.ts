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
import type { ConversationMessage, SessionStatus, Subagent, ForgeErrorInfo } from '../types.ts';
import type { DisplayItem } from '../components/MessageListItem.vue';
import { computeTurnFooters } from './useTurnFooter.ts';
import { collectTurnChangedFiles } from './useChangedFiles.ts';
import { useStreamPhase } from './useStreamPhase.ts';
import { applyTodoCompletion, applyTerminalCleanup, type TodoSnapshot } from '../utils/todoPanel.ts';
import { createAskQuestionStore, clearAskQuestionSession } from './askQuestionStore.ts';
import { clearTodoPanelSessionState } from './todoPanelUiState.ts';
import { i18n } from '../i18n/index.ts';
import { SUGGEST_NEXT_STEPS_TOOL_NAME } from '../constants.ts';

/** 各会话当前轮次起点（模块级，跨视图实例共享）：切走会话不丢，轮次终态才删 */
const turnStartAt = new Map<string, number>();

/**
 * 各会话待办面板快照（模块级，跨视图实例共享）—— 与 turnStartAt 同一取舍。
 *
 * 为什么必须在模块级：进设置页时 App.vue 用 v-if 整块卸载 ConversationView，
 * 实例级状态随组件一起被 GC，回来时 Map 空 → 待办面板消失。切会话本来就有
 * resetForSession 保护，而「进设置页」是同一种「切走再切回」，语义必须一致。
 *
 * 生命周期 = 渲染进程：重启 APP 随进程消失（不做跨进程持久化，由 design 明确接受），
 * 但开着 APP 期间的任何视图切换（设置页、多窗口聚焦、画布进出）都不丢。
 * 无上限增长由 session.removed 订阅兜底删除（见 onSessionRemoved）。
 */
const todoSnapshots = reactive(new Map<string, TodoSnapshot | null>());

/** 会话被删除：清掉该会话的模块级内存表（快照 / 问卷 / 面板折叠态），避免长会话累积 */
function onSessionRemoved(payload: unknown): void {
  const p = payload as { sessionId?: string };
  if (typeof p?.sessionId !== 'string') return;
  const sid = p.sessionId;
  todoSnapshots.delete(sid);
  clearAskQuestionSession(sid);
  clearTodoPanelSessionState(sid);
}

/**
 * conversation.error 载荷解读（CV-ERR-01）——导出为纯函数以便直接单测。
 *
 * 载荷有两种互斥语义，这是最容易写错的一处：
 * - `retry`：自动重试进行中，**轮次未终止**（不该当错误展示）
 * - `error`：终态错误的结构化分类（横幅数据源）
 * 旧链路（无新字段）只给 message：归为「无分类的终态错误」。
 */
export function interpretErrorPayload(payload: unknown): {
  retry: { attempt: number; maxAttempts: number } | null;
  error: ForgeErrorInfo | null;
  message: string | null;
} {
  const p = payload as {
    message?: string;
    error?: ForgeErrorInfo;
    retry?: { attempt?: number; maxAttempts?: number };
  };
  if (p?.retry !== undefined) {
    return {
      retry: {
        attempt: typeof p.retry.attempt === 'number' ? p.retry.attempt : 0,
        maxAttempts: typeof p.retry.maxAttempts === 'number' ? p.retry.maxAttempts : 0,
      },
      error: null,
      message: p.message ?? null,
    };
  }
  return { retry: null, error: p?.error ?? null, message: p?.message ?? null };
}

/** 错误横幅三件套的快照（errorMsg / errorInfo / retryInfo） */
export interface ErrorBannerState {
  message: string | null;
  info: ForgeErrorInfo | null;
  retry: { attempt: number; maxAttempts: number } | null;
}

/**
 * 错误横幅状态机（纯函数，横幅三件套的唯一改写处）。
 *
 * 「恢复」的定义（新轮次起点 = streaming）：main 侧在自动重试开始时会先把状态从
 * error 改回 streaming（红点回进行中），此前那条终态错误横幅如果还挂着，就会
 * 在「重试正在跑 / 已经跑通」的整个过程中一直显示在对话底部 —— 用户看到的就是
 * 「错过一次就永远挂着，恢复了也不消失」。因此 streaming 与轮次正常终态
 * （done/idle/canceled）一样清空；只有 status='error' 保留，等下一次发送/重试替换。
 *
 * retry 事件与 error 分类互斥：重试中轮次未终止，横幅（v-if）会盖住重试进度条
 * （v-else-if），两者同时存在时用户只看到旧错误。
 */
export function reduceErrorBanner(
  cur: ErrorBannerState,
  input:
    | { kind: 'status'; status: string }
    | { kind: 'event'; payload: unknown; fallbackMessage: string },
): ErrorBannerState {
  if (input.kind === 'status') {
    if (input.status === 'error') return cur;
    return { message: null, info: null, retry: null };
  }
  const { retry, error, message } = interpretErrorPayload(input.payload);
  if (retry !== null) return { message: null, info: null, retry };
  return { message: message ?? input.fallbackMessage, info: error, retry: null };
}

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
  /** CV-ERR-01：终态错误的结构化分类（结论/色调/是否可重试）。
   *  与 errorMsg 同生命周期：errorMsg 保留为本机/RPC 层失败（无分类）的通道，
   *  有分类时以本字段为准（errorMsg 此时 === error.raw）。 */
  const errorInfo = ref<ForgeErrorInfo | null>(null);
  /** CV-ERR-01：自动重试进行中（轮次未终止）。与 errorInfo 互斥。 */
  const retryInfo = ref<{ attempt: number; maxAttempts: number } | null>(null);

  /** 读/写横幅三件套：所有改写都过 reduceErrorBanner，避免各处口径漂移 */
  function bannerState(): ErrorBannerState {
    return { message: errorMsg.value, info: errorInfo.value, retry: retryInfo.value };
  }
  function applyBannerState(s: ErrorBannerState): void {
    errorMsg.value = s.message;
    errorInfo.value = s.info;
    retryInfo.value = s.retry;
  }

  /** toolEventId -> messages 数组索引，用于 started→completed 聚合 */
  const toolEventIndex = new Map<string, number>();
  /** 工具行 started 到达时刻（ms）：给运行态一个最短可见停留，见 applyToolTerminal */
  const toolStartedAt = new Map<string, number>();
  /** 终态延迟落点定时器：会话重置/卸载时统一清掉 */
  const toolDwellTimers = new Map<string, ReturnType<typeof setTimeout>>();

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

  // ===== Todo 面板快照（CV-S11）=====
  // 表已提到模块级（见文件头 todoSnapshots）：进设置页导致 ConversationView 卸载时不会丢。
  // Map 替代单 ref：切会话不清空，切换回历史会话时还原上次的 todo 视图。
  // "会话自己清理" 不需要主动 GC —— 自然清空（所有 task 被删）时 shouldRenderPanel=false 面板自动卸载。
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
    // 轮次品牌字标：挂在该轮 user 消息之后首个 assistant/tool 展示项头部；
    // user 消息重新置位（每轮一次），压缩分隔条与 suggest 建议消息不消耗
    let brandPending = true;
    const takeBrand = (): boolean => {
      if (!brandPending) return false;
      brandPending = false;
      return true;
    };
    let i = 0;
    while (i < msgs.length) {
      const cur = msgs[i]!;
      // CV-S07 压缩分隔条：compacted 标记不是消息，渲染成分界条——既保留压缩痕迹，
      // 又不会挤占消息卡的位置。摘要全文不外显（2026-09-28 用户反馈），仍留在会话数据里
      if (cur.compacted) {
        out.push({
          key: `compact-${cur.ts}-${i}`,
          kind: 'compaction-divider',
          ts: cur.ts,
        });
        i += 1;
        continue;
      }
      if (cur.role !== 'tool') {
        // 轮末插入点：上一轮的汇总卡片排在下一条 user 消息之前
        if (cur.role === 'user') pushFilesSummary(i);
        const footer = footers.get(i);
        const turnBrand = cur.role === 'assistant' && takeBrand();
        out.push({
          key: itemKey(cur),
          kind: 'message',
          msg: cur,
          idx: i,
          ...(turnBrand ? { turnBrand: true } : {}),
          ...(footer
            ? { showFooter: footer.showFooter, copyText: footer.copyText, firstOfTurn: footer.firstOfTurn }
            : {}),
        });
        if (cur.role === 'user') brandPending = true;
        i += 1;
      } else if (cur.toolName === SUGGEST_NEXT_STEPS_TOOL_NAME) {
        // 契约 I1（v2）：建议工具消息不进消息流，由 turnSuggestion 提升到底部渲染
        i += 1;
      } else {
        const start = i;
        const tools: ConversationMessage[] = [];
        while (
          i < msgs.length &&
          msgs[i]!.role === 'tool' &&
          msgs[i]!.toolName !== SUGGEST_NEXT_STEPS_TOOL_NAME
        ) {
          tools.push(msgs[i]!);
          i += 1;
        }
        if (tools.length >= 2) {
          const first = tools[0]!;
          const groupKey = `${first.toolEventId ?? first.ts}-group`;
          // 尾部组 = 正在执行的组：默认展开；其后有新消息到达即视为历史组，默认折叠。
          // 用户手动开合过（Map 有记录）则只跟随用户操作。
          const collapsed = toolGroupCollapsed.get(groupKey) ?? !(i === msgs.length);
          const turnBrand = takeBrand();
          out.push({
            key: groupKey,
            kind: 'tool-group',
            tools,
            totalCount: tools.length,
            collapsed,
            ...(turnBrand ? { turnBrand: true } : {}),
          });
        } else {
          for (let j = 0; j < tools.length; j += 1) {
            const tm = tools[j]!;
            const turnBrand = takeBrand();
            out.push({ key: itemKey(tm), kind: 'message', msg: tm, idx: start + j, ...(turnBrand ? { turnBrand: true } : {}) });
          }
        }
      }
    }
    // 轮末插入点（末轮）：流式中轮未结束时汇总卡片始终位于消息流末尾
    pushFilesSummary(msgs.length);
    return out;
  });

  /** currentCollapsed 为渲染层解析后的折叠态（含默认值）；用户意图 = 其反，记录后不再漂移 */
  function toggleGroup(key: string, currentCollapsed: boolean): void {
    toolGroupCollapsed.set(key, !currentCollapsed);
  }

  /**
   * 最新一轮的下一步建议（契约 I1 v2：锚定会话底部，不入流）。
   * 口径：最后一条 user 消息**之后**最后出现的 suggest 工具消息且 status=completed；
   * 用户发出新一轮后旧芯片自动消失（与成熟产品「建议只跟随当前轮」一致）。
   */
  const turnSuggestion = computed<ConversationMessage | null>(() => {
    const msgs = messages.value;
    let lastUser = -1;
    for (let i = msgs.length - 1; i >= 0; i -= 1) {
      if (msgs[i]!.role === 'user') {
        lastUser = i;
        break;
      }
    }
    for (let i = msgs.length - 1; i > lastUser; i -= 1) {
      const m = msgs[i]!;
      if (m.role === 'tool' && m.toolName === SUGGEST_NEXT_STEPS_TOOL_NAME) {
        return m.status === 'completed' ? m : null;
      }
    }
    return null;
  });

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
  /** 时间轴定位时目标上方的余量（展示项）：避免目标贴窗口首项、动画一结束就撞上触顶补挂 */
  const HISTORY_LOCATE_HEADROOM = 8;

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

  /** 消息索引（messages 序）→ 展示项索引（displayItems 序）；工具组内无单条消息故 -1 */
  function displayIndexOfMessage(messageIndex: number): number {
    const items = displayItems.value;
    for (let i = 0; i < items.length; i += 1) {
      const it = items[i];
      if (!it || it.kind !== 'message') continue;
      if (it.idx >= messageIndex) return i;
    }
    return -1;
  }

  /**
   * 时间轴定位：把窗口扩到「目标之上再留 HISTORY_LOCATE_HEADROOM 项、目标及其后全挂载」。
   * 目标 user 消息及其后的内容都要可见（回看模式向上翻页需要）；留一点上方余量是必要的——
   * 目标贴住窗口首项时，平滑滚动必然途经顶部，动画一结束就撞上「向上触顶补挂历史」，
   * 补挂的锚定又会把视口拽走（长会话里点靠前条目必现）。
   *
   * 入参是 **messages 数组索引**，而窗口是按 **displayItems 展示项** 切的（工具聚合成组后
   * 两者不再同序）。这里必须先换算成展示项索引再比较/换算长度——直接拿消息索引和
   * windowStartIndex 比会在长会话里误判「目标已挂载」，点击时间线条目落到别的轮次上。
   * @returns 窗口是否发生变化（调用方据此等待 patch 后再查 DOM）
   */
  function expandHistoryWindowTo(messageIndex: number): boolean {
    const target = displayIndexOfMessage(messageIndex);
    if (target < 0) return false;
    const want = Math.max(0, target - HISTORY_LOCATE_HEADROOM);
    if (want >= windowStartIndex.value) return false;
    const remaining = displayItems.value.length - want;
    if (remaining > historyWindow.value) historyWindow.value = remaining + 8;
    return true;
  }

  /**
   * 该 user 消息在**当前已挂载窗口**内的 DOM 序（0 起），供视图 querySelectorAll('.msg-user')
   * 取节点。窗口截断时全量序会与 DOM 序错位（上方轮次未挂载），故只数窗口内、且在目标之前的
   * user 消息。目标未挂载 → -1。
   */
  function userOrdinalInWindow(messageIndex: number): number {
    const items = windowedItems.value;
    let n = 0;
    for (const it of items) {
      if (it.kind !== 'message' || it.msg.role !== 'user') continue;
      if (it.idx === messageIndex) return n;
      n += 1;
    }
    return -1;
  }

  // ===== 历史加载 / 会话切换 =====

  /** 加载历史消息 */
  async function loadHistory(): Promise<void> {
    const sid = options.getSessionId();
    if (sid === null) return; // 草稿态无会话，无需加载
    loadingHistory.value = true;
    // 三件套一起清：只清 errorMsg 会把 errorInfo 留在横幅里（errorBanner 只看 errorInfo），
    // 切会话/重拉历史后旧错误就永久挂在新会话底部。下方 getLastError 路径按需恢复。
    applyBannerState(reduceErrorBanner(bannerState(), { kind: 'status', status: 'idle' }));
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
        const res = await call<{ message: string | null; error?: ForgeErrorInfo | null }>(
          'conversation/getLastError',
          { sessionId: sid },
        );
        if (sid === options.getSessionId() && res.message) {
          errorMsg.value = res.message;
          errorInfo.value = res.error ?? null;
          retryInfo.value = null;
        }
      } catch {
        // 静默降级：不显示横幅即可
      }
    }
  }

  /** 会话切换：重置状态（视图侧的回看模式/高亮等由视图自理）；
   * queueBySession 不清：队列镜像按事件全量维护，切走再切回徽标不丢（CV-S09）；
   * todoSnapshots 不清：按 sessionId 隔离，切回历史会话还原上次的 todo 视图（CV-S11 修正） */
  function resetForSession(): void {
    // 平滑缓冲按会话隔离，切走后旧会话缓冲作废（权威内容以历史/最终消息为准）
    smoothPending.clear();
    stopSmoothTimer();
    messages.value = [];
    toolEventIndex.clear();
    toolStartedAt.clear();
    for (const t of toolDwellTimers.values()) clearTimeout(t);
    toolDwellTimers.clear();
    toolGroupCollapsed.clear();
    historyWindow.value = HISTORY_INITIAL_ITEMS;
    isStreaming.value = false;
    loadingHistory.value = false;
    applyBannerState(reduceErrorBanner(bannerState(), { kind: 'status', status: 'idle' }));
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
    applyBannerState(reduceErrorBanner(bannerState(), { kind: 'status', status: 'streaming' }));
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

  /**
   * ⚡立即发送（CV-S09 队列编辑，打断语义）：中止当前轮并直发队列第 index 条。
   * user 气泡必须 UI 本地补——直发路径的气泡由本层渲染（后端只在「队列派发确认」
   * 时转发 user 气泡，直发起点会清空 pendingDelivery 不转发），不补的话对话区
   * 会出现「回复凭空提到没发过的消息」。流式读秒/阶段由 statusChanged(streaming)
   * 事件（新轮次起点）自动重启，无需在此处理。
   */
  async function sendQueuedNow(index: number): Promise<void> {
    const sid = options.getSessionId();
    const t = queueItems.value[index]?.trim();
    if (!t || sid === null) return;
    applyBannerState(reduceErrorBanner(bannerState(), { kind: 'status', status: 'streaming' }));
    messages.value.push({ role: 'user', content: t, ts: new Date().toISOString() });
    scheduleScroll();
    try {
      await call<null>('conversation/queueSendNow', { sessionId: sid, index });
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : String(e);
    }
  }

  /**
   * 「立即重试」：重发本会话最后一条用户消息（CV-ERR-01）。
   *
   * 为什么是“重发”而不是“回退”：pi 只提供 prompt/followUp（都是新的一轮），
   * 没有“重跑上一轮”的原语。因此重试在历史里会多出一条相同的用户消息 ——
   * 这是重试语义的必然结果，调用方（视图）应在按钮上说明，而不是静默假装没发生过。
   * 找不到用户消息（纯错误场景，如鉴权失败本轮没发消息）或正在流式时为 noop。
   */
  async function retryLastUserMessage(): Promise<void> {
    if (isStreaming.value) return;
    for (let i = messages.value.length - 1; i >= 0; i -= 1) {
      const m = messages.value[i];
      if (m?.role === 'user' && m.content.trim() !== '') {
        await send(m.content);
        return;
      }
    }
  }

  /** 取消流式（CV-S09）：返回被清空的待发队列文本（FIFO 序），供输入框回填。
   *  同时停掉读秒定时器：正常终态会经 statusChanged 停表，但无终态事件时（如调用方
   *  主动中断）也得停，否则定时器空转到会话销毁。 */
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
    // 流式阶段已通过 delta（平滑缓冲）构建了 assistant 占位消息，最终 message 到达时
    // 以其为权威内容覆盖，避免"delta 累积 + 完整消息再推一条"成双；
    // 覆盖前丢掉未放完的平滑缓冲（权威内容已含全部文本，继续放字反而画蛇添足）
    dropSmoothText(p.sessionId);
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

  // ===== 流式平滑输出（打字机）=====
  // delta 不直接上屏：先入按 sessionId 隔离的缓冲，再按帧匀速放出。放字速度随积压
  // 自适应（积压越多追越快），稳态落后约 1/3 秒，观感柔和又不至于越落越远。
  // 缓冲按 sessionId 隔离：终态 flush 补齐尾字，会话切换/重置时丢弃（权威内容以
  // 最终 message 事件与历史记录为准，缓冲只是展示节奏）。
  const SMOOTH_TICK_MS = 16;
  const SMOOTH_MIN_CHARS = 1; // 每 tick 保底输出字符数（最慢速度下限）
  const SMOOTH_MAX_CHARS = 24; // 每 tick 输出上限（积压大时不一次跳一大段）
  const SMOOTH_CATCHUP_DIVISOR = 20; // 放字速度 = 积压 / 该值（自平衡系数）

  const smoothPending = new Map<string, string>();
  let smoothTimer: ReturnType<typeof setInterval> | null = null;

  function stopSmoothTimer(): void {
    if (smoothTimer !== null) {
      clearInterval(smoothTimer);
      smoothTimer = null;
    }
  }

  /** 流式占位消息的稳定 id 序号（口径见 applyDeltaText） */
  let streamMsgSeq = 0;

  /** delta 文本真正落到消息流（原 onDelta 的追加逻辑） */
  function applyDeltaText(text: string): void {
    // 流式追加到最后一条 assistant 消息；无则新建
    const last = messages.value[messages.value.length - 1];
    if (last && last.role === 'assistant') {
      last.content += text;
    } else {
      // 占位必须带稳定 id：终态 message 事件会用「消息完成时刻」覆盖 ts，而列表 key
      // 取 `ts-role`，key 一变 Vue 就重挂整张卡（入场动画重播 + hljs/mermaid/画布
      // iframe 子树重建），观感即「回复完成时刷一下」。有 id 后 key 与 ts 解耦。
      streamMsgSeq += 1;
      messages.value.push({
        role: 'assistant',
        content: text,
        ts: new Date().toISOString(),
        id: `stream-${streamMsgSeq}`,
      });
    }
    scheduleScroll();
  }

  function drainSmooth(): void {
    const sid = options.getSessionId();
    if (sid === null) {
      stopSmoothTimer();
      return;
    }
    const pending = smoothPending.get(sid);
    if (pending === undefined || pending === '') {
      smoothPending.delete(sid);
      stopSmoothTimer();
      return;
    }
    const take = Math.min(
      pending.length,
      Math.min(
        SMOOTH_MAX_CHARS,
        Math.max(SMOOTH_MIN_CHARS, Math.ceil(pending.length / SMOOTH_CATCHUP_DIVISOR)),
      ),
    );
    smoothPending.set(sid, pending.slice(take));
    applyDeltaText(pending.slice(0, take));
  }

  function enqueueSmoothText(sid: string, text: string): void {
    smoothPending.set(sid, (smoothPending.get(sid) ?? '') + text);
    if (smoothTimer === null) smoothTimer = setInterval(drainSmooth, SMOOTH_TICK_MS);
  }

  /** 轮次终态：把缓冲里剩下的字一次补齐上屏（取消/出错也不丢已生成内容） */
  function flushSmoothText(sid: string): void {
    const pending = smoothPending.get(sid);
    smoothPending.delete(sid);
    if (pending !== undefined && pending !== '' && sid === options.getSessionId()) {
      applyDeltaText(pending);
    }
    if (smoothPending.size === 0) stopSmoothTimer();
  }

  /** 权威内容到达（最终 message）/ 会话重置：缓冲作废（权威内容覆盖展示缓冲） */
  function dropSmoothText(sid: string): void {
    smoothPending.delete(sid);
    if (smoothPending.size === 0) stopSmoothTimer();
  }

  function onDelta(payload: unknown): void {
    // 契约：delta 为 { text, kind: 'text' }（docs/api/03_conversation.md §3）
    const p = payload as { sessionId: string; delta: { text?: string } | string };
    if (p.sessionId !== options.getSessionId()) return;
    const text = typeof p.delta === 'string' ? p.delta : (p.delta.text ?? '');
    if (text === '') return;
    markOutputting();
    enqueueSmoothText(p.sessionId, text);
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
      // 新轮次起点 = 恢复：清掉上一轮残留的错误横幅/重试进度
      //（自动重试开始时 main 会把状态改回 streaming，此前那条终态错误必须让位）
      applyBannerState(reduceErrorBanner(bannerState(), { kind: 'status', status: 'streaming' }));
    } else if (p.status === 'done' || p.status === 'idle' || p.status === 'canceled' || p.status === 'error') {
      // 轮次终态：缓冲里剩余的文本一次补齐上屏（取消/出错也不丢已生成内容）
      flushSmoothText(p.sessionId);
      turnStartAt.delete(p.sessionId);
      stopElapsed();
      isStreaming.value = false;
      // 轮次终态后清错误横幅（自动重试提示同样经 conversation.error 展示，随轮次结束消失）；
      // status='error' 是例外——保留到「新轮次起点/下一次发送/重试」再替换（见 reduceErrorBanner）
      applyBannerState(reduceErrorBanner(bannerState(), { kind: 'status', status: p.status }));
      // CV-S11 兜底：会话终态时把残留的 in_progress 标为 completed，避免 TodoPanel
      // 永远挂着呼吸点。快照按 sessionId 隔离，只动当前会话。无可恢复快照时 noop。
      const prevSnap = todoSnapshots.get(p.sessionId) ?? null;
      const nextSnap = applyTerminalCleanup(prevSnap);
      if (nextSnap !== prevSnap) todoSnapshots.set(p.sessionId, nextSnap);
    }
  }

  function onError(payload: unknown): void {
    const p = payload as { sessionId: string; code?: number };
    if (p.sessionId !== options.getSessionId()) return;
    // 不在此处置 isStreaming=false：终态错误必伴随 status='error' 事件收尾；
    // conversation.error 还承载自动重试提示（轮次仍在 streaming），此处置假会误断进行中状态
    // CV-ERR-01：retry 与 error 互斥——前者是「轮次还在跑，正在重试」，
    // 不是错误，UI 要显示进度而不是红色横幅（否则重试成功也留着一条红字）。
    applyBannerState(
      reduceErrorBanner(bannerState(), {
        kind: 'event',
        payload,
        fallbackMessage: i18n.t('chat.conversationError', { code: p.code ?? 'unknown' }),
      }),
    );
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
    toolStartedAt.set(p.toolEventId, Date.now());
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

  /** 「进行中」态最短可见停留（ms）：快工具 started/completed 可能同帧背靠背，spinner 还没来得及被看到就被终态顶掉 */
  const TOOL_MIN_DWELL_MS = 300;

  /** 终态（completed/error）落点：不足最短停留时间则延迟改状态；到点时按 id 重查，会话已切走/已重置则静默丢弃 */
  function applyToolTerminal(toolEventId: string, mutate: (msg: ConversationMessage) => void): void {
    const run = (): void => {
      toolDwellTimers.delete(toolEventId);
      const idx = toolEventIndex.get(toolEventId);
      const msg = idx === undefined ? undefined : messages.value[idx];
      if (!msg || msg.status !== 'started') return;
      mutate(msg);
    };
    const startedAt = toolStartedAt.get(toolEventId);
    const wait = startedAt === undefined ? 0 : TOOL_MIN_DWELL_MS - (Date.now() - startedAt);
    toolStartedAt.delete(toolEventId);
    if (wait > 0) {
      toolDwellTimers.set(toolEventId, setTimeout(run, wait));
      return;
    }
    run();
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
    if (!toolEventIndex.has(p.toolEventId)) return;
    markToolEnd(p.toolEventId);
    // 真实后端为 result:{text}，summary 为 mock/旧格式兼容
    const text = p.result?.text ?? p.summary;
    applyToolTerminal(p.toolEventId, (msg) => {
      msg.status = 'completed';
      if (text) msg.content = text;
    });
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
    if (!toolEventIndex.has(p.toolEventId)) return;
    markToolEnd(p.toolEventId);
    // 真实后端为 error:{message}，summary/message 为 mock/旧格式兼容
    const text = p.error?.message ?? p.summary ?? p.message;
    applyToolTerminal(p.toolEventId, (msg) => {
      msg.status = 'error';
      if (text) msg.content = text;
    });
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
      // 模块级内存表的回收口：会话删除后不再保留其快照 / 问卷 / 面板折叠态
      subscribe('session.removed', onSessionRemoved),
    ];
  });

  onUnmounted(() => {
    unsubs.forEach((u) => u?.());
    unsubs = [];
    stopElapsed();
    smoothPending.clear();
    stopSmoothTimer();
    for (const t of toolDwellTimers.values()) clearTimeout(t);
    toolDwellTimers.clear();
    toolStartedAt.clear();
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
    errorInfo,
    retryInfo,
    retryLastUserMessage,
    isEmpty,
    displayItems,
    turnSuggestion,
    windowedItems,
    historyWindowTruncated,
    expandHistoryWindow,
    expandHistoryWindowTo,
    userOrdinalInWindow,
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
    sendQueuedNow,
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
