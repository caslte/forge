<script setup lang="ts">
/**
 * 分割沟（模块 12 CE-S03）。
 *
 * 只有 5px 宽——两纸贴合，中间仅留一道细缝。这是刻意的：沟宽一旦超过 10px，
 * 它就不再是「分界线」而是「第三块区域」，视觉上代码纸和对话纸就不像同一张面板
 * 被切开了。沟内那条 1px 的分隔线才是真正承担边界语义的元素。
 *
 * 为什么用 Pointer Events 而非 mousedown/touchstart：一套代码同时覆盖鼠标与触摸，
 * 且 `setPointerCapture` 能保证指针滑出沟外甚至滑出窗口时仍持续收到 move。
 * 原生 <input type="range"> 曾考虑过，但双击复位与「钳到 320px 保底」都不合手。
 */
import { computed, ref } from 'vue';
import {
  CODE_SIDE_MIN_PX,
  CODE_SPLIT_PCT_DEFAULT,
  CODE_SPLIT_STEP,
  clampCodeSplitPct,
  nextSplitPct,
} from '../composables/usePreferences';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  /** 当前代码区宽度百分比 */
  pct: number;
  /** 沟的宿主容器宽度（px）——百分比要换算成保底才准 */
  containerWidth: number;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (e: 'update:pct', v: number): void;
  /** 拖拽中持续上报，用于在状态栏就地更新读数而不重建 DOM */
  (e: 'dragging', v: boolean): void;
}>();

const dragging = ref(false);
const root = ref<HTMLElement | null>(null);

/** 保底后的百分比；实际写入用这个值 */
const clamped = computed(() => clampCodeSplitPct(props.pct, props.containerWidth));

function commit(pct: number): void {
  emit('update:pct', clampCodeSplitPct(pct, props.containerWidth));
}

let startX = 0;
let startPct = 0;

function onPointerDown(e: PointerEvent): void {
  if (props.disabled || e.button !== 0) return;
  const el = root.value;
  if (!el) return;
  // 沟自身只有 5px，不便点中；把命中区扩到两侧各 6px，视觉不变但好按
  e.preventDefault();
  dragging.value = true;
  // 捕获指针后光标仍按命中元素渲染（侧栏/终端同款实测）：不全局压住的话，
  // 拖进代码纸光标就变文本 I 形（用户 2026-10-01 点名要侧栏同款恒定居中光标）
  document.body.classList.add('csp-resizing');
  startX = e.clientX;
  startPct = clamped.value;
  el.setPointerCapture(e.pointerId);
  el.focus();
  emit('dragging', true);
}

function onPointerUp(e: PointerEvent): void {
  if (!dragging.value) return;
  dragging.value = false;
  document.body.classList.remove('csp-resizing');
  root.value?.releasePointerCapture?.(e.pointerId);
  emit('dragging', false);
}

function onPointerMove(e: PointerEvent): void {
  // 流光段跟手（侧栏右缘同款）：--seg-y 是相对沟自身的 top，需减掉沟的 rect 起点
  const el = root.value;
  if (el) {
    const r = el.getBoundingClientRect();
    el.style.setProperty('--seg-y', `${e.clientY - r.top}px`);
  }
  if (!dragging.value || props.containerWidth <= 0) return;
  // 起点 + 增量（而非当前值 + 增量）：到边界钳住后往回拖要「走回」被钳掉的距离
  commit(nextSplitPct(startPct, startX, e.clientX, props.containerWidth));
}

/** 双击恢复默认比例（原型与设置页都承诺了这个手势） */
function onDblclick(): void {
  if (props.disabled) return;
  commit(CODE_SPLIT_PCT_DEFAULT);
}

/** ←/→ 每次 2%：方向跟「沟往哪边移」一致（左 = 代码纸变宽）；Home/End 直达两端 */
function onKeydown(e: KeyboardEvent): void {
  if (props.disabled) return;
  const minPct = (CODE_SIDE_MIN_PX / Math.max(props.containerWidth, 1)) * 100;
  const maxPct = 100 - minPct;
  switch (e.key) {
    case 'ArrowLeft':
      commit(clamped.value + CODE_SPLIT_STEP);
      break;
    case 'ArrowRight':
      commit(clamped.value - CODE_SPLIT_STEP);
      break;
    case 'Home':
      commit(minPct);
      break;
    case 'End':
      commit(maxPct);
      break;
    case 'Enter':
      commit(CODE_SPLIT_PCT_DEFAULT);
      break;
    default:
      return;
  }
  e.preventDefault();
}
</script>

<template>
  <div
    ref="root"
    class="csp"
    :class="{ 'is-dragging': dragging, 'is-disabled': disabled }"
    role="separator"
    tabindex="0"
    :aria-orientation="'vertical'"
    :aria-valuenow="Math.round(clamped)"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-label="t('settings.codeViewer.splitPct')"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @dblclick="onDblclick"
    @keydown="onKeydown"
  >
    <span class="csp-line" />
  </div>
</template>

<style scoped>
.csp {
  position: relative;
  flex: none;
  /* 沟宽就是 5px（PRD：两纸贴合，中间只一道缝）。曾用 `margin: 0 -3px` 把命中区
     向外扩，但 .content 带 overflow:hidden——向右溢出的 3px 被裁掉，向左的 3px 又
     盖在对话纸上。实测点击点命中的是 .rightcol，拖拽完全失效。
     hover 反馈不改布局：用骑在线上的 110px 流光段（侧栏右缘同款）。 */
  width: 5px;
  z-index: 60;
  cursor: col-resize;
  background: transparent;
  outline: none;
  touch-action: none;
}
.csp-line {
  position: absolute;
  inset: 0 2px;
  background: var(--border);
}

/* 流光（侧栏右缘 / 终端顶边同款）：110px 两端渐隐柔光段骑在分隔线上，
   --seg-y 由 pointermove 写入鼠标 Y，停哪亮哪，不自动流动 */
.csp::after {
  content: '';
  position: absolute;
  left: 50%;
  top: var(--seg-y, 50%);
  width: 2px;
  height: 110px;
  transform: translate(-50%, -50%);
  border-radius: 1px;
  background: linear-gradient(180deg, transparent, color-mix(in oklab, var(--foreground) 65%, transparent) 50%, transparent);
  opacity: 0;
  transition: opacity var(--transition-fast);
  pointer-events: none;
}

.csp:hover::after,
.csp:focus-visible::after,
.csp.is-dragging::after {
  opacity: 1;
}
.csp.is-disabled {
  cursor: default;
  pointer-events: none;
}

/* 拖拽中全局压住 col-resize 并禁选中（侧栏 sidebar-resizing / 终端 term-resizing 同款） */
:global(body.csp-resizing) {
  cursor: col-resize;
  user-select: none;
}
</style>
