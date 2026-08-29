<script setup lang="ts">
import { ref, computed, reactive, watch, nextTick, onMounted, onUnmounted } from 'vue';
import { call, subscribe, type AttachmentFile } from '../bridge';
import type { ConversationMessage, ProjectItem, SessionItem, SessionStatus, Subagent } from '../types';
import InstructionInput from './InstructionInput.vue';
import MessageListItem, { type DisplayItem, type ToolDiff } from './MessageListItem.vue';
import SubagentTabBar from './SubagentTabBar.vue';
import SubagentResultView from './SubagentResultView.vue';
import { computeTurnFooters } from '../composables/useTurnFooter';

/**
 * 对话主视图。
 * 模块 06：子 Agent Tab 栏 + 结果视图。Tab 栏仅在会话内存态含子 agent 时渲染；
 * 切换 Tab 时消息区 v-show 互斥（不销毁 DOM，切回主会话消息流与滚动位置原样恢复）。
 *
 * 其他职责与原文档一致。
 */
const props = defineProps<{
  /** 草稿态（新建会话尚未发送首条消息）时为 null；发送首条消息时先创建会话再发送 */
  sessionId: string | null;
  project: ProjectItem;
  session: SessionItem | null;
  models: string[];
  currentModel: string | null;
}>();

const emit = defineEmits<{
  (e: 'model-change', model: string): void;
  /** 草稿态发送首条消息时已创建会话，通知上层绑定当前会话 */
  (e: 'session-created', sessionId: string): void;
}>();

const messages = ref<ConversationMessage[]>([]);
const isStreaming = ref(false);
const loadingHistory = ref(false);
const errorMsg = ref<string | null>(null);
const scrollRef = ref<HTMLElement | null>(null);
const inputRef = ref<InstanceType<typeof InstructionInput> | null>(null);

/** 子 Agent 内存态（按 sessionId 隔离）；空 = 不渲染 Tab 栏 */
const subagents = ref<Subagent[]>([]);
/** 当前激活的 Tab；null = 主会话 */
const activeAgentId = ref<string | null>(null);
/** 待二次确认的停止请求（结果视图头部"终止"） */
const pendingStopAgentId = ref<string | null>(null);

/** toolEventId -> messages 数组索引，用于 started→completed 聚合 */
const toolEventIndex = new Map<string, number>();

/** 工具组折叠状态：key 为工具组稳定 id（首条工具 toolEventId/ts，聚组边界变化不漂移） */
const toolGroupCollapsed = reactive(new Map<string, boolean>());

const isEmpty = computed(() => messages.value.length === 0 && !isStreaming.value && !loadingHistory.value);

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
        // 折叠状态只跟随用户操作；新增工具仅更新头部计数和外部 Diff。
        const collapsed = toolGroupCollapsed.get(groupKey) ?? true;
        out.push({
          key: groupKey,
          kind: 'tool-group',
          tools,
          toolCounts,
          totalCount: tools.length,
          collapsed,
          diffs: groupDiffs(tools),
          lastSummary: tools[tools.length - 1]?.content || undefined,
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

const sessionStatus = computed<SessionStatus>(() =>
  isStreaming.value ? 'streaming' : (props.session?.status ?? 'idle'),
);

const activeAssistantIndex = computed(() => messages.value.map((m) => m.role).lastIndexOf('assistant'));

function isMessageStreaming(index: number): boolean {
  return isStreaming.value && index === activeAssistantIndex.value;
}

/** 加载历史消息 */
async function loadHistory(): Promise<void> {
  if (props.sessionId === null) return; // 草稿态无会话，无需加载
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
/**
 * 草稿态发送首条消息时本次创建的会话 id：
 * 上层绑定 currentSessionId 后 props 变化，据此跳过 reset+reload（消息流已在本地）。
 */
let createdSessionId: string | null = null;

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
  // 草稿态（新建会话未发首条消息）：发送前先真正创建会话，左侧树标签随之创建，
  // 标题由 forge-core 首条消息自动命名生成（见 createForgeCore onFirstUserMessage）。
  if (props.sessionId === null) {
    try {
      const res = await call<{ session: { sessionId: string } }>('session/createSession', {
        projectPath: props.project.path,
      });
      const sid = res.session.sessionId;
      createdSessionId = sid;
      inputSessionId = sid;
      // 创建会话前捕获当前展示模型（全局默认或草稿态已切换），随后写入会话覆盖，
      // 保证首条消息按用户所见模型发送（写覆盖失败不阻塞，回退全局默认）
      const draftModel = props.currentModel;
      emit('session-created', sid);
      if (draftModel) {
        await call('model/setSessionModel', { sessionId: sid, model: draftModel }).catch((e) => {
          console.warn('[draft] 写入会话模型覆盖失败，回退全局默认', e);
        });
      }
    } catch (e) {
      errorMsg.value = e instanceof Error ? e.message : String(e);
      return;
    }
  }
  const sessionId = props.sessionId ?? createdSessionId!;
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
    const params: Record<string, unknown> = { sessionId, content: text };
    if (attachments && attachments.length > 0) {
      params.attachments = attachments.map((a) =>
        a.kind === 'image'
          ? { kind: 'image', name: a.name, mimeType: a.mimeType, data: a.data }
          : { kind: 'text', name: a.name, content: a.content },
      );
    }
    const res = await call<{ skippedImages?: number } | null>('conversation/sendMessage', params);
    // 多模态门控：模型不支持图片时后端已跳过图片附件，气泡上标记提示
    if (res && typeof res.skippedImages === 'number' && res.skippedImages > 0) {
      const last = messages.value[messages.value.length - 1];
      if (last && last.role === 'user') last.imageSkipped = true;
    }
  } catch (e) {
    isStreaming.value = false;
    errorMsg.value = e instanceof Error ? e.message : String(e);
  }
}

/** 取消流式 */
async function onCancel(): Promise<void> {
  try {
    await call('conversation/cancelStream', { sessionId: props.sessionId ?? createdSessionId });
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
  // 横幅渲染在对话流底部，立即滚动到底部，避免需要手动下拉才能看到
  nextTick(scrollToBottom);
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
  switchBannerTimer = setTimeout(() => {
    switchBanner.value = null;
  }, 2600);
}

// ===== 事件处理 =====
function onConversationMessage(payload: unknown): void {
  const p = payload as { sessionId: string; message: ConversationMessage };
  if (p.sessionId !== (props.sessionId ?? createdSessionId)) return;
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
  if (p.sessionId !== (props.sessionId ?? createdSessionId)) return;
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
  if (p.sessionId !== (props.sessionId ?? createdSessionId)) return;
  if (p.status === 'streaming') {
    isStreaming.value = true;
  } else if (p.status === 'done' || p.status === 'idle' || p.status === 'canceled' || p.status === 'error') {
    isStreaming.value = false;
  }
}

function onConversationError(payload: unknown): void {
  const p = payload as { sessionId: string; code?: number; message?: string };
  if (p.sessionId !== (props.sessionId ?? createdSessionId)) return;
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
  if (p.sessionId && p.sessionId !== (props.sessionId ?? createdSessionId)) return;
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
  if (p.sessionId && p.sessionId !== (props.sessionId ?? createdSessionId)) return;
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
  if (p.sessionId && p.sessionId !== (props.sessionId ?? createdSessionId)) return;
  const idx = toolEventIndex.get(p.toolEventId);
  if (idx === undefined) return;
  const msg = messages.value[idx];
  if (msg) {
    msg.status = 'error';
    const text = p.error?.message ?? p.summary ?? p.message;
    if (text) msg.content = text;
  }
}

// ===== 子 Agent 处理 =====

/** 加载会话的子 agent 内存态（queryList） */
async function loadSubagents(): Promise<void> {
  const sid = props.sessionId ?? createdSessionId;
  if (sid === null) {
    subagents.value = [];
    return;
  }
  try {
    const res = await call<{ subagents: Subagent[] }>('subagent/queryList', { sessionId: sid });
    subagents.value = res.subagents ?? [];
  } catch {
    subagents.value = [];
  }
}

/** 终态字段不可逆：终态记录的 finishedAt/result 一经设置不得回退 */
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
  if (p.sessionId !== (props.sessionId ?? createdSessionId)) return;
  applySubagentUpsert(p.subagent);
}

function onSubagentRemoved(payload: unknown): void {
  const p = payload as { sessionId: string; agentIds: string[] };
  if (p.sessionId !== (props.sessionId ?? createdSessionId)) return;
  const removed = new Set(p.agentIds);
  subagents.value = subagents.value.filter((s) => !removed.has(s.agentId));
  // 若被移除者正在激活，切回主会话
  if (activeAgentId.value !== null && removed.has(activeAgentId.value)) {
    activeAgentId.value = null;
  }
}

function onSelectTab(agentId: string | null): void {
  activeAgentId.value = agentId;
}

/** 单个终态 Tab 关闭：本地移除（mock 不区分单删与批量清除，二者语义一致） */
function onCloseTab(agentId: string): void {
  subagents.value = subagents.value.filter((s) => s.agentId !== agentId);
  if (activeAgentId.value === agentId) activeAgentId.value = null;
}

/** 清除已完成：批量移除终态 → 调 subagent/clearFinished（mock 也会 emit subagent.removed） */
async function onClearFinished(): Promise<void> {
  const sid = props.sessionId ?? createdSessionId;
  if (sid === null) return;
  try {
    await call('subagent/clearFinished', { sessionId: sid });
    // mock 已 emit subagent.removed 同步了本地状态；防御性主动清一次
    subagents.value = subagents.value.filter(
      (s) => s.status === 'queued' || s.status === 'running',
    );
  } catch {
    // 静默失败：本地乐观更新已落
    subagents.value = subagents.value.filter(
      (s) => s.status === 'queued' || s.status === 'running',
    );
  }
}

/** 结果视图头部“终止”按钮点击：进入二次确认（不可逆） */
function onSubagentStopRequest(agentId: string): void {
  pendingStopAgentId.value = agentId;
}

async function confirmSubagentStop(): Promise<void> {
  const agentId = pendingStopAgentId.value;
  pendingStopAgentId.value = null;
  if (agentId === null) return;
  const sid = props.sessionId ?? createdSessionId;
  if (sid === null) return;
  try {
    await call('subagent/stop', { sessionId: sid, agentId });
  } catch (e) {
    console.warn('[subagent] 终止失败', e);
  }
}

function cancelSubagentStop(): void {
  pendingStopAgentId.value = null;
}

/** 计算属性：当前激活的子 agent（结果视图渲染依赖） */
const activeSubagent = computed<Subagent | null>(() => {
  if (activeAgentId.value === null) return null;
  return subagents.value.find((s) => s.agentId === activeAgentId.value) ?? null;
});

/** 当前是否在结果视图 */
const showResultView = computed(() => activeSubagent.value !== null);

// 事件订阅句柄
let unsubs: Array<(() => void) | null> = [];

onMounted(() => {
  resetForSession(props.sessionId ?? '');
  if (props.sessionId !== null) void loadHistory();
  void loadSubagents();
  unsubs = [
    subscribe('conversation.message', onConversationMessage),
    subscribe('conversation.delta', onConversationDelta),
    subscribe('conversation.statusChanged', onConversationStatusChanged),
    subscribe('conversation.error', onConversationError),
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

// 会话切换
watch(
  () => props.sessionId,
  (sid) => {
    // 草稿发送时本组件创建的会话：消息流已在本地，回落后的 props 变化直接跳过重置与重载
    if (sid !== null && sid === createdSessionId) {
      createdSessionId = null;
      return;
    }
    resetForSession(sid ?? '');
    void loadHistory();
    activeAgentId.value = null; // 切换会话回主会话 Tab
    void loadSubagents();
  },
);
</script>

<template>
  <div class="conv-view">
    <!-- 消息区 vs 结果视图：v-show 互斥，不销毁消息流 DOM；结果视图原地占据消息区位置 -->
    <div ref="scrollRef" v-show="!showResultView" class="conv-messages">
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

        <!-- 消息流：连续 ≥2 的 tool 聚为可折叠组。每个展示项独立组件 + 稳定 key，
             流式聚合边界变化（单条 ↔ 组）只在组件内部切换形态，避免 patch 错位 -->
        <template v-else>
          <MessageListItem
            v-for="item in displayItems"
            :key="item.key"
            :item="item"
            :streaming="item.kind === 'message' && isMessageStreaming(item.idx)"
            :session-id="props.sessionId ?? createdSessionId ?? ''"
            @toggle-group="toggleGroup"
          />
          <!-- 流式思考指示器（流式期间始终显示）带 Codex 银色流光 -->
          <div v-if="isStreaming" class="conv-thinking">
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

    <!-- 结果视图：占据消息区位置（与消息区 v-show 互斥） -->
    <SubagentResultView
      v-if="showResultView && activeSubagent"
      :subagent="activeSubagent"
      @stop="onSubagentStopRequest"
    />

    <!-- 子 Agent Tab 栏：固定在输入框上方，有子 agent 才渲染 -->
    <SubagentTabBar
      :subagents="subagents"
      :active-agent-id="activeAgentId"
      @select="onSelectTab"
      @close="onCloseTab"
      @clear-finished="onClearFinished"
    />

    <div class="conv-input-wrap">
      <InstructionInput
        ref="inputRef"
        :session-id="props.sessionId ?? undefined"
        :session-status="sessionStatus"
        :models="models"
        :current-model="currentModel"
        @send="onSend"
        @cancel="onCancel"
        @model-change="onModelChange"
      />
    </div>

    <!-- 单个子 agent 终止二次确认弹窗（不可逆） -->
    <div v-if="pendingStopAgentId" class="stop-confirm-overlay" @click.self="cancelSubagentStop">
      <div class="stop-confirm" role="alertdialog" aria-modal="true" aria-label="确认终止子 Agent">
        <div class="stop-confirm-title">确认终止该子 Agent？</div>
        <div class="stop-confirm-desc">该操作不可逆。终止后子 Agent 将转“已终止”状态，未完成的工作不会保留。</div>
        <div class="stop-confirm-actions">
          <button type="button" class="stop-confirm-cancel" @click="cancelSubagentStop">取消</button>
          <button type="button" class="stop-confirm-confirm" @click="confirmSubagentStop">确认终止</button>
        </div>
      </div>
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

/* 结果视图：与消息流 v-show 互斥，独立占据消息区位置 */
.subagent-result-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

/* 单个终止二次确认弹窗 */
.stop-confirm-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in oklab, black 50%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 5000;
  animation: fadeIn 0.15s ease-out;
}

.stop-confirm {
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

.stop-confirm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.stop-confirm-desc {
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.55;
}

.stop-confirm-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 4px;
}

.stop-confirm-cancel,
.stop-confirm-confirm {
  padding: 6px 16px;
  border-radius: 8px;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
}

.stop-confirm-cancel:hover {
  background: var(--muted);
}

.stop-confirm-confirm {
  background: var(--destructive);
  color: var(--brand-foreground);
  border-color: var(--destructive);
}

.stop-confirm-confirm:hover {
  filter: brightness(0.95);
}
</style>
