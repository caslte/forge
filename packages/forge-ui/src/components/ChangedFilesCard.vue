<script setup lang="ts">
/**
 * 改动文件汇总卡片（每轮 AI 回复末尾）。
 *
 * 数据源：本轮成功的 edit/write 工具入参聚合（useChangedFiles.collectTurnChangedFiles）。
 * 交互：头部折叠/展开（默认折叠，状态不持久化）；点击文件行内联展开该文件 diff
 * （行间互斥，再点收起）；edit 多 hunk 逐块渲染（hunk i/n 标签分隔），单 hunk 不显示头部条。
 */
import { computed, ref } from 'vue';
import type { ChangedFileSummary } from '../composables/useChangedFiles';
import DiffView from './DiffView.vue';

const props = defineProps<{
  summary: ChangedFileSummary;
  /** 会话项目根路径（绝对路径剥前缀转相对展示；空/不匹配按原路径展示） */
  projectPath?: string;
}>();

/** 默认折叠（用户确认）；组件实例随稳定 key 存活，无需父级管理 */
const collapsed = ref(true);
/** 当前展开 diff 的文件（按 path 唯一）；null = 全部收起 */
const expandedPath = ref<string | null>(null);

const files = computed(() => props.summary.files);

/** 路径展示：归一 \ → / 后剥项目根前缀 */
function relPath(path: string): string {
  const p = path.replace(/\\/g, '/');
  const root = props.projectPath?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
  if (root !== '' && p.startsWith(root + '/')) return p.slice(root.length + 1);
  return p;
}

function toggleRow(path: string): void {
  expandedPath.value = expandedPath.value === path ? null : path;
}
</script>

<template>
  <div class="changed-files" :class="{ collapsed }">
    <button class="cf-head" @click="collapsed = !collapsed">
      <svg class="cf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2.5h-7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-11z" /><path d="M14 2.5v6h6.5" /></svg>
      <span class="cf-count">{{ files.length }} 个文件已更改</span>
      <span class="cf-spacer"></span>
      <span class="cf-total">
        <span class="cf-add">+{{ summary.totalAdded }}</span>
        <span class="cf-del">-{{ summary.totalRemoved }}</span>
      </span>
      <svg class="cf-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9" /></svg>
    </button>
    <div class="cf-body-shell">
      <div class="cf-body">
        <template v-for="file in files" :key="file.path">
          <button
            :class="['cf-row', { expanded: expandedPath === file.path }]"
            @click="toggleRow(file.path)"
          >
            <svg class="cf-row-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2.5h-7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-11z" /><path d="M14 2.5v6h6.5" /></svg>
            <span class="cf-name">{{ file.name }}</span>
            <span class="cf-path">{{ relPath(file.path) }}</span>
            <span class="cf-total">
              <span class="cf-add">+{{ file.added }}</span>
              <span class="cf-del">-{{ file.removed }}</span>
            </span>
          </button>
          <div v-if="expandedPath === file.path" class="cf-diff-wrap">
            <template v-for="(part, i) in file.parts" :key="i">
              <span v-if="file.parts.length > 1" class="hunk-tag">hunk {{ i + 1 }}/{{ file.parts.length }}</span>
              <DiffView
                :file-path="file.parts.length > 1 ? `hunk ${i + 1}/${file.parts.length}` : null"
                :old-string="part.oldText"
                :new-string="part.newText"
              />
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.changed-files {
  align-self: flex-start;
  max-width: 94%;
  min-width: 0;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--card);
  box-shadow: var(--shadow-sm);
  overflow: hidden;
}

.cf-head {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 10px 13px;
  font-size: 12.5px;
  color: var(--foreground);
  border: none;
  background: transparent;
  cursor: pointer;
  user-select: none;
  text-align: left;
}

.cf-head:hover {
  background: var(--muted);
}

.cf-icon {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  color: var(--muted-foreground);
}

.cf-count {
  font-weight: 600;
  white-space: nowrap;
}

.cf-spacer {
  flex: 1;
  min-width: 0;
}

.cf-total {
  font-family: var(--font-mono);
  font-size: 12px;
  white-space: nowrap;
  flex-shrink: 0;
}

.cf-add {
  color: var(--success);
  font-weight: 600;
}

.cf-del {
  color: var(--destructive);
  font-weight: 600;
  margin-left: 6px;
}

.cf-chevron {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--muted-foreground);
  transition: transform 0.2s;
}

.changed-files.collapsed .cf-chevron {
  transform: rotate(-90deg);
}

.cf-body-shell {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 200ms cubic-bezier(0.4, 0, 0.2, 1);
  overflow: hidden;
}

.changed-files.collapsed .cf-body-shell {
  grid-template-rows: 0fr;
}

.cf-body {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.cf-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 13px;
  font-family: var(--font-mono);
  font-size: 12px;
  border: none;
  border-top: 1px solid var(--border);
  background: transparent;
  cursor: pointer;
  user-select: none;
  text-align: left;
  transition: background 0.12s;
}

.cf-row:hover {
  background: var(--muted);
}

.cf-row.expanded {
  background: color-mix(in oklab, var(--brand-accent) 7%, transparent);
}

.cf-row-icon {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
  color: var(--muted-foreground);
}

.cf-name {
  color: var(--foreground);
  font-weight: 600;
  white-space: nowrap;
  flex-shrink: 0;
}

.cf-path {
  color: var(--muted-foreground);
  font-size: 11px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cf-diff-wrap {
  border-top: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 40%, transparent);
  padding: 8px 10px 10px 26px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.hunk-tag {
  align-self: flex-start;
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 8px;
  background: var(--card);
}
</style>
