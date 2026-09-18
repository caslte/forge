<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { call } from '../bridge';
import type { ProjectItem, SessionItem, ProjectPickerDescriptor } from '../types';
import InstructionInput from './InstructionInput.vue';
import TodoPanel from './TodoPanel.vue';
import AskUserQuestionPanel from './AskUserQuestionPanel.vue';
import MessageListItem from './MessageListItem.vue';
import ConversationTimelineRail from './ConversationTimelineRail.vue';
import ConversationHistoryPopover from './ConversationHistoryPopover.vue';
import SubagentTabBar from './SubagentTabBar.vue';
import SubagentResultView from './SubagentResultView.vue';
import { useCompactBanner } from '../composables/useCompactBanner';
import { usePreferences } from '../composables/usePreferences';
import { useSessionConversation } from '../composables/useSessionConversation';
import { buildRoundSnapshot, type RoundSnapshot } from '../utils/conversationTimeline';
import { solvePopoverPosition, type Rect } from '../utils/popoverPosition';
import { createReviewModeController, type ReviewModeState } from '../utils/reviewMode';
import { formatElapsed } from '../utils/formatElapsed.ts';

/**
 * 对话主视图。
 * 模块 06：子 Agent Tab 栏 + 结果视图。Tab 栏仅在会话内存态含子 agent 时渲染；
 * 切换 Tab 时消息区 v-show 互斥（不销毁 DOM，切回主会话消息流与滚动位置原样恢复）。
 *
 * 其他职责与原文档一致。
 */
const props = defineProps<{
  /** 草稿态（新建会话尚未发送首条消息）时为 null；发送首条消息时先创建会话再发送 */
  sessionId: string | null;
  project: ProjectItem;
  session: SessionItem | null;
  models: string[];
  currentModel: string | null;
  /** 项目选择器描述（SM-S01 v3.21）：上层组装，透传给输入框；不传则不渲染 */
  projectPicker?: ProjectPickerDescriptor;
  /** 项目忙（任一会话 streaming，PM-S05 AC-PM-016）：透传给分支徽标禁用 */
  gitBusy?: boolean;
}>();

const emit = defineEmits<{
  (e: 'model-change', model: string): void;
  /** 草稿态发送首条消息时已创建会话，通知上层绑定当前会话 */
  (e: 'session-created', sessionId: string): void;
  (e: 'pick-project', path: string): void;
  (e: 'open-project-picker'): void;
  (e: 'remove-project', path: string): void;
}>();

/**
 * 草稿态发送首条消息时本次创建的会话 id：
 * 上层绑定 currentSessionId 后 props 变化，据此跳过 reset+reload（消息流已在本地）。
 */
let createdSessionId: string | null = null;

/**
 * 共享单会话状态机（与多窗口 MultiWindowConversation 同一份实现）：
 * 消息流 / 流式状态 / 工具事件聚合 / 子 Agent。本视图只保留壳层差异
 * （时间线回看、历史浮窗、草稿建会话、模型横幅）。
 */
const {
  messages,
  isStreaming,
  loadingHistory,
  errorMsg,
  todoSnapshot,
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
  resetForSession: resetConvForSession,
  loadHistory,
  send: sendTurn,
  cancel: cancelTurn,
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
  askRequest,
  askDeadline,
  askAnswered,
  submitAskUserAnswers,
  dismissAskAnswered,
} = useSessionConversation({
  getSessionId: () => props.sessionId ?? createdSessionId,
  getStatusHint: () => props.session?.status,
  scrollToBottom: () => autoScrollToBottom(),
});

/**
 * 上下文压缩横幅（内存持久，按 sessionId 隔离）：压缩中「正在压缩上下文…」，
 * 完成「上下文已压缩（减少 x%）」。切换会话再回来仍保留；重启 App 丢失。
 * 状态由 InstructionInput 的事件订阅 / 压缩点击统一维护，视图只读渲染。
 */
const { getBanner: getCompactBanner } = useCompactBanner();
/** 个性化：对话框 diff 展示开关（设置页个性化 Tab，localStorage 持久） */
const { showDiff } = usePreferences();
const compactBanner = computed(() => getCompactBanner(props.sessionId));
const scrollRef = ref<HTMLElement | null>(null);
const inputRef = ref<InstanceType<typeof InstructionInput> | null>(null);

/** 会话切换：重置共享状态机并清视图侧回看态 */
function resetForSession(): void {
  resetConvForSession();
  // 回看模式随会话切换重置为浏览模式（AC-CV-016），定位高亮一并清理
  reviewCtrl.reset();
  syncReview();
  clearLocateHighlight();
}

/** 滚动到底部：覆盖 smooth 做瞬时定位，下一帧再补一次；长内容快速到达最后一条回复 */
function scrollToBottom(): void {
  const el = scrollRef.value;
  if (!el) return;
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    if (scrollRef.value !== el) return;
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prev;
  });
}

/** 发送消息：草稿态（未发首条消息）先真正创建会话再发送（状态机在 useSessionConversation） */
/** 停止当前轮（CV-S09）：被清空的待发队列文本回填输入框（pi TUI ESC 同款） */
async function onCancelTurn(): Promise<void> {
  const cleared = await cancelTurn();
  if (cleared.length > 0) inputRef.value?.restoreQueuedText(cleared);
}

async function onSend(text: string): Promise<void> {
  if (props.sessionId === null) {
    try {
      const res = await call<{ session: { sessionId: string } }>('session/createSession', {
        projectPath: props.project.path,
      });
      const sid = res.session.sessionId;
      createdSessionId = sid;
      // 创建会话前捕获当前展示模型（全局默认或草稿态已切换），随后写入会话覆盖，
      // 保证首条消息按用户所见模型发送（写覆盖失败不阻塞，回退全局默认）
      const draftModel = props.currentModel;
      // 草稿态思考级别（继承全局默认的回显或用户已选）：先于 session-created 写入会话覆盖，
      // 保证首条消息按输入框所示级别发送，且避免与输入框对 sid 的级别查询竞态
      // （写覆盖失败不阻塞，回退全局默认）
      const draftLevel = inputRef.value?.currentLevel ?? null;
      if (draftLevel) {
        await call('model/setSessionThinkingLevel', { sessionId: sid, level: draftLevel }).catch(
          (e) => {
            console.warn('[draft] 写入会话思考级别失败，回退全局默认', e);
          },
        );
      }
      emit('session-created', sid);
      if (draftModel) {
        await call('model/setSessionModel', { sessionId: sid, model: draftModel }).catch((e) => {
          console.warn('[draft] 写入会话模型覆盖失败，回退全局默认', e);
        });
      }
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : String(e);
      return;
    }
  }
  await sendTurn(text);
}

/**
 * 落地 hero 草稿直通（v3.77）：零项目落地页（LandingHero）输入的文本，在项目
 * 打开、本视图挂载后由上层（App post-flush）经此回填草稿输入框，用户无感衔接。
 * 仅草稿态（无会话）接受——带真实 sessionId 时是既有会话，回填会污染其输入框。
 */
function restoreDraft(text: string): void {
  if (props.sessionId !== null) return;
  inputRef.value?.restoreQueuedText([text]);
}

defineExpose({ restoreDraft });

function onModelChange(model: string): void {
  emit('model-change', model);
  showSwitchBanner(model);
}

/** 在对话流底部临时显示"已切换模型"横幅，方便多窗口分辨是哪个窗口切换 */
const switchBanner = ref<string | null>(null);
let switchBannerTimer: ReturnType<typeof setTimeout> | null = null;
function showSwitchBanner(model: string): void {
  switchBanner.value = `已切换模型 ${model}`;
  // 横幅渲染在对话流底部，立即滚动到底部，避免需要手动下拉才能看到
  autoScrollToBottom();
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
  switchBannerTimer = setTimeout(() => {
    switchBanner.value = null;
  }, 2600);
}

// ===== CV-S06 会话提问时间线 =====
/** 渲染前提：当前会话消息流含至少一条 user 消息（无 user 消息/草稿态不渲染，AC-CV-017） */
const hasTimeline = computed(() => messages.value.some((m) => m?.role === 'user'));

// ===== CV-S06 定位与回看模式（AC-CV-016，TD-CV-06） =====
/**
 * 回看模式状态机（纯函数，utils/reviewMode）：
 * - 点击条目 enter(index) → review（autoFollow=false）：流式 delta/新消息不再强制滚底；
 * - 滚动触底（距底 <40px，去抖停稳判定）或点击"回到底部"提示条 → exit → browse（autoFollow=true）；
 * - 会话切换 resetForSession → reset() 回浏览模式。
 */
const reviewCtrl = createReviewModeController();
const reviewState = ref<ReviewModeState>(reviewCtrl.getState());

function syncReview(): void {
  reviewState.value = reviewCtrl.getState();
}

/** 自动滚底统一门控：回看模式（autoFollow=false）下流式增量/新消息不强制滚底（AC-CV-016） */
const autoFollow = computed(() => reviewState.value.autoFollow);
const isReviewing = computed(() => reviewState.value.mode === 'review');
/** 回看态定位目标（Rail 条目弱高亮用）；browse 态为 null */
const reviewTargetIndex = computed(() =>
  reviewState.value.mode === 'review' ? reviewState.value.targetIndex : null,
);

function autoScrollToBottom(): void {
  if (!autoFollow.value) return;
  nextTick(scrollToBottom);
}

/** 定位高亮持续时长（短暂高亮提示，超时移除 class） */
const LOCATE_HIGHLIGHT_MS = 1500;
/** 触底判定距离（距底 <40px 视为触底） */
const NEAR_BOTTOM_PX = 40;
/** 触底判定去抖：滚动停稳后仍触底才判定（定位平滑滚动途中路过底部不误判退出） */
const NEAR_BOTTOM_DEBOUNCE_MS = 120;
/** 定位后触底抑制窗口：定位平滑滚动结束若贴近底部（目标靠后时被钳制在底部附近），
 *  属于程序化定位而非"手动滚到底"，窗口内触底信号不退出回看（否则选中突出立即丢失） */
const LOCATE_NEAR_BOTTOM_SUPPRESS_MS = 800;

let highlightTimer: ReturnType<typeof setTimeout> | null = null;
let highlightedMsgEl: HTMLElement | null = null;
let nearBottomTimer: ReturnType<typeof setTimeout> | null = null;
/** 最近一次定位进入回看的时刻（触底抑制窗口起点） */
let lastLocateAt = 0;

function clearLocateHighlight(): void {
  if (highlightTimer !== null) {
    clearTimeout(highlightTimer);
    highlightTimer = null;
  }
  if (highlightedMsgEl !== null) {
    highlightedMsgEl.classList.remove('msg-locate-highlight');
    highlightedMsgEl = null;
  }
}

/** messages 数组索引 → 第几条 user 消息（0 起）；索引越界或该位置非 user 返回 -1 */
function userOrdinalOf(index: number): number {
  const msgs = messages.value;
  if (!Number.isInteger(index) || index < 0 || index >= msgs.length) return -1;
  let count = 0;
  for (let i = 0; i <= index; i += 1) {
    if (msgs[i]?.role === 'user') count += 1;
  }
  return count - 1;
}

/**
 * 时间线条目点击：进入回看模式 + 平滑滚动定位到该用户消息 + 短暂高亮（AC-CV-016）。
 * 定位目标是 user 消息本身（.msg-user 按 DOM 顺序与 userOrdinal 对齐），
 * 工具组折叠不影响——user 消息永远渲染可见。
 */
async function locateMessage(index: number): Promise<void> {
  if (showResultView.value) return; // 结果视图激活期间不定位/回看（防御；Rail 本就隐藏）
  const container = scrollRef.value;
  if (!container) return;
  const ordinal = userOrdinalOf(index);
  if (ordinal < 0) return;
  // 目标消息被历史窗口化截断在上方：先扩窗覆盖再等 patch，否则 .msg-user 的
  // DOM 序只覆盖窗口内消息，ordinal 映射会错位（v3.74 窗口化配套）
  if (expandHistoryWindowTo(index)) await nextTick();
  const el = container.querySelectorAll<HTMLElement>('.msg-user')[ordinal] ?? null;
  if (!el) return;
  reviewCtrl.enter(index); // browse→review；review 中重复点击仅更新目标
  syncReview();
  lastLocateAt = Date.now(); // 开启触底抑制窗口（程序化定位滚动 ≠ 手动触底）
  clearLocateHighlight();
  el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  el.classList.add('msg-locate-highlight');
  highlightedMsgEl = el;
  highlightTimer = setTimeout(() => {
    highlightTimer = null;
    highlightedMsgEl?.classList.remove('msg-locate-highlight');
    highlightedMsgEl = null;
  }, LOCATE_HIGHLIGHT_MS);
}

function onTimelineSelect(index: number): void {
  locateMessage(index);
}

/** 触顶判定距离（距顶 <240px 开始向上补挂历史窗口批次） */
const NEAR_TOP_PX = 240;
let expandingWindow = false;

/**
 * 向上接近顶部 → 扩一批历史窗口（v3.74 窗口化）。新批次插在内容区**上方**，
 * 若不补偿 scrollTop，视口内容会瞬间跳动（浏览器保持 scrollTop 数值不变，
 * 内容整体下移）。锚定：记扩窗前的 scrollHeight，patch 完成后把差值补回。
 */
async function maybeExpandHistoryWindow(): Promise<void> {
  const el = scrollRef.value;
  if (el === null || !historyWindowTruncated.value || expandingWindow) return;
  if (el.scrollTop > NEAR_TOP_PX) return;
  expandingWindow = true;
  try {
    const prevHeight = el.scrollHeight;
    if (expandHistoryWindow()) {
      await nextTick();
      if (scrollRef.value === el) el.scrollTop += el.scrollHeight - prevHeight;
    }
  } finally {
    expandingWindow = false;
  }
}

/** scrollRef 滚动：向上触顶扩窗（历史窗口化）+ 回看态停稳触底退出（原有信号） */
function onMessagesScroll(): void {
  void maybeExpandHistoryWindow();
  if (!isReviewing.value) return;
  if (nearBottomTimer !== null) clearTimeout(nearBottomTimer);
  nearBottomTimer = setTimeout(() => {
    nearBottomTimer = null;
    const el = scrollRef.value;
    if (!el || !isReviewing.value) return;
    if (Date.now() - lastLocateAt < LOCATE_NEAR_BOTTOM_SUPPRESS_MS) return; // 定位滚动贴底不退出
    if (el.scrollHeight - el.scrollTop - el.clientHeight < NEAR_BOTTOM_PX) {
      reviewCtrl.nearBottom();
      syncReview();
    }
  }, NEAR_BOTTOM_DEBOUNCE_MS);
}

/** "回到底部"提示条点击：退出回看 + 立即滚到底（AC-CV-016） */
function onBackdownClick(): void {
  reviewCtrl.exit();
  syncReview();
  scrollToBottom();
}

// ===== CV-S06 历史浮窗（AC-CV-015/018） =====
/** 浮窗期望宽（PRD：固定宽度约 320px） */
const POPOVER_WIDTH = 320;
/** 渲染前求解用的名义高度（渲染后按实际高度校正 y，仅影响首帧绘制前的内部计算） */
const POPOVER_NOMINAL_HEIGHT = 160;

/** 浮窗状态：snapshot 为**弹出时刻**的一次性快照（流式期间不随 delta 变化） */
const historyPopover = ref<{
  open: boolean;
  x: number;
  y: number;
  width: number;
  snapshot: RoundSnapshot;
  running: boolean;
}>({
  open: false,
  x: 0,
  y: 0,
  width: POPOVER_WIDTH,
  snapshot: { userText: '', assistantText: null },
  running: false,
});

/** 浮窗组件实例（读其根元素实际渲染高度用于二次校正 y） */
const popoverComp = ref<InstanceType<typeof ConversationHistoryPopover> | null>(null);
/** 弹出时刻记录的锚点/视口矩形（渲染后按实际高度二次校正 y 用） */
let popoverAnchor: Rect | null = null;
let popoverViewport: Rect | null = null;

/** 关闭浮窗（移开条目/浮窗或 Esc；v-if 卸载 + 过渡 ≤150ms，无残留 DOM） */
function closeHistoryPopover(): void {
  if (!historyPopover.value.open) return;
  historyPopover.value.open = false;
  popoverAnchor = null;
  popoverViewport = null;
}

/** 按实际渲染高度重解坐标（nextTick 内调用，首帧绘制前完成，无可视跳动） */
function repositionHistoryPopover(): void {
  if (!popoverAnchor || !popoverViewport || !historyPopover.value.open) return;
  const el = popoverComp.value?.rootEl ?? null;
  const measuredHeight = el && el.offsetHeight > 0 ? el.offsetHeight : POPOVER_NOMINAL_HEIGHT;
  const solved = solvePopoverPosition(
    popoverAnchor,
    { width: POPOVER_WIDTH, height: measuredHeight },
    popoverViewport,
  );
  historyPopover.value.x = solved.x;
  historyPopover.value.y = solved.y;
  historyPopover.value.width = solved.width;
}

/** Rail hover（Rail 已做 300ms 防扫过，到时才 emit）：弹出时刻生成快照并求解坐标 */
function onTimelineHover(payload: { index: number; el: HTMLElement }): void {
  const rect = payload.el.getBoundingClientRect();
  popoverAnchor = { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  popoverViewport = {
    x: 0,
    y: 0,
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 800,
  };
  // 快照在弹出时刻生成一次：流式期间内容不随 delta 变化；关闭再 hover 才取新快照
  historyPopover.value.snapshot = buildRoundSnapshot(messages.value, payload.index);
  // running 仅影响无回复时的状态提示：仅"最后一条提问且正在流式"视为运行中，历史轮为等待中/出错
  const lastUserIndex = messages.value.map((m) => m?.role).lastIndexOf('user');
  historyPopover.value.running = isStreaming.value && payload.index === lastUserIndex;
  historyPopover.value.open = true;
  nextTick(repositionHistoryPopover);
}

/** 指针移开条目：立即关闭（Rail 侧计时器由 Rail 自己清理） */
function onTimelineHoverEnd(): void {
  closeHistoryPopover();
}

/** Esc 关闭：仅浮窗打开期间挂全局 keydown（不干扰其他快捷键） */
function onPopoverKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape') return;
  closeHistoryPopover();
}

watch(
  () => historyPopover.value.open,
  (open) => {
    if (open) window.addEventListener('keydown', onPopoverKeydown);
    else window.removeEventListener('keydown', onPopoverKeydown);
  },
);

onMounted(() => {
  // 回看模式触底判定（scrollRef 元素常驻，仅 v-show 切换）
  scrollRef.value?.addEventListener('scroll', onMessagesScroll, { passive: true });
});

onUnmounted(() => {
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
  window.removeEventListener('keydown', onPopoverKeydown);
  // 回看模式清理：触底判定去抖计时器 + 定位高亮
  if (nearBottomTimer !== null) {
    clearTimeout(nearBottomTimer);
    nearBottomTimer = null;
  }
  scrollRef.value?.removeEventListener('scroll', onMessagesScroll);
  clearLocateHighlight();
});

// 会话切换
watch(
  () => props.sessionId,
  (sid) => {
    // 草稿发送时本组件创建的会话：消息流已在本地，回落后的 props 变化直接跳过重置与重载
    if (sid !== null && sid === createdSessionId) {
      createdSessionId = null;
      return;
    }
    resetForSession();
    // 切回仍在流式的会话时恢复流式标记：后端不会对进行中的轮次重发 streaming 事件，
    // 不恢复则"助手正在思考"指示器消失、输入框却仍显示流式中（两处状态源不一致）；
    // 经 restoreStreaming 一并接管读秒启停（同 tick false→true 的 watch 会去致盲）
    restoreStreaming(props.session?.status === 'streaming');
    void loadHistory();
    activeAgentId.value = null; // 切换会话回主会话 Tab
    void loadSubagents();
  },
);

/**
 * ===== 空会话首屏：hero 居中 ↔ 输入框下沉置底 =====
 *
 * 交互：无消息时 hero（巨型 forge 字标 + 标题）与输入框整体垂直居中；首条消息发出后
 * 整体下沉到底部 dock，走 decelerate 缓动，不回弹。
 *
 * 实现约束（改动前务必先理解，否则容易改坏）：
 * 1. InstructionInput 必须始终挂在 .conv-input-wrap 内同一位置，既不迁移也不卸载。
 *    一旦用 <Transition> 在两个容器之间切换 Layout，textarea 焦点、草稿、
 *    InstructionInput 内部的 @ 提及浮窗状态会全部丢失。
 * 2. 位移只由 .conv-input-wrap 的 transform: translateY() 承担。hero 用 absolute
 *    脱离布局，所以 isEmpty 切换不会改变 wrap 自身高度 —— 位移过程因此不会叠加
 *    布局抖动，输入框在 t=0 时刻视觉位置连续。
 */
const viewRef = ref<HTMLElement | null>(null);
const inputWrapRef = ref<HTMLElement | null>(null);
const heroRef = ref<HTMLElement | null>(null);

/** 空态上抬位移（px，负值向上） */
const heroLift = ref(0);
/** false 时禁用一步过渡：首帧不要从底部「滑」到中间 */
const heroLiftReady = ref(false);

/**
 * 求让「hero + 输入框」整体垂直居中所需的位移。
 * hero 是 wrap 的 absolute 子元素，会随 wrap 一起被 transform 带走，
 * 所以要把当前已生效的位移减回去，才是未位移的原始几何。
 *
 * 注意：必须在 hero 已挂载且父级 flex 布局完成（首帧绘制后）再测。
 * 否则会测到 hero 未就位 / 父级高度为 0，算出超大负位移把输入框顶到顶部
 * （连续切换多窗口导致 ConversationView 反复挂载时最易触发，表现为“输入框被提到上面”）。
 * 测不到有效几何时返回 false，由 scheduleMeasure 下一帧重试。
 */
function measureHeroLift(): boolean {
  const view = viewRef.value;
  const wrap = inputWrapRef.value;
  if (!view || !wrap) return false;
  // hero 尚未挂载（Transition 首帧可能延迟）或父级尚未布局时，先不测
  if (isEmpty.value && !heroRef.value) return false;
  const vr = view.getBoundingClientRect();
  if (vr.height === 0) return false;
  const wr = wrap.getBoundingClientRect();
  const hr = heroRef.value?.getBoundingClientRect();
  const rawTop = hr ? Math.min(hr.top, wr.top) : wr.top;
  const rawBottom = hr ? Math.max(hr.bottom, wr.bottom) : wr.bottom;
  const groupCenter = (rawTop + rawBottom) / 2 - heroLift.value;
  heroLift.value = Math.round(vr.top + vr.height / 2 - groupCenter);
  return true;
}

/** 等首帧绘制（layout 就绪）后测量，必要时逐帧重试，直到 hero 就位。 */
function scheduleMeasure(): void {
  if (!isEmpty.value) return;
  let tries = 0;
  const step = () => {
    if (measureHeroLift()) {
      // 位移已落位，下一帧再放开过渡，避免「从底部滑到中间」
      if (!heroLiftReady.value) {
        requestAnimationFrame(() => {
          heroLiftReady.value = true;
        });
      }
      return;
    }
    if (tries++ < 10) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

watch(isEmpty, async (empty) => {
  if (!empty) {
    heroLift.value = 0;
    return;
  }
  await nextTick();
  scheduleMeasure();
});

let liftResizeObs: ResizeObserver | null = null;

onMounted(() => {
  if (!isEmpty.value) {
    heroLiftReady.value = true;
    return;
  }
  // 首帧先在无过渡态落位，待测量成功后再放开过渡
  heroLiftReady.value = false;
  scheduleMeasure();
  if (typeof ResizeObserver !== 'undefined' && viewRef.value) {
    liftResizeObs = new ResizeObserver(() => {
      if (isEmpty.value) measureHeroLift();
    });
    liftResizeObs.observe(viewRef.value);
  }
});

onUnmounted(() => {
  liftResizeObs?.disconnect();
  liftResizeObs = null;
});
</script>

<template>
  <div ref="viewRef" class="conv-view">
    <!-- 左缘时间线 + 消息区：横向并排（CV-S06）。整行与结果视图 v-show 互斥
         （结果视图激活时隐藏整行，切回即恢复），无 user 消息时整体不渲染（AC-CV-017） -->
    <div class="conv-main-row" v-show="!showResultView">
      <ConversationTimelineRail
        v-if="hasTimeline"
        v-show="!showResultView"
        :messages="messages"
        :active-index="reviewTargetIndex"
        @select="onTimelineSelect"
        @hover="onTimelineHover"
        @hover-end="onTimelineHoverEnd"
      />
      <!-- 消息区 vs 结果视图：v-show 互斥，不销毁消息流 DOM；结果视图原地占据消息区位置 -->
      <div ref="scrollRef" v-show="!showResultView" class="conv-messages">
        <div class="conv-messages-inner">
          <!-- 加载态 -->
          <div v-if="loadingHistory" class="conv-loading">
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-text">加载历史消息</span>
          </div>
          <!-- 消息流：连续 ≥2 的 tool 聚为可折叠组。每个展示项独立组件 + 稳定 key，
               流式聚合边界变化（单条 ↔ 组）只在组件内部切换形态，避免 patch 错位 -->
          <template v-else>
            <MessageListItem
              v-for="item in windowedItems"
              :key="item.key"
              :item="item"
              :streaming="item.kind === 'message' && isMessageStreaming(item.idx)"
              :session-id="props.sessionId ?? createdSessionId ?? ''"
              :project-path="props.session?.projectPath ?? ''"
              :show-diff="showDiff"
              @toggle-group="toggleGroup"
            />
            <!-- 流式思考指示器（流式期间始终显示）带 Codex 银色流光 -->
            <div v-if="isStreaming" class="conv-thinking">
              <span class="thinking-text thinking-shimmer">{{ streamPhaseText }}</span>
              <span class="thinking-sec">{{ formatElapsed(streamElapsedSec) }}</span>
            </div>
          </template>

          <!-- 上下文压缩横幅（内存持久，App 关闭前保持）：压缩中警示色微光，完成后常驻提示 -->
          <div
            v-if="compactBanner"
            class="compact-banner"
            :class="{ working: compactBanner.phase === 'compacting' }"
          >
            <span class="cb-line"></span>
            <span
              class="cb-text"
              :class="{ 'thinking-shimmer': compactBanner.phase === 'compacting' }"
            >{{ compactBanner.phase === 'compacting' ? '正在压缩上下文' : compactBanner.text }}</span>
            <span class="cb-line"></span>
          </div>

          <!-- 模型切换横幅（临时显示在对话流底部） -->
          <div v-if="switchBanner" class="conv-switch-banner">
            <span class="csb-line"></span>
            <span class="csb-text">{{ switchBanner }}</span>
            <span class="csb-line"></span>
          </div>

          <!-- 错误提示 -->
          <div v-if="errorMsg" class="conv-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <span>{{ errorMsg }}</span>
          </div>
        </div>
      </div>

      <!-- CV-S06 回看模式"回到底部"提示条（AC-CV-016）：悬浮于消息流底部、输入框上方，
           absolute 定位不改变消息区布局（回看期间无跳动）、不遮挡输入框；点击退出回看恢复自动滚底 -->
      <Transition name="bd-pop">
        <button
          v-if="isReviewing"
          type="button"
          class="review-backdown"
          data-testid="review-backdown"
          @click="onBackdownClick"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <polyline points="5 12 12 19 19 12" />
          </svg>
          <span>回到底部</span>
        </button>
      </Transition>
    </div>

    <!-- 结果视图：占据消息区位置（与消息区 v-show 互斥） -->
    <SubagentResultView
      v-if="showResultView && activeSubagent"
      :subagent="activeSubagent"
      :session-id="props.sessionId ?? createdSessionId ?? ''"
      @stop="onSubagentStopRequest"
    />

    <!-- 子 Agent Tab 栏：固定在输入框上方，有子 agent 才渲染 -->
    <SubagentTabBar
      :subagents="subagents"
      :active-agent-id="activeAgentId"
      @select="onSelectTab"
      @close="onCloseTab"
      @clear-finished="onClearFinished"
    />

    <div
      ref="inputWrapRef"
      class="conv-input-wrap"
      :class="{ 'hero-mode': isEmpty, 'hero-priming': !heroLiftReady || loadingHistory }"
      :style="{ '--conv-hero-lift': heroLift + 'px' }"
    >
      <!-- CV-S11 Todo 面板：放在 wrap 内、hero 占位之前。
           放在 wrap 内是为了与 hero 占位（absolute; bottom:100%）保持同一布局上下文，
           不被 hero 占位向上延伸的区域盖住；放在 hero 之前是为了让面板永远在输入框正上方。
           仅主会话承载（子 agent 结果视图不渲染） -->
      <TodoPanel :session-id="props.sessionId ?? createdSessionId" :todo-snapshot="todoSnapshot" />

      <!-- Path 2 ask_user_question 面板：同样放在 wrap 内、输入框正上方（与 TodoPanel
           同款「从输入框延伸出去」的浮窗）。挂在会话作用域（每个 ConversationView
           实例一份）而非 App 级 —— 契约 §4.4 硬约束 2，多窗格并排时各自只渲染自己
           会话的问卷。子 agent 结果视图不渲染（与 TodoPanel 一致）。 -->
      <AskUserQuestionPanel
        v-if="!showResultView"
        :session-id="props.sessionId ?? createdSessionId"
        :request="askRequest"
        :deadline="askDeadline"
        :answered="askAnswered"
        @submit="submitAskUserAnswers"
        @dismiss="dismissAskAnswered"
      />

      <!-- 空会话首屏 hero：absolute 挂在输入区上方，不参与 wrap 高度计算
           （下沉时不与位移叠加）；pointer-events:none 避免遮挡消息区滚动。
           加载历史期间禁用过渡（:css=false）：hero 在加载开始的同一 tick 内
           直接移除，不走 260ms 离场淡出——否则淡出残影会与「加载历史消息」同屏。
           正常发送首条消息时 loadingHistory 为 false，过渡保留 -->
      <Transition name="conv-hero" :css="!loadingHistory">
        <div v-if="isEmpty" ref="heroRef" class="conv-hero" aria-label="新建会话：输入任务开始对话">
          <span class="conv-wordmark" aria-hidden="true">forge</span>
        </div>
      </Transition>
      <InstructionInput
        ref="inputRef"
        :session-id="props.sessionId ?? undefined"
        :session-status="sessionStatus"
        :models="models"
        :current-model="currentModel"
        :project-picker="props.projectPicker"
        :project-path="props.project.path"
        :queue-items="queueItems"
        :git-project-path="props.projectPicker?.currentPath ?? props.project.path"
        :git-busy="props.gitBusy ?? false"
        @send="onSend"
        @cancel="onCancelTurn"
        @model-change="onModelChange"
        @pick-project="emit('pick-project', $event)"
        @open-project-picker="emit('open-project-picker')"
        @remove-project="emit('remove-project', $event)"
      />
    </div>

    <!-- CV-S06 历史浮窗：teleport 到 body + 组件内 fixed 定位（坐标由 solvePopoverPosition 求解，
         快照为弹出时刻一次性生成，流式期间不刷新；移开条目/浮窗或 Esc 立即关闭，过渡 ≤150ms） -->
    <Teleport to="body">
      <Transition name="hp-pop">
        <ConversationHistoryPopover
          v-if="historyPopover.open"
          ref="popoverComp"
          :snapshot="historyPopover.snapshot"
          :running="historyPopover.running"
          :x="historyPopover.x"
          :y="historyPopover.y"
          :width="historyPopover.width"
          @leave="onTimelineHoverEnd"
        />
      </Transition>
    </Teleport>

    <!-- 单个子 agent 终止二次确认弹窗（不可逆） -->
    <div v-if="pendingStopAgentId" class="stop-confirm-overlay" @click.self="cancelSubagentStop">
      <div class="stop-confirm" role="alertdialog" aria-modal="true" aria-label="确认终止子 Agent">
        <div class="stop-confirm-title">确认终止该子 Agent？</div>
        <div class="stop-confirm-desc">该操作不可逆。终止后子 Agent 将转“已终止”状态，未完成的工作不会保留。</div>
        <div class="stop-confirm-actions">
          <button type="button" class="stop-confirm-cancel" @click="cancelSubagentStop">取消</button>
          <button type="button" class="stop-confirm-confirm" @click="confirmSubagentStop">确认终止</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.conv-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
}

/* 左缘时间线 + 消息区横排容器（CV-S06）：时间线窄条在左，消息流占满余宽；
   relative 作为"回到底部"提示条的定位上下文 */
.conv-main-row {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
}

/* 消息流：全宽 thread，与原型对齐 */
.conv-messages {
  flex: 1;
  min-height: 0;
  /* flex row（.conv-main-row）子项：min-width:0 阻断长行 min-content 向上撑宽
     （多窗口窄窗格会裁掉右侧输入区）；溢出就地隐藏，代码块内部自有横向滚动 */
  min-width: 0;
  overflow-x: hidden;
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 18px 38px;
  scroll-behavior: smooth;
}

.conv-messages-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
}

/* 加载态 */
/* 上下文压缩横幅：切换模型同款横线分隔款式；压缩中文字走微光动画 */
.compact-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 6px;
  color: var(--muted-foreground);
  user-select: none;
  animation: fadeIn 0.2s ease-out;
}

.compact-banner .cb-line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklab, var(--border) 80%, transparent);
}

.compact-banner .cb-text {
  font-size: 11.5px;
  white-space: nowrap;
  font-weight: 500;
}

.conv-loading,
.conv-thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  color: var(--muted-foreground);
  font-size: 14px;
}

.loading-dot,
.thinking-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--muted-foreground);
  opacity: 0.4;
  animation: dot-bounce 1.4s ease-in-out infinite;
}

.loading-dot:nth-child(2),
.thinking-dot:nth-child(2) {
  animation-delay: 0.16s;
}

.loading-dot:nth-child(3),
.thinking-dot:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes dot-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.1); }
}

.loading-text,
.thinking-text {
  margin-left: 6px;
}

/* 思考指示器已无前置圆点，取消左移 */
.conv-thinking .thinking-text {
  margin-left: 0;
}

/* 流式读秒：正文右侧的计时器，小号弱化色 */
.thinking-sec {
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.55;
  margin-left: 2px;
}

/* Codex 银色流光（ai-coding streaming-working 同款，银色版） */
.thinking-shimmer {
  display: inline-block;
  font-weight: 500;
  background: linear-gradient(90deg, #6b7280 0%, #f3f4f6 22%, #6b7280 42%, #e5e7eb 62%, #6b7280 82%, #ffffff 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: thinking-shimmer 2.4s linear infinite;
}
@keyframes thinking-shimmer {
  0% { background-position: 100% 0%; }
  100% { background-position: 0% 0%; }
}

/* ===== 输入区 / 空会话首屏 hero（实现约束见 script 段注释） =====
   下沉位移只加在外层 wrap 上，InstructionInput 本身不动 DOM 位置 */
.conv-input-wrap {
  position: relative;
  flex-shrink: 0;
  padding: 12px 22px 18px;
  /* 字标用 26cqw 跟着可视宽度走，这里建立查询容器 */
  container-type: inline-size;
  transform: translateY(var(--conv-hero-lift, 0px));
  transition: transform var(--transition-decelerate);
  will-change: transform;
}

/* 首帧尚未测量出位移：直接落位，不要从底部「滑」到中间。
   加载历史期间同样禁用过渡：输入框直接以置底全宽呈现（与加载完成态一致），
   避免 hero 收窄居中 → 全宽的中间态（窄条偏左）闪现 */
.conv-input-wrap.hero-priming {
  transition: none;
}

.conv-input-wrap.hero-priming .compose-box {
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

@media (prefers-reduced-motion: reduce) {
  .conv-input-wrap {
    transition: none;
  }
  .conv-input-wrap .compose-box {
    transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  }
}

.conv-hero {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 100%;
  z-index: 2;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  pointer-events: none;
  user-select: none;
}

/* 巨型 forge 字标：实底 + 下缘蒙版渐隐，融进背板。
   透明度刻意留低——抬到 0.2 以上深色主题会起脏斑 */
.conv-wordmark {
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: -0.05em;
  line-height: 1;
  color: var(--foreground);
  opacity: 0.14;
  /* 老浏览器兜底 */
  font-size: 96px;
  font-size: min(26cqw, 180px);
  -webkit-mask-image: linear-gradient(180deg, #000 25%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 25%, transparent 100%);
}

.conv-hero-enter-active,
.conv-hero-leave-active {
  transition: opacity 260ms ease;
}

.conv-hero-enter-from,
.conv-hero-leave-to {
  opacity: 0;
}

/* 输入框宽度随 hero 态收窄居中：两端都写成 cqw 派生的长度，
   避免 percentage ↔ px 插值在 Chromium 上的不确定行为 */
.conv-input-wrap .compose-box {
  max-width: 100cqw;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    max-width var(--transition-decelerate);
}

.conv-input-wrap.hero-mode .compose-box {
  max-width: min(640px, 100cqw);
  margin: 0 auto;
}

/*
 * CV-S11：hero-mode 下让 TodoPanel 与 compose-box 同宽居中，与 opencode 参考一致。
 * 该规则在 ConversationView 里写是为了能直接选 .conv-input-wrap 祖先（TodoPanel
 * scoped CSS 里 :deep() 只能往下穿透、不能往上选祖先）。TodoPanel.vue 不重复定义。
 */
.conv-input-wrap.hero-mode :deep(.todo-panel) {
  max-width: min(640px, 100cqw);
  /* 保留 -10px 底 margin：面板底部仍塞进输入框背后，保持延伸一体感 */
  margin: 0 auto -10px;
}

/* Path 2：问卷面板与 compose-box 同宽居中（与上面 TodoPanel 规则同理，写在
   ConversationView 才能往上选 .conv-input-wrap 祖先）。 */
.conv-input-wrap.hero-mode :deep(.ask-panel) {
  max-width: min(640px, 100cqw);
  margin: 0 auto -10px;
}

/* 模型切换横幅：带左右横线的居中提示 */
.conv-switch-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 6px;
  color: var(--muted-foreground);
  user-select: none;
  animation: fadeIn 0.2s ease-out;
}
.csb-line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklab, var(--border) 80%, transparent);
}
.csb-text {
  font-size: 11.5px;
  white-space: nowrap;
  font-weight: 500;
}

/* 错误提示 */
.conv-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, transparent);
  color: var(--destructive);
  font-size: 12.5px;
  animation: fadeIn 0.2s ease-out;
}

.conv-error svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* 结果视图：与消息流 v-show 互斥，独立占据消息区位置 */
.subagent-result-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 单个终止二次确认弹窗 */
.stop-confirm-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in oklab, black 50%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5000;
  animation: fadeIn 0.15s ease-out;
}

.stop-confirm {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 22px 24px;
  max-width: 420px;
  width: calc(100% - 40px);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.stop-confirm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.stop-confirm-desc {
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.55;
}

.stop-confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 4px;
}

.stop-confirm-cancel,
.stop-confirm-confirm {
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
}

.stop-confirm-cancel:hover {
  background: var(--muted);
}

.stop-confirm-confirm {
  background: var(--destructive);
  color: var(--brand-foreground);
  border-color: var(--destructive);
}

.stop-confirm-confirm:hover {
  filter: brightness(0.95);
}

/* ===== CV-S06 回看模式"回到底部"提示条（AC-CV-016） =====
   悬浮于消息流底部（absolute 不参与布局，回看切换零跳动），点击退出回看恢复自动滚底 */
.review-backdown {
  position: absolute;
  bottom: 12px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 30;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--card);
  color: var(--foreground);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: var(--shadow-lg);
  animation: fadeIn 0.15s ease-out;
}

.review-backdown svg {
  width: 14px;
  height: 14px;
  color: var(--muted-foreground);
}

.review-backdown:hover {
  background: var(--muted);
}

.bd-pop-enter-active,
.bd-pop-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.bd-pop-enter-from,
.bd-pop-leave-to {
  opacity: 0;
  transform: translateX(-50%) translateY(6px);
}

/* ===== CV-S06 历史浮窗出现/消失过渡（≤150ms，AC-CV-015） =====
   Transition 类作用于子组件根元素（父作用域 id 亦挂在其上） */
.hp-pop-enter-active,
.hp-pop-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}

.hp-pop-enter-from,
.hp-pop-leave-to {
  opacity: 0;
  transform: translateY(4px);
}
</style>

<style>
/* ===== CV-S06 点击定位短暂高亮（AC-CV-016） =====
   高亮 class 由运行时加在 MessageCard 根元素（.msg-user，位于孙组件 MessageListItem
   的 fragment 模板内，父作用域样式无法命中），故用全局命名空间类；
   动画 1.5s 与 ConversationView 的 LOCATE_HIGHLIGHT_MS 一致，超时后 class 一并移除 */
@keyframes msg-locate-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in oklab, var(--brand) 45%, transparent);
    background: color-mix(in oklab, var(--brand) 16%, transparent);
    border-radius: 12px;
  }
  70% {
    box-shadow: 0 0 0 8px color-mix(in oklab, var(--brand) 0%, transparent);
  }
  100% {
    box-shadow: 0 0 0 0 transparent;
    background: transparent;
    border-radius: 12px;
  }
}

.msg-locate-highlight {
  animation: msg-locate-pulse 1.5s ease-out;
}
</style>
