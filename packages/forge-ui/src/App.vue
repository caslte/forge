<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from './bridge';
import type { ProjectItem, SessionItem, ThemeMode } from './types';
import { useTheme } from './composables/useTheme';
import { useToast } from './composables/useToast';
import TitleBar from './components/TitleBar.vue';
import ProjectTree from './components/ProjectTree.vue';
import ConversationView from './components/ConversationView.vue';
import SettingsPanel from './components/SettingsPanel.vue';
import ProjectPickerDialog from './components/ProjectPickerDialog.vue';
import ToastNotification from './components/ToastNotification.vue';
import ExitConfirmDialog from './components/ExitConfirmDialog.vue';

// 项目/会话
const projects = ref<ProjectItem[]>([]);
const sessions = ref<SessionItem[]>([]);
const currentProjectPath = ref<string | null>(null);
const currentSessionId = ref<string | null>(null);

// 视图
type View = 'sessions' | 'settings';
const activeView = ref<View>('sessions');
const sidebarCollapsed = ref(false);
const showProjectPicker = ref(false);
const showExitDialog = ref(false);

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
      await selectProject(projects.value[0]!.path);
    }
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function selectProject(path: string): Promise<void> {
  currentProjectPath.value = path;
  currentSessionId.value = null;
  await loadSessions();
}

async function loadSessions(): Promise<void> {
  if (currentProjectPath.value === null) {
    sessions.value = [];
    return;
  }
  try {
    const res = await call<{ sessions: SessionItem[] }>('session/querySessionList', {
      projectPath: currentProjectPath.value,
    });
    sessions.value = res.sessions;
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onAddProject(path: string): Promise<void> {
  try {
    await call('project/addProject', { path });
    showProjectPicker.value = false;
    await loadProjects();
    showToast('项目已添加', 'success');
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onRemoveProject(path: string): Promise<void> {
  try {
    await call('project/removeProject', { path });
    if (currentProjectPath.value === path) {
      currentProjectPath.value = null;
      currentSessionId.value = null;
      sessions.value = [];
    }
    await loadProjects();
    showToast('项目已移除', 'success');
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

async function onCreateSession(): Promise<void> {
  if (currentProjectPath.value === null) return;
  try {
    const res = await call<{ session: { sessionId: string } }>('session/createSession', {
      projectPath: currentProjectPath.value,
    });
    await loadSessions();
    currentSessionId.value = res.session.sessionId;
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

async function onSelectSession(id: string): Promise<void> {
  currentSessionId.value = id;
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

// 加载可用模型列表（SettingsPanel 操作 provider 后由 providersChanged 事件刷新）
async function loadModels(): Promise<void> {
  try {
    const res = await call<{ models: string[]; defaultModel: string | null }>('model/queryModels');
    models.value = res.models;
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
  if (currentSessionId.value === null) return;
  try {
    await call('model/setSessionModel', { sessionId: currentSessionId.value, model });
    currentSessionModel.value = model;
  } catch (e) {
    showError(e instanceof Error ? e.message : String(e));
  }
}

function openSettings(): void {
  activeView.value = 'settings';
}

function closeSettings(): void {
  activeView.value = 'sessions';
}

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
let unsubProjectRemoved: (() => void) | null = null;
let unsubProvidersChanged: (() => void) | null = null;

// 会话切换时加载该会话生效模型
watch(currentSessionId, (sid) => {
  if (sid !== null) void loadSessionModel(sid);
  else currentSessionModel.value = null;
});

onMounted(() => {
  void loadProjects();
  void loadModels();
  unsubSessionRemoved = subscribe('session.removed', (payload) => {
    const p = payload as { sessionId: string };
    if (p.sessionId === currentSessionId.value) currentSessionId.value = null;
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
  unsubProjectRemoved?.();
  unsubProvidersChanged?.();
  if (errorTimer !== null) clearTimeout(errorTimer);
});
</script>

<template>
  <div class="app-container" :class="{ 'sidebar-collapsed': sidebarCollapsed }">
    <TitleBar
      :sidebar-collapsed="sidebarCollapsed"
      :theme-mode="themeMode"
      @toggle-sidebar="sidebarCollapsed = !sidebarCollapsed"
      @toggle-theme="setTheme(themeMode === 'light' ? 'dark' : 'light')"
      @open-settings="openSettings"
      @request-exit="requestExit"
    />

    <section class="main-layout">
      <aside class="sidebar" :class="{ collapsed: sidebarCollapsed }">
        <header class="workspace-header">
          <span class="workspace-brand">FORGE</span>
        </header>
        <div class="tree-panel">
          <div class="sidebar-top">
            <span class="sidebar-top-label">项目</span>
            <button
              class="add-project-btn"
              data-tooltip="打开项目"
              @click="showProjectPicker = true"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          </div>
          <ProjectTree
            :projects="projects"
            :sessions="sessions"
            :current-project-path="currentProjectPath"
            :current-session-id="currentSessionId"
            @select-project="selectProject"
            @remove-project="onRemoveProject"
            @rename-project="onRenameProject"
            @create-session="onCreateSession"
            @select-session="onSelectSession"
            @delete-session="onDeleteSession"
            @rename-session="onRenameSession"
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
            :disabled="!currentProject"
            @click="onCreateSession"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <span>新会话</span>
          </button>
          <span class="app-toolbar-space"></span>
          <span v-if="currentProject" class="app-toolbar-path" :title="currentProject.path">
            {{ currentProject.path }}
          </span>
        </div>

        <section v-if="activeView === 'settings'" class="settings-stage">
          <SettingsPanel
            :theme-mode="themeMode"
            @theme-change="setTheme"
            @close="closeSettings"
          />
        </section>

        <template v-else>
          <div v-if="currentProject && currentSession" class="session-stage">
            <ConversationView
              :session-id="currentSessionId!"
              :project="currentProject"
              :session="currentSession"
              :models="models"
              :current-model="currentSessionModel"
              @model-change="onModelChange"
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
              <button class="primary" @click="showProjectPicker = true">打开项目</button>
            </div>
          </div>
        </template>
      </main>
    </section>

    <ProjectPickerDialog
      v-if="showProjectPicker"
      @close="showProjectPicker = false"
      @confirm="onAddProject"
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

.workspace-brand {
  font-family: var(--font-mono);
  font-size: 22px;
  letter-spacing: 0.14em;
  background: linear-gradient(90deg, var(--logo-gradient-base) 0%, var(--logo-gradient-accent) 25%, var(--logo-gradient-base) 50%, var(--logo-gradient-accent) 75%, var(--logo-gradient-base) 100%);
  background-size: 200% 100%;
  -webkit-background-clip: text;
  background-clip: text;
  -webkit-text-fill-color: transparent;
  animation: logo-gradient-shift 3s linear infinite;
  margin-left: 15px;
}

@keyframes logo-gradient-shift {
  0% { background-position: 0% 0%; }
  100% { background-position: 100% 0%; }
}

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

.sidebar-top-label {
  color: var(--muted-foreground);
  font-size: 14px;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.add-project-btn {
  width: 30px;
  height: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 10px;
  background: var(--background);
  border: 1px solid var(--border);
  color: var(--muted-foreground);
}

.add-project-btn svg {
  width: 16px;
  height: 16px;
}

.add-project-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
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

.app-toolbar-path {
  font-size: 12px;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.session-stage {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
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
