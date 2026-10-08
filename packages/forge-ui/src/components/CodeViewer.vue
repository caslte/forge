<script setup lang="ts">
/**
 * 内置只读代码查看器（模块 12 CE-S08 ~ CE-S11）。
 *
 * 三条硬约束：
 * 1. **只读**——没有输入框、没有保存按钮、没有编辑相关键盘绑定。改代码请回编辑器：
 *    这是「减少对 VSCode 依赖」而不是「替代编辑器」的前提。
 * 2. **不改内容**——正文只经「转义 + 逐行高亮」后原样渲染，不 trim 尾换行、
 *    不做智能引号替换；转义由 hljs/escapeDiffHtml 负责。
 * 3. **降级优先于报错**——二进制 / 超大 / 已删除都渲染成明确状态页并给出下一步，
 *    永远不白屏、也不连弹 toast。
 *
 * 高亮复用 `highlightDiffLine`（与 diff 视图同一份实现与配色），但补了它缺的一环：
 * hljs 逐行调用时没有跨行状态，跨行块注释的中间行会被当普通代码上色。
 * markBlockCommentLines 负责把这些行捞出来整体按注释渲染。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  buildSideBySideDiff,
  detectDiffLanguage,
  highlightDiffLine,
  type SideBySideRow,
} from '@forge/core/side-by-side-diff';
import {
  collectDiffOmissions,
  parseGitInlineDiff,
  parseGitUnifiedDiff,
  type InlineDelBlock,
  type ParsedInlineDiff,
} from '../utils/gitDiffRows';
import { markBlockCommentLines } from '../utils/codeBlockComment';
import { fileBadgeOf } from '../utils/fileBadge';
import { gitStatusUi } from '../utils/gitStatusUi';
import { useCodeExplorer } from '../composables/useCodeExplorer';
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue';
import type { OpenFile } from '../composables/useCodeExplorer';
import type { GitStatusFile } from '../types';
import { usePreferences } from '../composables/usePreferences';
import { formatCaps } from '../utils/platformKey';
import { useI18n } from '../i18n/index.ts';

/** 终端开合键的展示文本（模块 13）：平台化 ⌘` / Ctrl+`，不写死在 i18n 文案里 */
const TERMINAL_HOTKEY = formatCaps(['P', '`']);

const { t } = useI18n();
const { setTerminalOpen, terminalOpen } = usePreferences();
const { getFileDiff, setViewerMode } = useCodeExplorer();

/**
 * 一次性渲染多少行。50,000 行的文件若全量 v-html，渲染进程会卡住数秒。
 * 与 DiffView 的 INITIAL_ROWS 同一思路：先给足「够读完」的量，要更多再点。
 */
const INITIAL_LINES = 2000;
const PAGE_LINES = 2000;

const props = defineProps<{
  /** 全部已打开文件（标签栏数据源）；组件按 activeRel 选出正文 */
  files: OpenFile[];
  /** 当前激活文件的 relPath */
  activeRel: string | null;
  /** 当前项目绝对路径（并排 diff 经 git/getFileDiff 拉取要用；null=不可拉） */
  projectPath: string | null;
  /** 行尾 Git 徽标（仅文件级） */
  gitStatus?: GitStatusFile | null;
  /**
   * 请求的正文形态（file/inline/side）：状态在 useCodeExplorer（左栏变更视图
   * 点文件要把右侧切到对比，两组件共用一份）。缺省 = file。
   */
  mode?: 'file' | 'inline' | 'side';
}>();

const emit = defineEmits<{
  (e: 'select', relPath: string): void;
  (e: 'close', relPath: string): void;
  /** 拖拽排序 / 左移右移：把 relPath 移到 toIndex（组件不直接改 props） */
  (e: 'move', relPath: string, toIndex: number): void;
  /** 正文形态切换（文件 / 行内 / 并排），回写给 useCodeExplorer 统一保管 */
  (e: 'set-mode', mode: 'file' | 'inline' | 'side'): void;
}>();

const activeFile = computed(
  () => props.files.find((f) => f.relPath === props.activeRel) ?? null,
);

/** 该文件有未提交变更才谈得上对比 */
const hasGitChanges = computed(() => props.gitStatus != null);

/** 实际生效的正文形态：请求对比但该文件没有变更时落回文件正文
 *  （没改动不给 diff——按钮置灰，正文绝不弹全空对比） */
const effectiveMode = computed<'file' | 'inline' | 'side'>(() =>
  props.mode === 'inline' || props.mode === 'side'
    ? hasGitChanges.value
      ? props.mode
      : 'file'
    : 'file',
);

/** 行号列宽：随总行数位数增长，下限 3 位（101 行与 1001 行的观感一致） */
const gutterWidth = computed(() => {
  const n = activeFile.value?.data?.totalLines ?? 0;
  return `${Math.max(3, String(Math.max(n, 1)).length)}ch`;
});

/** 换文件才重算：逐行 v-html 是本组件唯一有 CPU 成本的一步 */
type Row = { no: number; html: string; isComment: boolean };
const rows = ref<Row[]>([]);
const renderedCount = ref(INITIAL_LINES);
const htmlCacheKey = ref('');

/** relPath + size + mtime 三元组：同名文件被外部改写后必须重算 */
const cacheKey = computed(() => {
  const f = activeFile.value;
  if (!f?.data) return '';
  return `${f.relPath}:${f.data.size}:${f.data.mtimeMs}`;
});

/**
 * tab 条的横向滚动。
 *
 * 两个真问题：
 * 1. 签数超过纸宽时，激活签可能停在可视区外（切完签眼睛要自己找）——切签时滚进视野。
 * 2. 滚动条被藏了（原型如此），不给出“右边还有”的提示就没人会去滚——溢出时挂右缘渐隐。
 *
 * 渐隐靠 ResizeObserver 而不是只靠 scroll：窗口拉宽/拉窄、纸宽变化（cover↔split）
 * 都会改 overflow，但**不产生 scroll 事件**，只在 scroll 里量永远会慢一拍。
 */
const tabsEl = ref<HTMLElement | null>(null);
const tabsOverflow = ref(false);
let tabsRO: ResizeObserver | null = null;

function syncTabsOverflow(): void {
  const el = tabsEl.value;
  tabsOverflow.value = !!el && el.scrollWidth > el.clientWidth + 1;
}

/** 把激活签滚进视野；inline:'nearest' 保证只在真的看不见时才动，避免每次都跳到最左 */
async function revealActiveTab(): Promise<void> {
  await nextTick();
  const el = tabsEl.value;
  if (!el) return;
  const active = el.querySelector<HTMLElement>('.cv-tab.active');
  active?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  syncTabsOverflow();
}

/** tab 溢出时把竖向滚轮折成横向滚动。
 *
 *  实测（Chromium/msedge，1400px 分割、7 个签）：
 *  `mouse.wheel(0, 240)` → scrollLeft 纹丝不动，`mouse.wheel(240, 0)` → +240。
 *  也就是说浏览器**不会**把竖向滚轮自动折给「只有横向溢出」的容器，
 *  于是“鼠标停在签上滚一下”完全无效——用户只会得出“滚不动”的结论。
 *
 *  三个约束：
 *  1. 只在真溢出时接管，否则会吞掉本该冒泡出去的滚动；
 *  2. deltaY 折完没动就不 preventDefault，让原生行为（横向滚轮 / 触控板）接手；
 *  3. 不用 shift+滚轮（浏览器已给横向意图），重复搬会双倍速度。 */
function onTabsWheel(e: WheelEvent): void {
  const el = tabsEl.value;
  if (!el || e.deltaY === 0 || e.shiftKey) return;
  if (el.scrollWidth <= el.clientWidth + 1) return;
  const before = el.scrollLeft;
  el.scrollLeft = before + e.deltaY;
  if (el.scrollLeft !== before) e.preventDefault();
}

watch(() => [props.activeRel, props.files.length], () => void revealActiveTab());

onMounted(() => {
  syncTabsOverflow();
  if (typeof ResizeObserver !== 'undefined' && tabsEl.value) {
    tabsRO = new ResizeObserver(() => syncTabsOverflow());
    tabsRO.observe(tabsEl.value);
  }
});

onBeforeUnmount(() => {
  tabsRO?.disconnect();
  tabsRO = null;
});

/**
 * 中键关闭 tab（编辑器通用手势）。
 *
 * 不用 auxclick：CDP 派发的中键（Playwright / 部分自动化链路）根本不产生 auxclick
 * 事件，挂在 auxclick 上就是「鼠标能关、测试关不了」——更糟的是它看起来像偶发。
 * mousedown + mouseup 配对在所有输入路径上都有，且能区分中键拖拽（自动滚动）。
 */
let auxDown: { relPath: string; target: unknown } | null = null;

function onTabAuxDown(e: MouseEvent, relPath: string): void {
  if (e.button !== 1) return;
  // preventDefault 挡掉中键的原生「自动滚动」光标；stop 免得中键又被当成切签
  e.preventDefault();
  e.stopPropagation();
  auxDown = { relPath, target: e.currentTarget };
}

function onTabAuxUp(e: MouseEvent, relPath: string): void {
  if (e.button !== 1) return;
  // 按下与抬起必须落在**同一个签**上才关，否则那是中键拖拽滚动而不是关闭
  if (auxDown && auxDown.target === e.currentTarget && auxDown.relPath === relPath) {
    e.stopPropagation();
    emit('close', relPath);
  }
  auxDown = null;
}

/* ===== tab 拖拽排序 =====
 *
 * 四个约束，每一个都是实测出来的：
 * 1. **阈值 4px**：不设阈值的话，“手按下签时抖一下”会把签抽走。
 * 2. **只用主键**：中键已经用于关闭（onTabAuxDown/Up），主键拖拽与它互不干涉。
 * 3. **拖过就不再响应 click**：pointerup 后浏览器还会补一个 click，不吞掉就会在
 *    “拖完了签” 的同时把它切激活（手势附带副作用，和中键关闭一个道理）。
 * 4. **拖动不切激活签**：moveFile 只改顺序。
 */
const DRAG_THRESHOLD = 4;
/** 拖到签条左右这个距离以内就开始自动滚动 */
const EDGE_SCROLL_ZONE = 48;

interface DragState {
  relPath: string;
  startX: number;
  /** 已越过阈值、真的在拖 */
  active: boolean;
}
/** ref 而非普通变量：拖拽中的签需要淡化反馈，那是模板要读的响应式状态 */
const drag = ref<DragState | null>(null);
/** pointerup 之后紧跟的那个 click 需要被吞掉 */
let suppressClick = false;

function onTabPointerDown(e: PointerEvent, relPath: string): void {
  // 只接主键；中键归关闭处理
  if (e.button !== 0) return;
  drag.value = { relPath, startX: e.clientX, active: false };
}

function onTabPointerMove(e: PointerEvent): void {
  const d = drag.value;
  if (!d) return;
  if (!d.active) {
    if (Math.abs(e.clientX - d.startX) < DRAG_THRESHOLD) return;
    d.active = true;
  }
  e.preventDefault();
  const strip = tabsEl.value;
  if (!strip) return;

  // 拖到边缘时自动滚动：签条本来就溢出，不自动滚就拖不到后面的签。
  // 力度按「深入边缘的距离」线性给，浅擦一下不滚，贴到底才最快。
  const r = strip.getBoundingClientRect();
  const leftGap = e.clientX - r.left;
  const rightGap = r.right - e.clientX;
  const speed = (gap: number): number => {
    if (gap > EDGE_SCROLL_ZONE) return 0;
    return Math.round(((EDGE_SCROLL_ZONE - gap) / EDGE_SCROLL_ZONE) * 18);
  };
  if (speed(leftGap)) strip.scrollLeft -= speed(leftGap);
  if (speed(rightGap)) strip.scrollLeft += speed(rightGap);

  // 目标下标：取指针落在哪个签的左半/右半。直接用当前布局算，不用累计位移。
  const tabs = [...strip.querySelectorAll<HTMLElement>('.cv-tab')];
  let target = tabs.length - 1;
  for (let i = 0; i < tabs.length; i += 1) {
    const tr = tabs[i]?.getBoundingClientRect();
    if (!tr) continue;
    if (e.clientX < tr.left + tr.width / 2) {
      target = i;
      break;
    }
  }
  emit('move', d.relPath, target);
}

function onTabPointerUp(): void {
  if (!drag.value) return;
  // 拖过就吞掉紧随的 click（见约束 3）
  suppressClick = drag.value.active;
  drag.value = null;
}

function onTabClick(e: MouseEvent, relPath: string): void {
  if (suppressClick) {
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  emit('select', relPath);
}

/** tab 右键菜单：左移 / 右移 / 关闭 =====
 * 拖拽是鼠标用户的手段，但「移到最左/最右」这类操作拖拽做起来很憋屈
 * （要一路贴着边缘自动滚），所以给一份显式菜单。
 * 到边界的项置 disabled 而不是隐藏：位置不变、用户能看到“它存在但现在不行”。
 *
 * 注：曾同时提供 Ctrl+Shift+PageUp/PageDown 快捷键，已按用户要求去掉——
 * 保留拖拽 + 菜单两套就够，再加快捷键反而多一处与 VSCode 绑定的不一致。 */
const tabCtx = ref<{ relPath: string; x: number; y: number } | null>(null);

function onTabContextMenu(e: MouseEvent, relPath: string): void {
  e.preventDefault();
  e.stopPropagation();
  tabCtx.value = { relPath, x: e.clientX, y: e.clientY };
}

const ICON_LEFT = 'M15 18l-6-6 6-6';
const ICON_RIGHT = 'M9 18l6-6-6-6';
const ICON_X = 'M18 6L6 18M6 6l12 12';

const tabCtxItems = computed<ContextMenuItem[]>(() => {
  // 局部变量**不能叫 t**：那会把 useI18n 的 t() 遮蔽掉，报错是
  // 「This expression is not callable」，与真因隔着十万八千里
  const target = tabCtx.value;
  if (!target) return [];
  const i = props.files.findIndex((f) => f.relPath === target.relPath);
  if (i === -1) return [];
  return [
    { key: 'left', label: t('code.tabMoveLeft'), icon: ICON_LEFT, disabled: i === 0 },
    {
      key: 'right',
      label: t('code.tabMoveRight'),
      icon: ICON_RIGHT,
      disabled: i === props.files.length - 1,
    },
    { key: 'close', label: t('code.tabClose'), icon: ICON_X, danger: true },
  ];
});

function onTabCtxSelect(key: string): void {
  const target = tabCtx.value;
  tabCtx.value = null;
  if (!target) return;
  const i = props.files.findIndex((f) => f.relPath === target.relPath);
  if (i === -1) return;
  if (key === 'left') emit('move', target.relPath, i - 1);
  else if (key === 'right') emit('move', target.relPath, i + 1);
  else if (key === 'close') emit('close', target.relPath);
}

watch(
  cacheKey,
  (key) => {
    renderedCount.value = INITIAL_LINES;
    if (!key || key === htmlCacheKey.value) return;
    const d = activeFile.value?.data;
    if (!d) {
      rows.value = [];
      htmlCacheKey.value = '';
      return;
    }
    const lang = detectDiffLanguage(activeFile.value?.name ?? activeFile.value?.relPath ?? null);
    const inComment = markBlockCommentLines(d.content, lang);
    const lines = d.content.split('\n');
    rows.value = lines.map((line, i) => ({
      no: i + 1,
      // 整行在块注释内 → 不交给 hljs（它看不到跨行上下文，会上成彩色代码）
      html: inComment[i] ? escapeComment(line) : highlightDiffLine(line, lang),
      isComment: inComment[i] === true,
    }));
    htmlCacheKey.value = key;
  },
  { immediate: true },
);

const visibleRows = computed(() => rows.value.slice(0, renderedCount.value));
const hasMore = computed(() => rows.value.length > renderedCount.value);

function loadMore(): void {
  renderedCount.value += PAGE_LINES;
}

/** 注释行整体转义后包一层 hljs-comment：与 diff 视图同色 */
function escapeComment(s: string): string {
  return `<span class="hljs-comment">${s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')}</span>`;
}

/** 面包屑：目录段 + 文件名（可滚动，窄面板下不换行） */
const crumbs = computed(() => {
  const f = activeFile.value;
  if (!f) return [];
  const parts = f.relPath.split('/').filter(Boolean);
  return parts.map((name, i) => ({ name, isFile: i === parts.length - 1 }));
});

/** 降级态分类：驱动「显示什么」，而不是模板里堆 v-if */
type DegradedKind = 'none' | 'binary' | 'tooBig' | 'missing' | 'error' | 'empty';
const degraded = computed<DegradedKind>(() => {
  const f = activeFile.value;
  if (!f) return 'none';
  if (f.missing) return 'missing';
  if (f.error && !f.data) return 'error';
  if (!f.data) return 'none';
  if (f.data.binary) return 'binary';
  if (f.data.truncated) return 'tooBig';
  if (f.data.lineCount === 0) return 'empty';
  return 'none';
});

const degradedTitle = computed(() => {
  switch (degraded.value) {
    case 'binary':
      return t('code.binaryTitle');
    case 'tooBig':
      return t('code.tooBigTitle');
    case 'missing':
      return t('code.missingTitle');
    case 'error':
      return activeFile.value?.error ?? t('code.readFailed');
    case 'empty':
      return t('code.emptyTitle');
    default:
      return '';
  }
});

const degradedHint = computed(() => {
  const d = activeFile.value?.data;
  switch (degraded.value) {
    case 'binary':
      return t('code.binaryHint');
    case 'tooBig':
      return d ? t('code.tooBigHint', { shown: d.lineCount, total: d.totalLines }) : '';
    case 'missing':
      return t('code.missingHint');
    case 'error':
      return t('code.errorHint');
    case 'empty':
      return t('code.emptyHint');
    default:
      return '';
  }
});

/** 状态栏：行数 / 体积 / 行尾（CE-S11） */
const statusText = computed(() => {
  const d = activeFile.value?.data;
  if (!d) return [];
  const out = [`${d.totalLines.toLocaleString()} ${t('code.lines')}`];
  out.push(d.truncated
    ? t('code.shownLines', { n: d.lineCount })
    : formatBytes(d.size));
  out.push(d.eol === 'crlf' ? 'CRLF' : d.eol === 'mixed' ? t('code.eolMixed') : 'LF');
  return out;
});

/* ===== diff 数据（模块 12 P2：并排 + 行内两种视图共用同一份拉取）=====
 *
 * 数据流：git/getFileDiff 的 unified 文本 → 一次解析成两种投影
 * （parseGitUnifiedDiff → 并排行；parseGitInlineDiff → 行级标记 + 删除块锚点）。
 * 对齐交给 git（hunk 内行序就是对齐结果），不在 UI 里对整文件跑 LCS——
 * 几千行的文件是几百 MB 级的 DP 表。
 * 未跟踪文件是例外：git 根本不给它 diff，用已加载正文合成「全新增」视角
 * （与变更视图把未跟踪整文件算 +N 的口径一致）。
 */
type DiffLoad = 'idle' | 'loading' | 'binary' | 'fail';
const diffLoad = ref<DiffLoad>('idle');
const diffRows = ref<SideBySideRow[]>([]);
/** 行内投影（文件正文上色用）；只在 effectiveMode === 'inline' 时被模板消费 */
const inlineParsed = ref<ParsedInlineDiff | null>(null);

/**
 * diff 为空 = git 状态已过期（文件其实没有未提交变更，多半是刚在外部提交过）：
 * **静默落回文件正文**，不渲染「此文件没有未提交的改动」空态页——
 * 未变更的文件就该直接是文件正文（用户 2026-10-03：不需要跳这个页面）。
 */
function fallBackToFile(): void {
  if (props.projectPath) setViewerMode(props.projectPath, 'file');
  diffLoad.value = 'idle';
  diffRows.value = [];
  inlineParsed.value = null;
}

/** relPath → 按 size+mtime 键缓存的解析结果；文件被外部改写后自动失效 */
interface DiffCacheEntry {
  key: string;
  binary: boolean;
  rows: SideBySideRow[];
  inline: ParsedInlineDiff;
  /** 相对基线零差异（两种投影都为空）→ 状态过期，落回文件正文 */
  empty: boolean;
}
const diffCache = new Map<string, DiffCacheEntry>();
/** 竞态防护：切签/切模式后，先前在途的响应不许覆盖新状态 */
let diffSeq = 0;

function applyEntry(e: DiffCacheEntry): void {
  if (e.binary) {
    diffLoad.value = 'binary';
    return;
  }
  if (e.empty) {
    fallBackToFile();
    return;
  }
  diffRows.value = e.rows;
  inlineParsed.value = e.inline;
  diffLoad.value = 'idle';
}

async function loadDiff(): Promise<void> {
  const f = activeFile.value;
  if (!f || !props.projectPath || effectiveMode.value === 'file' || degraded.value !== 'none') {
    diffLoad.value = 'idle';
    diffRows.value = [];
    inlineParsed.value = null;
    return;
  }
  const seq = ++diffSeq;
  const key = cacheKey.value;
  const hit = diffCache.get(f.relPath);
  if (hit && hit.key === key) {
    applyEntry(hit);
    return;
  }
  if (f.loading) {
    // 首读未回来：先挂加载态，data 到位后 cacheKey 变化会再触发本函数
    diffLoad.value = 'loading';
    return;
  }
  // 未跟踪：git 不给 diff，正文就是「全新增」
  if (props.gitStatus?.status === '?') {
    if (!f.data) {
      diffLoad.value = 'fail';
      return;
    }
    const entry: DiffCacheEntry = {
      key,
      binary: false,
      rows: buildSideBySideDiff(null, f.data.content),
      inline: {
        addedLines: f.data.content.split('\n').map((_, i) => i + 1),
        delBlocks: [],
        binary: false,
      },
      empty: f.data.content === '',
    };
    diffCache.set(f.relPath, entry);
    applyEntry(entry);
    return;
  }
  diffLoad.value = 'loading';
  const text = await getFileDiff(props.projectPath, f.relPath);
  if (seq !== diffSeq) return;
  if (text === null) {
    diffLoad.value = 'fail';
    return;
  }
  const unified = parseGitUnifiedDiff(text);
  const entry: DiffCacheEntry = {
    key,
    binary: unified.binary,
    rows: unified.rows,
    inline: parseGitInlineDiff(text),
    empty: !unified.binary && unified.rows.length === 0,
  };
  diffCache.set(f.relPath, entry);
  applyEntry(entry);
}

watch(
  [() => props.activeRel, cacheKey, effectiveMode, () => props.gitStatus?.status],
  () => void loadDiff(),
  { immediate: true },
);

/** 大 diff 与文件正文同一策略：先给首屏，其余点开（同一个 INITIAL 思路） */
const DIFF_INITIAL_ROWS = 400;
const diffTruncated = ref(true);
// 换签重新折叠：diff 的展开态跟着文件走，不跨签记忆
watch(() => props.activeRel, () => { diffTruncated.value = true; });
const diffRowsVisible = computed(() =>
  diffTruncated.value ? diffRows.value.slice(0, DIFF_INITIAL_ROWS) : diffRows.value,
);
const diffLanguage = computed(() =>
  detectDiffLanguage(activeFile.value?.name ?? activeFile.value?.relPath ?? null),
);
/** 可见行先截断再逐行高亮（大 diff 只上色首屏，与 DiffView 同款降级） */
const highlightedDiffRows = computed(() =>
  diffRowsVisible.value.map((row) => ({
    left: row.left ? { ...row.left, html: highlightDiffLine(row.left.text, diffLanguage.value) } : null,
    right: row.right ? { ...row.right, html: highlightDiffLine(row.right.text, diffLanguage.value) } : null,
  })),
);
/** 并排显示行：diff 行 + hunk 之间/首尾的「未变更 N 行」省略分隔条 */
type SideDisplayRow =
  | { kind: 'row'; row: (typeof highlightedDiffRows.value)[number] }
  | { kind: 'omit'; count: number };
const sideRows = computed<SideDisplayRow[]>(() => {
  const omissions = collectDiffOmissions(
    diffRows.value,
    activeFile.value?.data?.totalLines ?? 0,
  );
  const rows = highlightedDiffRows.value;
  if (omissions.length === 0) return rows.map((row) => ({ kind: 'row' as const, row }));
  const byEnd = new Map<number, number>();
  let trailing: number | null = null;
  for (const o of omissions) {
    if (o.endsAt === null) trailing = o.count;
    else byEnd.set(o.endsAt, o.count);
  }
  const out: SideDisplayRow[] = [];
  for (const row of rows) {
    const end = row.right?.line ?? null;
    if (end !== null && byEnd.has(end)) out.push({ kind: 'omit', count: byEnd.get(end)! });
    out.push({ kind: 'row', row });
  }
  if (trailing !== null) out.push({ kind: 'omit', count: trailing });
  return out;
});

function loadMoreDiff(): void {
  diffTruncated.value = false;
}

/* ===== 行内高亮（文件正文 + 行级标记，模块 12 P2 第二视图）=====
 * 原型口径：新增行在**行号栏右缘**挂色条 + 整行淡底（行号列 sticky，色条画左缘
 * 横向一滚就成「纸外飘着一条绿杠」）；被删的行在工作区文件里根本不存在，
 * 用一条可点开的红色占位条占位（贴在锚点行之后），展开看旧行。
 */
const inlineAdded = computed<Set<number>>(() =>
  effectiveMode.value === 'inline' && inlineParsed.value
    ? new Set(inlineParsed.value.addedLines)
    : new Set<number>(),
);
/** 展开态只跟当前文件走，换签重置（与 diff 折叠态同规则） */
const expandedDelBlocks = ref<Set<number>>(new Set());
watch(() => props.activeRel, () => { expandedDelBlocks.value = new Set(); });
function toggleDelBlock(id: number): void {
  const next = new Set(expandedDelBlocks.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  expandedDelBlocks.value = next;
}

/** 正文显示行：文件行 + 按锚点插入的删除占位条（仅行内模式；其余形态纯文件行） */
type DisplayRow = { kind: 'line'; row: Row } | { kind: 'delblock'; block: InlineDelBlock };
const displayRows = computed<DisplayRow[]>(() => {
  const base = visibleRows.value;
  const parsed = effectiveMode.value === 'inline' ? inlineParsed.value : null;
  if (!parsed) return base.map((row) => ({ kind: 'line' as const, row }));
  const out: DisplayRow[] = [];
  for (const b of parsed.delBlocks) {
    if (b.afterLine === null) out.push({ kind: 'delblock', block: b });
  }
  for (const row of base) {
    out.push({ kind: 'line', row });
    for (const b of parsed.delBlocks) {
      if (b.afterLine === row.no) out.push({ kind: 'delblock', block: b });
    }
  }
  return out;
});
function rowKey(r: DisplayRow): string | number {
  return r.kind === 'line' ? r.row.no : `del-${r.block.id}`;
}

/**
 * 滚动位置色块（Zed 同款，仅行内模式）：把变更映射到右缘细条上——
 * 新增行按**连续段**合并成一条绿块（逐行画会在密集改动处糊成一片），
 * 删除占位条在锚点位置画红块。比例 = 行号 / 全文行数，与滚动无关，
 * 是一张「整文变更地图」，用户滚动时一眼知道哪里有改动。
 */
const minimapMarks = computed<Array<{ top: number; height: number; kind: 'add' | 'del' }>>(() => {
  const parsed = effectiveMode.value === 'inline' ? inlineParsed.value : null;
  const total = activeFile.value?.data?.totalLines ?? 0;
  if (!parsed || total <= 0) return [];
  const pct = (lines: number): number => Math.max((lines / total) * 100, 0.5);
  const marks: Array<{ top: number; height: number; kind: 'add' | 'del' }> = [];
  // 连续新增行合并（已按行号升序——解析时即按 hunk 顺序产出）
  let runStart = 0;
  let runLen = 0;
  for (const no of parsed.addedLines) {
    if (runLen > 0 && no === runStart + runLen) {
      runLen += 1;
      continue;
    }
    if (runLen > 0) marks.push({ top: ((runStart - 1) / total) * 100, height: pct(runLen), kind: 'add' });
    runStart = no;
    runLen = 1;
  }
  if (runLen > 0) marks.push({ top: ((runStart - 1) / total) * 100, height: pct(runLen), kind: 'add' });
  for (const b of parsed.delBlocks) {
    const anchor = b.afterLine ?? 0;
    marks.push({ top: (anchor / total) * 100, height: pct(b.lines.length), kind: 'del' });
  }
  return marks;
});

const fileBadge = computed(() => {
  const s = props.gitStatus;
  if (!s) return null;
  // 走和文件树同一张映射表（?→U、冲突→!）：这里若直接印原始状态字符，
  // 就会出现「树里绿 U、头部橙 ?」的两副面孔（用户 2026-10-03 报）
  const ui = gitStatusUi(s.status);
  return { raw: s.status, cls: ui.cls.toLowerCase(), glyph: ui.glyph, title: ui.title };
});

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
</script>

<template>
  <section class="cv">
    <!-- 面包屑行：完整路径 + Git 徽标 + 关闭当前文件（44px，与原型 cp-head 同高） -->
    <header class="cv-head">
      <nav class="cv-crumbs" :title="activeFile?.relPath">
        <template v-if="activeFile">
          <span
            v-for="(c, i) in crumbs"
            :key="`${c.name}-${i}`"
            class="cv-crumb"
            :class="{ 'is-file': c.isFile, 'is-missing': activeFile.missing }"
            >{{ c.name }}</span
          >
        </template>
        <span v-else class="cv-crumb is-file">{{ t('code.noFile') }}</span>
      </nav>
      <span
        v-if="fileBadge"
        class="cv-badge"
        :class="`is-${fileBadge.cls}`"
        :data-git="fileBadge.raw"
        :title="fileBadge.title"
        >{{ fileBadge.glyph }}</span
      >
      <!-- 正文形态切换：文件 / 行内 / 并排。对比两档只对有未提交变更的文件可用
           （没改动给一个全空对比没有意义），没改动时置灰而非隐藏——
           「它存在但现在不可用」比「忽有忽无」可解释。默认哪档进个性化设置。 -->
      <div class="cv-modes" role="group" :aria-label="t('code.modeSwitcher')">
        <button
          class="cv-mode"
          :class="{ 'is-on': effectiveMode === 'file' }"
          type="button"
          @click="emit('set-mode', 'file')"
        >{{ t('code.modeFile') }}</button>
        <button
          class="cv-mode"
          :class="{ 'is-on': effectiveMode === 'inline' }"
          type="button"
          :disabled="!activeFile || !hasGitChanges"
          :title="!hasGitChanges ? t('code.diffNoChangesTitle') : undefined"
          @click="emit('set-mode', 'inline')"
        >{{ t('code.modeInline') }}</button>
        <button
          class="cv-mode"
          :class="{ 'is-on': effectiveMode === 'side' }"
          type="button"
          :disabled="!activeFile || !hasGitChanges"
          :title="!hasGitChanges ? t('code.diffNoChangesTitle') : undefined"
          @click="emit('set-mode', 'side')"
        >{{ t('code.modeDiff') }}</button>
      </div>
      <button
        class="cv-term"
        type="button"
        :title="t('terminal.toggle', { hotkey: TERMINAL_HOTKEY })"
        :aria-label="t('terminal.toggle', { hotkey: TERMINAL_HOTKEY })"
        :aria-pressed="terminalOpen"
        @click="setTerminalOpen(!terminalOpen)"
      >
        <!-- 与顶栏终端开关同款图标（>_）：原先是「关闭当前文件」，与签条 × 完全重复，
             换成终端唤醒——代码态不必回对话区也能随手拉起终端（Ctrl+` 的鼠标入口） -->
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <polyline points="4 17 10 11 4 5" />
          <line x1="12" y1="19" x2="20" y2="19" />
        </svg>
      </button>
    </header>

    <!-- 标签栏：多文件打开时可见；active 页顶部品牌色条（与 demo 一致）。
         位置在**面包屑行之下**：路径是“我在哪”，tab 是“我还开过什么”，前者优先级更高；
         反过来（tab 在顶）会把路径挤成副标题，而面包屑还得横向滚动才看得到全路径。 -->
    <div class="cv-tabs-wrap">
      <div
        ref="tabsEl"
        class="cv-tabs"
        :class="{ 'is-dragging': drag?.active === true }"
        role="tablist"
        @scroll.passive="syncTabsOverflow"
        @wheel="onTabsWheel"
      >
        <div
          v-for="f in files"
          :key="f.relPath"
          class="cv-tab"
          :class="{ active: f.relPath === activeRel, 'is-missing': f.missing, 'is-dragging': drag?.relPath === f.relPath && drag.active }"
          role="tab"
          :aria-selected="f.relPath === activeRel"
          :title="f.relPath"
          tabindex="0"
          @click="onTabClick($event, f.relPath)"
          @keydown.enter.prevent="emit('select', f.relPath)"
          @mousedown="onTabAuxDown($event, f.relPath)"
          @mouseup="onTabAuxUp($event, f.relPath)"
          @pointerdown="onTabPointerDown($event, f.relPath)"
          @pointermove="onTabPointerMove"
          @pointerup="onTabPointerUp"
          @pointercancel="onTabPointerUp"
          @contextmenu.prevent="onTabContextMenu($event, f.relPath)"
        >
          <span
            class="cv-tab-badge"
            :style="{ background: fileBadgeOf(f.name).bg, color: fileBadgeOf(f.name).fg }"
            aria-hidden="true"
          >{{ fileBadgeOf(f.name).label }}</span>
          <span class="cv-tab-name">{{ f.name }}</span>
          <button
            class="cv-tab-x"
            type="button"
            :title="t('code.closeTab', { name: f.name })"
            :aria-label="t('code.closeTab', { name: f.name })"
            @click.stop="emit('close', f.relPath)"
          >×</button>
        </div>
      </div>
      <!-- 溢出提示：滚动条被藏了，没有这个渐隐就没人知道右边还有签 -->
      <span v-if="tabsOverflow" class="cv-tabs-fade" aria-hidden="true" />
    </div>

    <!-- body 外包一层不滚的壳：滚动位置色块要钉在视口右缘，放进滚动容器里会跟内容一起滚走 -->
    <div class="cv-body-wrap">
    <div class="cv-body">
      <div v-if="!activeFile" class="cv-state">
        <div class="cv-state-icon">◍</div>
        <p class="cv-state-title">{{ t('code.pickFileTitle') }}</p>
        <p class="cv-state-hint">{{ t('code.pickFileHint') }}</p>
      </div>

      <div v-else-if="activeFile.loading" class="cv-state">
        <div class="cv-state-icon cv-spin">◌</div>
        <p class="cv-state-title">{{ t('code.loading') }}</p>
      </div>

      <div v-else-if="degraded !== 'none'" class="cv-state">
        <div class="cv-state-icon">
          {{ degraded === 'binary' ? '▦' : degraded === 'missing' ? '⚠' : '◌' }}
        </div>
        <p class="cv-state-title">{{ degradedTitle }}</p>
        <p class="cv-state-hint">{{ degradedHint }}</p>
        <p v-if="activeFile.data" class="cv-state-meta">
          {{ activeFile.data.name }} · {{ formatBytes(activeFile.data.size) }}
          <template v-if="activeFile.data.binary"> · {{ t('code.nonText') }}</template>
        </p>
      </div>

      <!-- 并排 diff：相对 HEAD 的左右对照（git 对齐，本层只渲染）。
           没有「没有未提交改动」的空态页：diff 为空说明状态过期，
           loadDiff 已静默落回文件正文（用户 2026-10-03 定稿）。 -->
      <div v-else-if="effectiveMode === 'side'" class="cv-diff-wrap">
        <div v-if="diffLoad === 'loading'" class="cv-state">
          <div class="cv-state-icon cv-spin">◌</div>
          <p class="cv-state-title">{{ t('code.loading') }}</p>
        </div>
        <div v-else-if="diffLoad === 'binary'" class="cv-state">
          <div class="cv-state-icon">▦</div>
          <p class="cv-state-title">{{ t('code.diffBinaryTitle') }}</p>
          <p class="cv-state-hint">{{ t('code.diffBinaryHint') }}</p>
        </div>
        <div v-else-if="diffLoad === 'fail'" class="cv-state">
          <div class="cv-state-icon">⚠</div>
          <p class="cv-state-title">{{ t('code.diffFailTitle') }}</p>
          <p class="cv-state-hint">{{ t('code.diffFailHint') }}</p>
        </div>
        <div v-else class="cv-diff" role="table">
          <template v-for="(r, i) in sideRows" :key="i">
            <div v-if="r.kind === 'row'" class="cv-diff-row" role="row">
              <span class="cv-diff-num" role="rowheader">{{ r.row.left?.line ?? '' }}</span>
              <pre
                v-if="r.row.left"
                class="cv-diff-cell"
                :class="`is-${r.row.left.type}`"
                role="cell"
                v-html="r.row.left.html"
              ></pre>
              <pre v-else class="cv-diff-cell is-empty" role="cell"></pre>
              <span class="cv-diff-num" role="rowheader">{{ r.row.right?.line ?? '' }}</span>
              <pre
                v-if="r.row.right"
                class="cv-diff-cell"
                :class="`is-${r.row.right.type}`"
                role="cell"
                v-html="r.row.right.html"
              ></pre>
              <pre v-else class="cv-diff-cell is-empty" role="cell"></pre>
            </div>
            <!-- hunk 之间/首尾的未变更区域：git 不产出它，显式交代行号为什么跳变 -->
            <div v-else class="cv-diff-omit" role="row">
              ⋯ {{ t('code.diffOmitted', { n: r.count }) }} ⋯
            </div>
          </template>
          <button
            v-if="diffTruncated && diffRows.length > highlightedDiffRows.length"
            class="cv-more"
            type="button"
            @click="loadMoreDiff"
          >
            {{ t('tool.diffExpandAll', { n: diffRows.length }) }}
          </button>
        </div>
      </div>

      <!-- 文件正文（file 与 inline 两种形态共用）：inline 在此之上叠行级标记——
           新增行行号栏右缘色条 + 整行淡底，被删行插红色占位条（可展开看旧行） -->
      <div v-else class="cv-code" :style="{ '--cv-gutter': gutterWidth }">
        <pre class="cv-pre"><code
          ><template v-for="r in displayRows" :key="rowKey(r)"
            ><span v-if="r.kind === 'line'" class="cv-line" :class="{ 'is-add': inlineAdded.has(r.row.no) }"
            ><span class="cv-ln" aria-hidden="true">{{ r.row.no }}</span
            ><span class="cv-lc" :class="{ 'is-comment': r.row.isComment }" v-html="r.row.html"
          /></span
          ><span
            v-else
            class="cv-delblock"
            :class="{ 'is-open': expandedDelBlocks.has(r.block.id) }"
          ><button class="cv-delblock-bar" type="button" @click="toggleDelBlock(r.block.id)"
            ><svg class="cv-delblock-tri" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M8 5v14l11-7z" /></svg
            ><span>{{ t('code.delBlockBar', { n: r.block.lines.length }) }}</span></button
          ><span v-show="expandedDelBlocks.has(r.block.id)" class="cv-delblock-gone"
            ><span v-for="l in r.block.lines" :key="l.no" class="cv-delblock-line"
              ><span class="cv-delblock-text">{{ l.text }}</span></span
          ></span
          ></span
        ></template></code
        ></pre>
        <button v-if="hasMore" class="cv-more" type="button" @click="loadMore">
          {{ t('code.loadMore', { n: rows.length - renderedCount }) }}
        </button>
      </div>
    </div>

      <!-- 滚动位置色块（Zed 同款，仅行内模式）：新增=绿段、删除占位条=红块 -->
      <div v-if="effectiveMode === 'inline' && minimapMarks.length" class="cv-minimap" aria-hidden="true">
        <span
          v-for="(m, i) in minimapMarks"
          :key="i"
          class="cv-minimap-mark"
          :class="`is-${m.kind}`"
          :style="{ top: `${m.top}%`, height: `${m.height}%` }"
        />
      </div>
    </div>

    <footer class="cv-foot">
      <span class="cv-ro" :title="t('code.roHint')">{{ t('code.readOnly') }}</span>
      <!-- 对比两态报逐文件 ±行数与基线（原型同款）；纯文件态报行数/体积/行尾 -->
      <template v-if="effectiveMode !== 'file' && gitStatus">
        <span class="cv-stat cv-add">+{{ gitStatus.added }}</span>
        <span v-if="gitStatus.removed" class="cv-stat cv-del">−{{ gitStatus.removed }}</span>
        <span class="cv-stat">{{ t('code.diffVsHead') }}</span>
      </template>
      <template v-else>
        <span v-for="s in statusText" :key="s" class="cv-stat">{{ s }}</span>
      </template>
    </footer>

    <!-- 签条右键：左移 / 右移 / 关闭（拖拽的键盘与长距离替代） -->
    <ContextMenu
      v-if="tabCtx"
      :x="tabCtx.x"
      :y="tabCtx.y"
      :items="tabCtxItems"
      :min-width="140"
      @select="onTabCtxSelect"
      @close="tabCtx = null"
    />
  </section>
</template>

<style scoped>
.cv {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  height: 100%;
  background: var(--background);
}

/* ---- 标签栏 ---- */
/* tab 滚动容器：渐隐要挂在一层不滚的壳上，否则会跟着内容一起滑走 */
.cv-tabs-wrap {
  position: relative;
  flex: none;
}
.cv-tabs-fade {
  position: absolute;
  top: 0;
  right: 0;
  /* 让到 tab 条的 1px 底边线为止，不要盖住分隔线 */
  bottom: 1px;
  width: 28px;
  pointer-events: none;
  background: linear-gradient(to right, rgba(0, 0, 0, 0), var(--background));
}
.cv-tabs {
  flex: none;
  display: flex;
  align-items: stretch;
  height: 34px;
  border-bottom: 1px solid var(--border);
  /* 不给底色（去掉之前的 --desk）：tab 条与代码区同属一张纸，中间只靠 1px 分隔线。
     之前那条深色带让 tab 条看着像另一个面板，而它描述的其实是**同一张纸里的文件**。 */
  overflow-x: auto;
  scrollbar-width: none;
}
/* 拖拽中的签：跟着指针走。不用 transform 整个签条，而是单个签偏移——
   签条有横向滚动，transform 会让被拖的签从滚动区里「飘」出去。 */
.cv-tab.is-dragging {
  opacity: 0.55;
  cursor: grabbing;
}
/* 拖拽中禁止文字选中与指针事件抢走（否则拖到签上会变成选文本） */
.cv-tabs.is-dragging {
  user-select: none;
}
.cv-tabs::-webkit-scrollbar {
  display: none;
}
.cv-tab {
  display: flex;
  align-items: center;
  gap: 7px;
  /* 220px 上限：超过就截断文件名。整屏盖盖时纸宽可达 1000+，不封顶的话
     一个超长文件会把其他 tab 挤到滚动区外。 */
  max-width: 220px;
  padding: 0 8px 0 12px;
  border-right: 1px solid var(--border);
  border-top: 2px solid transparent;
  font-size: 12.5px;
  color: var(--muted-foreground);
  cursor: pointer;
  white-space: nowrap;
  outline: none;
  transition: color var(--transition-fast, 120ms), background var(--transition-fast, 120ms);
}
.cv-tab:hover {
  background: var(--surface-hover);
}
.cv-tab:hover {
  color: var(--foreground);
}
.cv-tab.active {
  background: var(--background);
  color: var(--foreground);
  border-top-color: var(--brand-accent);
}
.cv-tab.is-missing .cv-tab-name {
  text-decoration: line-through;
}
.cv-tab-badge {
  flex: none;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  display: grid;
  place-items: center;
  font: 700 7px/1 var(--font-mono);
}
.cv-tab-name {
  max-width: 160px;
  overflow: hidden;
  text-overflow: ellipsis;
}
/* 低频关闭：悬停/激活页才显（沿用侧栏 ghost 按钮规范） */
.cv-tab-x {
  flex: none;
  width: 14px;
  height: 14px;
  /* padding 必须显式清零：global.css 的 button { padding: 6px 14px } 特异性更低
     但组件此前未覆盖——14px 的盒子被 28px 横向内边距挤成负内容区，× 被推到框外
     只剩半截（用户 2026-10-01 截图的「关闭按钮变形」即此） */
  padding: 0;
  border: 0;
  border-radius: 3px;
  background: transparent;
  color: inherit;
  font-size: 12px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
  opacity: 0;
  transition: opacity var(--transition-fast, 120ms), background var(--transition-fast, 120ms);
}
.cv-tab:hover .cv-tab-x,
.cv-tab.active .cv-tab-x {
  opacity: 0.7;
}
.cv-tab-x:hover {
  opacity: 1 !important;
  background: var(--surface-hover);
}

.cv-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px 8px 10px;
  border-bottom: 1px solid var(--border);
  flex: none;
  /* 44px 下限：面包屑与 tab 条两行叠加时，44px 让标题行不至于被挤成一条细边 */
  min-height: 44px;
}
.cv-crumbs {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  align-items: center;
  overflow-x: auto;
  scrollbar-width: none;
  font-size: 12px;
  color: var(--muted-foreground);
}
.cv-crumbs::-webkit-scrollbar {
  display: none;
}
.cv-crumb {
  white-space: nowrap;
  flex: none;
  /* 面包屑是路径，属于标识符：用等宽 + 12.5px（原型同款）。
     目录多时（如 packages/forge-ui/src/components/）等宽的对齐感能直接
     读出层级，无衬线小字则容易看串一截。 */
  font-family: var(--font-mono);
  font-size: 12.5px;
}
.cv-crumb + .cv-crumb::before {
  content: '/';
  margin-right: 6px;
  opacity: 0.55;
}
.cv-crumb.is-file {
  color: var(--foreground);
  font-weight: 500;
}
.cv-crumb.is-missing {
  text-decoration: line-through;
}
.cv-badge {
  flex: none;
  font-family: var(--font-mono);
  font-size: 9.5px;
  font-weight: 600;
  line-height: 1;
  min-width: 15px;
  height: 15px;
  display: grid;
  place-items: center;
  text-align: center;
  border-radius: 4px;
  color: var(--muted-foreground);
  background: color-mix(in oklab, var(--muted) 45%, transparent);
}
/* 字形变体配色与文件树 .ctp-git.is-* 一条不差（同一张 gitStatusUi 表驱动的两个出口，
   一边绿一边橙就是用户 2026-10-03 报的那种两副面孔）。R/C 重命名/复制保持中性灰。 */
.cv-badge.is-m {
  color: color-mix(in oklab, var(--warning) 85%, var(--foreground));
  background: color-mix(in oklab, var(--warning) 20%, transparent);
}
.cv-badge.is-u { color: var(--success); background: color-mix(in oklab, var(--success) 18%, transparent); }
.cv-badge.is-x { color: var(--destructive); background: color-mix(in oklab, var(--destructive) 20%, transparent); }
.cv-badge.is-a { color: var(--success); background: color-mix(in oklab, var(--success) 18%, transparent); }
.cv-badge.is-d { color: var(--destructive); background: color-mix(in oklab, var(--destructive) 18%, transparent); }
.cv-term {
  flex: none;
  width: 22px;
  height: 22px;
  /* 同 .cv-tab-x：清掉全局 button 的 6px 14px 内边距，否则图标被挤到框角 */
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  display: grid;
  place-items: center;
  /* 与顶栏 .app-toolbar-btn 同一条（120ms bg/color）：两个开关共用一个偏好，
     过渡时长不一致会让它们看上去一个先亮一个后亮 */
  transition: background var(--transition-fast), color var(--transition-fast);
}
.cv-term svg {
  width: 14px;
  height: 14px;
}
.cv-term:hover {
  background: var(--surface-hover);
  color: var(--foreground);
}
/* 激活态（终端已展开）与对话区顶栏的终端开关同款：同样的品牌底 + 品牌字色。
   两处同用一个 terminalOpen 偏好，若这里不给激活反馈，展开终端时左边的开关亮着
   、右边这个还是灰的，同一状态两种脸色（用户 2026-10-03 报）。
   取值抄 App.vue 的 `.app-toolbar-btn.is-active`，改一处要改另一处。 */
.cv-term[aria-pressed='true'] {
  background: color-mix(in oklab, var(--brand) 8%, var(--background));
  color: var(--brand);
}

.cv-body-wrap {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
}
.cv-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
/* ---- 滚动位置色块（Zed 同款，行内模式）----
   钉在视口右缘、紧贴原生滚动条（abs 定位锚在 padding 盒，天然贴着滚动条内侧），
   是一张「整文变更地图」：与滚动无关，比例 = 行号 / 全文行数。 */
.cv-minimap {
  position: absolute;
  top: 4px;
  bottom: 4px;
  right: 1px;
  width: 4px;
  pointer-events: none;
}
.cv-minimap-mark {
  position: absolute;
  left: 0;
  right: 0;
  min-height: 2px;
  border-radius: 1px;
}
.cv-minimap-mark.is-add {
  background: color-mix(in oklab, var(--success) 75%, transparent);
}
.cv-minimap-mark.is-del {
  background: color-mix(in oklab, var(--destructive) 75%, transparent);
}
.cv-state {
  margin: auto;
  padding: 24px 20px;
  text-align: center;
  max-width: 420px;
}
.cv-state-icon {
  font-size: 26px;
  color: var(--muted-foreground);
  opacity: 0.5;
  margin-bottom: 10px;
}
.cv-spin {
  animation: cv-spin 1.1s linear infinite;
  display: inline-block;
}
@keyframes cv-spin {
  to {
    transform: rotate(360deg);
  }
}
.cv-state-title {
  margin: 0 0 6px;
  font-size: 13px;
  color: var(--foreground);
}
.cv-state-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.65;
  color: var(--muted-foreground);
}
.cv-state-meta {
  margin: 10px 0 0;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
  opacity: 0.8;
}

.cv-code {
  min-width: 0;
}
.cv-pre {
  margin: 0;
  padding: 8px 0 16px;
  font-family: var(--font-mono);
  /* 必须显式开口：global.css 的 body 是 user-select:none（全站默认不可选，
     只有 MessageCard 用 user-select:text 开了对话区这一个口），
     于是代码纸一个字符都选不中，「选择复制」整个不成立。
     开了之后：
       - 行号列 .cv-ln 保持 user-select:none，复制时自动跳过（已验证）
       - 签条 / 面包屑 / 状态栏不在 .cv-pre 里，仍不可选
       - 选中样式走全局 ::selection（--brand 25%） */
  user-select: text;
  /* 12.5px / 20px = prototypes/code-tree-viewer-demo.html:256 `.code` 的原值。
     曾经为了「看得清」改成 14px / 1.6（对照 Qoder），代价是同一份文件在应用里
     比原型大一圈（行距 22.4 vs 20），截图并排一眼能看出来——而这个功能的存在
     理由就是「和原型一致」，所以原型优先。改大只需改这一行。 */
  font-size: 12.5px;
  line-height: 20px;
  /* 全局 -webkit-font-smoothing: antialiased 在小字号下会抽走一层笔画浓度，
     12.5px 恢复子像素渲染（auto）让字发实。 */
  -webkit-font-smoothing: auto;
  tab-size: 2;
  /* 等宽正文换行会让行号与内容错行，故不换行 + 横向滚动 */
  white-space: pre;
}
/* 关键：UA 样式表给 `code` 元素写了 `font-family: monospace`，而 <code> 是
   .cv-pre 的**子元素**——它不继承 .cv-pre 的字体，直接被换成浏览器的通用等宽
   （实测 Consolas 138.55 vs JetBrains Mono 151.2）。于是行号和正文其实都不是
   JetBrains Mono，和原型的代码块（原型没有 <code>，直接 .code 用 var(--font-mono)）
   长得不一样。这条是「代码字体和原型不一致」的真正原因。 */
.cv-pre code {
  font-family: inherit;
}
.cv-line {
  display: block;
  /* 空行（文件末尾的换行）也得占一行高。写死 20px 而不是 1.6em：
     1.6em 只在「字号 × 1.6 = line-height」时刚好相等，以后只改字号不改
     line-height（或反过来）时它会默默错位，而这种错位不报错、只表现为
     最后一行被压扁。数值与 .cv-pre 的 line-height 对应。 */
  min-height: 20px;
}
/* 行号列 sticky：横向滚动时行号必须留在视野里，否则长行一滚就不知道读到第几行。
   左右各 12px 呼吸位（宽度用 calc 补回：全局 border-box 下 padding 会吃掉 3ch
   数字区，之前数字直接糊在面板左缘上，用户 2026-10-01 点名「别贴边」） */
.cv-ln {
  position: sticky;
  left: 0;
  display: inline-block;
  /* 固定 52px 保底（原型 .ln 的 min-width），--cv-gutter 只负责 4 位数时的增宽 */
  min-width: 52px;
  width: calc(var(--cv-gutter, 3ch) + 30px);
  padding: 0 14px 0 16px;
  text-align: right;
  color: var(--muted-foreground);
  opacity: 0.55;
  user-select: none;
  /* 与正文同底：sticky 行号槽要在横向滚动时盖住滑过的代码，异色会露出一条穿帮带 */
  background: var(--background);
  /* 竖线把行号圈成独立一列。缺它的时候数字悬在纸边、代码紧贴数字，
     14px 下会读成「一长条数字」而不是一张对齐的表——这是原型更舒服的主因。 */
  border-right: 1px solid var(--border);
}
.cv-lc {
  display: inline;
  /* 竖线右侧的留白（原型 .lc 的 padding-left）：数字和代码之间要有气口 */
  padding-left: 14px;
}
.cv-more {
  display: block;
  margin: 12px auto 24px;
  padding: 5px 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  color: var(--muted-foreground);
  font-size: 12px;
  cursor: pointer;
}
.cv-more:hover {
  color: var(--foreground);
}

.cv-foot {
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding: 5px 14px;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
}
.cv-ro {
  padding: 1px 6px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--muted) 45%, transparent);
}
.cv-stat {
  white-space: nowrap;
}
.cv-add {
  color: var(--success);
  font-weight: 600;
}
.cv-del {
  color: var(--destructive);
  font-weight: 600;
}

/* ---- 正文形态切换（文件 / 并排 diff，原型 cp-modes 同款胶囊）---- */
.cv-modes {
  flex: none;
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--muted);
  border-radius: 999px;
}
.cv-mode {
  padding: 3px 10px;
  border: 0;
  border-radius: 999px;
  background: transparent;
  font-size: 11.5px;
  color: var(--muted-foreground);
  cursor: pointer;
  white-space: nowrap;
  transition: color var(--transition-fast, 120ms), background var(--transition-fast, 120ms);
}
.cv-mode:hover:not(:disabled) {
  color: var(--foreground);
}
.cv-mode.is-on {
  background: var(--card);
  color: var(--foreground);
  font-weight: 500;
  box-shadow: 0 1px 2px oklch(0 0 0 / 6%);
}
/* 没改动的文件不给 diff（原型拍板点 B）：置灰而不是点开一个全空对比 */
.cv-mode:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* ---- 并排 diff（模块 12 P2）----
   行结构与 DiffView 同款（grid 36px/1fr/36px/1fr）。min-width 兜底：分屏时纸可能
   只有 500px，不兜底每侧被压到 110px，pre-wrap 会把一行代码折成竖排「字柱」。 */
.cv-diff-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.cv-diff {
  padding: 8px 0 16px;
  min-width: 680px;
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 20px;
  /* 对话区/文件正文同款：diff 内容可选中复制 */
  user-select: text;
}
.cv-diff-row {
  display: grid;
  grid-template-columns: 36px minmax(240px, 1fr) 36px minmax(240px, 1fr);
}
.cv-diff-num {
  padding: 0 8px;
  font-size: 11px;
  text-align: right;
  color: var(--muted-foreground);
  opacity: 0.6;
  user-select: none;
}
.cv-diff-cell {
  margin: 0;
  padding: 0 10px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--foreground);
}
/* 第 2 个子元素恒为左侧行内容格（num/pre/num/pre 四格固定），中缝画在它右缘 */
.cv-diff-cell:nth-child(2) {
  border-right: 1px solid var(--border);
}
/* 增删行只染背景不强制字色，语法 token 颜色才能透出来（DiffView 同款透明度） */
.cv-diff-cell.is-removed {
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
}
.cv-diff-cell.is-added {
  background: color-mix(in oklab, var(--success) 10%, transparent);
}
.cv-diff-cell.is-empty {
  background: var(--muted);
}
/* hunk 之间/首尾的未变更省略条：横跨整行（网格 4 列占满），muted 弱化 */
.cv-diff-omit {
  grid-column: 1 / -1;
  padding: 2px 14px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
  background: color-mix(in oklab, var(--muted-foreground) 7%, transparent);
  border-top: 1px solid var(--border);
  border-bottom: 1px solid var(--border);
  user-select: none;
}

/* ---- 行内高亮（inline 形态，原型文件正文同款）---- */
/* 色条画在行号栏右缘（替换那条 1px 分隔线）：.cv-ln 是 sticky，画左缘横向一滚
   就成「纸外飘着一条绿杠」——原型注释里点名过的坑 */
.cv-line.is-add .cv-ln {
  border-right: 3px solid var(--success);
  padding-right: 12px;
}
/* 增行只染淡底不强制字色，语法 token 颜色才能透出来（与并排格同款透明度） */
.cv-line.is-add .cv-lc {
  background: color-mix(in oklab, var(--success) 10%, transparent);
}
/* 删除占位条：工作区文件里没有这些行，用一条可点开的红色细条占位（原型同款） */
.cv-delblock {
  display: block;
}
.cv-delblock-bar {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  height: 20px;
  padding: 0 12px 0 16px;
  border: 0;
  border-top: 1px solid color-mix(in oklab, var(--destructive) 30%, transparent);
  border-bottom: 1px solid color-mix(in oklab, var(--destructive) 30%, transparent);
  background: color-mix(in oklab, var(--destructive) 12%, transparent);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--destructive);
  text-align: left;
  cursor: pointer;
  user-select: none;
}
.cv-delblock-bar:hover {
  background: color-mix(in oklab, var(--destructive) 20%, transparent);
}
.cv-delblock-tri {
  width: 10px;
  height: 10px;
  flex: none;
  transition: transform var(--transition-fast, 120ms);
}
.cv-delblock.is-open .cv-delblock-tri {
  transform: rotate(90deg);
}
.cv-delblock-gone {
  display: block;
  padding: 4px 0;
  background: color-mix(in oklab, var(--destructive) 8%, transparent);
  border-bottom: 1px solid color-mix(in oklab, var(--destructive) 30%, transparent);
}
.cv-delblock-line {
  display: block;
  white-space: pre;
  font-size: 11.5px;
  line-height: 18px;
  color: var(--foreground);
}
/* 展开行不带行号（原型同款）：占位条本身挂在锚点行之后，位置已经自明；
   删除线只画在文本上 */
.cv-delblock-text {
  text-decoration: line-through;
  text-decoration-color: color-mix(in oklab, var(--destructive) 40%, transparent);
}
</style>

<!-- hljs token 主题：与 DiffView 同源（同一套 GitHub palette 微调）。
     非 scoped：v-html 注入的子节点不带 scoped 属性，加不上哈希前缀。 -->
<style>
.cv-lc .hljs-comment,
.cv-diff-cell .hljs-comment,
.cv-lc .hljs-quote,
.cv-diff-cell .hljs-quote {
  /* 不用斜体：中文注释走 Noto Sans CJK 的合成倾斜糊成一团，用户 2026-10-01 点名去掉 */
  color: #6e7781;
}
.cv-lc .hljs-keyword,
.cv-diff-cell .hljs-keyword,
.cv-lc .hljs-selector-tag,
.cv-diff-cell .hljs-selector-tag,
.cv-lc .hljs-doctag,
.cv-diff-cell .hljs-doctag,
.cv-lc .hljs-template-tag,
.cv-diff-cell .hljs-template-tag {
  color: #cf222e;
}
.cv-lc .hljs-string,
.cv-diff-cell .hljs-string,
.cv-lc .hljs-regexp,
.cv-diff-cell .hljs-regexp,
.cv-lc .hljs-meta .hljs-string,
.cv-diff-cell .hljs-meta .hljs-string {
  color: #0e7a3d;
}
.cv-lc .hljs-number,
.cv-diff-cell .hljs-number,
.cv-lc .hljs-literal,
.cv-diff-cell .hljs-literal {
  color: #0550ae;
}
.cv-lc .hljs-title,
.cv-diff-cell .hljs-title,
.cv-lc .hljs-title.function_,
.cv-diff-cell .hljs-title.function_,
.cv-lc .hljs-section,
.cv-diff-cell .hljs-section {
  color: #8250df;
}
.cv-lc .hljs-attr,
.cv-diff-cell .hljs-attr,
.cv-lc .hljs-attribute,
.cv-diff-cell .hljs-attribute,
.cv-lc .hljs-variable,
.cv-diff-cell .hljs-variable,
.cv-lc .hljs-template-variable,
.cv-diff-cell .hljs-template-variable {
  color: #0550ae;
}
.cv-lc .hljs-tag,
.cv-diff-cell .hljs-tag,
.cv-lc .hljs-name,
.cv-diff-cell .hljs-name,
.cv-lc .hljs-selector-id,
.cv-diff-cell .hljs-selector-id,
.cv-lc .hljs-selector-class,
.cv-diff-cell .hljs-selector-class {
  color: #116329;
}
.cv-lc .hljs-type,
.cv-diff-cell .hljs-type,
.cv-lc .hljs-built_in,
.cv-diff-cell .hljs-built_in,
.cv-lc .hljs-class .hljs-title,
.cv-diff-cell .hljs-class .hljs-title {
  color: #953800;
}
.cv-lc .hljs-symbol,
.cv-diff-cell .hljs-symbol,
.cv-lc .hljs-bullet,
.cv-diff-cell .hljs-bullet,
.cv-lc .hljs-link,
.cv-diff-cell .hljs-link {
  color: #0550ae;
}

/* 暗色：GitHub Dark 系（与 DiffView 暗色板同源），
   浅色板在暗底上对比度不足，实测整屏糊成一片 */
:root[data-theme='dark'] .cv-lc .hljs-comment,
:root[data-theme='dark'] .cv-diff-cell .hljs-comment,
:root[data-theme='dark'] .cv-lc .hljs-quote,
:root[data-theme='dark'] .cv-diff-cell .hljs-quote {
  color: #8b949e;
}
:root[data-theme='dark'] .cv-lc .hljs-keyword,
:root[data-theme='dark'] .cv-diff-cell .hljs-keyword,
:root[data-theme='dark'] .cv-lc .hljs-selector-tag,
:root[data-theme='dark'] .cv-diff-cell .hljs-selector-tag,
:root[data-theme='dark'] .cv-lc .hljs-doctag,
:root[data-theme='dark'] .cv-diff-cell .hljs-doctag,
:root[data-theme='dark'] .cv-lc .hljs-template-tag,
:root[data-theme='dark'] .cv-diff-cell .hljs-template-tag {
  color: #ff7b72;
}
:root[data-theme='dark'] .cv-lc .hljs-string,
:root[data-theme='dark'] .cv-diff-cell .hljs-string,
:root[data-theme='dark'] .cv-lc .hljs-regexp,
:root[data-theme='dark'] .cv-diff-cell .hljs-regexp,
:root[data-theme='dark'] .cv-lc .hljs-meta .hljs-string,
:root[data-theme='dark'] .cv-diff-cell .hljs-meta .hljs-string {
  color: #a5d6ff;
}
:root[data-theme='dark'] .cv-lc .hljs-number,
:root[data-theme='dark'] .cv-diff-cell .hljs-number,
:root[data-theme='dark'] .cv-lc .hljs-literal,
:root[data-theme='dark'] .cv-diff-cell .hljs-literal,
:root[data-theme='dark'] .cv-lc .hljs-attr,
:root[data-theme='dark'] .cv-diff-cell .hljs-attr,
:root[data-theme='dark'] .cv-lc .hljs-attribute,
:root[data-theme='dark'] .cv-diff-cell .hljs-attribute,
:root[data-theme='dark'] .cv-lc .hljs-variable,
:root[data-theme='dark'] .cv-diff-cell .hljs-variable,
:root[data-theme='dark'] .cv-lc .hljs-template-variable,
:root[data-theme='dark'] .cv-diff-cell .hljs-template-variable,
:root[data-theme='dark'] .cv-lc .hljs-meta,
:root[data-theme='dark'] .cv-diff-cell .hljs-meta,
:root[data-theme='dark'] .cv-lc .hljs-operator,
:root[data-theme='dark'] .cv-diff-cell .hljs-operator {
  color: #79c0ff;
}
:root[data-theme='dark'] .cv-lc .hljs-title,
:root[data-theme='dark'] .cv-diff-cell .hljs-title,
:root[data-theme='dark'] .cv-lc .hljs-title.function_,
:root[data-theme='dark'] .cv-diff-cell .hljs-title.function_,
:root[data-theme='dark'] .cv-lc .hljs-section,
:root[data-theme='dark'] .cv-diff-cell .hljs-section {
  color: #d2a8ff;
}
:root[data-theme='dark'] .cv-lc .hljs-tag,
:root[data-theme='dark'] .cv-diff-cell .hljs-tag,
:root[data-theme='dark'] .cv-lc .hljs-name,
:root[data-theme='dark'] .cv-diff-cell .hljs-name,
:root[data-theme='dark'] .cv-lc .hljs-selector-id,
:root[data-theme='dark'] .cv-diff-cell .hljs-selector-id,
:root[data-theme='dark'] .cv-lc .hljs-selector-class,
:root[data-theme='dark'] .cv-diff-cell .hljs-selector-class {
  color: #7ee787;
}
:root[data-theme='dark'] .cv-lc .hljs-type,
:root[data-theme='dark'] .cv-diff-cell .hljs-type,
:root[data-theme='dark'] .cv-lc .hljs-class .hljs-title,
:root[data-theme='dark'] .cv-diff-cell .hljs-class .hljs-title,
:root[data-theme='dark'] .cv-lc .hljs-built_in,
:root[data-theme='dark'] .cv-diff-cell .hljs-built_in {
  color: #ffa657;
}
:root[data-theme='dark'] .cv-lc .hljs-symbol,
:root[data-theme='dark'] .cv-diff-cell .hljs-symbol,
:root[data-theme='dark'] .cv-lc .hljs-bullet,
:root[data-theme='dark'] .cv-diff-cell .hljs-bullet,
:root[data-theme='dark'] .cv-lc .hljs-link,
:root[data-theme='dark'] .cv-diff-cell .hljs-link {
  color: #79c0ff;
}
</style>
