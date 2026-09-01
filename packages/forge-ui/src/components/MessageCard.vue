<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ConversationMessage } from '../types';
import { renderMarkdown, hasOpenFence } from '@forge/core/markdown';
import MermaidBlock from './MermaidBlock.vue';
import ImageLightbox from './ImageLightbox.vue';

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
 * Markdown 安全渲染（P2-B）：流式与结束后统一用完整渲染（marked + hljs + sanitize 白名单），
 * 保证两种状态样式一致（此前流式用简化渲染导致紧凑/正常样式跳变）。
 * ponytail: 每 chunk 全量解析，长文+多代码块若流式卡顿再上节流（100ms 重渲染一次）。
 */
const renderedContent = computed(() => {
  const raw = props.message.content;
  if (isUser.value || isSystem.value || isTool.value) {
    // 用户/系统/工具消息保持纯文本渲染（无 markdown 语义，避免误伤）
    return escapeHtml(raw);
  }
  return renderMarkdown(raw);
});

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
  if (hasOpenFence(props.message.content) && blocks.length > 0) blocks.pop();
  return blocks;
});

/** 正文 HTML：摘除 mermaid 占位 pre（原占位含 base64 源码，避免泄漏到文本区） */
const bodyHtml = computed(() => {
  const html = renderedContent.value;
  // 末围栏未闭合时保留最后一个占位 pre（含转义源码，按普通代码块展示），其余照常摘除
  const keepLast = hasOpenFence(props.message.content);
  const lastIdx = keepLast ? html.lastIndexOf('<pre class="md-mermaid-wrap">') : -1;
  return html.replace(/<pre class="md-mermaid-wrap">[\s\S]*?<\/pre>/g, (match, offset: number) =>
    keepLast && offset === lastIdx ? match : '',
  );
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
    <div class="msg-bubble">
      <div class="msg-content" v-html="bodyHtml"></div>
      <!-- 消息附带图片（P3-B）：固定正方形缩略图，点击弹窗看原图 -->
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
      <ImageLightbox :src="lightboxSrc" @close="lightboxSrc = null" />
      <!-- 多模态门控：当前模型不支持图片输入，附件已跳过未发送 -->
      <div v-if="isUser && message.imageSkipped" class="msg-image-skipped">
        图片未发送：当前模型不支持图片输入
      </div>
      <!-- Mermaid 图表（完整格式化后提取的占位，逐个渲染） -->
      <div v-for="block in mermaidBlocks" :key="block.key" class="msg-mermaid">
        <MermaidBlock :encoded="block.encoded" />
      </div>
    </div>
    <div v-if="!streaming && showFooter !== false" class="msg-footer">
      <button class="msg-copy" :title="copied ? '已复制' : '复制'" @click="copy">
        <svg v-if="copied" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
        <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <rect x="9" y="9" width="13" height="13" rx="2" />
          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
        </svg>
        <span>{{ copied ? '已复制' : '' }}</span>
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
}

.msg-bubble {
  min-width: 0;
}

.msg-user {
  align-self: flex-end;
  margin-left: auto;
}

.msg-user .msg-bubble {
  width: fit-content;
  margin-left: auto;
  max-width: 100%;
  padding: 10px 14px;
  border-radius: 16px;
  background: color-mix(in oklab, var(--muted) 55%, var(--background));
}

.msg-assistant {
  max-width: 94%;
}

.msg-system {
  max-width: 94%;
}

.msg-content {
  font-size: 14px;
  line-height: 1.5;
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

/* 消息附带图片（P3-B）：缩略图网格，点击放大 */
.msg-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}

.msg-images:empty {
  display: none;
}

/* 多模态门控：图片未发送的提示（模型不支持图片输入） */
.msg-image-skipped {
  margin-top: 6px;
  font-size: 11.5px;
  line-height: 1.4;
  color: color-mix(in oklab, var(--muted-foreground) 75%, var(--foreground));
  background: color-mix(in oklab, var(--warning, #b58900) 8%, transparent);
  border: 1px solid color-mix(in oklab, var(--warning, #b58900) 22%, transparent);
  border-radius: var(--radius-sm);
  padding: 4px 8px;
  user-select: none;
}

.msg-user .msg-image-skipped {
  text-align: right;
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
  line-height: 1.5;
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
  line-height: 1.45;
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
