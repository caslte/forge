<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue';
import type { ConversationMessage } from '../types';
import { renderMarkdown, renderMarkdownPartial } from '@forge/core/markdown';
import MermaidBlock from './MermaidBlock.vue';

const props = defineProps<{
  message: ConversationMessage;
  streaming?: boolean;
}>();

const isUser = computed(() => props.message.role === 'user');
const isAssistant = computed(() => props.message.role === 'assistant');
const isTool = computed(() => props.message.role === 'tool');
const isSystem = computed(() => props.message.role === 'system');

const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

/** 复制消息内容到剪贴板 */
async function copy(): Promise<void> {
  try {
    await navigator.clipboard.writeText(props.message.content);
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
 * 安全 Markdown 渲染（P2-B）：
 * - 流式期间用增量渲染（低成本：仅转义 + 行内 code + 粗体，避免半截代码块闪动）
 * - 流式结束后完整格式化（marked + hljs 高亮 + sanitize-html 白名单，mermaid 块留占位）
 */
const mdReady = computed(() => !props.streaming);
const renderedContent = computed(() => {
  const raw = props.message.content;
  if (isUser.value || isSystem.value || isTool.value) {
    // 用户/系统/工具消息保持纯文本渲染（无 markdown 语义，避免误伤）
    return escapeHtml(raw);
  }
  return mdReady.value ? renderMarkdown(raw) : renderMarkdownPartial(raw);
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

/** 图片点击放大态：当前放大的图片索引（null 为未放大） */
const zoomedImage = ref<number | null>(null);

/** 点击图片切换放大/还原 */
function toggleZoom(i: number): void {
  zoomedImage.value = zoomedImage.value === i ? null : i;
}

/** 从渲染好的 HTML 中提取 mermaid 占位，并把占位 pre 从正文中摘除（MermaidBlock 列表单独渲染） */
const mermaidBlocks = computed<{ key: string; encoded: string }[]>(() => {
  const blocks: { key: string; encoded: string }[] = [];
  if (mdReady.value) {
    const re = /data-md-mermaid="([^"]+)"/g;
    let m: RegExpExecArray | null;
    let i = 0;
    while ((m = re.exec(renderedContent.value)) !== null) {
      blocks.push({ key: `${i++}-${m[1]?.slice(0, 8) ?? ''}`, encoded: m[1] ?? '' });
    }
  }
  return blocks;
});

/** 正文 HTML：摘除 mermaid 占位 pre（原占位含 base64 源码，避免泄漏到文本区） */
const bodyHtml = computed(() =>
  renderedContent.value.replace(/<pre class="md-mermaid-wrap">[\s\S]*?<\/pre>/g, ''),
);

const timeLabel = computed(() => {
  try {
    const d = new Date(props.message.ts);
    return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  } catch {
    return '';
  }
});

// 流式结束时触发一次完整格式化（content 变化且不再 streaming）
watch(mdReady, (ready) => {
  if (ready) void nextTick();
});
</script>

<template>
  <div :class="['msg', `msg-${message.role}`, { streaming }]">
    <div class="msg-bubble">
      <div class="msg-content" v-html="bodyHtml"></div>
      <!-- 消息附带图片（P3-B：用户粘贴截图/上传，点击放大） -->
      <div v-if="imageSrcs.length > 0" class="msg-images">
        <img
          v-for="(src, i) in imageSrcs"
          :key="i"
          :src="src"
          :class="{ zoomed: zoomedImage === i }"
          class="msg-image"
          alt=""
          @click="toggleZoom(i)"
        />
      </div>
      <!-- 多模态门控：当前模型不支持图片输入，附件已跳过未发送 -->
      <div v-if="isUser && message.imageSkipped" class="msg-image-skipped">
        图片未发送：当前模型不支持图片输入
      </div>
      <!-- Mermaid 图表（完整格式化后提取的占位，逐个渲染） -->
      <div v-for="block in mermaidBlocks" :key="block.key" class="msg-mermaid">
        <MermaidBlock :encoded="block.encoded" />
      </div>
    </div>
    <div v-if="!streaming" class="msg-footer">
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
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text; /* 对话内容允许鼠标选择 */
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

.msg-image {
  max-width: 240px;
  max-height: 180px;
  border-radius: 10px;
  border: 1px solid var(--border);
  object-fit: contain;
  cursor: zoom-in;
  transition: transform var(--transition-fast);
}

.msg-image.zoomed {
  max-width: min(560px, 100%);
  max-height: 420px;
  cursor: zoom-out;
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
  margin-block-end: 6px;
}

.msg-content :deep(.md-code-block) {
  background: color-mix(in oklab, var(--foreground) 8%, var(--background));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  margin: 6px 0;
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
  margin-block-end: 4px;
  line-height: 10px;
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
  margin: 6px 0;
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
