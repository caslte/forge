<script setup lang="ts">
import { ref, computed, watch, onUnmounted, nextTick } from 'vue';
import type { ConversationMessage } from '../types';
import { renderMarkdown, hasOpenFence } from '@forge/core/markdown';
import { parseUserContent, baseName, isImagePath } from '../attachmentText';
import { onMarkdownContentClick } from '../utils/markdownLinks';
import {
  extractCommandFromMessage,
  formatCommandLabel,
  splitSkillRefs,
  SOURCE_LABELS,
} from '../utils/slashCommand';
import MermaidBlock from './MermaidBlock.vue';
import HtmlCanvasBlock from './HtmlCanvasBlock.vue';
import ImageLightbox from './ImageLightbox.vue';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  message: ConversationMessage;
  streaming?: boolean;
  /** footer（复制+时间）是否渲染；assistant 分片卡片由父级按轮次分组只保留末卡 */
  showFooter?: boolean;
  /** 整轮复制文本（assistant 末卡覆盖同轮全部分片；缺省复制本条内容） */
  copyText?: string;
  /** 该轮首张 assistant 卡：false = 轮内分片卡，不播入场动画（非 assistant 恒 undefined） */
  firstOfTurn?: boolean;
}>();

const isUser = computed(() => props.message.role === 'user');
const isAssistant = computed(() => props.message.role === 'assistant');
const isTool = computed(() => props.message.role === 'tool');
const isSystem = computed(() => props.message.role === 'system');

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

/** 复制消息内容到剪贴板（有整轮 copyText 时复制整轮文本） */
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.copyText ?? props.message.content);
    copied.value = true;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copied.value = false;
    }, 1400);
  } catch {
    copied.value = false;
  }
}

/** 收尾帧高度过渡时长（与 ConversationView 的思考行收拢保持一致，同帧启动同步完成） */
const SETTLE_MS = 160;

/**
 * footer 挂载过渡（v3.85.0 底部跳动修复）：流式结束时 footer 随 !streaming 一帧挂载
 * （实测高度 17px + margin-top 8px），与思考行摘除叠成收尾帧的一次性跳动。
 * 从 0 高/0 透明/0 外边距展开到自然尺寸，结束后清掉内联样式交还 CSS（含基础 opacity 0.6）。
 */
function growFooter(el: Element, done: () => void): void {
  const node = el as HTMLElement;
  const cs = getComputedStyle(node);
  const h = node.offsetHeight;
  const mt = parseFloat(cs.marginTop) || 0;
  const op = cs.opacity;
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (reduce || h === 0) {
    done();
    return;
  }
  const style = node.style;
  style.overflow = 'hidden';
  style.height = '0px';
  style.opacity = '0';
  style.marginTop = '0px';
  void node.offsetHeight; // 强制回流，锁定起始状态
  style.transition = `height ${SETTLE_MS}ms ease, opacity ${SETTLE_MS}ms ease, margin-top ${SETTLE_MS}ms ease`;
  style.height = `${h}px`;
  style.opacity = op;
  style.marginTop = `${mt}px`;
  let finished = false;
  const finish = (): void => {
    if (finished) return;
    finished = true;
    node.removeEventListener('transitionend', onEnd);
    style.transition = '';
    style.height = '';
    style.overflow = '';
    style.marginTop = '';
    style.opacity = '';
    done();
  };
  // transitionend 会冒泡且每个过渡属性各触发一次：只认本元素事件，finished 去重
  const onEnd = (e: TransitionEvent): void => {
    if (e.target === node) finish();
  };
  node.addEventListener('transitionend', onEnd);
  setTimeout(finish, SETTLE_MS + 80); // 兜底：transitionend 未触发时也要交还样式
}

/**
 * 附件解析（仅用户消息）：尾部路径行 + markdown 链接图片 → 图片出缩略图（不显示路径），
 * 非图片出文件占位 chip。pi 会话消息带独立 image part（msg.images）时，正文里的
 * 裸 [Image #N] 占位行一并剥离（缩略图已另行渲染）。
 */
const userParsed = computed(() => {
  if (!isUser.value) {
    return { body: props.message.content, files: [] as string[], images: [] as string[], command: null };
  }
  // CV-S08 消息气泡命令美化：识别两种形态（发送原始串 / pi 展开的 <skill> 块），
  // 命令段从正文拉出单独渲染（与浮窗同款：品牌色加粗 + 来源标签）；
  // 展开的 <skill> 指令文档整块收起不展示，只留用户正文
  const command = extractCommandFromMessage(props.message.content);
  const bodySource = command !== null ? command.rest : props.message.content;
  return {
    ...parseUserContent(bodySource, {
      hasEmbeddedImages: (props.message.images?.length ?? 0) > 0,
    }),
    command,
  };
});

/** 用户正文按 /skill:name 引用切段（所有技能名样式性美化，执行语义归 pi） */
const userSegments = computed(() => (isUser.value ? splitSkillRefs(userParsed.value.body) : []));

/**
 * 用户消息定高钳制：超高内容气泡内滚动（默认从头展示）；
 * 检测到溢出后整块可点，点击开「完整消息」弹窗看全文。
 */
const USER_BUBBLE_MAX_H = 140;
const bubbleRef = ref<HTMLElement | null>(null);
const userOverflow = ref(false);
const fullOpen = ref(false);
/** 渐隐方向开关：仅在该方向真有可滚内容时出现（与会话树滚动边缘渐隐同口径，曲线见样式） */
const fadeTop = ref(false);
const fadeBottom = ref(false);

function measureBubble(): void {
  const el = bubbleRef.value;
  if (!el || !isUser.value) {
    userOverflow.value = false;
    fadeTop.value = false;
    fadeBottom.value = false;
    return;
  }
  userOverflow.value = el.scrollHeight - el.clientHeight > 1;
  fadeTop.value = el.scrollTop > 0;
  fadeBottom.value = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
}

/**
 * 渐隐口径（参考图对齐）：文字淡进「气泡底色」，气泡轮廓始终完整——
 * 用叠层而非 mask（mask 会把气泡背景一起淡成透明，浅色主题下边缘像被啃掉）。
 * fadeTop/fadeBottom 只控制叠层显隐，哪侧有截断哪侧出现。
 */
const bubbleStyle = computed<Record<string, string> | undefined>(() => {
  if (!isUser.value) return undefined;
  return { maxHeight: `${USER_BUBBLE_MAX_H}px` };
});

let bubbleRo: ResizeObserver | null = null;
watch(
  bubbleRef,
  (el) => {
    bubbleRo?.disconnect();
    bubbleRo = null;
    if (el && typeof ResizeObserver !== 'undefined') {
      bubbleRo = new ResizeObserver(() => measureBubble());
      bubbleRo.observe(el);
    }
    measureBubble();
  },
);
// 钳制框高度封顶后内容增长不再触发 ResizeObserver，正文变化时手动补测一次
watch(
  () => [props.message.content, isUser.value],
  () => void nextTick(measureBubble),
);
onUnmounted(() => bubbleRo?.disconnect());

/** 弹窗全文：命令段存在时首行还原命令标签，后接正文 */
const userFullText = computed(() => {
  const { body, command } = userParsed.value;
  return command ? `${formatCommandLabel(command.name)}\n${body}` : body;
});

function onBubbleClick(): void {
  if (!userOverflow.value) return;
  const sel = window.getSelection();
  if (sel && sel.toString()) return; // 拖选文字不算"点击展开"
  fullOpen.value = true;
}

function onFullKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') fullOpen.value = false;
}
watch(fullOpen, (open) => {
  if (open) document.addEventListener('keydown', onFullKeydown);
  else document.removeEventListener('keydown', onFullKeydown);
});
onUnmounted(() => document.removeEventListener('keydown', onFullKeydown));

/** 图片路径 → data URL 缩略图（异步读，加载完成后渲染） */
const userThumbs = ref<Record<string, string>>({});
watch(
  () => userParsed.value.images,
  (images) => {
    for (const img of images) {
      if (userThumbs.value[img] !== undefined) continue;
      userThumbs.value[img] = ''; // 占位：加载中不渲染
      void window.forge.file.readImage(img).then((dataUrl) => {
        if (dataUrl) userThumbs.value[img] = dataUrl;
      });
    }
  },
  { immediate: true },
);

/**
 * Markdown 安全渲染（P2-B）：流式与结束后统一用完整渲染（marked + hljs + sanitize 白名单），
 * 保证两种状态样式一致（此前流式用简化渲染导致紧凑/正常样式跳变）。
 * ponytail: 每 chunk 全量解析，长文+多代码块若流式卡顿再上节流（100ms 重渲染一次）。
 *
 * 节流已上线（首条/后续消息流式冻结修复）：流式期间（streaming=true）每 150ms 尾随
 * 重渲染一次，非流式（历史加载/终态覆盖）立即渲染。marked+hljs+sanitizeHtml 全量
 * 解析单次可达几十 ms，逐 delta 重渲染是 O(n²)，长回复时渲染线程占满 → 全 UI 冻结。
 * 开围栏标记 openFence 与 html 一同在节流点快照，mermaid/bodyHtml 派生量只依赖
 * 节流后状态，不再逐 delta 重算 + 重换 v-html。
 */
const STREAM_RENDER_INTERVAL_MS = 150;
const renderedContent = ref('');
/** 渲染时刻的内容快照是否含未闭合围栏（流式中 mermaid 只写了一半） */
const renderedOpenFence = ref(false);
let renderTimer: ReturnType<typeof setTimeout> | null = null;

function renderMarkdownNow(): void {
  renderTimer = null;
  const raw = isUser.value ? userParsed.value.body : (props.message.content ?? '');
  if (isUser.value || isSystem.value || isTool.value) {
    // 用户/系统/工具消息保持纯文本渲染（无 markdown 语义，避免误伤）
    renderedContent.value = escapeHtml(raw);
  } else {
    // 流式中间态不写渲染缓存（cacheable=false）：一次长回复有数百个中间态，
    // 写入会把 LRU 里的稳定态历史挤掉；流式结束的终态渲染会正常入缓存
    renderedContent.value = renderMarkdown(raw, !props.streaming);
  }
  renderedOpenFence.value = hasOpenFence(props.message.content ?? '');
}

watch(
  () => props.message.content,
  (raw) => {
    if (!props.streaming) {
      // 非流式（历史加载/终态覆盖/用户消息）：立即渲染，不落后于数据
      if (renderTimer !== null) {
        clearTimeout(renderTimer);
        renderTimer = null;
      }
      renderMarkdownNow();
    } else if (renderTimer === null) {
      renderTimer = setTimeout(renderMarkdownNow, STREAM_RENDER_INTERVAL_MS);
    }
  },
  { immediate: true },
);

// 流式结束（含取消/错误收尾）：冲刷待渲染内容，终态不留尾随延迟
watch(
  () => props.streaming,
  (streaming) => {
    if (streaming) return;
    if (renderTimer !== null) {
      clearTimeout(renderTimer);
      renderTimer = null;
    }
    renderMarkdownNow();
  },
);

/** 纯文本转义（用户消息等不使用 markdown 渲染） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** 图片 data URL（P3-B：粘贴截图/上传图片的消息内展示） */
const imageSrcs = computed(() =>
  (props.message.images ?? []).map(
    (img) => `data:${img.mimeType ?? 'image/png'};base64,${img.data}`,
  ),
);

/** 当前弹窗查看的图片 data URL（null = 关闭）；点缩略图开弹窗，不在气泡内放大 */
const lightboxSrc = ref<string | null>(null);

/** 从渲染好的 HTML 中提取 mermaid 占位，并把占位 pre 从正文中摘除（MermaidBlock 列表单独渲染） */
const mermaidBlocks = computed<{ key: string; encoded: string }[]>(() => {
  const blocks: { key: string; encoded: string }[] = [];
  const re = /data-md-mermaid="([^"]+)"/g;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(renderedContent.value)) !== null) {
    blocks.push({ key: `${i++}-${m[1]?.slice(0, 8) ?? ''}`, encoded: m[1] ?? '' });
  }
  // 末围栏未闭合（流式中 mermaid 只写了一半）：末块先不渲染图表，避免半截源码反复渲染失败报错闪现
  if (renderedOpenFence.value && blocks.length > 0) blocks.pop();
  return blocks;
});

/** 正文 HTML：摘除 mermaid 占位 pre（原占位含 base64 源码，避免泄漏到文本区） */
const bodyHtml = computed(() => {
  const html = renderedContent.value;
  // 末围栏未闭合时保留最后一个占位 pre（含转义源码，按普通代码块展示），其余照常摘除
  const keepLast = renderedOpenFence.value;
  const lastIdx = keepLast ? html.lastIndexOf('<pre class="md-mermaid-wrap">') : -1;
  return html.replace(/<pre class="md-mermaid-wrap">[\s\S]*?<\/pre>/g, (match, offset: number) =>
    keepLast && offset === lastIdx ? match : '',
  );
});

/** 正文分段：一段安全 HTML，或一个画布卡片槽位 */
type Segment =
  | { kind: 'html'; html: string }
  | { kind: 'canvas'; key: string; encoded: string; blocked: boolean };

/**
 * 正文分段：把 canvas 占位从 HTML 流里切出来，换成组件槽位。
 *
 * 与 mermaid 的差别是刻意的：mermaid 图统一堆到气泡底部（历史行为，不动它），
 * 而画布卡片是「夹在两段正文中间、给上文配图」的，切到底部就丢了语义——
 * 用户按顺序读时图必须在它解释的那段话旁边。
 */
const segments = computed<Segment[]>(() => {
  const html = bodyHtml.value;
  const re = /<pre class="md-canvas-wrap"><code class="md-canvas" data-md-canvas="([^"]*)">[\s\S]*?<\/code><\/pre>/g;
  const out: Segment[] = [];
  let cursor = 0;
  let match: RegExpExecArray | null;
  let i = 0;
  while ((match = re.exec(html)) !== null) {
    if (match.index > cursor) {
      out.push({ kind: 'html', html: html.slice(cursor, match.index) });
    }
    const encoded = match[1] ?? '';
    out.push({ kind: 'canvas', key: `c${i}-${encoded.slice(0, 8)}`, encoded, blocked: false });
    cursor = match.index + match[0].length;
    i += 1;
  }
  if (cursor < html.length) {
    out.push({ kind: 'html', html: html.slice(cursor) });
  }
  // 末围栏未闭合（流式中卡片只写了一半）：只有最后那张换成骨架蒙版。
  // 蒙版高度 == 终态高度，所以闭合瞬间既不跳变也不顶动下方正文。
  // 仅流式期间生效：终态（结束/取消/历史）围栏仍未闭合时不会再有后续 token，
  // 骨架会永远转圈——此时直接按占位内容渲染（残缺 HTML 交给浏览器补齐，
  // 非 HTML 走代码块降级），宁可显示半成品也不挂假进度。
  if (renderedOpenFence.value && props.streaming) {
    for (let j = out.length - 1; j >= 0; j -= 1) {
      const seg = out[j];
      if (seg && seg.kind === 'canvas') {
        seg.blocked = true;
        break;
      }
    }
  }
  return out;
});

const timeLabel = computed(() => {
  try {
    const d = new Date(props.message.ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
});

/**
 * 入场动画（方案一）：只给「真新消息」挂载播 rise——ts 距挂载超过 RISE_FRESH_MS 视为
 * 历史加载/切会话批量重挂载，不播；一轮回复里非首张的 assistant 分片卡也不重播。
 */
const RISE_FRESH_MS = 2000;
const riseIn = computed(() => {
  if (isAssistant.value && props.firstOfTurn === false) return false;
  const ts = Date.parse(props.message.ts);
  return Number.isFinite(ts) && Date.now() - ts <= RISE_FRESH_MS;
});

</script>

<template>
  <div :class="['msg', `msg-${message.role}`, { streaming, 'rise-in': riseIn }]">
    <!-- 附件图片缩略图（统一给路径：图片不显示路径，点击放大）：渲染在气泡上方 -->
    <div
      v-if="userParsed.images.some((img) => userThumbs[img])"
      class="msg-images"
    >
      <template v-for="img in userParsed.images" :key="img">
        <img
          v-if="userThumbs[img]"
          :src="userThumbs[img]"
          class="msg-image"
          alt=""
          @click="lightboxSrc = userThumbs[img] ?? null"
        />
      </template>
    </div>
    <!-- 消息附带图片（旧会话历史遗留）：固定正方形缩略图，点击弹窗看原图 -->
    <div v-if="imageSrcs.length > 0" class="msg-images">
      <img
        v-for="(src, i) in imageSrcs"
        :key="i"
        :src="src"
        class="msg-image"
        alt=""
        @click="lightboxSrc = src"
      />
    </div>
    <!-- 外壳：仅作渐隐叠层的定位参照（叠层是气泡兄弟，悬浮在滚动内容之上、不随内容滚动） -->
    <div class="msg-bubble-shell" :class="{ 'is-clamped': isUser && userOverflow }">
      <div
        ref="bubbleRef"
        class="msg-bubble"
        :style="bubbleStyle"
        @click="onBubbleClick"
        @scroll="measureBubble"
      >
      <!-- CV-S08 命令美化段（与浮窗同款）：命令名 + 来源标签，后接剩余正文 -->
      <div v-if="userParsed.command" class="msg-cmd-head">
        <span
          class="msg-cmd-name"
          :class="userParsed.command.source ? 'is-' + userParsed.command.source : ''"
        >{{ formatCommandLabel(userParsed.command.name) }}</span>
        <span
          v-if="userParsed.command.source"
          class="msg-cmd-tag"
          :class="'tag-' + userParsed.command.source"
        >{{ SOURCE_LABELS[userParsed.command.source] }}</span>
      </div>
      <!-- 用户消息正文：按 /skill:name 引用切段渲染（全部技能名美化；Vue 插值自动转义） -->
      <div v-if="isUser" class="msg-content"><template
        v-for="(seg, i) in userSegments"
        :key="i"
        ><span v-if="seg.kind === 'text'">{{ seg.text }}</span><template
          v-else
        ><span class="msg-cmd-name is-skill">{{ formatCommandLabel(seg.text) }}</span><span
            class="msg-cmd-tag tag-skill"
          >{{ t('chat.skillTag') }}</span></template></template></div>
      <!-- 助手/系统/工具正文：分段渲染，画布卡片留在它原本的段落位置 -->
      <template v-else>
        <template v-for="(seg, i) in segments" :key="seg.kind === 'canvas' ? seg.key : `h${i}`">
          <div v-if="seg.kind === 'html'" class="msg-content" v-html="seg.html" @click="onMarkdownContentClick"></div>
          <HtmlCanvasBlock v-else :encoded="seg.encoded" :blocked="seg.blocked" />
        </template>
      </template>
      <!-- 附件文件占位 chip（非图片路径，title 显示完整路径） -->
      <div v-if="userParsed.files.length > 0" class="msg-att-files">
        <span
          v-for="f in userParsed.files"
          :key="f"
          class="msg-att-chip"
          :title="f"
        >
          <span class="msg-att-icon">
            <svg v-if="isImagePath(f)" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <polyline points="21 15 16 10 5 21" />
            </svg>
            <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
            </svg>
          </span>
          <span class="msg-att-name">{{ baseName(f) }}</span>
        </span>
      </div>
      <ImageLightbox :src="lightboxSrc" @close="lightboxSrc = null" />
      <!-- Mermaid 图表（完整格式化后提取的占位，逐个渲染） -->
      <div v-for="block in mermaidBlocks" :key="block.key" class="msg-mermaid">
        <MermaidBlock :encoded="block.encoded" />
      </div>
      </div>
      <div v-if="isUser && fadeTop" class="bubble-fade bubble-fade-top" />
      <div v-if="isUser && fadeBottom" class="bubble-fade bubble-fade-bottom" />
    </div>
    <!-- 完整消息弹窗：必须 Teleport 到 body（气泡祖先带 transform，fixed 会被劫持成气泡内定位） -->
    <Teleport to="body">
      <div v-if="fullOpen" class="msg-fullbox" @click.self="fullOpen = false">
        <div class="msg-fullbox-card">
          <div class="msg-fullbox-head">
            <span class="msg-fullbox-title">{{ t('chat.fullMessage') }}</span>
            <button class="msg-fullbox-close" :aria-label="t('canvas.close')" @click="fullOpen = false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
          <div class="msg-fullbox-body">{{ userFullText }}</div>
        </div>
      </div>
    </Teleport>
    <!-- 收尾帧 footer 挂载过渡（v3.85.0 底部跳动修复）：随 !streaming 一帧挂载
         （实测 17px 高 + 8px margin-top），与思考行摘除叠成收尾帧的一次性跳动；
         JS 钩子把高度/透明度/外边距摊到 160ms，与思考行收拢同帧启动、同步完成 -->
    <Transition :css="false" @enter="growFooter">
      <div v-if="!streaming && showFooter !== false" class="msg-footer">
        <button class="msg-copy" :title="copied ? t('chat.copied') : t('chat.copy')" @click="copy">
          <svg v-if="copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <polyline points="20 6 9 17 4 12" />
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <rect x="9" y="9" width="13" height="13" rx="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
          <span>{{ copied ? t('chat.copied') : '' }}</span>
        </button>
        <span class="msg-time">{{ timeLabel }}</span>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.msg {
  border: none;
  padding: 2px 4px;
  background: transparent;
  max-width: 100%;
  /* flex 子项（消息列表为 column flex）显式允许收缩：
     否则 min-width:auto 会被长代码块/长链接撑破窄窗格，代码块无法在容器内横向滚动 */
  min-width: 0;
}

.msg-bubble {
  min-width: 0;
}

.msg-user {
  align-self: flex-end;
  margin-left: auto;
  /* 长段落 fit-content 会取满整行（中文任意断行 max-content 巨大），
     限宽 78% 让左侧留空，视觉上与 assistant 回复区分层次 */
  max-width: 78%;
}

.msg-user .msg-bubble-shell {
  position: relative;
  width: fit-content;
  max-width: 100%;
  margin-left: auto;
  min-width: 0;
  --bubble-bg: #3a3a3d;
}

.msg-user .msg-bubble {
  width: fit-content;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--bubble-bg);
  transition: background-color var(--transition-fast);
  /* 定高钳制（max-height 由模板内联给出）：超高内容气泡内滚动，滚动条不渲染 */
  overflow-y: auto;
  scrollbar-width: none;
}

.msg-user .msg-bubble::-webkit-scrollbar {
  display: none;
}

.msg-user .msg-bubble-shell.is-clamped {
  cursor: pointer;
}

/* 可点开的反馈：悬停整体提亮一档（仅溢出态，普通短气泡无交互不给假暗示） */
.msg-user .msg-bubble-shell.is-clamped:hover {
  --bubble-bg: #4a4a4d;
}

/* 渐隐叠层：文字淡进气泡底色、轮廓完整；28px 内 smoothstep 曲线收色 */
.bubble-fade {
  position: absolute;
  left: 0;
  right: 0;
  height: 28px;
  pointer-events: none;
}
.bubble-fade-top {
  top: 0;
  border-radius: 16px 16px 0 0;
  background: linear-gradient(
    to top,
    transparent 0,
    color-mix(in srgb, var(--bubble-bg) 16%, transparent) 25%,
    color-mix(in srgb, var(--bubble-bg) 50%, transparent) 50%,
    color-mix(in srgb, var(--bubble-bg) 84%, transparent) 75%,
    var(--bubble-bg) 100%
  );
}
.bubble-fade-bottom {
  bottom: 0;
  border-radius: 0 0 16px 16px;
  background: linear-gradient(
    to bottom,
    transparent 0,
    color-mix(in srgb, var(--bubble-bg) 16%, transparent) 25%,
    color-mix(in srgb, var(--bubble-bg) 50%, transparent) 50%,
    color-mix(in srgb, var(--bubble-bg) 84%, transparent) 75%,
    var(--bubble-bg) 100%
  );
}

.msg-user .msg-content {
  color: #ffffff;
}

.msg-assistant {
  max-width: 94%;
}

.msg-system {
  max-width: 94%;
}

.msg-content {
  font-size: 14px;
  line-height: 2;
  color: var(--foreground);
  word-break: break-word;
  user-select: text; /* 对话内容允许鼠标选择 */
}

/* 纯文本消息（用户/系统/工具）保留手打换行。markdown 消息绝不能 pre-wrap：
   marked 输出的 HTML 标签间带 \n（</p>\n<h2>、结尾 \n），pre-wrap 会把它们
   渲染成 ~21px 隐形空行，导致块间距忽宽忽窄（实测 6px 外边距被撑到 25~27px） */
.msg-user .msg-content,
.msg-system .msg-content,
.msg-tool .msg-content {
  white-space: pre-wrap;
}

/* CV-S08 消息气泡命令美化段（与浮窗条目同款：品牌色加粗 + 来源标签胶囊）；
   与剩余正文同行内联穿插（命令名/标签后直接接正文，长文自然折行） */
.msg-cmd-head {
  display: inline;
  margin-right: 6px;
}
.msg-cmd-name {
  font-size: 13px;
  color: var(--foreground);
}
.msg-cmd-name.is-skill {
  font-weight: 700;
  color: #ffffff;
}
.msg-cmd-name.is-prompt {
  color: var(--muted-foreground);
}
.msg-cmd-tag {
  display: inline-block;
  margin-left: 6px;
  font-size: 10px;
  line-height: 1;
  padding: 3px 6px;
  border-radius: 999px;
  color: var(--muted-foreground);
  background: var(--muted);
}
.msg-cmd-tag.tag-skill {
  /* 纯黑气泡 + 白字技能名 + 白底深字胶囊：整组像一条 command chip，焦点明确 */
  color: #0f0f10;
  background: #ffffff;
}
/* 命令段存在时正文降为内联，紧跟命令名/标签之后（同级块间空白已被 Vue condense 移除，不产多余空隙） */
.msg-cmd-head + .msg-content {
  display: inline;
}

/* 消息附带图片（P3-B）：缩略图网格，渲染在气泡上方、靠右排列，点击放大 */
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  justify-content: flex-end;
  margin-bottom: 8px;
}

.msg-images:empty {
  display: none;
}

/* 附件文件占位 chip（用户消息尾部路径行）：胶囊样式，与输入框附件 chip 同款 */
.msg-att-files {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 8px;
}

.msg-att-files:empty {
  display: none;
}

.msg-att-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 260px;
  padding: 4px 8px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 999px;
  font-size: 12px;
  color: var(--foreground);
}

.msg-att-icon {
  display: inline-flex;
  color: var(--muted-foreground);
  flex-shrink: 0;
}

.msg-att-icon svg {
  width: 14px;
  height: 14px;
}

.msg-att-name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* 消息图片：固定 120px 正方形缩略图（cover 裁剪填满），点击弹窗看原图 */
.msg-image {
  width: 120px;
  height: 120px;
  object-fit: cover;
  border-radius: 10px;
  border: 1px solid var(--border);
  cursor: zoom-in;
  user-select: none;
}

.msg-footer {
  display: flex;
  align-items: center;
  justify-content: flex-start; /* 助手/系统回复：复制+时间靠左 */
  gap: 10px;
  margin-top: 8px;
  opacity: 0.6;
  transition: opacity var(--transition-fast);
  user-select: none;
}
.msg-user .msg-footer {
  justify-content: flex-end; /* 用户回复：复制+时间靠右 */
}
.msg:hover .msg-footer {
  opacity: 1;
}
.msg-time {
  font-size: 11px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
}
.msg-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 6px;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--muted-foreground);
  font-size: 11px;
  cursor: pointer;
  line-height: 1;
}
.msg-copy:hover {
  background: var(--muted);
  color: var(--foreground);
}
.msg-copy svg {
  width: 13px;
  height: 13px;
}

.msg-system .msg-content {
  color: var(--muted-foreground);
  font-style: italic;
}

/* 内联/块级 Markdown —— 统一重置块级默认 margin，使用紧凑统一块间距 */
.msg-mermaid {
  margin-top: 4px;
}

.msg-content :deep(p),
.msg-content :deep(h1),
.msg-content :deep(h2),
.msg-content :deep(h3),
.msg-content :deep(h4),
.msg-content :deep(h5),
.msg-content :deep(h6),
.msg-content :deep(blockquote),
.msg-content :deep(hr),
.msg-content :deep(pre),
.msg-content :deep(ul),
.msg-content :deep(ol),
.msg-content :deep(table) {
  margin: 0;
  margin-block-end: 12px;
}

/* md-ascii：字符画段落降级（renderMarkdown 的 paragraph 兜底），
   与代码块同款容器形态；pre 默认空白规则保住对齐 */
.msg-content :deep(.md-code-block),
.msg-content :deep(.md-ascii) {
  background: color-mix(in oklab, var(--foreground) 8%, var(--background));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  margin: 12px 0;
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
}

.msg-content :deep(.md-inline-code) {
  background: var(--muted);
  color: var(--foreground);
  padding: 1px 6px;
  border-radius: 6px;
  font-family: var(--font-mono);
  font-size: 12px;
}

.msg-content :deep(ul),
.msg-content :deep(ol) {
  padding-left: 0;
  list-style-position: inside;
}

/* 标题上方留白（块间外边距塌陷取 max，标题上实际 18px）；首块不另加顶部空隙 */
.msg-content :deep(h1),
.msg-content :deep(h2),
.msg-content :deep(h3),
.msg-content :deep(h4),
.msg-content :deep(h5),
.msg-content :deep(h6) {
  margin-block-start: 18px;
}

/* 首块无顶部外边距、末块无底部外边距：消息内部上下不拖空隙，
   文字卡与工具条上下间隙对称（均为 flex gap 16px + .msg padding 2px） */
.msg-content :deep(:first-child) {
  margin-block-start: 0;
}

.msg-content :deep(:last-child) {
  margin-block-end: 0;
}

.msg-content :deep(li) {
  padding-left: 4px;
  line-height: 2;
}

/* li 内部的段落/子列表不再产生块间距（marked 默认 <li><p>xxx</p></li> 会撑开） */
.msg-content :deep(li > p),
.msg-content :deep(li li > p),
.msg-content :deep(li > h1),
.msg-content :deep(li > h2),
.msg-content :deep(li > h3),
.msg-content :deep(li > h4),
.msg-content :deep(li > h5),
.msg-content :deep(li > h6),
.msg-content :deep(li > ul),
.msg-content :deep(li > ol),
.msg-content :deep(li > pre),
.msg-content :deep(li > blockquote),
.msg-content :deep(li > table) {
  margin: 0;
}

.msg-content :deep(li + li) {
  margin-top: 0;
}

.msg-content :deep(li)::marker {
  color: var(--muted-foreground);
}

/* Markdown 表格 */
.msg-content :deep(table) {
  border-collapse: collapse;
  margin: 12px 0;
  font-size: 13px;
  line-height: 2;
  display: block;
  max-width: 100%;
  overflow-x: auto;
  white-space: normal;
}

.msg-content :deep(th),
.msg-content :deep(td) {
  border: 1px solid var(--border);
  padding: 5px 10px;
  text-align: left;
  vertical-align: top;
  white-space: normal;
}

.msg-content :deep(th) {
  background: var(--muted);
  font-weight: 600;
  color: var(--foreground);
}

.msg-content :deep(tbody tr:nth-child(even)) {
  background: color-mix(in oklab, var(--muted) 40%, transparent);
}

/* 入场动画只挂 rise-in（判定逻辑见 script 段 riseIn） */
.msg.rise-in {
  animation: rise 0.3s ease both;
}

@keyframes rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}

/* ---------- 完整消息弹窗（遮罩/卡片配方同 SettingsPanel 弹窗口径：--overlay + 10px 毛玻璃） ---------- */
.msg-fullbox {
  position: fixed;
  inset: 0;
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 6vh 6vw;
  background: var(--overlay);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  animation: fullbox-fade 0.15s ease;
}
.msg-fullbox-card {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  max-height: 100%;
  border: none;
  border-radius: var(--radius-3xl);
  background: var(--card);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}
.msg-fullbox-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px 10px;
  flex-shrink: 0;
}
.msg-fullbox-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
}
.msg-fullbox-close {
  display: inline-flex;
  padding: 4px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--muted-foreground);
  cursor: pointer;
  line-height: 1;
}
.msg-fullbox-close:hover {
  background: var(--muted);
  color: var(--foreground);
}
.msg-fullbox-close svg {
  width: 16px;
  height: 16px;
}
.msg-fullbox-body {
  padding: 4px 18px 18px;
  overflow-y: auto;
  font-size: 14px;
  line-height: 1.7;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
}
@keyframes fullbox-fade {
  from { opacity: 0; }
  to { opacity: 1; }
}
</style>
