<script setup lang="ts">
import { computed, ref } from 'vue';
import type { ToolEvent } from '../types';
import { parseFileToolInput } from '../composables/useChangedFiles';
import DiffView from './DiffView.vue';

const props = defineProps<{
  event: ToolEvent;
  hideDiff?: boolean;
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

const toolSummaryLabel = computed(() => {
  const input = props.event.input;
  if (!input || typeof input !== 'object') return props.event.summary ?? '';
  const candidates = ['file_path', 'path', 'command', 'url', 'query', 'pattern'];
  for (const key of candidates) {
    const value = input[key];
    if (typeof value === 'string' && value.trim() !== '') {
      return value.replace(/\s+/g, ' ').trim();
    }
  }
  return props.event.summary ?? '';
});

/** 修改文件类工具的 diff 列表（pi edit 多 hunk 逐块一项；形状判定共享 parseFileToolInput，
 *  同时兼容 pi 真实 {path,edits}/{path,content} 与旧形状 {file_path,old_string,new_string}） */
const diffs = computed(() => {
  const parsed = parseFileToolInput(props.event.input);
  if (!parsed) return [];
  return parsed.parts.map((part, i) => ({
    filePath: parsed.path,
    oldString: part.oldText,
    newString: part.newText,
    showPath: i === 0,
  }));
});
</script>

<template>
  <div :class="['tool-calls', `tool-${event.status}`, { open, 'has-diff': !hideDiff && diffs.length > 0 }]">
    <button class="tool-calls-head" @click="open = !open">
      <svg class="tc-toggle" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="9 6 15 12 9 18" />
      </svg>
      <span class="tc-title">
        {{ toolLabel }}
        <span v-if="toolSummaryLabel" class="tc-summary">{{ toolSummaryLabel }}</span>
      </span>
      <span class="tc-count">
        <span v-if="isRunning" class="mini-badge live">{{ statusLabel }}</span>
        <span v-else-if="isError" class="mini-badge danger">{{ statusLabel }}</span>
        <span v-else class="mini-badge success">{{ statusLabel }}</span>
      </span>
    </button>
    <div v-if="(!hideDiff && diffs.length > 0) || event.summary" class="tool-item-body">
      <template v-if="!hideDiff">
        <DiffView
          v-for="(diff, i) in diffs"
          :key="i"
          class="tc-diff"
          :file-path="diff.showPath ? diff.filePath : null"
          :highlight-path="diff.filePath"
          :old-string="diff.oldString"
          :new-string="diff.newString"
        />
      </template>
      <pre v-if="event.summary" class="tool-summary">{{ event.summary }}</pre>
    </div>
  </div>
</template>

<style scoped>
.tool-calls {
  border: none;
  border-radius: 12px;
  background: color-mix(in oklab, var(--muted) 58%, transparent);
  overflow: hidden; /* overflow 非 visible 使 flex 子项 min-width:auto 归 0，窄窗格可收缩、标题省略号生效 */
  align-self: flex-start;
  max-width: 94%;
  min-width: 0;
}

/* 含 diff 时顶满整行（diff 并排双栏需要宽度；纯文本卡片保持收窄） */
.tool-calls.has-diff {
  width: 100%;
  max-width: 100%;
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
  display: flex;
  align-items: center;
  gap: 8px;
  overflow: hidden;
  white-space: nowrap;
  text-align: left;
}

.tc-summary {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  color: var(--muted-foreground);
  font-weight: 400;
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

/* 多 hunk 时多个 DiffView 的纵向间距 */
.tc-diff + .tc-diff {
  margin-top: 8px;
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
