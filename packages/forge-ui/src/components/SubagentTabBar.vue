<script setup lang="ts">
import { computed } from 'vue';
import { useI18n } from '../i18n/index.ts';
import type { Subagent } from '../types';

/**
 * 子 Agent Tab 栏（PRD 06 SA-F03）。
 *
 * 仅在 subagents.length > 0 时渲染（无子 agent 整条不出现）。
 * 结构：固定"主会话" Tab + 每个子 agent 一个 Tab（状态点 + 描述名）。
 * 右侧"清除已完成"按钮：仅当存在终态（completed/failed/stopped）时启用。
 * 排序：active（queued/running）在前，终态按 finishedAt desc。
 *
 * 设计原则：Tab 切换通过 emit('select') 由父组件控制，组件本身只负责渲染与交互；
 * "主会话"以 activeAgentId === null 表示，便于父组件直接以 Map<sessionId, agentId | null>
 * 持久化每个会话的当前激活 Tab。
 */
const props = defineProps<{
  subagents: Subagent[];
  /** 当前激活的 agentId；null = 主会话 */
  activeAgentId: string | null;
}>();

const emit = defineEmits<{
  (e: 'select', agentId: string | null): void;
  (e: 'close', agentId: string): void;
  (e: 'clear-finished'): void;
}>();

const { t } = useI18n();

/** 排序后的展示顺序：active 在前（按 startedAt asc），终态按 finishedAt desc */
const sorted = computed<Subagent[]>(() => {
  return [...props.subagents].sort((a, b) => {
    const aActive = a.status === 'queued' || a.status === 'running';
    const bActive = b.status === 'queued' || b.status === 'running';
    if (aActive !== bActive) return aActive ? -1 : 1;
    if (aActive && bActive) return (a.startedAt ?? '').localeCompare(b.startedAt ?? '');
    return (b.finishedAt ?? '').localeCompare(a.finishedAt ?? '');
  });
});

const hasFinished = computed(() =>
  props.subagents.some((s) => s.status === 'completed' || s.status === 'failed' || s.status === 'stopped'),
);

/** 状态点颜色 + 文本映射 */
function statusText(status: Subagent['status']): string {
  switch (status) {
    case 'queued':
      return t('panels.subagent.statusQueued');
    case 'running':
      return t('panels.subagent.statusRunning');
    case 'completed':
      return t('panels.subagent.statusCompleted');
    case 'failed':
      return t('panels.subagent.statusFailed');
    case 'stopped':
      return t('panels.subagent.statusStopped');
  }
}

function isActive(status: Subagent['status']): boolean {
  return status === 'queued' || status === 'running';
}

function onTabClick(agentId: string | null): void {
  if (props.activeAgentId !== agentId) emit('select', agentId);
}

function onTabKey(agentId: string | null, ev: KeyboardEvent): void {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    onTabClick(agentId);
  }
}

function onClose(agentId: string, ev: MouseEvent): void {
  ev.stopPropagation();
  emit('close', agentId);
}

function onCloseKey(agentId: string, ev: KeyboardEvent): void {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    emit('close', agentId);
  }
}

function onClearClick(): void {
  if (!hasFinished.value) return;
  emit('clear-finished');
}
</script>

<template>
  <div v-if="subagents.length > 0" class="subagent-tabbar" role="tablist" :aria-label="t('panels.subagent.tabbarAria')">
    <div class="subagent-tab-scroll">
      <!-- 主会话 Tab：固定首位 -->
      <button
        type="button"
        class="subagent-tab subagent-tab-main"
        :class="{ active: activeAgentId === null }"
        role="tab"
        :aria-selected="activeAgentId === null"
        @click="onTabClick(null)"
        @keydown="onTabKey(null, $event)"
      >
        <span class="subagent-status-dot main"></span>
        <span class="subagent-tab-label">{{ t('panels.subagent.mainSession') }}</span>
      </button>

      <button
        v-for="sa in sorted"
        :key="sa.agentId"
        type="button"
        class="subagent-tab"
        :class="[
          { active: activeAgentId === sa.agentId },
          `subagent-tab-${sa.status}`,
        ]"
        role="tab"
        :aria-selected="activeAgentId === sa.agentId"
        :title="sa.description"
        @click="onTabClick(sa.agentId)"
        @keydown="onTabKey(sa.agentId, $event)"
      >
        <span class="subagent-status-dot" :class="sa.status"></span>
        <span class="subagent-tab-label">{{ sa.description }}</span>
        <span class="subagent-tab-status">{{ statusText(sa.status) }}</span>
        <span
          v-if="!isActive(sa.status)"
          class="subagent-tab-close"
          role="button"
          tabindex="0"
          :aria-label="t('panels.subagent.closeTabAria')"
          :title="t('common.close')"
          @click="onClose(sa.agentId, $event)"
          @keydown="onCloseKey(sa.agentId, $event)"
        >×</span>
        <span
          v-else
          class="subagent-tab-close disabled"
          :aria-label="t('panels.subagent.runningTabCloseAria')"
          :title="t('panels.subagent.statusRunning')"
        >×</span>
      </button>
    </div>

    <button
      class="subagent-clear-btn"
      :disabled="!hasFinished"
      type="button"
      :data-tooltip="t('panels.subagent.clearAllTooltip')"
      @click="onClearClick"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M3 6h18" />
        <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
        <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      </svg>
      <span>{{ t('common.clearCompleted') }}</span>
    </button>
  </div>
</template>

<style scoped>
/* 列宽跟随个性化「内容宽度」偏好（--conv-col 由 .conv-view 定义：
   wide=100%，standard=min(--content-col-std,100%)）。本栏是 .conv-view 的直接子项，
   不在 .conv-messages-inner / .conv-input-wrap 内，若不限宽会在标准宽度下仍铺满，
   与已收拢的正文列、输入框左右错开。宽度取 100% + max-width（单写 max-width 会塌成
   fit-content），过渡与正文列同步。 */
.subagent-tabbar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 22px 2px;
  background: var(--background);
  flex-shrink: 0;
  box-sizing: border-box;
  width: 100%;
  max-width: var(--conv-col, 100%);
  margin-inline: auto;
  transition: max-width var(--transition-decelerate);
}

@media (prefers-reduced-motion: reduce) {
  .subagent-tabbar {
    transition: none;
  }
}

.subagent-tab-scroll {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 6px;
  overflow-x: auto;
  overflow-y: hidden;
  scrollbar-width: thin;
  padding-bottom: 0;
}

.subagent-tab-scroll::-webkit-scrollbar {
  height: 4px;
}

.subagent-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  max-width: 240px;
  flex-shrink: 0;
  white-space: nowrap;
  user-select: none;
  transition: border-color var(--transition-fast), color var(--transition-fast), background var(--transition-fast);
}

.subagent-tab:hover {
  border-color: var(--brand);
  color: var(--foreground);
}

.subagent-tab.active {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 8%, var(--background));
  color: var(--foreground);
}

.subagent-tab-main {
  /* 主会话 Tab：固定首位，无状态点（不需要）。图标简单区分 */
}

.subagent-tab-main .subagent-status-dot.main {
  background: color-mix(in oklab, var(--brand) 70%, transparent);
}

.subagent-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
  display: inline-block;
}

.subagent-status-dot.queued,
.subagent-status-dot.running {
  background: #f59e0b; /* amber */
  box-shadow: 0 0 0 0 color-mix(in oklab, #f59e0b 60%, transparent);
  animation: sa-running 1.4s ease-in-out infinite;
}

.subagent-status-dot.completed {
  background: #10b981; /* green */
}

.subagent-status-dot.failed {
  background: #ef4444; /* red */
}

.subagent-status-dot.stopped {
  background: #9ca3af; /* gray */
}

@keyframes sa-running {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, #f59e0b 60%, transparent); }
  50% { box-shadow: 0 0 0 5px color-mix(in oklab, #f59e0b 0%, transparent); }
}

.subagent-tab-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  /* 可收缩：胶囊到达 max-width 时先截断描述名，状态文字与关闭钮不溢出胶囊 */
  flex: 0 1 auto;
  min-width: 24px;
}

.subagent-tab-status {
  font-size: 11px;
  color: var(--muted-foreground);
  flex-shrink: 0;
}

.subagent-tab.active .subagent-tab-status {
  color: var(--foreground);
}

.subagent-tab-close {
  width: 16px;
  height: 16px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 999px;
  font-size: 13px;
  line-height: 1;
  color: var(--muted-foreground);
  flex-shrink: 0;
  cursor: pointer;
  user-select: none;
}

.subagent-tab-close:hover {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
  color: var(--destructive);
}

.subagent-tab-close.disabled {
  opacity: 0.25;
  cursor: not-allowed;
  pointer-events: none;
}

.subagent-clear-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
  align-self: center;
}

.subagent-clear-btn:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--foreground);
}

.subagent-clear-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.subagent-clear-btn svg {
  width: 12px;
  height: 12px;
}
</style>

<!-- 暗色 --brand 接近纯白，hover/active 边瞬间跳白显突兀；压到 40% mix 极轻提亮，不形成可辨环。
     ponytail: 调光旋钮 mix %，想再亮改 50%、再压改 30%；light 不动。 -->
<style>
:root[data-theme='dark'] .subagent-tab:hover {
  border-color: color-mix(in oklab, var(--brand) 55%, transparent);
}
:root[data-theme='dark'] .subagent-tab.active {
  border-color: color-mix(in oklab, var(--brand) 55%, transparent);
}
:root[data-theme='dark'] .subagent-clear-btn:hover:not(:disabled) {
  border-color: color-mix(in oklab, var(--brand) 55%, transparent);
}
</style>
