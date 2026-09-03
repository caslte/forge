<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import type { ProjectItem, SessionItem, SessionStatus } from '../types';
import { sortSessionsByActivation, projectTagOf } from '../utils/sessionView';

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
  (e: 'rename-project', path: string, alias: string): void;
  (e: 'create-session'): void;
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

// 项目拖拽排序：视觉反馈 + 落点（before/after）
const draggedPath = ref<string | null>(null);
const dragOverPath = ref<string | null>(null);
const dragOverPos = ref<'before' | 'after' | null>(null);

const statusTitleMap: Record<SessionStatus, string> = {
  idle: '空闲',
  streaming: '运行中',
  error: '出错',
  done: '已完成',
};

type StatusTone = 'streaming' | 'error' | 'done' | 'none';

function projectDisplayName(p: ProjectItem): string {
  if (p.alias) return p.alias;
  const segs = p.path.split(/[\\/]/);
  const last = segs[segs.length - 1];
  return last || p.path;
}

function sessionDisplayName(s: SessionItem): string {
  return s.alias || '会话 ' + s.sessionId.slice(-6);
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
  return statusTitleMap[s.status];
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

// create-session 事件无 path 载荷，先 select-project 让父端知道目标项目，再展开本面板
function onCreateSession(p: ProjectItem): void {
  emit('select-project', p.path);
  if (collapsedPaths.value.has(p.path)) {
    const next = new Set(collapsedPaths.value);
    next.delete(p.path);
    collapsedPaths.value = next;
  }
  emit('create-session');
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
  const h = 96;
  menuX.value = Math.max(8, Math.min(ev.clientX, window.innerWidth - w - 8));
  menuY.value = Math.max(8, Math.min(ev.clientY, window.innerHeight - h - 8));
  clearProjectDeleteTimer();
  projectDeleteConfirmPath.value = null;
}

function closeMenu(): void {
  menuOpenPath.value = null;
  clearProjectDeleteTimer();
  projectDeleteConfirmPath.value = null;
}

function clearProjectDeleteTimer(): void {
  if (projectDeleteConfirmTimer) {
    clearTimeout(projectDeleteConfirmTimer);
    projectDeleteConfirmTimer = null;
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

onMounted(() => {
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('scroll', onWindowScroll, true);
});

onUnmounted(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('scroll', onWindowScroll, true);
  clearDeleteConfirmTimer();
  clearProjectDeleteTimer();
});
</script>

<template>
  <div class="project-tree">
    <!-- 任务视角（SM-S06）：平摊全部会话，行尾项目 tag，排序与项目视角同规则 -->
    <template v-if="isTaskView">
      <div v-if="allSessionsSorted.length === 0" class="tree-empty tree-empty-centered">暂无会话</div>
      <div v-else class="tree-section">
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
            v-if="shouldShowDot(session)"
            class="tree-session-status-dot"
            :class="`tone-${sessionTone(session)}`"
            :title="statusTitle(session)"
            aria-hidden="true"
          ></span>

          <div class="tree-node-main">
            <input
              v-if="renamingSessionId === session.sessionId"
              :ref="focusAndSelect"
              v-model="renameSessionValue"
              class="tree-rename-input"
              type="text"
              placeholder="会话别名"
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
            <span v-if="isOnCanvas(session)" class="session-oncanvas-tag">已开窗</span>
          </div>

          <span class="tree-session-proj-tag" :title="session.projectPath">{{ taskProjectTag(session) }}</span>

          <div class="tree-node-actions">
            <button
              type="button"
              class="tree-icon-button danger"
              :class="{ 'confirm-mode': deleteConfirmId === session.sessionId }"
              :aria-label="deleteConfirmId === session.sessionId ? '确认删除' : '删除会话'"
              :data-tooltip="deleteConfirmId === session.sessionId ? '确认删除' : '删除会话'"
              @click.stop="handleDeleteSessionClick(session)"
            >
              <span v-if="deleteConfirmId === session.sessionId" class="confirm-text">确认</span>
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
          {{ taskExpanded ? '折叠显示' : `展开显示 ${hiddenTaskCount} 个` }}
        </button>
      </div>
    </template>

    <!-- 项目视角（现状）：按项目分组 -->
    <template v-else>
      <div v-if="projects.length === 0" class="tree-empty tree-empty-centered">暂无项目</div>

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
            :class="{ collapsed: !isExpanded(project.path) }"
            :aria-label="isExpanded(project.path) ? '折叠项目' : '展开项目'"
            @click.stop="toggleExpand(project.path)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          <div class="tree-node-main">
            <input
              v-if="renamingProjectPath === project.path"
              :ref="focusAndSelect"
              v-model="renameProjectValue"
              class="tree-rename-input"
              type="text"
              placeholder="项目别名"
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
              @dblclick.stop="startRenameProject(project)"
            >{{ projectDisplayName(project) }}</div>
          </div>

          <div class="tree-node-actions">
            <button
              type="button"
              class="tree-icon-button"
              aria-label="新建会话"
              data-tooltip="新建会话"
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
              aria-label="更多操作"
              data-tooltip="更多操作"
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
                v-if="shouldShowDot(session)"
                class="tree-session-status-dot"
                :class="`tone-${sessionTone(session)}`"
                :title="statusTitle(session)"
                aria-hidden="true"
              ></span>

              <div class="tree-node-main">
                <input
                  v-if="renamingSessionId === session.sessionId"
                  :ref="focusAndSelect"
                  v-model="renameSessionValue"
                  class="tree-rename-input"
                  type="text"
                  placeholder="会话别名"
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
                <span v-if="isOnCanvas(session)" class="session-oncanvas-tag">已开窗</span>
              </div>

              <div class="tree-node-actions">
                <button
                  type="button"
                  class="tree-icon-button danger"
                  :class="{ 'confirm-mode': deleteConfirmId === session.sessionId }"
                  :aria-label="deleteConfirmId === session.sessionId ? '确认删除' : '删除会话'"
                  :data-tooltip="deleteConfirmId === session.sessionId ? '确认删除' : '删除会话'"
                  @click.stop="handleDeleteSessionClick(session)"
                >
                  <span v-if="deleteConfirmId === session.sessionId" class="confirm-text">确认</span>
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
              {{ expandedSessionLists.has(project.path) ? '折叠显示' : `展开显示 ${hiddenSessionCount(project.path)} 个` }}
            </button>
            <div v-else-if="sessionsOf(project.path).length === 0" class="tree-empty tree-empty-inline">
              暂无会话
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
        <button type="button" class="project-action-menu-item" @click="onMenuRename">
          <svg class="project-action-menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          重命名
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
          {{ projectDeleteConfirmPath === menuOpenPath ? '确认删除' : '删除项目' }}
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
  padding: 10px 12px;
  border-radius: var(--radius-lg);
  cursor: pointer;
  color: var(--foreground);
  transition: background var(--transition-fast);
  min-width: 0;
}

.tree-project:hover {
  background: var(--surface-hover);
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
  width: 14px;
  height: 14px;
  transform: rotate(0deg);
  transition: transform var(--transition-fast);
}

.tree-arrow.collapsed svg {
  transform: rotate(-90deg);
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
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px 12px 4px 24px;
  border-radius: var(--radius-md);
  cursor: pointer;
  color: var(--foreground);
  transition: background var(--transition-fast);
  min-width: 0;
}

/* 已在多窗口画布上：置灰、去交互 */
.tree-session.on-canvas {
  opacity: 0.45;
  cursor: default;
}
.tree-session.on-canvas:hover {
  background: transparent;
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

.tree-session:hover {
  background: var(--surface-hover);
}

.tree-session.active {
  background: var(--surface-active);
}

.tree-session-status-dot {
  flex: 0 0 auto;
  width: 8px;
  height: 8px;
  border-radius: 999px;
}

/* 运行中：黄色 + 呼吸脉冲 */
.tree-session-status-dot.tone-streaming {
  background: var(--warning);
  --dot: var(--warning);
  animation: tree-status-pulse 1.6s ease-in-out infinite;
}

/* 出错：红色常显 */
.tree-session-status-dot.tone-error {
  background: var(--destructive);
}

/* 已完成（未点击过）：绿色 */
.tree-session-status-dot.tone-done {
  background: var(--success);
}

@keyframes tree-status-pulse {
  0% {
    box-shadow: 0 0 0 0 color-mix(in oklab, var(--dot, var(--warning)) 50%, transparent);
  }
  100% {
    box-shadow: 0 0 0 5px color-mix(in oklab, var(--dot, var(--warning)) 0%, transparent);
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
