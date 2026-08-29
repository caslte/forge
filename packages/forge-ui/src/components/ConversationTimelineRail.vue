<script setup lang="ts">
/**
 * 会话提问时间线 Rail（CV-S06，AC-CV-014/017）。
 *
 * - 数据：由当前会话已加载消息流派生（buildTimelineEntries 纯函数），与消息流同源，
 *   流式期间新增用户消息后条目实时出现，无独立刷新动作；
 * - 空态：messages 为空或无 user 消息时根节点不渲染（无占位，AC-CV-017）；
 * - 视觉：条目为简化短横条标记（不展示文本，截断文本走原生 title），Rail 无分隔边框、
 *   透明背景，融入消息区（用户裁定：避免文本行与分隔竖线的切割感）；
 * - 交互：条目正序排列；点击发出 select（定位/回看由父级消费），点击后目标条目
 *   短暂高亮 1.5s（组件内部处理，AC-CV-016）；hover 防扫过：mouseenter 启动 300ms 计时器，
 *   到时才 emit hover（AC-CV-015），不足 300ms 移开 → clearTimeout 绝不弹；
 *   移开条目立即 emit hover-end 供父级关闭浮窗；
 * - activeIndex（可选）：回看模式定位目标条目弱高亮（browse 态父级传 null）。
 */
import { computed, onUnmounted, ref } from 'vue';
import type { ConversationMessage } from '../types';
import { buildTimelineEntries } from '../utils/conversationTimeline';

const props = defineProps<{
  /** 当前会话已加载消息流（时间线唯一数据源） */
  messages: ConversationMessage[];
  /** 回看模式定位目标消息索引（该条目弱高亮）；browse 态为 null */
  activeIndex?: number | null;
}>();

const emit = defineEmits<{
  /** 点击条目：携带该消息在 messages 数组中的索引（后续 WU 做滚动定位） */
  (e: 'select', index: number): void;
  /** hover 条目停留 ≥300ms 后触发：携带索引与条目元素（父级弹出浮窗预览） */
  (e: 'hover', payload: { index: number; el: HTMLElement }): void;
  /** 指针移开条目：立即通知父级（清计时器/关闭浮窗，无残留） */
  (e: 'hover-end'): void;
}>();

/** 条目纯派生：消息流变更即重建，实时新增无需额外逻辑 */
const entries = computed(() => buildTimelineEntries(props.messages));

/** hover 防扫过延迟（PRD：停留 ≥300ms 才弹浮窗） */
const HOVER_OPEN_DELAY_MS = 300;

let hoverTimer: ReturnType<typeof setTimeout> | null = null;
let pendingHover: { index: number; el: HTMLElement } | null = null;

function clearHoverTimer(): void {
  if (hoverTimer !== null) {
    clearTimeout(hoverTimer);
    hoverTimer = null;
  }
  pendingHover = null;
}

/** 点击定位后目标条目短暂高亮时长（与 ConversationView 的 LOCATE_HIGHLIGHT_MS 一致） */
const FLASH_MS = 1500;
/** 短暂高亮的条目索引（点击后置位，超时清除） */
const flashIndex = ref<number | null>(null);
let flashTimer: ReturnType<typeof setTimeout> | null = null;

function clearFlashTimer(): void {
  if (flashTimer !== null) {
    clearTimeout(flashTimer);
    flashTimer = null;
  }
  flashIndex.value = null;
}

function onSelect(index: number): void {
  // 点击后目标条目短暂高亮（组件内部处理，父级无需传回 highlight）
  flashIndex.value = index;
  if (flashTimer !== null) clearTimeout(flashTimer);
  flashTimer = setTimeout(() => {
    flashTimer = null;
    flashIndex.value = null;
  }, FLASH_MS);
  emit('select', index);
}

function onItemEnter(index: number, event: MouseEvent): void {
  clearHoverTimer();
  const el = event.currentTarget;
  if (!(el instanceof HTMLElement)) return;
  pendingHover = { index, el };
  hoverTimer = setTimeout(() => {
    hoverTimer = null;
    if (!pendingHover) return; // 计时期间已移开（被 clearHoverTimer 置空）
    emit('hover', pendingHover);
    pendingHover = null;
  }, HOVER_OPEN_DELAY_MS);
}

function onItemLeave(): void {
  // 不足 300ms 移开 → 计时器被清、hover 绝不发出；已弹出 → 通知父级立即关闭
  clearHoverTimer();
  emit('hover-end');
}

onUnmounted(() => {
  clearHoverTimer();
  clearFlashTimer();
});
</script>

<template>
  <!-- 空态：无 user 消息时不渲染根节点，不留占位（AC-CV-017） -->
  <nav v-if="entries.length > 0" class="history-rail" data-testid="history-rail" aria-label="会话提问时间线">
    <button
      v-for="entry in entries"
      :key="entry.index"
      type="button"
      class="history-rail-item"
      :class="{ 'is-locate-flash': entry.index === flashIndex, 'is-active': entry.index === activeIndex }"
      data-testid="history-rail-item"
      :title="entry.text"
      @click="onSelect(entry.index)"
      @mouseenter="onItemEnter(entry.index, $event)"
      @mouseleave="onItemLeave"
    ><span class="history-rail-bar" aria-hidden="true"></span></button>
  </nav>
</template>

<style scoped>
/* 窄条纵列（约 28px），与消息区同高；无右边框、透明背景——融入消息区，不做视觉切割。
   条目少时整列垂直居中（safe center：溢出时回退顶部并保持可滚动）。
   内容宽度预留横条伸长空间（hover 22px），overflow 裁剪不会切掉伸长段 */
.history-rail {
  position: relative;
  width: 28px;
  flex-shrink: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  justify-content: safe center;
  gap: 4px;
  padding: 14px 3px;
  overflow-y: auto;
  overflow-x: hidden;
  background: transparent;
}

/* 简化横条标记：条目为极薄圆角横条（不展示文本，截断文本走原生 title 提示） */
.history-rail-item {
  display: flex;
  align-items: center;
  justify-content: flex-start;
  width: 100%;
  height: 12px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  cursor: pointer;
}

/* 横条本体：默认 12×3 圆角条；hover 平滑伸长（ZCode 风格：指针扫过时"最长的那根"随之流动）。
   flex:none——避免被按钮内容宽度（12px）压缩回默认长度 */
.history-rail-bar {
  display: block;
  flex: none;
  width: 12px;
  height: 3px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--muted-foreground) 42%, transparent);
  transition:
    width 200ms cubic-bezier(0.3, 0.7, 0.4, 1),
    background 150ms ease;
}

.history-rail-item:hover .history-rail-bar {
  width: 22px;
  background: color-mix(in oklab, var(--foreground) 72%, transparent);
}

/* 点击定位后目标条目短暂高亮（AC-CV-016，1.5s 后由组件移除） */
.history-rail-item.is-locate-flash .history-rail-bar {
  width: 22px;
  background: var(--brand);
}

/* 回看模式选中条目：保持加长（18px）+ brand 色（AC-CV-016，退出回看后随 activeIndex=null 消失） */
.history-rail-item.is-active .history-rail-bar {
  width: 18px;
  background: var(--brand);
}

.history-rail-item:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -1px;
}
</style>
