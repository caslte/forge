<script setup lang="ts">
import { computed, ref } from 'vue';
import {
  buildSideBySideDiff,
  detectDiffLanguage,
  highlightDiffLine,
  type SideBySideRow,
} from '@forge/core/side-by-side-diff';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  filePath: string | null;
  oldString: string | null;
  newString: string | null;
  /** 真实文件路径（多 hunk/汇总卡片展示头为 hunk 标签时仍能识别语言；缺省回退 filePath） */
  highlightPath?: string | null;
}>();

/** 大 diff 初始渲染行数限制，超出折叠并提供展开入口 */
const INITIAL_ROWS = 200;

const rows = computed<SideBySideRow[]>(() => buildSideBySideDiff(props.oldString, props.newString));
const truncated = ref(true);
const visibleRows = computed(() =>
  truncated.value ? rows.value.slice(0, INITIAL_ROWS) : rows.value,
);

/** 按文件扩展名识别高亮语言（hunk 标签等无扩展名时为 undefined，走纯文本） */
const language = computed(() => detectDiffLanguage(props.highlightPath ?? props.filePath));

/** 可见行先截断再逐行高亮（大 diff 只高亮首屏 200 行，避免初始化卡顿） */
const highlightedRows = computed(() =>
  visibleRows.value.map((row) => ({
    left: row.left
      ? { ...row.left, html: highlightDiffLine(row.left.text, language.value) }
      : null,
    right: row.right
      ? { ...row.right, html: highlightDiffLine(row.right.text, language.value) }
      : null,
  })),
);
</script>

<template>
  <div class="diff-view">
    <div v-if="filePath" class="diff-file">{{ filePath }}</div>
    <div class="diff-table" role="table">
      <div v-for="(row, i) in highlightedRows" :key="i" class="diff-row" role="row">
        <span class="diff-num" role="rowheader">{{ row.left ? row.left.line : '' }}</span>
        <pre
          v-if="row.left"
          :class="['diff-cell', `cell-${row.left.type}`]"
          role="cell"
          v-html="row.left.html"
        ></pre>
        <pre v-else class="diff-cell cell-empty" role="cell"></pre>
        <span class="diff-num" role="rowheader">{{ row.right ? row.right.line : '' }}</span>
        <pre
          v-if="row.right"
          :class="['diff-cell', `cell-${row.right.type}`]"
          role="cell"
          v-html="row.right.html"
        ></pre>
        <pre v-else class="diff-cell cell-empty" role="cell"></pre>
      </div>
    </div>
    <button
      v-if="truncated && rows.length > INITIAL_ROWS"
      class="diff-expand"
      @click="truncated = false"
    >
      {{ t('tool.diffExpandAll', { n: rows.length }) }}
    </button>
  </div>
</template>

<style scoped>
.diff-view {
  border-radius: 8px;
  overflow: hidden;
  /* body 全局禁选，diff 内容单独放开（与 .msg-content 同理）：支持鼠标框选复制 */
  user-select: text;
}

.diff-file {
  padding: 6px 10px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
  background: var(--muted);
}

.diff-table {
  display: flex;
  flex-direction: column;
  max-height: 420px;
  overflow-y: auto;
}

.diff-row {
  display: grid;
  grid-template-columns: 30px minmax(0, 1fr) 30px minmax(0, 1fr);
}

/* 行号列（旧/新文件行号独立计数，空侧不留号） */
.diff-num {
  padding: 1px 6px;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.55;
  text-align: right;
  color: var(--muted-foreground);
  opacity: 0.65;
  background: color-mix(in oklab, var(--muted) 45%, transparent);
  user-select: none;
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

.diff-cell:nth-child(2) {
  border-right: 1px solid var(--border);
}

.cell-equal {
  background: transparent;
}

/* 增删行只染背景不强制字色，语法 token 颜色才能透出来；纯文本行沿用默认前景色 */
.cell-removed {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
}

.cell-added {
  background: color-mix(in oklab, var(--success) 10%, transparent);
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
  user-select: none;
}

.diff-expand:hover {
  color: var(--foreground);
}
</style>

<!-- hljs token 主题（非 scoped：v-html 内容无 scoped 属性；light/dark 双主题，GitHub  palette 微调，保证在增删 tint 背景上可读） -->
<style>
.diff-view .hljs-comment,
.diff-view .hljs-quote {
  /* 与 CodeViewer 同规：注释不斜体（中文合成倾斜不可读） */
  color: #6e7781;
}
.diff-view .hljs-keyword,
.diff-view .hljs-selector-tag,
.diff-view .hljs-doctag,
.diff-view .hljs-template-tag {
  color: #cf222e;
}
.diff-view .hljs-string,
.diff-view .hljs-regexp,
.diff-view .hljs-meta .hljs-string {
  color: #0e7a3d;
}
.diff-view .hljs-number,
.diff-view .hljs-literal {
  color: #0550ae;
}
.diff-view .hljs-title,
.diff-view .hljs-title.function_,
.diff-view .hljs-section {
  color: #8250df;
}
.diff-view .hljs-attr,
.diff-view .hljs-attribute,
.diff-view .hljs-variable,
.diff-view .hljs-template-variable {
  color: #0550ae;
}
.diff-view .hljs-tag,
.diff-view .hljs-name,
.diff-view .hljs-selector-id,
.diff-view .hljs-selector-class {
  color: #116329;
}
.diff-view .hljs-type,
.diff-view .hljs-class .hljs-title,
.diff-view .hljs-built_in {
  color: #953800;
}
.diff-view .hljs-meta,
.diff-view .hljs-operator {
  color: #0550ae;
}

:root[data-theme='dark'] .diff-view .hljs-comment,
:root[data-theme='dark'] .diff-view .hljs-quote {
  color: #8b949e;
}
:root[data-theme='dark'] .diff-view .hljs-keyword,
:root[data-theme='dark'] .diff-view .hljs-selector-tag,
:root[data-theme='dark'] .diff-view .hljs-doctag,
:root[data-theme='dark'] .diff-view .hljs-template-tag {
  color: #ff7b72;
}
:root[data-theme='dark'] .diff-view .hljs-string,
:root[data-theme='dark'] .diff-view .hljs-regexp,
:root[data-theme='dark'] .diff-view .hljs-meta .hljs-string {
  color: #a5d6ff;
}
:root[data-theme='dark'] .diff-view .hljs-number,
:root[data-theme='dark'] .diff-view .hljs-literal,
:root[data-theme='dark'] .diff-view .hljs-attr,
:root[data-theme='dark'] .diff-view .hljs-attribute,
:root[data-theme='dark'] .diff-view .hljs-variable,
:root[data-theme='dark'] .diff-view .hljs-template-variable,
:root[data-theme='dark'] .diff-view .hljs-meta,
:root[data-theme='dark'] .diff-view .hljs-operator {
  color: #79c0ff;
}
:root[data-theme='dark'] .diff-view .hljs-title,
:root[data-theme='dark'] .diff-view .hljs-title.function_,
:root[data-theme='dark'] .diff-view .hljs-section {
  color: #d2a8ff;
}
:root[data-theme='dark'] .diff-view .hljs-tag,
:root[data-theme='dark'] .diff-view .hljs-name,
:root[data-theme='dark'] .diff-view .hljs-selector-id,
:root[data-theme='dark'] .diff-view .hljs-selector-class {
  color: #7ee787;
}
:root[data-theme='dark'] .diff-view .hljs-type,
:root[data-theme='dark'] .diff-view .hljs-class .hljs-title,
:root[data-theme='dark'] .diff-view .hljs-built_in {
  color: #ffa657;
}
</style>
