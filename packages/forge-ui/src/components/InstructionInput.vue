<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted, onUnmounted } from 'vue';
import type { SessionStatus } from '../types';

/**
 * 指令输入框。
 * 参考 ai-coding 的 composer 视觉，但精简为 textarea（非 contenteditable），
 * 因 forge-core mock 不支持 skill/文件提及/附件上传，相关按钮仅占位禁用。
 * 模型切换为点击浮窗菜单（对齐原型 .menu 机制：点字样开、点外部关）。
 */
const props = defineProps<{
  /** 当前会话状态，streaming 时切换为停止按钮并禁用输入 */
  sessionStatus: SessionStatus;
  /** 可选模型列表（来自 model/queryModels） */
  models: string[];
  /** 当前会话模型（来自 model/getSessionModel），null 表示用默认 */
  currentModel: string | null;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'cancel'): void;
  (e: 'model-change', model: string): void;
}>();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const attachRowRef = ref<HTMLElement | null>(null);
const focused = ref(false);
const modelMenuOpen = ref(false);

const isStreaming = computed(() => props.sessionStatus === 'streaming');
const canSend = computed(() => text.value.trim().length > 0 && !isStreaming.value);
const charCount = computed(() => text.value.length);
const MAX_CHARS = 8000;

/** textarea 自适应高度，上限 200px */
function autoGrow(): void {
  const el = textareaRef.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

function onInput(): void {
  autoGrow();
  if (text.value.length > MAX_CHARS) {
    text.value = text.value.slice(0, MAX_CHARS);
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
  text.value = '';
  nextTick(autoGrow);
  emit('send', t);
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

/** 点击浮窗外部关闭（对齐原型 document click + closest 机制） */
function onDocClick(e: MouseEvent): void {
  const el = e.target as HTMLElement | null;
  if (el && typeof el.closest === 'function' && el.closest('.model-wrap')) return;
  modelMenuOpen.value = false;
}

function focus(): void {
  textareaRef.value?.focus();
}

defineExpose({ focus });

onMounted(() => {
  nextTick(autoGrow);
  document.addEventListener('click', onDocClick);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
});

// 会话回到空闲时自动聚焦输入框
watch(
  () => props.sessionStatus,
  (s) => {
    if (s === 'idle' || s === 'done') {
      nextTick(focus);
    }
  },
);
</script>

<template>
  <div class="compose-box" :class="{ streaming: isStreaming, focused }">
    <!-- 附件待发区（预留，后端接入后展示） -->
    <div ref="attachRowRef" class="attach-row"></div>

    <textarea
      ref="textareaRef"
      v-model="text"
      class="compose-input"
      :placeholder="isStreaming ? '助手正在回复，可点击停止中断…' : '输入你的问题或任务指令… 按 Enter 发送'"
      :disabled="isStreaming"
      :rows="3"
      @input="onInput"
      @keydown="onKeydown"
      @focus="focused = true"
      @blur="focused = false"
    ></textarea>

    <div class="compose-bar">
      <div class="compose-links">
        <!-- 附件 -->
        <button
          class="meta-link"
          disabled
          data-tooltip="附件功能暂未启用"
          aria-label="附件"
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
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
            </svg>
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
      </div>

      <div class="compose-actions">
        <div class="ctx" title="上下文用量，接近上限可压缩" data-tooltip="上下文用量（后端接入后展示）">
          <span class="ctx-num">—</span>
          <div class="ctx-track"><div class="ctx-fill" style="width:0%"></div></div>
          <span class="ctx-cmp">压缩</span>
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
  padding: 12px 14px 10px;
  border-radius: 16px;
  border: 1px solid var(--input);
  background: var(--background);
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.compose-box:focus-within {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand) 10%, transparent);
}

.compose-box.streaming {
  border-color: color-mix(in oklab, var(--warning) 50%, var(--input));
}

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
  min-height: 68px;
  max-height: 360px;
  resize: vertical;
  user-select: text;
}

.compose-input::placeholder {
  color: var(--muted-foreground);
}

.compose-input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 底部操作条 */
.compose-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 10px;
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

.compose-actions {
  display: flex;
  align-items: center;
  gap: 8px;
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
