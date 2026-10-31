<script setup lang="ts">
/**
 * 插件 Tab（07 插件市场扩展）。
 *
 * 两段结构：
 * - 主面：已安装清单（内置标记不可卸 / 用户自装可卸）+ 「浏览插件库」入口
 * - 弹窗：插件库（搜索 + 已装标记 + 详情预览 + 安装），Teleport 到 body
 *
 * 为什么弹窗必须 Teleport：settings 区某祖先带 transform，fixed 遮罩会被裁剪
 * （与 SettingsPanel 模型表单、GitCommitDialog 同款处理）。
 *
 * 关键交互口径：
 * - 装/卸之后引擎侧**不会热加载**（解析与 import 只在启动时发生），所以成功一律
 *   提示「重启后生效」——不说这句，用户会以为装坏了。
 * - 失败必须回显 CLI 输出尾部：引擎对「装了但路径不存在」是静默跳过，UI 是用户
 *   唯一的信息来源（预装可以静默，市场不可以）。
 * - 内置项（预装清单内）不给卸载按钮：它们与内核行为耦合。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { invokeRaw } from '../bridge';
import type {
  PluginEntry,
  PluginInspectResult,
  PluginListResult,
  PluginMutateResult,
  PluginSearchItem,
  PluginSearchResult,
} from '../bridge';
import { useI18n } from '../i18n/index.ts';
import { useToast } from '../composables/useToast';

const { t } = useI18n();
const toast = useToast();

// ===== 已安装清单 =====

const loading = ref(false);
const loadError = ref<string | null>(null);
const installed = ref<PluginEntry[]>([]);

const builtinList = computed(() => installed.value.filter((p) => p.builtin));
const userList = computed(() => installed.value.filter((p) => !p.builtin));

/** 已装包名集合（弹窗里判「已安装」用；含内置） */
const installedNames = computed(() => new Set(installed.value.filter((p) => p.version !== null).map((p) => p.name)));

async function refresh(): Promise<void> {
  loading.value = true;
  loadError.value = null;
  try {
    const res = await invokeRaw<PluginListResult>('plugin/list', {});
    if (res.code !== 0 || res.data === null) {
      loadError.value = `${t('settings.plugins.errorLoad')}（${res.code}）: ${res.message}`;
      return;
    }
    installed.value = res.data.plugins;
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refresh();
});

// ===== 卸载 =====

const removingName = ref<string | null>(null);
const removeTarget = ref<PluginEntry | null>(null);

function askRemove(entry: PluginEntry): void {
  if (removingName.value !== null) return;
  removeTarget.value = entry;
}

async function confirmRemove(): Promise<void> {
  const target = removeTarget.value;
  if (target === null) return;
  removeTarget.value = null;
  removingName.value = target.name;
  try {
    const res = await invokeRaw<PluginMutateResult>('plugin/remove', { name: target.name });
    if (res.code !== 0) {
      toast.error(res.message);
      return;
    }
    toast.success(t('settings.plugins.removed', { name: target.name }));
    await refresh();
  } finally {
    removingName.value = null;
  }
}

// ===== 插件库弹窗 =====

const showMarket = ref(false);
const query = ref('');
const searching = ref(false);
const searchError = ref<string | null>(null);
const searchItems = ref<PluginSearchItem[]>([]);
const searchTotal = ref(0);
const hasSearched = ref(false);

/** 当前选中项（右侧详情面板数据源） */
const selected = ref<string | null>(null);
const inspecting = ref(false);
const inspectError = ref<string | null>(null);
const detail = ref<PluginInspectResult | null>(null);
/** 手动输入安装（搜索无结果时兜底：用户知道包名就能装） */
const manualSpec = ref('');

const installing = ref<string | null>(null);
const installOutput = ref<string | null>(null);
const installFailed = ref(false);

/** 弹窗打开即拉一次默认列表（keywords:pi-package 的推荐集合） */
watch(showMarket, (v) => {
  if (!v) return;
  if (!hasSearched.value) void runSearch('');
});

/** 关弹窗时清掉临时态，避免下次带着上次的选中/错误 */
function closeMarket(): void {
  showMarket.value = false;
  selected.value = null;
  detail.value = null;
  inspectError.value = null;
  installOutput.value = null;
  installFailed.value = false;
}

async function runSearch(keyword: string): Promise<void> {
  searching.value = true;
  searchError.value = null;
  try {
    const res = await invokeRaw<PluginSearchResult>('plugin/search', { query: keyword, size: 30 });
    if (res.code !== 0 || res.data === null) {
      searchError.value = `${t('settings.plugins.errorSearch')}（${res.code}）: ${res.message}`;
      return;
    }
    // 后端对网络失败不抛错，而是回 error 字段 —— 这里降级展示，不让列表白屏
    if (res.data.error !== null) {
      searchError.value = res.data.error;
      searchItems.value = [];
      searchTotal.value = 0;
      return;
    }
    searchItems.value = res.data.items;
    searchTotal.value = res.data.total;
    hasSearched.value = true;
  } finally {
    searching.value = false;
  }
}

function onSearchSubmit(): void {
  void runSearch(query.value.trim());
}

async function pick(name: string, force = false): Promise<void> {
  // 同项重复点击不重拉；但装/卸之后必须强制重拉（installed 状态变了，详情要跟着变）
  if (!force && selected.value === name && detail.value !== null) return;
  selected.value = name;
  detail.value = null;
  inspectError.value = null;
  installOutput.value = null;
  installFailed.value = false;
  inspecting.value = true;
  try {
    const res = await invokeRaw<PluginInspectResult>('plugin/inspect', { name });
    if (res.code !== 0 || res.data === null) {
      inspectError.value = res.message;
      return;
    }
    detail.value = res.data;
  } finally {
    inspecting.value = false;
  }
}

/** 手动装：spec 走同一套后端校验（只接受 npm 包名，统一补 npm: 前缀） */
function installManual(): void {
  const spec = manualSpec.value.trim();
  if (spec === '') return;
  void doInstall(spec);
}

async function doInstall(name: string): Promise<void> {
  if (installing.value !== null) return;
  installing.value = name;
  installOutput.value = null;
  installFailed.value = false;
  try {
    const res = await invokeRaw<PluginMutateResult>('plugin/install', { name });
    if (res.code !== 0) {
      installFailed.value = true;
      installOutput.value = res.data?.output ?? res.message;
      toast.error(res.message);
      return;
    }
    installOutput.value = res.data?.output ?? '';
    toast.success(t('settings.plugins.installedRestart', { name }));
    await refresh();
    // force：装完 installed 状态已变，详情必须重拉（否则按钮还停在「安装」）
    if (selected.value === name) await pick(name, true);
  } finally {
    installing.value = null;
  }
}

/** 体积展示（registry 未提供时显示「—」） */
function formatSize(bytes: number | null): string {
  if (bytes === null) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** 日期只取 YYYY-MM-DD（registry 给的是 ISO 串） */
function formatDate(iso: string | null): string {
  if (iso === null) return '—';
  return iso.slice(0, 10);
}

function isInstalled(name: string): boolean {
  return installedNames.value.has(name);
}
</script>

<template>
  <section class="settings-section plugins-section">
    <!-- 已安装 -->
    <div class="plugins-head">
      <h2 class="plugins-title">{{ t('settings.plugins.title') }}</h2>
      <button class="plugins-btn" :disabled="loading" @click="refresh">{{ t('settings.plugins.refresh') }}</button>
    </div>
    <p class="plugins-desc">{{ t('settings.plugins.desc') }}</p>

    <div v-if="loadError !== null" class="plugins-error">{{ loadError }}</div>
    <div v-else-if="loading" class="plugins-loading">{{ t('settings.plugins.loading') }}</div>

    <template v-else>
      <div v-if="installed.length === 0" class="plugins-empty">{{ t('settings.plugins.empty') }}</div>
      <div v-for="p in installed" :key="p.name" class="plugin-row">
        <div class="plugin-text">
          <span class="plugin-name">{{ p.name }}</span>
          <span class="plugin-meta">
            <template v-if="p.version !== null">v{{ p.version }}</template>
            <template v-else>{{ t('settings.plugins.notInstalled') }}</template>
          </span>
        </div>
        <span v-if="p.builtin" class="plugin-tag builtin">{{ t('settings.plugins.builtin') }}</span>
        <button
          v-else
          class="plugins-btn danger"
          :disabled="removingName !== null"
          @click="askRemove(p)"
        >{{ removingName === p.name ? t('settings.plugins.removing') : t('settings.plugins.remove') }}</button>
      </div>
    </template>

    <!-- 浏览入口 -->
    <div class="plugins-browse">
      <div class="plugins-browse-text">
        <span class="plugins-browse-title">{{ t('settings.plugins.browseTitle') }}</span>
        <span class="plugins-browse-desc">{{ t('settings.plugins.browseDesc') }}</span>
      </div>
      <button class="plugins-btn primary" @click="showMarket = true">{{ t('settings.plugins.browseAction') }}</button>
    </div>

    <!-- 卸载确认 -->
    <Teleport to="body">
      <div v-if="removeTarget !== null" class="plugins-overlay" role="dialog" aria-modal="true" @click.self="removeTarget = null">
        <div class="plugins-dialog small">
          <h3 class="plugins-dialog-title">{{ t('settings.plugins.confirmRemoveTitle', { name: removeTarget.name }) }}</h3>
          <p class="plugins-dialog-desc">{{ t('settings.plugins.confirmRemoveDesc') }}</p>
          <div class="plugins-dialog-actions">
            <button class="ghost small" @click="removeTarget = null">{{ t('common.cancel') }}</button>
            <button class="primary small danger-solid" @click="confirmRemove">{{ t('settings.plugins.remove') }}</button>
          </div>
        </div>
      </div>
    </Teleport>

    <!-- 插件库弹窗 -->
    <Teleport to="body">
      <div v-if="showMarket" class="plugins-overlay" role="dialog" aria-modal="true" @click.self="closeMarket">
        <div class="market-dialog">
          <header class="market-head">
            <h3 class="market-title">{{ t('settings.plugins.marketTitle') }}</h3>
            <span class="market-count">{{ t('settings.plugins.marketCount', { total: searchTotal }) }}</span>
            <button class="market-close" :aria-label="t('common.close')" @click="closeMarket">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </header>

          <div class="market-search">
            <input
              v-model="query"
              class="market-input"
              :placeholder="t('settings.plugins.searchPlaceholder')"
              @keydown.enter="onSearchSubmit"
            />
            <button class="plugins-btn primary" :disabled="searching" @click="onSearchSubmit">
              {{ searching ? t('settings.plugins.searching') : t('settings.plugins.search') }}
            </button>
          </div>

          <div v-if="searchError !== null" class="plugins-error market-error">{{ searchError }}</div>

          <div class="market-body">
            <div class="market-list">
              <div v-if="searching" class="plugins-loading">{{ t('settings.plugins.searching') }}</div>
              <div v-else-if="searchItems.length === 0 && hasSearched" class="plugins-empty">
                {{ t('settings.plugins.noResult') }}
              </div>
              <button
                v-for="item in searchItems"
                :key="item.name"
                class="market-card"
                :class="{ selected: selected === item.name }"
                @click="pick(item.name)"
              >
                <span class="market-card-name">{{ item.name }}</span>
                <span class="market-card-desc">{{ item.description }}</span>
                <span class="market-card-meta">
                  <span>v{{ item.version }}</span>
                  <span>{{ formatDate(item.updatedAt) }}</span>
                  <span v-if="isInstalled(item.name)" class="plugin-tag installed">{{ t('settings.plugins.installedTag') }}</span>
                </span>
              </button>
            </div>

            <aside class="market-side">
              <!-- 手动安装：搜索不中也能装 -->
              <div class="market-manual">
                <span class="market-manual-label">{{ t('settings.plugins.manualLabel') }}</span>
                <div class="market-manual-row">
                  <input
                    v-model="manualSpec"
                    class="market-input"
                    :placeholder="t('settings.plugins.manualPlaceholder')"
                    @keydown.enter="installManual"
                  />
                  <button class="plugins-btn" :disabled="installing !== null" @click="installManual">{{ t('settings.plugins.install') }}</button>
                </div>
              </div>

              <div v-if="inspecting" class="plugins-loading">{{ t('settings.plugins.loading') }}</div>
              <div v-else-if="inspectError !== null" class="plugins-error">{{ inspectError }}</div>
              <template v-else-if="detail !== null">
                <span class="market-side-name">{{ detail.name }}</span>
                <dl class="market-kv">
                  <dt>{{ t('settings.plugins.fieldVersion') }}</dt><dd>{{ detail.version }}</dd>
                  <dt>{{ t('settings.plugins.fieldSize') }}</dt><dd>{{ formatSize(detail.unpackedSize) }}</dd>
                  <dt>{{ t('settings.plugins.fieldLicense') }}</dt><dd>{{ detail.license ?? '—' }}</dd>
                  <dt>{{ t('settings.plugins.fieldUpdated') }}</dt><dd>{{ formatDate(detail.updatedAt) }}</dd>
                </dl>
                <p class="market-side-desc">{{ detail.description }}</p>
                <div v-if="detail.keywords.length > 0" class="market-kw">
                  <span v-for="k in detail.keywords.slice(0, 8)" :key="k">{{ k }}</span>
                </div>
                <p v-if="detail.builtin" class="market-hint">{{ t('settings.plugins.builtinHint') }}</p>
                <p v-else-if="detail.installed" class="market-hint ok">{{ t('settings.plugins.installedHint') }}</p>
                <p v-else class="market-hint">{{ t('settings.plugins.restartHint') }}</p>
                <button
                  v-if="!detail.installed && !detail.builtin"
                  class="plugins-btn primary full"
                  :disabled="installing !== null"
                  @click="doInstall(detail.name)"
                >{{ installing === detail.name ? t('settings.plugins.installing') : t('settings.plugins.install') }}</button>
              </template>
              <p v-else class="market-hint">{{ t('settings.plugins.pickHint') }}</p>

              <pre v-if="installOutput !== null" class="market-output" :class="{ failed: installFailed }">{{ installOutput }}</pre>
            </aside>
          </div>
        </div>
      </div>
    </Teleport>
  </section>
</template>

<style scoped>
.plugins-section {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plugins-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.plugins-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.plugins-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.plugins-btn {
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
  flex-shrink: 0;
}

.plugins-btn:hover { background: color-mix(in oklab, var(--muted) 70%, var(--foreground) 6%); }

.plugins-btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--brand-foreground, white);
}

.plugins-btn.danger {
  background: transparent;
  border-color: color-mix(in oklab, var(--destructive) 30%, var(--border));
  color: var(--destructive);
}

.plugins-btn[disabled] { opacity: 0.45; cursor: not-allowed; }

.plugins-btn.full { width: 100%; justify-content: center; margin-top: 8px; }

.plugins-error {
  font-size: 12px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--destructive) 8%, var(--card));
  border: 1px solid color-mix(in oklab, var(--destructive) 24%, transparent);
  color: var(--destructive);
}

.plugins-loading,
.plugins-empty {
  font-size: 12px;
  color: var(--muted-foreground);
  padding: 8px 0;
}

.plugin-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 9px 11px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card);
}

.plugin-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.plugin-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  word-break: break-all;
}

.plugin-meta {
  font-size: 11.5px;
  color: var(--muted-foreground);
}

.plugin-tag {
  font-size: 11px;
  border-radius: 999px;
  padding: 1px 9px;
  flex-shrink: 0;
  border: 1px solid var(--border);
  color: var(--muted-foreground);
}

.plugin-tag.installed {
  border-color: color-mix(in oklab, var(--brand-accent) 40%, transparent);
  color: var(--brand-accent);
}

.plugins-browse {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-top: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 40%, var(--card));
}

.plugins-browse-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }

.plugins-browse-title { font-size: 13px; font-weight: 600; color: var(--foreground); }

.plugins-browse-desc { font-size: 11.5px; color: var(--muted-foreground); line-height: 1.5; }

/* ===== 弹窗 ===== */

.plugins-overlay {
  position: fixed;
  inset: 0;
  background: color-mix(in oklab, black 42%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  /* 2000 = 项目弹窗统一层级（GitCommitDialog / ExitConfirmDialog / SkillsSection 同值）。
     必须高于 shell-topstrip 的 205 拖拽区，否则窗口左上角那段点不到弹窗。 */
  z-index: 2000;
}

.plugins-dialog {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  padding: 18px;
  width: 380px;
  max-width: 100%;
}

.plugins-dialog-title { font-size: 14px; font-weight: 600; color: var(--foreground); margin-bottom: 6px; }

.plugins-dialog-desc { font-size: 12.5px; color: var(--muted-foreground); line-height: 1.6; margin-bottom: 14px; }

.plugins-dialog-actions { display: flex; justify-content: flex-end; gap: 8px; }

.danger-solid { background: var(--destructive); border-color: var(--destructive); color: white; }

.market-dialog {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  width: 860px;
  max-width: 100%;
  height: 620px;
  max-height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.market-head {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.market-title { font-size: 15px; font-weight: 600; color: var(--foreground); }

.market-count { font-size: 11.5px; color: var(--muted-foreground); }

/* 与 GitCommitDialog 的 .dialog-close 同款：透明底 + 静默色图标，hover 才提亮。
   不要用 --muted 当底——深色主题下 --muted 与图标色（--foreground）对比过低，
   看起来像「按钮是空的」。 */
.market-close {
  margin-left: auto;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.market-close:hover {
  background: var(--muted);
  color: var(--foreground);
}

.market-close svg { width: 16px; height: 16px; flex: 0 0 auto; display: block; }

.market-search {
  display: flex;
  gap: 8px;
  padding: 12px 18px;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.market-input {
  flex: 1;
  min-width: 0;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 7px 11px;
  font-size: 13px;
  color: var(--foreground);
  font-family: inherit;
}

.market-error { margin: 10px 18px 0; }

.market-body {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 300px;
}

.market-list {
  overflow-y: auto;
  padding: 12px 16px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 8px;
  align-content: start;
}

.market-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--card);
  cursor: pointer;
  text-align: left;
  font-family: inherit;
}

.market-card:hover { border-color: color-mix(in oklab, var(--brand) 30%, var(--border)); }

.market-card.selected {
  border-color: color-mix(in oklab, var(--brand) var(--select-ring-pct, 78%), var(--border));
  background: color-mix(in oklab, var(--brand) var(--select-bg-pct, 10%), var(--card));
}

.market-card-name {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--foreground);
  word-break: break-all;
}

.market-card-desc {
  font-size: 11.5px;
  color: var(--muted-foreground);
  line-height: 1.45;
  flex: 1;
}

.market-card-meta {
  display: flex;
  gap: 8px;
  align-items: center;
  font-size: 10.5px;
  color: var(--muted-foreground);
}

.market-side {
  border-left: 1px solid var(--border);
  padding: 12px 14px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}

.market-manual { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }

.market-manual-label { font-size: 11.5px; color: var(--muted-foreground); }

.market-manual-row { display: flex; gap: 6px; }

.market-side-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--foreground);
  word-break: break-all;
  margin-bottom: 8px;
}

.market-kv { display: grid; grid-template-columns: 56px 1fr; gap: 3px 8px; margin: 0 0 8px; }

.market-kv dt { font-size: 11.5px; color: var(--muted-foreground); }

.market-kv dd { font-size: 11.5px; color: var(--foreground); margin: 0; word-break: break-all; }

.market-side-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.6;
  padding-top: 8px;
  border-top: 1px solid var(--border);
  margin-bottom: 8px;
}

.market-kw { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }

.market-kw span {
  font-size: 10px;
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 6px;
  color: var(--muted-foreground);
  background: var(--muted);
}

.market-hint {
  font-size: 11.5px;
  color: var(--muted-foreground);
  line-height: 1.55;
  margin-bottom: 6px;
}

.market-hint.ok { color: var(--brand-accent); }

.market-output {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  line-height: 1.6;
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 8px 10px;
  margin-top: 8px;
  max-height: 160px;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-all;
  color: var(--muted-foreground);
}

.market-output.failed {
  border-color: color-mix(in oklab, var(--destructive) 30%, transparent);
  color: var(--destructive);
}
</style>
