<script setup lang="ts">
/**
 * Skills 管理 Tab（模块 09，docs/prd/09_skill_management.md）。
 * 只管理全局（user 根）skill；项目级不在 UI 暴露（后端 RPC 仍支持）。
 *
 * 数据链路：skill/listSkills 枚举（口径 == pi loader，含 collision/非法诊断）；
 * 写操作（import/create/delete）全部经主进程，UI 只做确认交互与展示。
 * 4090 = 同名冲突正常分支 → invokeRaw 分流弹确认，确认后带 overwrite=true 重调。
 */
import { computed, onMounted, ref } from 'vue';
import { invokeRaw } from '../bridge';
import type { ListSkillsResult, SkillConflictData, SkillEntry, SkillIssue } from '../bridge';
import { useI18n } from '../i18n/index.ts';
import { useToast } from '../composables/useToast';

const { t } = useI18n();
const toast = useToast();

const loading = ref(false);
const loadError = ref<string | null>(null);
const skills = ref<SkillEntry[]>([]);
const issues = ref<SkillIssue[]>([]);

const userSkills = computed(() => skills.value.filter((s) => s.scope === 'user'));
const otherSkills = computed(() => skills.value.filter((s) => s.scope === 'other'));

function groupSkills(list: SkillEntry[]): SkillEntry[] {
  return [...list].sort((a, b) => a.name.localeCompare(b.name));
}

/** 展示分组：全局固定展示（空态占位），other 组仅在有内容时出现 */
interface SkillGroup {
  key: 'user' | 'other';
  label: string;
  list: SkillEntry[];
}

const groups = computed<SkillGroup[]>(() => {
  const list: SkillGroup[] = [
    { key: 'user', label: t('settings.skills.groupUser'), list: groupSkills(userSkills.value) },
  ];
  const other = groupSkills(otherSkills.value);
  if (other.length > 0) list.push({ key: 'other', label: t('settings.skills.groupOther'), list: other });
  return list;
});

async function refresh(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const res = await invokeRaw<ListSkillsResult>('skill/listSkills', {});
    if (res.code !== 0 || res.data === null) {
      loadError.value = `${t('settings.skills.errorLoad')}（${res.code}）: ${res.message}`;
      return;
    }
    skills.value = res.data.skills;
    issues.value = res.data.issues;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
});

// ===== 导入 =====

/** 冲突确认弹窗状态：确认后带 overwrite=true 重调同一方法 */
interface PendingOverwrite {
  kind: 'import' | 'create';
  conflictPath: string;
  params: Record<string, unknown>;
}
const pendingOverwrite = ref<PendingOverwrite | null>(null);

async function onImport(): Promise<void> {
  const dir = await window.forge.dialog.selectDirectory();
  if (dir === null) return; // 用户取消系统对话框：无任何反馈（未发生操作）
  await runImport({ scope: 'user', sourceDir: dir });
}

async function runImport(params: Record<string, unknown>): Promise<void> {
  const res = await invokeRaw<{ path: string; overwritten?: boolean }>('skill/importSkill', params);
  if (res.code === 4090 && res.data !== null) {
    // 4090 信封 data 实为 SkillConflictData（同接口双形态，泛型只声明成功支）
    const d = res.data as unknown as SkillConflictData;
    pendingOverwrite.value = { kind: 'import', conflictPath: d.conflictPath, params };
    return;
  }
  if (res.code !== 0) {
    toast.error(res.message);
    return;
  }
  toast.success(res.data?.overwritten ? t('settings.skills.overwritten') : t('settings.skills.imported'));
  await refresh();
}

// ===== 新建表单 =====

const showCreateForm = ref(false);
const formName = ref('');
const formDesc = ref('');
const formBody = ref('');
const formError = ref<string | null>(null);
const creating = ref(false);

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

function openCreateForm(): void {
  formName.value = '';
  formDesc.value = '';
  formBody.value = '';
  formError.value = null;
  showCreateForm.value = true;
}

async function onCreateSubmit(): Promise<void> {
  if (creating.value) return;
  const name = formName.value.trim();
  const description = formDesc.value.trim();
  // 即时校验（AC-09-09）；服务端同源再校验，UI 不可绕过
  if (!NAME_RE.test(name) || name.length > 64) {
    formError.value = t('settings.skills.nameInvalid');
    return;
  }
  if (description === '') {
    formError.value = t('settings.skills.descRequired');
    return;
  }
  formError.value = null;
  creating.value = true;
  try {
    await runCreate({
      scope: 'user',
      name,
      description,
      body: formBody.value || undefined,
    });
  } finally {
    creating.value = false;
  }
}

async function runCreate(params: Record<string, unknown>): Promise<void> {
  const res = await invokeRaw<{ path: string }>('skill/createSkill', params);
  if (res.code === 4090 && res.data !== null) {
    const d = res.data as unknown as SkillConflictData;
    pendingOverwrite.value = { kind: 'create', conflictPath: d.conflictPath, params };
    return;
  }
  if (res.code !== 0) {
    formError.value = res.message; // 表单失败保留输入（PRD §3.4）
    toast.error(res.message);
    return;
  }
  showCreateForm.value = false;
  toast.success(t('settings.skills.created'));
  await refresh();
}

/** 冲突确认：旧目录移入回收站后覆盖（取消 = 一切不变） */
async function confirmOverwrite(): Promise<void> {
  const pending = pendingOverwrite.value;
  if (pending === null) return;
  pendingOverwrite.value = null;
  const withOverwrite = { ...pending.params, overwrite: true };
  if (pending.kind === 'import') {
    await runImport(withOverwrite);
  } else {
    await runCreate(withOverwrite);
  }
}

// ===== 删除 =====

const deleteTarget = ref<SkillEntry | null>(null);

async function confirmDelete(): Promise<void> {
  const target = deleteTarget.value;
  if (target === null) return;
  deleteTarget.value = null;
  const res = await invokeRaw<{ trashed: boolean }>('skill/deleteSkill', {
    path: target.dirPath,
  });
  if (res.code !== 0) {
    toast.error(res.message);
    return;
  }
  if (res.data?.trashed === false) {
    toast.info(t('settings.skills.permDeleted')); // 回收站不可用，如实告知（TD-SK-04）
  } else {
    toast.success(t('settings.skills.deleted'));
  }
  await refresh();
}

function openDir(dirPath: string): void {
  void window.forge.shell.openPath(dirPath);
}
</script>

<template>
  <section class="settings-section skills-section">
    <div class="skills-head">
      <h2 class="skills-title">{{ t('settings.skills.title') }}</h2>
      <div class="skills-head-actions">
        <button class="skills-btn" :title="t('settings.skills.importTooltip')" @click="onImport">{{ t('settings.skills.import') }}</button>
        <button class="skills-btn primary" @click="openCreateForm">{{ t('settings.skills.create') }}</button>
      </div>
    </div>

    <div v-if="loadError" class="skills-error">{{ loadError }}</div>

    <div v-if="loading" class="skills-loading">{{ t('settings.skills.loading') }}</div>

    <!-- 分组展示（全局 [+ 其他根]），组内按名称排序；每条带真实目录路径徽标 -->
    <div v-for="group in groups" :key="group.key" class="skills-group">
      <h3 class="skills-group-title">{{ group.label }}</h3>
      <div v-if="group.list.length === 0" class="skills-empty">{{ t('settings.skills.empty') }}</div>
      <div v-for="s in group.list" :key="s.dirPath" class="skill-row">
        <div class="skill-info">
          <span class="skill-name">{{ s.name }}</span>
          <span class="skill-desc">{{ s.description }}</span>
          <button type="button" class="skill-path" :title="t('settings.skills.openDirTooltip')" @click="openDir(s.dirPath)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
            <span class="skill-path-text">{{ s.dirPath }}</span>
          </button>
        </div>
        <div class="skill-actions">
          <button
            class="skill-delete"
            :aria-label="t('settings.skills.delete')"
            @click="deleteTarget = s"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="3 6 5 6 21 6" />
              <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
            </svg>
          </button>
        </div>
      </div>
    </div>

    <!-- 异常与冲突（可折叠；含影子扫描补报的未加载目录，AC-09-02 不静默吞） -->
    <details v-if="issues.length > 0" class="skills-issues">
      <summary>{{ t('settings.skills.issuesSummary', { count: issues.length }) }}</summary>
      <ul>
        <li v-for="(issue, i) in issues" :key="i" class="skills-issue">
          <span class="skills-issue-type" :class="issue.type">{{ issue.type }}</span>
          <span>{{ issue.message }}</span>
          <span v-if="issue.type === 'collision' && issue.loserPath" class="skills-issue-path">{{ issue.loserPath }}{{ t('settings.skills.collisionSuffix') }}</span>
          <span v-else-if="issue.path" class="skills-issue-path">{{ issue.path }}</span>
        </li>
      </ul>
    </details>

    <!-- 冲突确认 / 删除确认 / 新建表单：Teleport 脱离 settings 祖先 transform（fixed 遮罩裁剪） -->
    <Teleport to="body">
      <div v-if="pendingOverwrite" class="skills-overlay" role="dialog" aria-modal="true" @click.self="pendingOverwrite = null">
        <div class="skills-dialog">
          <span class="skills-dialog-title">{{ t('settings.skills.importConflictTitle') }}</span>
          <p class="skills-dialog-text">{{ t('settings.skills.importConflictText') }}</p>
          <code class="skills-dialog-path">{{ pendingOverwrite.conflictPath }}</code>
          <div class="skills-dialog-actions">
            <button class="ghost small" @click="pendingOverwrite = null">{{ t('common.cancel') }}</button>
            <button class="primary small" @click="confirmOverwrite">{{ t('settings.skills.overwriteConfirm') }}</button>
          </div>
        </div>
      </div>

      <div v-if="deleteTarget" class="skills-overlay" role="dialog" aria-modal="true" @click.self="deleteTarget = null">
        <div class="skills-dialog">
          <span class="skills-dialog-title">{{ t('settings.skills.deleteConfirmTitle') }}：{{ deleteTarget.name }}</span>
          <p class="skills-dialog-text">{{ t('settings.skills.deleteConfirmText') }}</p>
          <code class="skills-dialog-path">{{ deleteTarget.dirPath }}</code>
          <div class="skills-dialog-actions">
            <button class="ghost small" @click="deleteTarget = null">{{ t('common.cancel') }}</button>
            <button class="primary small danger" @click="confirmDelete">{{ t('settings.skills.deleteConfirmOk') }}</button>
          </div>
        </div>
      </div>

      <div v-if="showCreateForm" class="skills-overlay" role="dialog" aria-modal="true" @click.self="showCreateForm = false">
        <div class="skills-dialog wide">
          <span class="skills-dialog-title">{{ t('settings.skills.createTitle') }}</span>
          <label class="skills-field">
            <span>{{ t('settings.skills.fieldName') }}</span>
            <input v-model="formName" type="text" placeholder="my-skill" :maxlength="64" />
            <em>{{ t('settings.skills.fieldNameHint') }}</em>
          </label>
          <label class="skills-field">
            <span>{{ t('settings.skills.fieldDesc') }}</span>
            <input v-model="formDesc" type="text" />
          </label>
          <label class="skills-field">
            <span>{{ t('settings.skills.fieldBody') }}</span>
            <textarea v-model="formBody" rows="6"></textarea>
          </label>
          <div v-if="formError" class="skills-error">{{ formError }}</div>
          <div class="skills-dialog-actions">
            <button class="ghost small" @click="showCreateForm = false">{{ t('common.cancel') }}</button>
            <button class="primary small" :disabled="creating" @click="onCreateSubmit">{{ t('settings.skills.createSubmit') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.skills-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.skills-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.skills-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.skills-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.skills-error {
  font-size: 12px;
  color: var(--destructive, oklch(0.62 0.19 25));
}

.skills-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  background: var(--muted);
  border: 1px solid var(--border);
  color: var(--foreground);
  cursor: pointer;
}

.skills-btn:hover { background: color-mix(in oklab, var(--muted) 70%, var(--foreground) 6%); }
.skills-btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--brand-foreground, white);
}

.skills-loading { font-size: 12px; color: var(--muted-foreground); padding: 8px 0; }

.skills-group { display: flex; flex-direction: column; gap: 4px; }

.skills-group-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
  margin-top: 4px;
}

.skills-empty { font-size: 12px; color: var(--muted-foreground); padding: 2px 0; }

.skill-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card);
}

.skill-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.skill-name { font-size: 13px; font-weight: 600; color: var(--foreground); }
.skill-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  white-space: normal;
  overflow-wrap: break-word;
}

.skill-path {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  border: none;
  background: transparent;
  padding: 0;
  cursor: pointer;
  color: var(--muted-foreground);
}

.skill-path svg { width: 11px; height: 11px; flex-shrink: 0; }

.skill-path-text {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.skill-path:hover .skill-path-text { text-decoration: underline; }

/* 危险图标按钮：对齐侧栏会话删除按钮（.tree-icon-button.danger）口径 */
.skill-delete {
  min-width: 24px;
  height: 24px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0 6px;
  border-radius: 999px;
  border: 1px solid color-mix(in oklab, var(--destructive) 22%, var(--border));
  background: color-mix(in oklab, var(--destructive) 8%, var(--background));
  color: var(--destructive);
  cursor: pointer;
  transition: background var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.skill-delete svg { width: 12px; height: 12px; flex: 0 0 auto; }
.skill-delete:hover { background: var(--destructive); color: #fff; border-color: var(--destructive); }

.skills-issues { font-size: 12px; color: var(--muted-foreground); }
.skills-issues summary { cursor: pointer; font-size: 12px; }
.skills-issues ul { margin: 6px 0 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
.skills-issue { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.skills-issue-type {
  font-size: 10.5px;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border);
  text-transform: uppercase;
}
.skills-issue-type.collision { color: var(--brand); border-color: var(--brand); }
.skills-issue-type.warning { color: oklch(0.72 0.14 85); border-color: currentColor; }
.skills-issue-type.error { color: var(--destructive, oklch(0.62 0.19 25)); border-color: currentColor; }
.skills-issue-path { font-family: var(--font-mono, monospace); font-size: 11px; word-break: break-all; }

/* 遮罩配方同 .up-confirm / .provider-form-overlay（设置页既有弹窗形态） */
.skills-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: var(--overlay);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--transition-base);
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.skills-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 420px;
  max-width: calc(100vw - 48px);
  padding: 22px 24px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-lg);
}

.skills-dialog.wide { width: 480px; max-height: calc(100vh - 96px); overflow-y: auto; }
.skills-dialog-title { font-size: 14px; font-weight: 600; color: var(--foreground); }
.skills-dialog-text { margin: 0; font-size: 12.5px; color: var(--muted-foreground); }

.skills-dialog-path {
  font-family: var(--font-mono, monospace);
  font-size: 11.5px;
  word-break: break-all;
  background: var(--muted);
  border-radius: var(--radius-md);
  padding: 6px 8px;
  color: var(--foreground);
}

.skills-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 4px;
}

.skills-dialog-actions .danger { background: var(--destructive, oklch(0.62 0.19 25)); border-color: transparent; color: white; }

.skills-field { display: flex; flex-direction: column; gap: 4px; font-size: 12.5px; color: var(--foreground); }
.skills-field em { font-style: normal; font-size: 11px; color: var(--muted-foreground); }
.skills-field input,
.skills-field textarea {
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  color: var(--foreground);
  padding: 6px 8px;
  font-size: 12.5px;
  font-family: inherit;
}

.skills-field textarea { resize: vertical; }

/* ghost/primary 是全局按钮样式，small 仅存在于 SettingsPanel scoped 块 —— 本组件弹窗按钮需自带 */
button.small {
  padding: 4px 12px;
  font-size: 12px;
}
</style>
