<script lang="ts">
/**
 * 模块级「已 toast 版本」记忆：SettingsPanel 随设置视图 v-if 挂载/卸载，
 * 发现新版本的 toast 需跨面板重开去重（同版本只提示一次）。
 */
let lastNotifiedUpVersion: string | null = null;
</script>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
// 从瘦 subpath 导入：@forge/core 根入口 re-export 含 node:events 的 RPC 层，浏览器打包会炸
import { DEFAULT_THINKING_LEVELS, THINKING_LEVELS } from '@forge/core/model';
import { call, subscribe } from '../bridge';
import type { PiGetInfoResult, UpdaterSnapshot } from '../bridge';
import { useToast } from '../composables/useToast';
import { usePreferences } from '../composables/usePreferences';
import type { ThemeMode, ProviderItem, ThinkingLevel } from '../types';

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
/** MP-S06：上下文窗口 1M 勾选（勾选写 1000000，未勾选移除字段） */
const formContext1M = ref(false);
/** 多模态勾选：勾选写模型记录 input:["text","image"]，未勾选移除字段（回退 pi 默认纯文本） */
const formVision = ref(false);
/** MP-S07：思考强度勾选（勾选写 reasoning:true，未勾选写 reasoning:false） */
const formReasoning = ref(false);
/** MP-S07：思考等级白名单（多选下拉；选中项写 thinkingLevelMap 非 null；off 不展示，恒可用） */
const formLevels = ref<ThinkingLevel[]>([...DEFAULT_THINKING_LEVELS]);
const levelMenuOpen = ref(false);
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
const { showDiff, setShowDiff } = usePreferences();

const canSubmitForm = computed(() => {
  return (
    formName.value.trim().length > 0 &&
    formBaseUrl.value.trim().length > 0 &&
    formModel.value.trim().length > 0 &&
    !saving.value
  );
});

/** MP-S07：多选下拉可选项（除去 off：off 是默认态，不展示，保存时始终写入） */
const levelOptions: ThinkingLevel[] = THINKING_LEVELS.filter((l) => l !== 'off');

/** MP-S07：多选下拉触发器文案（未启用思考/空选/已选列表；off 不展示） */
const selectedLevelsLabel = computed(() => {
  if (!formReasoning.value) {
    return '未启用思考';
  }
  const shown = formLevels.value.filter((l) => l !== 'off');
  if (shown.length === 0) {
    return '未选择思考等级';
  }
  return shown.join(' / ');
});

/** MP-S07：勾选/取消某思考等级（off 不展示；按固定顺序排序） */
function toggleLevel(l: ThinkingLevel): void {
  const arr = formLevels.value;
  const next = arr.includes(l) ? arr.filter((x) => x !== l) : [...arr, l];
  formLevels.value = next.sort((a, b) => THINKING_LEVELS.indexOf(a) - THINKING_LEVELS.indexOf(b));
}

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
      // 一律按勾选覆盖：勾选写 1000000，未勾选传 null（服务层移除字段，MP-S06）
      contextWindow: formContext1M.value ? 1000000 : null,
      // 多模态：一律按勾选覆盖（服务层写/移除 input 字段）
      vision: formVision.value,
      // MP-S07：思考强度开关 + 思考等级白名单（off 写 null 隐藏，对话框不出现在关闭思考挡位；未启用思考时移除 thinkingLevelMap）
      reasoning: formReasoning.value,
      thinkingLevels: formReasoning.value ? [...formLevels.value] : null,
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
  // 防御：若服务层未解析成功仍返回引用形式（$ENV / !command），不回填占位符
  // 避免用户无改动保存时把占位符当新明文存入 vault（MiniMax-M3 回归）
  const rawKey = p.apiKey ?? '';
  formApiKey.value = rawKey !== '' && /^[!$]/.test(rawKey) ? '' : rawKey;
  formModel.value = p.models[0] ?? '';
  // MP-S06 回显：仅严格等于 1000000 时勾选；缺失/非数字/其他值一律未勾选
  formContext1M.value = p.contextWindow === 1000000;
  // 多模态回显：首模型 input 含 "image" 即勾选
  formVision.value = p.vision === true;
  // MP-S07 回显：思考强度按 reasoning 字段；白名单按推导的 thinkingLevels（缺省/空回退默认集；过滤 off——off 不参与配置，写 null 隐藏）
  formReasoning.value = p.reasoning === true;
  const storedLevels = (p.thinkingLevels ?? []).filter((l) => l !== 'off');
  formLevels.value = [...storedLevels];
  if (storedLevels.length === 0) {
    formLevels.value = [...DEFAULT_THINKING_LEVELS];
  }
  levelMenuOpen.value = false;
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
  formContext1M.value = false;
  formVision.value = false;
  formReasoning.value = false;
  formLevels.value = [...DEFAULT_THINKING_LEVELS];
  levelMenuOpen.value = false;
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

// ===== 版本更新（07，「关于」Tab）：明面为 forge 产品更新；内部为内置引擎的共享扩展更新 =====
// 组件明细不回传 UI（原型确认 2026-09-08）：变更走结构化日志 + updater-state components 快照
const activeTab = ref<'general' | 'personal' | 'about'>('general');
const tabsEl = ref<HTMLElement | null>(null);
const thumbEl = ref<HTMLElement | null>(null);
const tabBtns = { general: null as HTMLElement | null, personal: null as HTMLElement | null, about: null as HTMLElement | null };

function setTabRef(name: 'general' | 'personal' | 'about', el: unknown): void {
  tabBtns[name] = (el as HTMLElement) ?? null;
}

/** 滑动选中块：贴齐当前 Tab 的位置与宽度（水滴/果冻式：前后边错时启停） */
let thumbLeft = -1;
let thumbInit = false;

function moveThumb(): void {
  const btn = tabBtns[activeTab.value];
  const wrap = tabsEl.value;
  const thumb = thumbEl.value;
  if (!btn || !wrap || !thumb) return;
  const l = btn.offsetLeft;
  const r = wrap.clientWidth - (l + btn.offsetWidth);
  // 方向决定两条边谁先动：向右滑右边先行、左边延迟追随；向左滑反之——
  // 途中滑块被拉成水滴，落位时两头先后回弹（时序在 CSS transition 里定义）
  thumb.classList.toggle('thumb-lb', l < thumbLeft);
  thumbLeft = l;
  if (!thumbInit) {
    // 首次定位直接落位，不做开场滑动动画
    thumbInit = true;
    thumb.style.transition = 'none';
    thumb.style.left = `${l}px`;
    thumb.style.right = `${r}px`;
    requestAnimationFrame(() => {
      thumb.style.transition = '';
    });
    return;
  }
  thumb.style.left = `${l}px`;
  thumb.style.right = `${r}px`;
}

watch(activeTab, () => { void nextTick(moveThumb); });

function onResize(): void { moveThumb(); }

const forgeVersion = ref<string | null>(null);

async function loadPiInfo(): Promise<void> {
  try {
    const res = await call<PiGetInfoResult>('pi/getInfo');
    forgeVersion.value = res.forgeVersion;
  } catch {
    // 静默降级：版本显示「—」
  }
}

// ===== 应用自更新（07 IN-S03）：发现新版 toast 一次 + 分区常驻；检查/下载/安装失败静默可重试 =====
// 快照镜像：updater.stateChanged 到达即整体替换；失败（6003/6004/6005）不弹窗、不出现红色报错横幅
const upSnapshot = ref<UpdaterSnapshot | null>(null);
/** 检查在途本地标记（checkForUpdates invoke 往返；状态跃迁本身经事件推送） */
const upChecking = ref(false);
/** 「重启安装」确认弹窗显隐（fixed 遮罩 + 居中 box，IN-F03 弹窗确认语义） */
const upConfirming = ref(false);
/** quitAndInstall 在途标记（确认安装按钮 busy） */
const upInstalling = ref(false);
/** 安装失败（6005）后本地回到 downloaded 可重试态（后端 fail 收敛为 idle，快照仅保留 latestVersion） */
const upInstallRetry = ref(false);
/** 检查完成且无新版本：版本行内显示「✓ 已是最新」徽标（按钮仍保留，可再次手动检查） */
const upCheckedUpToDate = ref(false);

/**
 * 快照落位 + 派生反应。
 * - 发现新版本（status=found）：toast.info 一次，同版本不重复（记忆在模块级，跨面板重开不重复）。
 * - 离开 downloaded 态收起确认条；新检查/下载周期开始清除安装重试标记。
 */
function applyUpSnapshot(snap: UpdaterSnapshot | null | undefined): void {
  if (!snap || typeof snap.status !== 'string') return;
  upSnapshot.value = snap;
  // 调试日志：每次状态快照落位（事件推送 / invoke 返回）记录迁移与错误文本
  upLog(
    `state=${snap.status} current=${snap.currentVersion} latest=${snap.latestVersion ?? '-'}` +
      ` progress=${snap.downloadProgress ?? '-'}` +
      (snap.error ? ` error=${snap.error}` : ''),
  );
  // 离开「已是最新」态：发现新版本 / 下载 / 失败（idle 带 latest 或 error）时清除徽标
  if (snap.status !== 'idle' || snap.latestVersion !== null || snap.error !== null) {
    upCheckedUpToDate.value = false;
  }
  if (snap.status !== 'idle' && snap.status !== 'installing') {
    upInstallRetry.value = false;
  }
  if (snap.status !== 'downloaded' && upConfirming.value) {
    upConfirming.value = false;
  }
  if (snap.status === 'found' && snap.latestVersion && snap.latestVersion !== lastNotifiedUpVersion) {
    lastNotifiedUpVersion = snap.latestVersion;
    toast.info(`发现新版本 ${snap.latestVersion}`);
  }
}

/** 调试控制台（原型风格滚动日志）：展开可见，记录 updater 状态迁移 / 调用结果，用于排查更新链路 */
const upDebugOn = ref(false);
const upDebugLines = ref<string[]>([]);
const upDebugScrollEl = ref<HTMLElement | null>(null);
function upLog(line: string): void {
  const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  upDebugLines.value.push(`[${ts}] ${line}`);
  if (upDebugLines.value.length > 300) {
    upDebugLines.value.splice(0, upDebugLines.value.length - 300);
  }
  // 新日志追加后自动滚到底，便于观察
  void nextTick(() => {
    const el = upDebugScrollEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

/** 复制全部调试日志到剪贴板（Electron 渲染进程下 navigator.clipboard 可用，失败回退 execCommand） */
async function onCopyDebugLog(): Promise<void> {
  if (upDebugLines.value.length === 0) return;
  const text = upDebugLines.value.join('\n');
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
    } else {
      // 回退：临时 textarea + execCommand（极少数环境 clipboard API 不可用）
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }
    upLog(`copyDebugLog → 已复制 ${upDebugLines.value.length} 行`);
  } catch (e) {
    upLog(`copyDebugLog → 失败 ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 调试控制台开关：由本地配置文件（userData/updater-debug.json）决定——普通用户不创建即不可见 */
const upDebugEnabled = ref(false);
async function loadUpDebugEnabled(): Promise<void> {
  try {
    const res = await call<{ enabled: boolean }>('app/getUpdateDebug');
    upDebugEnabled.value = res.enabled;
  } catch {
    upDebugEnabled.value = false;
  }
}

/** 分区常驻的「发现新版本」信息（found 之后有值；下载/安装失败后端保留该值供重试） */
const upFoundVersion = computed<string | null>(() => upSnapshot.value?.latestVersion ?? null);

/** 下载进度百分比（原型：版本行下方进度条数据源） */
const upDownloadPct = computed<number>(() => Math.round(upSnapshot.value?.downloadProgress ?? 0));

/** 主按钮形态：检查更新 → 更新（下载中 busy，进度走进度条）→ 重启安装 → 安装中…（busy 禁点） */
interface UpBtnView {
  action: 'check' | 'download' | 'install' | null;
  label: string;
  busy: boolean;
}

const upBtnView = computed<UpBtnView>(() => {
  const snap = upSnapshot.value;
  const status = snap?.status ?? 'idle';
  const latest = snap?.latestVersion ?? null;
  if (upChecking.value || status === 'checking') {
    return { action: null, label: '检查中…', busy: true };
  }
  if (status === 'downloading') {
    return { action: null, label: '更新', busy: true };
  }
  if (status === 'installing') {
    return { action: null, label: '安装中…', busy: true };
  }
  if (status === 'downloaded' || (upInstallRetry.value && latest !== null)) {
    return { action: 'install', label: '重启安装', busy: false };
  }
  if (latest !== null) {
    return { action: 'download', label: '更新', busy: false };
  }
  return { action: 'check', label: '检查更新', busy: false };
});

/** 初始状态拉取（getState 快照还原；found 时按需补一次 toast） */
async function refreshUpState(): Promise<void> {
  try {
    applyUpSnapshot(await call<UpdaterSnapshot>('updater/getState'));
  } catch {
    // 静默：快照缺失按未检查态展示
  }
}

/** 检查更新（进入「关于」Tab 自动触发一次 + 按钮手动触发）；6003 静默回可重试态 */
async function onCheckUpdates(): Promise<void> {
  if (upChecking.value) return;
  upChecking.value = true;
  upLog('checkForUpdates → 发起检查');
  try {
    const res = await call<UpdaterSnapshot>('updater/checkForUpdates');
    upLog(`checkForUpdates → 返回（state=${res.status}）`);
    applyUpSnapshot(res);
    // 检查完成且无新版本（idle 且无 error）→ 版本行显示「✓ 已是最新」徽标（按钮保留可重查）
    upCheckedUpToDate.value = res.status === 'idle' && !res.latestVersion && !res.error;
  } catch (e) {
    // 检查失败（6003）：无打断性提示，分区保持可重试；失败原因入调试日志
    upLog(`checkForUpdates → 失败 ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    upChecking.value = false;
  }
}

/** 下载更新；下载进度经 updater.stateChanged 事件推送，6004 静默回「发现新版本 + 更新」可重试态 */
async function onDownloadUpdate(): Promise<void> {
  upLog('downloadUpdate → 发起下载');
  try {
    const res = await call<UpdaterSnapshot>('updater/downloadUpdate');
    upLog(`downloadUpdate → 返回（state=${res.status}）`);
    applyUpSnapshot(res);
  } catch (e) {
    // 下载失败（6004）：静默，失败快照已经事件落位（latestVersion 保留）
    upLog(`downloadUpdate → 失败 ${e instanceof Error ? e.message : String(e)}`);
  }
}

/** 确认后执行安装重启：成功即退出（视觉不再返回）；6005 静默回到 downloaded 可重试态 */
async function onQuitAndInstall(): Promise<void> {
  if (upInstalling.value) return;
  upInstalling.value = true;
  upConfirming.value = false;
  upLog('quitAndInstall → 确认安装');
  try {
    // 直用 invoke：需按 code 分流（call 会把非 0 信封压成 Error 丢字段）
    const res = await window.forge.invoke('updater/quitAndInstall');
    if (res.code === 0) {
      applyUpSnapshot(res.data as UpdaterSnapshot | null);
    } else {
      upLog(`quitAndInstall → 返回 code ${res.code}（${res.message}）`);
      upInstallRetry.value = true;
    }
  } catch (e) {
    upLog(`quitAndInstall → 失败 ${e instanceof Error ? e.message : String(e)}`);
    upInstallRetry.value = true;
  } finally {
    upInstalling.value = false;
  }
}

/** 主按钮点击：按派生态分发 */
function onUpBtnClick(): void {
  const action = upBtnView.value.action;
  if (action === 'check') {
    void onCheckUpdates();
  } else if (action === 'download') {
    void onDownloadUpdate();
  } else if (action === 'install') {
    upConfirming.value = true;
  }
}

/** updater.stateChanged：整体替换快照（含下载进度步进） */
function onUpStateChanged(payload: unknown): void {
  applyUpSnapshot(payload as UpdaterSnapshot | null);
}

// 进入「关于」Tab 自动检查一次（PRD §3.4：检查随分区打开自动触发）
watch(activeTab, (tab) => {
  if (tab === 'about') void onCheckUpdates();
});

let unsubProviders: (() => void) | null = null;
let unsubUpdater: (() => void) | null = null;

onMounted(() => {
  void loadProviders();
  void loadModels();
  void loadPiInfo();
  void refreshUpState();
  void loadUpDebugEnabled();
  // 滑动选中块初始定位（含字体加载后宽度变化的一次校准）
  void nextTick(moveThumb);
  window.addEventListener('resize', onResize);
  unsubProviders = subscribe('model.providersChanged', () => {
    void loadProviders();
  });
  unsubUpdater = subscribe('updater.stateChanged', onUpStateChanged);
});

onUnmounted(() => {
  unsubProviders?.();
  unsubUpdater?.();
  if (deleteTimer) clearTimeout(deleteTimer);
  window.removeEventListener('resize', onResize);
});
</script>

<template>
  <div class="settings">
    <header class="settings-header">
      <div>
        <h1 class="settings-title">设置</h1>
      </div>
      <button class="ghost settings-close" aria-label="关闭设置" @click="emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </header>

    <!-- Tab：通用（模型配置+外观）/ 个性化 / 关于（版本更新）；分段控件 + 滑动选中块 -->
    <nav class="settings-tabs" :class="{ isdark: themeMode === 'dark' }" ref="tabsEl">
      <span class="settings-thumb" ref="thumbEl" aria-hidden="true"></span>
      <button
        class="settings-tab"
        :class="{ active: activeTab === 'general' }"
        :ref="(el) => setTabRef('general', el)"
        @click="activeTab = 'general'"
      >通用</button>
      <button
        class="settings-tab"
        :class="{ active: activeTab === 'personal' }"
        :ref="(el) => setTabRef('personal', el)"
        @click="activeTab = 'personal'"
      >个性化</button>
      <button
        class="settings-tab"
        :class="{ active: activeTab === 'about' }"
        :ref="(el) => setTabRef('about', el)"
        @click="activeTab = 'about'"
      >关于</button>
    </nav>

    <div class="settings-body" v-if="activeTab === 'general'">
      <!-- 外观（通用 Tab 顶部） -->
      <section class="settings-section aside">
        <h2 class="section-title">外观</h2>
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

      <!-- 模型配置 -->
      <section class="settings-section main">
        <div class="section-head">
          <div>
            <h2 class="section-title">模型配置</h2>
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

        <!-- 添加/编辑表单（弹窗形态：不再内联在列表上方挤压/推开模型列表）。
             Teleport 到 body：settings 区某祖先带 transform，fixed 遮罩会被其裁剪，须脱离组件树定位 -->
        <Teleport to="body">
        <div
          v-if="showAddForm"
          class="provider-form-overlay"
          role="dialog"
          aria-modal="true"
          @click.self="toggleForm"
        >
        <div class="provider-form">
          <div class="form-head">
            <span class="form-head-title">{{ editingId ? '编辑模型' : '添加模型' }}</span>
            <button type="button" class="form-close" aria-label="关闭" @click="toggleForm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
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
          <!-- MP-S06：上下文窗口 1M 单档勾选（勾选写 1000000，未勾选移除字段） -->
          <label class="form-field context-check context-1m">
            <input v-model="formContext1M" type="checkbox" />
            <span class="form-label">上下文窗口 1M（100 万 tokens）</span>
          </label>
          <!-- 多模态：勾选写模型 input:["text","image"]（能发图片给模型），未勾选移除 -->
          <label class="form-field context-check context-vision">
            <input v-model="formVision" type="checkbox" />
            <span class="form-label">支持图片输入（多模态）</span>
          </label>
          <!-- MP-S07：思考强度勾选（与上下勾选行样式一致）+ 下方思考等级多选下拉（控制对话框可选挡位） -->
          <label class="form-field context-check">
            <input v-model="formReasoning" type="checkbox" />
            <span class="form-label">思考强度</span>
          </label>
          <div class="form-field level-picker" :class="{ disabled: !formReasoning }">
            <button
              type="button"
              class="level-picker-trigger"
              :disabled="!formReasoning"
              data-tooltip="选择对话时可选用的思考等级"
              @click.stop="levelMenuOpen = !levelMenuOpen"
            >
              <span class="level-picker-label">{{ selectedLevelsLabel }}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div v-if="levelMenuOpen" class="level-overlay" @click="levelMenuOpen = false"></div>
            <div v-if="levelMenuOpen" class="level-menu">
              <div class="menu-hint">对话框中可选的思考等级</div>
              <label v-for="l in levelOptions" :key="l" class="level-option">
                <input
                  type="checkbox"
                  :checked="formLevels.includes(l)"
                  @change="toggleLevel(l)"
                />
                <span class="level-option-name">{{ l }}</span>
              </label>
            </div>
          </div>
          <div v-if="formError" class="form-error">{{ formError }}</div>
          <div class="form-actions">
            <button class="primary" :disabled="!canSubmitForm" @click="onSaveProvider">
              {{ saving ? '保存中…' : (editingId ? '保存修改' : '添加模型') }}
            </button>
          </div>
        </div>
        </div>
        </Teleport>

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
                <span v-if="p.vision === true" class="vision-tag">多模态</span>
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
    </div>

    <!-- 个性化 Tab：用户个性化偏好（首个：对话框 diff 展示开关） -->
    <div class="personal-body" v-if="activeTab === 'personal'">
      <section class="settings-section">
        <div class="pref-row">
          <div class="pref-text">
            <span class="pref-title">显示代码 Diff</span>
            <span class="pref-desc">关闭后对话框不再展示代码变更对比，页面更简洁</span>
          </div>
          <button
            class="pref-switch"
            :class="{ on: showDiff }"
            role="switch"
            :aria-checked="showDiff"
            aria-label="显示代码 Diff"
            @click="setShowDiff(!showDiff)"
          >
            <span class="pref-knob"></span>
          </button>
        </div>
      </section>
    </div>

    <!-- 关于 Tab：版本更新（无独立标题；版本行直接承载「Forge 版本」+ 检查更新/更新/重启安装，发现新版行内展示 v0.1.0 → v0.2.0） -->
    <div class="about-body" v-if="activeTab === 'about'">
      <section class="settings-section update-section">
        <!-- 版本行 + 同行右侧操作按钮；行占满到底（about-body 不限制宽度） -->
        <div class="version-row">
          <span class="version-label">Forge 版本</span>
          <span class="version-value">v{{ forgeVersion ?? '—' }}</span>
          <template v-if="upFoundVersion !== null">
            <span class="version-arrow">→</span>
            <span class="version-next"><span class="dot"></span>v{{ upFoundVersion }}</span>
          </template>
          <span class="version-spacer"></span>
          <span class="version-actions">
            <span v-if="upCheckedUpToDate" class="up-uptodate">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              已是最新
            </span>
            <button
              class="up-btn"
              :class="{ 'is-cta': upBtnView.action !== 'check' }"
              :disabled="upBtnView.busy"
              @click="onUpBtnClick"
            >{{ upBtnView.label }}</button>
          </span>
        </div>
        <!-- 下载进度（原型：版本行下方进度条；检查/下载/安装失败静默回可重试态） -->
        <div v-if="upSnapshot?.status === 'downloading'" class="up-progress">
          <div class="up-progress-meta"><span>正在下载 forge {{ upFoundVersion }}</span><b>{{ upDownloadPct }}%</b></div>
          <div class="up-progress-track"><div class="up-progress-fill" :style="{ width: upDownloadPct + '%' }"></div></div>
        </div>
        <!-- 调试控制台（仅本地配置文件开启后可见；滚动日志展示 updater 状态迁移/调用结果/错误） -->
        <div v-if="upDebugEnabled" class="up-debug">
          <button class="up-debug-toggle" @click="upDebugOn = !upDebugOn">
            {{ upDebugOn ? '收起调试日志' : '展开调试日志' }}
          </button>
          <div v-if="upDebugOn" class="up-debug-console">
            <div class="up-debug-ver">
              <span>当前 {{ forgeVersion ?? '—' }}</span>
              <span>快照 {{ upSnapshot?.status ?? '—' }}</span>
              <span v-if="upSnapshot?.error" class="up-debug-err">错误 {{ upSnapshot.error }}</span>
              <span class="up-debug-spacer"></span>
              <button class="up-debug-copy" :disabled="upDebugLines.length === 0" @click="onCopyDebugLog">复制全部</button>
            </div>
            <div v-if="upDebugLines.length === 0" class="up-debug-empty">暂无日志：进入「关于」Tab 后自动记录检查与状态迁移</div>
            <div ref="upDebugScrollEl" class="up-debug-scroll">
              <div v-for="(l, i) in upDebugLines" :key="i" class="up-debug-line">{{ l }}</div>
            </div>
          </div>
        </div>
        <!-- 重启安装确认弹窗（IN-F03）：fixed 遮罩 + 居中 box；取消停留当前版本，确认后关闭应用安装并自动重启 -->
        <div v-if="upConfirming" class="up-confirm" role="dialog" aria-modal="true" @click.self="upConfirming = false">
          <div class="up-confirm-box">
            <div class="up-confirm-main">
              <span class="up-confirm-title">安装 forge {{ upFoundVersion }}</span>
              <span class="up-confirm-desc">关闭应用并安装更新，完成后自动重启。</span>
            </div>
            <div class="up-confirm-actions">
              <button class="ghost small" @click="upConfirming = false">取消</button>
              <button class="primary small" :disabled="upInstalling" @click="onQuitAndInstall">确认安装</button>
            </div>
          </div>
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
  padding: 4px 4px 14px;
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

/* Tab：通用 / 关于 —— 分段控件 + 滑动选中块（方案 A，原型确认） */
.settings-tabs {
  position: relative;
  display: inline-flex;
  gap: 2px;
  background: var(--muted);
  border-radius: 999px;
  padding: 3px;
  margin-bottom: 18px;
}

.settings-thumb {
  position: absolute;
  top: 3px;
  bottom: 3px;
  /* 初始零宽贴左：JS 首次定位前不可见，避免满宽闪现 */
  left: 0;
  right: 100%;
  background: var(--card);
  border-radius: 999px;
  box-shadow: var(--shadow-sm);
  /* 基态（向左滑）：左边先行带轻微回弹，右边延迟追随 → 水滴拉丝 */
  transition:
    left 240ms cubic-bezier(0.34, 1.45, 0.64, 1),
    right 260ms cubic-bezier(0.22, 0.61, 0.36, 1) 70ms;
}

/* 向右滑：右边先行、左边滞后（thumb-lb = left behind） */
.settings-thumb.thumb-lb {
  transition:
    right 240ms cubic-bezier(0.34, 1.45, 0.64, 1),
    left 260ms cubic-bezier(0.22, 0.61, 0.36, 1) 70ms;
}

/* 深色主题：选中块用前景色混合提亮，避免与容器贴平 */
.settings-tabs.isdark .settings-thumb {
  background: color-mix(in oklab, var(--foreground) 14%, var(--card));
}

.settings-tab {
  position: relative;
  z-index: 1;
  border: none;
  background: transparent;
  padding: 6px 18px;
  border-radius: 999px;
  font-size: 13px;
  color: var(--muted-foreground);
  cursor: pointer;
  font-family: var(--font-sans);
  transition: color 0.2s;
}

.settings-tab:hover { color: var(--foreground); }

.settings-tab.active { color: var(--foreground); font-weight: 600; }

/* 通用 Tab：单栏，外观在上、模型配置在下 */
.settings-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 8px;
  display: flex;
  flex-direction: column;
  gap: 24px;
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

/* 「个性化」Tab：单栏偏好列表 */
.personal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.pref-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
}

.pref-text {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.pref-title {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--foreground);
}

.pref-desc {
  font-size: 12px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.pref-switch {
  flex-shrink: 0;
  width: 40px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 999px;
  background: var(--border);
  cursor: pointer;
  position: relative;
  transition: background 0.2s;
}

.pref-switch.on {
  background: var(--brand);
}

.pref-knob {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 50%;
  background: var(--card);
  box-shadow: var(--shadow-sm);
  transition: transform 0.2s;
}

.pref-switch.on .pref-knob {
  transform: translateX(18px);
}

/* 「关于」Tab：单栏承载版本更新分区；不限制宽度——版本行拉满到底，右侧不留空 */
.about-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 8px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-action:disabled {
  opacity: 0.6;
  cursor: default;
  pointer-events: none;
}

.version-row {
  display: flex;
  flex-wrap: wrap; /* 窄窗口放不下时整行换行，避免右侧内容被截断显示半截 */
  align-items: center;
  gap: 10px;
  row-gap: 8px;
  padding: 10px 14px;
  border: none;
  border-radius: var(--radius-lg);
  background: var(--muted);
}

/* 操作区（徽标 + 按钮）作为整体：行内放不下时整体换到下一行，不拆散 */
.version-actions {
  display: inline-flex;
  align-items: center;
  gap: 10px;
  flex-shrink: 0;
  min-width: 0;
}

.version-label {
  font-size: 12.5px;
  color: var(--foreground);
}

.version-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
}

/* 发现新版：版本行内「0.1.0 → 0.2.0」（原型 updater-prototype） */
.version-arrow {
  color: var(--muted-foreground);
  font-size: 12px;
}

.version-next {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  font-weight: 600;
  font-family: var(--font-mono);
  color: var(--brand);
}

.version-next .dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--brand);
  animation: upPulse 1.6s ease-in-out infinite;
}

@keyframes upPulse {
  0%, 100% { box-shadow: 0 0 0 0 color-mix(in oklab, var(--brand) 45%, transparent); }
  50% { box-shadow: 0 0 0 5px transparent; }
}

.version-spacer {
  flex: 1;
}

/* 下载进度（原型：版本行下方进度条） */
.up-progress {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.up-progress-meta {
  display: flex;
  justify-content: space-between;
  font-size: 11.5px;
  color: var(--muted-foreground);
}

.up-progress-meta b {
  font-family: var(--font-mono);
  font-weight: 600;
  color: var(--foreground);
}

.up-progress-track {
  height: 6px;
  border-radius: 999px;
  background: var(--border);
  overflow: hidden;
}

.up-progress-fill {
  height: 100%;
  width: 0%;
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 72%, transparent);
  transition: width 0.35s cubic-bezier(0.3, 0.8, 0.3, 1);
}

/* 调试控制台（展开可见，滚动日志——排查更新链路） */
.up-debug {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.up-debug-toggle {
  align-self: flex-start;
  padding: 2px 0;
  border: none;
  background: none;
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
}

.up-debug-toggle:hover {
  color: var(--brand);
}

.up-debug-console {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 10px 12px;
  background: var(--muted);
  border-radius: 8px;
  border: 1px solid var(--border);
  /* 调试控制台允许选中文本（覆盖 body 的 user-select: none），便于复制日志 */
  user-select: text;
  -webkit-user-select: text;
}

.up-debug-ver {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  font-size: 11.5px;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
}

.up-debug-spacer {
  flex: 1;
}

.up-debug-copy {
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  border-radius: 6px;
  padding: 2px 10px;
  font-size: 11.5px;
  font-family: var(--font-mono);
  cursor: pointer;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.up-debug-copy:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand);
}

.up-debug-copy:disabled {
  opacity: 0.5;
  cursor: default;
}

.up-debug-err {
  color: var(--destructive);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.up-debug-empty {
  font-size: 11.5px;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
}

.up-debug-scroll {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 180px;
  overflow-y: auto;
  padding-right: 4px;
}

.up-debug-line {
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.6;
  color: var(--foreground);
  word-break: break-all;
  /* 允许行内文本被拖选复制 */
  user-select: text;
  -webkit-user-select: text;
}

.up-btn {
  flex-shrink: 0;
  min-width: 84px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 5px 14px;
  border-radius: 999px;
  font-size: 12.5px;
  font-weight: 500;
  background: var(--muted);
  border: 1px solid var(--border);
  color: var(--foreground);
}

/* 检查完成且无新版本：「✓ 已是最新」徽标（按钮仍保留可再次检查） */
.up-uptodate {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 12.5px;
  font-weight: 500;
  color: var(--success);
}

.up-uptodate svg {
  width: 13px;
  height: 13px;
}

.up-btn.is-cta {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--brand-foreground);
}

.up-btn.is-cta:hover {
  background: var(--brand-hover);
  border-color: var(--brand-hover);
  color: var(--brand-foreground);
}

.up-btn:disabled {
  opacity: 0.6;
  cursor: default;
  pointer-events: none;
}

.up-confirm {
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

.up-confirm-box {
  width: 380px;
  max-width: calc(100vw - 48px);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-lg);
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.up-confirm-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.up-confirm-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.up-confirm-desc {
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.up-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* 主题色板（通用 Tab 顶部：横向排布） */
.theme-swatches {
  display: flex;
  gap: 12px;
}

.theme-swatch {
  min-width: 160px;
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

/* 模型配置表单：弹窗形态（遮罩配方同 .up-confirm），不占用列表空间 */
.provider-form-overlay {
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

.provider-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: 440px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 96px);
  overflow-y: auto;
  padding: 22px 24px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-lg);
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
  justify-content: space-between;
}

.form-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}

.form-close svg {
  width: 14px;
  height: 14px;
}

.form-close:hover {
  background: var(--muted);
  color: var(--foreground);
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

/* MP-S06：上下文 1M 单档勾选（原生 checkbox 横向排布；尺寸统一 16px 使各行文字对齐） */
.context-check {
  flex-direction: row;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  user-select: none;
}

.context-check input[type='checkbox'] {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  cursor: pointer;
}

/* MP-S07：思考等级多选下拉（位于「思考强度」勾选下方，独立一行） */
.level-picker {
  position: relative;
}

.level-picker.disabled {
  opacity: 0.55;
}

.level-picker-trigger {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  font-size: 12.5px;
  font-family: var(--font-mono);
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  cursor: pointer;
}

.level-picker-trigger:not(:disabled):hover,
.level-picker-trigger:not(:disabled):focus-visible {
  border-color: var(--brand);
}

.level-picker-trigger:disabled {
  cursor: not-allowed;
}

.level-picker-trigger svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.level-picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.level-overlay {
  position: fixed;
  inset: 0;
  z-index: 10;
}

.level-menu {
  position: absolute;
  z-index: 11;
  /* 表单已改为弹窗（内部可滚动）：向下弹会被 modal 底边裁切，故朝上展开 */
  top: auto;
  bottom: calc(100% + 4px);
  left: 0;
  right: 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.menu-hint {
  font-size: 11px;
  color: var(--muted-foreground);
  padding: 4px 8px 6px;
}

.level-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--foreground);
}

.level-option:hover {
  background: var(--muted);
}

.level-option input[type='checkbox'] {
  width: auto;
  margin: 0;
  flex-shrink: 0;
}

.level-option-name {
  font-family: var(--font-mono);
}

.level-option-note {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted-foreground);
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

/* 多模态标签：模型支持图片输入时在列表项展示 */
.vision-tag {
  padding: 1px 8px;
  border-radius: 999px;
  background: color-mix(in oklab, var(--brand) 9%, transparent);
  color: var(--brand);
  font-size: 11px;
  font-weight: 600;
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