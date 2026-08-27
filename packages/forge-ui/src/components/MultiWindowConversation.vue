<script setup lang="ts">
import { ref, computed, reactive, nextTick, onMounted, onUnmounted } from 'vue';
import { call, subscribe, type AttachmentFile } from '../bridge';
import type { ConversationMessage, SessionStatus, ToolEvent } from '../types';
import { useToast } from '../composables/useToast';
import MessageCard from './MessageCard.vue';
import DiffView from './DiffView.vue';
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

/** 工具组折叠：key 为组起始索引 */
const toolGroupCollapsed = reactive(new Map<number, boolean>());

const isEmpty = computed(() => messages.value.length === 0 && !isStreaming.value && !loading.value);

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
        out.push({ kind: 'tool-group', startIndex: start, tools, toolCounts, totalCount: tools.length, diffs: groupDiffs(tools), collapsed });
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

const sessionStatus = computed<SessionStatus>(() => (isStreaming.value ? 'streaming' : 'idle'));

const activeAssistantIndex = computed(() => messages.value.map((m) => m.role).lastIndexOf('assistant'));

function isMessageStreaming(index: number): boolean {
  return isStreaming.value && index === activeAssistantIndex.value;
}

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
    toolGroupCollapsed.clear();
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

async function onSend(text: string, attachments?: AttachmentFile[]): Promise<void> {
  const t = text.trim();
  if (!t || isStreaming.value) return;
  errorMsg.value = null;
  messages.value.push({ role: 'user', content: t, ts: new Date().toISOString() });
  isStreaming.value = true;
  nextTick(scrollToBottom);
  try {
    const params: Record<string, unknown> = { sessionId: props.sessionId, content: t };
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
  return m.role === 'tool';
}

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
        <template v-for="item in displayItems" :key="item.kind === 'message' ? (item.msg.id ?? item.msg.toolEventId ?? `m-${item.idx}-${item.msg.ts}`) : `group-${item.startIndex}`">
          <template v-if="item.kind === 'message'">
            <ToolCallCard v-if="isToolMessage(item.msg)" :event="toToolEvent(item.msg)" />
            <MessageCard v-else :message="item.msg" :streaming="isMessageStreaming(item.idx)" />
          </template>
          <div v-else class="tool-group wc-tool-group" :class="{ collapsed: item.collapsed }">
            <button class="tool-group-head" @click="toggleGroup(item.startIndex)">
              <svg class="tg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /><path d="M5 21l1.5-4.5" /></svg>
              <span class="tg-label">工具调用</span>
              <span class="tg-count">{{ item.totalCount }} 次</span>
              <span class="tg-names"><span v-for="tc in item.toolCounts" :key="tc.name" class="tg-chip"><span class="tg-chip-name">{{ tc.name }}</span><span v-if="tc.count > 1" class="tg-chip-count">×{{ tc.count }}</span></span></span>
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
        <div v-if="isStreaming && (messages.length === 0 || messages[messages.length - 1]?.role !== 'assistant')" class="wc-hint thinking-shimmer">助手正在思考</div>
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
        :session-id="sessionId"
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
.tool-group { border: none; border-radius: 12px; background: color-mix(in oklab, var(--muted) 58%, transparent); overflow: hidden; }
.tool-group-head { display: flex; align-items: center; gap: 8px; width: 100%; padding: 9px 12px; font-size: 12px; color: var(--muted-foreground); border: none; background: transparent; cursor: pointer; text-align: left; }
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
.thinking-shimmer { display: inline-block; font-weight: 500; background: linear-gradient(90deg, #6b7280 0%, #f3f4f6 22%, #6b7280 42%, #e5e7eb 62%, #6b7280 82%, #ffffff 100%); background-size: 200% 100%; -webkit-background-clip: text; background-clip: text; -webkit-text-fill-color: transparent; animation: thinking-shimmer 2.4s linear infinite; }
@keyframes thinking-shimmer { 0% { background-position: 100% 0%; } 100% { background-position: 0% 0%; } }
</style>
