<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import {
  IR_CARD_HEIGHT,
  buildIrStandaloneFile,
  compileIrWithMeta,
  decodeCanvasSource,
  judgeIr,
} from '@forge/core/markdown';
import { useI18n } from '../i18n/index.ts';

/**
 * 画布 IR 卡片（```canvas-ir 围栏）：把类型化 IR 编译成图示渲染在气泡内。
 *
 * 与 HtmlCanvasBlock（canvas 围栏）的根本差别：
 * - canvas：模型写好 HTML，宿主原样塞 iframe（**排版由模型负责**）
 * - canvas-ir：模型只给结构，宿主编译（**排版由本组件负责**）
 *
 * 因此本组件不含任何布局逻辑——那全在 @forge/core 的 canvasIrRender 里，
 * 可在 node:test 回归。组件只做「解码 → 编译 → 渲染」与失败态展示。
 *
 * 三种终态（与 renderMarkdown 的占位契约一一对应）：
 * 1. 有合规载荷 → 编译出SVG
 * 2. 有回执载荷 → 展示修复回执（不是空白卡片）
 * 3. 无载荷（流式未闭合）→ 骨架蒙版
 */
const props = defineProps<{
  /** base64 编码的 IR 源码（合规时存在） */
  encoded?: string;
  /** base64 编码的修复回执（校验失败时存在） */
  receiptEncoded?: string;
  /** 围栏尚未闭合（流式中途）：显示骨架，绝不出半成品 */
  blocked?: boolean;
}>();

const { t } = useI18n();

const source = computed(() =>
  props.encoded ? decodeCanvasSource(props.encoded) : '',
);

/** 回执文本。宿主不自行拼装，只解码 renderMarkdown 已生成的那份。 */
const receipt = computed(() => {
  if (!props.receiptEncoded) return '';
  return decodeCanvasSource(props.receiptEncoded);
});

const failed = computed(() => receipt.value !== '');

const compiled = computed(() => {
  if (props.blocked || failed.value || !source.value) return null;
  const verdict = judgeIr(source.value);
  // 二次校验：占位说是合规才编译。
  // 这道冗余是有意的——渲染期判定与编译期判定若不一致，宁可不画也不画错的。
  if (verdict.verdict !== 'ok' || !verdict.ir) return null;
  try {
    return compileIrWithMeta(verdict.ir);
  } catch {
    return null; // 编译器不该抛，但真抛了也不能让整条消息渲染中断
  }
});

/** 骨架态：围栏未闭合，或载荷未到。高度与终态相同 ⇒ 闭合瞬间零跳变。 */
const showSkeleton = computed(() => props.blocked === true && !compiled.value && !failed.value);

const expanded = ref(false);
const height = ref(320);
const copied = ref(false);
const saveState = ref<'idle' | 'saving'>('idle');
const saveMessage = ref('');
let copiedTimer: ReturnType<typeof setTimeout> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

/** 卡片标题（另存文件名 / lightbox 用） */
const cardTitle = computed(() => {
  const v = judgeIr(source.value);
  const t = v.ir?.meta?.title;
  return typeof t === 'string' && t.trim() ? t.trim() : 'ir-diagram';
});

function toggleHeight(): void {
  height.value = height.value === 320 ? 560 : 320;
}
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && expanded.value) expanded.value = false;
}

function irName(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `ir-${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.html`;
}

/** 另存：编译出的 SVG 包成自含 HTML（跟随系统深浅色），脱离 forge 可直接打开 */
async function save(): Promise<void> {
  if (saveState.value === 'saving' || !compiled.value) return;
  saveState.value = 'saving';
  try {
    const target = await window.forge.dialog.saveFile(irName());
    if (!target) {
      saveState.value = 'idle';
      return;
    }
    const ok = await window.forge.file.writeText(
      target,
      buildIrStandaloneFile(compiled.value.svg, cardTitle.value),
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

/** 复制 IR 源码（JSON）：可再编辑 / 重放，对 canvas 卡「复制源码」的语义对齐 */
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

watch(
  () => props.encoded,
  () => { expanded.value = false; },
);
</script>

<template>
  <!-- 合规：编译出的图示。工具栏四按钮与 canvas 卡片同款（悬浮右上、hover 显现） -->
  <div v-if="compiled" class="ir-card">
    <div class="ir-frame" :style="{ height: `${height}px` }">
      <div class="ir-tools">
        <button class="ir-tool" :title="t('canvas.expand')" @click="expanded = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="15 3 21 3 21 9" /><polyline points="9 21 3 21 3 15" />
            <line x1="21" y1="3" x2="13" y2="11" /><line x1="3" y1="21" x2="11" y2="13" />
          </svg>
        </button>
        <button class="ir-tool" :title="height === 320 ? t('canvas.taller') : t('canvas.tallerReset')" @click="toggleHeight">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="7 10 12 5 17 10" /><polyline points="7 14 12 19 17 14" />
          </svg>
        </button>
        <button class="ir-tool" :title="t('canvas.save')" :disabled="saveState === 'saving'" @click="save">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" />
            <polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" />
          </svg>
        </button>
        <button class="ir-tool" :title="copied ? t('canvas.copied') : t('canvas.copy')" @click="copy">
          <svg v-if="copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
      </div>
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div class="ir-svg" v-html="compiled.svg"></div>
    </div>
  </div>

  <!-- 校验失败：展示修复回执，而不是空白卡片 -->
  <div v-else-if="failed" class="ir-card is-invalid">
    <div class="ir-bar">
      <span>图示未通过校验</span>
      <span class="sp"></span>
    </div>
    <pre class="ir-receipt">{{ receipt }}</pre>
  </div>

  <!-- 流式未闭合：纯骨架（无标题行——ir-bar 样式已随工具栏改造移除），高度与终态一致 -->
  <div v-else-if="showSkeleton" class="ir-card">
    <div class="ir-frame">
      <div class="ir-skeleton">
        <div class="sk" style="width:42%"></div>
        <div class="sk" style="width:66%"></div>
        <div class="sk" style="width:52%"></div>
      </div>
    </div>
  </div>

  <!-- 载荷为空且未标记 blocked：正常终态不该出现，出现即渲染异常，输出可读兜底 -->
  <div v-else class="ir-card is-invalid">
    <div class="ir-bar"><span>图示无法解析</span></div>
    <pre class="ir-receipt">{{ source || '(空载荷)' }}</pre>
  </div>

  <div v-if="saveMessage" class="ir-toast">{{ saveMessage }}</div>

  <!-- 放大浮层：Teleport 到 body —— 气泡 rise 动画的 transform 会把 fixed 劫持进气泡内 -->
  <Teleport to="body">
    <div v-if="expanded" class="ir-lightbox" @click.self="expanded = false">
      <div class="ir-lightbox-head">
        <span class="ir-lightbox-title">{{ cardTitle }}</span>
        <button class="ir-lightbox-close" @click="expanded = false">{{ t('canvas.close') }}</button>
      </div>
      <div class="ir-lightbox-body">
        <!-- eslint-disable-next-line vue/no-v-html -->
        <div class="ir-svg" v-html="compiled?.svg"></div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * 变量口径与 canvas 卡片一致：--c-* 由 buildCanvasPreflight 体系提供，
 * 这里只用它们，保证深浅色自动跟随（不硬编码颜色，是现状链路的既有教训）。
 */
/*
 * 语义色变量注入（2026-10-10 真机 bug 的最终修法）。
 *
 * 背景：SVG 里所有颜色是 var(--c-*)，但这组变量只存在于 iframe 内部
 * （canvas 围栏由 buildCanvasDocument 注入 srcdoc）。本组件用 v-html 把 SVG
 * 直插宿主 DOM，不经 iframe ⇒ 宿主里没有这组变量 ⇒ 整卡渲染为空白。
 *
 * ⚠ 第一版修法是 :style 绑定 irCardRootStyle() 返回的「.ir-card{...}」CSS 规则串
 * —— 这是错的：Vue 的 :style 期望内联声明串，带选择器的规则串会被整段忽略，
 * 且单测断言恰好也按规则串写的，绿灯是假象。真机仍白板后才定位到。
 *
 * 正解：变量定义直接写进 scoped style。静态、无 JS、scoped 属性选择器天然限定
 * 作用域。映射值全部引用 design-tokens.css 基础令牌，浅底用 color-mix 派生，
 * 不写死任何绝对色 ⇒ 深浅色各自正确。与 utils/irCardTheme.ts 的映射表保持一致
 * （那边有单测守着「全 var() 无硬编码」，这边若漂移以测试为准）。
 */
/*
 * ⚠ 作用域必须是 .ir-card 与 .ir-lightbox 两者：
 * lightbox 经 Teleport 挂到 body，不在 .ir-card 的 DOM 子树里——
 * 变量只定义在 .ir-card 时，lightbox 内 SVG 的 fill 解析失败回落黑色
 * （rect 默认 fill:black、path 默认 stroke:none ⇒ 连线消失、黑块吞字，
 *  真机截图 3 的「黑块」就是这个）。CSS 自定义属性靠 DOM 继承，Teleport 断链。
 */
.ir-card,
.ir-lightbox {
  --c-bg: var(--background);
  --c-fg: var(--foreground);
  --c-muted: var(--muted);
  --c-muted-fg: var(--muted-foreground);
  --c-surface: color-mix(in oklab, var(--muted) 55%, var(--background));
  --c-border: var(--border);
  --c-ok: var(--success);
  --c-warn: var(--warning);
  --c-bad: var(--destructive);
  --c-accent: var(--brand-accent);
  --c-ok-bg: color-mix(in oklab, var(--success) 12%, var(--background));
  --c-warn-bg: color-mix(in oklab, var(--warning) 14%, var(--background));
  --c-bad-bg: color-mix(in oklab, var(--destructive) 12%, var(--background));

  margin-top: 8px;
  background: var(--c-bg);
  border: 1px solid var(--c-border);
  border-radius: var(--radius-lg, 10px);
  overflow: hidden;
  box-shadow: var(--shadow-md, 0 4px 12px rgb(0 0 0 / 6%));
}
.ir-card.is-invalid { border-color: var(--c-bad, var(--destructive)); }

/*
 * 工具栏：与 HtmlCanvasBlock 的 .canvas-tools 同款口径（悬浮右上、hover 显现、
 * 同尺寸同间距）。类名独立（ir- 前缀），视觉不与 canvas 卡互绑。
 */
.ir-tools {
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
  transition: opacity 120ms cubic-bezier(0.4, 0, 0.2, 1),
    transform 120ms cubic-bezier(0.4, 0, 0.2, 1);
}
.ir-card:hover .ir-tools,
.ir-card:focus-within .ir-tools {
  opacity: 1;
  transform: translateY(0);
}
.ir-tool {
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
.ir-tool:hover {
  background: var(--muted);
  color: var(--foreground);
}
.ir-tool:disabled { opacity: 0.5; cursor: default; }
.ir-tool svg { width: 15px; height: 15px; }

.ir-toast {
  position: fixed;
  bottom: 22px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1001;
  padding: 7px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 12px;
  box-shadow: var(--shadow-lg);
  max-width: 70vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 放大浮层：与 canvas lightbox 同口径（Teleport 到 body，Escape 关闭） */
.ir-lightbox {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  padding: 4vh 4vw;
  background: rgb(0 0 0 / 80%);
}
.ir-lightbox-head {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-bottom: 10px;
}
.ir-lightbox-title {
  margin-right: auto;
  color: #fff;
  font-size: 13px;
  opacity: 0.85;
}
.ir-lightbox-close {
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
.ir-lightbox-body {
  flex: 1;
  min-height: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg, 10px);
  overflow: auto;
  background: var(--background);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px;
}
.ir-lightbox-body .ir-svg { width: 100%; }

.ir-frame {
  position: relative;
  height: 320px;
  overflow: auto;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 12px;
}

/* SVG 自身带 preserveAspectRatio，高度自适应，不写死 px */
/*
 * ⚠ .ir-svg 必须显式 width:100%：
 * 它是 .ir-frame（flex）的 item，宽度 shrink-to-fit；而 SVG 无 width/height 属性
 * （只有 viewBox），max-width:100% 相对「由自己决定的宽度」⇒ 循环依赖 ⇒ 塌成 0×0。
 * 真机表现＝卡片全白但 computed fill 全部正常（颜色没坏，是整个 SVG 尺寸为 0）。
 * lightbox 里能看到图，正是因为那里显式写了 width:100%。
 */
.ir-svg { width: 100%; }
.ir-svg :deep(svg) { max-width: 100%; height: auto; display: block; margin: 0 auto; }

.ir-receipt {
  margin: 0;
  padding: 11px 12px;
  font-family: var(--font-mono, ui-monospace);
  font-size: 11.5px;
  line-height: 1.7;
  color: var(--c-fg, var(--foreground));
  background: var(--c-bg, var(--background));
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 320px;
  overflow: auto;
}

/* 骨架：高度与终态同高（320px），闭合瞬间零跳变 */
.ir-skeleton {
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 100%;
}
.ir-skeleton .sk {
  height: 12px;
  border-radius: 6px;
  background: var(--c-muted, var(--muted));
  position: relative;
  overflow: hidden;
}
.ir-skeleton .sk::after {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(
    90deg,
    transparent,
    color-mix(in oklab, var(--c-fg, #333) 7%, transparent),
    transparent
  );
  animation: ir-shimmer 1.4s infinite;
}
@keyframes ir-shimmer {
  0% { transform: translateX(-100%); }
  100% { transform: translateX(100%); }
}
@media (prefers-reduced-motion: reduce) {
  .ir-skeleton .sk::after { animation: none; }
}
</style>