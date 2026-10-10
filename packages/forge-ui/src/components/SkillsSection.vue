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
  if (importing.value) return;
  const dirs = await window.forge.dialog.selectDirectories();
  if (dirs === null || dirs.length === 0) return; // 用户取消系统对话框：无任何反馈（未发生操作）
  // 导入预览：逐个 skill/checkImport（与单个导入同源校验），无效项置灰不可勾选
  previewItems.value = dirs.map((dir) => ({
    dir,
    name: basenameOf(dir),
    status: 'checking' as const,
    conflictPath: null,
    reason: null,
    checked: true,
  }));
  showImportPreview.value = true;
  previewChecking.value = true;
  try {
    await Promise.all(
      previewItems.value.map(async (item) => {
        const res = await invokeRaw<CheckImportData>('skill/checkImport', { scope: 'user', sourceDir: item.dir });
        if (res.code !== 0 || res.data === null) {
          item.status = 'invalid';
          item.reason = res.message;
          item.checked = false;
          return;
        }
        item.status = res.data.status;
        item.conflictPath = res.data.conflictPath;
        item.reason = res.data.reason;
        if (res.data.status === 'invalid') item.checked = false; // 错误的不可选择
      }),
    );
  } finally {
    previewChecking.value = false;
  }
}

// ===== 导入预览（多选：选完后先校验，无效项禁选）=====

/** skill/checkImport 响应 data（与 forge-desktop CheckImportResult 同形） */
interface CheckImportData {
  status: 'ok' | 'conflict' | 'invalid';
  conflictPath: string | null;
  reason: string | null;
}

interface ImportPreviewItem {
  dir: string;
  name: string;
  status: 'checking' | 'ok' | 'conflict' | 'invalid';
  conflictPath: string | null;
  reason: string | null;
  checked: boolean;
}

const showImportPreview = ref(false);
const previewItems = ref<ImportPreviewItem[]>([]);
const previewChecking = ref(false);

const previewCheckedCount = computed(() => previewItems.value.filter((i) => i.checked).length);
const previewConfirmDisabled = computed(() => previewChecking.value || previewCheckedCount.value === 0);

function togglePreviewCheck(item: ImportPreviewItem, checked: boolean): void {
  if (item.status === 'invalid' || previewChecking.value) return;
  item.checked = checked;
}

/** 预览取消：什么都不导入 */
function cancelImportPreview(): void {
  showImportPreview.value = false;
  previewItems.value = [];
}

/** 预览确认：仅勾选项入队（冲突项在队列中再走 4090 覆盖确认） */
async function confirmImportPreview(): Promise<void> {
  if (previewConfirmDisabled.value) return;
  const dirs = previewItems.value.filter((i) => i.checked).map((i) => i.dir);
  cancelImportPreview();
  if (dirs.length === 0) return;
  importQueue.value = [...dirs];
  importStats.value = { ok: 0, skipped: 0, skippedNames: [] };
  importing.value = true;
  await processImportQueue();
}

// ===== 多选导入队列 =====

/**
 * 多选导入：逐个调 skill/importSkill（单目录接口，复用全部校验）。
 * 4090 冲突项挂起等用户确认（跳过 / 覆盖），其余继续；结束 toast 汇总。
 * 取消/关闭冲突弹窗 = 终止剩余队列（已完成项保留）。
 */
const importQueue = ref<string[]>([]);
const importing = ref(false);
const importStats = ref({ ok: 0, skipped: 0, skippedNames: [] as string[] });

/** 目录路径取末段（toast 标识用；含 / 与 \ 两种分隔符） */
function basenameOf(p: string): string {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return i >= 0 ? p.slice(i + 1) : p;
}

/** 导入结束汇总：全局单一 toast 会被后发覆盖，无效目录名并入汇总持续可见 */
function finishImportToast(): void {
  const { ok, skipped, skippedNames } = importStats.value;
  if (ok === 0 && skipped === 0) return;
  const preview = skippedNames.slice(0, 3).join('、') + (skippedNames.length > 3 ? ' 等' : '');
  toast.success(
    t('settings.skills.importSummary', { ok }) +
    (skipped > 0 ? t('settings.skills.importSkipSuffix', { skip: skipped, names: preview }) : ''),
  );
}

async function processImportQueue(): Promise<void> {
  while (importQueue.value.length > 0) {
    const dir = importQueue.value[0];
    if (dir === undefined) break; // noUncheckedIndexedAccess 防御（数组索引访问为 string | undefined）
    const res = await invokeRaw<{ path: string; overwritten?: boolean }>('skill/importSkill', {
      scope: 'user',
      sourceDir: dir,
    });
    if (res.code === 4090 && res.data !== null) {
      // 4090 信封 data 实为 SkillConflictData；挂起等确认，队列头不弹出
      const d = res.data as unknown as SkillConflictData;
      pendingOverwrite.value = { kind: 'import', conflictPath: d.conflictPath, params: { scope: 'user', sourceDir: dir } };
      return;
    }
    importQueue.value.shift();
    if (res.code !== 0) {
      importStats.value.skipped++;
      importStats.value.skippedNames.push(basenameOf(dir));
      toast.error(`${basenameOf(dir)}: ${res.message}`);
      continue;
    }
    importStats.value.ok++;
  }
  importing.value = false;
  finishImportToast();
  await refresh();
}

/** 冲突弹窗「跳过」：当前项不入库，继续队列 */
async function skipImportConflict(): Promise<void> {
  if (pendingOverwrite.value === null) return;
  pendingOverwrite.value = null;
  importQueue.value.shift();
  importStats.value.skipped++;
  await processImportQueue();
}

/** 冲突弹窗关闭（取消 / 点击遮罩）：终止剩余导入队列 */
function dismissOverwrite(): void {
  const wasImporting = pendingOverwrite.value?.kind === 'import' && importing.value;
  pendingOverwrite.value = null;
  if (!wasImporting) return;
  importQueue.value = [];
  importing.value = false;
  finishImportToast();
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
  if (pending.kind === 'create') {
    await runCreate(withOverwrite);
    return;
  }
  // import：覆盖当前队列头，继续余下队列
  const res = await invokeRaw<{ path: string; overwritten?: boolean }>('skill/importSkill', withOverwrite);
  importQueue.value.shift();
  if (res.code !== 0) {
    importStats.value.skipped++;
    toast.error(res.message);
  } else {
    importStats.value.ok++;
  }
  await processImportQueue();
}

// ===== 批量管理（批量删除）=====

const batchMode = ref(false);
const selectedPaths = ref<Set<string>>(new Set());
const batchDeleting = ref(false);
const showBatchConfirm = ref(false);

/** 批量删除确认弹窗清单：按展示顺序取所选条目（名称 + 目录路径） */
const selectedEntries = computed(() => skills.value.filter((s) => selectedPaths.value.has(s.dirPath)));
const selectedCount = computed(() => selectedPaths.value.size);

function toggleBatchMode(): void {
  batchMode.value = !batchMode.value;
  selectedPaths.value = new Set();
  showBatchConfirm.value = false;
}

function toggleSelect(dirPath: string, checked: boolean): void {
  const next = new Set(selectedPaths.value);
  if (checked) next.add(dirPath);
  else next.delete(dirPath);
  selectedPaths.value = next;
}

/** 全选/全不选（批量模式）：只作用于实际渲染的条目（全局 + 其它来源组；project 作用域不在 UI 展示） */
const renderedSkills = computed(() => [...userSkills.value, ...otherSkills.value]);
const allSelected = computed(
  () => renderedSkills.value.length > 0 && renderedSkills.value.every((s) => selectedPaths.value.has(s.dirPath)),
);

function toggleSelectAll(): void {
  selectedPaths.value = allSelected.value ? new Set() : new Set(renderedSkills.value.map((s) => s.dirPath));
}

/** 批量删除：逐条调既有 deleteSkill（复用 containment 校验 + 回收站回退）；失败不中断，汇总上报 */
async function confirmBatchDelete(): Promise<void> {
  if (batchDeleting.value || selectedEntries.value.length === 0) return;
  batchDeleting.value = true;
  const targets = selectedEntries.value;
  showBatchConfirm.value = false;
  let ok = 0;
  let trashed = 0;
  let failed = 0;
  for (const target of targets) {
    const res = await invokeRaw<{ trashed: boolean }>('skill/deleteSkill', { path: target.dirPath });
    if (res.code !== 0) {
      failed++;
      toast.error(`${target.name}: ${res.message}`);
      continue;
    }
    ok++;
    if (res.data?.trashed === true) trashed++;
  }
  batchDeleting.value = false;
  selectedPaths.value = new Set();
  if (ok > 0) {
    let msg = t('settings.skills.batchDeleted', { ok });
    if (trashed < ok) msg += t('settings.skills.batchPermSuffix', { perm: ok - trashed });
    if (failed > 0) msg += t('settings.skills.batchFailedSuffix', { failed });
    if (trashed < ok) toast.info(msg);
    else toast.success(msg);
  }
  if (failed === 0) batchMode.value = false; // 全部成功自动退出批量模式（页面还原整洁）
  await refresh();
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
        <template v-if="!batchMode">
          <button class="skills-btn skills-import-btn" :title="t('settings.skills.importTooltip')" :disabled="importing" @click="onImport">{{ t('settings.skills.import') }}</button>
          <button class="skills-btn primary" :disabled="importing" @click="openCreateForm">{{ t('settings.skills.create') }}</button>
          <button class="skills-btn skills-batch-manage-btn" :title="t('settings.skills.batchManageTooltip')" :disabled="importing" @click="toggleBatchMode">{{ t('settings.skills.batchManage') }}</button>
        </template>
        <template v-else>
          <button class="skills-btn skills-batch-manage-btn" :disabled="batchDeleting" @click="toggleBatchMode">{{ t('settings.skills.batchManageExit') }}</button>
          <button
            class="skills-btn skills-select-all-btn"
            :disabled="batchDeleting || renderedSkills.length === 0"
            @click="toggleSelectAll"
          >{{ allSelected ? t('settings.skills.selectAllNone') : t('settings.skills.selectAll') }}</button>
          <button class="skills-btn skills-batch-delete-btn" :disabled="selectedCount === 0 || batchDeleting" @click="showBatchConfirm = true">
            {{ t('settings.skills.batchDelete') }}{{ selectedCount > 0 ? ` (${selectedCount})` : '' }}
          </button>
        </template>
      </div>
    </div>

    <div v-if="loadError" class="skills-error">{{ loadError }}</div>

    <div v-if="loading" class="skills-loading">{{ t('settings.skills.loading') }}</div>

    <!-- 分组展示（全局 [+ 其他根]），组内按名称排序；每条带真实目录路径徽标 -->
    <div v-for="group in groups" :key="group.key" class="skills-group">
      <h3 class="skills-group-title">{{ group.label }}</h3>
      <div v-if="group.list.length === 0" class="skills-empty">{{ t('settings.skills.empty') }}</div>
      <div v-for="s in group.list" :key="s.dirPath" class="skill-row" :class="{ selected: batchMode && selectedPaths.has(s.dirPath) }">
        <input
          v-if="batchMode"
          type="checkbox"
          class="skill-check"
          :checked="selectedPaths.has(s.dirPath)"
          :aria-label="`${t('settings.skills.batchManage')}：${s.name}`"
          @change="toggleSelect(s.dirPath, ($event.target as HTMLInputElement).checked)"
        />
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
        <div v-if="!batchMode" class="skill-actions">
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
      <!-- 导入预览：系统窗口选完后先校验，无效项置灰禁选（校验口径 == 单个导入） -->
      <div v-if="showImportPreview" class="skills-overlay skills-preview-overlay" role="dialog" aria-modal="true" @click.self="cancelImportPreview">
        <div class="skills-dialog wide">
          <span class="skills-dialog-title">{{ t('settings.skills.previewTitle') }}</span>
          <p class="skills-dialog-text">{{ t('settings.skills.previewText') }}</p>
          <div class="skills-batch-list skills-preview-list">
            <label
              v-for="item in previewItems"
              :key="item.dir"
              class="skills-preview-item"
              :class="{ invalid: item.status === 'invalid' }"
            >
              <input
                type="checkbox"
                class="skill-check"
                :checked="item.checked"
                :disabled="item.status === 'invalid' || previewChecking"
                :title="item.reason ?? undefined"
                @change="togglePreviewCheck(item, ($event.target as HTMLInputElement).checked)"
              />
              <span class="skills-preview-name">{{ item.name }}</span>
              <span
                v-if="item.status === 'conflict'"
                class="skills-preview-badge conflict"
                :title="item.conflictPath ?? undefined"
              >{{ t('settings.skills.previewConflict') }}</span>
              <span v-else-if="item.status === 'invalid'" class="skills-preview-badge invalid" :title="item.reason ?? undefined">{{ t('settings.skills.previewInvalid') }}</span>
              <span v-else-if="item.status === 'ok'" class="skills-preview-badge ok">{{ t('settings.skills.previewOk') }}</span>
              <span v-else class="skills-preview-badge checking">{{ t('settings.skills.previewChecking') }}</span>
              <span class="skills-preview-path">{{ item.dir }}</span>
            </label>
          </div>
          <div class="skills-dialog-actions">
            <button class="ghost small" @click="cancelImportPreview">{{ t('common.cancel') }}</button>
            <button class="primary small skills-import-confirm" :disabled="previewConfirmDisabled" @click="confirmImportPreview">
              {{ t('settings.skills.previewImportSelected') }}{{ previewCheckedCount > 0 ? ` (${previewCheckedCount})` : '' }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="pendingOverwrite" class="skills-overlay skills-conflict-overlay" role="dialog" aria-modal="true" @click.self="dismissOverwrite">
        <div class="skills-dialog">
          <span class="skills-dialog-title">{{ t('settings.skills.importConflictTitle') }}</span>
          <p class="skills-dialog-text">{{ t('settings.skills.importConflictText') }}</p>
          <code class="skills-dialog-path">{{ pendingOverwrite.conflictPath }}</code>
          <div class="skills-dialog-actions">
            <button class="ghost small" @click="dismissOverwrite">{{ t('common.cancel') }}</button>
            <button v-if="importing" class="ghost small" @click="skipImportConflict">{{ t('settings.skills.conflictSkip') }}</button>
            <button class="primary small skills-conflict-overwrite" @click="confirmOverwrite">{{ t('settings.skills.overwriteConfirm') }}</button>
          </div>
        </div>
      </div>

      <!-- 批量删除确认：列出全部所选目录（移入回收站，可恢复） -->
      <div v-if="showBatchConfirm" class="skills-overlay skills-batch-overlay" role="dialog" aria-modal="true" @click.self="showBatchConfirm = false">
        <div class="skills-dialog">
          <span class="skills-dialog-title">{{ t('settings.skills.batchDeleteConfirmTitle') }}</span>
          <p class="skills-dialog-text">{{ t('settings.skills.batchDeleteConfirmText', { count: selectedCount }) }}</p>
          <div class="skills-batch-list">
            <code v-for="e in selectedEntries" :key="e.dirPath" class="skills-dialog-path skills-batch-item">{{ e.name }} — {{ e.dirPath }}</code>
          </div>
          <div class="skills-dialog-actions">
            <button class="ghost small" :disabled="batchDeleting" @click="showBatchConfirm = false">{{ t('common.cancel') }}</button>
            <button class="primary small danger" :disabled="batchDeleting" @click="confirmBatchDelete">{{ t('settings.skills.batchDeleteConfirmOk') }}</button>
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
.skills-btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.skills-btn[disabled]:hover { background: var(--muted); }
.skills-btn.primary[disabled]:hover { background: var(--brand); }
.skills-btn.primary[disabled] { opacity: 0.55; }
/* 批量删除按钮：危险口径（对齐 .skills-dialog-actions .danger） */
.skills-btn.skills-batch-delete-btn {
  background: var(--destructive, oklch(0.62 0.19 25));
  border-color: var(--destructive, oklch(0.62 0.19 25));
  color: white;
}
.skills-btn.skills-batch-delete-btn[disabled] { opacity: 0.45; }

/* 批量管理模式：行复选框 + 选中态高亮 */
.skill-check {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  accent-color: var(--destructive, oklch(0.62 0.19 25));
  cursor: pointer;
}
.skill-row.selected {
  background: color-mix(in oklab, var(--destructive, oklch(0.62 0.19 25)) 5%, var(--card));
  border-color: color-mix(in oklab, var(--destructive, oklch(0.62 0.19 25)) 30%, var(--border));
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
  flex: 1; /* 占满剩余宽度：批量模式下删除按钮隐藏，防 space-between 把短描述行挤到右缘（SK-BATCH-03） */
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

/* 批量删除确认清单：多目录可滚动（弹窗不撑破视口） */
.skills-batch-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
}
.skills-batch-list .skills-dialog-path { margin: 0; }

/* 导入预览清单：徽标三态（ok/conflict/invalid），invalid 整行置灰且复选框禁用 */
.skills-preview-list { gap: 8px; }
.skills-preview-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  cursor: pointer;
  min-width: 0;
}
.skills-preview-item.invalid {
  opacity: 0.55;
  cursor: not-allowed;
  background: var(--muted);
}
.skills-preview-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--foreground);
  flex-shrink: 0;
}
.skills-preview-item.invalid .skills-preview-name { color: var(--muted-foreground); }
.skills-preview-badge {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  white-space: nowrap;
}
.skills-preview-badge.ok { color: oklch(0.62 0.14 150); border-color: currentColor; }
.skills-preview-badge.conflict { color: oklch(0.72 0.14 85); border-color: currentColor; }
.skills-preview-badge.invalid { color: var(--destructive, oklch(0.62 0.19 25)); border-color: currentColor; }
.skills-preview-badge.checking { color: var(--muted-foreground); }
.skills-preview-path {
  font-family: var(--font-mono, monospace);
  font-size: 11px;
  color: var(--muted-foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  margin-left: auto;
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
