<script setup lang="ts">
import { ref, computed, nextTick, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from '../bridge';
import type { ConversationMessage, SessionStatus, ToolEvent } from '../types';
import { useToast } from '../composables/useToast';
import MessageCard from './MessageCard.vue';
import ToolCallCard from './ToolCallCard.vue';
import InstructionInput from './InstructionInput.vue';

/**
 * 多窗口画布内单个窗口的会话视图：加载历史、订阅会话/工具事件、渲染消息流，
 * 底部输入与单视图（ConversationView）保持一致（附件 / 切换模型 / 上下文用量 / 发送）。
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

/** toolEventId -> messages 索引，用于 started→completed 聚合 */
const toolEventIndex = new Map<string, number>();

const isEmpty = computed(() => messages.value.length === 0 && !isStreaming.value && !loading.value);

const sessionStatus = computed<SessionStatus>(() => (isStreaming.value ? 'streaming' : 'idle'));

function scrollToBottom(): void {
  const el = scrollRef.value;
  if (el) el.scrollTop = el.scrollHeight;
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
    messages.value.forEach((m, i) => {
      if (m.role === 'tool' && m.toolEventId) toolEventIndex.set(m.toolEventId, i);
    });
    nextTick(scrollToBottom);
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function onSend(text: string): Promise<void> {
  const t = text.trim();
  if (!t || isStreaming.value) return;
  errorMsg.value = null;
  messages.value.push({ role: 'user', content: t, ts: new Date().toISOString() });
  isStreaming.value = true;
  nextTick(scrollToBottom);
  try {
    await call('conversation/sendMessage', { sessionId: props.sessionId, content: t });
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
  messages.value.push(p.message);
  nextTick(scrollToBottom);
}

function onDelta(payload: unknown): void {
  const p = payload as { sessionId: string; delta: string };
  if (p.sessionId !== props.sessionId) return;
  const last = messages.value[messages.value.length - 1];
  if (last && last.role === 'assistant') {
    last.content += p.delta;
  } else {
    messages.value.push({ role: 'assistant', content: p.delta, ts: new Date().toISOString() });
  }
  nextTick(scrollToBottom);
}

function onStatus(payload: unknown): void {
  const p = payload as { sessionId: string; status: string };
  if (p.sessionId !== props.sessionId) return;
  if (p.status === 'streaming') isStreaming.value = true;
  else if (['done', 'idle', 'error'].includes(p.status)) isStreaming.value = false;
}

function onError(payload: unknown): void {
  const p = payload as { sessionId: string; code?: number; message?: string };
  if (p.sessionId !== props.sessionId) return;
  isStreaming.value = false;
  errorMsg.value = p.message ?? `对话错误（${p.code ?? 'unknown'}）`;
}

function onToolStarted(payload: unknown): void {
  const p = payload as { toolEventId: string; sessionId?: string; toolName?: string };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  if (toolEventIndex.has(p.toolEventId)) return;
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
  const m = messages.value[idx];
  if (!m) return;
  m.status = 'error';
  if (p.summary || p.message) m.content = p.summary ?? p.message ?? '';
}

function isToolMessage(m: ConversationMessage): boolean {
  return m.role === 'tool' && !!m.toolEventId;
}

function toToolEvent(m: ConversationMessage): ToolEvent {
  return {
    toolEventId: m.toolEventId ?? '',
    sessionId: props.sessionId,
    status: (m.status ?? 'started') as ToolEvent['status'],
    toolName: m.toolName,
    summary: m.content || undefined,
  };
}

let unsubs: Array<(() => void) | null> = [];

onMounted(() => {
  void loadHistory();
  void loadModel();
  unsubs = [
    subscribe('conversation.message', onMessage),
    subscribe('conversation.delta', onDelta),
    subscribe('conversation.statusChanged', onStatus),
    subscribe('conversation.error', onError),
    subscribe('tool.started', onToolStarted),
    subscribe('tool.completed', onToolCompleted),
    subscribe('tool.error', onToolError),
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
    <div ref="scrollRef" class="wc-messages">
      <div v-if="loading" class="wc-hint">加载历史…</div>
      <div v-else-if="isEmpty" class="wc-empty">开始新的对话</div>
      <template v-else>
        <template v-for="(m, i) in messages" :key="m.id ?? (m.toolEventId ?? `m-${i}-${m.ts}`)">
          <ToolCallCard v-if="isToolMessage(m)" :event="toToolEvent(m)" />
          <MessageCard
            v-else
            :message="m"
            :streaming="isStreaming && i === messages.length - 1 && m.role === 'assistant'"
          />
        </template>
        <div
          v-if="isStreaming && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant')"
          class="wc-hint"
        >
          助手正在思考…
        </div>
      </template>
      <div v-if="switchBanner" class="wc-switch-banner">
        <span class="wc-sb-line"></span>
        <span class="wc-sb-text">{{ switchBanner }}</span>
        <span class="wc-sb-line"></span>
      </div>
      <div v-if="errorMsg" class="wc-error">{{ errorMsg }}</div>
    </div>

    <div class="wc-input">
      <InstructionInput
        compact
        :session-status="sessionStatus"
        :models="models"
        :current-model="currentModel"
        @send="onSend"
        @cancel="onCancel"
        @model-change="onSelectModel"
      />
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
  font-size: 12px;
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
</style>