<script setup lang="ts">
import { onMounted, onUnmounted } from 'vue';

defineProps<{
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
</script>

<template>
  <div class="toast" :class="type" role="status">
    <span class="toast-icon" aria-hidden="true">
      <!-- success: 勾 -->
      <svg v-if="type === 'success'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 6L9 17l-5-5" />
      </svg>
      <!-- error: 叉 -->
      <svg v-else-if="type === 'error'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
      <!-- info: i -->
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    </span>
    <span class="toast-message">{{ message }}</span>
    <button class="ghost toast-close" aria-label="关闭" @click="emit('close')">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M6 6l12 12M18 6L6 18" />
      </svg>
    </button>
  </div>
</template>

<style scoped>
.toast {
  position: fixed;
  right: 24px;
  bottom: 24px;
  z-index: 9999;
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 240px;
  max-width: 380px;
  padding: 10px 12px;
  background: var(--card);
  border: 1px solid var(--border);
  border-left-width: 3px;
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  font-size: 13px;
  color: var(--foreground);
  animation: fadeIn var(--transition-base);
}

.toast.success {
  border-left-color: var(--success);
}

.toast.info {
  border-left-color: var(--info);
}

.toast.error {
  border-left-color: var(--destructive);
}

.toast-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.toast-icon svg {
  width: 16px;
  height: 16px;
}

.toast.success .toast-icon {
  color: var(--success);
}

.toast.info .toast-icon {
  color: var(--info);
}

.toast.error .toast-icon {
  color: var(--destructive);
}

.toast-message {
  flex: 1;
  word-break: break-word;
}

.toast-close {
  width: 22px;
  height: 22px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
}

.toast-close svg {
  width: 14px;
  height: 14px;
}
</style>
