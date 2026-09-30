<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import type { ProjectItem, SessionItem, SessionStatus } from '../types';
import { sortSessionsByActivation, projectTagOf } from '../utils/sessionView';
import { useI18n, type MessageKey } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  projects: ProjectItem[];
  sessions: SessionItem[];
  currentProjectPath: string | null;
  currentSessionId: string | null;
  /** 已在多窗口画布上打开的会话 id 列表（用于标记灰态，不可重复拖入） */
  openedSessionIds?: string[];
  /** 会话列表视角（SM-S06）：project=按项目分组（现状）；task=平摊全部会话 */
  view?: 'project' | 'task';
}>();

const emit = defineEmits<{
  (e: 'select-project', path: string): void;
  (e: 'remove-project', path: string): void;
  (e: 'clear-sessions', path: string): void;
  (e: 'rename-project', path: string, alias: string): void;
  (e: 'create-session', projectPath?: string): void;
  (e: 'select-session', id: string): void;
  (e: 'delete-session', id: string): void;
  (e: 'rename-session', id: string, alias: string): void;
  (e: 'reorder-project', paths: string[]): void;
  (e: 'fold-state', allCollapsed: boolean): void;
}>();

const VISIBLE_SESSION_LIMIT = 5;

// 折叠状态：记录“已折叠”的项目路径，未在集合中的默认展开（含新增项目）
const collapsedPaths = ref<Set<string>>(
  new Set(props.projects.filter((p) => p.expanded === false).map((p) => p.path)),
);
// 会话列表是否已“展开全部”（超过 5 条时）
const expandedSessionLists = ref<Set<string>>(new Set());

// 项目右键 / ⋯ 菜单
const menuOpenPath = ref<string | null>(null);
const menuX = ref(0);
const menuY = ref(0);
const menuRef = ref<HTMLElement | null>(null);

// 项目重命名（inline input）
const renamingProjectPath = ref<string | null>(null);
const renameProjectValue = ref('');

// 会话重命名（inline input）
const renamingSessionId = ref<string | null>(null);
const renameSessionValue = ref('');

// 会话删除两阶段确认
const deleteConfirmId = ref<string | null>(null);
let deleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

// 项目删除两阶段确认（菜单内）
const projectDeleteConfirmPath = ref<string | null>(null);
let projectDeleteConfirmTimer: ReturnType<typeof setTimeout> | null = null;

// 清理所有会话两阶段确认（菜单内；确认文案与删除独立，避免语义混淆）
const clearSessionsConfirmPath = ref<string | null>(null);
let clearSessionsConfirmTimer: ReturnType<typeof setTimeout> | null = null;

// 项目拖拽排序：视觉反馈 + 落点（before/after）
const draggedPath = ref<string | null>(null);
const dragOverPath = ref<string | null>(null);
const dragOverPos = ref<'before' | 'after' | null>(null);

const statusTitleMap: Record<SessionStatus, MessageKey> = {
  idle: 'project.statusIdle',
  streaming: 'project.statusStreaming',
  error: 'project.statusError',
  done: 'project.statusDone',
};

type StatusTone = 'streaming' | 'error' | 'done' | 'none';

function projectDisplayName(p: ProjectItem): string {
  if (p.alias) return p.alias;
  const segs = p.path.split(/[\\/]/);
  const last = segs[segs.length - 1];
  return last || p.path;
}

function sessionDisplayName(s: SessionItem): string {
  return s.alias || t('project.sessionName', { id: s.sessionId.slice(-6) });
}

// 激活顺序（最近激活在前）：会话进入 streaming 时置顶并**保留**，完成后不回退到后端原序
const activatedOrder = ref<string[]>([]);

watch(
  () => props.sessions,
  (sessions) => {
    const running = sessions.filter((s) => s.status === 'streaming').map((s) => s.sessionId);
    if (!running.length) return;
    activatedOrder.value = [...running, ...activatedOrder.value.filter((id) => !running.includes(id))];
  },
  { immediate: true },
);

function sessionsOf(path: string): SessionItem[] {
  // 按激活顺序排（最近激活在前）；从未激活过的保持后端原序（sort 稳定）
  return sortSessionsByActivation(
    props.sessions.filter((s) => s.projectPath === path),
    activatedOrder.value,
  );
}

// ===== 任务视角（SM-S06）：平摊全部会话，排序规则与项目视角一致 =====
const isTaskView = computed(() => props.view === 'task');
const allSessionsSorted = computed(() =>
  sortSessionsByActivation(props.sessions, activatedOrder.value),
);

// 任务视角截断：默认显示前 20 条（同排序规则），多余折叠，交互同项目视角「展开显示 N 个」
const TASK_VISIBLE_LIMIT = 20;
const taskExpanded = ref(false);
const visibleTaskSessions = computed(() =>
  taskExpanded.value ? allSessionsSorted.value : allSessionsSorted.value.slice(0, TASK_VISIBLE_LIMIT),
);
const hiddenTaskCount = computed(() =>
  Math.max(0, allSessionsSorted.value.length - TASK_VISIBLE_LIMIT),
);

function taskProjectTag(s: SessionItem): string {
  return projectTagOf(s.projectPath, props.projects);
}

// ===== 收起全部/展开全部（仅项目视角；两态判定 nextFoldAllAction 见 sessionView） =====
const allCollapsed = computed(() =>
  props.projects.length > 0 && props.projects.every((p) => collapsedPaths.value.has(p.path)),
);

watch(allCollapsed, (v) => emit('fold-state', v), { immediate: true });

function collapseAll(): void {
  collapsedPaths.value = new Set(props.projects.map((p) => p.path));
  // 顺手把每个项目里已"展开显示 N 个"的会话列表也恢复到默认截断（VISIBLE_SESSION_LIMIT 条），
  // 否则用户收起全部后再单独展开某个项目，会话会保持之前的全量展开态——与"收起"语义不符。
  expandedSessionLists.value = new Set();
}

function expandAll(): void {
  collapsedPaths.value = new Set();
}

defineExpose({ collapseAll, expandAll });

function visibleSessions(path: string): SessionItem[] {
  const all = sessionsOf(path);
  if (expandedSessionLists.value.has(path)) return all;
  return all.slice(0, VISIBLE_SESSION_LIMIT);
}

function hiddenSessionCount(path: string): number {
  return Math.max(0, sessionsOf(path).length - VISIBLE_SESSION_LIMIT);
}

function shouldShowDot(s: SessionItem): boolean {
  // 空闲不显示
  if (s.status === 'idle') return false;
  // 已完成：完成结果未读才显示绿点（已读落盘在 forge-store 的 doneReadAt，
  // 跨窗口/重启一致；新一轮完成时后端把 doneReadAt 清回 null → 重新提示）
  if (s.status === 'done') {
    return !s.doneReadAt;
  }
  // 运行中/错误总是显示——选中态与否一致（运行中状态点需始终可见，与列表高亮解耦）
  return true;
}

function sessionTone(s: SessionItem): StatusTone {
  return s.status as StatusTone;
}

function statusTitle(s: SessionItem): string {
  return t(statusTitleMap[s.status]);
}

function isExpanded(path: string): boolean {
  return !collapsedPaths.value.has(path);
}

function toggleExpand(path: string): void {
  const next = new Set(collapsedPaths.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  collapsedPaths.value = next;
}

function toggleSessionListExpand(path: string): void {
  const next = new Set(expandedSessionLists.value);
  if (next.has(path)) next.delete(path);
  else next.add(path);
  expandedSessionLists.value = next;
}

function selectProject(path: string): void {
  emit('select-project', path);
}

function selectSession(id: string): void {
  // 已读标记由 App 统一处理（session/markSessionRead 落盘，含正查看时完成的场景）
  emit('select-session', id);
}

// create-session 携带项目 path（v3.38）：App 端归属优先用载荷，不再依赖 select-project 先行
function onCreateSession(p: ProjectItem): void {
  emit('select-project', p.path);
  if (collapsedPaths.value.has(p.path)) {
    const next = new Set(collapsedPaths.value);
    next.delete(p.path);
    collapsedPaths.value = next;
  }
  emit('create-session', p.path);
}

// 会话删除：首次点击进入确认态（按钮变红“确认”），3 秒内再次点击才真删除
function handleDeleteSessionClick(s: SessionItem): void {
  if (deleteConfirmId.value === s.sessionId) {
    clearDeleteConfirmTimer();
    deleteConfirmId.value = null;
    emit('delete-session', s.sessionId);
    return;
  }
  clearDeleteConfirmTimer();
  deleteConfirmId.value = s.sessionId;
  deleteConfirmTimer = setTimeout(() => {
    deleteConfirmId.value = null;
  }, 3000);
}

function clearDeleteConfirmTimer(): void {
  if (deleteConfirmTimer) {
    clearTimeout(deleteConfirmTimer);
    deleteConfirmTimer = null;
  }
}

function openProjectMenu(p: ProjectItem, ev: MouseEvent): void {
  menuOpenPath.value = p.path;
  const w = 184;
  const h = 184;
  menuX.value = Math.max(8, Math.min(ev.clientX, window.innerWidth - w - 8));
  menuY.value = Math.max(8, Math.min(ev.clientY, window.innerHeight - h - 8));
  clearProjectDeleteTimer();
  projectDeleteConfirmPath.value = null;
  clearClearSessionsTimer();
  clearSessionsConfirmPath.value = null;
}

function closeMenu(): void {
  menuOpenPath.value = null;
  clearProjectDeleteTimer();
  projectDeleteConfirmPath.value = null;
  clearClearSessionsTimer();
  clearSessionsConfirmPath.value = null;
}

function clearProjectDeleteTimer(): void {
  if (projectDeleteConfirmTimer) {
    clearTimeout(projectDeleteConfirmTimer);
    projectDeleteConfirmTimer = null;
  }
}

function clearClearSessionsTimer(): void {
  if (clearSessionsConfirmTimer) {
    clearTimeout(clearSessionsConfirmTimer);
    clearSessionsConfirmTimer = null;
  }
}

function startRenameProject(p: ProjectItem): void {
  renamingProjectPath.value = p.path;
  renameProjectValue.value = p.alias ?? '';
}

function commitRenameProject(): void {
  const path = renamingProjectPath.value;
  if (path === null) return;
  const val = renameProjectValue.value.trim();
  if (val) emit('rename-project', path, val);
  renamingProjectPath.value = null;
  renameProjectValue.value = '';
}

function cancelRenameProject(): void {
  renamingProjectPath.value = null;
  renameProjectValue.value = '';
}

function startRenameSession(s: SessionItem): void {
  renamingSessionId.value = s.sessionId;
  renameSessionValue.value = s.alias ?? '';
}

function commitRenameSession(): void {
  const id = renamingSessionId.value;
  if (id === null) return;
  const val = renameSessionValue.value.trim();
  if (val) emit('rename-session', id, val);
  renamingSessionId.value = null;
  renameSessionValue.value = '';
}

function cancelRenameSession(): void {
  renamingSessionId.value = null;
  renameSessionValue.value = '';
}

// 项目删除两阶段：首次点击菜单项变红“确认删除”，3 秒内再次点击才 emit
function requestDeleteProject(p: ProjectItem): void {
  if (projectDeleteConfirmPath.value === p.path) {
    clearProjectDeleteTimer();
    projectDeleteConfirmPath.value = null;
    closeMenu();
    emit('remove-project', p.path);
    return;
  }
  clearProjectDeleteTimer();
  projectDeleteConfirmPath.value = p.path;
  projectDeleteConfirmTimer = setTimeout(() => {
    projectDeleteConfirmPath.value = null;
  }, 3000);
}

function onMenuOpenDir(): void {
  const path = menuOpenPath.value;
  closeMenu();
  if (path) void window.forge.shell.openPath(path);
}

// 清理所有会话两阶段：首次点击菜单项变红“确认清理”，3 秒内再次点击才 emit
function onMenuClearSessions(): void {
  const path = menuOpenPath.value;
  if (!path) return;
  if (clearSessionsConfirmPath.value === path) {
    clearClearSessionsTimer();
    clearSessionsConfirmPath.value = null;
    closeMenu();
    emit('clear-sessions', path);
    return;
  }
  clearClearSessionsTimer();
  clearSessionsConfirmPath.value = path;
  clearSessionsConfirmTimer = setTimeout(() => {
    clearSessionsConfirmPath.value = null;
  }, 3000);
}

function onMenuRename(): void {
  const path = menuOpenPath.value;
  if (!path) return;
  const project = props.projects.find((p) => p.path === path);
  closeMenu();
  if (project) startRenameProject(project);
}

function onMenuDelete(): void {
  const path = menuOpenPath.value;
  if (!path) return;
  const project = props.projects.find((p) => p.path === path);
  if (project) requestDeleteProject(project);
}

// 项目拖拽排序：记录拖拽源；指针在目标节点上半部=插入其前，下半部=其后
function onProjectDragStart(p: ProjectItem): void {
  draggedPath.value = p.path;
}

/** 会话是否已在多窗口画布上（标记灰态，不可再拖入） */
function isOnCanvas(session: SessionItem): boolean {
  return props.openedSessionIds?.includes(session.sessionId) ?? false;
}

/** 会话拖拽到多窗口画布：在 dataTransfer 记录 sessionId（需阻止冒泡，避免触发项目重排） */
function onSessionDragStart(e: DragEvent, s: SessionItem): void {
  e.stopPropagation();
  if (e.dataTransfer) {
    e.dataTransfer.setData('text/forge-session', s.sessionId);
    e.dataTransfer.effectAllowed = 'copy';
  }
}

function onProjectDragOver(ev: DragEvent, p: ProjectItem): void {
  if (!draggedPath.value || draggedPath.value === p.path) return;
  ev.preventDefault();
  const rect = (ev.currentTarget as HTMLElement).getBoundingClientRect();
  dragOverPath.value = p.path;
  dragOverPos.value = ev.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
}

function onProjectDragLeave(p: ProjectItem): void {
  if (dragOverPath.value === p.path) {
    dragOverPath.value = null;
    dragOverPos.value = null;
  }
}

/** 目标节点上放下：把拖拽项目移动到目标前/后，发射新顺序（全量） */
function onProjectDrop(ev: DragEvent, p: ProjectItem): void {
  ev.preventDefault();
  const from = draggedPath.value;
  const to = p.path;
  const pos = dragOverPos.value;
  resetProjectDrag();
  if (!from || from === to || !pos) return;
  const order = reorderCurrentList(from, to, pos);
  if (order !== null) emit('reorder-project', order);
}

/** 容器空白处放下：拖拽项目移到列表末尾 */
function onSectionDrop(ev: DragEvent): void {
  ev.preventDefault();
  const from = draggedPath.value;
  resetProjectDrag();
  if (!from) return;
  const order = props.projects.map((p) => p.path).filter((p) => p !== from);
  order.push(from);
  if (order.length === props.projects.length) emit('reorder-project', order);
}

function onSectionDragOver(ev: DragEvent): void {
  if (!draggedPath.value) return;
  ev.preventDefault();
}

/** 按目标位置计算新全量顺序；顺序未变化（拖到原位）返回 null */
function reorderCurrentList(from: string, to: string, pos: 'before' | 'after'): string[] | null {
  const cur = props.projects.map((p) => p.path);
  const fromIdx = cur.indexOf(from);
  const toIdx = cur.indexOf(to);
  if (fromIdx === -1 || toIdx === -1) return null;
  const next = cur.filter((p) => p !== from);
  const insertAt = next.indexOf(to) + (pos === 'after' ? 1 : 0);
  next.splice(insertAt, 0, from);
  return next.join('|') === cur.join('|') ? null : next;
}

function resetProjectDrag(): void {
  draggedPath.value = null;
  dragOverPath.value = null;
  dragOverPos.value = null;
}

function onProjectDragEnd(): void {
  resetProjectDrag();
}

function focusAndSelect(el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLInputElement) {
    el.focus();
    el.select();
  }
}

function onDocumentClick(ev: MouseEvent): void {
  if (menuOpenPath.value === null) return;
  const target = ev.target as Node | null;
  const menuEl = menuRef.value;
  if (menuEl && target && menuEl.contains(target)) return;
  closeMenu();
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key !== 'Escape') return;
  if (menuOpenPath.value) closeMenu();
  if (renamingProjectPath.value) cancelRenameProject();
  if (renamingSessionId.value) cancelRenameSession();
}

function onWindowScroll(): void {
  if (menuOpenPath.value) closeMenu();
}

// 滚动上下沿渐隐：仅当该方向还有溢出内容时才显示对应渐变遮罩
const treeRoot = ref<HTMLElement | null>(null);
const fadeTop = ref(false);
const fadeBottom = ref(false);

function updateTreeFade(): void {
  const el = treeRoot.value;
  if (!el) return;
  fadeTop.value = el.scrollTop > 1;
  fadeBottom.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

let fadeObserver: ResizeObserver | null = null;
function observeTreeFadeSource(): void {
  const el = treeRoot.value;
  if (!el) return;
  fadeObserver?.disconnect();
  // 观察容器自身（尺寸变化）与内容节点（增删/折叠动画导致的高度变化）
  fadeObserver = new ResizeObserver(updateTreeFade);
  fadeObserver.observe(el);
  if (el.firstElementChild) fadeObserver.observe(el.firstElementChild);
  updateTreeFade();
}

watch(
  () => [props.projects, props.sessions, taskExpanded.value],
  () => nextTick(observeTreeFadeSource),
  { deep: true }
);

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('scroll', onWindowScroll, true);
  window.addEventListener('resize', updateTreeFade);
  observeTreeFadeSource();
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('scroll', onWindowScroll, true);
  window.removeEventListener('resize', updateTreeFade);
  fadeObserver?.disconnect();
  fadeObserver = null;
  clearDeleteConfirmTimer();
  clearProjectDeleteTimer();
  clearClearSessionsTimer();
});
</script>

<template>
  <div
    ref="treeRoot"
    class="project-tree"
    :class="{ 'fade-t': fadeTop, 'fade-b': fadeBottom }"
    @scroll="updateTreeFade"
  >
    <!-- 任务视角（SM-S06）：平摊全部会话，行尾项目 tag，排序与项目视角同规则 -->
    <template v-if="isTaskView">
      <div v-if="allSessionsSorted.length === 0" class="tree-empty tree-empty-centered">{{ t('project.noSessions') }}</div>
      <div v-else class="tree-section task">
        <div
          v-for="session in visibleTaskSessions"
          :key="session.sessionId"
          class="tree-session"
          :class="{
            active: currentSessionId === session.sessionId,
            'on-canvas': isOnCanvas(session),
            'non-draggable': isOnCanvas(session),
          }"
          :draggable="!isOnCanvas(session)"
          @click="selectSession(session.sessionId)"
          @dragstart="onSessionDragStart($event, session)"
        >
          <span
            class="tree-session-status-dot"
            :class="[`tone-${sessionTone(session)}`, { 'is-blank': !shouldShowDot(session) }]"
            :title="shouldShowDot(session) ? statusTitle(session) : ''"
            aria-hidden="true"
          >
            <span class="dot-matrix"><i v-for="n in 8" :key="n" /></span>
            <svg
              v-if="session.status === 'done'"
              class="dot-check"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
            >
              <polyline points="20 6 9 17 4 12" />
            </svg>
            <span v-if="session.status === 'error'" class="dot-bang">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                <line x1="12" y1="8" x2="12" y2="13" />
                <line x1="12" y1="16.5" x2="12" y2="17.5" />
              </svg>
            </span>
          </span>

          <div class="tree-node-main">
            <input
              v-if="renamingSessionId === session.sessionId"
              :ref="focusAndSelect"
              v-model="renameSessionValue"
              class="tree-rename-input"
              type="text"
              :placeholder="t('project.sessionAlias')"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent="commitRenameSession()"
              @keydown.esc.prevent="cancelRenameSession()"
              @blur="commitRenameSession()"
            />
            <div
              v-else
              class="tree-session-title"
              :title="sessionDisplayName(session)"
              @dblclick.stop="startRenameSession(session)"
            >{{ sessionDisplayName(session) }}</div>
            <span v-if="isOnCanvas(session)" class="session-oncanvas-tag">{{ t('project.openedOnCanvas') }}</span>
          </div>

          <span class="tree-session-proj-tag" :title="session.projectPath">{{ taskProjectTag(session) }}</span>

          <div class="tree-node-actions">
            <button
              type="button"
              class="tree-icon-button danger"
              :class="{ 'confirm-mode': deleteConfirmId === session.sessionId }"
              :aria-label="deleteConfirmId === session.sessionId ? t('project.confirmDelete') : t('project.deleteSession')"
              :data-tooltip="deleteConfirmId === session.sessionId ? t('project.confirmDelete') : t('project.deleteSession')"
              @click.stop="handleDeleteSessionClick(session)"
            >
              <span v-if="deleteConfirmId === session.sessionId" class="confirm-text">{{ t('common.confirm') }}</span>
              <svg
                v-else
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
              >
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        </div>

        <button
          v-if="hiddenTaskCount > 0"
          type="button"
          class="tree-session-toggle"
          @click.stop="taskExpanded = !taskExpanded"
        >
          {{ taskExpanded ? t('project.collapseDisplay') : t('project.expandDisplay', { count: hiddenTaskCount }) }}
        </button>
      </div>
    </template>

    <!-- 项目视角（现状）：按项目分组 -->
    <template v-else>
      <div v-if="projects.length === 0" class="tree-empty tree-empty-centered">{{ t('project.noProjects') }}</div>

    <div v-else class="tree-section" @dragover="onSectionDragOver" @drop="onSectionDrop">
      <div
        v-for="project in projects"
        :key="project.path"
        class="tree-node"
        :class="{
          'drag-over-before': dragOverPath === project.path && dragOverPos === 'before',
          'drag-over-after': dragOverPath === project.path && dragOverPos === 'after',
          dragging: draggedPath === project.path,
        }"
        draggable="true"
        @dragstart="onProjectDragStart(project)"
        @dragover="onProjectDragOver($event, project)"
        @dragleave="onProjectDragLeave(project)"
        @drop="onProjectDrop($event, project)"
        @dragend="onProjectDragEnd"
      >
        <div
          class="tree-project"
          :class="{ active: currentProjectPath === project.path }"
          @click="selectProject(project.path)"
          @contextmenu.prevent="openProjectMenu(project, $event)"
        >
          <button
            type="button"
            class="tree-arrow"
            :aria-label="isExpanded(project.path) ? t('project.collapseProject') : t('project.expandProject')"
            @click.stop="toggleExpand(project.path)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path v-if="isExpanded(project.path)" d="m6 14 1.5-2.9A2 2 0 0 1 9.24 10H20a2 2 0 0 1 1.94 2.5l-1.54 6a2 2 0 0 1-1.95 1.5H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H18a2 2 0 0 1 2 2v2" />
              <path v-else d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </button>

          <div class="tree-node-main">
            <input
              v-if="renamingProjectPath === project.path"
              :ref="focusAndSelect"
              v-model="renameProjectValue"
              class="tree-rename-input"
              type="text"
              :placeholder="t('project.projectAlias')"
              @click.stop
              @dblclick.stop
              @keydown.enter.prevent="commitRenameProject()"
              @keydown.esc.prevent="cancelRenameProject()"
              @blur="commitRenameProject()"
            />
            <div
              v-else
              class="tree-node-title"
              :title="project.path"
              @click.stop="toggleExpand(project.path)"
            >{{ projectDisplayName(project) }}</div>
          </div>

          <div class="tree-node-actions">
            <button
              type="button"
              class="tree-icon-button"
              :aria-label="t('project.newSession')"
              :data-tooltip="t('project.newSession')"
              @click.stop="onCreateSession(project)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
            </button>
            <button
              type="button"
              class="tree-icon-button project-more-trigger"
              :class="{ active: menuOpenPath === project.path }"
              :aria-label="t('project.moreActions')"
              :data-tooltip="t('project.moreActions')"
              @click.stop="openProjectMenu(project, $event)"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <circle cx="5" cy="12" r="1" />
                <circle cx="12" cy="12" r="1" />
                <circle cx="19" cy="12" r="1" />
              </svg>
            </button>
          </div>
        </div>

        <div class="tree-session-group" :class="{ 'is-collapsed': !isExpanded(project.path) }">
          <div class="tree-session-list">
            <div
              v-for="session in visibleSessions(project.path)"
              :key="session.sessionId"
              class="tree-session"
              :class="{
                active: currentSessionId === session.sessionId,
                'on-canvas': isOnCanvas(session),
                'non-draggable': isOnCanvas(session),
              }"
              :draggable="!isOnCanvas(session)"
              @click="selectSession(session.sessionId)"
              @dragstart="onSessionDragStart($event, session)"
            >
              <span
                class="tree-session-status-dot"
                :class="[`tone-${sessionTone(session)}`, { 'is-blank': !shouldShowDot(session) }]"
                :title="shouldShowDot(session) ? statusTitle(session) : ''"
                aria-hidden="true"
              >
                <span class="dot-matrix"><i v-for="n in 8" :key="n" /></span>
                <svg
                  v-if="session.status === 'done'"
                  class="dot-check"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  stroke-width="3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                >
                  <polyline points="20 6 9 17 4 12" />
                </svg>
                <span v-if="session.status === 'error'" class="dot-bang">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
                    <line x1="12" y1="8" x2="12" y2="13" />
                    <line x1="12" y1="16.5" x2="12" y2="17.5" />
                  </svg>
                </span>
              </span>

              <div class="tree-node-main">
                <input
                  v-if="renamingSessionId === session.sessionId"
                  :ref="focusAndSelect"
                  v-model="renameSessionValue"
                  class="tree-rename-input"
                  type="text"
                  :placeholder="t('project.sessionAlias')"
                  @click.stop
                  @dblclick.stop
                  @keydown.enter.prevent="commitRenameSession()"
                  @keydown.esc.prevent="cancelRenameSession()"
                  @blur="commitRenameSession()"
                />
                <div
                  v-else
                  class="tree-session-title"
                  :title="sessionDisplayName(session)"
                  @dblclick.stop="startRenameSession(session)"
                >{{ sessionDisplayName(session) }}</div>
                <span v-if="isOnCanvas(session)" class="session-oncanvas-tag">{{ t('project.openedOnCanvas') }}</span>
              </div>

              <div class="tree-node-actions">
                <button
                  type="button"
                  class="tree-icon-button danger"
                  :class="{ 'confirm-mode': deleteConfirmId === session.sessionId }"
                  :aria-label="deleteConfirmId === session.sessionId ? t('project.confirmDelete') : t('project.deleteSession')"
                  :data-tooltip="deleteConfirmId === session.sessionId ? t('project.confirmDelete') : t('project.deleteSession')"
                  @click.stop="handleDeleteSessionClick(session)"
                >
                  <span v-if="deleteConfirmId === session.sessionId" class="confirm-text">{{ t('common.confirm') }}</span>
                  <svg
                    v-else
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="2"
                    stroke-linecap="round"
                    stroke-linejoin="round"
                    aria-hidden="true"
                  >
                    <polyline points="3 6 5 6 21 6" />
                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                  </svg>
                </button>
              </div>
            </div>

            <button
              v-if="hiddenSessionCount(project.path) > 0"
              type="button"
              class="tree-session-toggle"
              @click.stop="toggleSessionListExpand(project.path)"
            >
              {{ expandedSessionLists.has(project.path) ? t('project.collapseDisplay') : t('project.expandDisplay', { count: hiddenSessionCount(project.path) }) }}
            </button>
            <div v-else-if="sessionsOf(project.path).length === 0" class="tree-empty tree-empty-inline">
              {{ t('project.noSessions') }}
            </div>
          </div>
        </div>
      </div>
    </div>
    </template>

    <!-- 项目操作菜单：Teleport 到 body，避免被 sidebar overflow/stacking 裁剪遮挡 -->
    <Teleport to="body">
      <div
        v-if="menuOpenPath"
        ref="menuRef"
        class="project-action-menu"
        :style="{ left: menuX + 'px', top: menuY + 'px' }"
        @click.stop
        @contextmenu.prevent
      >
        <button type="button" class="project-action-menu-item" @click="onMenuOpenDir">
          <svg class="project-action-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          {{ t('project.openProjectDir') }}
        </button>
        <button type="button" class="project-action-menu-item" @click="onMenuRename">
          <svg class="project-action-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          {{ t('project.rename') }}
        </button>
        <button
          type="button"
          class="project-action-menu-item danger"
          :class="{ confirming: clearSessionsConfirmPath === menuOpenPath }"
          @click="onMenuClearSessions"
        >
          <svg class="project-action-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            <line x1="10" y1="11" x2="10" y2="17" />
            <line x1="14" y1="11" x2="14" y2="17" />
          </svg>
          {{ clearSessionsConfirmPath === menuOpenPath ? t('project.confirmClear') : t('project.clearSessions') }}
        </button>
        <button
          type="button"
          class="project-action-menu-item danger"
          :class="{ confirming: projectDeleteConfirmPath === menuOpenPath }"
          @click="onMenuDelete"
        >
          <svg class="project-action-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          {{ projectDeleteConfirmPath === menuOpenPath ? t('project.confirmDelete') : t('project.deleteProject') }}
        </button>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.project-tree {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow-y: auto;
  /* 与侧栏上方「项目/任务」切换、下方「设置」保持固定间距（含渐隐区） */
  margin: 6px 0;
  --edge-fade: 28px;
  --fade-top: 0px;
  --fade-bottom: 0px;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--fade-top),
    #000 calc(100% - var(--fade-bottom)),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 var(--fade-top),
    #000 calc(100% - var(--fade-bottom)),
    transparent 100%
  );
}

.project-tree.fade-t {
  --fade-top: var(--edge-fade);
}

.project-tree.fade-b {
  --fade-bottom: var(--edge-fade);
}

.project-tree::-webkit-scrollbar {
  width: 3px;
}

.project-tree::-webkit-scrollbar-thumb {
  background: color-mix(in oklab, var(--foreground) 8%, transparent);
  border-radius: 999px;
}

.project-tree::-webkit-scrollbar-thumb:hover {
  background: color-mix(in oklab, var(--foreground) 14%, transparent);
}

.tree-section {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.tree-section.task {
  margin: 2px 8px 0 12px;
}

.tree-node {
  display: flex;
  flex-direction: column;
  position: relative;
}

.tree-node.drag-over-before::before {
  content: '';
  position: absolute;
  top: -2px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--brand);
  border-radius: 2px;
  z-index: 1;
}

.tree-node.drag-over-after::after {
  content: '';
  position: absolute;
  bottom: -2px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--brand);
  border-radius: 2px;
  z-index: 1;
}

.tree-node.dragging {
  opacity: 0.5;
}

.tree-project {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 8px;
  padding: 4px 12px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  color: color-mix(in oklab, var(--foreground) 80%, var(--muted-foreground));
  transition: background var(--transition-fast);
  min-width: 0;
}

.tree-project:hover {
  background: var(--muted);
}

/* 项目选中不再使用背景色（仅 hover 有底色），避免与会话选中态视觉打架 */

.tree-arrow {
  width: 16px;
  height: 16px;
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  transition: color var(--transition-fast);
}

.tree-arrow:hover {
  border-color: transparent;
  background: transparent;
  color: var(--foreground);
}

.tree-arrow svg {
  width: 15px;
  height: 15px;
}

.tree-node-main {
  min-width: 0;
  flex: 1;
  display: flex;
  align-items: center;
  gap: 2px;
}

.tree-node-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 14px;
  color: inherit;
}

.tree-session-title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: inherit;
}

.tree-rename-input {
  width: 100%;
  min-width: 0;
  flex: 1;
  padding: 2px 6px;
  font-size: 13px;
  border-radius: var(--radius-sm);
}

.tree-node-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  margin-left: auto;
  opacity: 0;
  pointer-events: none;
  transition: opacity var(--transition-fast);
}

.tree-project:hover .tree-node-actions,
.tree-session:hover .tree-node-actions {
  opacity: 1;
  pointer-events: auto;
}

.tree-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 24px;
  height: 24px;
  padding: 0 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--background);
  color: var(--muted-foreground);
  font-size: 11px;
  line-height: 1;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.tree-icon-button:hover {
  border-color: var(--brand);
  background: var(--background);
  color: var(--brand);
}

.tree-icon-button svg {
  width: 12px;
  height: 12px;
  flex: 0 0 auto;
}

.tree-icon-button.danger {
  border-color: color-mix(in oklab, var(--destructive) 22%, var(--border));
  background: color-mix(in oklab, var(--destructive) 8%, var(--background));
  color: var(--destructive);
}

.tree-icon-button.danger:hover {
  background: var(--destructive);
  color: #fff;
  border-color: var(--destructive);
}

.tree-icon-button.danger.confirm-mode {
  background: var(--destructive);
  color: #fff;
  border-color: var(--destructive);
  font-weight: 500;
  padding: 0 8px;
  min-width: 44px;
}

.tree-icon-button.danger.confirm-mode:hover {
  background: color-mix(in oklab, var(--destructive) 85%, black);
}

.tree-icon-button.project-more-trigger.active {
  background: var(--muted);
  color: var(--foreground);
  border-color: var(--border);
}

.confirm-text {
  font-size: 11px;
  white-space: nowrap;
}

.tree-session-group {
  margin: 2px 8px 0 12px;
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows var(--transition-base);
  overflow: hidden;
}

.tree-session-group.is-collapsed {
  grid-template-rows: 0fr;
}

.tree-session-list {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.tree-session {
  position: relative;
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 2px 12px 2px 24px;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--muted-foreground);
  min-width: 0;
}

.tree-session.active {
  color: var(--foreground);
}

/* hover 高亮时文字恢复常规黑色 */
.tree-session:hover {
  color: var(--foreground);
}

/* hover 高亮走 ::before 伪元素做「从内向外微延展」（prototypes/session-hover-demo.html 方案 C）：
   文字/圆点静止，只有背景胶囊缓出铺满，列表零位移；
   720→950ms、幅度 0.93→0.88（横向每侧约 17px），用户实机持续要更慢更大 */
.tree-session::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  border-radius: var(--radius-md);
  background: var(--surface-hover);
  opacity: 0;
  transform: scale(0.88);
  transition:
    opacity 950ms cubic-bezier(0.22, 1, 0.36, 1),
    transform 950ms cubic-bezier(0.22, 1, 0.36, 1);
}
.tree-session:hover::before {
  opacity: 1;
  transform: scale(1);
}
.tree-session.active::before {
  background: var(--surface-active);
  opacity: 1;
  transform: scale(1);
}
/* 行内容盖在高亮层之上 */
.tree-session > * {
  position: relative;
  z-index: 1;
}

/* 已在多窗口画布上：置灰、去交互 */
.tree-session.on-canvas {
  opacity: 0.45;
  cursor: default;
}
.tree-session.on-canvas::before {
  display: none;
}
.session-oncanvas-tag {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 10px;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  padding: 1px 6px;
}

/* 任务视角行尾项目 tag（SM-S06） */
.tree-session-proj-tag {
  flex: 0 0 auto;
  max-width: 88px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 7px;
  background: color-mix(in oklab, var(--muted) 30%, transparent);
}

/* 状态槽位：12×12 的固定尺寸框（比 8px 圆点大，给运行中动画留余量）。
   关键：不参与行的 flex 流——绝对定位落进行左侧 24px 留白里，
   标题完全回到改动前的 24px 起始位置，图标一列也固定在同一 x 上。 */
.tree-session > .tree-session-status-dot {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  z-index: 1;
  width: 12px;
  height: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.tree-session-status-dot.is-blank {
  visibility: hidden;
}

/* ===== 运行中：2×4 盲文点阵，斜向波依次点亮（VS Code 资源管理器语汇）=====
   动得明确——不靠颜色也能读出「进行中」，且纯 CSS 不占主线程。
   点阵只在 streaming 下显形；其余三态走各自字形（见下）。
   扫过色取 --status-run-rest / --status-run-peak 两枚令牌（深浅两套值，
   浅底用暗点扫、深底用亮点扫——详见 design-tokens.css 处的说明）。 */
.dot-matrix {
  display: none;
  grid-template-columns: repeat(2, 2.3px);
  grid-auto-rows: 2.3px;
  /* 4 行 + 3 间隙 = 11.75px，刚好收在 12px 槽位内 */
  gap: 0.85px;
  place-content: center;
  align-items: center;
  justify-items: center;
}

.tree-session-status-dot.tone-streaming .dot-matrix {
  display: grid;
}

.dot-matrix i {
  width: 2.3px;
  height: 2.3px;
  border-radius: 999px;
  background-color: var(--status-run-rest);
  transform: scale(0.72);
  animation: tree-status-wave 1.6s ease-in-out infinite;
}

/* grid 行优先排列：odd = 左列 r0..r3，even = 右列 r0..r3；
   右列延后半拍 → 波形自左上向右下扫过。
   1.6s 周期 + 0.15s 步进：1.05s 版本用户嫌快，波形糊成一片闪烁；放缓后能看清「一个点从左上走到右下」 */
.dot-matrix i:nth-child(1) { animation-delay: 0s; }
.dot-matrix i:nth-child(3) { animation-delay: 0.15s; }
.dot-matrix i:nth-child(5) { animation-delay: 0.3s; }
.dot-matrix i:nth-child(7) { animation-delay: 0.45s; }
.dot-matrix i:nth-child(2) { animation-delay: 0.075s; }
.dot-matrix i:nth-child(4) { animation-delay: 0.225s; }
.dot-matrix i:nth-child(6) { animation-delay: 0.375s; }
.dot-matrix i:nth-child(8) { animation-delay: 0.525s; }

/* 峰值处同时切色 + 放大：background-color 在两枚令牌解析出的实色之间插值，
   浅色主题里就是一个暗点扫过淡点阵（而不是同色相的「深一档」——那个在白底上拉不开）。
   18% 达峰 / 45% 回落：亮点停留占大头，1.6s 周期才看得出方向而不是在闪。 */
@keyframes tree-status-wave {
  0%,
  45%,
  100% {
    background-color: var(--status-run-rest);
    transform: scale(0.72);
  }
  18% {
    background-color: var(--status-run-peak);
    transform: scale(1);
  }
}

/* ===== 已完成（未读）：Feather check =====
   路径是仓库现成的那一段（SettingsPanel .swatch-check / GitCommitDialog / MessageCard /
   HtmlCanvasBlock / selectionPopover.ts 五处同款），不手搓「两条 div 转 ±45°」——
   那种画法两臂接缝对不齐，缩到 1× 就是个歪的「人」字。
   stroke-width 取 3（与 .swatch-check 同款：24 网格缩到 12px 时 2 偏细）；
   描边走 currentColor，深浅主题自动跟随。 */
.dot-check {
  display: none;
  width: 12px;
  height: 12px;
  color: var(--success);
}

.tree-session-status-dot.tone-done .dot-check {
  display: block;
}

/* ===== 出错：11px 圆角方块 + 白色感叹号 =====
   底板用 CSS 画方块（正方形无形变风险，不值得为它上 SVG），里面的「!」用描边路径，
   与对勾同档 3px。红色只给需用户处理的错误（CV-ERR-01 口径），常显、静止。 */
.dot-bang {
  display: none;
  position: relative;
  width: 11px;
  height: 11px;
  border-radius: 3px;
  background: var(--destructive);
  color: #fff;
}

.tree-session-status-dot.tone-error .dot-bang {
  display: block;
}

.dot-bang svg {
  position: absolute;
  inset: 1.5px;
  width: calc(100% - 3px);
  height: calc(100% - 3px);
}

/* 降级：系统要求减少动效时，运行中退回静态点，取扫过色（两个主题下都醒目），语义不丢。
   已完成/出错本就是静止字形，不受此影响。 */
@media (prefers-reduced-motion: reduce) {
  .dot-matrix i {
    animation: none;
  }
  .tree-session-status-dot.tone-streaming .dot-matrix {
    display: none;
  }
  .tree-session-status-dot.tone-streaming::after {
    content: '';
    display: block;
    width: 8px;
    height: 8px;
    border-radius: 999px;
    background: var(--status-run-peak);
  }
}

.tree-session-toggle {
  width: 100%;
  margin-top: 2px;
  padding: 4px 12px 4px 24px;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: color var(--transition-fast);
}

.tree-session-toggle:hover {
  background: transparent;
  border-color: transparent;
  color: var(--foreground);
}

.tree-empty {
  color: var(--muted-foreground);
  font-size: 12px;
}

.tree-empty-inline {
  padding: 6px 12px 6px 24px;
}

.tree-empty-centered {
  padding: 24px 12px;
  text-align: center;
}

.project-action-menu {
  position: fixed;
  z-index: 1000;
  min-width: 180px;
  padding: 4px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.project-action-menu-item {
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

.project-action-menu-item:hover {
  background: var(--muted);
  border-color: transparent;
  color: var(--foreground);
}

.project-action-menu-item.danger {
  color: var(--destructive);
}

.project-action-menu-item.danger:hover {
  background: color-mix(in oklab, var(--destructive) 10%, transparent);
  color: var(--destructive);
  border-color: transparent;
}

.project-action-menu-item.danger.confirming {
  background: var(--destructive);
  color: #fff;
  font-weight: 600;
}

.project-action-menu-item.danger.confirming:hover {
  background: color-mix(in oklab, var(--destructive) 85%, black);
  color: #fff;
}

.project-action-menu-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
