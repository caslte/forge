<script setup lang="ts">
/**
 * 会话提问时间线 Rail（CV-S06，AC-CV-014/017）。
 *
 * - 数据：由当前会话已加载消息流派生（buildTimelineEntries 纯函数），与消息流同源，
 *   流式期间新增用户消息后条目实时出现，无独立刷新动作；
 * - 空态：messages 为空或无 user 消息时根节点不渲染（无占位，AC-CV-017）；
 * - 视觉：简化短横条标记（截断文本走原生 title）；条目少时整列垂直居中（safe center）；
 *   悬停时以悬停条为中心的**波浪衰减**（邻居按距离递减伸长，width 过渡平滑流动，
 *   ZCode 风格）；回看选中条目保持突出（brand 色 + 加长），其波包带动邻居轻微伸长；
 * - 交互：点击发出 select（定位/回看由父级消费）；hover 防扫过：mouseenter 启动 300ms
 *   计时器，到时才 emit hover（AC-CV-015），不足 300ms 移开 → clearTimeout 绝不弹；
 *   移开条目立即 emit hover-end 供父级关闭浮窗；
 * - activeIndex（可选）：回看模式定位目标条目（非悬停时作为波浪中心回退 + brand 色）。
 */
import { computed, onUnmounted, ref } from 'vue';
import type { ConversationMessage } from '../types';
import { buildTimelineEntries } from '../utils/conversationTimeline';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  /** 当前会话已加载消息流（时间线唯一数据源） */
  messages: ConversationMessage[];
  /** 回看模式定位目标消息索引（选中突出 + 非悬停时波浪中心回退）；browse 态为 null */
  activeIndex?: number | null;
}>();

const emit = defineEmits<{
  /** 点击条目：携带该消息在 messages 数组中的索引（父级做滚动定位） */
  (e: 'select', index: number): void;
  /** hover 条目停留 ≥300ms 后触发：携带索引与条目元素（父级弹出浮窗预览） */
  (e: 'hover', payload: { index: number; el: HTMLElement }): void;
  /** 指针移开条目：立即通知父级（清计时器/关闭浮窗，无残留） */
  (e: 'hover-end'): void;
}>();

/** 条目纯派生：消息流变更即重建，实时新增无需额外逻辑 */
const entries = computed(() => buildTimelineEntries(props.messages));

/** 悬停条目索引：mouseenter 立即置位驱动波浪衰减（与 300ms 浮窗计时无关） */
const hoverIndex = ref<number | null>(null);

/** 波浪宽度表（按与中心的距离取值，超出表长回退默认）；悬停波包高于选中波包 */
const HOVER_WAVE = ['22px', '18px', '15px', '13px'] as const;
const ACTIVE_WAVE = ['18px', '15px', '13px'] as const;

/** 条目序数表：消息索引 → 时间线上的相邻序位（波浪距离按序数算——相邻条目的消息索引
 *  因中间隔着 assistant/tool 并不相邻，直接相减会把波包压缩） */
const entryOrdinal = computed(() => {
  const map = new Map<number, number>();
  entries.value.forEach((entry, i) => map.set(entry.index, i));
  return map;
});

function waveDistance(index: number): number | null {
  const center = hoverIndex.value ?? props.activeIndex ?? null;
  if (center == null) return null;
  const c = entryOrdinal.value.get(center);
  const i = entryOrdinal.value.get(index);
  if (c == null || i == null) return null;
  return Math.abs(i - c);
}

function barWidth(index: number): string {
  const d = waveDistance(index);
  if (d == null) return '12px';
  const table = hoverIndex.value != null ? HOVER_WAVE : ACTIVE_WAVE;
  return table[d] ?? '12px';
}

function barColor(index: number): string {
  if (index === hoverIndex.value) return 'color-mix(in oklab, var(--foreground) 72%, transparent)';
  if (index === props.activeIndex) return 'var(--brand)';
  return 'color-mix(in oklab, var(--muted-foreground) 42%, transparent)';
}

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

function onItemEnter(index: number, event: MouseEvent): void {
  hoverIndex.value = index; // 波浪立即响应（width 过渡平滑流动）
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
  hoverIndex.value = null;
  emit('hover-end');
}

function onRailLeave(): void {
  // 指针离开整列（间隙/边缘）：波浪复位、计时器清理（双保险，item mouseleave 已覆盖主路径）
  clearHoverTimer();
  hoverIndex.value = null;
}

onUnmounted(() => {
  clearHoverTimer();
});
</script>

<template>
  <!-- 空态：无 user 消息时不渲染根节点，不留占位（AC-CV-017） -->
  <nav
    v-if="entries.length > 0"
    class="history-rail"
    data-testid="history-rail"
    :aria-label="t('chat.timelineAriaLabel')"
    @mouseleave="onRailLeave"
  >
    <button
      v-for="entry in entries"
      :key="entry.index"
      type="button"
      class="history-rail-item"
      data-testid="history-rail-item"
      :title="entry.text"
      @click="emit('select', entry.index)"
      @mouseenter="onItemEnter(entry.index, $event)"
      @mouseleave="onItemLeave"
    ><span
      class="history-rail-bar"
      aria-hidden="true"
      :style="{ width: barWidth(entry.index), background: barColor(entry.index) }"
    ></span></button>
  </nav>
</template>

<style scoped>
/* 窄条纵列（约 28px），与消息区同高；无右边框、透明背景——融入消息区，不做视觉切割。
   条目少时整列垂直居中（safe center：溢出时回退顶部并保持可滚动）。
   内容宽度预留波峰伸长空间（22px），overflow 裁剪不会切掉伸长段 */
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

/* 横条本体：默认 12×3 圆角条；宽度/颜色由波浪逻辑内联驱动（barWidth/barColor），
   width 过渡让指针扫过时波包平滑流动。flex:none——避免被按钮内容宽度（12px）压缩 */
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

.history-rail-item:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: -1px;
}
</style>

<!-- 暗色 --ring ≈ oklch 0.78，2px 实线外圈在深底上太刺；压到 55% mix。
     ponytail: 想再亮改 65、再压改 45；light 不动。 -->
<style>
:root[data-theme='dark'] .history-rail-item:focus-visible {
  outline-color: color-mix(in oklab, var(--ring) 55%, transparent);
}
</style>

