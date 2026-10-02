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
import { detectDiffLanguage, highlightDiffLine } from '@forge/core/side-by-side-diff';
import { markBlockCommentLines } from '../utils/codeBlockComment';
import { fileBadgeOf } from '../utils/fileBadge';
import ContextMenu, { type ContextMenuItem } from './ContextMenu.vue';
import type { OpenFile } from '../composables/useCodeExplorer';
import type { GitStatusFile } from '../types';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

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
  /** 行尾 Git 徽标（仅文件级） */
  gitStatus?: GitStatusFile | null;
}>();

const emit = defineEmits<{
  (e: 'select', relPath: string): void;
  (e: 'close', relPath: string): void;
  /** 拖拽排序 / 左移右移：把 relPath 移到 toIndex（组件不直接改 props） */
  (e: 'move', relPath: string, toIndex: number): void;
}>();

const activeFile = computed(
  () => props.files.find((f) => f.relPath === props.activeRel) ?? null,
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

const fileBadge = computed(() => {
  const s = props.gitStatus;
  if (!s) return null;
  return { text: s.status, untracked: s.status === '?' };
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
        :data-git="fileBadge.text"
        :title="t('code.gitBadge', { s: fileBadge.text })"
        >{{ fileBadge.text }}</span
      >
      <button
        v-if="activeFile"
        class="cv-close"
        type="button"
        :title="t('code.close')"
        aria-label="close"
        @click="emit('close', activeFile.relPath)"
      >×</button>
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

      <div v-else class="cv-code" :style="{ '--cv-gutter': gutterWidth }">
        <pre class="cv-pre"><code
          ><span v-for="r in visibleRows" :key="r.no" class="cv-line"
            ><span class="cv-ln" aria-hidden="true">{{ r.no }}</span
            ><span class="cv-lc" :class="{ 'is-comment': r.isComment }" v-html="r.html"
          /></span></code
        ></pre>
        <button v-if="hasMore" class="cv-more" type="button" @click="loadMore">
          {{ t('code.loadMore', { n: rows.length - renderedCount }) }}
        </button>
      </div>
    </div>

    <footer class="cv-foot">
      <span class="cv-ro" :title="t('code.roHint')">{{ t('code.readOnly') }}</span>
      <span v-for="s in statusText" :key="s" class="cv-stat">{{ s }}</span>
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
.cv-badge[data-git='U'],
.cv-badge[data-git='?'] {
  color: var(--warning);
}
.cv-close {
  flex: none;
  width: 22px;
  height: 22px;
  /* 同 .cv-tab-x：清掉全局 button 的 6px 14px 内边距，否则 × 被挤到框角 */
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--muted-foreground);
  font-size: 17px;
  line-height: 1;
  cursor: pointer;
  display: grid;
  place-items: center;
}
.cv-close:hover {
  background: var(--surface-hover);
  color: var(--foreground);
}

.cv-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
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
</style>

<!-- hljs token 主题：与 DiffView 同源（同一套 GitHub palette 微调）。
     非 scoped：v-html 注入的子节点不带 scoped 属性，加不上哈希前缀。 -->
<style>
.cv-lc .hljs-comment,
.cv-lc .hljs-quote {
  /* 不用斜体：中文注释走 Noto Sans CJK 的合成倾斜糊成一团，用户 2026-10-01 点名去掉 */
  color: #6e7781;
}
.cv-lc .hljs-keyword,
.cv-lc .hljs-selector-tag,
.cv-lc .hljs-doctag,
.cv-lc .hljs-template-tag {
  color: #cf222e;
}
.cv-lc .hljs-string,
.cv-lc .hljs-regexp,
.cv-lc .hljs-meta .hljs-string {
  color: #0e7a3d;
}
.cv-lc .hljs-number,
.cv-lc .hljs-literal {
  color: #0550ae;
}
.cv-lc .hljs-title,
.cv-lc .hljs-title.function_,
.cv-lc .hljs-section {
  color: #8250df;
}
.cv-lc .hljs-attr,
.cv-lc .hljs-attribute,
.cv-lc .hljs-variable,
.cv-lc .hljs-template-variable {
  color: #0550ae;
}
.cv-lc .hljs-tag,
.cv-lc .hljs-name,
.cv-lc .hljs-selector-id,
.cv-lc .hljs-selector-class {
  color: #116329;
}
.cv-lc .hljs-type,
.cv-lc .hljs-built_in,
.cv-lc .hljs-class .hljs-title {
  color: #953800;
}
.cv-lc .hljs-symbol,
.cv-lc .hljs-bullet,
.cv-lc .hljs-link {
  color: #0550ae;
}

/* 暗色：GitHub Dark 系（与 DiffView 暗色板同源），
   浅色板在暗底上对比度不足，实测整屏糊成一片 */
:root[data-theme='dark'] .cv-lc .hljs-comment,
:root[data-theme='dark'] .cv-lc .hljs-quote {
  color: #8b949e;
}
:root[data-theme='dark'] .cv-lc .hljs-keyword,
:root[data-theme='dark'] .cv-lc .hljs-selector-tag,
:root[data-theme='dark'] .cv-lc .hljs-doctag,
:root[data-theme='dark'] .cv-lc .hljs-template-tag {
  color: #ff7b72;
}
:root[data-theme='dark'] .cv-lc .hljs-string,
:root[data-theme='dark'] .cv-lc .hljs-regexp,
:root[data-theme='dark'] .cv-lc .hljs-meta .hljs-string {
  color: #a5d6ff;
}
:root[data-theme='dark'] .cv-lc .hljs-number,
:root[data-theme='dark'] .cv-lc .hljs-literal,
:root[data-theme='dark'] .cv-lc .hljs-attr,
:root[data-theme='dark'] .cv-lc .hljs-attribute,
:root[data-theme='dark'] .cv-lc .hljs-variable,
:root[data-theme='dark'] .cv-lc .hljs-template-variable,
:root[data-theme='dark'] .cv-lc .hljs-meta,
:root[data-theme='dark'] .cv-lc .hljs-operator {
  color: #79c0ff;
}
:root[data-theme='dark'] .cv-lc .hljs-title,
:root[data-theme='dark'] .cv-lc .hljs-title.function_,
:root[data-theme='dark'] .cv-lc .hljs-section {
  color: #d2a8ff;
}
:root[data-theme='dark'] .cv-lc .hljs-tag,
:root[data-theme='dark'] .cv-lc .hljs-name,
:root[data-theme='dark'] .cv-lc .hljs-selector-id,
:root[data-theme='dark'] .cv-lc .hljs-selector-class {
  color: #7ee787;
}
:root[data-theme='dark'] .cv-lc .hljs-type,
:root[data-theme='dark'] .cv-lc .hljs-class .hljs-title,
:root[data-theme='dark'] .cv-lc .hljs-built_in {
  color: #ffa657;
}
:root[data-theme='dark'] .cv-lc .hljs-symbol,
:root[data-theme='dark'] .cv-lc .hljs-bullet,
:root[data-theme='dark'] .cv-lc .hljs-link {
  color: #79c0ff;
}
</style>
