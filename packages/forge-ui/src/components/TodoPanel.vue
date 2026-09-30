<!--
  Todo 面板（CV-S11，AC-CV-037~042，v3.63 修正）。

  数据源：`useSessionConversation().todoSnapshot`（按 sessionId 内存隔离 Map；
  切走再切回不丢视图，关闭 APP 随进程消失）。
  视觉规范与 pi TUI 端 rpiv-todo 面板同款：标题「已完成 X / 共 Y 个」+ 状态字符
  `○/●(呼吸点)/✓` + activeForm 括号 + 完成态删除线；点击头部折叠/展开（列表高度 +
  透明度过渡动画）；空快照从 DOM 卸载。

  浮窗卡片（opencode 风格）：与输入框 compose-box 同材质（同背景 + 同边框色 +
  同顶部圆角），下边沿无 border，面板底部以负 margin 塞进输入框背后，
  由输入框的上边框充当视觉底边，形成"从输入框延伸出去"的一体感。

  渲染规则（与 todoPanel.ts 纯函数同源）：
  - selectVisibleTasks 过滤 deleted 墓碑，按 (completed, in_progress, pending) + id 升序
  - shouldRenderPanel 控制可见性门（visible=0 → 整个面板卸载）
  - formatTodoRow 行格式化（pending dim / in_progress warning+accent / completed success+删除线）
  - truncateSubject 长度截断
  - 折叠状态按 sessionId 内存维护（不写 localStorage、不跨会话同步、不发 IPC）

  滚动策略（AC-CV-042，用户需求 2026-10）：
  - 有 in_progress 时：保证 in_progress 行落在 3 行可视窗口内（第 1/2/3 行都可），
    用户不用手动滚动就能看到当前在做什么
  - 无 in_progress（全部完成 / 无中状态）时：滚到最后一行，让用户看到最终状态
  - 触发时机：初次挂载 / 折叠→展开 / 布局变化（in_progress 出现/消失/换 id、任务总数变化）
  - 函数内部检查目标行是否已可视，已可视则 no-op——不抢用户手动滚动位置

  全部完成自动收起（用户需求 2026-10）：
  - visible 非空且全 completed → 停留 TODO_AUTO_COLLAPSE_DELAY_MS（看清末态 ✓ +
    数字翻滚）→ 自动折叠（复用 todo-collapse 200ms 高度+透明度动画）
    → 间隔 TODO_AUTO_HIDE_DELAY_MS → 自动隐藏（todo-panel-hide 260ms 淡出+下沉，
    播完后从 DOM 卸载，不占位）
  - 新任务到达（出现 pending/in_progress）→ 取消待触发定时器，已自动折叠的展开、
    已隐藏的重新出现（默认展开）
  - 用户手动点头部折叠/展开 → 取消待触发的自动定时器（本次快照不再自动收起，
    以手动意图为准）；折叠/隐藏状态均按 sessionId 内存隔离
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import type { Ref } from 'vue';
import {
  formatTodoRow,
  isAllCompleted,
  selectVisibleTasks,
  shouldRenderPanel,
  TODO_AUTO_COLLAPSE_DELAY_MS,
  TODO_AUTO_HIDE_DELAY_MS,
  type TodoSnapshot,
} from '../utils/todoPanel';
import { useI18n } from '../i18n/index.ts';
// 折叠 / 自动隐藏表为模块级（见 todoPanelUiState.ts 注释）：视图重建不回初值
import {
  autoFoldedSessions,
  collapsedBySession,
  dismissedBySession,
} from '../composables/todoPanelUiState.ts';

const { t } = useI18n();

const props = defineProps<{
  /** 当前会话 id；面板可见性 = 快照有 visible task（不依赖 sessionId 显式校验，
   *  因 snapshot 已按 sessionId 隔离 —— 不同会话的 snapshot 互不影响） */
  sessionId: string | null;
  /** 当前会话 todo 快照（CV-S11 主数据源） */
  todoSnapshot: TodoSnapshot | null;
}>();

/** 折叠状态表见 todoPanelUiState.ts（模块级）；当前会话折叠态 */
const collapsed = computed(() => {
  if (!props.sessionId) return false;
  return collapsedBySession.value.get(props.sessionId) ?? false;
});

/** 切会话时清理不存在的会话折叠态（防止 map 无限增长） */
watch(
  () => props.sessionId,
  (newId, oldId) => {
    if (oldId && newId !== oldId && !collapsedBySession.value.has(oldId)) {
      // 旧会话未折叠过，保留空记录（避免反复创建）
    }
  },
);
/** 可见任务（过滤 deleted + 排序） */
const visibleTasks = computed(() => selectVisibleTasks(props.todoSnapshot));
/** 标题计数（completed / total） */
const counts = computed(() => {
  const visible = visibleTasks.value;
  const completed = visible.filter((t) => t.status === 'completed').length;
  return { completed, total: visible.length };
});
/** 可见性门（visible=0 → false，面板卸载） */
const isVisible = computed(() => shouldRenderPanel(visibleTasks.value));
/** 全部完成（自动收起的触发条件：非空且全 completed） */
const allCompleted = computed(() => isAllCompleted(visibleTasks.value));
/** 自动隐藏态表见 todoPanelUiState.ts（模块级）；当前会话自动隐藏态 */
const dismissed = computed(() => {
  if (!props.sessionId) return false;
  return dismissedBySession.value.get(props.sessionId) ?? false;
});
/** 实际渲染门（含自动隐藏；离开动画由外层 todo-panel-hide Transition 承载） */
const effectiveVisible = computed(() => isVisible.value && !dismissed.value);
/** 面板头部 chevron（折叠态 ▸ / 展开态 ▾） */
const chevron = computed(() => (collapsed.value ? '▸' : '▾'));

/** autoFoldedSessions 见 todoPanelUiState.ts（模块级） */
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
let hideTimer: ReturnType<typeof setTimeout> | null = null;

function clearAutoTimers(): void {
  if (collapseTimer !== null) {
    clearTimeout(collapseTimer);
    collapseTimer = null;
  }
  if (hideTimer !== null) {
    clearTimeout(hideTimer);
    hideTimer = null;
  }
}

function setCollapsedFor(sid: string, value: boolean): void {
  const newMap = new Map(collapsedBySession.value);
  newMap.set(sid, value);
  collapsedBySession.value = newMap;
}

function setDismissedFor(sid: string, value: boolean): void {
  const newMap = new Map(dismissedBySession.value);
  newMap.set(sid, value);
  dismissedBySession.value = newMap;
}

function armHideTimer(sid: string): void {
  if (hideTimer !== null) clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    hideTimer = null;
    setDismissedFor(sid, true);
  }, TODO_AUTO_HIDE_DELAY_MS);
}

/** 切换折叠：按 sessionId 维护折叠状态；手动操作取消待触发的自动收起 */
function toggleCollapsed(): void {
  if (!props.sessionId) return;
  clearAutoTimers();
  autoFoldedSessions.delete(props.sessionId);
  const next = !collapsed.value;
  const newMap = new Map(collapsedBySession.value);
  newMap.set(props.sessionId, next);
  collapsedBySession.value = newMap;
}

/** 渲染任务行（前 50 行 + 「+N more」收口，避免超量撑爆布局） */
const MAX_RENDERED_ROWS = 50;
const renderedRows = computed(() => visibleTasks.value.slice(0, MAX_RENDERED_ROWS));
const overflowCount = computed(() => Math.max(0, visibleTasks.value.length - MAX_RENDERED_ROWS));

/** 滚动容器引用（用于保证进行中行在可视窗口内） */
const listRef = ref<HTMLElement | null>(null);

/**
 * 布局 key（in_progress 在排序后的索引 + 最后一行索引）。
 * 任意一个变动 = 可能导致可视行发生滑出/滑入，触发重新评估。
 */
function layoutKey(): string {
  const visible = visibleTasks.value;
  const inProgressIdx = visible.findIndex((t) => t.status === 'in_progress');
  const lastIdx = visible.length - 1;
  return `${inProgressIdx}:${lastIdx}`;
}

/**
 * 保证"用户应看到的目标行"在 3 行可视窗口内（AC-CV-042）：
 * - 有 in_progress → 目标行 = in_progress 所在 li
 * - 无 in_progress（全部完成） → 目标行 = 最后一个 todo-row
 * 函数内部先检查目标行是否已可视，已可视则直接返回（不抢用户手动滚动位置），
 * 不在可视则按超出方向调整 scrollTop 以使其出现。
 */
function ensureTargetRowVisible(): void {
  const list = listRef.value;
  if (!list) return;
  const visible = visibleTasks.value;
  if (visible.length === 0) return;

  let targetRow: HTMLElement | null = null;
  const inProgressTask = visible.find((t) => t.status === 'in_progress');
  if (inProgressTask) {
    targetRow = list.querySelector(`[data-testid="todo-row-${inProgressTask.id}"]`) as HTMLElement | null;
  } else {
    const rows = list.querySelectorAll('.todo-row');
    targetRow = (rows[rows.length - 1] as HTMLElement | undefined) ?? null;
  }
  if (!targetRow) return;

  const listRect = list.getBoundingClientRect();
  const rowRect = targetRow.getBoundingClientRect();
  if (rowRect.top < listRect.top) {
    list.scrollTop -= listRect.top - rowRect.top;
  } else if (rowRect.bottom > listRect.bottom) {
    list.scrollTop += rowRect.bottom - listRect.bottom;
  }
}

// 初次挂载：collapsed=true 时 ul 未挂载，下一次展开由 watch 接手
onMounted(() => {
  void nextTick(ensureTargetRowVisible);
  armAutoFoldIfNeeded();
});

onBeforeUnmount(() => {
  clearAutoTimers();
});

/**
 * 任务内容签名（id + status 序列）：任务增删/状态流转即变化，用于重估自动收起。
 * 仅用 id + status（不含 subject/activeForm），避免同态文本编辑误触发重计时。
 */
function tasksKey(): string {
  return visibleTasks.value.map((t) => `${t.id}:${t.status}`).join(',');
}

/** 按当前快照决定是否挂起自动折叠→隐藏；条件不满足则取消待触发定时器 */
function armAutoFoldIfNeeded(): void {
  const sid = props.sessionId;
  if (!sid || !isVisible.value) {
    clearAutoTimers();
    return;
  }
  if (!allCompleted.value) {
    // 新任务到达：取消自动收起，已自动折叠的展开、已隐藏的重新出现
    clearAutoTimers();
    if (dismissed.value) setDismissedFor(sid, false);
    if (autoFoldedSessions.has(sid)) {
      autoFoldedSessions.delete(sid);
      if (collapsed.value) setCollapsedFor(sid, false);
    }
    return;
  }
  // 已全部完成且已隐藏：无事可做（切回历史已收起会话时保持隐藏）
  if (dismissed.value) return;
  clearAutoTimers();
  if (collapsed.value) {
    // 用户已手动折叠：跳过折叠段，直接安排隐藏段
    armHideTimer(sid);
    return;
  }
  collapseTimer = setTimeout(() => {
    collapseTimer = null;
    // 快照可能已变化（新任务/切会话/手动折叠）：复核后再折叠
    if (props.sessionId !== sid || !isVisible.value || !allCompleted.value) return;
    if (dismissedBySession.value.get(sid) ?? false) return;
    setCollapsedFor(sid, true);
    autoFoldedSessions.add(sid);
    armHideTimer(sid);
  }, TODO_AUTO_COLLAPSE_DELAY_MS);
}

// 自动收起触发：会话切换 / 任务内容变化 / 完成态翻转 / 卸载重挂载
watch(
  () => ({
    sid: props.sessionId,
    tasks: tasksKey(),
    completed: allCompleted.value,
    baseVisible: isVisible.value,
  }),
  () => {
    armAutoFoldIfNeeded();
  },
);

// 后续触发：折叠→展开 / 布局变化（in_progress 位置或最后一行变动）
watch(
  () => ({
    visible: isVisible.value,
    collapsed: collapsed.value,
    layout: layoutKey(),
  }),
  (next, prev) => {
    if (!next.visible || next.collapsed) return;
    const becameExpanded = prev !== undefined && prev.collapsed && !next.collapsed;
    const layoutChanged = prev !== undefined && next.layout !== prev.layout;
    if (becameExpanded || layoutChanged) {
      void nextTick(ensureTargetRowVisible);
    }
  },
);

/** 暴露给父组件做断言/测试 */
defineExpose({
  collapsed,
  visibleTasks,
  isVisible,
  allCompleted,
  effectiveVisible,
});
</script>

<template>
  <Transition name="todo-panel-hide">
    <div
      v-if="effectiveVisible"
      class="todo-panel"
      :class="{ 'todo-panel-collapsed': collapsed }"
      data-testid="todo-panel"
    >
    <button
      type="button"
      class="todo-heading"
      data-testid="todo-heading"
      :aria-expanded="!collapsed"
      @click="toggleCollapsed"
    >
      <span class="todo-heading-text">{{ t('panels.todo.completedPrefix') }} <span class="roll-num" data-testid="todo-completed-num"><Transition name="num-roll"><span :key="counts.completed" class="num-val">{{ counts.completed }}</span></Transition></span>{{ t('panels.todo.totalSuffix', { total: counts.total }) }}</span>
      <span class="todo-heading-chevron" aria-hidden="true">{{ chevron }}</span>
    </button>
    <Transition name="todo-collapse">
      <ul
        v-if="!collapsed"
        ref="listRef"
        class="todo-list"
        data-testid="todo-list"
      >
        <li
          v-for="task in renderedRows"
          :key="task.id"
          class="todo-row"
          :class="`todo-row-${task.status}`"
          :data-testid="`todo-row-${task.id}`"
        >
          <span v-html="formatTodoRow(task)" />
        </li>
        <li
          v-if="overflowCount > 0"
          class="todo-overflow"
          data-testid="todo-overflow"
        >+{{ overflowCount }} more</li>
      </ul>
    </Transition>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * Todo 浮窗 = 从输入框向上延伸出的浮窗卡片（opencode 风格）。
 * 与 compose-box 同材质：同背景 + 同边框色 + 同顶部圆角 16px；
 * 下边沿无 border：面板底部以 -10px 负 margin 塞进输入框背后（输入框后渲染、
 * 背景不透明，自然盖住面板底边），由输入框的上边框充当视觉底边，形成一体延伸感。
 * 面板水平 padding 取 14px，与 compose-box 内边距对齐。
 *
 * 2026-09-30 同步输入框抬升（C 方案）：compose-box 改成 --card + --elev-1 后，
 * 面板若仍留 --background 会「面板贴着、框浮着」，接缝处出现一道色差断层；
 * 这里跟同材质一起抬，抬升投影落在面板上缘、被输入框的投影盖住，延伸感不变。
 */
.todo-panel {
  position: relative;
  z-index: 0;
  border: 1px solid var(--input);
  border-bottom: 0;
  border-radius: 16px 16px 0 0;
  background: var(--card);
  box-shadow: var(--elev-1);
  /* 底部 20px padding：给被输入框盖住的 10px 重叠区留出呼吸，避免末行文字贴边 */
  margin: 0 0 -10px;
  padding: 10px 14px 20px;
  font-size: 13px;
  line-height: 1.55;
  transition: padding 200ms ease, border-color var(--transition-fast);
}

.todo-panel-collapsed {
  padding: 6px 14px 16px;
}

.todo-heading {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: 0;
  background: transparent;
  /* 标题统一灰色 muted（无左侧状态圈，状态只看任务行图标） */
  color: var(--muted-foreground, #888);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  text-align: left;
}

.todo-heading:focus-visible {
  outline: 1px solid var(--brand-accent, currentColor);
  outline-offset: 2px;
}

.todo-heading-text {
  flex: 1;
  font-weight: 500;
}

/*
 * 已完成数翻滚动画（秒表/倒计时牌效果）：旧数字上滑出、新数字上滑入。
 * 平时 DOM 里只有一个数字节点（0-9 长条会污染文本断言，已验证不可行）；
 * 过渡 320ms 内瞬间双节点，文本断言走轮询不受影响。
 * tabular-nums 让数字等宽，翻滚时不左右抖动。
 */
.roll-num {
  position: relative;
  display: inline-block;
  height: 1lh;
  overflow: hidden;
  vertical-align: top;
  font-variant-numeric: tabular-nums;
}
.num-val {
  display: block;
  height: 1lh;
}
.num-roll-enter-active,
.num-roll-leave-active {
  transition: transform 320ms cubic-bezier(0.3, 0.7, 0.3, 1), opacity 320ms ease;
}
.num-roll-enter-from {
  transform: translateY(100%);
  opacity: 0;
}
.num-roll-leave-to {
  transform: translateY(-100%);
  opacity: 0;
}
.num-roll-leave-active {
  position: absolute;
  inset-inline: 0;
  top: 0;
}

.todo-heading-chevron {
  font-size: 11px;
  opacity: 0.7;
}

.todo-list {
  list-style: none;
  margin: 6px 0 0;
  padding: 0;
  /* 面板字小一号：标题与任务行统一 12px */
  font-size: 12px;
  /* 可视区固定 3 行高度（行高 1.55em，随字号自适应），超出内部滚动，保持界面干净；
   * max-height 同时是折叠动画的可过渡属性（auto 无法过渡） */
  max-height: calc(1.55em * 3);
  overflow-y: auto;
  /* 细滚动条：Firefox */
  scrollbar-width: thin;
  scrollbar-color: color-mix(in oklab, var(--muted-foreground, #888) 45%, transparent) transparent;
}
/* 细滚动条：Chromium（宽 3px、透明轨道、半透明圆角滑块） */
.todo-list::-webkit-scrollbar {
  width: 3px;
}
.todo-list::-webkit-scrollbar-track {
  background: transparent;
}
.todo-list::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--muted-foreground, #888) 45%, transparent);
  border-radius: 999px;
}

/* 折叠/展开动画：列表高度 + 透明度过渡（≤200ms，PRD 性能预算） */
.todo-collapse-enter-active,
.todo-collapse-leave-active {
  transition: max-height 200ms ease, opacity 180ms ease, margin 200ms ease;
  overflow: hidden;
}
.todo-collapse-enter-from,
.todo-collapse-leave-to {
  max-height: 0 !important;
  opacity: 0;
  margin-top: 0 !important;
  overflow: hidden;
}

/*
 * 全部完成自动隐藏：整块面板淡出 + 下沉 10px（沉进输入框背后）+ 高度收起，
 * 260ms 播完后从 DOM 卸载（不占位）；出现时反向淡入上浮。
 * max-height 取 120px 包住折叠态标题行（隐藏总是发生在折叠之后）。
 */
.todo-panel-hide-enter-active,
.todo-panel-hide-leave-active {
  transition: opacity 260ms ease, transform 260ms ease, max-height 260ms ease,
    padding 260ms ease, margin 260ms ease;
  overflow: hidden;
  max-height: 120px;
}
.todo-panel-hide-enter-from,
.todo-panel-hide-leave-to {
  max-height: 0 !important;
  opacity: 0;
  transform: translateY(10px);
  margin-bottom: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  overflow: hidden;
}

.todo-row {
  font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, monospace);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.todo-row :deep(.todo-glyph) {
  display: inline-block;
  width: 1.2em;
}

.todo-row :deep(.todo-glyph-pending) {
  color: var(--muted-foreground, #888);
}

.todo-row :deep(.todo-glyph-active) {
  color: var(--warning, oklch(0.75 0.16 85));
}

/* 进行中呼吸点：实心圆点做透明度 + 缩放呼吸循环 */
.todo-row :deep(.todo-glyph-breathing) {
  animation: todo-breathe 1.8s ease-in-out infinite;
}
@keyframes todo-breathe {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.3; transform: scale(0.75); }
}

.todo-row :deep(.todo-glyph-done) {
  color: var(--success, oklch(0.55 0.16 145));
}

.todo-row :deep(.todo-glyph-deleted) {
  color: var(--muted-foreground, #888);
}

/* 待办文案与上方「已完成」标题统一 muted 灰色，整块面板视觉一致 */
.todo-row :deep(.todo-subject) {
  color: var(--muted-foreground, #888);
}

.todo-row :deep(.todo-subject-active) {
  /* 用户裁定：正常灰色字（muted），不用绿色/深色；
   * 状态只看呼吸点 + 括号里的 activeForm */
  color: var(--muted-foreground, #888);
}

.todo-row :deep(.todo-subject-done) {
  color: var(--muted-foreground, #888);
  text-decoration: line-through;
}

.todo-row :deep(.todo-subject-deleted) {
  color: var(--muted-foreground, #888);
  text-decoration: line-through;
}

.todo-row :deep(.todo-active-form) {
  color: var(--muted-foreground, #888);
  margin-left: 4px;
}

.todo-overflow {
  color: var(--muted-foreground, #888);
  font-size: 12px;
  padding-left: 1.2em;
}

@media (prefers-reduced-motion: reduce) {
  .todo-panel,
  .todo-collapse-enter-active,
  .todo-collapse-leave-active,
  .todo-panel-hide-enter-active,
  .todo-panel-hide-leave-active {
    transition: none;
  }
  .num-roll-enter-active,
  .num-roll-leave-active {
    transition: none;
  }
  .todo-row :deep(.todo-glyph-breathing) {
    animation: none;
  }
}
</style>