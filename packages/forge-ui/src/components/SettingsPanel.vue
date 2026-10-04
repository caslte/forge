<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue';
// 从瘦 subpath 导入：@forge/core 根入口 re-export 含 node:events 的 RPC 层，浏览器打包会炸
import { DEFAULT_THINKING_LEVELS, THINKING_LEVELS } from '@forge/core/model';
import { call, invokeRaw, subscribe } from '../bridge';
import type { PiGetInfoResult } from '../bridge';
import { useToast } from '../composables/useToast';
import {
  usePreferences,
  type CodeDiffDefaultMode,
  type CodeViewerLayout,
  type ContentWidth,
  type TerminalShellPref,
} from '../composables/usePreferences';
import { useUpdater } from '../composables/useUpdater';
import { useI18n, type LocalePreference, type MessageKey } from '../i18n/index.ts';
import SkillsSection from './SkillsSection.vue';
import type { ThemeMode, ProviderItem, ThinkingLevel } from '../types';

/**
 * 设置面板。
 * 模型配置采用「一条配置 = 一个模型」的直白形态：
 * - 每个 provider（底层仍是 provider，兼容 pi）只展示一个模型
 * - 字段：名称 / API 地址 / API Key / 模型 ID
 * - 「主会话模型」单选项：复用 setDefault，全局唯一
 * 底层 forge-core 契约不变（saveProvider 的 type 固定 openai-completions，models 传单元素数组）。
 */
defineProps<{
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
/** 连通性测试进行中 / 结果文案（结果紧挨按钮下方展示，不弹 toast 免遮挡表单） */
const testing = ref(false);
const testResult = ref<{ ok: boolean; text: string } | null>(null);
const formError = ref<string | null>(null);
const apiKeyVisible = ref(false);

// 删除两阶段确认
const deleteConfirmId = ref<string | null>(null);
let deleteTimer: ReturnType<typeof setTimeout> | null = null;

const { t, preference, activeLocale, setPreference } = useI18n();

const themeSwatches: { mode: ThemeMode; labelKey: MessageKey; color: string }[] = [
  { mode: 'light', labelKey: 'settings.theme.light', color: 'oklch(1 0 0)' },
  { mode: 'dark', labelKey: 'settings.theme.dark', color: 'oklch(0.24 0.01 286.3)' },
];

// 模块 08：语言偏好三态；选项文案不随界面语言翻译（各语言自身书写，PRD 常规默认项）
const languageOptions: { value: LocalePreference; labelKey: MessageKey }[] = [
  { value: 'zh-CN', labelKey: 'settings.language.zhCN' },
  { value: 'en', labelKey: 'settings.language.en' },
  { value: 'system', labelKey: 'settings.language.system' },
];

/** 个性化：对话内容宽度两态（wide = 现有铺满行为，standard = 收拢居中） */
const contentWidthOptions: { value: ContentWidth; labelKey: MessageKey }[] = [
  { value: 'standard', labelKey: 'settings.personal.contentWidthStandard' },
  { value: 'wide', labelKey: 'settings.personal.contentWidthWide' },
];

/** 模块 12：代码查看器布局单选项（默认 cover 整屏覆盖，2026-10-02 用户定稿；split 留给偏好并排的人） */
const codeLayoutOptions: { value: CodeViewerLayout; labelKey: MessageKey }[] = [
  { value: 'cover', labelKey: 'settings.codeViewer.layoutCover' },
  { value: 'split', labelKey: 'settings.codeViewer.layoutSplit' },
];

/** 模块 12 P2：代码对比默认视图（默认 side 并排，2026-10-03 用户定稿；inline 留给偏好带标记全文的人） */
const diffViewOptions: { value: CodeDiffDefaultMode; labelKey: MessageKey }[] = [
  { value: 'side', labelKey: 'settings.codeViewer.diffViewSide' },
  { value: 'inline', labelKey: 'settings.codeViewer.diffViewInline' },
];

/**
 * 模块 10 TD-TM-05 方案 B：终端 Shell 选项。首项恒为 auto（跟随系统默认优先级链），
 * 其余来自主进程探测（listTerminalShells 只回已安装档，label=产品名）。探测失败/空
 * 列表只剩 auto——静默降级，不报错打扰。
 */
const installedShells = ref<{ id: TerminalShellPref; label: string }[]>([]);
const terminalShellOptions = computed<{ value: TerminalShellPref; label: string }[]>(() => [
  { value: 'auto', label: t('settings.personal.terminalShellAuto') },
  ...installedShells.value.map((s) => ({ value: s.id, label: s.label })),
]);

/** 终端 Shell 下拉（TD-TM-05 B）：开合状态与当前档展示名；选择即落盘并收起 */
const shellMenuOpen = ref(false);
const selectedShellLabel = computed(
  () =>
    terminalShellOptions.value.find((o) => o.value === terminalShell.value)?.label ??
    terminalShell.value,
);

function pickShell(v: TerminalShellPref): void {
  setTerminalShell(v);
  shellMenuOpen.value = false;
}

async function refreshTerminalShells(): Promise<void> {
  try {
    const list = await window.forge.shell.listTerminalShells();
    // 白名单过滤：id 必须落在 TerminalShellPref 枚举内，脏数据不进选项
    installedShells.value = list.flatMap((s) =>
      s.id === 'pwsh' || s.id === 'powershell' || s.id === 'cmd'
        ? [{ id: s.id, label: s.label }]
        : [],
    );
  } catch {
    installedShells.value = [];
  }
}

const toast = useToast();
const { showDiff, setShowDiff, contentWidth, setContentWidth, terminalShell, setTerminalShell } =
  usePreferences();
const { codeViewerLayout, setCodeViewerLayout } = usePreferences();
const { codeDiffDefaultMode, setCodeDiffDefaultMode } = usePreferences();

const canSubmitForm = computed(() => {
  return (
    formName.value.trim().length > 0 &&
    formBaseUrl.value.trim().length > 0 &&
    formModel.value.trim().length > 0 &&
    !saving.value
  );
});

/** 改动作废上一次结果：换了地址/Key/模型后仍挂着「连接成功」会误导 */
watch([formBaseUrl, formApiKey, formModel], () => {
  testResult.value = null;
});

/** 测试只需 API 地址 + 模型 ID（本地推理服务常无 Key），且不与保存/另一次测试并发 */
const canTestForm = computed(() => {
  return (
    formBaseUrl.value.trim().length > 0 &&
    formModel.value.trim().length > 0 &&
    !testing.value &&
    !saving.value
  );
});

/** MP-S07：多选下拉可选项（除去 off：off 是默认态，不展示，保存时始终写入） */
const levelOptions: ThinkingLevel[] = THINKING_LEVELS.filter((l) => l !== 'off');

/** MP-S07：多选下拉触发器文案（未启用思考/空选/已选列表；off 不展示） */
const selectedLevelsLabel = computed(() => {
  if (!formReasoning.value) {
    return t('settings.model.reasoningOff');
  }
  const shown = formLevels.value.filter((l) => l !== 'off');
  if (shown.length === 0) {
    return t('settings.model.noLevels');
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
    toast.success(t('settings.model.saved'));
  } catch (e) {
    formError.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

/**
 * 用表单当前值（无需先保存）发一次最小 chat/completions 探活。
 * 经 invokeRaw 而非 call：call 的抛错带 `model/testProvider 失败（1006）:` 前缀，
 * 这里要的是后端已写好人话的 message 原文。
 */
async function onTestProvider(): Promise<void> {
  if (!canTestForm.value) return;
  testing.value = true;
  testResult.value = null;
  try {
    const res = await invokeRaw<{ latencyMs: number }>('model/testProvider', {
      baseUrl: formBaseUrl.value.trim(),
      apiKey: formApiKey.value.trim(),
      model: formModel.value.trim(),
    });
    testResult.value =
      res.code === 0
        ? { ok: true, text: t('settings.model.testOk', { ms: res.data?.latencyMs ?? 0 }) }
        : { ok: false, text: res.message };
  } catch (e) {
    testResult.value = { ok: false, text: e instanceof Error ? e.message : String(e) };
  } finally {
    testing.value = false;
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
  testResult.value = null;
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
const activeTab = ref<'general' | 'personal' | 'skills' | 'about'>('general');
const tabsEl = ref<HTMLElement | null>(null);
const thumbEl = ref<HTMLElement | null>(null);
const tabBtns = { general: null as HTMLElement | null, personal: null as HTMLElement | null, skills: null as HTMLElement | null, about: null as HTMLElement | null };

function setTabRef(name: 'general' | 'personal' | 'skills' | 'about', el: unknown): void {
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

// 语言切换重排 Tab 文案宽度：等 DOM 更新后重贴滑块（RO 兜底字体加载，这里管文案换语言）
watch(activeLocale, () => { void nextTick(moveThumb); });

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

// ===== 应用自更新（07 IN-S03 改造）：状态与动作在 useUpdater 全局单例，本面板为「关于」页镜像消费方 =====
// 口径：发现新版不再弹 toast（提示由侧栏 UpdateEntry 图标承担）；检查/下载/安装失败静默可重试
const {
  snapshot: upSnapshot,
  checking: upChecking,
  installing: upInstalling,
  installRetry: upInstallRetry,
  checkedUpToDate: upCheckedUpToDate,
  logLines: upDebugLines,
  foundVersion: upFoundVersion,
  downloadPct: upDownloadPct,
  ensureSubscribed: upEnsureSubscribed,
  refresh: refreshUpState,
  check: upCheck,
  download: upDownload,
  quitAndInstall: upQuitAndInstall,
} = useUpdater();

/** 「重启安装」确认弹窗显隐（fixed 遮罩 + 居中 box，IN-F03 弹窗确认语义；面板局部态） */
const upConfirming = ref(false);
// 状态离开 downloaded（如另一入口完成安装/检查重置）时收起确认条
watch(
  () => upSnapshot.value?.status,
  (status) => {
    if (status !== 'downloaded' && upConfirming.value) upConfirming.value = false;
  },
);

/** 调试控制台（原型风格滚动日志）：展开可见；日志源为 useUpdater 模块级 logLines（状态迁移/调用结果） */
const upDebugOn = ref(false);
const upDebugScrollEl = ref<HTMLElement | null>(null);
// 新日志追加后自动滚到底，便于观察
watch(
  () => upDebugLines.value.length,
  () => {
    void nextTick(() => {
      const el = upDebugScrollEl.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  },
);

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
  } catch {
    // 静默：复制失败无副作用
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
    return { action: null, label: t('settings.update.checking'), busy: true };
  }
  if (status === 'downloading') {
    return { action: null, label: t('settings.update.update'), busy: true };
  }
  if (status === 'installing') {
    return { action: null, label: t('settings.update.installing'), busy: true };
  }
  if (status === 'downloaded' || (upInstallRetry.value && latest !== null)) {
    return { action: 'install', label: t('settings.update.installNow'), busy: false };
  }
  if (latest !== null) {
    return { action: 'download', label: t('settings.update.update'), busy: false };
  }
  return { action: 'check', label: t('settings.update.check'), busy: false };
});

/** 主按钮点击：按派生态分发（动作实现见 useUpdater） */
function onUpBtnClick(): void {
  const action = upBtnView.value.action;
  if (action === 'check') {
    void upCheck();
  } else if (action === 'download') {
    void upDownload();
  } else if (action === 'install') {
    upConfirming.value = true;
  }
}

/** 确认安装：先收本面板确认条，再走全局动作（成功即退出应用） */
function onQuitAndInstall(): void {
  upConfirming.value = false;
  void upQuitAndInstall();
}

let unsubProviders: (() => void) | null = null;
// Tab 按钮宽度变化（语言切换改文案、字体加载）时重贴滑块
let thumbRo: ResizeObserver | null = null;

onMounted(() => {
  void loadProviders();
  void loadModels();
  void loadPiInfo();
  void refreshTerminalShells();
  void refreshUpState();
  upEnsureSubscribed();
  void loadUpDebugEnabled();
  // 滑动选中块初始定位（含字体加载后宽度变化的一次校准）
  void nextTick(moveThumb);
  window.addEventListener('resize', onResize);
  thumbRo = new ResizeObserver(() => moveThumb());
  for (const btn of Object.values(tabBtns)) {
    if (btn) thumbRo.observe(btn);
  }
  unsubProviders = subscribe('model.providersChanged', () => {
    void loadProviders();
  });
});

onUnmounted(() => {
  unsubProviders?.();
  if (deleteTimer) clearTimeout(deleteTimer);
  window.removeEventListener('resize', onResize);
  thumbRo?.disconnect();
  thumbRo = null;
});
</script>

<template>
  <div class="settings">
    <header class="settings-header">
      <div>
        <h1 class="settings-title">{{ t('settings.title') }}</h1>
      </div>
      <button class="ghost settings-back" :aria-label="t('settings.backToWorkspace')" @click="emit('close')">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        <span>{{ t('settings.backToWorkspace') }}</span>
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
      >{{ t('settings.tab.general') }}</button>
      <button
        class="settings-tab"
        :class="{ active: activeTab === 'personal' }"
        :ref="(el) => setTabRef('personal', el)"
        @click="activeTab = 'personal'"
      >{{ t('settings.tab.personal') }}</button>
      <button
        class="settings-tab"
        :class="{ active: activeTab === 'skills' }"
        :ref="(el) => setTabRef('skills', el)"
        @click="activeTab = 'skills'"
      >{{ t('settings.tab.skills') }}</button>
      <button
        class="settings-tab"
        :class="{ active: activeTab === 'about' }"
        :ref="(el) => setTabRef('about', el)"
        @click="activeTab = 'about'"
      >{{ t('settings.tab.about') }}</button>
    </nav>

    <div class="settings-body" v-if="activeTab === 'general'">
      <!-- 外观（通用 Tab 顶部） -->
      <section class="settings-section aside">
        <h2 class="section-title">{{ t('settings.appearance') }}</h2>
        <div class="theme-swatches">
          <button
            v-for="swatch in themeSwatches"
            :key="swatch.mode"
            class="theme-swatch"
            :class="{ active: themeMode === swatch.mode }"
            @click="selectTheme(swatch.mode)"
          >
            <span class="swatch-color" :style="{ background: swatch.color }">
              <svg v-if="themeMode === swatch.mode" class="swatch-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="20 6 9 17 4 12" />
              </svg>
            </span>
            <span class="swatch-label">{{ t(swatch.labelKey) }}</span>
          </button>
        </div>
        <div class="language-row">
          <span class="language-label">{{ t('settings.language') }}</span>
          <div class="language-options" role="radiogroup" :aria-label="t('settings.language')">
            <button
              v-for="opt in languageOptions"
              :key="opt.value"
              class="language-option"
              :class="{ active: preference === opt.value }"
              role="radio"
              :aria-checked="preference === opt.value"
              @click="setPreference(opt.value)"
            >{{ t(opt.labelKey) }}</button>
          </div>
        </div>
      </section>

      <!-- 模型配置 -->
      <section class="settings-section main">
        <div class="section-head">
          <div>
            <h2 class="section-title">{{ t('settings.model.title') }}</h2>
          </div>
          <button class="section-action" @click="toggleForm">
            <svg v-if="!showAddForm" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
            {{ showAddForm ? t('common.cancel') : t('settings.model.add') }}
          </button>
        </div>

        <!-- 当前主会话模型（置于列表上方，模型多时不遮挡） -->
        <div v-if="defaultModel" class="default-model-row">
          <span class="default-model-label">{{ t('settings.model.currentDefault') }}</span>
          <span class="default-model-value">{{ defaultModel }}</span>
          <button class="ghost small" @click="onClearDefault">{{ t('settings.model.clear') }}</button>
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
            <span class="form-head-title">{{ editingId ? t('settings.model.edit') : t('settings.model.add') }}</span>
            <button type="button" class="form-close" :aria-label="t('common.close')" @click="toggleForm">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
                <path d="M6 6l12 12M18 6L6 18" />
              </svg>
            </button>
          </div>
          <label class="form-field">
            <span class="form-label">{{ t('settings.model.name') }}</span>
            <input v-model="formName" type="text" :placeholder="t('settings.model.namePlaceholder')" />
          </label>
          <label class="form-field">
            <span class="form-label">{{ t('settings.model.baseUrl') }}</span>
            <input v-model="formBaseUrl" type="text" placeholder="https://api.xxx.com/v1" />
          </label>
          <label class="form-field">
            <span class="form-label">API Key</span>
            <div class="api-key-wrap">
              <input
                v-model="formApiKey"
                :type="apiKeyVisible ? 'text' : 'password'"
                class="api-key-input"
                :placeholder="t('settings.model.apiKeyPlaceholder')"
              />
              <button
                type="button"
                class="api-key-toggle"
                :aria-label="apiKeyVisible ? t('settings.model.hideKey') : t('settings.model.showKey')"
                :data-tooltip="apiKeyVisible ? t('settings.model.hideKey') : t('settings.model.showKey')"
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
            <span class="form-label">{{ t('settings.model.modelId') }}</span>
            <input v-model="formModel" type="text" :placeholder="t('settings.model.modelIdPlaceholder')" />
          </label>
          <!-- MP-S06：上下文窗口 1M 单档勾选（勾选写 1000000，未勾选移除字段） -->
          <label class="form-field context-check context-1m">
            <input v-model="formContext1M" type="checkbox" />
            <span class="form-label">{{ t('settings.model.context1M') }}</span>
          </label>
          <!-- 多模态：勾选写模型 input:["text","image"]（能发图片给模型），未勾选移除 -->
          <label class="form-field context-check context-vision">
            <input v-model="formVision" type="checkbox" />
            <span class="form-label">{{ t('settings.model.vision') }}</span>
          </label>
          <!-- MP-S07：思考强度勾选（与上下勾选行样式一致）+ 下方思考等级多选下拉（控制对话框可选挡位） -->
          <label class="form-field context-check">
            <input v-model="formReasoning" type="checkbox" />
            <span class="form-label">{{ t('settings.model.reasoning') }}</span>
          </label>
          <div class="form-field level-picker" :class="{ disabled: !formReasoning }">
            <button
              type="button"
              class="level-picker-trigger"
              :disabled="!formReasoning"
              :data-tooltip="t('settings.model.levelsTooltip')"
              @click.stop="levelMenuOpen = !levelMenuOpen"
            >
              <span class="level-picker-label">{{ selectedLevelsLabel }}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div v-if="levelMenuOpen" class="level-overlay" @click="levelMenuOpen = false"></div>
            <div v-if="levelMenuOpen" class="level-menu">
              <div class="menu-hint">{{ t('settings.model.levelsHint') }}</div>
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
            <!-- 连通性测试：用当前表单值直连一次，不需要先保存 -->
            <button
              type="button"
              class="ghost"
              :disabled="!canTestForm"
              :data-tooltip="t('settings.model.testTooltip')"
              @click="onTestProvider"
            >
              {{ testing ? t('settings.model.testing') : t('settings.model.test') }}
            </button>
            <button class="primary" :disabled="!canSubmitForm" @click="onSaveProvider">
              {{ saving ? t('settings.model.saving') : (editingId ? t('settings.model.saveChanges') : t('settings.model.add')) }}
            </button>
          </div>
          <div v-if="testResult" class="form-test-result" :class="testResult.ok ? 'is-ok' : 'is-fail'">
            {{ testResult.text }}
          </div>
        </div>
        </div>
        </Teleport>

        <!-- 模型列表 -->
        <div v-if="providerError" class="section-error">{{ providerError }}</div>
        <div v-if="providers.length === 0 && !loadingModels" class="empty-state">
          {{ t('settings.model.empty') }}
        </div>
        <div v-else-if="providers.length" class="provider-list">
          <div v-for="p in providers" :key="p.id" class="provider-item"
            :class="{ 'is-default': p.models[0] && isDefault(p.models[0]) }">
            <div class="provider-info">
              <div class="provider-name-row">
                <span class="provider-name">{{ p.name }}</span>
                <span v-if="p.models[0] && isDefault(p.models[0])" class="default-tag">{{ t('settings.model.defaultTag') }}</span>
                <span v-if="p.lastError" class="provider-error-tag" :title="p.lastError">{{ t('settings.model.errorTag') }}</span>
              </div>
              <div class="provider-meta">
                <span v-if="p.baseUrl" class="provider-baseurl">{{ p.baseUrl }}</span>
                <span v-else class="provider-baseurl muted">{{ t('settings.model.localDefault') }}</span>
                <span class="provider-models-count">{{ p.models[0] ?? '—' }}</span>
                <span v-if="p.vision === true" class="vision-tag">{{ t('settings.model.visionTag') }}</span>
              </div>
            </div>
            <div class="provider-actions">
              <button
                class="provider-default-btn"
                :data-tooltip="t('settings.model.editTooltip')"
                @click="onEdit(p)"
              >{{ t('settings.model.editBtn') }}</button>
              <button
                v-if="p.models[0] && !isDefault(p.models[0])"
                class="provider-default-btn"
                :data-tooltip="t('settings.model.setDefaultTooltip')"
                @click="onSetDefault(p.models[0])"
              >{{ t('settings.model.setDefault') }}</button>
              <button
                class="provider-delete"
                :class="{ confirming: deleteConfirmId === p.id }"
                :data-tooltip="deleteConfirmId === p.id ? t('settings.model.confirmDeleteTooltip') : t('common.delete')"
                @click="onDeleteProvider(p.id)"
              >
                {{ deleteConfirmId === p.id ? t('settings.model.confirmDelete') : '' }}
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

    <!-- 个性化 Tab：用户个性化偏好（内容宽度分段控件 / 对话框 diff 展示开关） -->
    <div class="personal-body" v-if="activeTab === 'personal'">
      <section class="settings-section">
        <div class="pref-row">
          <div class="pref-text">
            <span class="pref-title">{{ t('settings.personal.contentWidthTitle') }}</span>
            <span class="pref-desc">{{ t('settings.personal.contentWidthDesc') }}</span>
          </div>
          <div class="width-options" role="radiogroup" :aria-label="t('settings.personal.contentWidthTitle')">
            <button
              v-for="opt in contentWidthOptions"
              :key="opt.value"
              class="width-option"
              :class="{ active: contentWidth === opt.value }"
              role="radio"
              :aria-checked="contentWidth === opt.value"
              @click="setContentWidth(opt.value)"
            >{{ t(opt.labelKey) }}</button>
          </div>
        </div>
      </section>
      <section class="settings-section">
        <div class="pref-row">
          <div class="pref-text">
            <span class="pref-title">{{ t('settings.personal.showDiffTitle') }}</span>
            <span class="pref-desc">{{ t('settings.personal.showDiffDesc') }}</span>
          </div>
          <button
            class="pref-switch"
            :class="{ on: showDiff }"
            role="switch"
            :aria-checked="showDiff"
            :aria-label="t('settings.personal.showDiffTitle')"
            @click="setShowDiff(!showDiff)"
          >
            <span class="pref-knob"></span>
          </button>
        </div>
      </section>

      <!-- 模块 10 TD-TM-05 方案 B：终端 Shell（auto=主进程优先级链；钉住档只显示已探测到的） -->
      <section class="settings-section">
        <div class="pref-row">
          <div class="pref-text">
            <span class="pref-title">{{ t('settings.personal.terminalShellTitle') }}</span>
            <span class="pref-desc">{{ t('settings.personal.terminalShellDesc') }}</span>
          </div>
          <div class="shell-picker">
            <button
              type="button"
              class="shell-picker-trigger"
              :aria-label="t('settings.personal.terminalShellTitle')"
              @click.stop="shellMenuOpen = !shellMenuOpen"
            >
              <span class="shell-picker-label">{{ selectedShellLabel }}</span>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </button>
            <div v-if="shellMenuOpen" class="level-overlay" @click="shellMenuOpen = false"></div>
            <div v-if="shellMenuOpen" class="shell-menu">
              <button
                v-for="opt in terminalShellOptions"
                :key="opt.value"
                type="button"
                class="shell-option"
                :class="{ active: terminalShell === opt.value }"
                @click="pickShell(opt.value)"
              >
                <span>{{ opt.label }}</span>
                <svg v-if="terminalShell === opt.value" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                  <polyline points="20 6 9 17 4 12" />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 模块 12：代码查看器布局（CE-S01）。分割宽度的设置项已撤下——
           这类细节用户基本不会调，拖代码区中间的分隔线即可调整（双击复位）。 -->
      <section class="settings-section">
        <div class="pref-row">
          <div class="pref-text">
            <span class="pref-title">{{ t('settings.codeViewer.title') }}</span>
            <span class="pref-desc">{{ t('settings.codeViewer.desc') }}</span>
          </div>
          <div
            class="width-options code-layout-options"
            role="radiogroup"
            :aria-label="t('settings.codeViewer.layout')"
          >
            <button
              v-for="opt in codeLayoutOptions"
              :key="opt.value"
              class="code-layout-option"
              :class="{ active: codeViewerLayout === opt.value }"
              role="radio"
              :aria-checked="codeViewerLayout === opt.value"
              :data-tooltip="
                opt.value === 'cover'
                  ? t('settings.codeViewer.layoutCoverDesc')
                  : t('settings.codeViewer.layoutSplitDesc')
              "
              @click="setCodeViewerLayout(opt.value)"
            >{{ t(opt.labelKey) }}</button>
          </div>
        </div>
        <!-- 模块 12 P2：有修改的文件默认进哪种对比（并排/行内），代码纸右上角可临时切 -->
        <div class="pref-row">
          <div class="pref-text">
            <span class="pref-title">{{ t('settings.codeViewer.diffView') }}</span>
            <span class="pref-desc">{{ t('settings.codeViewer.diffViewDesc') }}</span>
          </div>
          <div
            class="width-options code-layout-options"
            role="radiogroup"
            :aria-label="t('settings.codeViewer.diffView')"
          >
            <button
              v-for="opt in diffViewOptions"
              :key="opt.value"
              class="code-layout-option"
              :class="{ active: codeDiffDefaultMode === opt.value }"
              role="radio"
              :aria-checked="codeDiffDefaultMode === opt.value"
              @click="setCodeDiffDefaultMode(opt.value)"
            >{{ t(opt.labelKey) }}</button>
          </div>
        </div>
      </section>
    </div>

    <!-- 关于 Tab：版本更新（无独立标题；版本行直接承载「Forge 版本」+ 检查更新/更新/重启安装，发现新版行内展示 v0.1.0 → v0.2.0） -->
    <div class="about-body" v-if="activeTab === 'about'">
      <section class="settings-section update-section">
        <!-- 版本行 + 同行右侧操作按钮；行占满到底（about-body 不限制宽度） -->
        <div class="version-row">
          <span class="version-label">{{ t('settings.update.forgeVersion') }}</span>
          <span class="version-value">v{{ forgeVersion ?? '—' }}</span>
          <template v-if="upFoundVersion !== null">
            <span class="version-arrow">→</span>
            <span class="version-next"><span class="dot"></span>v{{ upFoundVersion }}</span>
          </template>
          <span class="version-spacer"></span>
          <span class="version-actions">
            <span v-if="upCheckedUpToDate" class="up-uptodate">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12" /></svg>
              {{ t('settings.update.uptodate') }}
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
          <div class="up-progress-meta"><span>{{ t('settings.update.downloading', { version: upFoundVersion ?? '' }) }}</span><b>{{ upDownloadPct }}%</b></div>
          <div class="up-progress-track"><div class="up-progress-fill" :style="{ width: upDownloadPct + '%' }"></div></div>
        </div>
        <!-- 调试控制台（仅本地配置文件开启后可见；滚动日志展示 updater 状态迁移/调用结果/错误） -->
        <div v-if="upDebugEnabled" class="up-debug">
          <button class="up-debug-toggle" @click="upDebugOn = !upDebugOn">
            {{ upDebugOn ? t('settings.update.collapseDebug') : t('settings.update.expandDebug') }}
          </button>
          <div v-if="upDebugOn" class="up-debug-console">
            <div class="up-debug-ver">
              <span>{{ t('settings.update.debugCurrent', { version: forgeVersion ?? '—' }) }}</span>
              <span>{{ t('settings.update.debugSnapshot', { status: upSnapshot?.status ?? '—' }) }}</span>
              <span v-if="upSnapshot?.error" class="up-debug-err">{{ t('settings.update.debugError', { error: upSnapshot.error }) }}</span>
              <span class="up-debug-spacer"></span>
              <button class="up-debug-copy" :disabled="upDebugLines.length === 0" @click="onCopyDebugLog">{{ t('settings.update.copyAll') }}</button>
            </div>
            <div v-if="upDebugLines.length === 0" class="up-debug-empty">{{ t('settings.update.debugEmpty') }}</div>
            <div ref="upDebugScrollEl" class="up-debug-scroll">
              <div v-for="(l, i) in upDebugLines" :key="i" class="up-debug-line">{{ l }}</div>
            </div>
          </div>
        </div>
        <!-- 重启安装确认弹窗（IN-F03）：fixed 遮罩 + 居中 box；取消停留当前版本，确认后关闭应用安装并自动重启 -->
        <div v-if="upConfirming" class="up-confirm" role="dialog" aria-modal="true" @click.self="upConfirming = false">
          <div class="up-confirm-box">
            <div class="up-confirm-main">
              <span class="up-confirm-title">{{ t('settings.update.installTitle', { version: upFoundVersion ?? '' }) }}</span>
              <span class="up-confirm-desc">{{ t('settings.update.installDesc') }}</span>
            </div>
            <div class="up-confirm-actions">
              <button class="ghost small" @click="upConfirming = false">{{ t('common.cancel') }}</button>
              <button class="primary small" :disabled="upInstalling" @click="onQuitAndInstall">{{ t('settings.update.confirmInstall') }}</button>
            </div>
          </div>
        </div>
      </section>
    </div>

    <!-- Skills Tab（模块 09）：独立 Tab 页，进入即挂载刷新 -->
    <div class="settings-body" v-if="activeTab === 'skills'">
      <SkillsSection />
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

.settings-back {
  height: 32px;
  padding: 0 12px;
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  border-radius: 8px;
}

.settings-back svg {
  width: 15px;
  height: 15px;
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

/* 内容宽度分段控件（标准 / 宽）：与「语言」行同款胶囊单选 */
.width-options {
  display: inline-flex;
  gap: 6px;
  flex-shrink: 0;
}

/*
 * 选项片的视觉规则由「内容宽度」与「代码查看器布局」两组共用，所以每条规则都写成
 * 两个类名。**不要**把代码查看器那组也挂上 .width-option：两组的选项数不一样
 * （宽度 2 档、布局 2 档，但 reset 按钮又是个 .width-option），
 * E2E 里 locator('.width-option.active') 会同时命中两组，直接 strict mode violation。
 * 类名分开 = 选择器各打各的，互不干扰。
 */
.width-option,
.code-layout-option {
  /* 1px 环（原型 prototypes/selection-highlight-options.html B 档）：
     2px 满圈在深色主题是全屏最亮的元素，形状语言也和 focus 撞脸。
     描边每边减 1px，padding 每边补 1px → **外框尺寸逐像素不变**，
     分组内不会出现半像素错位。 */
  padding: 6px 15px;
  font-size: 12px;
  font-weight: 500;
  font-family: inherit;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.width-option:hover,
.code-layout-option:hover {
  border-color: color-mix(in oklab, var(--brand) var(--select-hover-pct), var(--border));
}

.width-option.active,
.code-layout-option.active {
  /* 环色不再用 --brand 原值，改由 --select-ring-pct 统一给出（比例按主题定，见 design-tokens.css）；
     存在感由底色补。 */
  border-color: color-mix(in oklab, var(--brand) var(--select-ring-pct), var(--border));
  background: color-mix(in oklab, var(--brand) var(--select-bg-pct), var(--card));
}

.pref-switch.on .pref-knob {
  transform: translateX(18px);
}

/* ===== 模块 12：代码查看器布局设置 ===== */

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
  padding: 9px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--card);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.theme-swatch:hover {
  border-color: color-mix(in oklab, var(--brand) var(--select-hover-pct), var(--border));
}

.theme-swatch.active {
  border-color: color-mix(in oklab, var(--brand) var(--select-ring-pct), var(--border));
  background: color-mix(in oklab, var(--brand) var(--select-bg-pct), var(--card));
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

/* 模块 08：语言切换行（外观区内、主题色板下方）。
   与「外观」同款版式：标题独占一行，选项在下方。 */
.language-row {
  margin-top: 14px;
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
}

.language-label {
  /* 与「外观」分区标题（.section-title）同款：14px/600 前景色 */
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}

.language-options {
  display: flex;
  gap: 8px;
}

.language-option {
  padding: 7px 15px;
  font-size: 12px;
  font-weight: 500;
  color: var(--foreground);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  cursor: pointer;
  transition: border-color var(--transition-fast), background var(--transition-fast);
}

.language-option:hover {
  border-color: color-mix(in oklab, var(--brand) var(--select-hover-pct), var(--border));
}

.language-option.active {
  border-color: color-mix(in oklab, var(--brand) var(--select-ring-pct), var(--border));
  background: color-mix(in oklab, var(--brand) var(--select-bg-pct), var(--card));
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
/* 终端 Shell 下拉（TD-TM-05 B）：trigger 与 level-picker 同族；设置行靠面板上方 → 向下弹 */
.shell-picker {
  position: relative;
}

.shell-picker-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 180px;
  padding: 7px 10px;
  font-size: 12.5px;
  background: var(--background);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  color: var(--foreground);
  cursor: pointer;
}

/* 全局 button:hover 会把边框和字一起染成品牌色（global.css）：本触发器不随 hover 变色 */
.shell-picker-trigger:hover {
  border-color: var(--border);
  color: var(--foreground);
}

.shell-picker-trigger svg {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}

.shell-picker-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.shell-menu {
  position: absolute;
  z-index: 11;
  top: calc(100% + 4px);
  right: 0;
  min-width: 200px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: 0 6px 24px rgba(0, 0, 0, 0.12);
  padding: 6px;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.shell-option {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12.5px;
  color: var(--foreground);
  text-align: left;
}

.shell-option:hover {
  background: var(--muted);
}

.shell-option.active {
  color: var(--brand);
}

.shell-option svg {
  width: 14px;
  height: 14px;
  margin-left: auto;
  flex-shrink: 0;
}

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

/* 测试结果一行内联反馈（成功绿/失败红，长错误可换行） */
.form-test-result {
  font-size: 12px;
  line-height: 1.5;
  word-break: break-word;
}

.form-test-result.is-ok {
  color: var(--success);
}

.form-test-result.is-fail {
  color: var(--destructive);
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
  border-color: color-mix(in oklab, var(--brand) var(--select-ring-pct), var(--border));
  background: color-mix(in oklab, var(--brand) var(--select-bg-pct), var(--card));
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