<script setup lang="ts">
import { computed } from 'vue';
import type { ToolEvent } from '../types';

const props = defineProps<{
  event: ToolEvent;
}>();

const isRunning = computed(() => props.event.status === 'started');
const isError = computed(() => props.event.status === 'error');
const isDone = computed(() => props.event.status === 'completed');

const statusLabel = computed(() => {
  if (isRunning.value) return '运行中';
  if (isError.value) return '失败';
  if (isDone.value) return '已完成';
  return props.event.status;
});

const toolLabel = computed(() => props.event.toolName ?? '工具');
</script>

<template>
  <div :class="['tool-card', `tool-${event.status}`]">
    <div class="tool-head">
      <div class="tool-icon">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
        </svg>
      </div>
      <span class="tool-name">{{ toolLabel }}</span>
      <span :class="['tool-status', `status-${event.status}`]">
        <span v-if="isRunning" class="spinner"></span>
        {{ statusLabel }}
      </span>
    </div>
    <div v-if="event.summary" class="tool-summary">{{ event.summary }}</div>
  </div>
</template>

<style scoped>
.tool-card {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  padding: 10px 12px;
  margin: 6px 0;
  max-width: 85%;
  font-size: 12.5px;
  animation: fadeIn 0.2s ease-out;
}

.tool-card.tool-started {
  border-color: color-mix(in oklab, var(--warning) 40%, var(--border));
  background: color-mix(in oklab, var(--warning) 5%, var(--card));
}

.tool-card.tool-error {
  border-color: color-mix(in oklab, var(--destructive) 40%, var(--border));
  background: color-mix(in oklab, var(--destructive) 5%, var(--card));
}

.tool-card.tool-completed {
  border-color: color-mix(in oklab, var(--success) 30%, var(--border));
}

.tool-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.tool-icon {
  width: 18px;
  height: 18px;
  color: var(--muted-foreground);
  flex-shrink: 0;
}

.tool-icon svg {
  width: 100%;
  height: 100%;
}

.tool-name {
  font-weight: 600;
  font-family: var(--font-mono);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.tool-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 999px;
  font-weight: 500;
}

.tool-status.status-started {
  background: color-mix(in oklab, var(--warning) 15%, transparent);
  color: var(--warning);
}

.tool-status.status-error {
  background: color-mix(in oklab, var(--destructive) 15%, transparent);
  color: var(--destructive);
}

.tool-status.status-completed {
  background: color-mix(in oklab, var(--success) 15%, transparent);
  color: var(--success);
}

.spinner {
  width: 10px;
  height: 10px;
  border: 1.5px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
}

.tool-summary {
  margin-top: 6px;
  padding: 6px 8px;
  background: color-mix(in oklab, var(--foreground) 4%, transparent);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: var(--muted-foreground);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}
</style>
