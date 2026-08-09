<script setup lang="ts">
import { ref, computed, nextTick, watch, onMounted } from 'vue';
import type { SessionStatus, PermissionLevel } from '../types';

/**
 * 指令输入框。
 * 参考 ai-coding 的 composer 视觉，但精简为 textarea（非 contenteditable），
 * 因 forge-core mock 不支持 skill/文件提及/附件上传，相关按钮仅占位禁用。
 */
const props = defineProps<{
  /** 当前会话状态，streaming 时切换为停止按钮并禁用输入 */
  sessionStatus: SessionStatus;
  /** 可选模型列表（来自 model/queryModels） */
  models: string[];
  /** 当前会话模型（来自 model/getSessionModel），null 表示用默认 */
  currentModel: string | null;
  /** 权限级别（纯前端 localStorage，后端 mock 未实现） */
  permissionLevel: PermissionLevel;
}>();

const emit = defineEmits<{
  (e: 'send', text: string): void;
  (e: 'cancel'): void;
  (e: 'model-change', model: string): void;
  (e: 'permission-change', level: PermissionLevel): void;
}>();

const text = ref('');
const textareaRef = ref<HTMLTextAreaElement | null>(null);
const focused = ref(false);

const isStreaming = computed(() => props.sessionStatus === 'streaming');
const canSend = computed(() => text.value.trim().length > 0 && !isStreaming.value);
const charCount = computed(() => text.value.length);
const MAX_CHARS = 8000;

const permissionLabels: Record<PermissionLevel, string> = {
  'default': '默认',
  'auto': '自动批准',
  'full-access': '完全访问',
};

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

function onModelChange(ev: Event): void {
  const val = (ev.target as HTMLSelectElement).value;
  if (val) emit('model-change', val);
}

function onPermissionChange(ev: Event): void {
  const val = (ev.target as HTMLSelectElement).value as PermissionLevel;
  emit('permission-change', val);
}

function focus(): void {
  textareaRef.value?.focus();
}

defineExpose({ focus });

onMounted(() => {
  nextTick(autoGrow);
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
  <div class="composer" :class="{ streaming: isStreaming, focused }">
    <!-- 流式中提示条 -->
    <div v-if="isStreaming" class="streaming-bar">
      <span class="streaming-dot"></span>
      <span class="streaming-text">正在思考</span>
      <button class="stop-btn" @click="onCancel">
        <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2" /></svg>
        停止
      </button>
    </div>

    <div class="composer-main">
      <!-- 附件按钮占位（forge-core mock 未支持） -->
      <button
        class="composer-icon-btn"
        disabled
        data-tooltip="附件功能暂未启用"
        aria-label="附件"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48" />
        </svg>
      </button>

      <textarea
        ref="textareaRef"
        v-model="text"
        class="composer-textarea"
        :placeholder="isStreaming ? '助手正在回复，可点击停止中断…' : '输入指令，Enter 发送，Shift+Enter 换行'"
        :disabled="isStreaming"
        rows="1"
        @input="onInput"
        @keydown="onKeydown"
        @focus="focused = true"
        @blur="focused = false"
      ></textarea>

      <!-- 发送/停止双态按钮 -->
      <button
        v-if="!isStreaming"
        class="send-btn"
        :class="{ active: canSend }"
        :disabled="!canSend"
        aria-label="发送"
        data-tooltip="发送（Enter）"
        @click="onSend"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="12" y1="19" x2="12" y2="5" />
          <polyline points="5 12 12 5 19 12" />
        </svg>
      </button>
    </div>

    <!-- 底部工具栏 -->
    <div class="composer-toolbar">
      <div class="toolbar-left">
        <!-- 权限下拉 -->
        <label class="toolbar-field" data-tooltip="权限级别（仅前端状态，后端未实现）">
          <svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          </svg>
          <select
            class="toolbar-select"
            :value="permissionLevel"
            @change="onPermissionChange"
          >
            <option v-for="lvl in (['default','auto','full-access'] as PermissionLevel[])" :key="lvl" :value="lvl">
              {{ permissionLabels[lvl] }}
            </option>
          </select>
        </label>

        <!-- 模型下拉 -->
        <label class="toolbar-field" data-tooltip="会话模型">
          <svg class="toolbar-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" />
          </svg>
          <select
            class="toolbar-select"
            :value="currentModel ?? ''"
            @change="onModelChange"
          >
            <option value="" disabled>选择模型</option>
            <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
          </select>
        </label>
      </div>

      <div class="toolbar-right">
        <span class="char-count" :class="{ near: charCount > MAX_CHARS * 0.9 }">{{ charCount }} / {{ MAX_CHARS }}</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.composer {
  border: 1px solid var(--border);
  border-radius: var(--radius-2xl);
  background: var(--card);
  box-shadow: var(--shadow-sm);
  display: flex;
  flex-direction: column;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
  overflow: hidden;
}

.composer.focused {
  border-color: var(--brand);
  box-shadow: 0 0 0 3px color-mix(in oklab, var(--brand) 12%, transparent), var(--shadow-sm);
}

.composer.streaming {
  border-color: color-mix(in oklab, var(--warning) 50%, var(--border));
}

/* 流式提示条 */
.streaming-bar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 14px;
  background: color-mix(in oklab, var(--warning) 6%, var(--card));
  border-bottom: 1px solid color-mix(in oklab, var(--warning) 20%, var(--border));
  font-size: 12.5px;
  color: var(--muted-foreground);
}

.streaming-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--warning);
  animation: dot-pulse 1.4s ease-in-out infinite;
}

@keyframes dot-pulse {
  0%, 100% { opacity: 0.4; transform: scale(0.85); }
  50% { opacity: 1; transform: scale(1.15); }
}

.streaming-text {
  flex: 1;
  font-weight: 500;
}

.stop-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px 3px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, var(--destructive) 30%, var(--border));
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
  color: var(--destructive);
  font-size: 12px;
  font-weight: 500;
}

.stop-btn:hover {
  background: var(--destructive);
  color: #fff;
  border-color: var(--destructive);
}

.stop-btn svg {
  width: 11px;
  height: 11px;
}

/* 主输入区 */
.composer-main {
  display: flex;
  align-items: flex-end;
  gap: 8px;
  padding: 10px 10px 8px 12px;
}

.composer-icon-btn {
  flex-shrink: 0;
  width: 32px;
  height: 32px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid transparent;
  background: transparent;
  border-radius: var(--radius-md);
  color: var(--muted-foreground);
  cursor: not-allowed;
  opacity: 0.5;
}

.composer-icon-btn svg {
  width: 17px;
  height: 17px;
}

.composer-textarea {
  flex: 1;
  min-width: 0;
  min-height: 32px;
  max-height: 200px;
  padding: 6px 4px;
  border: none;
  background: transparent;
  border-radius: 0;
  font-family: var(--font-sans);
  font-size: 14px;
  line-height: 1.55;
  color: var(--foreground);
  resize: none;
  outline: none;
  user-select: text;
}

.composer-textarea::placeholder {
  color: var(--muted-foreground);
}

.composer-textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* 发送按钮 */
.send-btn {
  flex-shrink: 0;
  width: 34px;
  height: 34px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  background: var(--muted);
  border-radius: 999px;
  color: var(--muted-foreground);
  cursor: not-allowed;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast), transform var(--transition-fast);
}

.send-btn svg {
  width: 16px;
  height: 16px;
}

.send-btn.active {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--brand-foreground);
  cursor: pointer;
}

.send-btn.active:hover {
  background: var(--brand-hover);
  border-color: var(--brand-hover);
  transform: translateY(-1px);
}

.send-btn.active:active {
  transform: translateY(0);
}

/* 底部工具栏 */
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px 8px;
  border-top: 1px solid color-mix(in oklab, var(--border) 60%, transparent);
  gap: 12px;
}

.toolbar-left {
  display: flex;
  align-items: center;
  gap: 14px;
  min-width: 0;
}

.toolbar-field {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
  cursor: pointer;
  color: var(--muted-foreground);
}

.toolbar-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  opacity: 0.8;
}

.toolbar-select {
  appearance: none;
  -webkit-appearance: none;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  font-family: var(--font-sans);
  padding: 2px 14px 2px 0;
  cursor: pointer;
  outline: none;
  max-width: 160px;
  background-image: url("data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='10' height='10' viewBox='0 0 24 24' fill='none' stroke='%23888' stroke-width='2.5' stroke-linecap='round' stroke-linejoin='round'><polyline points='6 9 12 15 18 9'/></svg>");
  background-repeat: no-repeat;
  background-position: right center;
}

.toolbar-select:hover {
  color: var(--foreground);
}

.toolbar-select option {
  background: var(--card);
  color: var(--foreground);
}

.toolbar-right {
  flex-shrink: 0;
}

.char-count {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}

.char-count.near {
  color: var(--warning);
}
</style>
