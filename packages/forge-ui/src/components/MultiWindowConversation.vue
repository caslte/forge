<script setup lang="ts">
import { ref, computed, reactive, nextTick, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from '../bridge';
import type { ConversationMessage, SessionStatus, Subagent } from '../types';
import { useToast } from '../composables/useToast';
import InstructionInput from './InstructionInput.vue';
import MessageListItem, { type DisplayItem, type ToolDiff } from './MessageListItem.vue';
import SubagentTabBar from './SubagentTabBar.vue';
import SubagentResultView from './SubagentResultView.vue';
import { computeTurnFooters } from '../composables/useTurnFooter';
import { useStreamPhase } from '../composables/useStreamPhase';

/**
 * 多窗口画布内单个窗口的会话视图：加载历史、订阅会话/工具事件、渲染消息流，
 * 底部输入与单视图（ConversationView）保持一致（附件 / 切换模型 / 上下文用量 / 发送）。
 * 模块 06：与单视图同样拥有子 Agent Tab 栏 + 结果视图（单/多窗口行为一致，AC-SA-012）。
 */
const props = defineProps<{
  sessionId: string;
  /** 可选模型列表（透传给输入框，与单视图一致） */
  models: string[];
}>();

const { success: toastSuccess } = useToast();

const messages = ref<ConversationMessage[]>([]);
const isStreaming = ref(false);
const loading = ref(false);
const errorMsg = ref<string | null>(null);
const currentModel = ref<string | null>(null);
const scrollRef = ref<HTMLElement | null>(null);

/** 子 Agent 内存态 + 激活 Tab（多窗口下每个窗口独立，AC-SA-012） */
const subagents = ref<Subagent[]>([]);
const activeAgentId = ref<string | null>(null);
const pendingStopAgentId = ref<string | null>(null);

/** toolEventId -> messages 索引，用于 started→completed 聚合 */
const toolEventIndex = new Map<string, number>();

/** 流式阶段指示（方案 A）：按 delta/工具事件推断当前动作文案（思考/输出/写入/读取/执行命令…） */
const { streamPhaseText, reset: resetStreamPhase, markOutputting, markTool, markToolEnd } = useStreamPhase();

/** 工具组折叠状态：key 为工具组稳定 id（首条工具 toolEventId/ts，聚组边界变化不漂移） */
const toolGroupCollapsed = reactive(new Map<string, boolean>());

const isEmpty = computed(() => messages.value.length === 0 && !isStreaming.value && !loading.value);

/** 从 ConversationMessage（role=tool）构造 ToolDiff（Edit 类含 file_path/old_string/new_string） */
function toToolDiff(message: ConversationMessage): ToolDiff | null {
  const input = message.input;
  if (!input || typeof input !== 'object') return null;
  if (!('old_string' in input) && !('new_string' in input)) return null;
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  return {
    id: message.toolEventId ?? `${message.ts}-${input.file_path ?? ''}`,
    filePath: text(input.file_path),
    oldString: text(input.old_string),
    newString: text(input.new_string),
  };
}

function groupDiffs(tools: ConversationMessage[]): ToolDiff[] {
  return tools.flatMap((tool) => {
    const diff = toToolDiff(tool);
    return diff ? [diff] : [];
  });
}

/**
 * 稳定唯一 key：
 * - 消息：id ?? toolEventId ?? `ts-role`（不依赖列表位置，避免 idx 漂移导致 patch 错位）
 * - 工具组：首条工具 toolEventId ?? ts 加 `-group` 后缀（与消息 key 永不冲突）
 */
function itemKey(m: ConversationMessage): string {
  return m.id ?? m.toolEventId ?? `${m.ts}-${m.role}`;
}

const displayItems = computed(() => {
  const out: DisplayItem[] = [];
  const msgs = messages.value;
  // 轮次 footer：一次回复被工具调用拆成多张 assistant 卡片时，仅末卡显示复制+时间
  const footers = computeTurnFooters(msgs);
  let i = 0;
  while (i < msgs.length) {
    const cur = msgs[i]!;
    if (cur.role !== 'tool') {
      const footer = footers.get(i);
      out.push({
        key: itemKey(cur),
        kind: 'message',
        msg: cur,
        idx: i,
        ...(footer ? { showFooter: footer.showFooter, copyText: footer.copyText } : {}),
      });
      i += 1;
    } else {
      const start = i;
      const tools: ConversationMessage[] = [];
      while (i < msgs.length && msgs[i]!.role === 'tool') {
        tools.push(msgs[i]!);
        i += 1;
      }
      if (tools.length >= 2) {
        const first = tools[0]!;
        const groupKey = `${first.toolEventId ?? first.ts}-group`;
        const counts = new Map<string, number>();
        for (const t of tools) counts.set(t.toolName ?? 'tool', (counts.get(t.toolName ?? 'tool') ?? 0) + 1);
        const toolCounts = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
        const collapsed = toolGroupCollapsed.get(groupKey) ?? true;
        out.push({
          key: groupKey,
          kind: 'tool-group',
          tools,
          toolCounts,
          totalCount: tools.length,
          collapsed,
          diffs: groupDiffs(tools),
        });
      } else {
        for (let j = 0; j < tools.length; j += 1) {
          const tm = tools[j]!;
          out.push({ key: itemKey(tm), kind: 'message', msg: tm, idx: start + j });
        }
      }
    }
  }
  return out;
});

function toggleGroup(key: string): void {
  const cur = toolGroupCollapsed.get(key);
  toolGroupCollapsed.set(key, !(cur ?? true));
}

const sessionStatus = computed<SessionStatus>(() => (isStreaming.value ? 'streaming' : 'idle'));

const activeAssistantIndex = computed(() => messages.value.map((m) => m.role).lastIndexOf('assistant'));

function isMessageStreaming(index: number): boolean {
  return isStreaming.value && index === activeAssistantIndex.value;
}

function scrollToBottom(): void {
  const el = scrollRef.value;
  if (!el) return;
  const prev = el.style.scrollBehavior;
  el.style.scrollBehavior = 'auto';
  el.scrollTop = el.scrollHeight;
  requestAnimationFrame(() => {
    if (scrollRef.value !== el) return;
    el.scrollTop = el.scrollHeight;
    el.style.scrollBehavior = prev;
  });
}

async function loadModel(): Promise<void> {
  try {
    const res = await call<{ model: string | null }>('model/getSessionModel', {
      sessionId: props.sessionId,
    });
    currentModel.value = res.model;
  } catch {
    currentModel.value = null;
  }
}

async function onSelectModel(model: string): Promise<void> {
  try {
    await call('model/setSessionModel', { sessionId: props.sessionId, model });
    currentModel.value = model;
    toastSuccess(`已切换模型：${model}`); // 顶部全局提示
    showSwitchBanner(model); // 窗口内容内提示
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  }
}

/** 在当前窗口内临时显示"已切换模型"横幅，便于在多窗口分辨是哪个窗口切换 */
const switchBanner = ref<string | null>(null);
let switchBannerTimer: ReturnType<typeof setTimeout> | null = null;
function showSwitchBanner(model: string): void {
  switchBanner.value = `已切换模型 ${model}`;
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
  switchBannerTimer = setTimeout(() => {
    switchBanner.value = null;
  }, 2600);
}

async function loadHistory(): Promise<void> {
  loading.value = true;
  errorMsg.value = null;
  try {
    const res = await call<{ messages: ConversationMessage[] }>('conversation/queryHistory', {
      sessionId: props.sessionId,
    });
    messages.value = res.messages ?? [];
    toolEventIndex.clear();
    toolGroupCollapsed.clear();
    messages.value.forEach((m, i) => {
      if (m.role === 'tool' && m.toolEventId) toolEventIndex.set(m.toolEventId, i);
    });
    nextTick(scrollToBottom);
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    nextTick(scrollToBottom);
  }
}

async function onSend(text: string): Promise<void> {
  const t = text.trim();
  if (!t || isStreaming.value) return;
  errorMsg.value = null;
  messages.value.push({
    role: 'user',
    content: t,
    ts: new Date().toISOString(),
  });
  isStreaming.value = true;
  resetStreamPhase();
  nextTick(scrollToBottom);
  try {
    const params: Record<string, unknown> = { sessionId: props.sessionId, content: t };
    await call<null>('conversation/sendMessage', params);
  } catch (e) {
    isStreaming.value = false;
    errorMsg.value = e instanceof Error ? e.message : String(e);
  }
}

async function onCancel(): Promise<void> {
  try {
    await call('conversation/cancelStream', { sessionId: props.sessionId });
  } catch {
    // 忽略
  }
  isStreaming.value = false;
}

// ===== 事件处理（按自身 sessionId 过滤） =====
function onMessage(payload: unknown): void {
  const p = payload as { sessionId: string; message: ConversationMessage };
  if (p.sessionId !== props.sessionId) return;
  const last = messages.value[messages.value.length - 1];
  if (last && last.role === 'assistant') {
    last.content = p.message.content;
    last.ts = p.message.ts ?? last.ts;
    nextTick(scrollToBottom);
    return;
  }
  messages.value.push(p.message);
  nextTick(scrollToBottom);
}

function onDelta(payload: unknown): void {
  // 契约：delta 为 { text, kind: 'text' }（docs/api/03_conversation.md §3）
  const p = payload as { sessionId: string; delta: { text?: string } | string };
  if (p.sessionId !== props.sessionId) return;
  const text = typeof p.delta === 'string' ? p.delta : (p.delta.text ?? '');
  if (text !== '') markOutputting();
  const last = messages.value[messages.value.length - 1];
  if (last && last.role === 'assistant') {
    last.content += text;
  } else {
    messages.value.push({ role: 'assistant', content: text, ts: new Date().toISOString() });
  }
  nextTick(scrollToBottom);
}

function onStatus(payload: unknown): void {
  const p = payload as { sessionId: string; status: string };
  if (p.sessionId !== props.sessionId) return;
  if (p.status === 'streaming') {
    isStreaming.value = true;
    resetStreamPhase();
  } else if (['done', 'idle', 'canceled', 'error'].includes(p.status)) {
    isStreaming.value = false;
    if (p.status !== 'error') errorMsg.value = null; // 重试提示在轮次正常结束时消失
  }
}

function onError(payload: unknown): void {
  const p = payload as { sessionId: string; code?: number; message?: string };
  if (p.sessionId !== props.sessionId) return;
  // 同 ConversationView：终态由 status 事件收尾；本事件还承载自动重试提示（轮次仍在 streaming）
  errorMsg.value = p.message ?? `对话错误（${p.code ?? 'unknown'}）`;
}

function onToolStarted(payload: unknown): void {
  const p = payload as { toolEventId: string; sessionId?: string; toolName?: string };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  if (toolEventIndex.has(p.toolEventId)) return;
  markTool(p.toolEventId, p.toolName ?? null);
  messages.value.push({
    role: 'tool',
    content: '',
    ts: new Date().toISOString(),
    toolEventId: p.toolEventId,
    toolName: p.toolName,
    status: 'started',
  });
  toolEventIndex.set(p.toolEventId, messages.value.length - 1);
  nextTick(scrollToBottom);
}

function onToolCompleted(payload: unknown): void {
  const p = payload as { toolEventId: string; sessionId?: string; summary?: string };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  const idx = toolEventIndex.get(p.toolEventId);
  if (idx === undefined) return;
  markToolEnd(p.toolEventId);
  const m = messages.value[idx];
  if (!m) return;
  m.status = 'completed';
  if (p.summary) m.content = p.summary;
}

function onToolError(payload: unknown): void {
  const p = payload as { toolEventId: string; sessionId?: string; summary?: string; message?: string };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  const idx = toolEventIndex.get(p.toolEventId);
  if (idx === undefined) return;
  markToolEnd(p.toolEventId);
  const m = messages.value[idx];
  if (!m) return;
  m.status = 'error';
  if (p.summary || p.message) m.content = p.summary ?? p.message ?? '';
}

// ===== 子 Agent 处理（与单视图同步，AC-SA-012） =====

async function loadSubagents(): Promise<void> {
  try {
    const res = await call<{ subagents: Subagent[] }>('subagent/queryList', {
      sessionId: props.sessionId,
    });
    subagents.value = res.subagents ?? [];
  } catch {
    subagents.value = [];
  }
}

function applySubagentUpsert(sa: Subagent): void {
  const idx = subagents.value.findIndex((s) => s.agentId === sa.agentId);
  if (idx === -1) {
    subagents.value.push({ ...sa });
    return;
  }
  const cur = subagents.value[idx]!;
  subagents.value[idx] = {
    ...cur,
    ...sa,
    finishedAt: cur.finishedAt ?? sa.finishedAt,
    result: cur.result ?? sa.result,
    error: cur.error ?? sa.error,
  };
}

function onSubagentUpdated(payload: unknown): void {
  const p = payload as { sessionId: string; subagent: Subagent };
  if (p.sessionId !== props.sessionId) return;
  applySubagentUpsert(p.subagent);
}

function onSubagentRemoved(payload: unknown): void {
  const p = payload as { sessionId: string; agentIds: string[] };
  if (p.sessionId !== props.sessionId) return;
  const removed = new Set(p.agentIds);
  subagents.value = subagents.value.filter((s) => !removed.has(s.agentId));
  if (activeAgentId.value !== null && removed.has(activeAgentId.value)) {
    activeAgentId.value = null;
  }
}

function onSelectTab(agentId: string | null): void {
  activeAgentId.value = agentId;
}

function onCloseTab(agentId: string): void {
  subagents.value = subagents.value.filter((s) => s.agentId !== agentId);
  if (activeAgentId.value === agentId) activeAgentId.value = null;
}

async function onClearFinished(): Promise<void> {
  try {
    await call('subagent/clearFinished', { sessionId: props.sessionId });
    subagents.value = subagents.value.filter(
      (s) => s.status === 'queued' || s.status === 'running',
    );
  } catch {
    subagents.value = subagents.value.filter(
      (s) => s.status === 'queued' || s.status === 'running',
    );
  }
}

function onSubagentStopRequest(agentId: string): void {
  pendingStopAgentId.value = agentId;
}

async function confirmSubagentStop(): Promise<void> {
  const agentId = pendingStopAgentId.value;
  pendingStopAgentId.value = null;
  if (agentId === null) return;
  try {
    await call('subagent/stop', { sessionId: props.sessionId, agentId });
  } catch (e) {
    console.warn('[subagent] 终止失败', e);
  }
}

function cancelSubagentStop(): void {
  pendingStopAgentId.value = null;
}

const activeSubagent = computed<Subagent | null>(() => {
  if (activeAgentId.value === null) return null;
  return subagents.value.find((s) => s.agentId === activeAgentId.value) ?? null;
});

const showResultView = computed(() => activeSubagent.value !== null);

let unsubs: Array<(() => void) | null> = [];

onMounted(() => {
  void loadHistory();
  void loadModel();
  void loadSubagents();
  unsubs = [
    subscribe('conversation.message', onMessage),
    subscribe('conversation.delta', onDelta),
    subscribe('conversation.statusChanged', onStatus),
    subscribe('conversation.error', onError),
    subscribe('tool.started', onToolStarted),
    subscribe('tool.completed', onToolCompleted),
    subscribe('tool.error', onToolError),
    subscribe('subagent.updated', onSubagentUpdated),
    subscribe('subagent.removed', onSubagentRemoved),
  ];
});

onUnmounted(() => {
  unsubs.forEach((u) => u?.());
  unsubs = [];
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
});
</script>

<template>
  <div class="wc-view">
    <!-- 消息区 vs 结果视图：v-show 互斥；结果视图原地占据消息区位置 -->
    <div ref="scrollRef" v-show="!showResultView" class="wc-messages">
      <div v-if="loading" class="wc-hint">加载历史…</div>
      <div v-else-if="isEmpty" class="wc-empty">开始新的对话</div>
      <template v-else>
        <!-- 每个展示项独立组件 + 稳定 key，流式聚合边界变化只在组件内部切换形态 -->
        <MessageListItem
          v-for="item in displayItems"
          :key="item.key"
          :item="item"
          :streaming="item.kind === 'message' && isMessageStreaming(item.idx)"
          :session-id="props.sessionId"
          @toggle-group="toggleGroup"
        />
        <div v-if="isStreaming" class="wc-hint thinking-shimmer">{{ streamPhaseText }}</div>
      </template>
      <div v-if="switchBanner" class="wc-switch-banner">
        <span class="wc-sb-line"></span>
        <span class="wc-sb-text">{{ switchBanner }}</span>
        <span class="wc-sb-line"></span>
      </div>
      <div v-if="errorMsg" class="wc-error">{{ errorMsg }}</div>
    </div>

    <!-- 结果视图：占据消息区位置（与消息区 v-show 互斥） -->
    <SubagentResultView
      v-if="showResultView && activeSubagent"
      :subagent="activeSubagent"
      :session-id="sessionId"
      @stop="onSubagentStopRequest"
    />

    <!-- 子 Agent Tab 栏：固定在输入框上方，仅子 agent > 0 时渲染 -->
    <SubagentTabBar
      :subagents="subagents"
      :active-agent-id="activeAgentId"
      @select="onSelectTab"
      @close="onCloseTab"
      @clear-finished="onClearFinished"
    />

    <div class="wc-input">
      <InstructionInput
        compact
        :session-id="sessionId"
        :session-status="sessionStatus"
        :models="models"
        :current-model="currentModel"
        @send="onSend"
        @cancel="onCancel"
        @model-change="onSelectModel"
      />
    </div>

    <!-- 单个子 agent 终止二次确认弹窗 -->
    <div v-if="pendingStopAgentId" class="wc-stop-confirm-overlay" @click.self="cancelSubagentStop">
      <div class="wc-stop-confirm" role="alertdialog" aria-modal="true" aria-label="确认终止子 Agent">
        <div class="wc-stop-confirm-title">确认终止该子 Agent？</div>
        <div class="wc-stop-confirm-desc">该操作不可逆。终止后子 Agent 将转“已终止”状态，未完成的工作不会保留。</div>
        <div class="wc-stop-confirm-actions">
          <button type="button" class="wc-stop-confirm-cancel" @click="cancelSubagentStop">取消</button>
          <button type="button" class="wc-stop-confirm-confirm" @click="confirmSubagentStop">确认终止</button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wc-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.wc-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.wc-hint {
  color: var(--muted-foreground);
  font-size: 13px;
  padding: 6px 2px;
  text-align: center;
}
.wc-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  font-size: 13px;
}
.wc-error {
  color: var(--destructive);
  font-size: 12px;
  padding: 6px 10px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
}
.wc-switch-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  color: var(--muted-foreground);
  user-select: none;
  animation: fadeIn 0.2s ease-out;
}
.wc-sb-line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklab, var(--border) 80%, transparent);
}
.wc-sb-text {
  font-size: 11px;
  white-space: nowrap;
  font-weight: 500;
}
.wc-input {
  flex-shrink: 0;
  padding: 0 8px 8px;
}
.thinking-shimmer { display: inline-block; font-weight: 500; background: linear-gradient(90deg, #6b7280 0%, #f3f4f6 22%, #6b7280 42%, #e5e7eb 62%, #6b7280 82%, #ffffff 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: thinking-shimmer 2.4s linear infinite; }
@keyframes thinking-shimmer { 0% { background-position: 100% 0%; } 100% { background-position: 0% 0%; } }

/* 结果视图：在多窗口会话区中占据主区位置 */
.subagent-result-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 单个终止二次确认弹窗（多窗口用） */
.wc-stop-confirm-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in oklab, black 50%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5000;
  animation: fadeIn 0.15s ease-out;
}

.wc-stop-confirm {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  padding: 22px 24px;
  max-width: 420px;
  width: calc(100% - 40px);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.wc-stop-confirm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.wc-stop-confirm-desc {
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.55;
}

.wc-stop-confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.wc-stop-confirm-cancel,
.wc-stop-confirm-confirm {
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
}

.wc-stop-confirm-cancel:hover { background: var(--muted); }

.wc-stop-confirm-confirm {
  background: var(--destructive);
  color: var(--brand-foreground);
  border-color: var(--destructive);
}

.wc-stop-confirm-confirm:hover { filter: brightness(0.95); }
</style>
