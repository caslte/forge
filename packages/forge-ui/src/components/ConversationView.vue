<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { call } from '../bridge';
import type { ProjectItem, SessionItem, ProjectPickerDescriptor } from '../types';
import InstructionInput from './InstructionInput.vue';
import SuggestionChips from './SuggestionChips.vue';
import TodoPanel from './TodoPanel.vue';
import AskUserQuestionPanel from './AskUserQuestionPanel.vue';
import MessageListItem from './MessageListItem.vue';
import ConversationTimelineRail from './ConversationTimelineRail.vue';
import ConversationHistoryPopover from './ConversationHistoryPopover.vue';
import SubagentTabBar from './SubagentTabBar.vue';
import SubagentResultView from './SubagentResultView.vue';
import { useCompactBanner } from '../composables/useCompactBanner';
import { useShellHealth } from '../composables/useShellHealth';
import { usePreferences } from '../composables/usePreferences';
import { useSessionConversation } from '../composables/useSessionConversation';
import { buildRoundSnapshot, type RoundSnapshot } from '../utils/conversationTimeline';
import { solvePopoverPosition, type Rect } from '../utils/popoverPosition';
import { createReviewModeController, type ReviewModeState } from '../utils/reviewMode';
import { formatElapsed } from '../utils/formatElapsed.ts';
import { toErrorBannerModel } from '../utils/errorPresentation.ts';
import { useI18n } from '../i18n/index.ts';

// v3.85.2：字标与 splash/BootWelcome 同一 URL（public 资产，dev '/'、prod './' 均可解析）——
// 全链路共享同一次加载/解码，接管时不再有「新图解码前塌高」的闪动
const logoWordmarkDark = import.meta.env.BASE_URL + 'logo-wordmark-on-dark.png';
const logoWordmarkLight = import.meta.env.BASE_URL + 'logo-wordmark-on-light.png';

/**
 * 对话主视图。
 * 模块 06：子 Agent Tab 栏 + 结果视图。Tab 栏仅在会话内存态含子 agent 时渲染；
 * 切换 Tab 时消息区 v-show 互斥（不销毁 DOM，切回主会话消息流与滚动位置原样恢复）。
 *
 * 其他职责与原文档一致。
 */
const { t } = useI18n();

const props = defineProps<{
  /** 草稿态（新建会话尚未发送首条消息）时为 null；发送首条消息时先创建会话再发送 */
  sessionId: string | null;
  project: ProjectItem;
  session: SessionItem | null;
  models: string[];
  currentModel: string | null;
  /** 项目选择器描述（SM-S01 v3.21）：上层组装，透传给输入框；不传则不渲染 */
  projectPicker?: ProjectPickerDescriptor;
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
  errorInfo,
  retryInfo,
  retryLastUserMessage,
  todoSnapshot,
  isEmpty,
  displayItems,
  turnSuggestion,
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
 * 上下文压缩横幅（内存态，按 sessionId 隔离）：仅覆盖压缩中区间
 * （「正在压缩上下文…」）。完成后不再常驻——压缩点由消息流内联
 * 「上下文已压缩」分隔条标记，结果由瞬时 toast 反馈（2026-09-27 用户反馈）。
 * 状态由 InstructionInput 的事件订阅 / 压缩点击统一维护，视图只读渲染。
 */
const { isCompacting } = useCompactBanner();
/** 个性化：对话框 diff 展示开关（设置页个性化 Tab，localStorage 持久） */
const { showDiff, contentWidth } = usePreferences();
const compactingNow = computed(() => isCompacting(props.sessionId));

/**
 * 错误横幅展示模型（CV-ERR-01）：有结构化分类时由分类决定结论句/色调/是否给重试；
 * 无分类（本机或 RPC 层失败，只有原文）时走 .conv-error--plain 单行样式。
 * 不在视图里拼文案——文案规则集中在 utils/errorPresentation.ts，便于单测与调改。
 */
const errorBanner = computed(() =>
  errorInfo.value === null ? null : toErrorBannerModel(errorInfo.value),
);

/** 「立即重试」：重发本会话最后一条用户消息（pi 无重跑上一轮的原语，
 *  重试会在历史里多一条相同的用户消息——按钮文案与解释句均已说明这一点）。 */
function onRetryError(): void {
  void retryLastUserMessage();
}

/**
 * shell 健康横幅（全局单例，非按会话隔离——shell 是机器属性）。
 * 主进程按 pi 同口径探测 bash，且失败时会自动定位 Git Bash 写进 settings.json 再复探：
 * - broken 非空＝本机确实没有可用 bash（或写配置失败）→ 常驻提示 + 重新检测 + 打开配置目录；
 * - autoFixed 非空＝本次是自动写配置后恢复的，提示重启（已存在会话仍持旧解析结果）。
 * 2026-09 dev 切根后 WSL 拦截事故的收尾：用户不再需要自己编辑 settings.json。
 */
const {
  broken: shellBroken,
  autoFixed: shellAutoFixed,
  busy: shellProbing,
  ensureProbed: ensureShellProbed,
  reprobe: reprobeShell,
} = useShellHealth();
ensureShellProbed();
/** 打开 settings.json 所在目录做修复（路径去掉末段文件名，win/posix 通用） */
function openShellSettingsDir(): void {
  const p = shellBroken.value?.settingsPath;
  if (p) void window.forge.shell.openPath(p.replace(/[\\/][^\\/]+$/, ''));
}
const scrollRef = ref<HTMLElement | null>(null);
const inputRef = ref<InstanceType<typeof InstructionInput> | null>(null);

/** 会话切换：重置共享状态机并清视图侧回看态 */
function resetForSession(): void {
  resetConvForSession();
  stoppedNotice.value = false;
  // 回看模式随会话切换重置为浏览模式（AC-CV-016），定位高亮一并清理
  reviewCtrl.reset();
  syncReview();
  clearLocateHighlight();
  beginSettlePin();
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
    updateConvFade();
  });
}

/**
 * 会话切换后的「落位稳定期」。首帧钉底之后仍有两类延后变化会把视口留在底部上方：
 * - 消息区**变矮**：子 Agent 标签栏（subagent/queryList 异步回填）/ Todo 面板在钉底后才挂载；
 * - 内容**变高**：流式态经 getStatusHint 迟到恢复 → 末尾「正在执行…」指示行晚挂载。
 * 两种情况浏览器都只保持 scrollTop 数值，不跟随补差。稳定期内任一尺寸变化重新钉底；
 * 用户在此期间手动滚动即刻放弃（尊重用户位置，不与回看抢方向盘）。
 */
const SETTLE_PIN_MS = 800;
let settlePinUntil = 0;

function beginSettlePin(): void {
  settlePinUntil = Date.now() + SETTLE_PIN_MS;
}

function cancelSettlePin(): void {
  settlePinUntil = 0;
}

/**
 * 消息区/内容尺寸变化：先钉底再刷新上下沿渐隐。
 * 流式 markdown 按 150ms 节流重渲染，而滚底挂在每个 delta 上（useSessionConversation.scheduleScroll），
 * 两者不同帧：增长帧内容已变高、视口未跟上 → 底沿渐隐亮起，下个 delta 才跳回 → 底部周期性闪烁。
 * ResizeObserver 回调在本帧绘制前，跟随态在此同帧钉底可关掉错位窗口；
 * 渐隐改为钉底后再算，增长帧不会闪出遮罩。
 */
function onConvResize(): void {
  const settling = Date.now() < settlePinUntil;
  if (settling && !autoFollow.value) {
    // 稳定期内的回看态只可能是布局钳位被 onMessagesScroll 误判成「用户上滚」而 detach
    // （detach 无定位目标）；真·手动滚动已由下面的输入事件结束稳定期，
    // 而点了时间轴定位（有 targetIndex）是明确意图，不覆盖。
    if (reviewTargetIndex.value === null) {
      reviewCtrl.exit();
      syncReview();
    }
  }
  if (settling || autoFollow.value) scrollToBottom();
  updateConvFade();
}

// 消息区滚动上下沿渐隐：仅当该方向还有溢出内容时才显示对应渐变遮罩（同会话树口径）
const convFadeTop = ref(false);
const convFadeBottom = ref(false);

function updateConvFade(): void {
  const el = scrollRef.value;
  if (!el) return;
  convFadeTop.value = el.scrollTop > 1;
  convFadeBottom.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

let convFadeObserver: ResizeObserver | null = null;

/** 发送消息：草稿态（未发首条消息）先真正创建会话再发送（状态机在 useSessionConversation） */
/** 停止当前轮（CV-S09）：被清空的待发队列文本回填输入框（pi TUI ESC 同款） */
/** 主动打断提示：停止按钮 / Esc×2 后置显，下一轮开始或切会话收起（内存态，不落库） */
const stoppedNotice = ref(false);

async function onCancelTurn(): Promise<void> {
  const cleared = await cancelTurn();
  if (cleared.length > 0) inputRef.value?.restoreQueuedText(cleared);
  stoppedNotice.value = true;
}

watch(isStreaming, (streaming) => {
  if (streaming) stoppedNotice.value = false;
});

/** 收尾帧高度过渡时长：把一次性布局跳变摊成可感知的平滑收拢（与 MessageCard footer 展开同步） */
const SETTLE_MS = 160;

/** 是否播放过渡：测试环境（无 matchMedia）与「减少动态效果」系统偏好下直接完成，不动画 */
function canAnimate(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    !window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * 思考指示行摘除过渡（v3.85.0 底部跳动修复）：流式结束该行随 v-if 卸载，
 * 实测一帧内消失 ~55px（行高 39px + flex gap 16px），是收尾帧「跳一下」的主要来源。
 * rAF 逐帧显式赋值驱动收拢。关键坑：该行有上下 padding 各 10px，
 * box-sizing:border-box 下渲染高度不能低于 padding 之和（内容盒钳到 0 为下限），
 * 只动 height 会卡死在 20px、残余在卸载帧一次性跳出（探针两次实测确认），
 * 故 padding 必须与 height 同步收到 0。
 * 父容器为 column flex + gap，元素卸载时上/下侧 gap 一并消失，
 * 按有无相邻兄弟用负外边距等量抵消，保证动画结束后零残余。
 */
function collapseThinking(el: Element, done: () => void): void {
  const node = el as HTMLElement;
  const h = node.offsetHeight;
  if (!canAnimate() || h === 0) {
    done();
    return;
  }
  const cs = getComputedStyle(node);
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const parent = node.parentElement;
  const gap = parent ? parseFloat(getComputedStyle(parent).rowGap) || 0 : 0;
  const topGap = node.previousElementSibling ? gap : 0;
  const bottomGap = node.nextElementSibling ? gap : 0;
  const style = node.style;
  style.boxSizing = 'border-box';
  style.overflow = 'hidden';
  style.minHeight = '0px'; // 防 flex min-height:auto 钳制（overflow:hidden 理论上已归零，双保险）
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    done();
  };
  const start = performance.now();
  const tick = (now: number): void => {
    if (finished) return;
    const p = Math.min((now - start) / SETTLE_MS, 1);
    const e = 1 - Math.pow(1 - p, 3); // easeOutCubic：先快后慢，收尾更柔
    style.height = `${(h * (1 - e)).toFixed(2)}px`;
    style.paddingTop = `${(pt * (1 - e)).toFixed(2)}px`;
    style.paddingBottom = `${(pb * (1 - e)).toFixed(2)}px`;
    style.opacity = (1 - e).toFixed(3);
    if (topGap > 0) style.marginTop = `-${(topGap * e).toFixed(2)}px`;
    if (bottomGap > 0) style.marginBottom = `-${(bottomGap * e).toFixed(2)}px`;
    if (p < 1) {
      requestAnimationFrame(tick);
      return;
    }
    finish(); // 末帧已写到 0 高/0 透明/-gap 边距，done 后由 Vue 卸载（此刻尺寸为零，无残余跳变）
  };
  requestAnimationFrame(tick);
  setTimeout(finish, SETTLE_MS + 160); // 兜底：rAF 停摆（如切走窗口）时也要按时卸载
}

/**
 * 流式 FORGE 字标：轮次开始（思考阶段、本轮尚无 assistant/tool 展示项）时显示在思考行头部；
 * 本轮首个展示项（工具组或 assistant 卡）一旦出现，字标由该项头部接管
 * （见 useSessionConversation displayItems turnBrand + MessageListItem .msg-brand）。
 */
const turnBrandRendered = computed(() => {
  const msgs = messages.value;
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    const m = msgs[i]!;
    if (m.role === 'user') return false;
    if (m.compacted) continue;
    if (m.role === 'assistant' || m.role === 'tool') return true;
  }
  return false;
});

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
  // 主动发消息 = 要回到底部看新一轮回复：退出回看恢复自动跟随
  reviewCtrl.exit();
  syncReview();
  await sendTurn(text);
}

/** 点「新会话」：输入框无内容时还原被手动拖高的高度（App 经此透传，草稿态重复点击 sessionId 不变、watch 不触发） */
function resetInputHeightIfEmpty(): void {
  inputRef.value?.resetHeightIfEmpty();
}

defineExpose({ resetInputHeightIfEmpty });

function onModelChange(model: string): void {
  emit('model-change', model);
  showSwitchBanner(model);
}

/** 在对话流底部临时显示"已切换模型"横幅，方便多窗口分辨是哪个窗口切换 */
const switchBanner = ref<string | null>(null);
let switchBannerTimer: ReturnType<typeof setTimeout> | null = null;
function showSwitchBanner(model: string): void {
  switchBanner.value = t('chat.modelSwitched', { model });
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
 * - 流式/浏览期间用户手动上滚离开底部 → detach() → review（无定位目标）：同上不再滚底；
 * - 滚动触底（距底 <40px，去抖停稳判定）或点击"回到底部"提示条 → exit → browse（autoFollow=true）；
 * - 用户发送新消息 → exit 回浏览（主动发消息 = 要看新一轮回复）；
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

/** scrollRef 滚动：向上触顶扩窗（历史窗口化）+ 手动上滚暂停跟随 + 回看态停稳触底退出 */
/** 上次滚动位置（方向判定用）：用户上滚 vs 程序化滚底（扩窗锚定/定位/置底均为向下） */
let lastScrollTop = 0;

function onMessagesScroll(): void {
  updateConvFade();
  void maybeExpandHistoryWindow();
  const elNow = scrollRef.value;
  if (elNow) {
    const scrolledUpBy = lastScrollTop - elNow.scrollTop;
    lastScrollTop = elNow.scrollTop;
    // 流式输出期间用户向上翻阅历史：脱离自动跟随（delta 不再强制滚底），
    // 露出「回到底部」按钮；滚回距底 <NEAR_BOTTOM_PX 停稳后由下方触底判定恢复
    if (
      scrolledUpBy > 2 &&
      elNow.scrollHeight - elNow.scrollTop - elNow.clientHeight > NEAR_BOTTOM_PX
    ) {
      reviewCtrl.detach();
      syncReview();
    }
  }
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

/**
 * 流式期间连按两次 Esc 停止当前轮（与停止按钮同走 onCancelTurn，含队列回填）。
 * 仅流式时挂监听；会消费 ESC 的界面（历史浮窗 / ask 提问面板）开着时这次按键
 * 归它们，双击计数清零，不与「Esc 关闭浮窗」抢同一次按键。
 */
const DOUBLE_ESC_MS = 500;
let lastEscAt = 0;

function onEscKeydown(e: KeyboardEvent): void {
  if (e.key !== 'Escape' || e.repeat) return;
  if (historyPopover.value.open || askRequest.value !== null) {
    lastEscAt = 0;
    return;
  }
  const now = Date.now();
  if (now - lastEscAt > DOUBLE_ESC_MS) {
    lastEscAt = now;
    return;
  }
  lastEscAt = 0;
  void onCancelTurn();
}

watch(
  isStreaming,
  (streaming) => {
    lastEscAt = 0;
    if (streaming) window.addEventListener('keydown', onEscKeydown);
    else window.removeEventListener('keydown', onEscKeydown);
  },
  { immediate: true },
);

onMounted(() => {
  // 回看模式触底判定（scrollRef 元素常驻，仅 v-show 切换）
  scrollRef.value?.addEventListener('scroll', onMessagesScroll, { passive: true });
  // 上下沿渐隐 + 切会话落位稳定期补钉底：观察容器与内容节点（流式增高/消息增删/折叠都会重算）
  const el = scrollRef.value;
  if (el) {
    convFadeObserver = new ResizeObserver(onConvResize);
    convFadeObserver.observe(el);
    if (el.firstElementChild) convFadeObserver.observe(el.firstElementChild);
    // 用户手动滚动 = 明确的位置意图，立即结束稳定期
    // （pointerdown 覆盖拖动滚动条，它既不触发 wheel 也不触发 touchstart）
    el.addEventListener('wheel', cancelSettlePin, { passive: true });
    el.addEventListener('touchstart', cancelSettlePin, { passive: true });
    el.addEventListener('pointerdown', cancelSettlePin, { passive: true });
    el.addEventListener('keydown', cancelSettlePin);
  }
  // 挂载即带会话（多窗格/切窗口重挂）时同样走稳定期：本钩子晚于 composable 的
  // onMounted（loadHistory/loadSubagents 已发起），此处开窗不会漏掉异步回填
  if (props.sessionId !== null) beginSettlePin();
  updateConvFade();
});

onUnmounted(() => {
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
  window.removeEventListener('keydown', onPopoverKeydown);
  window.removeEventListener('keydown', onEscKeydown);
  // 回看模式清理：触底判定去抖计时器 + 定位高亮
  if (nearBottomTimer !== null) {
    clearTimeout(nearBottomTimer);
    nearBottomTimer = null;
  }
  scrollRef.value?.removeEventListener('scroll', onMessagesScroll);
  convFadeObserver?.disconnect();
  convFadeObserver = null;
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
 * 关键：hero 与 wrap 共用同一个 translateY（hero 是 wrap 的子元素），
 * 因此「组中心」受变换污染的幅度恰好等于 hero 高度的一半——
 * 用 view 的偏移量把 wrap 还原成未位移布局位（offsetTop 不含祖先 transform），
 * 再补回这半个 hero，即可精确还原原始几何。
 * 若直接拿变换后的 rect 相减（旧算法 rawTop 减 wr.top 时污染抵消不掉），
 * 拖拽/缩放窗口时 ResizeObserver 会在 transform 过渡中途重测，误差按
 * 「1 + hero高/输入框高」倍自我放大，表现为字标漂移、顶部被裁切。
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
  // offset* 系列不受任何祖先 transform 影响，是纯布局几何
  const wrapTop = wrap.offsetTop;
  const wrapH = wrap.offsetHeight;
  const viewH = view.offsetHeight;
  let heroH = 0;
  if (heroRef.value) {
    // offsetHeight 不含祖先 transform；enter 过渡的 opacity 会推动内层字标高度，
    // 故 rect 高度更贴合当前渲染态——仅当它不小于布局高度时采用
    const layoutH = heroRef.value.offsetHeight;
    const renderedH = heroRef.value.getBoundingClientRect().height;
    heroH = Math.max(layoutH, Math.round(renderedH));
  }
  // 未位移时组中心 = wrap 顶 - hero 高 + (hero 高 + wrap 高)/2
  const groupCenter = wrapTop - heroH / 2 + wrapH / 2;
  heroLift.value = Math.round(viewH / 2 - groupCenter);
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
    // v3.85.2：wrap 自身高度也会被 models 异步回填/状态行内容推动，而 hero 锚在
    // wrap 顶（bottom:100%）——只观测 view 会漏掉这类「输入框长高 → 字标漂移」的重测
    if (inputWrapRef.value) liftResizeObs.observe(inputWrapRef.value);
  }
});

onUnmounted(() => {
  liftResizeObs?.disconnect();
  liftResizeObs = null;
});
</script>

<template>
  <div ref="viewRef" class="conv-view" :class="{ 'col-standard': contentWidth === 'standard' }">
    <!-- 左缘时间线 + 消息区：横向并排（CV-S06）。整行与结果视图 v-show 互斥
         （结果视图激活时隐藏整行，切回即恢复），无 user 消息时整体不渲染（AC-CV-017） -->
    <div class="conv-main-row" :class="{ 'has-rail': hasTimeline }" v-show="!showResultView">
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
      <div
        ref="scrollRef"
        v-show="!showResultView"
        class="conv-messages"
        :class="{ 'fade-t': convFadeTop, 'fade-b': convFadeBottom }"
      >
        <div class="conv-messages-inner">
          <!-- 加载态 -->
          <div v-if="loadingHistory" class="conv-loading">
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-dot"></span>
            <span class="loading-text">{{ t('chat.loadHistoryMessages') }}</span>
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
            <!-- 流式思考指示器（流式期间始终显示）带 Codex 银色流光。
                 收尾帧随 v-if 卸载会连同所在 flex gap 一帧消失 ~55px（实测主要跳动来源），
                 用 JS 钩子把高度/透明度渐变收拢、负外边距抵消将消失的 gap（v3.85.0）。
                 外层包装块同帧卸载：字标与思考行一起被 collapseThinking 收拢，无残余跳动 -->
            <Transition :css="false" @leave="collapseThinking">
              <div v-if="isStreaming" class="conv-streaming-head">
                <div v-if="!turnBrandRendered" class="msg-brand">FORGE</div>
                <div class="conv-thinking">
                  <span class="thinking-text thinking-shimmer">{{ streamPhaseText }}</span>
                  <span class="thinking-sec">{{ formatElapsed(streamElapsedSec) }}</span>
                </div>
              </div>
            </Transition>
            <!-- 下一步建议芯片：锚定消息流末尾、仅当前轮（契约 I1 v2，key=该建议消息，换轮复位已点态） -->
            <SuggestionChips
              v-if="turnSuggestion"
              :key="turnSuggestion.toolEventId ?? turnSuggestion.ts"
              :msg="turnSuggestion"
              @pick="onSend"
            />
            <!-- 主动打断提示（同款分隔线横幅形态）：说明这一轮是手动停的，非模型/网络原因 -->
            <div v-if="stoppedNotice" class="conv-switch-banner">
              <span class="csb-line"></span>
              <span class="csb-text">{{ t('chat.stoppedNotice') }}</span>
              <span class="csb-line"></span>
            </div>
          </template>

          <!-- 上下文压缩横幅（仅压缩中）：警示色微光提示，完成后收掉 -->
          <div v-if="compactingNow" class="compact-banner working">
            <span class="cb-line"></span>
            <span class="cb-text thinking-shimmer">{{ t('chat.compactingContext') }}</span>
            <span class="cb-line"></span>
          </div>

          <!-- 模型切换横幅（临时显示在对话流底部） -->
          <div v-if="switchBanner" class="conv-switch-banner">
            <span class="csb-line"></span>
            <span class="csb-text">{{ switchBanner }}</span>
            <span class="csb-line"></span>
          </div>

          <!-- shell 健康横幅（常驻）：自动定位 Git Bash 仍失败时说明原因并给修复入口 -->
          <div v-if="shellBroken" class="shell-banner">
            <span class="sb-line"></span>
            <div class="sb-body">
              <span class="sb-text">{{ shellBroken.reason === 'wsl-stub' ? t('chat.shellWslStub') : t('chat.shellNoShell') }}</span>
              <span class="sb-hint">{{ t('chat.shellFixHint', { path: shellBroken.settingsPath }) }}</span>
              <span class="sb-actions">
                <button type="button" class="sb-fix" :disabled="shellProbing" @click="reprobeShell">
                  {{ shellProbing ? t('chat.shellReprobing') : t('chat.shellReprobe') }}
                </button>
                <button type="button" class="sb-fix" @click="openShellSettingsDir">{{ t('chat.shellOpenFolder') }}</button>
              </span>
            </div>
            <span class="sb-line"></span>
          </div>

          <!-- 自动修复成功（config 刚落盘）：已存在会话仍持旧 shell，提示重启后生效 -->
          <div v-else-if="shellAutoFixed" class="shell-banner">
            <span class="sb-line"></span>
            <div class="sb-body">
              <span class="sb-text sb-ok">{{ t('chat.shellAutoFixed', { path: shellAutoFixed.shell }) }}</span>
            </div>
            <span class="sb-line"></span>
          </div>

          <!-- 错误横幅（CV-ERR-01）：两行结构——第一行结论 + 原始错误原文，
               第二行解释 +（仅可重试时）立即重试。色调三档：需用户处理/可自愈/已完整。 -->
          <div v-if="errorBanner" class="conv-error" :class="`conv-error--${errorBanner.tone}`">
            <svg class="ce-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            <div class="ce-body">
              <div class="ce-line1">
                <span class="ce-verdict">{{ errorBanner.title }}</span><span
                  v-if="errorBanner.raw !== ''"
                  class="ce-raw"
                  >：{{ errorBanner.raw }}</span
                >
              </div>
              <div class="ce-line2">
                <span class="ce-detail">{{ errorBanner.detail }}</span>
                <button
                  v-if="errorBanner.showRetry"
                  class="ce-retry"
                  type="button"
                  :disabled="isStreaming"
                  @click="onRetryError"
                >
                  <span class="ce-retry-ico" aria-hidden="true">↻</span>
                  {{ t('chat.errorRetry') }}
                </button>
              </div>
            </div>
          </div>
          <!-- 自动重试进行中（CV-ERR-01）：轮次未终止，不是错误——独立于横幅显示进度 -->
          <div v-else-if="retryInfo" class="conv-error conv-error--info">
            <span class="ce-spinner" aria-hidden="true"></span>
            <div class="ce-body">
              <div class="ce-line1">
                <span class="ce-verdict">{{
                  t('chat.errorRetrying', { attempt: retryInfo.attempt, max: retryInfo.maxAttempts })
                }}</span>
              </div>
            </div>
          </div>
          <!-- 无分类的本机/RPC 失败：保持单行原文（分类器只管 provider/网络层错误） -->
          <div v-else-if="errorMsg" class="conv-error conv-error--plain">
            <svg class="ce-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
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
          <span>{{ t('chat.backToBottom') }}</span>
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
        <div v-if="isEmpty" ref="heroRef" class="conv-hero" :aria-label="t('chat.heroAriaLabel')">
          <img class="conv-hero-wordmark wm-dark" :src="logoWordmarkDark" alt="FORGE" width="320" height="42" aria-hidden="true" draggable="false" />
          <img class="conv-hero-wordmark wm-light" :src="logoWordmarkLight" alt="FORGE" width="320" height="42" aria-hidden="true" draggable="false" />
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
        :commit-entry="!isEmpty"
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
      <div class="stop-confirm" role="alertdialog" aria-modal="true" :aria-label="t('chat.stopSubagentAriaLabel')">
        <div class="stop-confirm-title">{{ t('chat.stopSubagentTitle') }}</div>
        <div class="stop-confirm-desc">{{ t('chat.stopSubagentDesc') }}</div>
        <div class="stop-confirm-actions">
          <button type="button" class="stop-confirm-cancel" @click="cancelSubagentStop">{{ t('common.cancel') }}</button>
          <button type="button" class="stop-confirm-confirm" @click="confirmSubagentStop">{{ t('chat.stopSubagentConfirm') }}</button>
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

  /* 内容列宽（个性化偏好 settings.personal.contentWidth）：
     wide = 100%（现有行为，铺满）；standard = 固定列宽居中。
     列宽数值走 token --content-col-std，改一处即全局生效（HMR 实时可调）。 */
  --conv-col: 100%;
  /* 输入框/状态行/浮窗宽度：跟随所在形态（hero 首屏收窄居中，见 .hero-mode） */
  --conv-box-w: 100cqw;
}

/* 标准宽度：正文列与输入区同宽居中；min() 保证窄窗格自动退化为满宽 */
.conv-view.col-standard {
  --conv-col: min(var(--content-col-std, 920px), 100%);
}

/* 左缘时间线窄条占掉消息区左侧，标准宽度下若不补右侧对称 padding，
   内容列会以「消息区」而非「整列视口」为中心，整体右移半个窄条宽，
   与下方输入框错开。补齐后两者严格同轴。 */
.conv-view.col-standard .conv-main-row.has-rail .conv-messages {
  padding-right: calc(38px + var(--timeline-rail-w, 28px));
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
  --edge-fade: 28px;
  --fade-top: 0px;
  --fade-bottom: 0px;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--fade-top),
    #000 calc(100% - var(--fade-bottom)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--fade-top),
    #000 calc(100% - var(--fade-bottom)),
    transparent 100%
  );
}

.conv-messages.fade-t {
  --fade-top: var(--edge-fade);
}

.conv-messages.fade-b {
  --fade-bottom: var(--edge-fade);
}

.conv-messages-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
  /* 内容列收拢（标准宽度）：居中 + 宽度过渡，与输入框同步动画。
     width:100% 必须显式写：margin-inline:auto 会取消 flex 的 stretch 对齐，
     只留 max-width 时列会塌成 fit-content（宽模式也被压窄）。 */
  width: 100%;
  max-width: var(--conv-col);
  margin-inline: auto;
  transition: max-width var(--transition-decelerate);
}

@media (prefers-reduced-motion: reduce) {
  .conv-messages-inner {
    transition: none;
  }
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

/* 流式头部包装：字标 + 思考行同挂收起过渡（collapseThinking 测的是本块整体高度） */
.conv-streaming-head {
  display: flex;
  flex-direction: column;
}

/* FORGE 轮次字标（流式阶段，与 MessageListItem .msg-brand 同口径）；
   左右 14px 抵消 .conv-thinking 内边距，使字标与正文左缘对齐 */
.msg-brand {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.4;
  color: var(--muted-foreground);
  margin: 4px 14px -4px;
  user-select: none;
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

.conv-input-wrap.hero-priming :deep(.compose-box) {
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

@media (prefers-reduced-motion: reduce) {
  .conv-input-wrap {
    transition: none;
  }
  .conv-input-wrap :deep(.compose-box) {
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

/* FORGE 字标（设计稿切图，深浅主题各一版，按 data-theme 切换）。
   首屏不再放图形 LOGO，字标即主视觉，纯黑白不变灰 */
.conv-hero-wordmark {
  display: none;
  width: min(40cqw, 320px);
  height: auto;
  margin-bottom: 44px;
  pointer-events: none;
  user-select: none;
}

:root:not([data-theme='light']) .conv-hero-wordmark.wm-dark,
:root[data-theme='light'] .conv-hero-wordmark.wm-light {
  display: block;
}

/* 浅色主题下纯黑字标对比过强，降透明度柔化（与 landing 首屏同参数） */
:root[data-theme='light'] .conv-hero-wordmark.wm-light {
  opacity: 0.8;
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
/* InstructionInput 为多根 fragment（compose-box + 状态行），不再继承父组件 scopeId，
   父作用域规则必须经 :deep() 才能命中 .compose-box */
/* 宽度统一取 --conv-box-w：默认 100cqw（= 原有 100cqw），hero 态收窄，
   标准宽度偏好下由 .conv-view.col-standard 改写为内容列宽（三种形态一致，不跳宽） */
.conv-input-wrap :deep(.compose-box) {
  max-width: var(--conv-box-w);
  margin-inline: auto;
  transition:
    border-color var(--transition-fast),
    box-shadow var(--transition-fast),
    max-width var(--transition-decelerate);
}

/* hero 收窄居中（状态行同宽跟随，保证项目/分支左缘贴着输入框左缘） */
.conv-input-wrap.hero-mode {
  --conv-box-w: min(640px, 100cqw);
}

.conv-input-wrap :deep(.compose-status) {
  max-width: var(--conv-box-w);
  margin-inline: auto;
}

/* 标准宽度：输入框整体（输入框 + 状态行）跟随正文列宽 */
.conv-view.col-standard .conv-input-wrap {
  --conv-box-w: var(--conv-col);
}

/*
 * CV-S11：hero-mode 下让 TodoPanel 与 compose-box 同宽居中，与 opencode 参考一致。
 * 该规则在 ConversationView 里写是为了能直接选 .conv-input-wrap 祖先（TodoPanel
 * scoped CSS 里 :deep() 只能往下穿透、不能往上选祖先）。TodoPanel.vue 不重复定义。
 */
.conv-input-wrap.hero-mode :deep(.todo-panel) {
  max-width: var(--conv-box-w);
  /* 保留 -10px 底 margin：面板底部仍塞进输入框背后，保持延伸一体感 */
  margin: 0 auto -10px;
}

/* Path 2：问卷面板与 compose-box 同宽居中（与上面 TodoPanel 规则同理，写在
   ConversationView 才能往上选 .conv-input-wrap 祖先）。 */
.conv-input-wrap.hero-mode :deep(.ask-panel) {
  max-width: var(--conv-box-w);
  margin: 0 auto -10px;
}

/* 非 hero 态：Todo / 问卷浮窗（挂在输入框上方）跟随输入框同宽居中，
   否则标准宽度下浮窗仍铺满，与收窄的输入框错位 */
.conv-input-wrap:not(.hero-mode) :deep(.todo-panel),
.conv-input-wrap:not(.hero-mode) :deep(.ask-panel) {
  max-width: var(--conv-box-w);
  margin-inline: auto;
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

/* shell 健康横幅：同款横线分隔；主句警示色，修复路径小字可选中复制（供手动编辑配置） */
.shell-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 6px;
  animation: fadeIn 0.2s ease-out;
}
.sb-line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklab, var(--border) 80%, transparent);
}
.sb-body {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  user-select: none;
}
.sb-text {
  font-size: 11.5px;
  font-weight: 500;
  white-space: nowrap;
  color: var(--destructive);
}
.sb-hint {
  font-size: 11px;
  color: var(--muted-foreground);
  max-width: 520px;
  text-align: center;
  white-space: normal;
  overflow-wrap: anywhere;
  user-select: text;
}
/* 自动修复成功态：同一横幅位置换成正常色，与错误态区分但不喧哗 */
.sb-ok {
  color: var(--muted-foreground);
  font-weight: 400;
}
.sb-actions {
  display: flex;
  align-items: center;
  gap: 14px;
}
.sb-fix {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 11.5px;
  color: var(--primary);
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.sb-fix:disabled {
  color: var(--muted-foreground);
  cursor: default;
  text-decoration: none;
}

/* 错误横幅（CV-ERR-01）：色调三档 + 单行 fallback。
   红色只给「用户不动它就不行」的类（凭据/额度/上下文/本机依赖），
   可自愈与未识别用 warning——不把红色当常态，红才有信号价值。 */
.conv-error {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  font-size: 12.5px;
  animation: fadeIn 0.2s ease-out;
  --ce-tone: var(--muted-foreground);
  background: color-mix(in oklab, var(--ce-tone) 8%, var(--card));
  border: 1px solid color-mix(in oklab, var(--ce-tone) 24%, transparent);
  color: var(--ce-tone);
}

.conv-error--destructive {
  --ce-tone: var(--destructive);
}

.conv-error--warning {
  --ce-tone: var(--warning);
}

.conv-error--info {
  --ce-tone: var(--info);
}

.conv-error--plain {
  --ce-tone: var(--muted-foreground);
  align-items: center;
}

.ce-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  margin-top: 2px;
}

.ce-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.ce-line1 {
  min-width: 0;
  /* 原文可能很长（整段 JSON 错误体）：限两行并允许在任意字符断行，
     不让一条 provider 长错误把输入框顶下去 */
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  line-height: 1.45;
}

.ce-verdict {
  font-weight: 600;
}

/* 原始错误原文：等宽、不加粗、略暗——它在“解释结论”，不该抢结论的视觉重量 */
.ce-raw {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  font-size: 11.5px;
  font-weight: 400;
  color: color-mix(in oklab, var(--ce-tone) 72%, var(--muted-foreground));
  overflow-wrap: anywhere;
}

.ce-line2 {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 10px;
  color: color-mix(in oklab, var(--ce-tone) 78%, var(--muted-foreground));
  line-height: 1.45;
}

.ce-retry {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-sm, 6px);
  border: 1px solid color-mix(in oklab, var(--ce-tone) 34%, transparent);
  background: color-mix(in oklab, var(--ce-tone) 10%, transparent);
  color: inherit;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease-out;
}

.ce-retry:hover:not(:disabled) {
  background: color-mix(in oklab, var(--ce-tone) 20%, transparent);
}

.ce-retry:disabled {
  opacity: 0.55;
  cursor: default;
}

.ce-retry-ico {
  font-size: 12px;
  line-height: 1;
}

/* 自动重试指示：转圈只表示“还在等”，不表示死锁 */
.ce-spinner {
  width: 12px;
  height: 12px;
  margin: 3px 2px 0;
  flex-shrink: 0;
  border-radius: 50%;
  border: 2px solid color-mix(in oklab, var(--ce-tone) 30%, transparent);
  border-top-color: var(--ce-tone);
  animation: ce-spin 0.9s linear infinite;
}

@keyframes ce-spin {
  to {
    transform: rotate(360deg);
  }
}

@media (prefers-reduced-motion: reduce) {
  .ce-spinner {
    animation: none;
  }
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
   悬浮于消息流底部（absolute 不参与布局，回看切换零跳动），点击退出回看恢复自动滚底。

   ⚠️ 入场动画不能用全局 fadeIn（其关键帧只有 translateY，没有 translateX(-50%)，
   跑动画时 transform 会被覆盖 → left:50% 没有抵消 → 按钮左缘钉在中线、整体偏右；
   0.15s 后动画结束、静态 transform 回血、按钮"啪"左跳半宽）。这里用一个本地 keyframe
   把 translateX(-50%) 显式写入 from/to，静态 transform 同步保留作 fallback（动画未
   跑/被 reduced-motion 禁用时仍居中）。 */
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
  animation: review-backdown-in 0.15s ease-out;
}

/* CV-S06 本地入场 keyframe：translateX(-50%) 必须显式带上，否则会覆盖静态居中。
   与下方 .bd-pop-enter-from / .bd-pop-leave-to 的 transform 写法保持一致。 */
@keyframes review-backdown-in {
  from { opacity: 0; transform: translateX(-50%) translateY(6px); }
  to   { opacity: 1; transform: translateX(-50%) translateY(0);   }
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
