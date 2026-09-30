<script setup lang="ts">
/**
 * 改动文件汇总卡片（每轮 AI 回复末尾）。
 *
 * 数据源：本轮成功的 edit/write 工具入参聚合（useChangedFiles.collectTurnChangedFiles）。
 * 交互：头部折叠/展开（默认折叠，状态不持久化）；点击文件行内联展开该文件 diff
 * （行间互斥，再点收起）；edit 多 hunk 逐块渲染（hunk i/n 标签分隔），单 hunk 不显示头部条。
 */
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import type { ChangedFileEntry, ChangedFileSummary } from '../composables/useChangedFiles';
import { useI18n } from '../i18n/index.ts';
import { collapseDotSegments } from '../utils/pathSegments.ts';
import DiffView from './DiffView.vue';

const { t } = useI18n();

const props = defineProps<{
  summary: ChangedFileSummary;
  /** 会话项目根路径（绝对路径剥前缀转相对展示；空/不匹配按原路径展示） */
  projectPath?: string;
}>();

/** 默认折叠（用户确认）；组件实例随稳定 key 存活，无需父级管理 */
const collapsed = ref(true);
/** 当前展开 diff 的文件（按 path 唯一）；null = 全部收起 */
const expandedPath = ref<string | null>(null);
/** 右键菜单：目标文件 path（null=收起）+ 视口坐标 */
const contextMenuPath = ref<string | null>(null);
const contextMenuX = ref(0);
const contextMenuY = ref(0);
const contextMenuRef = ref<HTMLElement | null>(null);

const files = computed(() => props.summary.files);

/** 路径展示：归一 \ → / 后剥项目根前缀 */
function relPath(path: string): string {
  const p = path.replace(/\\/g, '/');
  const root = props.projectPath?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
  if (root !== '' && p.startsWith(root + '/')) return p.slice(root.length + 1);
  return p;
}

/** 把工具入参 path 规整为绝对路径：相对路径则拼项目根前缀；空 / 已是绝对 → 原样返回。
 *  已 normalize 为正斜杠（useChangedFiles.parseFileToolInput），无需再替换 \\；
 *  折叠 . / .. 中间段——工具入参 ./x 常见，ShellExecuteEx 不归一这种段（见 pathSegments.ts） */
function absoluteFilePath(p: string): string {
  const looksAbsolute = p.startsWith('/') || /^[a-zA-Z]:\//.test(p);
  if (looksAbsolute) return collapseDotSegments(p);
  const root = props.projectPath?.replace(/\\/g, '/').replace(/\/+$/, '') ?? '';
  return root !== '' ? collapseDotSegments(`${root}/${p}`) : p;
}

/** 取正斜杠路径的目录部分；根目录 / 单段名原样返回（让 openPath 自己失败即可） */
function dirOf(p: string): string {
  const i = p.lastIndexOf('/');
  return i > 0 ? p.slice(0, i) : p;
}

function toggleRow(path: string): void {
  expandedPath.value = expandedPath.value === path ? null : path;
}

/** 可交给「用浏览器打开」的扩展名：仅 .html/.htm。与主进程 shell/openTarget.ts
 *  的白名单同口径；主进程才是「能不能开」的最终裁决者，这里只决定菜单项显不显示。 */
const BROWSER_OPEN_EXT = /\.html?$/i;

/** 当前右键目标是否展示「用浏览器打开」 */
const contextMenuIsHtml = computed(() => {
  const p = contextMenuPath.value;
  return p !== null && BROWSER_OPEN_EXT.test(p.trim());
});

function onRowContextMenu(file: ChangedFileEntry, ev: MouseEvent): void {
  ev.preventDefault();
  contextMenuPath.value = file.path;
  // 视口边界保护：菜单宽 ~160，单项高 ~30 + 容器内边距 8；html 行多一项，菜单高 ~70
  const w = 168;
  const h = BROWSER_OPEN_EXT.test(file.path.trim()) ? 72 : 38;
  contextMenuX.value = Math.max(8, Math.min(ev.clientX, window.innerWidth - w - 8));
  contextMenuY.value = Math.max(8, Math.min(ev.clientY, window.innerHeight - h - 8));
}

function closeContextMenu(): void {
  contextMenuPath.value = null;
}

function onContextMenuOpenDir(): void {
  const filePath = contextMenuPath.value;
  closeContextMenu();
  if (!filePath) return;
  const dir = dirOf(absoluteFilePath(filePath));
  void window.forge.shell.openPath(dir);
}

/** 用系统默认浏览器打开该文件本体（不是目录）。绝对路径同样先折叠 ./ 中间段——
 *  与 openPath 同款：ShellExecuteEx 不归一中间段会弹「找不到文件」。 */
function onContextMenuOpenInBrowser(): void {
  const filePath = contextMenuPath.value;
  closeContextMenu();
  if (!filePath) return;
  void window.forge.shell.openInBrowser(absoluteFilePath(filePath));
}

function onDocumentClick(ev: MouseEvent): void {
  if (contextMenuPath.value === null) return;
  const menuEl = contextMenuRef.value;
  const target = ev.target as Node | null;
  if (menuEl && target && menuEl.contains(target)) return;
  closeContextMenu();
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape' && contextMenuPath.value !== null) closeContextMenu();
}

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeydown);
});
</script>

<template>
  <div class="changed-files" :class="{ collapsed }">
    <button class="cf-head" @click="collapsed = !collapsed">
      <svg class="cf-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2.5h-7a2 2 0 0 0-2 2v15a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-11z" /><path d="M14 2.5v6h6.5" /></svg>
      <span class="cf-count">{{ t('tool.changedFilesCount', { n: files.length }) }}</span>
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
            @contextmenu.prevent="onRowContextMenu(file, $event)"
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
                :highlight-path="file.path"
                :old-string="part.oldText"
                :new-string="part.newText"
              />
            </template>
          </div>
        </template>
      </div>
    </div>
  </div>

  <!-- 文件右键菜单：Teleport 到 body，避免被卡片 overflow / stacking 裁剪遮挡 -->
  <Teleport to="body">
    <div
      v-if="contextMenuPath !== null"
      ref="contextMenuRef"
      class="cf-context-menu"
      :style="{ left: contextMenuX + 'px', top: contextMenuY + 'px' }"
      @click.stop
      @contextmenu.prevent
    >
      <button v-if="contextMenuIsHtml" type="button" class="cf-context-menu-item" @click="onContextMenuOpenInBrowser">
        <svg class="cf-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" />
          <path d="M2 12h20" />
        </svg>
        {{ t('tool.openInBrowser') }}
      </button>
      <button type="button" class="cf-context-menu-item" @click="onContextMenuOpenDir">
        <svg class="cf-context-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
        </svg>
        {{ t('tool.openContainingDir') }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.changed-files {
  align-self: flex-start;
  width: 100%;
  max-width: 100%;
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

/* 文件右键菜单：Teleport 到 body，避免被卡片 overflow 裁剪；样式沿用 project-action-menu 视觉 */
.cf-context-menu {
  position: fixed;
  z-index: 1000;
  min-width: 160px;
  padding: 4px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.cf-context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}

.cf-context-menu-item:hover {
  background: var(--muted);
  color: var(--foreground);
}

.cf-context-menu-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
