<script setup lang="ts">
import { ref, computed } from 'vue';
import type { ConversationMessage } from '../types';

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

/** 简单 Markdown 渲染：代码块、行内代码、加粗、换行。不引入依赖。 */
const renderedContent = computed(() => {
  const raw = props.message.content;
  // 转义 HTML
  let html = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  // 代码块 ```lang\n...```
  html = html.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, _lang, code) => {
    return `<pre class="md-code-block"><code>${code.replace(/\n$/, '')}</code></pre>`;
  });
  // 行内代码
  html = html.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>');
  // 加粗
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // 换行
  html = html.replace(/\n/g, '<br>');
  return html;
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
      <div class="msg-content" v-html="renderedContent"></div>
      <div v-if="streaming" class="msg-cursor"></div>
    </div>
    <div class="msg-footer">
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
  line-height: 1.65;
  color: var(--foreground);
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text; /* 对话内容允许鼠标选择 */
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

/* 内联/块级 Markdown */
.msg-content :deep(.md-code-block) {
  background: color-mix(in oklab, var(--foreground) 8%, var(--background));
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  padding: 10px 12px;
  margin: 8px 0;
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

.msg-cursor {
  display: inline-block;
  width: 7px;
  height: 16px;
  background: var(--brand);
  margin-left: 2px;
  animation: cursor-blink 1s step-end infinite;
  vertical-align: text-bottom;
}

@keyframes cursor-blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

@keyframes rise {
  from { opacity: 0; transform: translateY(6px); }
  to { opacity: 1; transform: translateY(0); }
}
</style>
