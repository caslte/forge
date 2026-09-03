<script setup lang="ts">
import { onMounted, onUnmounted, computed } from 'vue';

const props = defineProps<{
  message: string;
  type: 'success' | 'info' | 'error';
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

let timer: ReturnType<typeof setTimeout> | null = null;

onMounted(() => {
  timer = setTimeout(() => {
    emit('close');
  }, 3000);
});

onUnmounted(() => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
});

// 长消息含全角冒号时拆为 label+value 富文本，模型名等关键值一眼可辨
const parsed = computed(() => {
  const m = props.message;
  const idx = m.indexOf('：');
  if (idx > -1 && m.length > 20) {
    return { label: m.slice(0, idx), value: m.slice(idx + 1) };
  }
  return { label: null as string | null, value: m };
});
</script>

<template>
  <div class="toast" :class="type" role="status" aria-live="polite">
    <!-- 顶部品牌渐变细线：中性深灰+暖琥珀，与整体一致 -->
    <span class="toast-accent" aria-hidden="true"></span>

    <div class="toast-body">
      <span v-if="parsed.label" class="toast-label">{{ parsed.label }}</span>
      <span class="toast-message" :class="{ 'is-split': !!parsed.label }">
        <template v-if="parsed.label">
          <span class="toast-sep">：</span><span class="toast-value">{{ parsed.value }}</span>
        </template>
        <template v-else>{{ parsed.value }}</template>
      </span>
    </div>

    <button class="ghost toast-close" aria-label="关闭" @click="emit('close')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
/* 容器：无图标极简版，靠排版与品牌细线体现高级感 */
.toast {
  position: fixed;
  left: 50%;
  right: auto;
  top: 88px;
  bottom: auto;
  transform: translateX(-50%);
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
  max-width: 380px;
  width: max-content;
  padding: 11px 14px 11px 16px;
  background: color-mix(in oklab, var(--card) 92%, transparent);
  backdrop-filter: blur(18px) saturate(1.35);
  -webkit-backdrop-filter: blur(18px) saturate(1.35);
  border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
  border-radius: var(--radius-xl);
  box-shadow:
    0 14px 36px oklch(0 0 0 / 10%),
    0 3px 10px oklch(0 0 0 / 6%),
    inset 0 1px 0 color-mix(in oklab, white 55%, transparent);
  font-size: 13px;
  color: var(--foreground);
  overflow: hidden;
  animation: toastIn 420ms cubic-bezier(0.16, 1, 0.3, 1);
}

:root[data-theme='dark'] .toast {
  background: color-mix(in oklab, var(--card) 92%, transparent);
  border-color: color-mix(in oklab, var(--border) 92%, transparent);
  box-shadow:
    0 20px 48px oklch(0 0 0 / 32%),
    0 6px 16px oklch(0 0 0 / 22%),
    inset 0 1px 0 color-mix(in oklab, white 7%, transparent);
}

/* 顶部品牌渐变细线：全类型统一中性品牌+暖琥珀，去掉绿色 success */
.toast-accent {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg,
    transparent 0%,
    color-mix(in oklab, var(--brand) 14%, transparent) 22%,
    color-mix(in oklab, var(--brand) 18%, var(--logo-gradient-accent) 14%) 50%,
    color-mix(in oklab, var(--brand) 14%, transparent) 78%,
    transparent 100%);
  opacity: 0.85;
}
.toast.error .toast-accent {
  background: linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--destructive) 22%, transparent) 24%, color-mix(in oklab, var(--destructive) 14%, var(--brand) 86%) 50%, transparent 100%);
}

/* 文案：label 11/ muted + value 单行 inline，模型名突出，不换行 */
.toast-body {
  min-width: 0;
  display: flex;
  align-items: baseline;
  flex-direction: row;
  gap: 4px;
  line-height: 1.4;
  white-space: nowrap;
}
.toast-label {
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground);
}
.toast-message {
  min-width: 0;
  font-size: 13.4px;
  font-weight: 500;
  color: var(--foreground);
  white-space: nowrap;
}
.toast-message.is-split {
  display: flex;
  align-items: baseline;
  gap: 0;
  flex-wrap: nowrap;
  overflow: hidden;
}
.toast-sep {
  color: var(--muted-foreground);
  margin-right: 1px;
}
.toast-value {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* 关闭：28 圆，悬浮 muted，高级克制 */
.toast-close {
  flex-shrink: 0;
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted-foreground);
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}
.toast-close:hover {
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  color: var(--foreground);
  border-color: color-mix(in oklab, var(--border) 80%, transparent);
}
.toast-close svg {
  width: 14px;
  height: 14px;
}

@keyframes toastIn {
  from {
    opacity: 0;
    transform: translateX(calc(-50% + 6px)) translateY(14px) scale(0.96);
    filter: blur(6px);
  }
  to {
    opacity: 1;
    transform: translateX(-50%) translateY(0) scale(1);
    filter: blur(0);
  }
}

/* 悬浮微抬升，增强“可感知但不打扰” */
.toast:hover {
  transform: translateX(-50%) translateY(-1px);
  box-shadow:
    0 20px 44px oklch(0 0 0 / 12%),
    0 6px 16px oklch(0 0 0 / 9%),
    inset 0 1px 0 color-mix(in oklab, white 60%, transparent);
  transition: transform var(--transition-base), box-shadow var(--transition-base);
}
:root[data-theme='dark'] .toast:hover {
  box-shadow:
    0 24px 56px oklch(0 0 0 / 36%),
    0 8px 20px oklch(0 0 0 / 26%),
    inset 0 1px 0 color-mix(in oklab, white 8%, transparent);
}
</style>
