<script setup lang="ts">
/**
 * 子 Agent 工具行（v6.37「子 Agent 工具化」改造）。
 *
 * 取代原先的「输入框上方胶囊 Tab 栏 + 整页结果视图」：子 agent 现在是消息流里的
 * 一行，与工具行同族同缩进，**不受工具组折叠影响**，并发几个就几行。
 *
 * 一行说清四件事：状态（转圈/对勾/叉）、任务描述、agent 类型、实时阶段 + 工具数 + 耗时。
 * 点开即原地展开执行过程（与旧结果视图同一份 queryOutput 解析），终态附用量与结果全文；
 * 运行中头部 hover 出现「终止」，走与旧结果视图完全相同的二次确认弹窗。
 *
 * 设计取舍：
 * - 不新增浮层/抽屉：用户「愿意看就展开」，收起时一行到底，黑盒开发下不打扰。
 * - 展开态左侧一条 1px 竖线当「子会话内文」边界，不用卡片边框套娃。
 * - 过程流不再二次分组折叠（旧结果视图里 ≥2 工具聚一组）：容器本身已是展开态，
 *   再嵌一层折叠纯属多余。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import { call } from '../bridge';
import { renderMarkdown } from '@forge/core/markdown';
import { decorateMarkdownHtml, onMarkdownContentClick } from '../utils/markdownLinks';
import { groupStreamNodes, parseSubagentStream, stripDanglingFence, formatToolArg } from '../utils/subagentStream';
import { formatElapsed } from '../utils/formatElapsed.ts';
import { toolLabelKey } from '../utils/toolLabels.ts';
import { useI18n } from '../i18n/index.ts';
import type { Subagent } from '../types';

const props = defineProps<{
  /** 绑定到的子 agent 记录（必填：未绑定成功的 Agent 调用降级为普通工具行） */
  subagent: Subagent;
  /** 所属会话 ID（读取执行过程输出文件需要） */
  sessionId: string;
  /** 展开态（由父级持有，切会话后可复原） */
  expanded: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle'): void;
  (e: 'stop'): void;
}>();

const { t } = useI18n();

const now = ref<number>(Date.now());
let tickTimer: ReturnType<typeof setInterval> | null = null;

const active = computed(
  () => props.subagent.status === 'queued' || props.subagent.status === 'running',
);

// ===== 实时过程（输出文件 JSONL → 时间线）=====
const outputChunk = ref('');
let loadingOutput = false;

const streamItems = computed(() => parseSubagentStream(outputChunk.value));
/** 过程节点（工具行保持平铺，见文件头设计取舍） */
const streamNodes = computed(() => groupStreamNodes(streamItems.value));
const toolCount = computed(() => streamItems.value.filter((it) => it.kind === 'tool').length);

/** 最近一个仍在跑的工具 → 「正在执行 X…」；无工具时退回输出/思考 */
const runningToolName = computed<string | null>(() => {
  const items = streamItems.value;
  for (let i = items.length - 1; i >= 0; i -= 1) {
    const it = items[i]!;
    if (it.kind === 'tool' && it.status === 'running') {
      const key = toolLabelKey(it.name);
      return key ? t(key) : it.name;
    }
  }
  return null;
});

const phaseText = computed<string>(() => {
  if (!active.value) return '';
  const running = runningToolName.value;
  if (running !== null) return t('chat.agentRunningTool', { name: running });
  if (streamItems.value.length > 0) return t('panels.subagent.outputting');
  return t('panels.subagent.thinking');
});

async function refreshOutput(): Promise<void> {
  if (loadingOutput) return;
  loadingOutput = true;
  try {
    const res = await call<{ exists: boolean; size: number; chunk: string }>('subagent/queryOutput', {
      sessionId: props.sessionId,
      agentId: props.subagent.agentId,
    });
    if (res.chunk !== outputChunk.value) outputChunk.value = res.chunk;
  } catch {
    // 静默：过程读取失败不影响行本身（下一 tick 重试）
  } finally {
    loadingOutput = false;
  }
}

// ===== 展示文案 =====
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

const elapsedSec = computed(() => {
  const start = Date.parse(props.subagent.startedAt);
  if (Number.isNaN(start)) return 0;
  const end = props.subagent.finishedAt ? Date.parse(props.subagent.finishedAt) : now.value;
  return Math.max(0, Math.floor((end - start) / 1000));
});

/** 头部右侧一行：运行中「阶段 · N 次工具 · 1m24s」；终态「状态 · N 次工具 · 2m10s」 */
const metaText = computed(() => {
  const parts: string[] = [];
  parts.push(active.value ? (phaseText.value || statusText(props.subagent.status)) : statusText(props.subagent.status));
  if (toolCount.value > 0) parts.push(t('chat.agentToolCount', { count: toolCount.value }));
  parts.push(formatElapsed(elapsedSec.value));
  return parts.join(' · ');
});

const usage = computed(() => props.subagent.usage);

/** 无过程数据时的结果兜底：completed 用 result 全文（同源 markdown） */
const fallbackResult = computed(() => {
  const r = props.subagent.result;
  return r ? stripDanglingFence(r) : '';
});

const showBody = computed(() => props.expanded);

// ===== 限高滚动区（见 .agent-scroll 样式注释）=====
const scrollRef = ref<HTMLElement | null>(null);
/** 内容是否超出限高：短内容不加边缘渐隐，避免把完整报告虚化掉 */
const overflowing = ref(false);
/** 是否贴底：运行中自动跟随；用户手动往上滚就停止跟随（同主对话的取舍） */
const atBottom = ref(true);

function updateScrollState(): void {
  const el = scrollRef.value;
  if (!el) return;
  overflowing.value = el.scrollHeight - el.clientHeight > 1;
  atBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 4;
}

function onScroll(): void {
  updateScrollState();
}

/** 运行中内容持续增长：贴底时才自动跟随，用户往回翻就不打扰 */
function stickToBottom(): void {
  const el = scrollRef.value;
  if (!el || !showBody.value) return;
  if (el.scrollHeight - el.clientHeight > 1 && atBottom.value) el.scrollTop = el.scrollHeight;
  updateScrollState();
}

watch([streamNodes, fallbackResult], () => {
  void nextTick(stickToBottom);
});

watch(showBody, (open) => {
  if (!open) return;
  // 首次展开默认停在底部（看到最新进度），再由下一帧量出是否超高
  void nextTick(() => {
    const el = scrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
    updateScrollState();
  });
});

// ===== 生命周期：运行中每秒取一次过程 + 刷新耗时；终态补拉一次 =====
watch(active, (isActive, prev) => {
  if (prev && !isActive) void refreshOutput();
});

onMounted(() => {
  void refreshOutput();
  tickTimer = setInterval(() => {
    if (!active.value) return;
    now.value = Date.now();
    void refreshOutput();
  }, 1000);
});

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer);
  tickTimer = null;
});

function onHeadClick(): void {
  emit('toggle');
}

function onHeadKey(ev: KeyboardEvent): void {
  if (ev.key === 'Enter' || ev.key === ' ') {
    ev.preventDefault();
    emit('toggle');
  }
}

function onStopClick(ev: MouseEvent): void {
  ev.stopPropagation();
  emit('stop');
}
</script>

<template>
  <div class="agent-row" :class="[`is-${subagent.status}`, { open: showBody }]">
    <div
      class="agent-head"
      role="button"
      tabindex="0"
      :aria-expanded="showBody"
      :aria-label="t('chat.agentToggleExpand', { name: subagent.description })"
      @click="onHeadClick"
      @keydown="onHeadKey"
    >
      <span class="icon-slot" aria-hidden="true">
        <svg class="ico spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M12 3a9 9 0 1 0 9 9" />
        </svg>
        <svg class="ico ok" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" /><polyline points="8.5 12.2 11 14.7 15.5 9.8" />
        </svg>
        <svg class="ico err" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
          <circle cx="12" cy="12" r="9" /><path d="M9.2 9.2l5.6 5.6M14.8 9.2l-5.6 5.6" />
        </svg>
      </span>
      <span class="agent-ico" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <rect x="3.5" y="6.5" width="17" height="12" rx="3.2" />
          <circle cx="9" cy="12.6" r="1.15" fill="currentColor" stroke="none" />
          <circle cx="15" cy="12.6" r="1.15" fill="currentColor" stroke="none" />
          <path d="M12 6.5V3.8" />
        </svg>
      </span>
      <span class="lbl" :title="subagent.description">{{ subagent.description }}</span>
      <span v-if="subagent.agentType" class="type">{{ subagent.agentType }}</span>
      <span class="meta">{{ metaText }}</span>
      <button
        v-if="active"
        type="button"
        class="agent-stop"
        :title="t('panels.subagent.stopTooltip')"
        @click="onStopClick"
      >{{ t('panels.subagent.stop') }}</button>
    </div>

    <div class="agent-shell">
      <div class="agent-inner">
        <div class="agent-body">
          <!-- 执行过程（运行中实时 / 终态可回看，与旧结果视图同源解析）。
               外层 .agent-scroll 限高 + 内部滚动：见样式注释里的取舍说明。 -->
          <div
            ref="scrollRef"
            class="agent-scroll"
            :class="{ 'is-short': !overflowing }"
            @scroll.passive="onScroll"
          >
          <template v-if="streamNodes.length > 0">
            <template v-for="(node, ni) in streamNodes" :key="ni">
              <div
                v-if="node.kind === 'text'"
                class="agent-text"
                v-html="decorateMarkdownHtml(renderMarkdown(node.text))"
                @click="onMarkdownContentClick"
              ></div>
              <div v-else-if="node.kind === 'tool-group'" class="agent-tools">
                <div v-for="(tc, ti) in node.items" :key="ti" class="agent-tool" :class="tc.status">
                  <span class="tool-status" aria-hidden="true">
                    <span v-if="tc.status === 'running'" class="tool-spinner"></span>
                    <template v-else>{{ tc.status === 'ok' ? '✓' : '✗' }}</template>
                  </span>
                  <span class="tool-name">{{ tc.name }}</span>
                  <span v-if="tc.args" class="tool-args">{{ formatToolArg(tc.args) }}</span>
                </div>
              </div>
              <div v-else class="agent-tool" :class="node.item.status">
                <span class="tool-status" aria-hidden="true">
                  <span v-if="node.item.status === 'running'" class="tool-spinner"></span>
                  <template v-else>{{ node.item.status === 'ok' ? '✓' : '✗' }}</template>
                </span>
                <span class="tool-name">{{ node.item.name }}</span>
                <span v-if="node.item.args" class="tool-args">{{ formatToolArg(node.item.args) }}</span>
              </div>
            </template>
          </template>
          <!-- 无过程数据兜底：completed 用 result 全文 -->
          <template v-else>
            <div
              v-if="fallbackResult"
              class="agent-text"
              v-html="decorateMarkdownHtml(renderMarkdown(fallbackResult))"
              @click="onMarkdownContentClick"
            ></div>
            <div v-else-if="subagent.status === 'completed'" class="agent-empty">{{ t('panels.subagent.noResult') }}</div>
          </template>
          </div>

          <!-- 失败 / 终止错误信息（放限高区外：错误必须一眼看到，不该藏在滚动里） -->
          <div v-if="subagent.status === 'failed' || subagent.status === 'stopped'" class="agent-error">
            <div class="agent-error-title">
              {{ subagent.status === 'failed' ? t('panels.subagent.execFailed') : t('panels.subagent.statusStopped') }}
            </div>
            <div class="agent-error-msg">{{ subagent.error ?? t('panels.subagent.noError') }}</div>
          </div>

          <!-- 终态用量（与旧结果视图同一 i18n 口径） -->
          <div v-if="usage" class="agent-usage">
            <span>{{ t('panels.subagent.usageInput', { tokens: usage.inputTokens.toLocaleString() }) }}</span>
            <span>{{ t('panels.subagent.usageOutput', { tokens: usage.outputTokens.toLocaleString() }) }}</span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 行度量与 ToolCallCard 严格对齐（13px / gap 8 / 15px 图标 / padding 4px 6px / margin-left -6px），
   这样 Agent 行夹在普通工具行之间时基线不歪。 */
.agent-row {
  display: flex;
  flex-direction: column;
  min-width: 0;
  max-width: 100%;
}

.agent-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: calc(100% + 6px);
  padding: 4px 6px;
  margin-left: -6px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--muted-foreground);
  cursor: pointer;
  user-select: none;
  text-align: left;
  transition: background var(--transition-fast);
}

.agent-head:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
}

.agent-head:focus-visible {
  outline: 2px solid color-mix(in oklab, var(--brand) 45%, transparent);
  outline-offset: 1px;
}

/* 状态图标叠放同格（与工具行同一套交叉淡化：状态类驱动 opacity/scale/dashoffset） */
.icon-slot {
  display: grid;
  place-items: center;
  width: 15px;
  height: 15px;
  flex-shrink: 0;
}

.icon-slot > svg {
  grid-area: 1 / 1;
}

.ico {
  width: 15px;
  height: 15px;
}

.ico.ok {
  color: var(--success);
}

.ico.err {
  color: var(--destructive);
}

@keyframes ar-spin {
  to {
    transform: rotate(360deg);
  }
}

.ico.spinner {
  color: var(--muted-foreground);
  animation: ar-spin 0.9s linear infinite;
  transition: opacity var(--motion-icon-out);
}

.ico.ok,
.ico.err {
  opacity: 0;
  transform: scale(0.7);
  transition:
    opacity var(--motion-icon-in) calc(var(--motion-icon-out) / 2),
    transform var(--motion-icon-in) calc(var(--motion-icon-out) / 2);
}

.is-completed .ico.spinner,
.is-failed .ico.spinner,
.is-stopped .ico.spinner {
  opacity: 0;
  animation-play-state: paused;
}

.is-completed .ico.ok,
.is-failed .ico.err,
.is-stopped .ico.err {
  opacity: 1;
  transform: scale(1);
}

/* agent 标记：与工具行的纯状态图标区分开——一眼看出这行是「一个 agent」而不是一次工具调用 */
.agent-ico {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  display: inline-flex;
  color: color-mix(in oklab, var(--muted-foreground) 80%, var(--foreground));
}

.agent-ico svg {
  width: 100%;
  height: 100%;
}

.is-running .agent-ico,
.is-queued .agent-ico {
  color: var(--foreground);
}

.lbl {
  flex-shrink: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--foreground);
  font-weight: 500;
}

/* agent 类型：等宽小字，弱化到注释级（描述名才是主角） */
.type {
  flex-shrink: 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
  opacity: 0.8;
  white-space: nowrap;
}

.meta {
  flex-shrink: 0;
  margin-left: auto;
  padding-left: 10px;
  font-size: 12px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

.is-running .meta,
.is-queued .meta {
  color: color-mix(in oklab, var(--muted-foreground) 70%, var(--foreground));
}

/* 终止：hover 才出现（行本身是阅读对象，按钮不该常驻抢注意力） */
.agent-stop {
  flex-shrink: 0;
  padding: 0 8px;
  height: 20px;
  border: 1px solid color-mix(in oklab, var(--destructive) 32%, var(--border));
  background: color-mix(in oklab, var(--destructive) 8%, var(--background));
  color: var(--destructive);
  border-radius: 6px;
  font-size: 11.5px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast), background var(--transition-fast);
}

.agent-head:hover .agent-stop,
.agent-stop:focus-visible {
  opacity: 1;
}

.agent-stop:hover {
  background: color-mix(in oklab, var(--destructive) 14%, var(--background));
}

/* 展开详情：0fr↔1fr 网格动画，与工具行同一节奏 */
.agent-shell {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-base);
}

.agent-row.open .agent-shell {
  grid-template-rows: 1fr;
}

.agent-inner {
  min-height: 0;
  overflow: hidden;
}

/* 左侧 1px 竖线 = 子会话内文边界（缩进 23px 与工具行组内容左缘一致） */
.agent-body {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin: 4px 0 10px 23px;
  padding-left: 14px;
  border-left: 1px solid color-mix(in oklab, var(--border) 85%, transparent);
}

/* 执行过程限高 + 内部滚动。
 *
 * 为什么必须有：子 agent 一次能跑几十次工具、再吐几千字报告，原样展开会把整个
 * 消息流撑到几屏高，正文被挤出视口——用户的原话是「非常多内容，整个就把页面拉高，
 * 正文也看不到」。限高后展开项自己滚，主对话仍在一屏内。
 *
 * 为什么不用 max-height 兜住 .agent-body 本身：折叠动画走的是外层
 * `.agent-shell { grid-template-rows: 0fr↔1fr }`，body 一旦自带 max-height +
 * overflow，`0fr` 收缩时会被自身滚动容器吞掉高度而不是塌成 0，展开/收起会出现
 * 「半截内容残留」。所以限高只加在 body **内部**的滚动视口上，body 仍是普通流。
 *
 * 46vh：视口高度的一半左右，配合下方 236px 下限，矮窗口不会只剩一条缝。
 * 注意与主对话滚动的关系用 overscroll-behavior: contain 切断——
 * 否则滚到底会「穿透」把整页一起带着滚（同 MessageListItem 的 .tg-scroll 处置）。 */
.agent-scroll {
  max-height: clamp(236px, 46vh, 520px);
  overflow-y: auto;
  overscroll-behavior: contain;
  /* 细滚动条：Firefox */
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklab, var(--muted-foreground) 45%, transparent) transparent;
  /* 上下边缘渐隐，暗示「还有内容」而不是硬切 */
  --ar-fade: 18px;
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    black var(--ar-fade),
    black calc(100% - var(--ar-fade)),
    transparent 100%
  );
}

/* 内容没超高时不要留渐隐（短报告不该被虚化头尾） */
.agent-scroll.is-short {
  mask-image: none;
}

/* 细滚动条：Chromium（宽 3px、透明轨道、半透明圆角滑块），与 TodoPanel 同一口径 */
.agent-scroll::-webkit-scrollbar {
  width: 3px;
}

.agent-scroll::-webkit-scrollbar-track {
  background: transparent;
}

.agent-scroll::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--muted-foreground) 45%, transparent);
  border-radius: 999px;
}

.agent-text {
  font-size: 13px;
  line-height: 1.7;
  color: var(--foreground);
  word-break: break-word;
  min-width: 0;
}

.agent-text :deep(p) {
  margin: 0 0 8px;
}

.agent-text :deep(p:last-child) {
  margin-bottom: 0;
}

.agent-text :deep(pre) {
  background: color-mix(in oklab, var(--muted) 14%, var(--card));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 34px 8px 10px;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12px;
}

.agent-text :deep(code) {
  font-family: var(--font-mono);
  font-size: 12px;
}

.agent-text :deep(ul),
.agent-text :deep(ol) {
  margin: 4px 0;
  padding-left: 20px;
}

.agent-tools {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

/* 过程工具行：无边框纯排版（外层已是展开容器，再套框就成俄罗斯套娃） */
.agent-tool {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--muted-foreground);
  min-width: 0;
  padding: 2px 0;
}

.agent-tool.ok .tool-status {
  color: var(--success);
}

.agent-tool.error .tool-status {
  color: var(--destructive);
}

.tool-status {
  width: 14px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.tool-spinner {
  width: 10px;
  height: 10px;
  border: 2px solid color-mix(in oklab, var(--muted-foreground) 30%, transparent);
  border-top-color: var(--brand);
  border-radius: 999px;
  animation: ar-spin 0.9s linear infinite;
}

.tool-name {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--foreground);
}

.tool-args {
  font-family: var(--font-mono);
  font-size: 11.5px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

.agent-empty {
  font-size: 12px;
  color: var(--muted-foreground);
}

.agent-error {
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, var(--border));
  border-radius: var(--radius-md);
  padding: 10px 12px;
}

.agent-error-title {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--destructive);
  margin-bottom: 4px;
}

.agent-error-msg {
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: pre-wrap;
  word-break: break-word;
}

.agent-usage {
  display: flex;
  gap: 12px;
  font-size: 11.5px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
</style>
