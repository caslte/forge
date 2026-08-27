<script setup lang="ts">
import { computed, ref } from 'vue';
import { buildSideBySideDiff, type SideBySideRow } from '@forge/core/side-by-side-diff';

const props = defineProps<{
  filePath: string | null;
  oldString: string | null;
  newString: string | null;
}>();

/** 大 diff 初始渲染行数限制，超出折叠并提供展开入口 */
const INITIAL_ROWS = 200;

const rows = computed<SideBySideRow[]>(() => buildSideBySideDiff(props.oldString, props.newString));
const truncated = ref(true);
const visibleRows = computed(() =>
  truncated.value ? rows.value.slice(0, INITIAL_ROWS) : rows.value,
);
</script>

<template>
  <div class="diff-view">
    <div v-if="filePath" class="diff-file">{{ filePath }}</div>
    <div class="diff-table" role="table">
      <div v-for="(row, i) in visibleRows" :key="i" class="diff-row" role="row">
        <pre
          v-if="row.left"
          :class="['diff-cell', `cell-${row.left.type}`]"
          role="cell"
        >{{ row.left.text }}</pre>
        <pre v-else class="diff-cell cell-empty" role="cell"></pre>
        <pre
          v-if="row.right"
          :class="['diff-cell', `cell-${row.right.type}`]"
          role="cell"
        >{{ row.right.text }}</pre>
        <pre v-else class="diff-cell cell-empty" role="cell"></pre>
      </div>
    </div>
    <button
      v-if="truncated && rows.length > INITIAL_ROWS"
      class="diff-expand"
      @click="truncated = false"
    >
      展开全部 {{ rows.length }} 行
    </button>
  </div>
</template>

<style scoped>
.diff-view {
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
}

.diff-file {
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
  background: var(--muted);
  border-bottom: 1px solid var(--border);
}

.diff-table {
  display: flex;
  flex-direction: column;
  max-height: 420px;
  overflow-y: auto;
}

.diff-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

.diff-cell {
  margin: 0;
  padding: 1px 10px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--foreground);
}

.diff-cell:first-child {
  border-right: 1px solid var(--border);
}

.cell-equal {
  background: transparent;
}

.cell-removed {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
  color: var(--destructive);
}

.cell-added {
  background: color-mix(in oklab, var(--success) 10%, transparent);
  color: var(--success);
}

.cell-empty {
  background: var(--muted);
}

.diff-expand {
  width: 100%;
  padding: 6px;
  font-size: 11px;
  color: var(--muted-foreground);
  border: none;
  border-top: 1px solid var(--border);
  background: var(--muted);
  cursor: pointer;
}

.diff-expand:hover {
  color: var(--foreground);
}
</style>
