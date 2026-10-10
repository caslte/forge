<script setup lang="ts">
/**
 * 目标模式状态徽标（goal 接入，2026-10-10）。
 *
 * 解决的问题：pi-goal 跑起来后会持续汇报状态（进行中 / 等待 / 暂停 / 受阻 / 额度用尽 /
 * 预算用尽 / 已完成）与用量（已自动轮次 / 上限、token 预算）。接入前 forge 没给扩展
 * 真实 UI，这些信息被 pi 的 `noOpUIContext.setStatus` 空实现全部吞掉 —— 用户完全不知道
 * 目标在不在跑、烧了多少轮。本徽标是该信息在 UI 上的唯一出口。
 *
 * 设计要点：
 * - **无目标时不渲染**（v-if），不占底栏空间。
 * - 「需用户介入」的终局（受阻 / 额度用尽 / 预算用尽）用警示色 + 标题，
 *   不能只靠颜色区分（无障碍）。
 * - 悬浮显示 pi-goal 原文（`view.raw`），避免二次加工丢信息。
 * - 纯展示，不发命令：暂停/恢复等操作走输入框斜杠命令（`/goal pause`），
 *   由 pi-goal 自己处理，避免在 UI 里复制一套状态机。
 */
import { computed } from 'vue';
import { parseGoalStatus, goalStateNeedsUser, type GoalBadgeView } from '../utils/goalStatus';

const props = defineProps<{
  /** pi-goal 的紧凑状态串原文；null/空串表示无目标（不渲染） */
  statusText: string | null;
}>();

/** 解析结果；null 表示无目标 */
const view = computed<GoalBadgeView | null>(() => parseGoalStatus(props.statusText));
/** 是否为需要用户介入的终局（决定警示样式） */
const needsUser = computed(() => goalStateNeedsUser(view.value));
</script>

<template>
  <span
    v-if="view"
    class="goal-badge"
    :class="[`is-${view.state}`, { 'needs-user': needsUser }]"
    :title="view.raw"
  >
    <span class="dot" aria-hidden="true"></span>
    <span class="label">{{ view.label }}</span>
    <span v-if="view.turnLabel" class="turns">{{ view.turnLabel }}</span>
    <span v-if="view.budgetLabel" class="budget">{{ view.budgetLabel }}</span>
  </span>
</template>

<style scoped>
/* 形态对齐 BranchBadge 的 .meta-link pill：同一底栏内视觉同族 */
.goal-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  padding: 0 8px;
  border-radius: 11px;
  font-size: 12px;
  line-height: 1;
  white-space: nowrap;
  border: 1px solid var(--border-tertiary, rgba(0, 0, 0, 0.15));
  background: var(--bg-secondary, #f7f7f5);
  color: var(--text-secondary, #5f5e5a);
}

.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: currentColor;
  flex: none;
}

/* 进行中：主色 + 呼吸感（与「已停」形态一眼可辨） */
.is-active {
  color: var(--accent, #534ab7);
  border-color: var(--accent-border, rgba(83, 74, 183, 0.35));
}
.is-active .dot {
  animation: goal-pulse 1.6s ease-in-out infinite;
}

@keyframes goal-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.35; }
}
@media (prefers-reduced-motion: reduce) {
  .is-active .dot { animation: none; }
}

.label { font-weight: 500; }

/* 轮次 / 预算：次要信息，弱化 */
.turns,
.budget {
  color: var(--text-tertiary, #888780);
  font-variant-numeric: tabular-nums;
}

/* 等待中：中性偏蓝 */
.is-waiting { color: #185fa5; border-color: rgba(24, 95, 165, 0.3); }

/* 已暂停 / 已完成：灰 */
.is-paused,
.is-complete { color: #5f5e5a; }
.is-paused .dot,
.is-complete .dot { opacity: 0.5; }

/* 需用户介入的三种终局：警示色 + 加粗边框。
   不只靠颜色区分——文本本身已表达状态（受阻/额度用尽/预算用尽）。 */
.needs-user {
  color: #a32d2d;
  border-color: rgba(163, 45, 45, 0.45);
  background: rgba(163, 45, 45, 0.06);
  font-weight: 500;
}

/* 未知形态：虚线边框提示「这是原样透传的，不保证解读正确」 */
.is-unknown {
  border-style: dashed;
}
</style>
