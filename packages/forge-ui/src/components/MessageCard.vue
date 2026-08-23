<script setup lang="ts">
import { computed } from 'vue';
import type { ConversationMessage } from '../types';

const props = defineProps<{
  message: ConversationMessage;
  streaming?: boolean;
}>();

const isUser = computed(() => props.message.role === 'user');
const isAssistant = computed(() => props.message.role === 'assistant');
const isTool = computed(() => props.message.role === 'tool');
const isSystem = computed(() => props.message.role === 'system');

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
    <div class="msg-content" v-html="renderedContent"></div>
    <div v-if="streaming" class="msg-cursor"></div>
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

.msg-user {
  align-self: flex-end;
  margin-left: auto;
  max-width: 86%;
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
