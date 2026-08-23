<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolEvent } from '../types';

const props = defineProps<{
  event: ToolEvent;
}>();

const open = ref(false);

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
  <div :class="['tool-calls', `tool-${event.status}`, { open }]">
    <button class="tool-calls-head" @click="open = !open">
      <svg class="tc-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 6 15 12 9 18" />
      </svg>
      <span class="tc-title">{{ toolLabel }}</span>
      <span class="tc-count">
        <span v-if="isRunning" class="mini-badge live">{{ statusLabel }}</span>
        <span v-else-if="isError" class="mini-badge danger">{{ statusLabel }}</span>
        <span v-else class="mini-badge success">{{ statusLabel }}</span>
      </span>
    </button>
    <div v-if="event.summary" class="tool-item-body">
      <pre class="tool-summary">{{ event.summary }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool-calls {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card);
  overflow: hidden;
  align-self: flex-start;
  max-width: 94%;
  min-width: 260px;
}

.tool-calls.tool-started {
  border-color: color-mix(in oklab, var(--warning) 40%, var(--border));
}

.tool-calls.tool-error {
  border-color: color-mix(in oklab, var(--destructive) 40%, var(--border));
}

.tool-calls.tool-completed {
  border-color: color-mix(in oklab, var(--success) 30%, var(--border));
}

.tool-calls-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--muted-foreground);
  border: none;
  background: transparent;
  cursor: pointer;
  user-select: none;
}

.tool-calls-head:hover {
  background: var(--muted);
}

.tc-toggle {
  transition: transform 150ms ease;
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

.tool-calls.open .tc-toggle {
  transform: rotate(90deg);
}

.tc-title {
  font-weight: 500;
  color: var(--foreground);
  font-family: var(--font-mono);
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
}

.tc-count {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
}

.mini-badge {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 11px;
  white-space: nowrap;
  border: 1px solid var(--border);
  background: var(--muted);
  color: var(--muted-foreground);
}

.mini-badge.success {
  color: var(--success);
  border-color: color-mix(in oklab, var(--success) 30%, var(--border));
  background: color-mix(in oklab, var(--success) 8%, transparent);
}

.mini-badge.danger {
  color: var(--destructive);
  border-color: color-mix(in oklab, var(--destructive) 30%, var(--border));
  background: color-mix(in oklab, var(--destructive) 8%, transparent);
}

.mini-badge.live {
  color: var(--warning);
  border-color: color-mix(in oklab, var(--warning) 30%, var(--border));
  background: color-mix(in oklab, var(--warning) 8%, transparent);
}

.tool-item-body {
  display: none;
  padding: 0 12px 12px 32px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.tool-calls.open .tool-item-body {
  display: block;
}

.tool-summary {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.6;
  max-height: 180px;
  overflow-y: auto;
}
</style>
