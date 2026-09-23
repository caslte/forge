<script setup lang="ts">
/**
 * 会话历史浮窗（CV-S06，AC-CV-015/018）。
 *
 * - 内容为**弹出时刻**生成的一轮对话快照（RoundSnapshot，由 ConversationView 用
 *   buildRoundSnapshot 生成后传入），流式期间不随 delta 变化（props 不变则不重渲染内容）；
 * - 纯文本插值（{{ }}，默认转义），绝不使用 v-html；Markdown 符号（#、** 等）原样显示，
 *   不渲染 Markdown/图片（PRD 明确不做）；
 * - assistantText 为 null（该轮暂无助手回复）时显示状态提示：running ? '运行中' : '等待回复'；
 * - 固定宽（约 320px，极窄视口由 solvePopoverPosition 收拢后传入）、max-height 40vh，
 *   内容超出内部滚动（.hp-body overflow auto，AC-CV-018）；
 * - 坐标由 ConversationView 用 solvePopoverPosition 求解后经 props 传入（fixed 定位）；
 *   定位/尺寸样式只读 props，本组件不感知窗口。
 */
import { computed, ref } from 'vue';
import type { RoundSnapshot } from '../utils/conversationTimeline';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  /** 一轮对话快照（弹出时刻快照，流式期间内容不刷新） */
  snapshot: RoundSnapshot;
  /** 该轮是否正在流式（仅影响无回复时的状态提示文案） */
  running?: boolean;
  /** 落位 x（视口坐标，solvePopoverPosition 求解） */
  x: number;
  /** 落位 y（视口坐标） */
  y: number;
  /** 落位宽（默认 320，极窄视口可能被收拢） */
  width: number;
}>();

const emit = defineEmits<{
  /** 指针移出浮窗：通知父级立即关闭（与移开条目/Esc 同效） */
  (e: 'leave'): void;
}>();

/** 根元素（expose 给父级测量实际渲染高度，用于二次校正 y） */
const rootEl = ref<HTMLElement | null>(null);

defineExpose({ rootEl });

/** 无助手回复时的状态提示文案 */
const statusText = computed(() =>
  props.running ? t('chat.popoverRunning') : t('chat.popoverAwaitingReply'),
);
</script>

<template>
  <div
    ref="rootEl"
    class="history-popover"
    data-testid="history-popover"
    role="tooltip"
    :style="{ left: `${x}px`, top: `${y}px`, width: `${width}px` }"
    @mouseleave="emit('leave')"
  >
    <div class="hp-body">
      <section class="hp-section">
        <div class="hp-label">{{ t('chat.popoverUserLabel') }}</div>
        <!-- 纯文本插值：Markdown 符号原样显示，绝不 v-html -->
        <p class="hp-text" data-testid="history-popover-user">{{ snapshot.userText }}</p>
      </section>
      <section class="hp-section">
        <div class="hp-label">{{ t('chat.popoverAssistantLabel') }}</div>
        <p
          v-if="snapshot.assistantText !== null"
          class="hp-text"
          data-testid="history-popover-assistant"
        >{{ snapshot.assistantText }}</p>
        <p v-else class="hp-text hp-status" data-testid="history-popover-status">
          <span class="hp-status-dot" :class="{ 'hp-status-running': running }"></span>
          <span>{{ statusText }}</span>
        </p>
      </section>
    </div>
  </div>
</template>

<style scoped>
/* 落位层内固定定位（坐标由 solvePopoverPosition 求解，ConversationView 传入） */
.history-popover {
  position: fixed;
  z-index: 4200;
  display: flex;
  flex-direction: column;
  max-height: 40vh;
  overflow: hidden;
  background: var(--popover);
  color: var(--popover-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  pointer-events: auto;
}

/* 内容区：超出内部滚动（AC-CV-018 超高内容不撑破视口） */
.hp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.hp-section {
  min-width: 0;
}

.hp-label {
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  color: var(--muted-foreground);
  margin-bottom: 3px;
  user-select: none;
}

/* 纯文本快照：pre-wrap 保留原始换行，Markdown 符号原样 */
.hp-text {
  margin: 0;
  font-family: var(--font-sans);
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
  overflow-wrap: anywhere;
}

/* 无回复状态提示 */
.hp-status {
  display: flex;
  align-items: center;
  gap: 6px;
  color: var(--muted-foreground);
}

.hp-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 999px;
  background: var(--muted-foreground);
  opacity: 0.55;
  flex-shrink: 0;
}

.hp-status-dot.hp-status-running {
  background: var(--warning);
  opacity: 1;
  animation: hp-pulse 1.2s ease-in-out infinite;
}

@keyframes hp-pulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
</style>
