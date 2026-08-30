<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { call } from '../bridge';
import type { Subagent } from '../types';

/**
 * 子 Agent 结果视图（PRD 06 SA-F04）。
 *
 * 头部：图标 + 描述名 + 类型徽标 + 状态点 + 状态文字 + 实时耗时（运行中每秒刷新，终态停止）。
 * 正文：
 * - running/queued → 占位提示（状态区分文案）+ 实时执行过程（只读 tail，每秒刷新、自动滚动）
 * - completed → result 全文 + Token 用量
 * - failed/stopped → error 信息 + Token 用量（如有）
 * - 空 result → "无结果输出"
 * 终态附"执行过程"折叠面板回看（读取扩展任务输出文件尾部；无文件显示"无过程记录"）。
 *
 * 头部"终止"按钮：仅当子 agent 活跃（queued/running）时显示，点击抛出 stop 事件由父组件二次确认。
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

// ===== 执行过程（wu-06 v1.1：扩展任务输出文件只读 tail）=====

const outputChunk = ref('');
const outputExists = ref<boolean | null>(null); // null = 未加载
const outputSize = ref(0);
/** 终态"执行过程"折叠面板展开状态（运行中恒展开） */
const showProcess = ref(false);
const processTextEl = ref<HTMLElement | null>(null);
let loadingOutput = false;

const outputSizeText = computed(() => {
  if (outputSize.value >= 1024) return `${(outputSize.value / 1024).toFixed(1)} KB`;
  return `${outputSize.value} B`;
});

/** 拉取过程尾部（每秒 tick / 终态展开时调用） */
async function refreshOutput(): Promise<void> {
  if (loadingOutput) return;
  loadingOutput = true;
  try {
    const res = await call<{ exists: boolean; size: number; chunk: string }>('subagent/queryOutput', {
      sessionId: props.sessionId,
      agentId: props.subagent.agentId,
    });
    outputExists.value = res.exists;
    outputSize.value = res.size;
    if (res.chunk !== outputChunk.value) {
      outputChunk.value = res.chunk;
      // 自动滚动到底（运行中跟随最新输出）
      void nextTick(() => {
        const el = processTextEl.value;
        if (el) el.scrollTop = el.scrollHeight;
      });
    }
  } catch {
    // 静默：过程读取失败不影响主视图（下一 tick 重试）
  } finally {
    loadingOutput = false;
  }
}

/** 终态展开折叠面板时加载一次（终态文件不再变化） */
watch(showProcess, (open) => {
  if (open && !isActive.value && outputExists.value === null) void refreshOutput();
});

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

onMounted(() => {
  // 运行中每秒刷新耗时 + 过程；终态停止（elapsedText 取 finishedAt 静态值）
  tickTimer = setInterval(() => {
    if (isActive.value) {
      now.value = Date.now();
      void refreshOutput();
    }
  }, 1000);
  // 运行中挂载即拉一次过程（不等首个 tick）
  if (isActive.value) void refreshOutput();
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

    <div class="srv-body">
      <!-- 运行中/排队占位（状态区分文案） -->
      <div v-if="isActive" class="subagent-result-placeholder">
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span class="thinking-dot"></span>
        <span>{{ subagent.status === 'queued'
          ? '子 Agent 排队中，开始运行后此处将显示进展'
          : '子 Agent 正在运行，最终结果将在完成时显示' }}</span>
      </div>

      <!-- 运行中：实时执行过程（只读 tail，每秒刷新、自动滚动） -->
      <div v-if="isActive" class="srv-process">
        <div class="srv-process-head">
          <span>实时过程</span>
          <span v-if="outputExists" class="srv-process-size">{{ outputSizeText }}</span>
        </div>
        <pre v-if="outputExists !== false" ref="processTextEl" class="srv-process-text">{{ outputChunk !== '' ? outputChunk : '加载中…' }}</pre>
        <div v-else class="srv-process-empty">暂无过程输出</div>
      </div>

      <!-- 失败 / 终止 -->
      <template v-else-if="subagent.status === 'failed' || subagent.status === 'stopped'">
        <div class="subagent-result-error">
          <div class="srv-error-title">{{ subagent.status === 'failed' ? '执行失败' : '已终止' }}</div>
          <div class="srv-error-msg">{{ subagent.error ?? '无错误信息' }}</div>
        </div>
      </template>

      <!-- completed：result 全文（空 → 无结果输出） -->
      <template v-else-if="subagent.status === 'completed'">
        <div v-if="subagent.result === null || subagent.result === ''" class="subagent-result-empty">
          无结果输出
        </div>
        <div v-else class="subagent-result-body">
          <pre class="subagent-result-text">{{ subagent.result }}</pre>
        </div>
      </template>

      <!-- 终态：回看执行过程（折叠面板，读取输出文件尾部） -->
      <div v-if="!isActive" class="srv-process-panel">
        <button
          type="button"
          class="srv-process-toggle"
          :aria-expanded="showProcess"
          @click="showProcess = !showProcess"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" :class="{ expanded: showProcess }">
            <polyline points="9 18 15 12 9 6" />
          </svg>
          <span>执行过程</span>
        </button>
        <div v-if="showProcess" class="srv-process">
          <div class="srv-process-head">
            <span>执行过程</span>
            <span v-if="outputExists" class="srv-process-size">{{ outputSizeText }}</span>
          </div>
          <pre v-if="outputExists !== false" ref="processTextEl" class="srv-process-text">{{ outputChunk !== '' ? outputChunk : '加载中…' }}</pre>
          <div v-else class="srv-process-empty">无过程记录</div>
        </div>
      </div>

      <!-- 终态：token 用量（result 视图 footer） -->
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
}

.srv-elapsed {
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
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

.subagent-result-placeholder {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted-foreground);
  font-size: 13px;
  padding: 10px 0;
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

.subagent-result-body {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  padding: 14px 18px;
}

.subagent-result-text {
  margin: 0;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.65;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
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

/* ===== 执行过程（实时 tail / 终态回看）===== */
.srv-process {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  overflow: hidden;
}

.srv-process-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted-foreground);
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 6%, var(--card));
}

.srv-process-size {
  font-variant-numeric: tabular-nums;
  font-weight: 400;
}

.srv-process-text {
  margin: 0;
  padding: 10px 14px;
  max-height: 260px;
  overflow-y: auto;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.6;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
}

.srv-process-empty {
  padding: 12px 14px;
  font-size: 12.5px;
  color: var(--muted-foreground);
}

.srv-process-panel {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.srv-process-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--muted-foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}

.srv-process-toggle:hover {
  border-color: var(--brand);
  color: var(--foreground);
}

.srv-process-toggle svg {
  width: 12px;
  height: 12px;
  transition: transform var(--transition-fast);
}

.srv-process-toggle svg.expanded {
  transform: rotate(90deg);
}
</style>