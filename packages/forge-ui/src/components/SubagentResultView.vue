<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { call } from '../bridge';
import { parseSubagentStream, stripDanglingFence, groupStreamNodes } from '../utils/subagentStream';
import { renderMarkdown } from '@forge/core/markdown';
import type { Subagent } from '../types';

/**
 * 子 Agent 结果视图（PRD 06 SA-F04，v1.2 改版）。
 *
 * 头部：图标 + 描述名 + 类型徽标 + 状态点 + 状态文字 + 实时耗时（运行中每秒刷新，终态停止）。
 * 正文（与主会话一致的流式阅读体验，运行中与终态共用同一条消息流）：
 * - 解析输出文件 JSONL → assistant 文本按主会话同源 markdown 渲染，
 *   工具调用显示摘要行（名称+参数预览+状态）；thinking/user 条目不展示
 * - 运行中底部“正在思考…/正在输出…”指示（无边框），完成后指示消失、附 Token 用量
 * - failed/stopped 附错误信息；无过程数据时 completed 用 result 全文兑底（markdown）
 *
 * 头部“终止”按钮：仅当子 agent 活跃（queued/running）时显示，点击抛出 stop 事件由父组件二次确认。
 */
const props = defineProps<{
  subagent: Subagent;
  /** 所属会话 ID（读取执行过程输出文件需要） */
  sessionId: string;
}>();

const emit = defineEmits<{
  (e: 'stop', agentId: string): void;
}>();

const now = ref<number>(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

const isActive = computed(() =>
  props.subagent.status === 'queued' || props.subagent.status === 'running',
);

// ===== 实时过程（wu-06 v1.2：输出文件 JSONL → 消息流渲染，运行中/终态共用）=====

const outputChunk = ref('');
const streamTextEl = ref<HTMLElement | null>(null);
let loadingOutput = false;

/** 输出文件尾部 → 渲染时间线（正文条目 + 工具摘要行，连续工具聚为折叠组） */
const streamItems = computed(() => parseSubagentStream(outputChunk.value));
const streamNodes = computed(() => groupStreamNodes(streamItems.value));

/** 展开的工具组（按组内首个工具下标，默认全部收起，与主会话一致） */
const expandedGroups = ref(new Set<number>());

function toggleGroup(start: number): void {
  const next = new Set(expandedGroups.value);
  if (next.has(start)) next.delete(start);
  else next.add(start);
  expandedGroups.value = next;
}

/** 拉取过程尾部（运行中每秒 tick；挂载时终态也拉一次供回看） */
async function refreshOutput(): Promise<void> {
  if (loadingOutput) return;
  loadingOutput = true;
  try {
    const res = await call<{ exists: boolean; size: number; chunk: string }>('subagent/queryOutput', {
      sessionId: props.sessionId,
      agentId: props.subagent.agentId,
    });
    if (res.chunk !== outputChunk.value) {
      outputChunk.value = res.chunk;
      // 自动滚动到底（运行中跟随最新输出）
      void nextTick(() => {
        const el = streamTextEl.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  } catch {
    // 静默：过程读取失败不影响主视图（下一 tick 重试）
  } finally {
    loadingOutput = false;
  }
}

const elapsedMs = computed(() => {
  const start = Date.parse(props.subagent.startedAt);
  if (Number.isNaN(start)) return 0;
  const end = props.subagent.finishedAt ? Date.parse(props.subagent.finishedAt) : now.value;
  return Math.max(0, end - start);
});

const elapsedText = computed(() => {
  const ms = elapsedMs.value;
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} 秒`;
  const m = Math.floor(s / 60);
  const ss = s % 60;
  if (m < 60) return `${m} 分 ${ss} 秒`;
  const h = Math.floor(m / 60);
  const mm = m % 60;
  return `${h} 小时 ${mm} 分`;
});

function statusText(status: Subagent['status']): string {
  switch (status) {
    case 'queued':
      return '排队中';
    case 'running':
      return '运行中';
    case 'completed':
      return '已完成';
    case 'failed':
      return '失败';
    case 'stopped':
      return '已终止';
  }
}

function onStop(): void {
  if (!isActive.value) return;
  emit('stop', props.subagent.agentId);
}

/** 终态切换补拉一次：完成后/终止后 tail 才含完整内容（含 result 末条），运行中的 tick 已停 */
watch(isActive, (active, prev) => {
  if (prev && !active) void refreshOutput();
});

onMounted(() => {
  // 挂载即拉一次（终态重新打开 Tab 也能回看消息流）；运行中每秒刷新耗时 + 过程
  void refreshOutput();
  tickTimer = setInterval(() => {
    if (isActive.value) {
      now.value = Date.now();
      void refreshOutput();
    }
  }, 1000);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
});
</script>

<template>
  <div class="subagent-result-view">
    <header class="srv-header">
      <span class="srv-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3" y="6" width="18" height="13" rx="2" />
          <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          <circle cx="9" cy="13" r="1.5" />
          <circle cx="15" cy="13" r="1.5" />
        </svg>
      </span>
      <span class="srv-name" :title="subagent.description">{{ subagent.description }}</span>
      <span class="srv-type-badge">{{ subagent.agentType }}</span>
      <span class="subagent-status-dot" :class="subagent.status"></span>
      <span class="srv-status-text">{{ statusText(subagent.status) }}</span>
      <span class="srv-elapsed">· {{ elapsedText }}</span>

      <span class="srv-spacer"></span>

      <button
        v-if="isActive"
        type="button"
        class="srv-stop-btn"
        data-tooltip="终止此子 Agent（不可逆，需二次确认）"
        @click="onStop"
      >终止</button>
    </header>

    <div ref="streamTextEl" class="srv-body">
      <!-- 消息流：运行中与终态共用同一条流（完成后不切换视图，只停指示 + 附用量）；连续工具聚为折叠组 -->
      <template v-if="streamNodes.length > 0">
        <template v-for="(node, ni) in streamNodes" :key="ni">
          <div
            v-if="node.kind === 'text'"
            class="srv-stream-text"
            v-html="renderMarkdown(node.text)"
          ></div>
          <div v-else-if="node.kind === 'tool-group'" class="srv-tool-group">
            <button class="stg-head" @click="toggleGroup(node.start)">
              <svg class="stg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /><path d="M5 21l1.5-4.5" /></svg>
              <span class="stg-label">工具调用</span>
              <span class="stg-count">{{ node.total }} 次</span>
              <span class="stg-names">
                <span v-for="tc in node.counts" :key="tc.name" class="stg-chip">
                  {{ tc.name }}<span v-if="tc.count > 1" class="stg-chip-count">×{{ tc.count }}</span>
                </span>
              </span>
              <span class="stg-collapse">{{ expandedGroups.has(node.start) ? '▾' : '▸' }}</span>
            </button>
            <div class="stg-shell" :class="{ 'is-collapsed': !expandedGroups.has(node.start) }">
              <div class="stg-body">
                <div
                  v-for="(t, ti) in node.items"
                  :key="ti"
                  class="srv-stream-tool"
                  :class="t.status"
                >
                  <span class="srv-tool-status" aria-hidden="true">
                    <span v-if="t.status === 'running'" class="srv-tool-spinner"></span>
                    <template v-else>{{ t.status === 'ok' ? '✓' : '✗' }}</template>
                  </span>
                  <span class="srv-tool-name">{{ t.name }}</span>
                  <span v-if="t.args" class="srv-tool-args">{{ t.args }}</span>
                </div>
              </div>
            </div>
          </div>
          <div v-else class="srv-stream-tool" :class="node.item.status">
            <span class="srv-tool-status" aria-hidden="true">
              <span v-if="node.item.status === 'running'" class="srv-tool-spinner"></span>
              <template v-else>{{ node.item.status === 'ok' ? '✓' : '✗' }}</template>
            </span>
            <span class="srv-tool-name">{{ node.item.name }}</span>
            <span v-if="node.item.args" class="srv-tool-args">{{ node.item.args }}</span>
          </div>
        </template>
      </template>

      <!-- 无过程数据兑底：completed 用 result 全文（同源 markdown 渲染，与过程视图一致） -->
      <template v-else>
        <div v-if="subagent.result" class="srv-stream-text" v-html="renderMarkdown(stripDanglingFence(subagent.result))"></div>
        <div v-else-if="subagent.status === 'completed'" class="subagent-result-empty">无结果输出</div>
      </template>

      <!-- 运行中指示（无边框，随内容滚动，与主会话一致） -->
      <div v-if="isActive" class="srv-indicator">
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span>{{ streamItems.length > 0 ? '正在输出…' : '正在思考…' }}</span>
      </div>
      <!-- 失败 / 终止错误信息 -->
      <div v-if="subagent.status === 'failed' || subagent.status === 'stopped'" class="subagent-result-error">
        <div class="srv-error-title">{{ subagent.status === 'failed' ? '执行失败' : '已终止' }}</div>
        <div class="srv-error-msg">{{ subagent.error ?? '无错误信息' }}</div>
      </div>

      <!-- 终态：token 用量 -->
      <div v-if="!isActive && subagent.usage" class="subagent-result-usage">
        <span>输入 {{ subagent.usage.inputTokens.toLocaleString() }} tokens</span>
        <span class="srv-usage-sep">·</span>
        <span>输出 {{ subagent.usage.outputTokens.toLocaleString() }} tokens</span>
      </div>
    </div>
  </div>
</template>

<style scoped>
.subagent-result-view {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  background: var(--background);
  padding: 0;
}

.srv-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 22px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 8%, var(--background));
  flex-shrink: 0;
  font-size: 13px;
}

.srv-icon {
  width: 18px;
  height: 18px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: var(--brand);
}

.srv-icon svg {
  width: 100%;
  height: 100%;
}

.srv-name {
  font-weight: 600;
  color: var(--foreground);
  max-width: 280px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.srv-type-badge {
  font-size: 11px;
  padding: 2px 8px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--muted-foreground);
  flex-shrink: 0;
}

.subagent-status-dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  flex-shrink: 0;
  display: inline-block;
}

.subagent-status-dot.running,
.subagent-status-dot.queued {
  background: #f59e0b;
  animation: sa-running 1.4s ease-in-out infinite;
}

.subagent-status-dot.completed { background: #10b981; }
.subagent-status-dot.failed { background: #ef4444; }
.subagent-status-dot.stopped { background: #9ca3af; }

@keyframes sa-running {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, #f59e0b 60%, transparent); }
  50% { box-shadow: 0 0 0 5px color-mix(in oklab, #f59e0b 0%, transparent); }
}

.srv-status-text {
  color: var(--foreground);
  font-weight: 500;
  /* 窄容器（多窗口分块）下 flex 会把无 nowrap 的中文压到逐字竖排（变形）；禁止换行收缩，压缩量全部由左侧描述名（ellipsis）吸收 */
  white-space: nowrap;
  flex-shrink: 0;
}

.srv-elapsed {
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  flex-shrink: 0;
}

.srv-spacer {
  flex: 1;
}

.srv-stop-btn {
  padding: 4px 12px;
  border: 1px solid color-mix(in oklab, var(--destructive) 30%, var(--border));
  background: color-mix(in oklab, var(--destructive) 8%, var(--background));
  color: var(--destructive);
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  flex-shrink: 0;
}

.srv-stop-btn:hover {
  background: color-mix(in oklab, var(--destructive) 14%, var(--background));
}

.srv-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 22px 38px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

/* 运行中指示（无边框，与主会话同风格） */
.srv-indicator {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted-foreground);
  font-size: 13px;
  padding: 2px 0;
}

.thinking-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--muted-foreground);
  opacity: 0.4;
  animation: dot-bounce 1.4s ease-in-out infinite;
}

.thinking-dot:nth-child(2) { animation-delay: 0.16s; }
.thinking-dot:nth-child(3) { animation-delay: 0.32s; }

@keyframes dot-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.1); }
}

.subagent-result-empty {
  color: var(--muted-foreground);
  font-size: 13px;
  padding: 12px 14px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  text-align: center;
}

.subagent-result-error {
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, var(--border));
  border-radius: var(--radius-lg);
  padding: 14px 18px;
  color: var(--foreground);
}

.srv-error-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--destructive);
  margin-bottom: 6px;
}

.srv-error-msg {
  font-size: 12.5px;
  color: var(--muted-foreground);
  white-space: pre-wrap;
  word-break: break-word;
}

.subagent-result-usage {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted-foreground);
  align-self: flex-start;
  padding: 4px 10px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
}

.srv-usage-sep {
  color: var(--border);
}

/* ===== 实时消息流（输出文件 JSONL → 正文 + 工具摘要行，无边框直接排版）===== */
/* 正文条目：与主会话 assistant 消息同源的 markdown 渲染 */
.srv-stream-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--foreground);
  word-break: break-word;
}

.srv-stream-text :deep(p) { margin: 0 0 8px; }
.srv-stream-text :deep(p:last-child) { margin-bottom: 0; }
.srv-stream-text :deep(pre) {
  background: color-mix(in oklab, var(--muted) 12%, var(--card));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
}
.srv-stream-text :deep(code) { font-family: var(--font-mono); font-size: 12px; }
.srv-stream-text :deep(ul),
.srv-stream-text :deep(ol) { margin: 4px 0; padding-left: 20px; }

/* 工具摘要行：单行紧凑展示（状态 + 名称 + 参数预览） */
.srv-stream-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted-foreground);
  padding: 5px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--muted) 6%, var(--card));
  min-width: 0;
}

.srv-stream-tool.ok .srv-tool-status { color: #10b981; }
.srv-stream-tool.error .srv-tool-status { color: var(--destructive); }

.srv-tool-status {
  width: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.srv-tool-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid color-mix(in oklab, var(--muted-foreground) 30%, transparent);
  border-top-color: var(--brand);
  border-radius: 999px;
  animation: srv-spin 0.9s linear infinite;
}

@keyframes srv-spin {
  to { transform: rotate(360deg); }
}

.srv-tool-name {
  font-weight: 600;
  color: var(--foreground);
  flex-shrink: 0;
}

.srv-tool-args {
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

/* 工具组折叠（与主会话 tool-group 同交互：默认收起，头部计数 + 工具名 chips） */
.srv-tool-group {
  border: none;
  border-radius: 12px;
  background: color-mix(in oklab, var(--muted) 58%, transparent);
  overflow: hidden;
}

.stg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  font-size: 12px;
  color: var(--muted-foreground);
  border: none;
  background: transparent;
  cursor: pointer;
  user-select: none;
  text-align: left;
}

.stg-head:hover { background: var(--muted); }
.stg-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--muted-foreground); }
.stg-label { font-weight: 600; color: var(--foreground); white-space: nowrap; }
.stg-count { font-weight: 500; color: var(--muted-foreground); white-space: nowrap; }
.stg-names { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; overflow: hidden; flex-wrap: nowrap; }
.stg-chip { display: inline-flex; align-items: center; gap: 1px; font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); background: color-mix(in oklab, var(--muted) 55%, transparent); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
.stg-chip-count { font-weight: 600; color: var(--foreground); }
.stg-collapse { flex-shrink: 0; color: var(--muted-foreground); font-size: 12px; }
.stg-shell { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 200ms cubic-bezier(0.4, 0, 0.2, 1); overflow: hidden; }
.stg-shell.is-collapsed { grid-template-rows: 0fr; }
.stg-body { min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 10px; transition: padding 200ms cubic-bezier(0.4, 0, 0.2, 1), gap 200ms cubic-bezier(0.4, 0, 0.2, 1); }
.stg-shell.is-collapsed .stg-body { padding-top: 0; padding-bottom: 0; gap: 0; }
</style>