<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from '../bridge';
import type { ConversationMessage, ProjectItem, SessionItem, SessionStatus, ToolEvent } from '../types';
import MessageCard from './MessageCard.vue';
import ToolCallCard from './ToolCallCard.vue';
import InstructionInput from './InstructionInput.vue';

/**
 * 对话主视图。
 * 参考 ai-coding ConversationView 的消息流 + 内嵌 composer 结构，但精简为：
 * - 单一会话消息流（不做 subagent tab / 消息分组聚类，后端 mock 不支持）
 * - 历史加载（conversation/queryHistory）
 * - 事件订阅：conversation.message / delta / statusChanged / error + tool.started/completed/error
 * - 流式状态条（streaming 时顶部显示）
 * - 空会话欢迎页
 * - 底部内嵌 InstructionInput
 *
 * 工具事件（tool.*）作为 role='tool' 消息插入流中，按 toolEventId 聚合 started→completed。
 * mock 适配器不产生工具事件，但事件通道真实存在，UI 兼容渲染。
 */
const props = defineProps<{
  sessionId: string;
  project: ProjectItem;
  session: SessionItem;
  models: string[];
  currentModel: string | null;
}>();

const emit = defineEmits<{
  (e: 'model-change', model: string): void;
}>();

const messages = ref<ConversationMessage[]>([]);
const isStreaming = ref(false);
const loadingHistory = ref(false);
const errorMsg = ref<string | null>(null);
const scrollRef = ref<HTMLElement | null>(null);
const inputRef = ref<InstanceType<typeof InstructionInput> | null>(null);

/** toolEventId -> messages 数组索引，用于 started→completed 聚合 */
const toolEventIndex = new Map<string, number>();

const isEmpty = computed(() => messages.value.length === 0 && !isStreaming.value && !loadingHistory.value);

const sessionStatus = computed<SessionStatus>(() =>
  isStreaming.value ? 'streaming' : props.session.status,
);

const projectDisplayName = computed(() => props.project.alias ?? basename(props.project.path));

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

/** 加载历史消息 */
async function loadHistory(): Promise<void> {
  loadingHistory.value = true;
  errorMsg.value = null;
  try {
    const res = await call<{ messages: ConversationMessage[] }>('conversation/queryHistory', {
      sessionId: props.sessionId,
    });
    // 仅在会话未切换时应用结果
    if (inputSessionId === props.sessionId) {
      messages.value = res.messages ?? [];
      toolEventIndex.clear();
      // 重建工具事件索引
      messages.value.forEach((m, i) => {
        if (m.role === 'tool' && m.toolEventId) {
          toolEventIndex.set(m.toolEventId, i);
        }
      });
      nextTick(scrollToBottom);
    }
  } catch (e) {
    errorMsg.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (inputSessionId === props.sessionId) loadingHistory.value = false;
  }
}

// 用于判断异步结果是否仍属于当前会话
let inputSessionId = '';

/** 会话切换：重置状态并重新加载 */
function resetForSession(sid: string): void {
  inputSessionId = sid;
  messages.value = [];
  toolEventIndex.clear();
  isStreaming.value = false;
  errorMsg.value = null;
}

/** 滚动到底部 */
function scrollToBottom(): void {
  const el = scrollRef.value;
  if (!el) return;
  el.scrollTop = el.scrollHeight;
}

/** 发送消息：本地追加 user 消息 + 调后端 */
async function onSend(text: string): Promise<void> {
  errorMsg.value = null;
  messages.value.push({
    role: 'user',
    content: text,
    ts: new Date().toISOString(),
  });
  isStreaming.value = true;
  nextTick(scrollToBottom);
  try {
    await call('conversation/sendMessage', { sessionId: props.sessionId, content: text });
  } catch (e) {
    isStreaming.value = false;
    errorMsg.value = e instanceof Error ? e.message : String(e);
  }
}

/** 取消流式 */
async function onCancel(): Promise<void> {
  try {
    await call('conversation/cancelStream', { sessionId: props.sessionId });
  } catch (e) {
    // 取消失败不阻塞，仍允许 UI 停止
  }
  isStreaming.value = false;
}

function onModelChange(model: string): void {
  emit('model-change', model);
}

// ===== 事件处理 =====
function onConversationMessage(payload: unknown): void {
  const p = payload as { sessionId: string; message: ConversationMessage };
  if (p.sessionId !== props.sessionId) return;
  messages.value.push(p.message);
  nextTick(scrollToBottom);
}

function onConversationDelta(payload: unknown): void {
  const p = payload as { sessionId: string; delta: string };
  if (p.sessionId !== props.sessionId) return;
  // 流式追加到最后一条 assistant 消息；无则新建
  const last = messages.value[messages.value.length - 1];
  if (last && last.role === 'assistant') {
    last.content += p.delta;
  } else {
    messages.value.push({
      role: 'assistant',
      content: p.delta,
      ts: new Date().toISOString(),
    });
  }
  nextTick(scrollToBottom);
}

function onConversationStatusChanged(payload: unknown): void {
  const p = payload as { sessionId: string; status: string };
  if (p.sessionId !== props.sessionId) return;
  if (p.status === 'streaming') {
    isStreaming.value = true;
  } else if (p.status === 'done' || p.status === 'idle' || p.status === 'error') {
    isStreaming.value = false;
  }
}

function onConversationError(payload: unknown): void {
  const p = payload as { sessionId: string; code?: number; message?: string };
  if (p.sessionId !== props.sessionId) return;
  isStreaming.value = false;
  errorMsg.value = p.message ?? `对话错误（${p.code ?? 'unknown'}）`;
}

function onToolStarted(payload: unknown): void {
  const p = payload as { toolEventId: string; sessionId?: string; toolName?: string; summary?: string };
  // tool 事件可能不带 sessionId（按 ToolDescriptor 结构），保守处理：若无 sessionId 则归当前会话
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  if (toolEventIndex.has(p.toolEventId)) return;
  const msg: ConversationMessage = {
    role: 'tool',
    content: '',
    ts: new Date().toISOString(),
    toolEventId: p.toolEventId,
    toolName: p.toolName,
    status: 'started',
  };
  messages.value.push(msg);
  toolEventIndex.set(p.toolEventId, messages.value.length - 1);
  nextTick(scrollToBottom);
}

function onToolCompleted(payload: unknown): void {
  const p = payload as { toolEventId: string; sessionId?: string; summary?: string };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  const idx = toolEventIndex.get(p.toolEventId);
  if (idx === undefined) return;
  const msg = messages.value[idx];
  if (msg) {
    msg.status = 'completed';
    if (p.summary) msg.content = p.summary;
  }
}

function onToolError(payload: unknown): void {
  const p = payload as { toolEventId: string; sessionId?: string; summary?: string; message?: string };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  const idx = toolEventIndex.get(p.toolEventId);
  if (idx === undefined) return;
  const msg = messages.value[idx];
  if (msg) {
    msg.status = 'error';
    if (p.summary || p.message) msg.content = p.summary ?? p.message ?? '';
  }
}

/** 把 ConversationMessage（role=tool）转成 ToolCallCard 需要的 ToolEvent */
function toToolEvent(m: ConversationMessage): ToolEvent {
  return {
    toolEventId: m.toolEventId ?? '',
    sessionId: props.sessionId,
    status: (m.status ?? 'started') as ToolEvent['status'],
    toolName: m.toolName,
    summary: m.content || undefined,
  };
}

function isToolMessage(m: ConversationMessage): boolean {
  return m.role === 'tool' && !!m.toolEventId;
}

// 事件订阅句柄
let unsubs: Array<(() => void) | null> = [];

onMounted(() => {
  resetForSession(props.sessionId);
  void loadHistory();
  unsubs = [
    subscribe('conversation.message', onConversationMessage),
    subscribe('conversation.delta', onConversationDelta),
    subscribe('conversation.statusChanged', onConversationStatusChanged),
    subscribe('conversation.error', onConversationError),
    subscribe('tool.started', onToolStarted),
    subscribe('tool.completed', onToolCompleted),
    subscribe('tool.error', onToolError),
  ];
});

onUnmounted(() => {
  unsubs.forEach((u) => u?.());
  unsubs = [];
});

// 会话切换
watch(
  () => props.sessionId,
  (sid) => {
    resetForSession(sid);
    void loadHistory();
  },
);
</script>

<template>
  <div class="conv-view">
    <div ref="scrollRef" class="conv-messages">
      <div class="conv-messages-inner">
        <!-- 加载态 -->
        <div v-if="loadingHistory" class="conv-loading">
          <span class="loading-dot"></span>
          <span class="loading-dot"></span>
          <span class="loading-dot"></span>
          <span class="loading-text">加载历史消息</span>
        </div>

        <!-- 空会话欢迎页 -->
        <div v-else-if="isEmpty" class="conv-welcome">
          <div class="welcome-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
            </svg>
          </div>
          <h3 class="welcome-title">开始新的对话</h3>
          <p class="welcome-project">{{ projectDisplayName }}</p>
          <p class="welcome-hint">在下方输入框输入指令，Enter 发送</p>
        </div>

        <!-- 消息流 -->
        <template v-else>
          <template v-for="(m, i) in messages" :key="m.id ?? (m.toolEventId ?? `msg-${i}-${m.ts}`)">
            <ToolCallCard v-if="isToolMessage(m)" :event="toToolEvent(m)" />
            <MessageCard
              v-else
              :message="m"
              :streaming="isStreaming && i === messages.length - 1 && m.role === 'assistant'"
            />
          </template>
          <!-- 流式思考指示器（无 delta 时显示） -->
          <div v-if="isStreaming && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant')" class="conv-thinking">
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
            <span class="thinking-text">助手正在思考</span>
          </div>
        </template>

        <!-- 错误提示 -->
        <div v-if="errorMsg" class="conv-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
          <span>{{ errorMsg }}</span>
        </div>
      </div>
    </div>

    <div class="conv-input-wrap">
      <InstructionInput
        ref="inputRef"
        :session-status="sessionStatus"
        :models="models"
        :current-model="currentModel"
        @send="onSend"
        @cancel="onCancel"
        @model-change="onModelChange"
      />
    </div>
  </div>
</template>

<style scoped>
.conv-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
}

/* 消息流：全宽 thread，与原型对齐 */
.conv-messages {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 18px 22px;
  scroll-behavior: smooth;
}

.conv-messages-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 加载态 */
.conv-loading,
.conv-thinking {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 10px 14px;
  color: var(--muted-foreground);
  font-size: 13px;
}

.loading-dot,
.thinking-dot {
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--muted-foreground);
  opacity: 0.4;
  animation: dot-bounce 1.4s ease-in-out infinite;
}

.loading-dot:nth-child(2),
.thinking-dot:nth-child(2) {
  animation-delay: 0.16s;
}

.loading-dot:nth-child(3),
.thinking-dot:nth-child(3) {
  animation-delay: 0.32s;
}

@keyframes dot-bounce {
  0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
  40% { opacity: 1; transform: scale(1.1); }
}

.loading-text,
.thinking-text {
  margin-left: 6px;
}

/* 空会话欢迎页 */
.conv-welcome {
  text-align: center;
  padding: 60px 24px 40px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  animation: fadeIn 0.3s ease-out;
}

.welcome-icon {
  width: 56px;
  height: 56px;
  margin-bottom: 8px;
  color: var(--brand);
  opacity: 0.55;
}

.welcome-icon svg {
  width: 100%;
  height: 100%;
}

.welcome-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--foreground);
}

.welcome-project {
  font-size: 13px;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
}

.welcome-hint {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-top: 4px;
}

/* 错误提示 */
.conv-error {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, transparent);
  color: var(--destructive);
  font-size: 12.5px;
  animation: fadeIn 0.2s ease-out;
}

.conv-error svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

/* 输入区 */
.conv-input-wrap {
  flex-shrink: 0;
  padding: 12px 22px 18px;
}
</style>
