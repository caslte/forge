<script setup lang="ts">
import { ref, computed, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { call, subscribe, type AttachmentFile } from '../bridge';
import type { ConversationMessage, ProjectItem, SessionItem, SessionStatus, ToolEvent } from '../types';
import MessageCard from './MessageCard.vue';
import DiffView from './DiffView.vue';
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

/** 工具组折叠状态：key 为组首条在 messages 中的起始索引 */
const toolGroupCollapsed = reactive(new Map<number, boolean>());

const isEmpty = computed(() => messages.value.length === 0 && !isStreaming.value && !loadingHistory.value);

/** 分组后的展示项：连续 ≥2 的 tool 合为一组，其余单条透传 */
type DisplayItem =
  | { kind: 'message'; msg: ConversationMessage; idx: number }
  | {
      kind: 'tool-group';
      startIndex: number;
      tools: ConversationMessage[];
      toolCounts: Array<{ name: string; count: number }>;
      totalCount: number;
      diffs: ToolDiff[];
      collapsed: boolean;
      lastSummary?: string;
    };

type ToolDiff = {
  id: string;
  filePath: string | null;
  oldString: string | null;
  newString: string | null;
};

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

const displayItems = computed<DisplayItem[]>(() => {
  const out: DisplayItem[] = [];
  const msgs = messages.value;
  let i = 0;
  while (i < msgs.length) {
    const cur = msgs[i]!;
    if (cur.role !== 'tool') {
      out.push({ kind: 'message', msg: cur, idx: i });
      i += 1;
    } else {
      const start = i;
      const tools: ConversationMessage[] = [];
      while (i < msgs.length && msgs[i]!.role === 'tool') {
        tools.push(msgs[i]!);
        i += 1;
      }
      if (tools.length >= 2) {
        const counts = new Map<string, number>();
        for (const t of tools) counts.set(t.toolName ?? 'tool', (counts.get(t.toolName ?? 'tool') ?? 0) + 1);
        const toolCounts = Array.from(counts.entries()).map(([name, count]) => ({ name, count }));
        // 折叠状态只跟随用户操作；新增工具仅更新头部计数和外部 Diff。
        const collapsed = toolGroupCollapsed.get(start) ?? true;
        out.push({
          kind: 'tool-group',
          startIndex: start,
          tools,
          toolCounts,
          totalCount: tools.length,
          collapsed,
          diffs: groupDiffs(tools),
          lastSummary: tools[tools.length - 1]?.content || undefined,
        });
      } else {
        for (let j = 0; j < tools.length; j += 1) out.push({ kind: 'message', msg: tools[j]!, idx: start + j });
      }
    }
  }
  return out;
});

function toggleGroup(startIndex: number): void {
  const cur = toolGroupCollapsed.get(startIndex);
  toolGroupCollapsed.set(startIndex, !(cur ?? true));
}

const sessionStatus = computed<SessionStatus>(() =>
  isStreaming.value ? 'streaming' : props.session.status,
);

const activeAssistantIndex = computed(() => messages.value.map((m) => m.role).lastIndexOf('assistant'));

function isMessageStreaming(index: number): boolean {
  return isStreaming.value && index === activeAssistantIndex.value;
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
      toolGroupCollapsed.clear();
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
    if (inputSessionId === props.sessionId) {
      loadingHistory.value = false;
      nextTick(scrollToBottom);
    }
  }
}

// 用于判断异步结果是否仍属于当前会话
let inputSessionId = '';

/** 会话切换：重置状态并重新加载 */
function resetForSession(sid: string): void {
  inputSessionId = sid;
  messages.value = [];
  toolEventIndex.clear();
  toolGroupCollapsed.clear();
  isStreaming.value = false;
  errorMsg.value = null;
}

/** 滚动到底部：覆盖 smooth 做瞬时定位，下一帧再补一次；长内容快速到达最后一条回复 */
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

/** 发送消息：本地追加 user 消息 + 调后端（P3-B：携带附件；图片同步进本地消息流展示） */
async function onSend(text: string, attachments?: AttachmentFile[]): Promise<void> {
  errorMsg.value = null;
  // 图片附件进本地消息（实时显示；历史回显由 loadPiSessionHistory 解析 JSONL）
  const images = (attachments ?? [])
    .filter((a) => a.kind === 'image' && typeof a.data === 'string')
    .map((a) => ({ data: a.data as string, mimeType: a.mimeType ?? 'image/png' }));
  messages.value.push({
    role: 'user',
    content: text,
    ts: new Date().toISOString(),
    images: images.length > 0 ? images : undefined,
  });
  isStreaming.value = true;
  nextTick(scrollToBottom);
  try {
    const params: Record<string, unknown> = { sessionId: props.sessionId, content: text };
    if (attachments && attachments.length > 0) {
      params.attachments = attachments.map((a) =>
        a.kind === 'image'
          ? { kind: 'image', name: a.name, mimeType: a.mimeType, data: a.data }
          : { kind: 'text', name: a.name, content: a.content },
      );
    }
    await call('conversation/sendMessage', params);
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
  showSwitchBanner(model);
}

/** 在对话流底部临时显示"已切换模型"横幅，方便多窗口分辨是哪个窗口切换 */
const switchBanner = ref<string | null>(null);
let switchBannerTimer: ReturnType<typeof setTimeout> | null = null;
function showSwitchBanner(model: string): void {
  switchBanner.value = `已切换模型 ${model}`;
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
  switchBannerTimer = setTimeout(() => {
    switchBanner.value = null;
  }, 2600);
}

// ===== 事件处理 =====
function onConversationMessage(payload: unknown): void {
  const p = payload as { sessionId: string; message: ConversationMessage };
  if (p.sessionId !== props.sessionId) return;
  // 流式阶段已通过 delta 构建了一条 assistant 占位消息，最终 message 到达时以其为权威内容覆盖，
  // 避免“delta 累积 + 完整消息再推一条”成双
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

function onConversationDelta(payload: unknown): void {
  // 契约：delta 为 { text, kind: 'text' }（docs/api/03_conversation.md §3）
  const p = payload as { sessionId: string; delta: { text?: string } | string };
  if (p.sessionId !== props.sessionId) return;
  const text = typeof p.delta === 'string' ? p.delta : (p.delta.text ?? '');
  // 流式追加到最后一条 assistant 消息；无则新建
  const last = messages.value[messages.value.length - 1];
  if (last && last.role === 'assistant') {
    last.content += text;
  } else {
    messages.value.push({
      role: 'assistant',
      content: text,
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
  const p = payload as {
    toolEventId: string;
    sessionId?: string;
    tool?: { name?: string; input?: Record<string, unknown> };
    toolName?: string;
  };
  // tool 事件可能不带 sessionId（按 ToolDescriptor 结构），保守处理：若无 sessionId 则归当前会话
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  if (toolEventIndex.has(p.toolEventId)) return;
  const msg: ConversationMessage = {
    role: 'tool',
    content: '',
    ts: new Date().toISOString(),
    toolEventId: p.toolEventId,
    toolName: p.tool?.name ?? p.toolName,
    status: 'started',
    input: p.tool?.input,
  };
  messages.value.push(msg);
  toolEventIndex.set(p.toolEventId, messages.value.length - 1);
  nextTick(scrollToBottom);
}

function onToolCompleted(payload: unknown): void {
  const p = payload as {
    toolEventId: string;
    sessionId?: string;
    result?: { text: string | null };
    summary?: string;
  };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  const idx = toolEventIndex.get(p.toolEventId);
  if (idx === undefined) return;
  const msg = messages.value[idx];
  if (msg) {
    msg.status = 'completed';
    const text = p.result?.text ?? p.summary;
    if (text) msg.content = text;
  }
}

function onToolError(payload: unknown): void {
  const p = payload as {
    toolEventId: string;
    sessionId?: string;
    error?: { message: string };
    summary?: string;
    message?: string;
  };
  if (p.sessionId && p.sessionId !== props.sessionId) return;
  const idx = toolEventIndex.get(p.toolEventId);
  if (idx === undefined) return;
  const msg = messages.value[idx];
  if (msg) {
    msg.status = 'error';
    const text = p.error?.message ?? p.summary ?? p.message;
    if (text) msg.content = text;
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
    input: m.input,
  };
}

function isToolMessage(m: ConversationMessage): boolean {
  return m.role === 'tool';
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
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
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
        </div>

        <!-- 消息流：连续 ≥2 的 tool 聚为可折叠组，文本出现即扎口 -->
        <template v-else>
          <template v-for="item in displayItems" :key="item.kind === 'message' ? (item.msg.id ?? item.msg.toolEventId ?? `msg-${item.idx}-${item.msg.ts}`) : `group-${item.startIndex}`">
            <template v-if="item.kind === 'message'">
              <ToolCallCard v-if="isToolMessage(item.msg)" :event="toToolEvent(item.msg)" />
              <MessageCard
                v-else
                :message="item.msg"
                :streaming="isMessageStreaming(item.idx)"
              />
            </template>
            <div v-else class="tool-group" :class="{ collapsed: item.collapsed }">
              <button class="tool-group-head" @click="toggleGroup(item.startIndex)">
                <svg class="tg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /><path d="M5 21l1.5-4.5" /></svg>
                <span class="tg-label">工具调用</span>
                <span class="tg-count">{{ item.totalCount }} 次</span>
                <span class="tg-names">
                  <span v-for="tc in item.toolCounts" :key="tc.name" class="tg-chip"><span class="tg-chip-name">{{ tc.name }}</span><span v-if="tc.count > 1" class="tg-chip-count">×{{ tc.count }}</span></span>
                </span>
                <span class="tg-collapse">{{ item.collapsed ? '▸' : '▾' }}</span>
              </button>
              <div class="tool-group-body-shell" :class="{ 'is-collapsed': item.collapsed }">
                <div class="tool-group-body">
                  <ToolCallCard v-for="tm in item.tools" :key="tm.toolEventId ?? tm.ts" :event="toToolEvent(tm)" hide-diff />
                </div>
              </div>
              <div v-if="item.diffs.length > 0" class="tool-group-diffs">
                <DiffView
                  v-for="diff in item.diffs"
                  :key="diff.id"
                  class="tool-group-diff"
                  :file-path="diff.filePath"
                  :old-string="diff.oldString"
                  :new-string="diff.newString"
                />
              </div>
            </div>
          </template>
          <!-- 流式思考指示器（无 delta 时显示）带 Codex 银色流光 -->
          <div v-if="isStreaming && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant')" class="conv-thinking">
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
            <span class="thinking-dot"></span>
            <span class="thinking-text thinking-shimmer">助手正在思考</span>
          </div>
        </template>

        <!-- 模型切换横幅（临时显示在对话流底部） -->
        <div v-if="switchBanner" class="conv-switch-banner">
          <span class="csb-line"></span>
          <span class="csb-text">{{ switchBanner }}</span>
          <span class="csb-line"></span>
        </div>

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
        :session-id="props.sessionId"
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
  display: flex;
  flex-direction: column;
  overflow-y: auto;
  padding: 18px 38px;
  scroll-behavior: smooth;
}

.conv-messages-inner {
  display: flex;
  flex-direction: column;
  gap: 16px;
  flex: 1;
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

/* 工具组折叠（连续 ≥2 的 tool 聚为一组）复用 ai-coding tool-cluster 思路 */
.tool-group {
  border: none;
  border-radius: 12px;
  background: color-mix(in oklab, var(--muted) 58%, transparent);
  overflow: hidden;
}
.tool-group-head {
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
.tool-group-head:hover { background: var(--muted); }
.tg-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--muted-foreground); }
.tg-label { font-weight: 600; color: var(--foreground); white-space: nowrap; }
.tg-count { font-weight: 500; color: var(--muted-foreground); white-space: nowrap; }
.tg-names { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; overflow: hidden; flex-wrap: nowrap; }
.tg-chip { display: inline-flex; align-items: center; gap: 1px; font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); background: color-mix(in oklab, var(--muted) 55%, transparent); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
.tg-chip-count { font-weight: 600; color: var(--foreground); }
.tg-collapse { flex-shrink: 0; color: var(--muted-foreground); font-size: 12px; }
.tool-group-body-shell { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 200ms cubic-bezier(0.4,0,0.2,1); overflow: hidden; }
.tool-group-body-shell.is-collapsed { grid-template-rows: 0fr; }
.tool-group-body { min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 10px; transition: padding 200ms cubic-bezier(0.4,0,0.2,1), gap 200ms cubic-bezier(0.4,0,0.2,1); }
.tool-group-body-shell.is-collapsed .tool-group-body { padding-top: 0; padding-bottom: 0; gap: 0; }
.tool-group-diffs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 94%;
}
.tool-group-diff {
  background: var(--card);
}

/* Codex 银色流光（ai-coding streaming-working 同款，银色版） */
.thinking-shimmer {
  display: inline-block;
  font-weight: 500;
  background: linear-gradient(90deg, #6b7280 0%, #f3f4f6 22%, #6b7280 42%, #e5e7eb 62%, #6b7280 82%, #ffffff 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: thinking-shimmer 2.4s linear infinite;
}
@keyframes thinking-shimmer {
  0% { background-position: 100% 0%; }
  100% { background-position: 0% 0%; }
}

/* 空会话欢迎页：占满整个内容区可视高度并水平/垂直居中 */
.conv-welcome {
  flex: 1;
  text-align: center;
  padding: 24px;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
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

/* 模型切换横幅：带左右横线的居中提示 */
.conv-switch-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 2px 6px;
  color: var(--muted-foreground);
  user-select: none;
  animation: fadeIn 0.2s ease-out;
}
.csb-line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklab, var(--border) 80%, transparent);
}
.csb-text {
  font-size: 11.5px;
  white-space: nowrap;
  font-weight: 500;
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
