<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue';
import type { SessionStatus, ThinkingLevel, ModelThinkingLevels, SessionThinkingLevel, ProjectPickerDescriptor } from '../types';
import { call, subscribe, type PendingAttachment, type ConversationCompactResult, type SlashCommand, type GetSlashCommandsResult } from '../bridge';
import {
  detectSlashContext,
  filterCommands,
  buildInsertion,
  formatCommandLabel,
  SOURCE_LABELS,
} from '../utils/slashCommand';
import { baseName, isImagePath } from '../attachmentText';
import { detectAtContext, filterAtFiles } from '../utils/atCompletion';
// 浏览器禁根入口 import（node:events 会炸，见 SettingsPanel.vue 注释）：白名单从瘦子路径导入
import { isAllowedAttachmentPath } from '@forge/core/attachments';
import { useToast } from '../composables/useToast';
import { useCompactBanner, compactReductionPct } from '../composables/useCompactBanner';
import ImageLightbox from './ImageLightbox.vue';

/**
 * 指令输入框。
 * 参考 ai-coding 的 composer 视觉，但精简为 textarea（非 contenteditable）。
 * 附件统一给路径：选择/粘贴/拖入只收集绝对路径随消息发送，内容由模型自行 read；
 * 剪贴板截图不在盘上，先由主进程落盘临时文件再给路径。
 * 模型切换为点击浮窗菜单（对齐原型 .menu 机制：点字样开、点外部关）。
 * P3-A：底部上下文用量区读取 conversation/getContextUsage，压缩按钮调用 compact。
 */
const props = defineProps<{
  /** 当前会话状态，streaming 时切换为停止按钮并禁用输入 */
  sessionStatus: SessionStatus;
  /** 可选模型列表（来自 model/queryModels） */
  models: string[];
  /** 当前会话模型（来自 model/getSessionModel），null 表示用默认 */
  currentModel: string | null;
  /** 会话 ID（P3-A：读取上下文用量 / 手动压缩） */
  sessionId?: string;
  /** 当前会话待发送队列（CV-S09，FIFO 序）；不传则不渲染徽标 */
  queueItems?: string[];
  /** 项目选择器（SM-S01 v3.21）：单视图传入；不传则不渲染（多窗口窗口标题行已有项目 pill） */
  projectPicker?: ProjectPickerDescriptor;
  /** 项目根路径（@ 文件补全候选范围）；未传则 @ 补全不触发 */
  projectPath?: string;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'cancel'): void;
  (e: 'model-change', model: string): void;
  /** 草稿态选中归属项目（上层切当前项目，草稿保留） */
  (e: 'pick-project', path: string): void;
  /** 打开项目选择弹窗 */
  (e: 'open-project-picker'): void;
  /** 移除项目（仅删 forge 元数据，不删源文件/会话） */
  (e: 'remove-project', path: string): void;
}>();

const text = ref('');
/** 待发附件（统一给路径）：只存路径与嗅探标记 */
const attachments = ref<PendingAttachment[]>([]);
const attachError = ref<string | null>(null);
let attachErrorTimer: ReturnType<typeof setTimeout> | null = null;
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const inputBoxRef = ref<HTMLElement | null>(null);
const attachRowRef = ref<HTMLElement | null>(null);
const focused = ref(false);
const modelMenuOpen = ref(false);
/** 项目选择器下拉开关（SM-S01 v3.21） */

// ===== 输入历史翻阅（CLI 风格，方案 B：仅输入框为空时触发） =====
// 存储：本会话的 user 输入按发送顺序倒序（0=最新），上限 100，localStorage 持久化
// 状态：cursor = -1（当前编辑，未在历史中），0..n-1（历史索引，0 是最近）
// 触发：↑ 在空输入框 + 浮窗关闭 → cursor+1 + 替换；↓ → cursor-1 + 替换
// 边界：cursor 走过最新回到 -1 时 text 清空（待编辑草稿已暂存/恢复）
const HISTORY_MAX = 100;
const historyList = ref<string[]>([]);
const historyCursor = ref(-1);
let pendingDraft = ''; // 进入历史前暂存当前编辑内容；回到 -1 时回填

function historyKey(sid: string | undefined): string | null {
  return sid ? `forge.inputHistory.${sid}` : null;
}

function loadHistory(sid: string | undefined): void {
  const k = historyKey(sid);
  if (!k) {
    historyList.value = [];
    historyCursor.value = -1;
    pendingDraft = '';
    return;
  }
  try {
    const raw = localStorage.getItem(k);
    const arr = raw ? (JSON.parse(raw) as unknown) : [];
    historyList.value = Array.isArray(arr) ? arr.filter((s): s is string => typeof s === 'string') : [];
  } catch {
    historyList.value = [];
  }
  historyCursor.value = -1;
  pendingDraft = '';
}

function saveHistory(): void {
  const k = historyKey(props.sessionId);
  if (!k) return;
  try {
    localStorage.setItem(k, JSON.stringify(historyList.value));
  } catch {
    // 配额溢出等异常静默
  }
}

/** 发送成功时调用：去重（与最近一条相同则不入栈），上限截断后落盘 */
function pushHistory(s: string): void {
  if (!props.sessionId) return; // 草稿态不入栈
  const trimmed = s.trim();
  if (trimmed === '') return;
  const list = historyList.value;
  if (list[0] === trimmed) return; // 与最近一条相同，去重
  list.unshift(trimmed);
  if (list.length > HISTORY_MAX) list.length = HISTORY_MAX;
  saveHistory();
}

const projMenuOpen = ref(false);

function toggleProjMenu(): void {
  // 仅草稿态（新会话）可弹：已创建会话归属不可换，浮窗不弹
  if (props.projectPicker?.mode !== 'draft') return;
  projMenuOpen.value = !projMenuOpen.value;
}

function onPickProject(path: string): void {
  projMenuOpen.value = false;
  if (path !== props.projectPicker?.currentPath) emit('pick-project', path);
}

function onOpenProjectPicker(): void {
  projMenuOpen.value = false;
  emit('open-project-picker');
}

/** 项目删除两阶段确认（与 ProjectTree 同模式）：首点变红「确认删除」，3s 内再点才 emit */
const projDeleteConfirmPath = ref<string | null>(null);
let projDeleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

function onProjDelete(path: string): void {
  if (projDeleteConfirmPath.value === path) {
    if (projDeleteConfirmTimer) clearTimeout(projDeleteConfirmTimer);
    projDeleteConfirmPath.value = null;
    projMenuOpen.value = false;
    emit('remove-project', path);
    return;
  }
  projDeleteConfirmPath.value = path;
  if (projDeleteConfirmTimer) clearTimeout(projDeleteConfirmTimer);
  projDeleteConfirmTimer = setTimeout(() => {
    projDeleteConfirmPath.value = null;
  }, 3000);
}

// ===== CV-S08：斜杠命令浮窗（AC-CV-026~030/032/033） =====
/** 会话级命令清单缓存（初值 []；会话切换 / slashCommandsUpdated 事件时清空重拉） */
const commands = ref<SlashCommand[]>([]);
/** 浮窗开关 */
const commandPanelOpen = ref(false);
/** 当前高亮索引（默认 0） */
const highlightIndex = ref(0);
/** 按过滤串过滤后的可见命令 */
const filteredCommands = ref<SlashCommand[]>([]);
/** 拉取在途守卫：避免多个 / 输入竞态重复请求 */
let slashFetching = false;
/** 拉取代际编号：只应用最新一次响应，避免交错覆盖 */
let slashLoadGen = 0;

const { success: toastSuccess, error: toastError } = useToast();
const { markCompacting, markDone, clear: clearCompactBanner } = useCompactBanner();

// ===== MP-S05：思考级别切换器（模型选择旁紧凑下拉；非推理模型隐藏入口） =====
/** 当前模型可用级别（来自 model/getModelThinkingLevels；仅 ["off"] 时隐藏切换器） */
const availableLevels = ref<ThinkingLevel[]>([]);
/** 会话当前生效思考级别（来自 model/getSessionThinkingLevel） */
const currentLevel = ref<ThinkingLevel | null>(null);
const levelMenuOpen = ref(false);
/** max 金色流光动画开关（纯视觉，不影响输入） */
const shimmerOn = ref(false);
let shimmerTimer: ReturnType<typeof setTimeout> | null = null;
/** 会话/模型切换竞态代际编号：只应用最新一次查询响应，避免交错覆盖 */
let tlGen = 0;

const isStreaming = computed(() => props.sessionStatus === 'streaming');

// 进行中转轮（与终端 pi 同帧序列、同 80ms 步进）：仅以 placeholder 前缀呈现，输入非空时随 placeholder 一起隐藏
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const spinnerIdx = ref(0);
const spinnerFrame = computed(() => SPINNER_FRAMES[spinnerIdx.value] ?? SPINNER_FRAMES[0]);
let spinnerTimer: ReturnType<typeof setInterval> | null = null;
watch(
  isStreaming,
  (on) => {
    if (spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = null;
    }
    if (on) {
      spinnerTimer = setInterval(() => {
        spinnerIdx.value = (spinnerIdx.value + 1) % SPINNER_FRAMES.length;
      }, 80);
    } else {
      spinnerIdx.value = 0;
    }
  },
  { immediate: true },
);

const charCount = computed(() => text.value.length);
const MAX_CHARS = 8000;

// ===== P3-A：上下文用量 =====
interface ContextUsageInfo {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}
const usage = ref<ContextUsageInfo | null>(null);
const usageError = ref<string | null>(null);
/** 手动压缩进行中（点击压缩按钮 → RPC 返回） */
const compacting = ref(false);
/** 自动压缩进行中（conversation.compacting → compacted 事件区间） */
const autoCompacting = ref(false);

const usagePercent = computed(() => {
  if (usage.value === null || usage.value.percent === null) return null;
  return Math.round(usage.value.percent * 10) / 10;
});
const usagePct = computed(() => (usagePercent.value === null ? 0 : usagePercent.value));
const usageLabel = computed(() => {
  if (usage.value === null) return '—';
  const pct = usagePercent.value;
  if (pct === null) return `${usage.value.tokens ?? '?'} tokens`;
  return `${pct}%`;
});
const usageWarning = computed(() => usagePercent.value !== null && usagePercent.value >= 80);

/** 压缩期间锁定输入（手动或自动）：上下文重建中发送会造成内容错位 */
const inputLocked = computed(() => compacting.value || autoCompacting.value);
/** 待发送队列（CV-S09）：忙时发送入队，上限 5 条 */
const queueList = computed(() => props.queueItems ?? []);
const QUEUE_MAX = 5;
const queuePanelOpen = ref(false);
const canSend = computed(
  () => (text.value.trim().length > 0 || attachments.value.length > 0) && !inputLocked.value,
);

/**
 * 流式期间禁止压缩：pi 的 compact() 会先 abort 当前轮，导致正在生成的回答被
 * 静默截断（以 stopReason=aborted 入库）。宁可禁用，也不让用户莫名丢回答。
 */
const compactDisabled = computed(() => compacting.value || autoCompacting.value || isStreaming.value);
const compactLabel = computed(() =>
  compacting.value || autoCompacting.value ? '压缩中…' : '压缩',
);
const compactTitle = computed(() => {
  if (compacting.value || autoCompacting.value) return '压缩中…';
  if (isStreaming.value) return '回答生成中，暂不支持压缩';
  return '压缩上下文';
});

/**
 * 压缩结果 toast 文案：减少百分比优先（用户对比例更有感），
 * 附带前后 token 变化做细节；数据不足退回简文。
 */
function formatCompactToast(r: ConversationCompactResult): string {
  const pct = compactReductionPct(r.tokensBefore, r.tokensAfter);
  if (typeof r.tokensBefore === 'number' && typeof r.tokensAfter === 'number') {
    return pct !== null
      ? `压缩完成：${r.tokensBefore} → ${r.tokensAfter} tokens（减少 ${pct}%）`
      : `压缩完成：${r.tokensBefore} → ${r.tokensAfter} tokens`;
  }
  return '压缩完成：上下文已更新';
}

/** 拉取当前会话上下文用量（P3-A） */
async function refreshUsage(): Promise<void> {
  if (!props.sessionId) return;
  try {
    const res = await call<{ usage: ContextUsageInfo | null }>('conversation/getContextUsage', {
      sessionId: props.sessionId,
    });
    usage.value = res.usage ?? null;
    usageError.value = null;
  } catch (e) {
    usageError.value = e instanceof Error ? e.message : '';
    usage.value = null;
  }
}

/** 手动压缩（P3-A）：压缩中锁定输入 + 持久横幅；结果走全局 toast（同切换模型款式） */
async function onCompact(): Promise<void> {
  if (!props.sessionId || compacting.value || autoCompacting.value || isStreaming.value) return;
  compacting.value = true;
  markCompacting(props.sessionId);
  try {
    const res = await call<{ result: ConversationCompactResult }>('conversation/compact', {
      sessionId: props.sessionId,
    });
    const r = res.result;
    if (!r.ok) {
      toastError(r.message ?? '压缩失败');
      clearCompactBanner(props.sessionId);
      return;
    }
    await refreshUsage();
    // bug 兜底：pi 在压缩边界后可能返回 percent=null（UI 会显示"? tokens"），
    // 用压缩结果的 tokensAfter 合成压缩后百分比
    if (
      usage.value !== null &&
      usage.value.percent === null &&
      typeof r.tokensAfter === 'number' &&
      usage.value.contextWindow > 0
    ) {
      usage.value = {
        tokens: r.tokensAfter,
        contextWindow: usage.value.contextWindow,
        percent: (r.tokensAfter / usage.value.contextWindow) * 100,
      };
    }
    toastSuccess(formatCompactToast(r));
    markDone(props.sessionId, r.tokensBefore ?? null, r.tokensAfter ?? null);
  } catch (e) {
    toastError(e instanceof Error ? e.message : '压缩失败');
    clearCompactBanner(props.sessionId);
  } finally {
    compacting.value = false;
    // compacting/compacted 事件可能因压缩中止不成对发射，RPC 返回即解锁输入
    autoCompacting.value = false;
  }
}

/** textarea 自适应高度上限：与拖拽盒子上限(320)对齐（320 − 上内边距12 − 底部预留58），之后交给滚动条 */
const GROW_MAX = 250;

/**
 * textarea 自适应高度——只增长、不收缩覆盖手动拖拽的高度：
 * 输入字数变多时自动增高，直到与拖拽上限一致的上限后，剩余内容交给 textarea 滚动条。
 * 文本清空（发送/删空）时重置回默认高度（CSS min-height），长文本撑高的输入框不残留。
 */
function autoGrow(): void {
  const el = textareaRef.value;
  if (!el) return;
  if (text.value === '') {
    el.style.height = '';
    return;
  }
  const desired = Math.min(el.scrollHeight, GROW_MAX);
  const cur = parseFloat(el.style.height) || 0;
  if (desired > cur) el.style.height = desired + 'px';
}

function onInput(): void {
  autoGrow();
  if (text.value.length > MAX_CHARS) {
    text.value = text.value.slice(0, MAX_CHARS);
  }
  void refreshSlashPanel(true);
  void refreshAtPanel(true);
}

// ===== CV-S08：斜杠命令浮窗逻辑 =====
/** 拉取命令清单（会话级缓存；失败/空清单 → 浮窗显示「无可用命令」，不阻塞输入） */
async function fetchCommands(): Promise<void> {
  if (commands.value.length > 0 || slashFetching) return;
  slashFetching = true;
  const gen = ++slashLoadGen;
  try {
    const res = await call<GetSlashCommandsResult>('conversation/getSlashCommands', {
      sessionId: props.sessionId,
    });
    if (gen !== slashLoadGen) return;
    commands.value = res.commands ?? [];
  } catch (e) {
    if (gen !== slashLoadGen) return;
    console.warn('[slash] 拉取命令清单失败（降级为空清单）', e);
    commands.value = [];
  } finally {
    slashFetching = false;
  }
}

/**
 * 按当前光标处斜杠上下文刷新浮窗。
 * @param resetIndex 是否把高亮重置到首条（输入变化时）；光标移动（keyup/click）时不重置
 */
async function refreshSlashPanel(resetIndex: boolean): Promise<void> {
  const detect = (): ReturnType<typeof detectSlashContext> => {
    const el = textareaRef.value;
    const caret = el ? el.selectionStart : text.value.length;
    return detectSlashContext(text.value, caret);
  };
  let ctx = detect();
  if (!ctx.active) {
    commandPanelOpen.value = false;
    return;
  }
  // 清单为空先拉取（异步），拉完用最新光标位再判定一次，避免竞态
  if (commands.value.length === 0) {
    await fetchCommands();
    ctx = detect();
    if (!ctx.active) {
      commandPanelOpen.value = false;
      return;
    }
  }
  commandPanelOpen.value = true;
  filteredCommands.value = filterCommands(commands.value, ctx.filter);
  if (resetIndex) {
    highlightIndex.value = 0;
  } else if (highlightIndex.value >= filteredCommands.value.length) {
    highlightIndex.value = Math.max(0, filteredCommands.value.length - 1);
  }
}

/** 光标移动（@click / @keyup）：浮窗打开时用最新光标位刷新过滤串 */
function onCursorMove(): void {
  if (commandPanelOpen.value) void refreshSlashPanel(false);
  if (atPanelOpen.value) void refreshAtPanel(false);
}

/** ↑↓ 高亮循环导航（首↔末） */
function moveHighlight(dir: number): void {
  const n = filteredCommands.value.length;
  if (n === 0) return;
  highlightIndex.value = (highlightIndex.value + dir + n) % n;
}

/** 选中命令：用原始命令串（/name + 空格）替换 [lineStart, caret) 区间，美化名不入输入框 */
function applyCommand(cmd: SlashCommand): void {
  const el = textareaRef.value;
  const caret = el ? el.selectionStart : text.value.length;
  const ctx = detectSlashContext(text.value, caret);
  const lineStart = ctx.active ? ctx.lineStart : 0;
  const insertion = buildInsertion(cmd.name);
  text.value = text.value.slice(0, lineStart) + insertion + text.value.slice(caret);
  commandPanelOpen.value = false;
  autoGrow();
  nextTick(() => {
    const pos = lineStart + insertion.length;
    if (el) {
      el.focus();
      el.setSelectionRange(pos, pos);
    }
  });
}

function onBlur(): void {
  focused.value = false;
  commandPanelOpen.value = false;
  atPanelOpen.value = false;
}

// ===== @ 弹文件补全（CV-S01 扩展 v3.30：与附件 @路径行协议闭环） =====
/** @ 浮窗开关 */
const atPanelOpen = ref(false);
/** 候选文件清单（按 projectPath 缓存一次拉取，逐键本地过滤） */
const atCandidates = ref<string[]>([]);
/** 缓存归属项目路径（null = 未拉取） */
const atLoadedFor = ref<string | null>(null);
const atFetching = ref(false);
/** 过滤后可见候选 */
const atFiltered = ref<string[]>([]);
/** 当前高亮索引 */
const atHighlight = ref(0);

/** 拉取候选文件（每项目一次；失败降级空清单不阻塞输入） */
async function fetchAtCandidates(): Promise<void> {
  const root = props.projectPath;
  if (!root || atLoadedFor.value === root || atFetching.value) return;
  atFetching.value = true;
  try {
    const files = await window.forge.file.listProjectFiles(root);
    if (props.projectPath !== root) return; // 拉取期间已切项目，丢弃
    atCandidates.value = files;
    atLoadedFor.value = root;
  } catch (e) {
    console.warn('[at] 拉取文件候选失败（降级为空清单）', e);
    atCandidates.value = [];
    atLoadedFor.value = root;
  } finally {
    atFetching.value = false;
  }
}

/** 按当前光标处 @ 上下文刷新浮窗（与斜杠浮窗互斥；无项目路径不触发） */
async function refreshAtPanel(resetIndex: boolean): Promise<void> {
  const el = textareaRef.value;
  const caret = el ? el.selectionStart : text.value.length;
  const ctx = detectAtContext(text.value, caret);
  if (!ctx.active || !props.projectPath) {
    atPanelOpen.value = false;
    return;
  }
  commandPanelOpen.value = false;
  if (atLoadedFor.value !== props.projectPath) {
    await fetchAtCandidates();
    const recheck = detectAtContext(text.value, el ? el.selectionStart : text.value.length);
    if (!recheck.active) {
      atPanelOpen.value = false;
      return;
    }
  }
  atPanelOpen.value = true;
  atFiltered.value = filterAtFiles(atCandidates.value, ctx.filter);
  if (resetIndex) {
    atHighlight.value = 0;
  } else if (atHighlight.value >= atFiltered.value.length) {
    atHighlight.value = Math.max(0, atFiltered.value.length - 1);
  }
}

function moveAtHighlight(dir: number): void {
  const n = atFiltered.value.length;
  if (n === 0) return;
  atHighlight.value = (atHighlight.value + dir + n) % n;
}

/** 选中文件：移除 [atStart, caret) 的 @token，文件进待发区（与选择/粘贴/拖拽同链路） */
function applyAtFile(file: string): void {
  const el = textareaRef.value;
  const caret = el ? el.selectionStart : text.value.length;
  const ctx = detectAtContext(text.value, caret);
  const atStart = ctx.active ? ctx.atStart : caret;
  text.value = text.value.slice(0, atStart) + text.value.slice(caret);
  atPanelOpen.value = false;
  autoGrow();
  void addPaths([file]);
  nextTick(() => {
    if (el) {
      el.focus();
      el.setSelectionRange(atStart, atStart);
    }
  });
}

/** @ 候选项展示：文件名 + 去项目前缀的目录提示 */
function atItemParts(p: string): { name: string; dir: string } {
  const name = baseName(p);
  let dir = p.slice(0, p.length - name.length);
  if (props.projectPath) {
    const normRoot = props.projectPath.replace(/[\\/]+$/, '');
    const normDir = dir.replace(/\\/g, '/');
    const normRootSlash = normRoot.replace(/\\/g, '/') + '/';
    if (normDir.toLowerCase().startsWith(normRootSlash.toLowerCase())) {
      dir = normDir.slice(normRootSlash.length);
    }
  }
  return { name, dir };
}

// ===== 上边沿拖拽调整输入框高度（单窗口 / 多窗口通用） =====
// 上限：避免把消息区挤没 / 输入框挤出屏幕
const RESIZE_MAX = 320;
let rsStartY = 0;
let rsStartH = 0;
let rsFloor = 0;

/** 当前布局下盒子最小高度：上内边距 + 附件行实高（v3.39 贴图后计入，防拖拽下限以下内容溢出重叠）+ 输入区最小高度 + 底部预留 */
function minBoxHeight(): number {
  const el = inputBoxRef.value;
  if (!el) return 64;
  const cs = getComputedStyle(el);
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const ta = textareaRef.value;
  const taMin = ta ? parseFloat(getComputedStyle(ta).minHeight) || 0 : 0;
  const attachH = attachRowRef.value?.offsetHeight ?? 0;
  return Math.max(64, pt + attachH + taMin + pb - 2);
}

function onResizeDown(e: PointerEvent): void {
  const el = inputBoxRef.value;
  if (!el) return;
  e.preventDefault();
  // 稳定底线＝附件行实高 + 输入区最小高度 + 上下预留（minBoxHeight）：拖拽最低也不能让内容溢出重叠
  rsFloor = minBoxHeight();
  rsStartY = e.clientY;
  rsStartH = el.offsetHeight;
  (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
}
function onResizeMove(e: PointerEvent): void {
  if (rsStartH === 0) return;
  const el = inputBoxRef.value;
  if (!el) return;
  const dh = rsStartY - e.clientY;
  const h = Math.min(RESIZE_MAX, Math.max(rsFloor, rsStartH + dh));
  el.style.height = h + 'px';
}
function onResizeUp(e: PointerEvent): void {
  rsStartH = 0;
  try {
    (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
  } catch {
    // 忽略
  }
}

// 附件增减后，手动拖过的固定高度盒子若低于新下限则抬起（先贴图后拖拽/先拖矮后贴图两序均覆盖）
watch(
  () => attachments.value.length,
  async () => {
    await nextTick(); // 等 attach-row 渲染出实际高度
    const el = inputBoxRef.value;
    if (!el || el.style.height === '') return; // auto 高度自然增长，无需干预
    const need = minBoxHeight();
    if (el.offsetHeight < need) el.style.height = need + 'px';
  },
);

function onKeydown(ev: KeyboardEvent): void {
  if (!ev.isComposing && atPanelOpen.value) {
    // @ 浮窗打开期间消费导航/选择/关闭键，避免误触发消息发送
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveAtHighlight(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveAtHighlight(-1);
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      const file = atFiltered.value[atHighlight.value];
      if (file) applyAtFile(file);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      atPanelOpen.value = false;
      return;
    }
  }
  if (!ev.isComposing && commandPanelOpen.value) {
    // 浮窗打开期间消费导航/选择/关闭键，避免误触发消息发送
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      moveHighlight(1);
      return;
    }
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      moveHighlight(-1);
      return;
    }
    if (ev.key === 'Enter' || ev.key === 'Tab') {
      ev.preventDefault();
      const item = filteredCommands.value[highlightIndex.value];
      if (item) applyCommand(item);
      return;
    }
    if (ev.key === 'Escape') {
      ev.preventDefault();
      commandPanelOpen.value = false;
      return;
    }
  }
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    onSend();
    return;
  }
  // 输入历史翻阅：方案 B——仅输入框为空时（且浮窗都关闭）才拦截 ↑/↓
  // 避免误删用户正在输入的内容；已在历史模式（cursor>=0）时继续拦截 ↑/↓ 走完历史
  if (!atPanelOpen.value && !commandPanelOpen.value
      && (text.value === '' || historyCursor.value >= 0)
      && historyList.value.length > 0) {
    if (ev.key === 'ArrowUp') {
      ev.preventDefault();
      if (historyCursor.value === -1) {
        pendingDraft = ''; // 已是空，无需保留草稿
      }
      const next = historyCursor.value + 1;
      if (next < historyList.value.length) {
        historyCursor.value = next;
        text.value = historyList.value[next]!;
        nextTick(autoGrow);
      }
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault();
      if (historyCursor.value === -1) return; // 已在当前编辑态
      const next = historyCursor.value - 1;
      if (next < 0) {
        historyCursor.value = -1;
        text.value = pendingDraft;
        pendingDraft = '';
        nextTick(autoGrow);
      } else {
        historyCursor.value = next;
        text.value = historyList.value[next]!;
        nextTick(autoGrow);
      }
      return;
    }
  }
}

function onSend(): void {
  if (!canSend.value) return;
  const t = text.value.trim();
  const atts = attachments.value;
  // CV-S09 队列上限：忙时入队前校验（软校验，双窗口极端并发可能超 1 条）
  if (isStreaming.value && queueList.value.length >= QUEUE_MAX) {
    toastError(`待发送队列已满（最多 ${QUEUE_MAX} 条），请稍候`);
    return;
  }
  // 密钥嗅探确认：flagged 附件（路径对应文件含疑似凭据）出域前需确认
  const flagged = atts.filter((a) => a.flagged);
  if (flagged.length > 0 && !window.confirm(
    `检测到疑似密钥/凭据：\n${flagged.map((a) => a.name).join('、')}\n\n附件会被模型读取并发送给模型服务商，确认仍要附带吗？`,
  )) {
    return;
  }
  const paths = atts.map((a) => a.path);
  text.value = '';
  attachments.value = [];
  attachError.value = null;
  // 发送成功后入栈输入历史（未跳过验证 / 文本非空 / 有 sessionId）
  pushHistory(t);
  nextTick(autoGrow);
  // 附件行追加在正文后（换行分隔），@ 前缀是附件协议标记：@开头=附件，
  // 手敲裸路径=正文，展示层零歧义；模型据此自行 read，纯附件消息就是纯附件行
  emit('send', paths.length > 0 ? `${t}\n${paths.map((p) => `@${p}`).join('\n')}` : t);
}

/** 把一批路径加入待发区（格式白名单 + 主进程密钥嗅探后返回标记）；返回是否全部成功 */
async function addPaths(paths: string[]): Promise<boolean> {
  if (paths.length === 0) return true;
  // 格式白名单（v3.19 用户需求）：选择/粘贴/拖拽三入口统一在此把关（选择器的 dialog filter 仅是软过滤）
  const accepted = paths.filter((p) => isAllowedAttachmentPath(p));
  const rejected = paths.filter((p) => !isAllowedAttachmentPath(p));
  if (rejected.length > 0) {
    showAttachError(
      `不支持的文件格式：${rejected.slice(0, 3).map(baseName).join('、')}${rejected.length > 3 ? ` 等 ${rejected.length} 个` : ''}`,
    );
  }
  if (accepted.length === 0) return false;
  const all = [...attachments.value, ...accepted];
  if (all.length > MAX_ATTACHMENTS) {
    showAttachError(`附件最多 ${MAX_ATTACHMENTS} 个，已跳过`);
    return false;
  }
  try {
    const scanned = await window.forge.file.scanAttachments(accepted);
    // 图片附加载缩略图（点击放大用）；非图片/读取失败保持 icon chip
    const entries: PendingAttachment[] = [];
    for (const s of scanned) {
      const dataUrl = isImagePath(s.name) ? await window.forge.file.readImage(s.path).catch(() => null) : null;
      entries.push({ ...s, dataUrl: dataUrl ?? undefined });
    }
    attachments.value = [...attachments.value, ...entries];
    attachError.value = null;
    return true;
  } catch (e) {
    showAttachError(e instanceof Error ? e.message : '附件嗅探失败');
    return false;
  }
}

/** 选择附件（统一给路径：只拿路径，不读内容） */
async function pickAttachments(): Promise<void> {
  if (inputLocked.value) return;
  try {
    const files = await window.forge.dialog.selectFiles();
    if (files.length === 0) return;
    await addPaths(files);
  } catch (e) {
    showAttachError(e instanceof Error ? e.message : '读取附件失败');
  }
}

// ===== 截图/文件 粘贴（Ctrl+V）+ 拖拽：统一收集路径 =====

/** 待发图片预览弹窗（点击缩略图打开，null = 关闭） */
const lightboxSrc = ref<string | null>(null);

/** 单条消息附件总数上限 */
const MAX_ATTACHMENTS = 10;

/** Blob 读取为纯 base64（去掉 data URL 前缀，供主进程落盘） */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const r = reader.result;
      if (typeof r === 'string' && r.includes(',')) {
        resolve(r.slice(r.indexOf(',') + 1));
      } else {
        reject(new Error('图片读取失败'));
      }
    };
    reader.onerror = () => reject(reader.error ?? new Error('图片读取失败'));
    reader.readAsDataURL(blob);
  });
}

/**
 * 单个文件加入待发区：有盘路径直接给路径；无盘图片（粘贴截图）先落盘再给路径。
 * 返回是否已受理（路径收集成功/已入队）。
 */
async function collectFile(f: File, paths: string[]): Promise<void> {
  const diskPath = window.forge.file.getPathForFile(f);
  if (diskPath !== '') {
    paths.push(diskPath);
    return;
  }
  // 无盘文件：仅支持图片（剪贴板截图），先落盘临时文件；其余格式拒绝并提示
  if (!f.type.startsWith('image/')) {
    showAttachError(`不支持的文件格式：${f.name || '未知文件'}`);
    return;
  }
  const mimeType = f.type || 'image/png';
  const ext = (mimeType.split('/')[1] ?? 'png').split('+')[0] ?? 'png';
  const data = await blobToBase64(f);
  const saved = await window.forge.file.savePasteImage(data, ext);
  if (!saved) {
    showAttachError('截图落盘失败，已跳过');
    return;
  }
  // base64 已在手，缩略图直接本地拼 data URL，不再走 IPC 回读
  attachments.value = [
    ...attachments.value,
    { path: saved.path, name: saved.name, flagged: false, dataUrl: `data:${mimeType};base64,${data}` },
  ];
}

/**
 * 粘贴事件：剪贴板含文本时优先走默认文本粘贴（如从 Excel 复制）；
 * 否则拦截文件/截图为路径附件。
 */
async function onPaste(ev: ClipboardEvent): Promise<void> {
  if (inputLocked.value) return;
  const cd = ev.clipboardData;
  if (!cd) return;
  if (cd.getData('text/plain').trim() !== '') return;
  const files: File[] = [];
  for (const item of cd.items) {
    if (item.kind === 'file') {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (files.length === 0) return;
  ev.preventDefault();
  const diskPaths: string[] = [];
  for (const f of files) {
    try {
      await collectFile(f, diskPaths);
    } catch (e) {
      showAttachError(e instanceof Error ? e.message : '图片读取失败');
    }
  }
  await addPaths(diskPaths);
}

/** 拖拽悬停高亮态 */
const dragOver = ref(false);

/** 拖拽悬停：仅当拖入的是文件时高亮并允许放置 */
function onDragOver(ev: DragEvent): void {
  if (inputLocked.value) return;
  const types = ev.dataTransfer?.types;
  if (!types || !Array.from(types).includes('Files')) return;
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
  dragOver.value = true;
}

/** 拖拽离开：越过子元素内部移动不取消高亮 */
function onDragLeave(ev: DragEvent): void {
  const el = inputBoxRef.value;
  if (el && ev.relatedTarget && el.contains(ev.relatedTarget as Node)) return;
  dragOver.value = false;
}

/** 放置：拖入的文件统一收集路径（截图类无盘文件先落盘） */
async function onDrop(ev: DragEvent): Promise<void> {
  if (inputLocked.value) return;
  dragOver.value = false;
  const files = Array.from(ev.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  ev.preventDefault();
  const diskPaths: string[] = [];
  for (const f of files) {
    try {
      await collectFile(f, diskPaths);
    } catch (e) {
      showAttachError(e instanceof Error ? e.message : '图片读取失败');
    }
  }
  await addPaths(diskPaths);
}

/** 从待发区移除附件（失败/误选可移除重试） */
function removeAttachment(index: number): void {
  attachments.value = attachments.value.filter((_, i) => i !== index);
}

function showAttachError(msg: string): void {
  attachError.value = msg;
  if (attachErrorTimer) clearTimeout(attachErrorTimer);
  attachErrorTimer = setTimeout(() => {
    attachError.value = null;
  }, 4000);
}

function onCancel(): void {
  emit('cancel');
}

function onModelChange(model: string): void {
  emit('model-change', model);
}

function toggleModelMenu(): void {
  modelMenuOpen.value = !modelMenuOpen.value;
}

function selectModel(m: string): void {
  modelMenuOpen.value = false;
  if (m !== props.currentModel) onModelChange(m);
}

// ===== MP-S05：加载并切换思考级别 =====
/**
 * 加载当前会话的思考级别状态：
 * - model/getModelThinkingLevels 得可用级别（失败 → 隐藏切换器，降级不阻塞输入）
 * - model/getSessionThinkingLevel 得当前生效级别（失败仅降级回显，不隐藏切换器）
 * 草稿态（新会话未创建，sessionId 缺省）同样渲染切换器：级别列表只依赖模型
 * （草稿用全局默认模型）；级别回显传空参查全局默认（新会话继承全局，TD-MP-05）。
 * 仅当 currentModel 不存在时回退空态。
 * animateMax：切换模型触发的重载时传 true——刷新后级别仍为 max 则触发金色流光
 * （与手动切级别到 max 一致，确认新模型下最强推理仍在生效）。
 */
async function loadThinkingState(animateMax = false): Promise<void> {
  const gen = ++tlGen;
  if (!props.currentModel) {
    availableLevels.value = [];
    currentLevel.value = null;
    return;
  }
  try {
    const res = await call<ModelThinkingLevels>('model/getModelThinkingLevels', {
      model: props.currentModel,
    });
    if (gen !== tlGen) return;
    availableLevels.value = res.levels ?? [];
  } catch (e) {
    if (gen !== tlGen) return;
    console.warn('[thinkingLevel] 查询可用级别失败，隐藏切换器', e);
    availableLevels.value = [];
    currentLevel.value = null;
    return;
  }
  try {
    // 草稿态无 sessionId：传空参查全局默认（后端语义见 docs/api/05_model.md §9）
    const res = await call<SessionThinkingLevel>(
      'model/getSessionThinkingLevel',
      props.sessionId ? { sessionId: props.sessionId } : {},
    );
    if (gen !== tlGen) return;
    currentLevel.value = res.level ?? null;
    // 切换模型后级别仍为 max：同样触发金色流光（displayLevel 兼容新模型不支持 max 的回退）
    if (animateMax && displayLevel.value === 'max') triggerShimmer();
  } catch (e) {
    if (gen !== tlGen) return;
    console.warn('[thinkingLevel] 查询当前思考级别失败（降级回显）', e);
    currentLevel.value = null;
  }
}

/** 触发器/选项高亮展示的级别：会话级 off 在菜单不可选时回退最小可用级别（MP-S07 对话框不出现 off） */
const displayLevel = computed<ThinkingLevel | null>(() => {
  const cur = currentLevel.value;
  if (cur === null) {
    return null;
  }
  if (availableLevels.value.includes(cur)) {
    return cur;
  }
  return availableLevels.value[0] ?? cur;
});

function toggleLevelMenu(): void {
  levelMenuOpen.value = !levelMenuOpen.value;
}

/** 触发输入框 max 动画（仅 MAX 浮现→停留→淡出，全程约 2.8s 后自移除，重入时重启动画） */
function triggerShimmer(): void {
  if (shimmerTimer) clearTimeout(shimmerTimer);
  shimmerOn.value = false;
  // 同一帧后再挂载，确保 CSS 动画能重新启动
  requestAnimationFrame(() => {
    shimmerOn.value = true;
    shimmerTimer = setTimeout(() => {
      shimmerOn.value = false;
    }, 2900);
  });
}

/** 选择思考级别：乐观更新本地 + 写当前会话（同步全局默认由后端处理）；
 *  草稿态（无 sessionId）仅本地记录，随会话创建由 ConversationView 落库（见其草稿发送分支）；切换 max 触发金色流光动画 */
function selectLevel(level: ThinkingLevel): void {
  levelMenuOpen.value = false;
  const prev = currentLevel.value;
  if (level === prev) return;
  currentLevel.value = level; // 乐观更新，不弹 toast
  if (level === 'max') triggerShimmer();
  if (!props.sessionId) return; // 草稿态：无会话可写，留给发送时随会话创建落库
  call('model/setSessionThinkingLevel', { sessionId: props.sessionId, level }).catch((e) => {
    console.warn('[thinkingLevel] 切换思考级别失败（静默降级）', e);
  });
}

/** 点击浮窗外部关闭模型菜单 */
function onDocClick(e: MouseEvent): void {
  const el = e.target as HTMLElement | null;
  const inModel = el && typeof el.closest === 'function' && el.closest('.model-wrap');
  const inLevel = el && typeof el.closest === 'function' && el.closest('.level-wrap');
  const inProj = el && typeof el.closest === 'function' && el.closest('.proj-wrap');
  const inQueue = el && typeof el.closest === 'function' && el.closest('.queue-wrap');
  if (inModel || inLevel || inProj || inQueue) return;
  modelMenuOpen.value = false;
  levelMenuOpen.value = false;
  projMenuOpen.value = false;
  queuePanelOpen.value = false;
}

/**
 * 停止时回填被清空的待发队列文本（CV-S09，pi TUI ESC 同款）：
 * 队列文本按空行段落拼接，置于当前输入内容之前（对齐 TUI [queued, current] 顺序）。
 */
function restoreQueuedText(items: string[]): void {
  const valid = items.filter((s) => typeof s === 'string' && s.trim() !== '');
  if (valid.length === 0) return;
  const queued = valid.join('\n\n');
  const current = text.value.trim();
  text.value = current ? `${queued}\n\n${current}` : queued;
  queuePanelOpen.value = false;
  nextTick(() => {
    autoGrow();
    focus();
  });
}

function focus(): void {
  textareaRef.value?.focus();
}

// currentLevel 供父组件读取：草稿态发送首条消息时随新会话写入（见 ConversationView.onSend）
defineExpose({ focus, currentLevel, restoreQueuedText });

/** 压缩开始/完成事件订阅（自动压缩锁定输入 + 刷新用量；手动压缩同样经此收尾） */
let unsubCompacted: (() => void) | null = null;
let unsubCompacting: (() => void) | null = null;
/** 命令上报扩展（slashCommandsUpdated）订阅：收到后清空命令缓存，下次触发重拉（AC-CV-032） */
let unsubSlash: (() => void) | null = null;

onMounted(() => {
  nextTick(autoGrow);
  document.addEventListener('click', onDocClick);
  if (props.sessionId) void refreshUsage();
  void loadThinkingState();
  // 命令上报扩展到达：失效该会话命令清单缓存（草稿态无 sessionId 时全局接受）
  unsubSlash = subscribe('conversation.slashCommandsUpdated', (payload) => {
    const p = payload as { sessionId?: string };
    if (props.sessionId && p.sessionId && p.sessionId !== props.sessionId) return;
    commands.value = [];
  });
  // 自动压缩（运行时按阈值/溢出触发）没有 RPC 入口，只能靠事件感知：
  // compacting → 锁定输入 + 持久横幅；compacted → 解锁 + 刷新用量 + 横幅收尾
  unsubCompacting = subscribe('conversation.compacting', (payload) => {
    const p = payload as { sessionId?: string };
    if (p.sessionId !== props.sessionId) return;
    autoCompacting.value = true;
    if (props.sessionId) markCompacting(props.sessionId);
  });
  unsubCompacted = subscribe('conversation.compacted', (payload) => {
    const p = payload as {
      sessionId?: string;
      tokensBefore?: number | null;
      tokensAfter?: number | null;
    };
    if (p.sessionId !== props.sessionId) return;
    autoCompacting.value = false;
    void refreshUsage();
    // 自动压缩的横幅收尾在此统一处理（手动压缩 RPC 返回时也会再标记一次，幂等）
    if (props.sessionId) markDone(props.sessionId, p.tokensBefore ?? null, p.tokensAfter ?? null);
  });
});

onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  unsubCompacted?.();
  unsubCompacting?.();
  unsubSlash?.();
  if (attachErrorTimer) clearTimeout(attachErrorTimer);
  if (shimmerTimer) clearTimeout(shimmerTimer);
  if (spinnerTimer) clearInterval(spinnerTimer);
});

// 会话回到空闲时自动聚焦输入框；一轮回复完成后刷新上下文用量（P3-A）。
// 同时兜底解除自动压缩锁定：compaction 被中止时 compacted 事件不成对发射，
// 轮次结束即可安全解锁（压缩不可能跨轮次存活）
watch(
  () => props.sessionStatus,
  (s) => {
    if (s === 'idle' || s === 'done') {
      autoCompacting.value = false;
      nextTick(focus);
      void refreshUsage();
    }
  },
);

// 切换会话：重载输入历史（不同会话的历史独立存储）
watch(
  () => props.sessionId,
  (sid) => {
    // 如果之前在历史模式（残留的 input 文本是上一会话的某条历史），切会话后应清空
    // 草稿态则保留 input 不动（草稿不被会话清空）
    if (historyCursor.value >= 0) {
      text.value = '';
      pendingDraft = '';
      nextTick(autoGrow); // 空文本 → 重置回默认高度
    }
    loadHistory(sid);
  },
  { immediate: true },
);

// 会议切换 / sessionId 变化时重新拉取用量（横幅状态在 useCompactBanner 内按会话隔离保留）
watch(
  () => props.sessionId,
  () => {
    usage.value = null;
    autoCompacting.value = false;
    commandPanelOpen.value = false;
    commands.value = []; // 切换会话 → 命令清单缓存失效，下次触发重拉
    if (props.sessionId) void refreshUsage();
  },
);

// 切换项目 → @ 候选缓存失效 + 浮窗关闭
watch(
  () => props.projectPath,
  () => {
    atPanelOpen.value = false;
    atCandidates.value = [];
    atLoadedFor.value = null;
  },
);

// 会话 / 当前模型变化时重新加载思考级别状态（MP-S05）；模型变化时带 animateMax，
// 刷新后仍为 max 则播放金色流光
watch(
  () => [props.currentModel, props.sessionId] as const,
  ([model], [prevModel]) => {
    levelMenuOpen.value = false;
    void loadThinkingState(model !== prevModel);
  },
);
</script>

<template>
  <div
    ref="inputBoxRef"
    class="compose-box"
    :class="{ streaming: isStreaming, focused, dragover: dragOver }"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop="onDrop"
  >
    <!-- 上边沿：透明拖拽带，悬停显示 row-resize，可拖拽调整整个输入框高度 -->
    <div
      class="cb-resize"
      title="拖动调整输入框高度"
      @pointerdown="onResizeDown"
      @pointermove="onResizeMove"
      @pointerup="onResizeUp"
    ></div>
    <!-- 进行中蚂蚁线边框：SVG overlay 沿圆角画流动虚线；聚焦/拖拽时隐藏，让位 brand 实线 -->
    <svg v-if="isStreaming" class="cb-ants" aria-hidden="true"><rect /></svg>
    <!-- max 思考级别动画（仅 "M A X" 底部浮现 → 停留 → 淡出；纯视觉层 pointer-events:none 不阻塞输入） -->
    <div v-if="shimmerOn" class="max-shimmer" aria-hidden="true">
      <span class="max-text">M A X</span>
    </div>
    <!-- 附件待发区（统一给路径）：图片 = 64px 缩略图（点击放大）；其他 = 胶囊 chip（icon+文件名）；可移除 -->
    <div ref="attachRowRef" class="attach-row">
      <template v-for="(att, i) in attachments" :key="att.path + i">
        <div v-if="att.dataUrl" class="attach-image" :title="att.name">
          <img
            class="attach-image-img"
            :src="att.dataUrl"
            alt=""
            draggable="false"
            @click="lightboxSrc = att.dataUrl ?? null"
          />
          <button class="attach-remove" title="移除附件" @click.stop="removeAttachment(i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
        <div v-else class="attach-chip" :class="{ flagged: att.flagged }" :title="att.path">
          <span class="attach-icon">
            <svg v-if="isImagePath(att.name)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
          <span class="attach-name" :title="att.flagged ? `${att.name}（疑似含密钥）` : att.name">{{ att.name }}</span>
          <button class="attach-remove" title="移除附件" @click="removeAttachment(i)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      </template>
      <div v-if="attachError" class="attach-error">{{ attachError }}</div>
    </div>

    <textarea
      ref="textareaRef"
      v-model="text"
      class="compose-input"
      :placeholder="isStreaming ? `${spinnerFrame} 助手回复中，Enter 排队发送…` : compacting || autoCompacting ? '正在压缩上下文，稍候…' : '输入问题或指令… Enter 发送，Ctrl+V 粘贴截图'"
      :disabled="inputLocked"
      :rows="3"
      spellcheck="false"
      @input="onInput"
      @keydown="onKeydown"
      @keyup="onCursorMove"
      @click="onCursorMove"
      @paste="onPaste"
      @focus="focused = true"
      @blur="onBlur"
    ></textarea>

    <!-- 斜杠命令浮窗（CV-S08，AC-CV-026~030/032/033）：向上弹出、行首 / 触发，命令=原始串替换 -->
    <div
      v-if="commandPanelOpen"
      class="slash-menu"
      @mousedown.prevent
    >
      <div v-if="commands.length === 0" class="slash-empty">无可用命令</div>
      <template v-else>
        <button
          v-for="(item, i) in filteredCommands"
          :key="item.name"
          class="slash-item"
          :class="{ highlighted: i === highlightIndex }"
          type="button"
          @click="applyCommand(item)"
        >
          <span class="slash-main">
            <span class="slash-name" :class="'is-' + item.source">{{ formatCommandLabel(item.name) }}</span>
            <span class="slash-tag" :class="'tag-' + item.source">{{ SOURCE_LABELS[item.source] }}</span>
          </span>
          <span v-if="item.description" class="slash-desc">{{ item.description }}</span>
        </button>
        <div v-if="filteredCommands.length === 0" class="slash-empty">无匹配命令</div>
      </template>
    </div>

    <!-- @ 文件补全浮窗（CV-S01 扩展 v3.30）：行内 @ 触发，选中进待发区（发送时拼 @ 路径行） -->
    <div
      v-if="atPanelOpen"
      class="slash-menu at-menu"
      @mousedown.prevent
    >
      <div v-if="atFiltered.length === 0" class="slash-empty">无匹配文件</div>
      <button
        v-for="(p, i) in atFiltered"
        :key="p"
        class="slash-item at-item"
        :class="{ highlighted: i === atHighlight }"
        type="button"
        :title="p"
        @click="applyAtFile(p)"
      >
        <span class="slash-main">
          <span class="at-icon" aria-hidden="true">
            <svg v-if="isImagePath(p)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
          <span class="at-name">{{ atItemParts(p).name }}</span>
          <span v-if="atItemParts(p).dir" class="at-dir">{{ atItemParts(p).dir }}</span>
        </span>
      </button>
    </div>

    <div class="compose-bar">
      <div class="compose-links">
        <!-- 项目选择器（SM-S01 v3.21）：草稿=选归属；会话中=同式样可点，信息态+定位 -->
        <div v-if="projectPicker" class="proj-wrap">
          <button
            type="button"
            class="meta-link proj-pill"
            :class="{ 'proj-pill-static': projectPicker.mode === 'session' }"
            :data-tooltip="projectPicker.mode === 'draft' ? '选择新会话归属项目' : '会话归属项目'"
            @click="toggleProjMenu"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span>{{ projectPicker.currentName }}</span>
            <span v-if="projectPicker.mode === 'draft'" class="proj-caret" aria-hidden="true">▾</span>
          </button>
          <div v-if="projMenuOpen && projectPicker.mode === 'draft'" class="model-menu proj-menu">
            <template v-if="projectPicker.mode === 'draft'">
              <div class="menu-hint">新会话归属项目</div>
              <button
                v-for="it in projectPicker.items"
                :key="it.path"
                type="button"
                class="proj-item"
                :class="{ active: it.path === projectPicker.currentPath }"
                @click="onPickProject(it.path)"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span class="proj-item-main">
                  <span class="proj-item-name">{{ it.name }}</span>
                  <span class="proj-item-path" :title="it.path">{{ it.path }}</span>
                </span>
                <span
                  class="proj-item-del"
                  :class="{ confirming: projDeleteConfirmPath === it.path }"
                  :title="projDeleteConfirmPath === it.path ? '再次点击确认移除' : '移除项目（连同其下会话一并删除，源文件保留）'"
                  role="button"
                  @click.stop.prevent="onProjDelete(it.path)"
                >
                  <span v-if="projDeleteConfirmPath === it.path" class="confirm-text">确认</span>
                  <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </span>
              </button>
              <div class="proj-menu-sep"></div>
              <button type="button" class="proj-item" @click="onOpenProjectPicker">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                </svg>
                <span class="proj-item-main"><span class="proj-item-name">打开项目…</span></span>
              </button>
            </template>
          </div>
        </div>

        <!-- 附件 -->
        <button
          class="meta-link"
          :disabled="inputLocked"
          data-tooltip="添加附件（图片 / 文本 / Office 文档）"
          aria-label="附件"
          @click="pickAttachments"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
          </svg>
          <span>附件</span>
        </button>

        <!-- 模型：点击字样弹浮窗切换 -->
        <div class="model-wrap">
          <button
            class="meta-link"
            type="button"
            data-tooltip="会话模型 · 点击切换"
            @click.stop="toggleModelMenu"
          >
            <span>{{ currentModel ?? '选择模型' }}</span>
          </button>
          <div v-if="modelMenuOpen" class="model-menu">
            <div class="menu-hint">本会话生效模型</div>
            <button
              v-for="m in models"
              :key="m"
              class="menu-item"
              :class="{ active: m === currentModel }"
              type="button"
              @click="selectModel(m)"
            >
              {{ m }}
            </button>
          </div>
        </div>

        <!-- 思考级别：模型选择旁紧凑切换器
        显示条件：含任一非 off 挡位即显示（非推理模型 levels=["off"] 隐藏；
        推理模型即使只剩单个挡位如 ["max"] 也显示，MP-S07） -->
        <div v-if="availableLevels.some((l) => l !== 'off')" class="level-wrap">
          <button
            class="meta-link"
            :class="{ 'is-max': displayLevel === 'max' }"
            type="button"
            data-tooltip="思考级别 · 点击切换"
            @click.stop="toggleLevelMenu"
          >
            <span>{{ displayLevel ?? 'off' }}</span>
          </button>
          <div v-if="levelMenuOpen" class="level-menu">
            <button
              v-for="lv in availableLevels"
              :key="lv"
              class="menu-item"
              :class="{ active: lv === displayLevel }"
              type="button"
              @click="selectLevel(lv)"
            >
              {{ lv }}
            </button>
          </div>
        </div>
      </div>

      <div class="compose-actions">
        <div class="ctx-wrap">
          <div
            class="ctx"
            :class="{ 'ctx-warn': usageWarning }"
            :title="usageError || '上下文用量，接近上限可压缩'"
            data-tooltip="上下文用量"
          >
            <span class="ctx-num">{{ usageLabel }}</span>
            <div class="ctx-track">
              <div
                class="ctx-fill"
                :class="{ warn: usageWarning }"
                :style="{ width: usagePct + '%' }"
              ></div>
            </div>
            <span
              class="ctx-cmp"
              :class="{ disabled: compactDisabled }"
              :title="compactTitle"
              @click="onCompact"
            >{{ compactLabel }}</span>
          </div>
        </div>

        <!-- CV-S09 待发送队列徽标 + 只读浮窗：忙时入队的消息在派发前暂存于此 -->
        <div v-if="queueList.length > 0" class="queue-wrap">
          <button
            class="queue-badge"
            type="button"
            data-tooltip="待发送队列"
            @click.stop="queuePanelOpen = !queuePanelOpen"
          >
            待发送 {{ queueList.length }}
          </button>
          <div v-if="queuePanelOpen" class="queue-panel">
            <div class="menu-hint">待发送队列（忙完自动按序发出）</div>
            <div v-for="(item, i) in queueList" :key="i" class="queue-item">{{ item }}</div>
          </div>
        </div>

        <!-- 发送/停止 -->
        <button
          v-if="!isStreaming"
          class="send-btn"
          :disabled="!canSend"
          aria-label="发送"
          data-tooltip="发送（Enter）"
          @click="onSend"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
        <button
          v-if="isStreaming && canSend"
          class="send-btn queue-send"
          aria-label="排队发送"
          data-tooltip="排队发送（Enter）"
          @click="onSend"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="22" y1="2" x2="11" y2="13" />
            <polygon points="22 2 15 22 11 13 2 9 22 2" />
          </svg>
        </button>
        <button v-if="isStreaming" class="cancel-btn" aria-label="停止" data-tooltip="停止（清空待发送队列并回填输入框）" @click="onCancel">
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button>
      </div>
    </div>

    <!-- 图片预览弹窗（待发缩略图点击打开，滚轮缩放，Esc/点遮罩关闭） -->
    <ImageLightbox :src="lightboxSrc" @close="lightboxSrc = null" />
  </div>
</template>

<style scoped>
.compose-box {
  position: relative;
  padding: 12px 14px 58px; /* 底部预留：给钉在底部的操作行留空间 */
  border-radius: 16px;
  border: 1px solid var(--input);
  background: var(--background);
  display: flex;
  flex-direction: column;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

/* 上边沿调整带：把命中区对准输入框外层 border 的顶部边沿（不再画内层线） */
.cb-resize {
  position: absolute;
  top: -5px;
  left: 0;
  right: 0;
  height: 10px;
  cursor: row-resize;
  touch-action: none;
  z-index: 2;
}

.compose-box:focus-within {
  border-color: var(--brand);
  /* 仅保留外圈边框；去掉内圈 3px 光环 */
}

/* 进行中：蚂蚁线（流动虚线）画在 SVG overlay 上，实体边框让位为透明；
   聚焦时整条让位会导致无框，故显式回 brand 实线（权重高于 :focus-within/.streaming 单条） */
.compose-box.streaming {
  border-color: transparent;
}

.compose-box.streaming:focus-within {
  border-color: var(--brand);
}

.cb-ants {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
  overflow: visible;
}

.cb-ants rect {
  x: 0.5px;
  y: 0.5px;
  width: calc(100% - 1px);
  height: calc(100% - 1px);
  rx: 15.5px;
  ry: 15.5px;
  fill: none;
  stroke: var(--foreground);
  stroke-width: 1;
  stroke-dasharray: 6 6;
  animation: cb-ants-march 0.9s linear infinite;
}

/* 聚焦（排队打字）/拖拽附件时隐藏蚂蚁线，露出 brand 实线 */
.compose-box:focus-within .cb-ants,
.compose-box.dragover .cb-ants {
  display: none;
}

@keyframes cb-ants-march {
  to {
    stroke-dashoffset: -12;
  }
}

/* 拖拽图片悬停高亮：边框品牌色 + 轻微底色提示可放置 */
.compose-box.dragover {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 4%, var(--background));
}

/* 紧凑模式（多窗口）：与单窗口输入框高度规则保持一致（可拖拽调整） */

/* 附件待发区 */
.attach-row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin: 0 0 10px;
}

.attach-row:empty {
  display: none;
}

.attach-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 4px 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--foreground);
}

/* 命中密钥嗅探的附件：警示色边框提醒 */
.attach-chip.flagged {
  border-color: color-mix(in oklab, var(--warning, #d97706) 60%, var(--border));
}

.attach-icon {
  display: inline-flex;
  color: var(--muted-foreground);
  flex-shrink: 0;
}

/* 图片附件：固定 64px 正方形缩略图卡片；点击弹窗预览，× 悬浮右上角（hover 显示） */
.attach-image {
  position: relative;
  width: 64px;
  height: 64px;
  border: 1px solid var(--border);
  border-radius: 10px;
  overflow: hidden;
  flex-shrink: 0;
}

.attach-image-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: zoom-in;
  user-select: none;
}

.attach-image .attach-remove {
  position: absolute;
  top: 3px;
  right: 3px;
  width: 18px;
  height: 18px;
  background: color-mix(in oklab, var(--background) 75%, transparent);
  color: var(--foreground);
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.attach-image:hover .attach-remove,
.attach-image .attach-remove:focus-visible {
  opacity: 1;
}

.attach-image .attach-remove:hover {
  color: var(--destructive);
  background: color-mix(in oklab, var(--destructive) 18%, var(--background));
}

.attach-icon svg {
  width: 12px;
  height: 12px;
}

.attach-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attach-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 4px;
  color: var(--muted-foreground);
  cursor: pointer;
  flex-shrink: 0;
}

.attach-remove:hover {
  color: var(--destructive);
  background: color-mix(in oklab, var(--destructive) 10%, transparent);
}

.attach-remove svg {
  width: 11px;
  height: 11px;
}

.attach-error {
  font-size: 12px;
  color: var(--destructive);
  padding: 2px 4px;
}

.compose-input {
  display: block;
  width: 100%;
  border: none;
  outline: none;
  background: transparent;
  color: var(--foreground);
  font-size: 14px;
  line-height: 1.6;
  font-family: var(--font-sans);
  flex: 1 1 auto;
  min-height: 68px;
  max-height: 360px;
  resize: none; /* 去掉右下角缩放手柄，高度统一由上边沿拖拽控制 */
  user-select: text;
}

.compose-input::placeholder {
  color: var(--muted-foreground);
}

.compose-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.compose-input:focus {
  /* 内圈文本区无需任何焦点边框/光环，仅由外圈 .compose-box 边框表达聚焦 */
  border: none;
  outline: none;
  box-shadow: none;
}

/* 底部操作条：钉在输入框最底部，无论盒子高度如何都不再移动 */
.compose-bar {
  position: absolute;
  left: 14px;
  right: 14px;
  bottom: 12px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}

.compose-links {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.meta-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted-foreground);
  padding: 4px 6px;
  border: none;
  background: transparent;
  border-radius: 6px;
  line-height: 1;
  cursor: pointer;
}

.meta-link:hover:not(:disabled) {
  color: var(--foreground);
  background: var(--card);
  border-color: transparent;
}

.meta-link:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.meta-link svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

/* 模型浮窗菜单（对齐原型 .menu：向上弹、点外部关） */
.model-wrap {
  position: relative;
}

/* CV-S09 待发送队列：徽标 + 向上弹出只读浮窗（对齐 .model-menu 视觉） */
.queue-wrap {
  position: relative;
}

.queue-badge {
  flex-shrink: 0;
  padding: 3px 10px;
  font-size: 12px;
  font-weight: 600;
  color: var(--foreground);
  background: color-mix(in oklab, var(--primary) 12%, var(--background));
  border: 1px solid color-mix(in oklab, var(--primary) 30%, var(--border));
  border-radius: 999px;
  cursor: pointer;
  white-space: nowrap;
}

.queue-badge:hover {
  background: color-mix(in oklab, var(--primary) 20%, var(--background));
}

.queue-panel {
  position: absolute;
  right: 0;
  bottom: calc(100% + 10px);
  min-width: 220px;
  max-width: 340px;
  max-height: 260px;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 700;
  animation: menu-rise 0.15s ease both;
}

.queue-item {
  padding: 6px 10px;
  font-size: 12.5px;
  line-height: 1.5;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
  border-radius: 6px;
}

.queue-item + .queue-item {
  border-top: 1px solid var(--border);
}

.queue-send {
  margin-right: 2px;
}

.model-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  min-width: 190px;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 700;
  animation: menu-rise 0.15s ease both;
}

/* 项目选择器（SM-S01 v3.21）：pill + 下拉 */
.proj-wrap {
  position: relative;
}

.proj-pill {
  font-weight: 600;
  color: var(--foreground);
}

/* 会话中归属只读：不弹浮窗、去除可点反馈 */
.proj-pill-static {
  cursor: default;
}

.proj-pill-static:hover {
  background: transparent;
}

.proj-menu {
  min-width: 280px;
  max-height: 320px;
  overflow-y: auto;
}

.proj-item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.proj-item:hover {
  background: color-mix(in oklab, var(--surface-hover) 55%, transparent);
}

.proj-item.active {
  background: color-mix(in oklab, var(--surface-active) 55%, transparent);
}

/* 上下相邻两项同为焦点（active/hover）时留 1px 缝，避免高亮块粘连 */
:is(.proj-item.active, .proj-item:hover) + :is(.proj-item.active, .proj-item:hover) {
  margin-top: 1px;
}

.proj-item svg {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
  color: var(--muted-foreground);
}

.proj-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.proj-item-name {
  font-size: 12.5px;
  font-weight: 600;
}

.proj-item-path {
  font-size: 10.5px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl; /* 超长路径保尾段（目录名）可见 */
  text-align: left;
}

/* 移除按钮：悬停=裸 × 无底色；确认态=红色「确认」胶囊（同删除会话款） */
.proj-item-del {
  flex: 0 0 auto;
  display: none;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 4px;
  border: 1px solid transparent;
  border-radius: 999px;
  background: transparent;
  color: var(--destructive);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.proj-item:hover .proj-item-del {
  display: inline-flex;
}

.proj-item-del svg {
  width: 12px;
  height: 12px;
}

.proj-item-del.confirming {
  display: inline-flex;
  background: var(--destructive);
  color: #fff;
  border-color: var(--destructive);
  font-weight: 500;
  padding: 0 8px;
  min-width: 44px;
}

.proj-item-del.confirming:hover {
  background: color-mix(in oklab, var(--destructive) 85%, black);
}

.confirm-text {
  font-size: 11px;
  white-space: nowrap;
}

.proj-menu-sep {
  height: 1px;
  background: var(--border);
  margin: 3px 6px;
}

.menu-hint {
  padding: 8px 12px 2px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.menu-item {
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  background: transparent;
  border-radius: 6px;
  font-size: 12px;
  color: var(--foreground);
}

.menu-item:hover {
  background: var(--muted);
  color: var(--foreground);
  border-color: transparent;
}

.menu-item.active {
  font-weight: 500;
}

@keyframes menu-rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* 斜杠命令浮窗（CV-S08）：向上弹出、对齐 .model-menu 视觉，位置由外层 .compose-box 绝对定位 */
.slash-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  min-width: 220px;
  max-width: 100%; /* 封顶=输入框宽度：长描述不再把浮窗撑得比输入框宽，超出由条目 ellipsis 截断 */
  max-height: 40vh;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 700;
  animation: menu-rise 0.15s ease both;
}

.slash-item {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border: none;
  background: transparent;
  border-radius: 8px;
  cursor: pointer;
}

.slash-item.highlighted,
.slash-item:hover {
  background: var(--muted);
}

.slash-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.slash-name {
  font-size: 13px;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* 来源样式：技能=加粗+品牌色；扩展=普通前景；模板=弱化前景 */
.slash-name.is-skill {
  font-weight: 700;
  color: var(--brand);
}
.slash-name.is-extension {
  color: var(--foreground);
}
.slash-name.is-prompt {
  color: var(--muted-foreground);
}

.slash-tag {
  flex-shrink: 0;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  color: var(--muted-foreground);
  background: var(--muted);
}
.slash-tag.tag-skill {
  color: var(--brand);
  background: color-mix(in oklab, var(--brand) 14%, transparent);
}
.slash-tag.tag-extension {
  color: var(--foreground);
  background: var(--muted);
}
.slash-tag.tag-prompt {
  color: var(--muted-foreground);
  background: var(--muted);
}

.slash-desc {
  margin-top: 4px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* @ 文件补全条目：图标 + 文件名 + 去项目前缀的目录提示（复用 slash-menu 容器样式） */
.at-item .slash-main {
  align-items: baseline;
}
.at-icon {
  display: inline-flex;
  align-self: center;
  flex: none;
}
.at-icon svg {
  width: 13px;
  height: 13px;
  color: var(--muted-foreground);
}
.at-name {
  font-size: 13px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.at-dir {
  flex: 1;
  min-width: 0;
  text-align: right;
  font-size: 11px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-empty {
  padding: 12px;
  text-align: center;
  font-size: 12px;
  color: var(--muted-foreground);
}

/* 思考级别切换器（MP-S05）：紧凑胶囊，紧邻模型选择，弹层样式对齐 .model-menu */
.level-wrap {
  position: relative;
}

.level-menu {
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  min-width: 150px;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 700;
  animation: menu-rise 0.15s ease both;
}

/* 思考级别胶囊：默认前景色（黑）；当前级别为 max 时金黄色，与 MAX 动画文字同色，提示已启用最强推理 */
.level-wrap .meta-link {
  color: var(--foreground);
}
.level-wrap .meta-link.is-max {
  color: var(--logo-gradient-accent);
}

/* max 动画：仅 "M A X" 文字浮现→停留→淡出；容器只负责裁剪与隔离 */
.max-shimmer {
  position: absolute;
  inset: 0;
  border-radius: 16px;
  overflow: hidden;
  pointer-events: none;
  z-index: 3;
}

/* "M A X" 文字：底部居中浮现，LOGO 同款金色渐变流动 + 金色光晕（等宽字体贴近 cli 终端质感） */
.max-text {
  position: absolute;
  left: 50%;
  bottom: 15px;
  transform: translateX(-50%);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 700;
  letter-spacing: 0.18em;
  background: linear-gradient(90deg,
    var(--logo-gradient-base) 0%,
    var(--logo-gradient-accent) 30%,
    color-mix(in srgb, var(--logo-gradient-accent) 55%, white) 50%,
    var(--logo-gradient-accent) 70%,
    var(--logo-gradient-base) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
  white-space: nowrap;
  filter: drop-shadow(0 0 12px color-mix(in srgb, var(--logo-gradient-accent) 45%, transparent));
  animation: max-text-flow 2.4s linear infinite, max-in 0.45s ease-out 0.1s both, max-out 0.6s ease 2.2s both;
}
@keyframes max-text-flow {
  0% { background-position: 0% 0%; }
  100% { background-position: 200% 0%; }
}
@keyframes max-in {
  from { opacity: 0; transform: translateX(-50%) translateY(8px); }
  to { opacity: 1; transform: translateX(-50%) translateY(0); }
}
@keyframes max-out {
  from { opacity: 1; }
  to { opacity: 0; }
}

.compose-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* 上下文用量容器 */
.ctx-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* 上下文用量（发送左侧、去边框） */
.ctx {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: nowrap;
}

.ctx.warn .ctx-num {
  color: var(--warning);
}

.ctx-num {
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.ctx-track {
  width: 50px;
  height: 4px;
  border-radius: 999px;
  background: var(--muted);
  overflow: hidden;
}

.ctx-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: var(--brand);
  transition: width 300ms ease;
}

.ctx-fill.warn {
  background: var(--warning);
}

.ctx-cmp {
  padding: 3px 5px;
  border-radius: 5px;
  font-size: 12px;
  color: var(--muted-foreground);
  cursor: pointer;
}

.ctx-cmp:hover {
  color: var(--foreground);
  background: var(--muted);
}

.ctx-cmp.disabled {
  opacity: 0.5;
  cursor: default;
}

/* 发送/停止（对齐原型：常显品牌色，禁用态灰） */
.send-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  padding: 0;
  display: grid;
  place-items: center;
  background: var(--brand);
  border: none;
  border-radius: 999px;
  color: var(--brand-foreground);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.send-btn svg {
  width: 16px;
  height: 16px;
}

.send-btn:hover:not(:disabled) {
  background: var(--brand-hover);
}

.send-btn:disabled {
  opacity: 1;
  background: var(--muted);
  color: var(--muted-foreground);
  cursor: default;
}

.cancel-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  padding: 0;
  display: grid;
  place-items: center;
  color: var(--destructive);
  background: color-mix(in oklab, var(--destructive) 10%, var(--background));
  border: 1px solid color-mix(in oklab, var(--destructive) 22%, var(--border));
  border-radius: 999px;
}

.cancel-btn svg {
  width: 14px;
  height: 14px;
}
</style>
