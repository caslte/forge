<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import {
  CANVAS_DEFAULT_HEIGHT,
  CANVAS_TALL_HEIGHT,
  stripCanvasProse,
  judgeCanvasSource,
  decodeCanvasSource,
  buildCanvasDocument,
  buildCanvasStandaloneFile,
  renderMarkdown,
  type CanvasVerdict,
  type CanvasTokens,
} from '@forge/core/markdown';
import { useI18n } from '../i18n/index.ts';
import { useTheme } from '../composables/useTheme.ts';

/**
 * 画布卡片（```canvas 围栏）：把模型手写的 HTML 图示渲染在气泡内。
 *
 * 输入是 base64 编码的 HTML 源码（来自 renderMarkdown 的 md-canvas 占位）。
 * 四态：blocked=骨架蒙版 / 非 HTML=降级代码块 / 文字塞卡片=降级正文 / 其余=iframe 沙箱。
 *
 * 沙箱口径（不可放宽）：`sandbox=""` 全关。不给 allow-scripts，模型 HTML 里的
 * <script> 与 on* 一律不执行；不给 allow-same-origin，srcdoc 是独立 origin，
 * 读不到宿主文档、也拿不到 window.forge。详见 @forge/core/markdown canvasSandbox。
 */
const props = defineProps<{
  /** base64 编码的 HTML 源码 */
  encoded: string;
  /** 围栏尚未闭合（流式中途）：显示骨架蒙版，绝不渲染半成品 */
  blocked?: boolean;
}>();

const { t } = useI18n();
const { themeMode } = useTheme();

/** base64 → UTF-8（解码口径与流式骨架判决共用 @forge/core 的 decodeCanvasSource） */
const source = computed(() => decodeCanvasSource(props.encoded));

/**
 * 宿主令牌 → 沙箱语义色。
 *
 * 从 :root 读计算值而不是硬编码一份：主题与调色板的唯一事实来源留在 design-tokens.css，
 * 这里只做映射。themeMode 进依赖链，切主题即重算 srcdoc（iframe 文档重建）。
 */
const tokens = computed<CanvasTokens>(() => {
  void themeMode.value;
  const cs = getComputedStyle(document.documentElement);
  const read = (name: string, fallback: string): string =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: read('--background', '#ffffff'),
    fg: read('--foreground', '#333333'),
    muted: read('--muted', '#f5f5f5'),
    mutedFg: read('--muted-foreground', '#8a8a8a'),
    surface: read('--muted', '#f5f5f5'),
    border: read('--border', '#e5e5e5'),
    ok: read('--success', 'oklch(0.55 0.16 145)'),
    warn: read('--warning', 'oklch(0.75 0.16 85)'),
    bad: read('--destructive', 'oklch(0.577 0.245 27.325)'),
    accent: read('--brand-accent', 'oklch(0.62 0.09 170)'),
  };
});

const srcdoc = computed(() => buildCanvasDocument(source.value, tokens.value));
/**
 * 四态判决走 @forge/core 的 judgeCanvasSource（唯一口径），本组件不再自己排
 * 「先看 isHtml 还是先看 isProse」——那正是 2026-09-29 骨架闪完落到代码框的成因：
 * 旧模板里 !isHtml 分支排在 isProse 前面，无标签的纯文字永远先被代码块截胡。
 */
const verdict = computed(() => judgeCanvasSource(source.value));
/**
 * 骨架只在「结论还会变」时挂。
 *
 * - undecided：判不出（无标签又太短），先占位；
 * - html：已经确定是卡片，但源码只写了一半——绝不能把半成品塞进 iframe
 *   （E-CA-003 契约），仍要挂骨架等闭合；
 * - prose / code：结论已定且不会再变（无标签分支对文本单调：只会变长，判据
 *   只会从 undecided 走到终态），此时挂骨架就是「假进度」——用户先看一秒
 *   转圈再变成正文/代码框，正是 2026-09-29 截图的观感。直接出终态。
 */
const showSkeleton = computed(
  () => props.blocked === true && (verdict.value === 'undecided' || verdict.value === 'html'),
);
/**
 * 真正用来选模板分支的态：undecided 只在流式骨架期间成立，撑不到终态（终态不再有
 * token 来闭合围栏）。它必须在模板里落到某个具体分支，故归一到 code——无标签内容
 * 进 iframe 必然是空白卡，这正是 canvasSandbox 文件头要避免的。
 */
const shape = computed<CanvasVerdict>(() => (verdict.value === 'undecided' ? 'code' : verdict.value));
const isHtml = computed(() => shape.value === 'html');
/**
 * 「文字塞卡片」：模型把纯文字说明包进 canvas 围栏。不出 iframe（固定高卡片装
 * 一段文字 = 大片留白），摘出文字过 renderMarkdown（sanitize 白名单在内）按正文
 * 流渲染——安全面与普通 markdown 正文同一条线，卡片边框与工具栏都不出现。
 */
const proseHtml = computed(() => (shape.value === 'prose' ? renderMarkdown(stripCanvasProse(source.value)) : ''));
/** 蒙版与终态同高：闭合瞬间不产生跳变，下方正文不会被顶动 */
const height = ref(CANVAS_DEFAULT_HEIGHT);
const expanded = ref(false);
/** 降级代码块的内联拉高态：不想开浮层时直接在气泡里看全文 */
const sourceExpanded = ref(false);
const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
const saveState = ref<'idle' | 'saving'>('idle');
const saveMessage = ref('');
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 换源（同一条消息被终态覆盖重写）时复位手动高度 */
watch(
  () => props.encoded,
  () => {
    height.value = CANVAS_DEFAULT_HEIGHT;
    sourceExpanded.value = false;
  },
);

function toggleHeight(): void {
  height.value = height.value === CANVAS_DEFAULT_HEIGHT ? CANVAS_TALL_HEIGHT : CANVAS_DEFAULT_HEIGHT;
}

/** ESC 关闭放大浮层：与 ImageLightbox 同款口径；浮层没开时不动别的 UI */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && expanded.value) expanded.value = false;
}

function canvasName(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `canvas-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.html`;
}

/** 另存：原生保存对话框选位置 → 写独立 HTML（脱离 forge 也能直接打开） */
async function save(): Promise<void> {
  if (saveState.value === 'saving') return;
  saveState.value = 'saving';
  try {
    const target = await window.forge.dialog.saveFile(canvasName());
    if (!target) {
      // 用户取消不是错误，静默回到空闲态
      saveState.value = 'idle';
      return;
    }
    const ok = await window.forge.file.writeText(
      target,
      buildCanvasStandaloneFile(source.value, tokens.value, 'canvas'),
    );
    flash(ok ? t('canvas.saved', { path: target }) : t('canvas.saveFailed'));
  } catch {
    flash(t('canvas.saveFailed'));
  }
}

function flash(message: string): void {
  saveState.value = 'idle';
  saveMessage.value = message;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveMessage.value = '';
  }, 2600);
}

async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(source.value);
    copied.value = true;
    if (copiedTimer) clearTimeout(copiedTimer);
    copiedTimer = setTimeout(() => {
      copied.value = false;
    }, 1400);
  } catch {
    copied.value = false;
  }
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});

onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
  if (copiedTimer) clearTimeout(copiedTimer);
  if (saveTimer) clearTimeout(saveTimer);
});
</script>

<template>
  <div class="md-canvas-block">
    <!-- 流式中途：骨架蒙版。高度与终态一致，闭合瞬间零跳变。
         但源码一旦能判出「不可能是 HTML」（无标签且已够长），骨架立刻撤掉直接出正文，
         不让用户先看一秒假进度再变成别的形态——截图那类纯文字说明就是这么被误判的。 -->
    <div v-if="showSkeleton" class="canvas-frame canvas-skel" :style="{ height: `${CANVAS_DEFAULT_HEIGHT}px` }">
      <div class="skel-bar skel-title" />
      <div class="skel-bar skel-sub" />
      <div class="skel-row"><span /><span /></div>
      <div class="skel-row"><span /><span /></div>
      <div class="skel-bar skel-wide" />
      <div class="canvas-caption">
        <span class="canvas-spin" />
        <span>{{ t('canvas.generating') }}</span>
      </div>
    </div>

    <!-- 闭合但内容为空：不给 iframe，一句说明 -->
    <div v-else-if="shape === 'empty'" class="canvas-frame canvas-empty">{{ t('canvas.empty') }}</div>

    <!-- 文字塞卡片（含无标签的纯文字）：标签只是排版壳，或压根没标签。
         摘出文字按正文流渲染，不出卡片框、不给固定高 -->
    <div v-else-if="shape === 'prose'" class="canvas-prose" v-html="proseHtml"></div>

    <!-- 闭合且是源码/字符画：降级代码块（蒙版期间用户看不到内容，此处必须兜底） -->
    <div v-else-if="shape === 'code'" class="canvas-fallback">
      <div class="canvas-tools">
        <button class="canvas-tool" :title="t('canvas.expand')" @click="expanded = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="13" y2="11" /><line x1="3" y1="21" x2="11" y2="13" />
          </svg>
        </button>
        <button class="canvas-tool" :title="sourceExpanded ? t('canvas.tallerReset') : t('canvas.taller')" @click="sourceExpanded = !sourceExpanded">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="7 10 12 5 17 10" /><polyline points="7 14 12 19 17 14" />
          </svg>
        </button>
      </div>
      <pre class="canvas-source" :style="sourceExpanded ? { maxHeight: `${CANVAS_TALL_HEIGHT}px` } : undefined"><code>{{ source }}</code></pre>
    </div>

    <!-- 正常态：沙箱 iframe -->
    <div v-else class="canvas-frame" :style="{ height: `${height}px` }">
      <div class="canvas-tools">
        <button class="canvas-tool" :title="t('canvas.expand')" @click="expanded = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="13" y2="11" /><line x1="3" y1="21" x2="11" y2="13" />
          </svg>
        </button>
        <button class="canvas-tool" :title="height === CANVAS_DEFAULT_HEIGHT ? t('canvas.taller') : t('canvas.tallerReset')" @click="toggleHeight">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="7 10 12 5 17 10" /><polyline points="7 14 12 19 17 14" />
          </svg>
        </button>
        <button class="canvas-tool" :title="t('canvas.save')" :disabled="saveState === 'saving'" @click="save">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
          </svg>
        </button>
        <button class="canvas-tool" :title="copied ? t('canvas.copied') : t('canvas.copy')" @click="copy">
          <svg v-if="copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>
      <!-- sandbox=""：脚本与同源访问全关。srcdoc 每次主题/源码变化即整文档重建 -->
      <iframe :srcdoc="srcdoc" sandbox="" :title="t('canvas.generating')" />
    </div>

    <div v-if="saveMessage" class="canvas-toast">{{ saveMessage }}</div>

    <!-- 放大浮层：必须 Teleport 到 body —— 气泡的 rise 动画带 transform，会把 fixed 劫持成气泡内 -->
    <Teleport to="body">
      <div v-if="expanded" class="canvas-lightbox" @click.self="expanded = false">
        <div class="canvas-lightbox-head">
          <span />
          <button class="canvas-lightbox-close" @click="expanded = false">{{ t('canvas.close') }}</button>
        </div>
        <div class="canvas-lightbox-body">
          <iframe v-if="isHtml" :srcdoc="srcdoc" sandbox="" :title="t('canvas.generating')" />
          <pre v-else class="canvas-lightbox-source"><code>{{ source }}</code></pre>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.md-canvas-block {
  margin: 10px 0;
  min-width: 0;
}

/* 外框形态 A：与 MermaidBlock 卡片同款（同一视觉语言，不新增口径） */
.canvas-frame {
  position: relative;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--foreground) 3%, var(--background));
  padding: 12px;
  min-width: 0;
}

.canvas-frame iframe {
  display: block;
  width: 100%;
  flex: 1;
  min-height: 0;
  border: 0;
  border-radius: var(--radius-sm);
  background: var(--background);
}

/* ---------- 骨架蒙版 ---------- */
.canvas-skel {
  gap: 10px;
  justify-content: center;
}
.skel-bar,
.skel-row > span {
  border-radius: 6px;
  background: linear-gradient(
    100deg,
    var(--muted) 30%,
    color-mix(in oklab, var(--muted-foreground) 16%, var(--muted)) 50%,
    var(--muted) 70%
  );
  background-size: 220% 100%;
  /* 2.8s：与工具行同一档慢节奏（v 已按 0.5x 口径调过），1.4s 被判定「太快、像抖动」 */
  animation: canvas-shimmer 2.8s linear infinite;
}
.skel-title {
  height: 14px;
  width: 56%;
}
.skel-sub {
  height: 10px;
  width: 34%;
}
.skel-wide {
  height: 10px;
  width: 80%;
}
.skel-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.skel-row > span {
  height: 62px;
}
.canvas-caption {
  display: flex;
  align-items: center;
  gap: 7px;
  font-size: 12px;
  color: var(--muted-foreground);
}
.canvas-spin {
  width: 12px;
  height: 12px;
  flex-shrink: 0;
  border-radius: 50%;
  border: 1.5px solid var(--muted-foreground);
  border-top-color: transparent;
  /* 1.2s：跟 shimmer 同步放慢；再慢会读成「卡住没在转」 */
  animation: canvas-rot 1.2s linear infinite;
}
@keyframes canvas-shimmer {
  from { background-position: 180% 0; }
  to { background-position: -80% 0; }
}
@keyframes canvas-rot {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .skel-bar,
  .skel-row > span {
    animation: none;
  }
}

/* ---------- 空 / 降级 ---------- */
.canvas-empty {
  font-size: 12px;
  color: var(--muted-foreground);
  justify-content: center;
  align-items: center;
  min-height: 64px;
}
.canvas-fallback {
  position: relative;
  min-width: 0;
}
.canvas-source {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.7;
  max-height: 260px;
  overflow: auto;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--foreground) 3%, var(--background));
  white-space: pre-wrap;
  word-break: break-all;
}

/* ---------- 文字塞卡片降级：正文流渲染 ---------- */
/* MessageCard 的 .msg-content 系列是 scoped 样式，穿不进本组件，这里镜像必要口径：
   统一块间距、标题上距、内联代码胶囊、表格描边。prose 降级里基本只有段落与列表。 */
.canvas-prose {
  min-width: 0;
  font-size: 14px;
  line-height: 2;
  color: var(--foreground);
  word-break: break-word;
  user-select: text;
}
.canvas-prose :deep(p),
.canvas-prose :deep(h1),
.canvas-prose :deep(h2),
.canvas-prose :deep(h3),
.canvas-prose :deep(h4),
.canvas-prose :deep(h5),
.canvas-prose :deep(h6),
.canvas-prose :deep(blockquote),
.canvas-prose :deep(hr),
.canvas-prose :deep(ul),
.canvas-prose :deep(ol),
.canvas-prose :deep(table) {
  margin: 0;
  margin-block-end: 12px;
}
.canvas-prose :deep(h1),
.canvas-prose :deep(h2),
.canvas-prose :deep(h3),
.canvas-prose :deep(h4),
.canvas-prose :deep(h5),
.canvas-prose :deep(h6) {
  margin-block-start: 18px;
}
.canvas-prose :deep(:first-child) {
  margin-block-start: 0;
}
.canvas-prose :deep(:last-child) {
  margin-block-end: 0;
}
.canvas-prose :deep(ul),
.canvas-prose :deep(ol) {
  padding-left: 0;
  list-style-position: inside;
}
.canvas-prose :deep(.md-inline-code) {
  background: var(--muted);
  color: var(--foreground);
  padding: 1px 6px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
}
.canvas-prose :deep(table) {
  border-collapse: collapse;
}
.canvas-prose :deep(th),
.canvas-prose :deep(td) {
  border: 1px solid var(--border);
  padding: 4px 10px;
}

/* ---------- 工具栏 ---------- */
.canvas-tools {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 2;
  display: flex;
  gap: 2px;
  padding: 3px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: color-mix(in oklab, var(--background) 82%, transparent);
  box-shadow: var(--shadow-md);
  opacity: 0;
  transform: translateY(-2px);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}
.canvas-frame:hover .canvas-tools,
.canvas-frame:focus-within .canvas-tools,
.canvas-fallback:hover .canvas-tools,
.canvas-fallback:focus-within .canvas-tools {
  opacity: 1;
  transform: none;
}
.canvas-tool {
  width: 26px;
  height: 26px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
}
.canvas-tool:hover {
  background: var(--muted);
  color: var(--foreground);
}
.canvas-tool:disabled {
  cursor: default;
  opacity: 0.5;
}
.canvas-tool svg {
  width: 14px;
  height: 14px;
}

/* ---------- 保存结果提示 ---------- */
.canvas-toast {
  margin-top: 6px;
  font-size: 12px;
  color: var(--muted-foreground);
  word-break: break-all;
}

/* ---------- 放大浮层 ---------- */
.canvas-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  padding: 4vh 4vw;
  background: rgba(0, 0, 0, 0.8);
  animation: canvas-fade 0.15s ease;
}
.canvas-lightbox-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  margin-bottom: 10px;
}
.canvas-lightbox-close {
  font-family: inherit;
  font-size: 12px;
  line-height: 1;
  padding: 6px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--background);
  color: var(--foreground);
  cursor: pointer;
}
.canvas-lightbox-body {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  overflow: hidden;
  background: var(--background);
  box-shadow: var(--shadow-lg);
}
.canvas-lightbox-body iframe {
  width: 100%;
  height: 100%;
  display: block;
  border: 0;
}
.canvas-lightbox-source {
  height: 100%;
  overflow: auto;
  margin: 0;
  padding: 16px 20px;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.7;
  white-space: pre-wrap;
  word-break: break-all;
}
@keyframes canvas-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
