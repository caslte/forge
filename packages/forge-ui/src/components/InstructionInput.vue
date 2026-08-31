<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue';
import type { SessionStatus, ThinkingLevel, ModelThinkingLevels, SessionThinkingLevel } from '../types';
import { call, subscribe, type AttachmentFile, type ConversationCompactResult } from '../bridge';

/**
 * 指令输入框。
 * 参考 ai-coding 的 composer 视觉，但精简为 textarea（非 contenteditable）。
 * P3-B：附件上传（文件选择 / Ctrl+V 粘贴截图 / 拖拽图片），随消息一起发送。
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
  /** 紧凑模式（多窗口用）：更小的默认高度，可用鼠标拖拽调整 */
  compact?: boolean;
}>();

const emit = defineEmits<{
  (e: 'send', text: string, attachments?: AttachmentFile[]): void;
  (e: 'cancel'): void;
  (e: 'model-change', model: string): void;
}>();

const text = ref('');
/** P3-B：待发附件（图片 base64 / 文本 content，随消息一起发送） */
const attachments = ref<AttachmentFile[]>([]);
const attachError = ref<string | null>(null);
let attachErrorTimer: ReturnType<typeof setTimeout> | null = null;
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const inputBoxRef = ref<HTMLElement | null>(null);
const attachRowRef = ref<HTMLElement | null>(null);
const focused = ref(false);
const modelMenuOpen = ref(false);

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
const canSend = computed(() => (text.value.trim().length > 0 || attachments.value.length > 0) && !isStreaming.value);
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
const compacting = ref(false);
const compactResult = ref<string | null>(null);
/** 最近一次压缩是否失败（失败提示用告警色） */
const compactFailed = ref(false);
let compactResultTimer: ReturnType<typeof setTimeout> | null = null;

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

/**
 * 流式期间禁止压缩：pi 的 compact() 会先 abort 当前轮，导致正在生成的回答被
 * 静默截断（以 stopReason=aborted 入库）。宁可禁用，也不让用户莫名丢回答。
 */
const compactDisabled = computed(() => compacting.value || isStreaming.value);
const compactLabel = computed(() => (compacting.value ? '压缩中…' : '压缩'));
const compactTitle = computed(() => {
  if (compacting.value) return '压缩中…';
  if (isStreaming.value) return '回答生成中，暂不支持压缩';
  return '压缩上下文';
});

/** 压缩结果文案：有前后 token 时展示变化量（pi 在压缩边界后可能仍返回 null） */
function formatCompactResult(r: ConversationCompactResult): string {
  if (!r.ok) return r.message ?? '压缩失败';
  const before = r.tokensBefore;
  const after = r.tokensAfter;
  if (typeof before === 'number' && typeof after === 'number') {
    return `压缩完成：${before} → ${after} tokens`;
  }
  return '压缩完成';
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

/** 手动压缩（P3-A）：成功后刷新用量 */
async function onCompact(): Promise<void> {
  if (!props.sessionId || compacting.value || isStreaming.value) return;
  compacting.value = true;
  compactResult.value = null;
  compactFailed.value = false;
  try {
    const res = await call<{ result: ConversationCompactResult }>('conversation/compact', {
      sessionId: props.sessionId,
    });
    const r = res.result;
    compactFailed.value = !r.ok;
    compactResult.value = formatCompactResult(r);
    await refreshUsage();
  } catch (e) {
    compactFailed.value = true;
    compactResult.value = e instanceof Error ? e.message : '压缩失败';
  } finally {
    compacting.value = false;
    if (compactResultTimer) clearTimeout(compactResultTimer);
    compactResultTimer = setTimeout(() => {
      compactResult.value = null;
    }, 4000);
  }
}

/** textarea 自适应高度上限：与拖拽盒子上限(320)对齐（320 − 上内边距12 − 底部预留58），之后交给滚动条 */
const GROW_MAX = 250;

/**
 * textarea 自适应高度——只增长、不收缩覆盖手动拖拽的高度：
 * 输入字数变多时自动增高，直到与拖拽上限一致的上限后，剩余内容交给 textarea 滚动条。
 */
function autoGrow(): void {
  const el = textareaRef.value;
  if (!el) return;
  const desired = Math.min(el.scrollHeight, GROW_MAX);
  const cur = parseFloat(el.style.height) || 0;
  if (desired > cur) el.style.height = desired + 'px';
}

function onInput(): void {
  autoGrow();
  if (text.value.length > MAX_CHARS) {
    text.value = text.value.slice(0, MAX_CHARS);
  }
}

// ===== 上边沿拖拽调整输入框高度（单窗口 / 多窗口通用） =====
// 上限：避免把消息区挤没 / 输入框挤出屏幕
const RESIZE_MAX = 320;
let rsStartY = 0;
let rsStartH = 0;
let rsFloor = 0;

function onResizeDown(e: PointerEvent): void {
  const el = inputBoxRef.value;
  if (!el) return;
  e.preventDefault();
  // 稳定底线＝上内边距 + 输入区最小高度 + 底部预留：保证钉在底部的操作行始终可见、不移动
  const cs = getComputedStyle(el);
  const pt = parseFloat(cs.paddingTop) || 0;
  const pb = parseFloat(cs.paddingBottom) || 0;
  const ta = textareaRef.value;
  const taMin = ta ? parseFloat(getComputedStyle(ta).minHeight) || 0 : 0;
  rsFloor = Math.max(64, pt + taMin + pb - 2);
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

function onKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing) {
    ev.preventDefault();
    onSend();
  }
}

function onSend(): void {
  if (!canSend.value) return;
  const t = text.value.trim();
  const atts = attachments.value;
  text.value = '';
  attachments.value = [];
  attachError.value = null;
  nextTick(autoGrow);
  emit('send', t, atts.length > 0 ? atts : undefined);
}

/** P3-B：选择附件并加入待发区（图片/文本由主进程读取） */
async function pickAttachments(): Promise<void> {
  if (isStreaming.value) return;
  try {
    const files = await window.forge.dialog.selectFiles();
    if (files.length === 0) return;
    attachments.value = [...attachments.value, ...files];
    attachError.value = null;
  } catch (e) {
    showAttachError(e instanceof Error ? e.message : '读取附件失败');
  }
}

// ===== 截图图片上传：粘贴（Ctrl+V）+ 拖拽 =====
/** 图片大小上限，与主进程 selectFiles 的 10MB 一致 */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 拖拽悬停高亮态 */
const dragOver = ref(false);

/** Blob 读取为纯 base64（去掉 data URL 前缀，与主进程附件 data 格式一致） */
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
 * 把剪贴板/拖入的图片 Blob 加入附件待发区。
 * @param file 图片 Blob（粘贴截图无文件名，自动按时间生成）
 * @param fallbackName 已知文件名（拖入场景），缺省生成「截图-HHmmss.ext」
 */
async function addImageFromBlob(file: Blob, fallbackName?: string): Promise<void> {
  if (file.size > MAX_IMAGE_BYTES) {
    showAttachError('图片超过 10MB 上限，已跳过');
    return;
  }
  const mimeType = file.type || 'image/png';
  const ext = (mimeType.split('/')[1] ?? 'png').split('+')[0] ?? 'png';
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const name = fallbackName ?? `截图-${hh}${mm}${ss}.${ext}`;
  try {
    const data = await blobToBase64(file);
    attachments.value = [
      ...attachments.value,
      { path: `clipboard:${name}`, name, kind: 'image' as const, mimeType, data },
    ];
    attachError.value = null;
  } catch (e) {
    showAttachError(e instanceof Error ? e.message : '图片读取失败');
  }
}

/**
 * 粘贴事件：剪贴板含文本时优先走默认文本粘贴（如从 Excel 复制）；
 * 纯截图（Win+Shift+S 等）拦截为图片附件。
 */
function onPaste(ev: ClipboardEvent): void {
  if (isStreaming.value) return;
  const cd = ev.clipboardData;
  if (!cd) return;
  if (cd.getData('text/plain').trim() !== '') return;
  const images: File[] = [];
  for (const item of cd.items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const f = item.getAsFile();
      if (f) images.push(f);
    }
  }
  if (images.length === 0) return;
  ev.preventDefault();
  for (const f of images) void addImageFromBlob(f);
}

/** 拖拽悬停：仅当拖入的是文件时高亮并允许放置 */
function onDragOver(ev: DragEvent): void {
  if (isStreaming.value) return;
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

/** 放置：读取拖入的图片文件（非图片类型忽略） */
function onDrop(ev: DragEvent): void {
  if (isStreaming.value) return;
  dragOver.value = false;
  const files = Array.from(ev.dataTransfer?.files ?? []);
  if (files.length === 0) return;
  ev.preventDefault();
  for (const f of files) {
    if (f.type.startsWith('image/')) void addImageFromBlob(f, f.name);
  }
}

/** 从待发区移除附件（P3-B 失败/误选可移除重试） */
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
 * 仅当 sessionId 与 currentModel 都存在时才查询（缺少任一回退空态）。
 */
async function loadThinkingState(): Promise<void> {
  const gen = ++tlGen;
  if (!props.sessionId || !props.currentModel) {
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
    const res = await call<SessionThinkingLevel>('model/getSessionThinkingLevel', {
      sessionId: props.sessionId,
    });
    if (gen !== tlGen) return;
    currentLevel.value = res.level ?? null;
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

/** 选择思考级别：乐观更新本地 + 写当前会话（同步全局默认由后端处理）；切换 max 触发金色流光动画 */
function selectLevel(level: ThinkingLevel): void {
  levelMenuOpen.value = false;
  const prev = currentLevel.value;
  if (level === prev) return;
  currentLevel.value = level; // 乐观更新，不弹 toast
  if (level === 'max') triggerShimmer();
  if (!props.sessionId) return;
  call('model/setSessionThinkingLevel', { sessionId: props.sessionId, level }).catch((e) => {
    console.warn('[thinkingLevel] 切换思考级别失败（静默降级）', e);
  });
}

/** 点击浮窗外部关闭模型菜单 */
function onDocClick(e: MouseEvent): void {
  const el = e.target as HTMLElement | null;
  const inModel = el && typeof el.closest === 'function' && el.closest('.model-wrap');
  const inLevel = el && typeof el.closest === 'function' && el.closest('.level-wrap');
  if (inModel || inLevel) return;
  modelMenuOpen.value = false;
  levelMenuOpen.value = false;
}

function focus(): void {
  textareaRef.value?.focus();
}

defineExpose({ focus });

/** 压缩完成事件订阅（自动压缩后刷新用量显示） */
let unsubCompacted: (() => void) | null = null;

onMounted(() => {
  nextTick(autoGrow);
  document.addEventListener('click', onDocClick);
  if (props.sessionId) void refreshUsage();
  void loadThinkingState();
  // 自动压缩（运行时按阈值/溢出触发）没有 RPC 入口，只能靠事件刷新用量显示
  unsubCompacted = subscribe('conversation.compacted', (payload) => {
    const p = payload as { sessionId?: string };
    if (p.sessionId !== props.sessionId) return;
    void refreshUsage();
  });
});

onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  unsubCompacted?.();
  if (compactResultTimer) clearTimeout(compactResultTimer);
  if (attachErrorTimer) clearTimeout(attachErrorTimer);
  if (shimmerTimer) clearTimeout(shimmerTimer);
});

// 会话回到空闲时自动聚焦输入框；一轮回复完成后刷新上下文用量（P3-A）
watch(
  () => props.sessionStatus,
  (s) => {
    if (s === 'idle' || s === 'done') {
      nextTick(focus);
      void refreshUsage();
    }
  },
);

// 会议切换 / sessionId 变化时重新拉取用量
watch(
  () => props.sessionId,
  () => {
    usage.value = null;
    compactResult.value = null;
    if (props.sessionId) void refreshUsage();
  },
);

// 会话 / 当前模型变化时重新加载思考级别状态（MP-S05）
watch(
  () => [props.currentModel, props.sessionId] as const,
  () => {
    levelMenuOpen.value = false;
    void loadThinkingState();
  },
);
</script>

<template>
  <div
    ref="inputBoxRef"
    class="compose-box"
    :class="{ streaming: isStreaming, focused, compact, dragover: dragOver }"
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
    <!-- max 思考级别动画（仅 "M A X" 底部浮现 → 停留 → 淡出；纯视觉层 pointer-events:none 不阻塞输入） -->
    <div v-if="shimmerOn" class="max-shimmer" aria-hidden="true">
      <span class="max-text">M A X</span>
    </div>
    <!-- 附件待发区（P3-B：选择/粘贴/拖入后展示，可移除） -->
    <div ref="attachRowRef" class="attach-row">
      <div v-for="(att, i) in attachments" :key="att.path + i" class="attach-chip">
        <span
          v-if="att.kind === 'image' && att.data"
          class="attach-thumb"
          :style="{ backgroundImage: `url(data:${att.mimeType ?? 'image/png'};base64,${att.data})` }"
        ></span>
        <span v-else class="attach-icon">
          <svg v-if="att.kind === 'image'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
          </svg>
        </span>
        <span class="attach-name" :title="att.path">{{ att.name }}</span>
        <button class="attach-remove" title="移除附件" @click="removeAttachment(i)">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>
      <div v-if="attachError" class="attach-error">{{ attachError }}</div>
    </div>

    <textarea
      ref="textareaRef"
      v-model="text"
      class="compose-input"
      :placeholder="isStreaming ? '助手正在回复，可点击停止中断…' : '输入问题或指令… Enter 发送，Ctrl+V 粘贴截图'"
      :disabled="isStreaming"
      :rows="3"
      @input="onInput"
      @keydown="onKeydown"
      @paste="onPaste"
      @focus="focused = true"
      @blur="focused = false"
    ></textarea>

    <div class="compose-bar">
      <div class="compose-links">
        <!-- 附件 -->
        <button
          class="meta-link"
          :disabled="isStreaming"
          data-tooltip="添加附件（图片 / 文本）"
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
          <!-- 压缩结果提示：绝对定位，避免挤压输入框布局 -->
          <span
            v-if="compactResult"
            class="compact-result"
            :class="{ error: compactFailed }"
          >{{ compactResult }}</span>
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
        <button v-else class="cancel-btn" aria-label="停止" data-tooltip="停止" @click="onCancel">
          <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        </button>
      </div>
    </div>
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

.compose-box.streaming {
  border-color: color-mix(in oklab, var(--warning) 50%, var(--input));
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

.attach-icon {
  display: inline-flex;
  color: var(--muted-foreground);
  flex-shrink: 0;
}

/* 图片附件缩略图：base64 直接渲染，直观确认粘贴/拖入的截图内容 */
.attach-thumb {
  width: 28px;
  height: 28px;
  border-radius: 6px;
  background-size: cover;
  background-position: center;
  background-color: var(--muted);
  border: 1px solid var(--border);
  flex-shrink: 0;
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

/* 上下文用量容器：压缩结果提示相对它绝对定位，避免挤压输入框布局 */
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

/* 压缩结果提示（绝对定位浮在用量条上方，4s 后自动消失） */
.compact-result {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 5;
  padding: 4px 10px;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--popover);
  color: var(--success);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
}

.compact-result.error {
  color: var(--destructive);
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
