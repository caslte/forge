<script setup lang="ts">
/**
 * 内嵌终端面板（模块 10，docs/prd/10_embedded_terminal.md）。
 *
 * 视觉与交互事实来源 = prototypes/terminal-git-prototype.html（demo 验收 2026-09-23）：
 * - 底部面板：顶边 grip 拖高（120 ~ 窗口高度−280px，绝对上限 1200），tab 与面板**连体**（活动 tab 底边压住面板
 *   顶边框、左上角与面板齐平），开关 200ms 过渡。
 * - tab：终端图标 + 项目名 + hover 现形 ✕；＋ 新建（cwd 自动取当前会话项目根，
 *   无项目禁用+tooltip）。
 * - 面板右端两个动作键：终端配色档切换（暗/亮；未手选前跟随应用主题）、收起面板
 *   （等价顶栏终端按钮的「关」）。配色档落 `forge:terminal-tint`。
 *
 * 生命周期口径（TM-S04）：收起面板 pty 保活；关 tab 即 kill；组件卸载（窗口关闭/文档
 * 重载前的渲染侧动作）kill 本组件创建的全部 pty。tab 列表与终端内容不持久化（TM-S05）。
 *
 * 数据流（TD-TM-03）：输入 term/write invoke 上行；输出/退出经 term:data/term:exit
 * 事件下行，按 ptyId 路由到对应 tab 的 xterm 实例。所有 tab 各持**存活** xterm
 * （display 切换不销毁），后台 tab 持续写入自身 buffer → 切回即最新（AC-10-04）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import { invokeRaw, subscribe } from '../bridge';
import type { TermCreateResult, TermDataPayload, TermExitPayload } from '../bridge';
import { useI18n } from '../i18n/index.ts';
import { usePreferences, clampTerminalHeight } from '../composables/usePreferences.ts';
import { useTheme } from '../composables/useTheme.ts';
import { useToast } from '../composables/useToast.ts';

const props = defineProps<{
  /** 新 tab 的 cwd 来源（当前会话项目根）；null = 无项目，＋ 禁用 */
  projectPath: string | null;
  /** tab 标题（项目别名 ?? 目录名） */
  projectName: string;
}>();

const { t } = useI18n();
const { terminalOpen, terminalHeight, terminalTint, setTerminalOpen, setTerminalHeight, setTerminalTint } =
  usePreferences();
const { themeMode } = useTheme();
const { info: toastInfo } = useToast();

interface TermTab {
  /** UI 本地 id（ptyId 确认前也可寻址） */
  id: string;
  ptyId: string | null;
  name: string;
  cwd: string;
  term: Terminal;
  fit: FitAddon;
  host: HTMLDivElement;
  /** create 在途（tab 显示「连接中…」防御态） */
  creating: boolean;
  exited: boolean;
  /** 最近一次已同步给 pty 的尺寸（去重 resize 风暴） */
  lastCols: number;
  lastRows: number;
}

const tabs = shallowRef<TermTab[]>([]);
const activeId = ref<string | null>(null);
const bodyRef = ref<HTMLElement | null>(null);
const dragging = ref(false);
const activeTab = () => tabs.value.find((x) => x.id === activeId.value) ?? null;
const showConnecting = computed(() =>
  tabs.value.some((x) => x.id === activeId.value && x.creating),
);

/**
 * tabs 是 shallowRef（xterm 实例不做深响应），直接改 tab 字段不会触发任何 computed/模板重算
 * ——「连接中」会永远挂着。状态字段一律经这个辅助函数改：重排数组引用，强制重求值。
 */
function patchTab(tab: TermTab, patch: Partial<Pick<TermTab, 'creating' | 'exited' | 'ptyId'>>): void {
  Object.assign(tab, patch);
  tabs.value = [...tabs.value];
}

let seq = 0;
let disposed = false;
let unsubData: (() => void) | null = null;
let unsubExit: (() => void) | null = null;
let ro: ResizeObserver | null = null;
let tooManyWarned = false;

/**
 * 主进程在 spawn 成功那一刻就开始推 term:data/exit，而 ptyId 要等 create 应答回传
 * ——首块输出（如 shell prompt）会先于 tab.ptyId 到位。未能认领的下行事件按 ptyId
 * 暂存，create 应答确认归属后回放；无人认领（tab 已关/生成失败）随 tab 回收丢弃。
 */
type PendingTermEvent = { kind: 'data'; data: string } | { kind: 'exit'; exitCode: number };
const pendingEvents = new Map<string, PendingTermEvent[]>();

function routeOrQueue(ptyId: string, ev: PendingTermEvent): void {
  const tab = tabs.value.find((x) => x.ptyId === ptyId);
  if (tab !== undefined) {
    applyTermEvent(tab, ev);
    return;
  }
  const q = pendingEvents.get(ptyId);
  if (q !== undefined) q.push(ev);
  else pendingEvents.set(ptyId, [ev]);
}

function applyTermEvent(tab: TermTab, ev: PendingTermEvent): void {
  if (ev.kind === 'data') {
    tab.term.write(ev.data);
    return;
  }
  if (tab.exited) return;
  patchTab(tab, { exited: true });
  tab.term.write(`\r\n\x1b[90m${t('terminal.exited', { code: ev.exitCode })}\x1b[0m\r\n`);
}

function flushPendingEvents(tab: TermTab): void {
  const q = tab.ptyId === null ? undefined : pendingEvents.get(tab.ptyId);
  if (q === undefined) return;
  pendingEvents.delete(tab.ptyId as string);
  for (const ev of q) applyTermEvent(tab, ev);
}

/** design-tokens → xterm 主题 */
function cssVar(name: string, fallback: string): string {
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v === '' ? fallback : v;
}

/**
 * 终端两档配色。**必须是 hex**：xterm 的颜色解析只认 `#rgb/#rrggbb/rgb()`，design tokens
 * 里的 `oklch()`/`color-mix()` 串会被判非法并静默回退成 xterm 默认色（此前终端的底色/字色
 * 实际就是默认色，靠 `.term-body` 的 CSS 底色衬着才看不出）。取值 = 两档令牌换算后的 sRGB。
 */
const TERM_PALETTE = {
  dark: { background: '#15171d', foreground: '#ccced0', cursor: '#70ccae', selection: '#2a2c31' },
  light: { background: '#f4f4f5', foreground: '#333333', cursor: '#46987e', selection: '#dfdede' },
} as const;

/** 生效档：auto 跟随应用主题，dark/light 为用户手选 */
const termDark = computed(
  () => (terminalTint.value === 'auto' ? themeMode.value === 'dark' : terminalTint.value === 'dark'),
);
const termPalette = computed(() => (termDark.value ? TERM_PALETTE.dark : TERM_PALETTE.light));

function xtermTheme() {
  const p = termPalette.value;
  return {
    background: p.background,
    foreground: p.foreground,
    cursor: p.cursor,
    selectionBackground: p.selection,
  };
}

function buildTerminal(): Terminal {
  const term = new Terminal({
    fontFamily: cssVar('--font-mono', 'Consolas, Menlo, monospace'),
    fontSize: 12,
    // 1.8 沿用 demo 静态文本的观感，真实终端里行距明显偏松（用户 2026-09-29 反馈）
    lineHeight: 1.4,
    scrollback: 1000,
    cursorBlink: true,
    theme: xtermTheme(),
  });
  bindCopyShortcut(term);
  return term;
}

/** 剪贴板写入：Clipboard API 优先（需文档有焦点），失败退临时 textarea + execCommand */
async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    /* 落到兜底路径 */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.cssText = 'position:fixed;top:-100px;opacity:0';
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand('copy');
  } catch {
    /* 两条路都不通：不弹错误打扰，选区仍在屏幕上 */
  }
  ta.remove();
}

/**
 * 有选区时 Ctrl/Cmd+C（及 Ctrl+Insert）= 复制，不发给 shell；无选区原样放行（Ctrl+C
 * 仍是终端的「中断」语义）。xterm 自身不绑复制键，这段是「终端里能复制」的全部实现。
 */
function bindCopyShortcut(term: Terminal): void {
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !term.hasSelection()) return true;
    const k = e.key.toLowerCase();
    const copyKey = (e.ctrlKey || e.metaKey) && k === 'c';
    const insertKey = e.ctrlKey && k === 'insert';
    if (!copyKey && !insertKey) return true;
    void copyText(term.getSelection().replace(/\r\n?/g, '\n'));
    return false;
  });
}

watch([themeMode, terminalTint], () => {
  const theme = xtermTheme();
  for (const tab of tabs.value) tab.term.options.theme = theme;
});

/** 手选档与生效档相反即切过去（auto 下第一击 = 逆着当前应用主题的那一档） */
function toggleTint(): void {
  setTerminalTint(termDark.value ? 'light' : 'dark');
}

/** 新建 tab：xterm 先行（占位渲染 + 真实尺寸），pty 随后按该尺寸 spawn */
async function createTab(): Promise<void> {
  const cwd = props.projectPath;
  if (cwd === null || disposed) return;
  if (tabs.value.length >= 20 && !tooManyWarned) {
    tooManyWarned = true;
    toastInfo(t('terminal.tooMany', { n: tabs.value.length + 1 }));
  }
  const host = document.createElement('div');
  host.className = 'term-host is-hidden';
  const term = buildTerminal();
  const fit = new FitAddon();
  term.loadAddon(fit);
  // 右键 = Windows Terminal 口径：有选区即复制（无选区不拦，行为与现状一致）
  host.addEventListener('contextmenu', (ev) => {
    if (!term.hasSelection()) return;
    ev.preventDefault();
    void copyText(term.getSelection().replace(/\r\n?/g, '\n'));
  });
  const tab: TermTab = {
    id: `tm-${++seq}`,
    ptyId: null,
    name: props.projectName,
    cwd,
    term,
    fit,
    host,
    creating: true,
    exited: false,
    lastCols: 80,
    lastRows: 24,
  };
  bodyRef.value?.appendChild(host);
  tabs.value = [...tabs.value, tab];
  setActive(tab.id);
  term.open(host);
  // 先量一次真实尺寸再 spawn：xterm 默认 80×24，直接拿去建 pty 会让 shell 按 24 行
  // 排版、而视口只有 8 行——多出来的行全被推进滚动区（表现为「空白，往上滚才有字」）
  refitTab(tab);
  const spawnCols = term.cols;
  const spawnRows = term.rows;
  term.onData((data) => {
    if (tab.ptyId === null || tab.exited) return;
    void invokeRaw('term/write', { ptyId: tab.ptyId, data });
  });
  const res = await invokeRaw<TermCreateResult>('term/create', {
    cwd,
    cols: spawnCols,
    rows: spawnRows,
  });
  // 临时诊断（模块10 断链排查，定位后删除）
  console.log(`[term-diag] create envelope code=${res.code} ptyId=${res.data?.ptyId.slice(0, 8) ?? 'null'}`);
  if (disposed || !tabs.value.includes(tab)) {
    // tab 在 create 往返期间被关闭：回收刚建好的 pty 与其暂存事件
    if (res.code === 0 && res.data !== null) {
      pendingEvents.delete(res.data.ptyId);
      void invokeRaw('term/kill', { ptyId: res.data.ptyId });
    }
    return;
  }
  if (res.code !== 0 || res.data === null) {
    patchTab(tab, { creating: false, exited: true });
    term.write(`\x1b[31m${t('terminal.spawnFailed', { message: res.message })}\x1b[0m\r\n`);
    return;
  }
  patchTab(tab, { creating: false, ptyId: res.data.ptyId });
  // pty 现在的尺寸 = 建它时那一份；据此立比对基准，再重测一次：
  // 只有真的变了才补发 resize（同尺寸的 resize 会让 ConPTY 重排，把 banner 顶出可视区）
  tab.lastCols = spawnCols;
  tab.lastRows = spawnRows;
  refitTab(tab);
  flushPendingEvents(tab);
  term.focus();
}

function setActive(id: string): void {
  activeId.value = id;
  for (const tab of tabs.value) {
    tab.host.classList.toggle('is-hidden', tab.id !== id);
  }
  void nextTick(() => refitTab(activeTab()));
}

/** 量容器 → 定 xterm 行列 → 需要时同步给 pty。fit 与 resize 必须成对，缺一即错位 */
function refitTab(tab: TermTab | null): void {
  if (tab === null || tab.exited) return;
  try {
    tab.fit.fit();
  } catch {
    /* 容器 0 尺寸（面板收起/过渡未落定）：等 ResizeObserver 再来一次 */
    return;
  }
  syncTabSize(tab);
}

function syncTabSize(tab: TermTab | null): void {
  if (tab === null || tab.ptyId === null || tab.exited) return;
  if (tab.term.cols === tab.lastCols && tab.term.rows === tab.lastRows) return;
  tab.lastCols = tab.term.cols;
  tab.lastRows = tab.term.rows;
  void invokeRaw('term/resize', { ptyId: tab.ptyId, cols: tab.lastCols, rows: tab.lastRows });
}

async function closeTab(id: string): Promise<void> {
  const idx = tabs.value.findIndex((x) => x.id === id);
  if (idx < 0) return;
  const tab = tabs.value[idx]!;
  tabs.value = tabs.value.filter((x) => x.id !== id);
  if (tab.ptyId !== null) {
    pendingEvents.delete(tab.ptyId);
    void invokeRaw('term/kill', { ptyId: tab.ptyId });
  }
  try {
    tab.term.dispose();
  } catch {
    /* dispose 竞态无需处理 */
  }
  tab.host.remove();
  if (activeId.value === id) {
    const next = tabs.value[tabs.value.length - 1] ?? null;
    if (next !== null) {
      setActive(next.id);
    } else {
      activeId.value = null;
      tooManyWarned = false;
    }
  }
}

// ===== 事件下行路由（TD-TM-03）：按 ptyId 写各自存活的 xterm，后台 tab 不断流 =====
function onTermData(payload: unknown): void {
  const p = payload as TermDataPayload;
  // 临时诊断（模块10 断链排查，定位后删除）
  console.log(`[term-diag] panel onTermData (ptyId=${p.ptyId.slice(0, 8)}, bytes=${p.data.length})`);
  routeOrQueue(p.ptyId, { kind: 'data', data: p.data });
}

function onTermExit(payload: unknown): void {
  const p = payload as TermExitPayload;
  routeOrQueue(p.ptyId, { kind: 'exit', exitCode: p.exitCode });
}

// ===== 面板开关与自动 newTab（TM-S01/S02）=====
let pendingAutoCreate = false;

function togglePanel(): void {
  setTerminalOpen(!terminalOpen.value);
}

/**
 * 面板高度带 CSS 过渡（0 ↔ --h），过渡途中的容器尺寸是中间态——此刻 fit 出的行列既不该
 * 拿去 spawn（shell 会按错行数排版，banner 被顶出可视区 = 「上面空一块」），也不该连着
 * 发多次 resize（每次都会让 ConPTY 重排一次屏）。所以开关/拖拽后一律等落定再量一次。
 * 260ms ≈ --transition-base。
 */
const PANEL_SETTLE_MS = 260;
let settleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * 「空面板被打开 → 自动建一个 tab」的意图位。
 * 不能只把 allowCreate 当 scheduleSettle 的入参传：面板高度过渡期间 ResizeObserver 会
 * 连着回调并各自重排一次 settle 定时器，默认不建 tab 的那几次会把带建 tab 的那一次顶掉，
 * 于是点顶栏终端按钮只开了个空面板。意图单独记账，谁最后落定都算数。
 */
let wantAutoCreate = false;

/** 等面板高度落定后重测活动 tab；空面板且记账了开面板意图则补建 tab */
function scheduleSettle(): void {
  if (settleTimer !== null) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    settleTimer = null;
    if (disposed || !terminalOpen.value) return;
    if (tabs.value.length === 0) {
      if (!wantAutoCreate) return;
      wantAutoCreate = false;
      // cwd=当前项目（会话点入时 App.vue 已把项目对齐到会话归属）；无项目 → 等项目就绪补做
      if (props.projectPath !== null) void createTab();
      else pendingAutoCreate = true;
      return;
    }
    refitTab(activeTab());
  }, PANEL_SETTLE_MS);
}

watch(terminalOpen, (open) => {
  if (!open) return;
  wantAutoCreate = tabs.value.length === 0;
  scheduleSettle();
});

watch(
  () => props.projectPath,
  (p) => {
    if (pendingAutoCreate && p !== null && terminalOpen.value && tabs.value.length === 0) {
      pendingAutoCreate = false;
      void createTab();
    }
  },
);

// ===== 拖高（TM-F01）：拖动只改本地样式，松手才落 localStorage =====
const liveHeight = ref(terminalHeight.value);
watch(terminalHeight, (h) => {
  if (!dragging.value) liveHeight.value = h;
});

/**
 * 窗口变矮 → 上限跟着降 → 把超限的面板高度收回内存值（AC-10-02「极小窗口 clamp」同款口径）。
 * 故意不写 localStorage：窗口拉回去时用户记着的那个数还在。
 */
function onWindowResize(): void {
  const clamped = clampTerminalHeight(terminalHeight.value);
  if (clamped !== terminalHeight.value) terminalHeight.value = clamped;
}

function onGripDown(ev: PointerEvent): void {
  if (!terminalOpen.value) return;
  ev.preventDefault();
  dragging.value = true;
  const startY = ev.clientY;
  const startH = liveHeight.value;
  const target = ev.currentTarget as HTMLElement;
  try {
    target.setPointerCapture(ev.pointerId);
  } catch {
    /* 合成/失效 pointer 无活动态可捕获：document 级监听照常工作 */
  }
  const mv = (e: PointerEvent): void => {
    liveHeight.value = clampTerminalHeight(startH - (e.clientY - startY));
  };
  const up = (): void => {
    dragging.value = false;
    setTerminalHeight(liveHeight.value);
    document.removeEventListener('pointermove', mv);
    document.removeEventListener('pointerup', up);
    // 松手即终态（拖高期间无过渡），立刻重测：只 sync 不 fit 会让 xterm 停在旧行列
    refitTab(activeTab());
  };
  document.addEventListener('pointermove', mv);
  document.addEventListener('pointerup', up);
}

onMounted(() => {
  unsubData = subscribe('term:data', onTermData);
  unsubExit = subscribe('term:exit', onTermExit);
  if (bodyRef.value !== null) {
    // 容器尺寸变化（窗口缩放、侧栏折叠、面板过渡）→ 落定后重测一次；
    // 连续变化用防抖收成一次，避免一路 resize 打给 ConPTY
    ro = new ResizeObserver(() => {
      if (dragging.value) return;
      scheduleSettle();
    });
    ro.observe(bodyRef.value);
  }
  // 冷启动恢复「开着的」面板：同 watch 口径自动补一个 tab
  if (terminalOpen.value && tabs.value.length === 0) {
    wantAutoCreate = true;
    scheduleSettle();
  }
  window.addEventListener('resize', onWindowResize);
});

onBeforeUnmount(() => {
  disposed = true;
  window.removeEventListener('resize', onWindowResize);
  unsubData?.();
  unsubExit?.();
  ro?.disconnect();
  // 渲染侧标签页销毁 = UI 不再引用任何 pty，全部回收（主进程 did-navigate 兜底同款）
  for (const tab of tabs.value) {
    if (tab.ptyId !== null) void invokeRaw('term/kill', { ptyId: tab.ptyId });
    tab.term.dispose();
  }
  tabs.value = [];
});

defineExpose({ togglePanel });
</script>

<template>
  <div
    class="term"
    :class="{ open: terminalOpen, dragging }"
    :style="{ '--h': liveHeight + 'px', '--term-surface': termPalette.background, '--term-ink': termPalette.foreground }"
  >
    <div class="grip" @pointerdown="onGripDown"></div>
    <div class="term-bar">
      <span
        v-for="tab in tabs"
        :key="tab.id"
        class="term-tab"
        :class="{ on: tab.id === activeId }"
        :title="tab.cwd"
        @click="setActive(tab.id)"
        @auxclick.middle.prevent="closeTab(tab.id)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
        <span class="term-tab-name">{{ tab.name }}</span>
        <button
          class="x"
          :data-tooltip="t('terminal.closeTab')"
          @click.stop="closeTab(tab.id)"
        >✕</button>
      </span>
      <button
        class="term-add"
        :data-tooltip="projectPath === null ? t('terminal.addNoProject') : t('terminal.add')"
        :disabled="projectPath === null"
        @click="createTab()"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
      <span class="spacer"></span>
      <!-- 面板右侧动作键：终端配色档切换 + 收起面板（等价右上角终端按钮的关） -->
      <button
        class="term-act"
        :data-tooltip="termDark ? t('terminal.tintToLight') : t('terminal.tintToDark')"
        @click="toggleTint"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <circle cx="12" cy="12" r="8" />
          <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
        </svg>
      </button>
      <button
        class="term-act"
        :data-tooltip="t('terminal.hidePanel')"
        @click="setTerminalOpen(false)"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <line x1="18" y1="6" x2="6" y2="18" />
          <line x1="6" y1="6" x2="18" y2="18" />
        </svg>
      </button>
    </div>
    <div ref="bodyRef" class="term-body">
      <span v-if="tabs.length === 0" class="dim">{{ t('terminal.empty') }}</span>
      <span v-if="showConnecting" class="dim term-connecting">{{ t('terminal.connecting') }}</span>
    </div>
  </div>
</template>

<style scoped>
/* 全部取自 design-tokens（demo .term 一节逐值对齐） */
.term {
  flex: none;
  height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-top: 1px solid var(--border);
  background: var(--background);
  transition: height var(--transition-base);
}

.term.open {
  height: var(--h, 240px);
}

/* 拖高期间去过渡：高度必须逐帧跟手 */
.term.dragging {
  transition: none;
}

.term .grip {
  height: 5px;
  flex: none;
  cursor: row-resize;
  margin-top: -5px;
  z-index: 1;
}

.term .grip:hover {
  background: color-mix(in oklab, var(--brand-accent) 30%, transparent);
}

.term-bar {
  flex: none;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px 0;
  font-size: 12.5px;
}

/* 连体 tab（D5 定稿）：底边压住面板顶边框、面板左上角直角 */
.term-tab {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 5px 10px;
  max-width: 240px;
  cursor: pointer;
  border: 1px solid transparent;
  border-bottom: none;
  color: var(--muted-foreground);
  font-size: 12px;
  position: relative;
  margin-bottom: -1px;
  border-radius: var(--radius-md) var(--radius-md) 0 0;
}

.term-tab.on {
  /* 与终端面同色（--term-surface 由 script 侧配色档绑定，手选暗色时 tab 一起变） */
  background: var(--term-surface);
  border-color: var(--border);
  border-bottom: 1px solid var(--term-surface);
  color: var(--term-ink);
}

.term-tab svg {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
}

.term-tab-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.term-tab .x {
  font-size: 12px;
  opacity: 0;
  border: none;
  background: transparent;
  border-radius: 4px;
  width: 16px;
  height: 16px;
  line-height: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  color: inherit;
  cursor: pointer;
}

.term-tab:hover .x {
  opacity: 0.6;
}

.term-tab .x:hover {
  opacity: 1;
  background: var(--surface-hover);
}

.term-add {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.term-add:hover:not(:disabled) {
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  color: var(--foreground);
}

.term-add:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.term-add svg {
  width: 13px;
  height: 13px;
}

.term-bar .spacer {
  flex: 1;
}

/* 面板右端动作键（配色档切换 / 收起面板）：与 ＋ 同尺寸同质地，常驻可见 */
.term-act {
  width: 24px;
  height: 24px;
  padding: 0;
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  display: inline-flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
}

.term-act:hover {
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  color: var(--foreground);
}

.term-act svg {
  width: 13px;
  height: 13px;
}

.term-body {
  position: relative;
  flex: 1;
  min-height: 0;
  margin: 0 10px 10px;
  padding: 10px 14px;
  background: var(--term-surface);
  border: 1px solid var(--border);
  border-radius: 0 var(--radius-lg) var(--radius-lg) var(--radius-lg);
  overflow: hidden;
}

.term-body .dim {
  color: var(--term-ink);
  opacity: 0.62;
  font-size: 12px;
}

.term-connecting {
  position: absolute;
  top: 10px;
  left: 14px;
}

/* xterm 宿主铺满 term-body（多 tab 常存，display 切换） */
.term-body :deep(.term-host) {
  position: absolute;
  inset: 10px 6px 10px 14px;
}

.term-body :deep(.term-host.is-hidden) {
  display: none;
}
</style>
