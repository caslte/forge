<script setup lang="ts">
import { ref, computed, watch } from 'vue';
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
  if (renderedOpenFence.value) {
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

</script>

<template>
  <div :class="['msg', `msg-${message.role}`, { streaming }]">
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
    <div class="msg-bubble">
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
  </div>
</template>

<style scoped>
.msg {
  border: none;
  padding: 2px 4px;
  background: transparent;
  animation: rise 0.3s ease both;
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

.msg-user .msg-bubble {
  width: fit-content;
  margin-left: auto;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: 16px;
  background: #3a3a3d;
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

.msg-content :deep(.md-code-block) {
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

@keyframes rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
