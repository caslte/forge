<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from '../bridge';
import { useToast } from '../composables/useToast';
import type { ThemeMode, ProviderItem } from '../types';

/**
 * 设置面板。
 * 模型配置采用「一条配置 = 一个模型」的直白形态：
 * - 每个 provider（底层仍是 provider，兼容 pi）只展示一个模型
 * - 字段：名称 / API 地址 / API Key / 模型 ID
 * - 「主会话模型」单选项：复用 setDefault，全局唯一
 * 底层 forge-core 契约不变（saveProvider 的 type 固定 openai-completions，models 传单元素数组）。
 */
const props = defineProps<{
  themeMode: ThemeMode;
}>();

const emit = defineEmits<{
  (e: 'theme-change', mode: ThemeMode): void;
  (e: 'close'): void;
}>();

// 模型 provider 数据
const providers = ref<ProviderItem[]>([]);
const models = ref<string[]>([]);
const defaultModel = ref<string | null>(null);
const loadingModels = ref(false);
const providerError = ref<string | null>(null);

// 添加/编辑配置表单
const showAddForm = ref(false);
const editingId = ref<string | null>(null);
const formName = ref('');
const formBaseUrl = ref('');
const formApiKey = ref('');
const formModel = ref('');
const saving = ref(false);
const formError = ref<string | null>(null);
const apiKeyVisible = ref(false);

// 删除两阶段确认
const deleteConfirmId = ref<string | null>(null);
let deleteTimer: ReturnType<typeof setTimeout> | null = null;

const themeSwatches: { mode: ThemeMode; label: string; color: string }[] = [
  { mode: 'light', label: '浅色', color: 'oklch(1 0 0)' },
  { mode: 'dark', label: '深色', color: 'oklch(0.24 0.01 286.3)' },
];

const toast = useToast();

const canSubmitForm = computed(() => {
  return (
    formName.value.trim().length > 0 &&
    formBaseUrl.value.trim().length > 0 &&
    formModel.value.trim().length > 0 &&
    !saving.value
  );
});

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
    // 固定 openai-completions 协议（与 pi models.json 一致），小白无需理解「类型」
    await call('model/saveProvider', {
      id: editingId.value ?? undefined,
      name: formName.value.trim(),
      type: 'openai-completions',
      baseUrl: formBaseUrl.value.trim() || null,
      apiKey: formApiKey.value.trim() || undefined,
      models: [formModel.value.trim()],
    });
    await loadProviders();
    await loadModels();
    resetForm();
    showAddForm.value = false;
    toast.success('模型配置已保存');
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

/** 点击列表「编辑」：回填表单进入编辑态（apiKey 由服务层解析为明文返回） */
function onEdit(p: ProviderItem): void {
  editingId.value = p.id;
  formName.value = p.name;
  formBaseUrl.value = p.baseUrl ?? '';
  formApiKey.value = p.apiKey ?? '';
  formModel.value = p.models[0] ?? '';
  formError.value = null;
  apiKeyVisible.value = false;
  showAddForm.value = true;
}

/** 打开新建表单 / 取消 */
function toggleForm(): void {
  if (showAddForm.value) {
    resetForm();
    showAddForm.value = false;
  } else {
    editingId.value = null;
    resetForm();
    showAddForm.value = true;
  }
}

function resetForm(): void {
  editingId.value = null;
  formName.value = '';
  formBaseUrl.value = '';
  formApiKey.value = '';
  formModel.value = '';
  formError.value = null;
  apiKeyVisible.value = false;
}

async function onDeleteProvider(id: string): Promise<void> {
  if (deleteConfirmId.value !== id) {
    deleteConfirmId.value = id;
    if (deleteTimer) clearTimeout(deleteTimer);
    deleteTimer = setTimeout(() => {
      deleteConfirmId.value = null;
    }, 3000);
    return;
  }
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

function onSetDefault(model: string): void {
  void (async () => {
    try {
      await call('model/setDefault', { model });
      await loadModels();
    } catch (e) {
      providerError.value = e instanceof Error ? e.message : String(e);
    }
  })();
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

function isDefault(model: string): boolean {
  return defaultModel.value === model;
}

function selectTheme(mode: ThemeMode): void {
  emit('theme-change', mode);
}

let unsubProviders: (() => void) | null = null;

onMounted(() => {
  void loadProviders();
  void loadModels();
  unsubProviders = subscribe('model.providersChanged', () => {
    void loadProviders();
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
        <p class="settings-subtitle">管理模型、界面外观</p>
      </div>
      <button class="ghost settings-close" aria-label="关闭设置" @click="emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <div class="settings-body">
      <!-- 模型配置 -->
      <section class="settings-section main">
        <div class="section-head">
          <div>
            <h2 class="section-title">模型配置</h2>
            <p class="section-desc">每个模型单独一条。选中的「主会话模型」用于当前对话。</p>
          </div>
          <button class="section-action" @click="toggleForm">
            <svg v-if="!showAddForm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            {{ showAddForm ? '取消' : '添加模型' }}
          </button>
        </div>

        <!-- 当前主会话模型（置于列表上方，模型多时不遮挡） -->
        <div v-if="defaultModel" class="default-model-row">
          <span class="default-model-label">当前主会话模型：</span>
          <span class="default-model-value">{{ defaultModel }}</span>
          <button class="ghost small" @click="onClearDefault">清除</button>
        </div>

        <!-- 添加/编辑表单 -->
        <div v-if="showAddForm" class="provider-form">
          <div class="form-head">
            <span class="form-head-title">{{ editingId ? '编辑模型' : '添加模型' }}</span>
          </div>
          <label class="form-field">
            <span class="form-label">名称</span>
            <input v-model="formName" type="text" placeholder="如 Grok、GPT、MiniMax" />
          </label>
          <label class="form-field">
            <span class="form-label">API 地址</span>
            <input v-model="formBaseUrl" type="text" placeholder="https://api.xxx.com/v1" />
          </label>
          <label class="form-field">
            <span class="form-label">API Key</span>
            <div class="api-key-wrap">
              <input
                v-model="formApiKey"
                :type="apiKeyVisible ? 'text' : 'password'"
                class="api-key-input"
                placeholder="sk-…（存入系统密钥链，不明文保存）"
              />
              <button
                type="button"
                class="api-key-toggle"
                :aria-label="apiKeyVisible ? '隐藏密钥' : '显示密钥'"
                :data-tooltip="apiKeyVisible ? '隐藏密钥' : '显示密钥'"
                @click="apiKeyVisible = !apiKeyVisible"
              >
                <svg v-if="apiKeyVisible" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          </label>
          <label class="form-field">
            <span class="form-label">模型 ID</span>
            <input v-model="formModel" type="text" placeholder="如 gpt-4o、grok-4.5" />
          </label>
          <div v-if="formError" class="form-error">{{ formError }}</div>
          <div class="form-actions">
            <button class="primary" :disabled="!canSubmitForm" @click="onSaveProvider">
              {{ saving ? '保存中…' : (editingId ? '保存修改' : '添加模型') }}
            </button>
          </div>
        </div>

        <!-- 模型列表 -->
        <div v-if="providerError" class="section-error">{{ providerError }}</div>
        <div v-if="providers.length === 0 && !loadingModels" class="empty-state">
          还没有模型，点击「添加模型」配置第一个
        </div>
        <div v-else-if="providers.length" class="provider-list">
          <div v-for="p in providers" :key="p.id" class="provider-item"
            :class="{ 'is-default': p.models[0] && isDefault(p.models[0]) }">
            <div class="provider-info">
              <div class="provider-name-row">
                <span class="provider-name">{{ p.name }}</span>
                <span v-if="p.models[0] && isDefault(p.models[0])" class="default-tag">主会话模型</span>
                <span v-if="p.lastError" class="provider-error-tag" :title="p.lastError">异常</span>
              </div>
              <div class="provider-meta">
                <span v-if="p.baseUrl" class="provider-baseurl">{{ p.baseUrl }}</span>
                <span v-else class="provider-baseurl muted">本地默认</span>
                <span class="provider-models-count">{{ p.models[0] ?? '—' }}</span>
              </div>
            </div>
            <div class="provider-actions">
              <button
                class="provider-default-btn"
                data-tooltip="编辑模型配置"
                @click="onEdit(p)"
              >编辑</button>
              <button
                v-if="p.models[0] && !isDefault(p.models[0])"
                class="provider-default-btn"
                data-tooltip="设为主会话模型"
                @click="onSetDefault(p.models[0])"
              >设为主会话</button>
              <button
                class="provider-delete"
                :class="{ confirming: deleteConfirmId === p.id }"
                :data-tooltip="deleteConfirmId === p.id ? '再次点击确认删除' : '删除'"
                @click="onDeleteProvider(p.id)"
              >
                {{ deleteConfirmId === p.id ? '确认删除' : '' }}
                <svg v-if="deleteConfirmId !== p.id" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="3 6 5 6 21 6" />
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 外观 -->
      <section class="settings-section aside">
        <h2 class="section-title">外观</h2>
        <p class="section-desc">切换浅色 / 深色主题</p>
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

/* 两栏布局：模型配置为主区，外观为右侧窄栏，减少留白 */
.settings-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 8px;
  display: grid;
  grid-template-columns: minmax(0, 1fr) 240px;
  gap: 24px;
  align-items: start;
}

.settings-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.settings-section.aside {
  gap: 12px;
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

.settings-section.aside .theme-swatches {
  flex-direction: column;
  gap: 8px;
}

.theme-swatch {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
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
  width: 40px;
  height: 28px;
  flex-shrink: 0;
  border-radius: var(--radius-md);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  position: relative;
}

.swatch-check {
  width: 16px;
  height: 16px;
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

/* 模型配置表单 */
.provider-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  background: color-mix(in oklab, var(--muted) 30%, var(--card));
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
}

.form-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
  min-width: 0;
}

.form-head {
  display: flex;
  align-items: center;
}

.form-head-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
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

.form-field input {
  width: 100%;
  font-size: 13px;
  font-family: var(--font-sans);
}

/* API Key：右侧眼睛切换明文/隐藏 */
.api-key-wrap {
  position: relative;
  width: 100%;
}

.api-key-wrap input {
  padding-right: 34px;
}

.api-key-toggle {
  position: absolute;
  top: 50%;
  right: 6px;
  transform: translateY(-50%);
  width: 26px;
  height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  cursor: pointer;
}

.api-key-toggle:hover {
  background: var(--muted);
  color: var(--foreground);
  border-color: transparent;
}

.api-key-toggle svg {
  width: 16px;
  height: 16px;
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

/* 模型列表 */
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  transition: border-color var(--transition-fast);
}

.provider-item:hover {
  border-color: color-mix(in oklab, var(--brand) 30%, var(--border));
}

.provider-item.is-default {
  border-color: var(--brand);
  background: color-mix(in oklab, var(--brand) 4%, var(--card));
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

.default-tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
  font-size: 11px;
  font-weight: 600;
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

.provider-models-count {
  font-family: var(--font-mono);
  font-size: 12px;
}

.provider-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.provider-default-btn {
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11.5px;
  font-weight: 500;
  background: var(--brand);
  color: var(--brand-foreground);
  border: 1px solid var(--brand);
}

.provider-default-btn:hover {
  background: var(--brand-hover);
  color: var(--brand-foreground);
  border-color: var(--brand-hover);
}

.provider-delete {
  flex-shrink: 0;
  height: 30px;
  padding: 0 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
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
}

.provider-delete.confirming:hover {
  background: color-mix(in oklab, var(--destructive) 85%, black);
  color: #fff;
}

/* 当前主会话模型 */
.default-model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 20%, var(--card));
  margin-top: 4px;
}

.default-model-label {
  font-size: 12px;
  color: var(--muted-foreground);
}

.default-model-value {
  font-family: var(--font-mono);
  font-size: 12.5px;
  color: var(--foreground);
  font-weight: 500;
}

button.small {
  padding: 4px 12px;
  font-size: 12px;
}
</style>