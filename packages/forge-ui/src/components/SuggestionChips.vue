<script setup lang="ts">
/**
 * suggest_next_steps 芯片行（docs/plan/suggest-next-steps.md）。
 *
 * 数据源 = tool 消息的 input.steps（I1：从 tool call 派生，无独立事件通道）。
 * 点击 = 直接发送该文本（决策 A），并本地移除该芯片防误触重发（I5）。
 * 仅 completed 状态渲染（I4），started 半成品参数不显示。
 */
import { computed, ref } from 'vue';
import type { ConversationMessage } from '../types';

const props = defineProps<{
  msg: ConversationMessage;
}>();

const emit = defineEmits<{
  (e: 'pick', text: string): void;
}>();

const visible = computed<string[]>(() => {
  if (props.msg.status !== 'completed') return [];
  const raw = props.msg.input?.steps;
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((s): s is string => typeof s === 'string')
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .slice(0, 3);
});

/** 本实例已点击过的建议（组件重挂载即复位，见契约 I5） */
const picked = ref<Set<string>>(new Set());

function onPick(step: string): void {
  if (picked.value.has(step)) return;
  picked.value = new Set(picked.value).add(step);
  emit('pick', step);
}
</script>

<template>
  <div v-if="visible.length > 0" class="suggest-chips">
    <button
      v-for="step in visible"
      :key="step"
      class="suggest-chip"
      :class="{ picked: picked.has(step) }"
      :disabled="picked.has(step)"
      @click="onPick(step)"
    >
      <svg
        class="sc-arrow"
        width="14"
        height="14"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      ><path d="M8 4v7a4 4 0 0 0 4 4h8" /><polyline points="16.5 11.5 20 15 16.5 18.5" /></svg>
      <span class="sc-text">{{ step }}</span>
    </button>
  </div>
</template>

<style scoped>
.suggest-chips {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  min-width: 0;
  max-width: 100%;
}

.suggest-chip {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  max-width: 100%;
  padding: 5px 12px 6px;
  margin-left: -12px;
  border-radius: 9px;
  border: none;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 13px;
  line-height: 1.5;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.suggest-chip:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
}

/* 描线箭头（下折右转）：14px，首行垂直居中（行高 19.5 ≈ 13×1.5，偏移 (19.5-14)/2≈3px） */
.sc-arrow {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  margin-top: 3px;
  color: var(--muted-foreground);
}

/* 长句换行不撑破（中英文双字宽验收点） */
.sc-text {
  min-width: 0;
  overflow-wrap: break-word;
}

.suggest-chip.picked {
  display: none;
}
</style>
