<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from './bridge';
import type { ProjectItem, SessionItem, ThemeMode, ProjectPickerDescriptor } from './types';
import { projectTagOf } from './utils/sessionView';
import { useTheme } from './composables/useTheme';
import { useToast } from './composables/useToast';
import TitleBar from './components/TitleBar.vue';
import ProjectTree from './components/ProjectTree.vue';
import ConversationView from './components/ConversationView.vue';
import MultiWindowCanvas from './components/MultiWindowCanvas.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import TrustAskDialog from './components/TrustAskDialog.vue';
import ToastNotification from './components/ToastNotification.vue';
import ExitConfirmDialog from './components/ExitConfirmDialog.vue';

// 项目/会话
const projects = ref<ProjectItem[]>([]);
const sessions = ref<SessionItem[]>([]);
const currentProjectPath = ref<string | null>(null);
const currentSessionId = ref<string | null>(null);
/**
 * 草稿输入态：点击「新会话」后尚未真正创建 pi session（未发送首条消息）。
 * 发送首条消息时由 ConversationView 先创建会话（emit session-created），
 * 待会话列表出现该会话（别名已由首条消息生成）后退出草稿态。
 */
const draftMode = ref(false);

// 视图
type View = 'sessions' | 'settings';
const activeView = ref<View>('sessions');
const sidebarCollapsed = ref(false);
const showExitDialog = ref(false);
/** 待信任确认的项目（1005 弹窗） */
const trustAskPath = ref<string | null>(null);
const trustAskName = ref('');
/** 多窗口画布模式（单会话视图 ↔ 多窗口画布 切换） */
const multiWindow = ref(false);
/** 已在多窗口画布上打开的会话 id 列表（供会话池标记灰态） */
const openedSessionIds = ref<string[]>([]);
/** 多窗口模式下聚焦查看的会话 id（非空时在画布上方叠加单会话视图，布局保留） */
const focusedSessionForWin = ref<string | null>(null);

// 会话树视角（SM-S06）：项目=按项目分组（现状）；任务=平摊全部会话。选择记忆在 localStorage
const TREE_VIEW_KEY = 'forge:sidebar:view';
const treeView = ref<'project' | 'task'>(readTreeView());
const projectTreeRef = ref<InstanceType<typeof ProjectTree> | null>(null);
/** 项目视角全部项目是否已折叠（收起/展开全部按钮两态，由 ProjectTree 上报） */
const allCollapsed = ref(false);

function readTreeView(): 'project' | 'task' {
  try {
    return localStorage.getItem(TREE_VIEW_KEY) === 'task' ? 'task' : 'project';
  } catch {
    return 'project';
  }
}

watch(treeView, (v) => {
  try {
    localStorage.setItem(TREE_VIEW_KEY, v);
  } catch {
    // 存储失败忽略（不影响运行）
  }
});

function onFoldAll(): void {
  if (allCollapsed.value) projectTreeRef.value?.expandAll();
  else projectTreeRef.value?.collapseAll();
}

/** 下拉项目排序记忆：最近使用置顶（新建项目/创建会话触发），localStorage 持久（SM-S01 v3.29，v3.45 改 MRU） */
const PICK_ORDER_KEY = 'forge:project-pick-order';
const pickOrder = ref<string[]>(readPickOrder());

function readPickOrder(): string[] {
  try {
    const arr = JSON.parse(localStorage.getItem(PICK_ORDER_KEY) ?? '[]');
    return Array.isArray(arr) ? arr.filter((p): p is string => typeof p === 'string' && p.length > 0) : [];
  } catch {
    return [];
  }
}

watch(pickOrder, (v) => {
  try {
    localStorage.setItem(PICK_ORDER_KEY, JSON.stringify(v));
  } catch {
    // 存储失败忽略（不影响运行）
  }
});

/** 最近使用置顶（MRU）：重复使用也置顶，其余项目相对顺序不变；与项目树拖拽序无关 */
function bumpProjectToFront(path: string): void {
  pickOrder.value = [path, ...pickOrder.value.filter((p) => p !== path)];
}

/** 聚焦层「返回多窗口」行显示会话归属项目（别名优先，SM-S06 多窗口配套） */
const winFocusProjectName = computed(() => {
  const s = sessions.value.find((x) => x.sessionId === focusedSessionForWin.value);
  if (!s) return '';
  const p = projects.value.find((x) => x.path === s.projectPath);
  return p?.alias ?? basename(s.projectPath);
});

/**
 * 输入框项目选择器（SM-S01 v3.21）：草稿态=可选归属；会话中=只读信息。
 * 列表序（v3.45 改 MRU）：pickOrder（最近使用置顶）优先，未记录的按后端序排后。
 * 触发点仅两个：新建项目、创建会话成功；纯下拉选中不改序（与项目树拖拽序无关）。
 */
const orderedProjects = computed<ProjectItem[]>(() => {
  const rank = (p: string): number => {
    const idx = pickOrder.value.indexOf(p);
    return idx === -1 ? pickOrder.value.length : idx;
  };
  return [...projects.value].sort((a, b) => rank(a.path) - rank(b.path));
});

const projectPicker = computed<ProjectPickerDescriptor | null>(() => {
  if (projects.value.length === 0) return null;
  const s = currentSession.value;
  const inSession = s !== null && !draftMode.value;
  const path = inSession ? s.projectPath : (currentProject.value?.path ?? null);
  if (!path) return null;
  return {
    mode: inSession ? 'session' : 'draft',
    currentPath: path,
    currentName: projectTagOf(path, projects.value),
    items: orderedProjects.value.map((p) => ({
      path: p.path,
      name: projectTagOf(p.path, projects.value),
    })),
  };
});

// 设置
const { themeMode, setTheme } = useTheme();
const { message: toastMessage, type: toastType, show: showToast, clear: clearToast } = useToast();

// 模型列表与会话模型（ConversationView 消费）
const models = ref<string[]>([]);
const currentSessionModel = ref<string | null>(null);

const currentProject = computed(() =>
  projects.value.find((p) => p.path === currentProjectPath.value) ?? null,
);
const currentSession = computed(() =>
  sessions.value.find((s) => s.sessionId === currentSessionId.value) ?? null,
);

const sessionError = ref<string | null>(null);
let errorTimer: ReturnType<typeof setTimeout> | null = null;
function showError(msg: string): void {
  sessionError.value = msg;
  if (errorTimer !== null) clearTimeout(errorTimer);
  errorTimer = setTimeout(() => {
    sessionError.value = null;
  }, 6000);
}
function clearError(): void {
  sessionError.value = null;
  if (errorTimer !== null) clearTimeout(errorTimer);
}

async function loadProjects(): Promise<void> {
  try {
    const res = await call<{ projects: ProjectItem[] }>('project/queryProjectList');
    projects.value = res.projects;
    if (currentProjectPath.value === null && projects.value.length > 0) {
      await openProject(projects.value[0]!.path);
    }
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function selectProject(path: string): Promise<void> {
  currentProjectPath.value = path;
  currentSessionId.value = null;
  draftMode.value = false;
  // 设置在设置页时，点击项目应关闭设置并回到会话视图
  if (activeView.value === 'settings') activeView.value = 'sessions';
  await loadSessions();
}

/**
 * 输入框选择器切换归属项目（SM-S01 v3.21）：与侧栏切项目不同，
 * 草稿保留（选择器语义就是“给当前未发送的会话换归属”），不关设置页。
 */
async function onPickProject(path: string): Promise<void> {
  // 纯选中不改下拉序（v3.45 MRU 粒度）：置顶只由新建项目/创建会话触发
  currentProjectPath.value = path;
  currentSessionId.value = null;
  await loadSessions();
}

/**
 * 打开项目（P2-A）：先走 project/openProject；含项目资源且信任未定时返回 1005，
 * 弹出信任确认；已确定状态直接进入。错误码 1005 特殊处理（带 prompt 载荷）。
 */
async function openProject(path: string): Promise<void> {
  try {
    await call('project/openProject', { path });
    await selectProject(path);
  } catch (e) {
    if (e instanceof Error && e.message.includes('1005')) {
      // 信任询问：附带路径进入弹窗，不阻断会话视图
      trustAskPath.value = path;
      trustAskName.value = basename(path);
      await selectProject(path);
    } else {
      // 其余错误：仍进入项目（基础会话可用），仅提示
      await selectProject(path);
      showError(e instanceof Error ? e.message : String(e));
    }
  }
}

/** 信任决策回传（P2-A）：写 pi 权威后关闭弹窗 */
async function onTrustDecide(decision: 'trust' | 'reject' | 'trustOnce'): Promise<void> {
  const path = trustAskPath.value;
  trustAskPath.value = null;
  if (!path) return;
  try {
    await call('project/setTrust', { path, decision });
    const label =
      decision === 'trust' ? '已信任' : decision === 'reject' ? '已拒绝' : '本次已信任';
    showToast(`${label}：${basename(path)}`, decision === 'reject' ? 'info' : 'success');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function loadSessions(): Promise<void> {
  // 全量加载所有项目的会话（querySessionList 不传 projectPath 时返回全部），
  // 这样会话树里每个项目都能正确显示自己的会话，而非只显示当前项目。
  try {
    const res = await call<{ sessions: SessionItem[] }>('session/querySessionList', {});
    // core 会话状态值域（idle/running/done/error）映射到 UI 值域（running→streaming），
    // 保证会话树状态圆点 tone-* 样式类命中（后端运行时返回 'running'，宽化比较）
    sessions.value = res.sessions.map((s) => ({
      ...s,
      status: ((s.status as string) === 'running' ? 'streaming' : s.status) as SessionItem['status'],
    }));
    // 草稿态会话已真实创建（首条消息后自动命名入树）→ 退出草稿态。
    if (draftMode.value && currentSessionId.value !== null) {
      if (sessions.value.some((s) => s.sessionId === currentSessionId.value)) {
        draftMode.value = false;
      }
    }
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onAddProject(path: string): Promise<void> {
  try {
    await call('project/addProject', { path });
    await loadProjects();
    bumpProjectToFront(path);
    // 新建即选中：归属切到新项目（v3.48 用户反馈：排第一但未选中）；
    // 走 onPickProject 语义——草稿保留，与下拉选中一致
    await onPickProject(path);
    showToast('项目已添加', 'success');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/** 打开项目：不弹弹窗，直接弹系统目录选择器，选中即注册（取消/失败视为无操作） */
async function openFolderPicker(): Promise<void> {
  try {
    const dir = await window.forge.dialog.selectDirectory();
    if (dir) await onAddProject(dir);
  } catch {
    // 用户取消或桥接失败：无操作
  }
}

async function onRemoveProject(path: string): Promise<void> {
  try {
    // 级联删除：后端连同该项目名下会话（含 pi 会话文件）一并删除（v3.32 用户改判 TD-PM-05）
    const res = await call<{ removedSessions: number }>('project/removeProject', { path });
    pickOrder.value = pickOrder.value.filter((p) => p !== path);
    if (currentProjectPath.value === path) {
      currentProjectPath.value = null;
      currentSessionId.value = null;
    }
    await loadProjects();
    await loadSessions();
    showToast(res.removedSessions > 0 ? `项目已移除，连同 ${res.removedSessions} 个会话一并删除` : '项目已移除', 'success');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onRenameProject(path: string, alias: string): Promise<void> {
  try {
    await call('project/updateProjectAlias', { path, alias });
    await loadProjects();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/** 项目拖拽排序：全量新顺序落盘后刷新列表 */
async function onReorderProjects(paths: string[]): Promise<void> {
  try {
    await call('project/reorderProjects', { paths });
    await loadProjects();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/**
 * 新建会话：仅进入草稿输入态，不真正创建 pi session。
 * 发送首条消息时由 ConversationView 创建会话并 emit 'session-created'（见 onSessionCreated）。
 * 归属默认=项目选择器列表第一项（v3.38 用户裁定：顺序不变，默认选第一项）；
 * 项目树行内"新建会话"显式携带项目 path，优先于默认。
 */
function onCreateSession(sessionProjectPath?: string): void {
  if (projects.value.length === 0) return;
  // 多窗口画布无独立输入区，新建先退回单会话视图
  if (multiWindow.value) multiWindow.value = false;
  const target = sessionProjectPath ?? orderedProjects.value[0]?.path ?? null;
  if (target !== null && target !== currentProjectPath.value) void selectProject(target);
  currentSessionId.value = null;
  draftMode.value = true;
}

/**
 * ConversationView 草稿态发送首条消息时触发：会话已创建，绑定为当前会话。
 * 会话树标签等该会话别名生成（forge-core 自动命名 + session.updated → loadSessions）后自然出现，
 * 因此这里不主动刷新列表，保证左侧标签首次出现即带首条问题截取标题。
 */
function onSessionCreated(sessionId: string): void {
  currentSessionId.value = sessionId;
  // 会话归属落定 → 归属项目置顶（v3.45 MRU 粒度，草稿归属即 currentProjectPath）
  const p = currentProjectPath.value;
  if (p !== null) bumpProjectToFront(p);
}

async function onSelectSession(id: string): Promise<void> {
  currentSessionId.value = id;
  draftMode.value = false;
  // 设置在设置页时，点击会话应关闭设置并回到会话视图
  if (activeView.value === 'settings') activeView.value = 'sessions';
  try {
    await call('session/attachSessionWindow', { sessionId: id });
  } catch {
    // 重复 attach 忽略
  }
}

async function onDeleteSession(id: string): Promise<void> {
  try {
    await call('session/deleteSession', { sessionId: id });
    if (currentSessionId.value === id) currentSessionId.value = null;
    await loadSessions();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onRenameSession(id: string, alias: string): Promise<void> {
  try {
    await call('session/updateSessionAlias', { sessionId: id, alias });
    await loadSessions();
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

/** 全局默认模型（草稿态预览/未配置会话级覆盖时展示） */
const defaultModel = ref<string | null>(null);

// 加载可用模型列表（SettingsPanel 操作 provider 后由 providersChanged 事件刷新）
async function loadModels(): Promise<void> {
  try {
    const res = await call<{ models: string[]; defaultModel: string | null }>('model/queryModels');
    models.value = res.models;
    defaultModel.value = res.defaultModel;
    // 无会话（含草稿输入态）时用全局默认模型做展示
    if (currentSessionId.value === null) currentSessionModel.value = res.defaultModel;
  } catch {
    models.value = [];
  }
}

// 加载当前会话生效模型（优先会话覆盖，其次全局默认）
async function loadSessionModel(sid: string): Promise<void> {
  try {
    const res = await call<{ model: string | null; effective: string }>('model/getSessionModel', {
      sessionId: sid,
    });
    currentSessionModel.value = res.model;
  } catch {
    currentSessionModel.value = null;
  }
}

// 会话级模型切换（写 modelOverride，不影响全局默认）
async function onModelChange(model: string): Promise<void> {
  currentSessionModel.value = model;
  // 草稿态（会话尚未创建）：仅本地回显预览；所选模型在创建会话时由
  // ConversationView 写入会话覆盖（见其草稿发送分支），发送即生效
  if (currentSessionId.value === null) {
    // 不弹顶部 toast：模型选择器本身已回显所选模型，避免遮挡会话区
    return;
  }
  try {
    await call('model/setSessionModel', { sessionId: currentSessionId.value, model });
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

function openSettings(): void {
  activeView.value = 'settings';
  multiWindow.value = false;
  focusedSessionForWin.value = null;
}

function closeSettings(): void {
  activeView.value = 'sessions';
}

/** 切换单会话视图 / 多窗口画布 */
function toggleMultiWindow(): void {
  multiWindow.value = !multiWindow.value;
  // 主动退出（或重新进入）多窗口时，清掉窗口单会话聚焦层
  focusedSessionForWin.value = null;
}

/**
 * 多窗口画布中点击窗口"单视图"：不退出多窗口，改为在画布上方叠加单个会话视图，
 * 保留画布上的窗口布局，可随时返回。
 */
function onMultiWindowFocus(sessionId: string): void {
  currentSessionId.value = sessionId;
  focusedSessionForWin.value = sessionId;
}

/** 从窗口单会话聚焦层返回多窗口画布 */
function closeWinFocus(): void {
  focusedSessionForWin.value = null;
}

/** 多窗口画布开窗集合变化：同步给会话池标记灰态 */
function onOpenedChange(sessionIds: string[]): void {
  openedSessionIds.value = sessionIds;
}

// 退出多窗口（画布卸载）时清掉会话树"已开窗"标记；
// 布局已持久化，重进多窗口时 restoreLayout 会重开窗并重新同步该集合
watch(multiWindow, (v) => {
  if (!v) openedSessionIds.value = [];
});

function requestExit(): void {
  showExitDialog.value = true;
}

function confirmExit(): void {
  showExitDialog.value = false;
  window.forge.window.close();
}

function basename(p: string): string {
  const parts = p.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || p;
}

let unsubSessionRemoved: (() => void) | null = null;
let unsubSessionUpdated: (() => void) | null = null;
let unsubSessionStatus: (() => void) | null = null;
let unsubProjectRemoved: (() => void) | null = null;
let unsubProvidersChanged: (() => void) | null = null;

// 会话切换时加载该会话生效模型；无会话（含草稿态）时展示全局默认模型
watch(currentSessionId, (sid) => {
  if (sid !== null) void loadSessionModel(sid);
  else currentSessionModel.value = defaultModel.value;
});

// 查看中的会话完成结果未读 → 调 session/markSessionRead 落盘已读（forge-store，
// 跨窗口/重启一致）。覆盖三种路径：点击已完成会话；正查看时会话 streaming→done
//（session.statusChanged → loadSessions 触发本 watch）；多窗口画布聚焦。
watch([sessions, currentSessionId], () => {
  if (currentSessionId.value === null) return;
  const s = sessions.value.find((it) => it.sessionId === currentSessionId.value);
  if (s && s.status === 'done' && !s.doneReadAt) {
    call('session/markSessionRead', { sessionId: s.sessionId }).catch(() => {
      // 标记失败不阻断会话视图（绿点会在下次触发时重试）
    });
  }
});

onMounted(() => {
  void loadProjects();
  void loadModels();
  unsubSessionRemoved = subscribe('session.removed', (payload) => {
    const p = payload as { sessionId: string };
    if (p.sessionId === currentSessionId.value) currentSessionId.value = null;
    void loadSessions();
  });
  // 会话别名更新（手动重命名或首条消息自动命名）：刷新列表保持 UI 同步
  unsubSessionUpdated = subscribe('session.updated', () => {
    void loadSessions();
  });
  // 会话运行时状态变化（streaming/done/error）：刷新会话树状态圆点
  unsubSessionStatus = subscribe('session.statusChanged', () => {
    void loadSessions();
  });
  unsubProjectRemoved = subscribe('project.removed', () => {
    void loadProjects();
  });
  // SettingsPanel 增删 provider 后刷新模型列表
  unsubProvidersChanged = subscribe('model.providersChanged', () => {
    void loadModels();
    if (currentSessionId.value !== null) void loadSessionModel(currentSessionId.value);
  });
});

onUnmounted(() => {
  unsubSessionRemoved?.();
  unsubSessionUpdated?.();
  unsubSessionStatus?.();
  unsubProjectRemoved?.();
  unsubProvidersChanged?.();
  if (errorTimer !== null) clearTimeout(errorTimer);
});
</script>

<template>
  <div class="app-container" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <TitleBar
      :sidebar-collapsed="sidebarCollapsed"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      @request-exit="requestExit"
    />

    <section class="main-layout">
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <header class="workspace-header"></header>
        <div class="tree-panel">
          <div class="sidebar-top">
            <div class="view-seg" role="tablist" aria-label="会话列表视角">
              <button
                type="button"
                class="view-seg-btn"
                :class="{ active: treeView === 'project' }"
                @click="treeView = 'project'"
              >项目</button>
              <button
                type="button"
                class="view-seg-btn"
                :class="{ active: treeView === 'task' }"
                @click="treeView = 'task'"
              >任务</button>
            </div>
            <div class="sidebar-top-actions">
              <button
                v-if="treeView === 'project'"
                type="button"
                class="fold-all-btn"
                :aria-label="allCollapsed ? '展开全部项目' : '收起全部项目'"
                :data-tooltip="allCollapsed ? '展开全部项目' : '收起全部项目'"
                @click="onFoldAll"
              >
                <svg v-if="allCollapsed" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 展开全部：对角双箭头外扩 -->
                  <polyline points="15 3 21 3 21 9" />
                  <polyline points="9 21 3 21 3 15" />
                  <line x1="21" y1="3" x2="14" y2="10" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <!-- 收起全部：对角双箭头内收 -->
                  <polyline points="4 14 10 14 10 20" />
                  <polyline points="20 10 14 10 14 4" />
                  <line x1="14" y1="10" x2="21" y2="3" />
                  <line x1="3" y1="21" x2="10" y2="14" />
                </svg>
              </button>
            </div>
          </div>
          <ProjectTree
            ref="projectTreeRef"
            :view="treeView"
            :projects="projects"
            :sessions="sessions"
            :current-project-path="currentProjectPath"
            :current-session-id="currentSessionId"
            :opened-session-ids="openedSessionIds"
            @select-project="selectProject"
            @remove-project="onRemoveProject"
            @rename-project="onRenameProject"
            @reorder-project="onReorderProjects"
            @create-session="onCreateSession"
            @select-session="onSelectSession"
            @delete-session="onDeleteSession"
            @rename-session="onRenameSession"
            @fold-state="allCollapsed = $event"
          />
        </div>
        <div class="sidebar-footer">
          <button class="sidebar-link" @click="openSettings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
            <span>设置</span>
          </button>
        </div>
      </aside>

      <main class="content" :class="{ 'settings-mode': activeView === 'settings' }">
        <div v-if="sessionError" class="error-toast" @click="clearError">
          {{ sessionError }}
        </div>

        <div v-if="activeView !== 'settings'" class="app-toolbar">
          <button
            class="app-toolbar-btn"
            data-tooltip="新建会话"
            :disabled="projects.length === 0"
            @click="onCreateSession()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>新会话</span>
          </button>
          <button
            class="app-toolbar-btn"
            :class="{ 'is-active': multiWindow }"
            data-tooltip="多窗口画布：会话并排观察"
            @click="toggleMultiWindow"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="8" height="8" rx="1.5" />
              <rect x="13" y="3" width="8" height="8" rx="1.5" />
              <rect x="3" y="13" width="8" height="8" rx="1.5" />
              <rect x="13" y="13" width="8" height="8" rx="1.5" />
            </svg>
            <span>多窗口</span>
          </button>
          <span class="app-toolbar-space"></span>
        </div>

        <section v-if="activeView === 'settings'" class="settings-stage">
          <SettingsPanel
            :theme-mode="themeMode"
            @theme-change="setTheme"
            @close="closeSettings"
          />
        </section>

        <template v-else>
          <!-- 多窗口画布模式 -->
          <div v-if="multiWindow" class="session-stage">
            <!-- 多窗口画布始终挂载，保留窗口布局 -->
            <MultiWindowCanvas
              :sessions="sessions"
              :models="models"
              @close="multiWindow = false"
              @focus-session="onMultiWindowFocus"
              @opened-change="onOpenedChange"
            />
            <!-- 窗口单会话聚焦层：不卸载画布，可返回多窗口 -->
            <div
              v-if="focusedSessionForWin && currentProject && currentSession"
              class="win-focus-overlay"
            >
              <div class="win-focus-bar">
                <button class="win-focus-back" @click="closeWinFocus">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M19 12H5M12 19l-7-7 7-7" />
                  </svg>
                  <span>返回多窗口</span>
                </button>
                <span class="win-focus-title">
                  {{ currentSession.alias || '会话 ' + currentSession.sessionId.slice(-6) }}
                </span>
                <span class="win-focus-proj">{{ winFocusProjectName }}</span>
              </div>
              <ConversationView
                :session-id="currentSessionId!"
                :project="currentProject"
                :session="currentSession"
                :models="models"
                :current-model="currentSessionModel"
                :project-picker="projectPicker ?? undefined"
                @model-change="onModelChange"
                @pick-project="onPickProject"
                @open-project-picker="openFolderPicker"
                @remove-project="onRemoveProject"
              />
            </div>
          </div>
          <div v-else-if="currentProject && (currentSession || draftMode)" class="session-stage">
            <ConversationView
              :session-id="currentSessionId"
              :project="currentProject"
              :session="currentSession"
              :models="models"
              :current-model="currentSessionModel"
              :project-picker="projectPicker ?? undefined"
              @model-change="onModelChange"
              @session-created="onSessionCreated"
              @pick-project="onPickProject"
              @open-project-picker="openFolderPicker"
              @remove-project="onRemoveProject"
            />
          </div>
          <div v-else-if="currentProject" class="no-session">
            <div class="no-session-card">
              <div class="no-session-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p class="no-session-title">{{ currentProject.alias ?? basename(currentProject.path) }}</p>
              <p class="hint">点击左侧 + 新建会话开始对话</p>
            </div>
          </div>
          <div v-else class="no-session">
            <div class="no-session-card">
              <div class="no-session-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <p class="no-session-title">选择项目或创建新项目开始</p>
              <button class="primary" @click="openFolderPicker">打开项目</button>
            </div>
          </div>
        </template>
      </main>
    </section>

    <TrustAskDialog
      v-if="trustAskPath !== null"
      :project-path="trustAskPath"
      :project-name="trustAskName"
      @decide="onTrustDecide"
    />

    <ExitConfirmDialog
      v-if="showExitDialog"
      @confirm="confirmExit"
      @cancel="showExitDialog = false"
    />

    <ToastNotification
      v-if="toastMessage"
      :message="toastMessage"
      :type="toastType"
      @close="clearToast"
    />
  </div>
</template>

<style scoped>
.app-container {
  height: 100vh;
  width: 100vw;
  background: var(--background);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.main-layout {
  flex: 1;
  min-height: 0;
  display: flex;
  width: 100%;
  overflow: hidden;
  background: var(--card);
}

.sidebar {
  width: 292px;
  min-width: 292px;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: auto minmax(0, 1fr) auto;
  min-height: 0;
  height: 100%;
  position: relative;
  overflow: hidden;
  background: color-mix(in oklab, var(--muted) 10%, transparent);
  backdrop-filter: blur(24px) saturate(1.4);
  -webkit-backdrop-filter: blur(24px) saturate(1.4);
  transition: width var(--transition-base), min-width var(--transition-base), opacity var(--transition-base);
}

.sidebar::before {
  content: '';
  position: absolute;
  inset: -40%;
  z-index: 0;
  pointer-events: none;
  background:
    radial-gradient(ellipse 80% 60% at 20% 30%, color-mix(in oklab, var(--muted-foreground) 10%, transparent) 0%, transparent 60%),
    radial-gradient(ellipse 70% 50% at 80% 70%, color-mix(in oklab, var(--muted) 30%, transparent) 0%, transparent 55%);
}

.sidebar > * {
  position: relative;
  z-index: 1;
}

.sidebar.collapsed {
  width: 0;
  min-width: 0;
  opacity: 0;
  pointer-events: none;
}

.workspace-header {
  display: flex;
  align-items: center;
  padding: 14px 18px;
  min-height: 56px;
}

/* FORGE 渐变文字 LOGO 已随 SM-S07 隐藏（品牌位移至 TitleBar 左上角 LOGO 瓷片）；
   重设计后如需文字品牌，在 workspace-header 内新增节点即可 */

.tree-panel {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.sidebar-top {
  padding: 10px 18px 4px;
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* 视角分段开关（SM-S06）：项目 / 任务 */
.view-seg {
  display: inline-flex;
  gap: 2px;
  padding: 2px;
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  border: 1px solid var(--border);
  border-radius: 999px;
}

.view-seg-btn {
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.view-seg-btn.active {
  background: var(--surface-active);
  color: var(--foreground);
}

.view-seg-btn:not(.active):hover {
  color: var(--foreground);
}

.sidebar-top-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* 收起全部/展开全部（仅项目视角）：无 边框 ghost 按钮（SM-S06） */
.fold-all-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: transparent;
  border: 0;
  color: var(--muted-foreground);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast);
}

.fold-all-btn:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
  color: var(--foreground);
}

.fold-all-btn svg {
  width: 15px;
  height: 15px;
}

.sidebar-footer {
  padding: 10px 12px 14px 28px;
}

.sidebar-link {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 0;
  background: transparent;
  border: none;
  color: var(--muted-foreground);
  font-size: 13px;
  font-weight: 500;
  text-align: left;
}

.sidebar-link:hover {
  color: var(--foreground);
  background: transparent;
  border-color: transparent;
}

.sidebar-link svg {
  width: 16px;
  height: 16px;
}

.content {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
  overflow: hidden;
  border-left: 1px solid var(--border);
}

.content.settings-mode {
  padding: 16px 18px;
}

.app-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 8%, var(--background));
  flex-shrink: 0;
}

.app-toolbar-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
}

.app-toolbar-btn:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand);
}

.app-toolbar-btn.is-active {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 8%, var(--background));
  color: var(--brand);
}

.app-toolbar-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.app-toolbar-btn svg {
  width: 13px;
  height: 13px;
}

.app-toolbar-space {
  flex: 1;
}

.session-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  position: relative;
}

.win-focus-overlay {
  position: absolute;
  inset: 0;
  z-index: 40;
  background: var(--background);
  display: flex;
  flex-direction: column;
  min-height: 0;
  animation: fadeIn 0.2s ease-out;
}

.win-focus-bar {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in oklab, var(--muted) 8%, var(--background));
}
.win-focus-back {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: var(--card);
  color: var(--foreground);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
}
.win-focus-back:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.win-focus-back svg {
  width: 13px;
  height: 13px;
}
.win-focus-title {
  font-size: 12px;
  color: var(--muted-foreground);
}

/* 聚焦行项目 pill（SM-S06 多窗口配套）：点会话进来即可见归属项目 */
.win-focus-proj {
  flex-shrink: 0;
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  color: var(--muted-foreground);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 1px 6px;
  background: color-mix(in oklab, var(--muted) 30%, transparent);
}

.no-session {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
}

.no-session-card {
  text-align: center;
  padding: 28px 32px;
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  background: color-mix(in oklab, var(--muted) 45%, var(--background));
  max-width: 360px;
  box-shadow: var(--shadow-md);
}

.no-session-icon {
  width: 48px;
  height: 48px;
  margin: 0 auto 12px;
  color: var(--muted-foreground);
  opacity: 0.6;
}

.no-session-icon svg {
  width: 100%;
  height: 100%;
}

.no-session-title {
  color: var(--foreground);
  font-size: 15px;
  font-weight: 500;
  margin-bottom: 6px;
}

.no-session-card .hint {
  font-size: 12px;
  color: var(--muted-foreground);
  margin-bottom: 12px;
}

.settings-stage {
  flex: 1;
  min-height: 0;
  display: flex;
}

.error-toast {
  position: fixed;
  top: 48px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 3000;
  background: color-mix(in oklab, var(--destructive) 10%, var(--card));
  color: var(--foreground);
  padding: 10px 18px;
  border-radius: var(--radius-lg);
  font-size: 13px;
  cursor: pointer;
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, transparent);
  box-shadow: var(--shadow-lg);
  animation: fadeIn 0.2s ease-out;
  max-width: 70vw;
  text-align: center;
  word-break: break-word;
}
</style>
