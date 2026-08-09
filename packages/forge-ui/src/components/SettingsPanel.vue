<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from '../bridge';
import type { ThemeMode, PermissionLevel, ProviderItem } from '../types';

/**
 * 设置面板。
 * 参考 ai-coding SettingsPanel 分区结构：外观 / 模型 Provider / 权限 / 关于。
 * Provider CRUD 直接走 bridge（model/queryProviderList、saveProvider、deleteProvider、
 * queryModels、setDefault），操作后后端发 model.providersChanged 事件，App.vue 监听
 * 该事件刷新会话侧模型列表，解耦。
 */
const props = defineProps<{
  themeMode: ThemeMode;
  permissionLevel: PermissionLevel;
}>();

const emit = defineEmits<{
  (e: 'theme-change', mode: ThemeMode): void;
  (e: 'permission-change', level: PermissionLevel): void;
  (e: 'close'): void;
}>();

// 模型 provider 数据
const providers = ref<ProviderItem[]>([]);
const models = ref<string[]>([]);
const defaultModel = ref<string | null>(null);
const loadingModels = ref(false);
const providerError = ref<string | null>(null);

// 添加 provider 表单
const showAddForm = ref(false);
const formName = ref('');
const formType = ref('openai');
const formBaseUrl = ref('');
const formApiKey = ref('');
const formModels = ref('');
const saving = ref(false);
const formError = ref<string | null>(null);

// 删除两阶段确认
const deleteConfirmId = ref<string | null>(null);
let deleteTimer: ReturnType<typeof setTimeout> | null = null;

const permissionLabels: Record<PermissionLevel, string> = {
  'default': '默认',
  'auto': '自动批准',
  'full-access': '完全访问',
};

const permissionDescs: Record<PermissionLevel, string> = {
  'default': '每次工具调用都需确认',
  'auto': '安全操作自动批准，危险操作仍需确认',
  'full-access': '所有操作自动执行，无需确认',
};

const themeSwatches: { mode: ThemeMode; label: string; color: string }[] = [
  { mode: 'light', label: '浅色', color: 'oklch(1 0 0)' },
  { mode: 'dark', label: '深色', color: 'oklch(0.24 0.01 286.3)' },
];

const formModelsList = computed(() =>
  formModels.value
    .split(/[,，\n]/)
    .map((m) => m.trim())
    .filter((m) => m.length > 0),
);

const canSubmitForm = computed(
  () =>
    formName.value.trim().length > 0 &&
    formType.value.trim().length > 0 &&
    formModelsList.value.length > 0 &&
    !saving.value,
);

async function loadProviders(): Promise<void> {
  try {
    const res = await call<{ providers: ProviderItem[] }>('model/queryProviderList');
    providers.value = res.providers;
    providerError.value = null;
  } catch (e) {
    providerError.value = e instanceof Error ? e.message : String(e);
  }
}

async function loadModels(): Promise<void> {
  loadingModels.value = true;
  try {
    const res = await call<{ models: string[]; defaultModel: string | null }>('model/queryModels');
    models.value = res.models;
    defaultModel.value = res.defaultModel;
  } catch (e) {
    // 静默，模型列表非关键
    models.value = [];
    defaultModel.value = null;
  } finally {
    loadingModels.value = false;
  }
}

async function onSaveProvider(): Promise<void> {
  if (!canSubmitForm.value) return;
  saving.value = true;
  formError.value = null;
  try {
    await call('model/saveProvider', {
      name: formName.value.trim(),
      type: formType.value.trim(),
      baseUrl: formBaseUrl.value.trim() || null,
      apiKey: formApiKey.value.trim() || undefined,
      models: formModelsList.value,
    });
    // 后端会发 providersChanged 事件，这里也主动刷新兜底
    await loadProviders();
    await loadModels();
    resetForm();
    showAddForm.value = false;
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

function resetForm(): void {
  formName.value = '';
  formType.value = 'openai';
  formBaseUrl.value = '';
  formApiKey.value = '';
  formModels.value = '';
  formError.value = null;
}

async function onDeleteProvider(id: string): Promise<void> {
  // 两阶段确认
  if (deleteConfirmId.value !== id) {
    deleteConfirmId.value = id;
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      deleteConfirmId.value = null;
    }, 3000);
    return;
  }
  // 确认删除
  if (deleteTimer) {
    clearTimeout(deleteTimer);
    deleteTimer = null;
  }
  deleteConfirmId.value = null;
  try {
    await call('model/deleteProvider', { id });
    await loadProviders();
    await loadModels();
  } catch (e) {
    providerError.value = e instanceof Error ? e.message : String(e);
  }
}

async function onSetDefault(model: string): Promise<void> {
  try {
    await call('model/setDefault', { model });
    await loadModels();
  } catch (e) {
    providerError.value = e instanceof Error ? e.message : String(e);
  }
}

function onClearDefault(): void {
  void (async () => {
    try {
      await call('model/setDefault', { model: null });
      await loadModels();
    } catch (e) {
      providerError.value = e instanceof Error ? e.message : String(e);
    }
  })();
}

function selectTheme(mode: ThemeMode): void {
  emit('theme-change', mode);
}

function selectPermission(level: PermissionLevel): void {
  emit('permission-change', level);
}

let unsubProviders: (() => void) | null = null;

onMounted(() => {
  void loadProviders();
  void loadModels();
  unsubProviders = subscribe('model.providersChanged', () => {
    void loadProviders();
    void loadModels();
  });
});

onUnmounted(() => {
  unsubProviders?.();
  if (deleteTimer) clearTimeout(deleteTimer);
});
</script>

<template>
  <div class="settings">
    <header class="settings-header">
      <div>
        <h1 class="settings-title">设置</h1>
        <p class="settings-subtitle">管理模型 Provider、界面外观与权限</p>
      </div>
      <button class="ghost settings-close" aria-label="关闭设置" @click="emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <div class="settings-body">
      <!-- 外观 -->
      <section class="settings-section">
        <h2 class="section-title">外观</h2>
        <p class="section-desc">切换浅色 / 深色主题，所有窗口立即生效</p>
        <div class="theme-swatches">
          <button
            v-for="t in themeSwatches"
            :key="t.mode"
            class="theme-swatch"
            :class="{ active: themeMode === t.mode }"
            @click="selectTheme(t.mode)"
          >
            <span class="swatch-color" :style="{ background: t.color }">
              <svg v-if="themeMode === t.mode" class="swatch-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span class="swatch-label">{{ t.label }}</span>
          </button>
        </div>
      </section>

      <!-- 模型 Provider -->
      <section class="settings-section">
        <div class="section-head">
          <div>
            <h2 class="section-title">模型 Provider</h2>
            <p class="section-desc">配置 API Provider 与可用模型，密钥安全存储于系统密钥链</p>
          </div>
          <button
            class="section-action"
            @click="showAddForm = !showAddForm; if (!showAddForm) resetForm()"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            {{ showAddForm ? '取消' : '添加' }}
          </button>
        </div>

        <!-- 添加表单 -->
        <div v-if="showAddForm" class="provider-form">
          <div class="form-row">
            <label class="form-field">
              <span class="form-label">名称 *</span>
              <input v-model="formName" type="text" placeholder="如 OpenAI" />
            </label>
            <label class="form-field">
              <span class="form-label">类型 *</span>
              <input v-model="formType" type="text" placeholder="如 openai / anthropic" />
            </label>
          </div>
          <label class="form-field">
            <span class="form-label">Base URL</span>
            <input v-model="formBaseUrl" type="text" placeholder="https://api.openai.com/v1（留空为本地默认）" />
          </label>
          <label class="form-field">
            <span class="form-label">API Key</span>
            <input v-model="formApiKey" type="password" placeholder="sk-...（存入系统密钥链，不明文落盘）" />
          </label>
          <label class="form-field">
            <span class="form-label">模型列表 * <span class="form-hint">（逗号或换行分隔）</span></span>
            <textarea
              v-model="formModels"
              rows="2"
              placeholder="gpt-4o, gpt-4o-mini, gpt-3.5-turbo"
            ></textarea>
          </label>
          <div v-if="formModelsList.length" class="form-models-preview">
            <span v-for="m in formModelsList" :key="m" class="model-chip">{{ m }}</span>
          </div>
          <div v-if="formError" class="form-error">{{ formError }}</div>
          <div class="form-actions">
            <button class="primary" :disabled="!canSubmitForm" @click="onSaveProvider">
              {{ saving ? '保存中…' : '保存 Provider' }}
            </button>
          </div>
        </div>

        <!-- provider 列表 -->
        <div v-if="providerError" class="section-error">{{ providerError }}</div>
        <div v-if="providers.length === 0 && !loadingModels" class="empty-state">
          暂无 Provider，点击「添加」配置第一个
        </div>
        <div v-else class="provider-list">
          <div v-for="p in providers" :key="p.id" class="provider-item">
            <div class="provider-info">
              <div class="provider-name-row">
                <span class="provider-name">{{ p.name }}</span>
                <span class="provider-type">{{ p.type }}</span>
                <span v-if="p.lastError" class="provider-error-tag" :title="p.lastError">异常</span>
              </div>
              <div class="provider-meta">
                <span v-if="p.baseUrl" class="provider-baseurl">{{ p.baseUrl }}</span>
                <span v-else class="provider-baseurl muted">本地默认</span>
                <span class="provider-models-count">{{ p.models.length }} 个模型</span>
              </div>
              <div class="provider-models">
                <span v-for="m in p.models" :key="m" class="model-chip small">{{ m }}</span>
              </div>
            </div>
            <button
              class="provider-delete"
              :class="{ confirming: deleteConfirmId === p.id }"
              :data-tooltip="deleteConfirmId === p.id ? '再次点击确认删除' : '删除 Provider'"
              @click="onDeleteProvider(p.id)"
            >
              {{ deleteConfirmId === p.id ? '确认' : '' }}
              <svg v-if="deleteConfirmId !== p.id" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="3 6 5 6 21 6" />
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
              </svg>
            </button>
          </div>
        </div>

        <!-- 默认模型 -->
        <div class="default-model-row">
          <label class="form-field inline">
            <span class="form-label">全局默认模型</span>
            <select
              class="default-model-select"
              :value="defaultModel ?? ''"
              @change="onSetDefault(($event.target as HTMLSelectElement).value)"
            >
              <option value="" disabled>未设置</option>
              <option v-for="m in models" :key="m" :value="m">{{ m }}</option>
            </select>
          </label>
          <button v-if="defaultModel" class="ghost small" @click="onClearDefault">清除</button>
        </div>
      </section>

      <!-- 权限 -->
      <section class="settings-section">
        <h2 class="section-title">权限级别</h2>
        <p class="section-desc">控制工具调用的自动批准范围（当前为前端状态，后端尚未实现权限拦截）</p>
        <div class="permission-options">
          <button
            v-for="lvl in (['default','auto','full-access'] as PermissionLevel[])"
            :key="lvl"
            class="permission-option"
            :class="{ active: permissionLevel === lvl }"
            @click="selectPermission(lvl)"
          >
            <span class="permission-radio">
              <span v-if="permissionLevel === lvl" class="permission-radio-dot"></span>
            </span>
            <span class="permission-text">
              <span class="permission-label">{{ permissionLabels[lvl] }}</span>
              <span class="permission-desc">{{ permissionDescs[lvl] }}</span>
            </span>
          </button>
        </div>
      </section>

      <!-- 关于 -->
      <section class="settings-section about">
        <h2 class="section-title">关于</h2>
        <dl class="about-list">
          <div class="about-row"><dt>应用</dt><dd>Forge</dd></div>
          <div class="about-row"><dt>运行时</dt><dd>Electron + Vue 3 + Vite</dd></div>
          <div class="about-row"><dt>内核</dt><dd>forge-core（mock pi 适配器）</dd></div>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped>
.settings {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 4px 18px;
  border-bottom: 1px solid var(--border);
  margin-bottom: 18px;
}

.settings-title {
  font-size: 20px;
  font-weight: 700;
  color: var(--foreground);
  letter-spacing: -0.01em;
}

.settings-subtitle {
  font-size: 12.5px;
  color: var(--muted-foreground);
  margin-top: 3px;
}

.settings-close {
  width: 32px;
  height: 32px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.settings-close svg {
  width: 17px;
  height: 17px;
}

.settings-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 8px;
  display: flex;
  flex-direction: column;
  gap: 26px;
  max-width: 720px;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}

.section-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.section-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.section-action {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  background: var(--muted);
  border: 1px solid var(--border);
  color: var(--foreground);
}

.section-action svg {
  width: 14px;
  height: 14px;
}

.section-action:hover {
  border-color: var(--brand);
  color: var(--brand);
  background: color-mix(in oklab, var(--brand) 6%, var(--background));
}

.section-error {
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, transparent);
  color: var(--destructive);
  font-size: 12.5px;
}

.empty-state {
  padding: 18px;
  text-align: center;
  color: var(--muted-foreground);
  font-size: 13px;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
}

/* 主题色板 */
.theme-swatches {
  display: flex;
  gap: 12px;
}

.theme-swatch {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 10px;
  border: 2px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.theme-swatch:hover {
  border-color: var(--muted-foreground);
}

.theme-swatch.active {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 6%, var(--card));
}

.swatch-color {
  width: 56px;
  height: 40px;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.swatch-check {
  width: 18px;
  height: 18px;
  color: var(--brand);
  filter: drop-shadow(0 0 3px rgba(255,255,255,0.6));
}

[data-theme='dark'] .swatch-check {
  color: oklch(0.9 0 0);
}

.swatch-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
}

/* provider 表单 */
.provider-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: color-mix(in oklab, var(--muted) 30%, var(--card));
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-row .form-field {
  flex: 1;
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.form-field.inline {
  flex-direction: row;
  align-items: center;
  gap: 10px;
}

.form-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--muted-foreground);
}

.form-hint {
  font-weight: 400;
  color: var(--muted-foreground);
  opacity: 0.7;
}

.form-field input,
.form-field textarea {
  width: 100%;
  font-size: 13px;
  font-family: var(--font-sans);
}

.form-field textarea {
  resize: vertical;
  min-height: 44px;
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.form-models-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 5px;
  margin-top: -4px;
}

.model-chip {
  display: inline-flex;
  align-items: center;
  padding: 2px 9px;
  background: color-mix(in oklab, var(--brand) 8%, var(--background));
  border: 1px solid color-mix(in oklab, var(--brand) 18%, transparent);
  border-radius: 999px;
  font-size: 11.5px;
  font-family: var(--font-mono);
  color: var(--foreground);
}

.model-chip.small {
  padding: 1px 7px;
  font-size: 11px;
  background: var(--muted);
  border-color: var(--border);
  color: var(--muted-foreground);
}

.form-error {
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in oklab, var(--destructive) 8%, transparent);
  color: var(--destructive);
  font-size: 12px;
}

.form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* provider 列表 */
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-item {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  transition: border-color var(--transition-fast);
}

.provider-item:hover {
  border-color: color-mix(in oklab, var(--brand) 30%, var(--border));
}

.provider-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 5px;
}

.provider-name-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.provider-type {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--info) 12%, transparent);
  color: var(--info);
  font-size: 11px;
  font-family: var(--font-mono);
}

.provider-error-tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--destructive) 14%, transparent);
  color: var(--destructive);
  font-size: 11px;
  font-weight: 600;
}

.provider-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 12px;
  color: var(--muted-foreground);
}

.provider-baseurl.muted {
  font-style: italic;
}

.provider-models {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 2px;
}

.provider-delete {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  padding: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--muted-foreground);
  font-size: 11px;
  font-weight: 600;
}

.provider-delete svg {
  width: 14px;
  height: 14px;
}

.provider-delete:hover {
  border-color: var(--destructive);
  color: var(--destructive);
  background: color-mix(in oklab, var(--destructive) 6%, var(--background));
}

.provider-delete.confirming {
  background: var(--destructive);
  color: #fff;
  border-color: var(--destructive);
  width: auto;
  padding: 0 10px;
}

.provider-delete.confirming:hover {
  background: color-mix(in oklab, var(--destructive) 85%, black);
}

/* 默认模型 */
.default-model-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 20%, var(--card));
  margin-top: 4px;
}

.default-model-row .form-field.inline {
  flex: 1;
}

.default-model-select {
  min-width: 200px;
}

button.small {
  padding: 4px 12px;
  font-size: 12px;
}

/* 权限 */
.permission-options {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.permission-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  cursor: pointer;
  text-align: left;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.permission-option:hover {
  border-color: color-mix(in oklab, var(--brand) 30%, var(--border));
}

.permission-option.active {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 5%, var(--card));
}

.permission-radio {
  width: 18px;
  height: 18px;
  border: 2px solid var(--border);
  border-radius: 999px;
  flex-shrink: 0;
  margin-top: 1px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color var(--transition-fast);
}

.permission-option.active .permission-radio {
  border-color: var(--brand);
}

.permission-radio-dot {
  width: 10px;
  height: 10px;
  border-radius: 999px;
  background: var(--brand);
}

.permission-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.permission-label {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--foreground);
}

.permission-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.45;
}

/* 关于 */
.about-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.about-row {
  display: flex;
  gap: 16px;
  padding: 8px 0;
  border-bottom: 1px solid color-mix(in oklab, var(--border) 50%, transparent);
}

.about-row dt {
  width: 80px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--muted-foreground);
}

.about-row dd {
  font-size: 13px;
  color: var(--foreground);
  font-family: var(--font-mono);
}
</style>
