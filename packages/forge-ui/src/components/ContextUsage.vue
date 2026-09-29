<script setup lang="ts">
import { useI18n } from '../i18n/index.ts';

defineProps<{
  sessionId: string;
}>();

const { t } = useI18n();
</script>

<template>
  <!-- 占位：forge-core 尚未提供上下文用量事件 -->
  <div class="ctx" :data-session-id="sessionId" :data-tooltip="t('chat.contextTooltip')">
    <span class="ctx-icon" aria-hidden="true">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M12 11v5M12 8h.01" />
      </svg>
    </span>
    <div class="ctx-body">
      <div class="ctx-label">{{ t('chat.contextLabelUnimplemented') }}</div>
      <div class="ctx-bar">
        <div class="ctx-fill"></div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ctx {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--muted-foreground);
}

.ctx-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.ctx-icon svg {
  width: 14px;
  height: 14px;
}

.ctx-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.ctx-label {
  font-size: 12px;
  color: var(--muted-foreground);
}

.ctx-bar {
  height: 4px;
  background: var(--background);
  border-radius: 999px;
  overflow: hidden;
}

.ctx-fill {
  width: 0%;
  height: 100%;
  background: var(--muted-foreground);
  border-radius: 999px;
}
</style>
