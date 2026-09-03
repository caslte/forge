<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { call } from '../bridge';
import type { SessionItem } from '../types';
import { useSessionConversation } from '../composables/useSessionConversation';
import InstructionInput from './InstructionInput.vue';
import MessageListItem from './MessageListItem.vue';
import SubagentTabBar from './SubagentTabBar.vue';
import SubagentResultView from './SubagentResultView.vue';
import { useCompactBanner } from '../composables/useCompactBanner';
import { formatElapsed } from '../utils/formatElapsed.ts';

/**
 * 多窗口画布内单个窗口的会话视图：会话状态机（消息流/流式/工具/子 Agent）与单视图共用
 * useSessionConversation（模块 06：子 Agent Tab 栏 + 结果视图行为一致，AC-SA-012），
 * 本组件只保留多窗口壳层：加载/切换模型、窗口内提示横幅、输入框。
 */
const props = defineProps<{
  sessionId: string;
  /** 所属会话（流式状态提示源，供加入已在流式的会话时恢复指示器） */
  session: SessionItem | null;
  /** 可选模型列表（透传给输入框，与单视图一致） */
  models: string[];
  /** 项目根路径（透传给输入框，@ 文件补全候选范围） */
  projectPath?: string;
}>();

/**
 * 上下文压缩横幅（内存持久，按 sessionId 隔离）：状态由 InstructionInput 的
 * 事件订阅 / 压缩点击统一维护，本视图只读渲染（与单窗口一致）。
 */
const { getBanner: getCompactBanner } = useCompactBanner();
const compactBanner = computed(() => getCompactBanner(props.sessionId));

const scrollRef = ref<HTMLElement | null>(null);
const currentModel = ref<string | null>(null);

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

/** 共享会话状态机（与单视图同一份实现） */
const {
  isStreaming,
  loadingHistory,
  errorMsg,
  isEmpty,
  displayItems,
  isMessageStreaming,
  toggleGroup,
  sessionStatus,
  streamPhaseText,
  streamElapsedSec,
  send,
  cancel,
  subagents,
  activeAgentId,
  activeSubagent,
  showResultView,
  pendingStopAgentId,
  onSelectTab,
  onCloseTab,
  onClearFinished,
  onSubagentStopRequest,
  confirmSubagentStop,
  cancelSubagentStop,
} = useSessionConversation({
  getSessionId: () => props.sessionId,
  getStatusHint: () => props.session?.status,
  scrollToBottom,
});

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
    showSwitchBanner(model); // 窗口内容内提示（不再弹顶部全局 toast）
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

onMounted(() => {
  void loadModel();
});

onUnmounted(() => {
  if (switchBannerTimer) clearTimeout(switchBannerTimer);
});
</script>

<template>
  <div class="wc-view">
    <!-- 消息区 vs 结果视图：v-show 互斥；结果视图原地占据消息区位置 -->
    <div ref="scrollRef" v-show="!showResultView" class="wc-messages">
      <div v-if="loadingHistory" class="wc-hint">加载历史…</div>
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
        <!-- 与单视图 .conv-thinking 同构：左对齐，窄窗格用紧凑字号/内边距 -->
        <div v-if="isStreaming" class="wc-thinking">
          <span class="thinking-shimmer">{{ streamPhaseText }}</span>
          <span class="thinking-sec">{{ formatElapsed(streamElapsedSec) }}</span>
        </div>
      </template>
      <!-- 上下文压缩横幅（内存持久，App 关闭前保持）：压缩中警示色微光，完成后常驻提示 -->
      <div
        v-if="compactBanner"
        class="wc-compact-banner"
        :class="{ working: compactBanner.phase === 'compacting' }"
      >
        <span class="wc-cb-line"></span>
        <span
          class="wc-cb-text"
          :class="{ 'thinking-shimmer': compactBanner.phase === 'compacting' }"
        >{{ compactBanner.phase === 'compacting' ? '正在压缩上下文' : compactBanner.text }}</span>
        <span class="wc-cb-line"></span>
      </div>
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
        :project-path="projectPath"
        @send="send"
        @cancel="cancel"
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
  /* .mw-body 是 flex row：不设 min-width:0 时内容 min-content（超长 token/代码行）会把
  整列撑宽越出窗口右缘，右下角的上下文用量+发送按钮被 overflow:hidden 裁掉不可见 */
  min-width: 0;
  display: flex;
  flex-direction: column;
}
.wc-messages {
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow-y: auto;
  /* 防御性裁剪：窄窗格下任何残余横向溢出就地隐藏，不撑破窗口右侧 */
  overflow-x: hidden;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  scrollbar-width: thin; /* Firefox 细滚动条 */
}
/* 多窗口消息区滚动条细化（全局 8px 在窄窗格偏粗） */
.wc-messages::-webkit-scrollbar {
  width: 6px;
  height: 6px;
}
.wc-hint {
  color: var(--muted-foreground);
  font-size: 13px;
  padding: 6px 2px;
  text-align: center;
}
/* 流式思考指示：与单视图 .conv-thinking 同款左对齐（曾误用居中的 .wc-hint） */
.wc-thinking {
  display: flex;
  align-items: center;
  padding: 6px 2px;
  color: var(--muted-foreground);
  font-size: 13px;
}
.wc-thinking .thinking-sec {
  margin-left: 6px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  opacity: 0.55;
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
/* 上下文压缩横幅：切换模型同款横线分隔款式；压缩中文字走微光动画 */
.wc-compact-banner {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 2px 4px;
  color: var(--muted-foreground);
  user-select: none;
  animation: fadeIn 0.2s ease-out;
}
.wc-compact-banner .wc-cb-line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklab, var(--border) 80%, transparent);
}
.wc-compact-banner .wc-cb-text {
  font-size: 11px;
  white-space: nowrap;
  font-weight: 500;
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
