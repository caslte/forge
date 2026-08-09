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
    <div class="msg-avatar">
      <svg v-if="isUser" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
        <circle cx="12" cy="7" r="4" />
      </svg>
      <svg v-else-if="isAssistant" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M12 1v6m0 10v6M4.22 4.22l4.24 4.24m7.08 7.08l4.24 4.24M1 12h6m10 0h6M4.22 19.78l4.24-4.24m7.08-7.08l4.24-4.24" />
      </svg>
      <svg v-else-if="isTool" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="16" x2="12" y2="12" />
        <line x1="12" y1="8" x2="12.01" y2="8" />
      </svg>
    </div>
    <div class="msg-body">
      <div class="msg-head">
        <span class="msg-role">{{ isUser ? '你' : isAssistant ? '助手' : isTool ? '工具' : '系统' }}</span>
        <span v-if="timeLabel" class="msg-time">{{ timeLabel }}</span>
      </div>
      <div class="msg-content" v-html="renderedContent"></div>
      <div v-if="streaming" class="msg-cursor"></div>
    </div>
  </div>
</template>

<style scoped>
.msg {
  display: flex;
  gap: 10px;
  max-width: 85%;
  animation: fadeIn 0.2s ease-out;
}

.msg-user {
  flex-direction: row-reverse;
  align-self: flex-end;
}

.msg-avatar {
  width: 28px;
  height: 28px;
  border-radius: var(--radius-md);
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  background: var(--muted);
  color: var(--muted-foreground);
}

.msg-avatar svg {
  width: 16px;
  height: 16px;
}

.msg-user .msg-avatar {
  background: var(--brand);
  color: var(--brand-foreground);
}

.msg-assistant .msg-avatar {
  background: color-mix(in oklab, var(--info) 15%, var(--background));
  color: var(--info);
}

.msg-tool .msg-avatar {
  background: color-mix(in oklab, var(--warning) 15%, var(--background));
  color: var(--warning);
}

.msg-body {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.msg-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--muted-foreground);
}

.msg-user .msg-head {
  flex-direction: row-reverse;
}

.msg-role {
  font-weight: 600;
}

.msg-content {
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  font-size: 13.5px;
  line-height: 1.65;
  word-break: break-word;
  white-space: normal;
}

.msg-user .msg-content {
  background: var(--brand);
  color: var(--brand-foreground);
  border-bottom-right-radius: var(--radius-sm);
}

.msg-assistant .msg-content,
.msg-tool .msg-content,
.msg-system .msg-content {
  background: var(--card);
  border: 1px solid var(--border);
  border-bottom-left-radius: var(--radius-sm);
}

.msg-tool .msg-content {
  background: color-mix(in oklab, var(--warning) 5%, var(--card));
  font-family: var(--font-mono);
  font-size: 12.5px;
}

.msg-system .msg-content {
  font-style: italic;
  color: var(--muted-foreground);
}

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

.msg-user .msg-content :deep(.md-code-block) {
  background: color-mix(in oklab, var(--brand-foreground) 12%, var(--brand));
  border-color: color-mix(in oklab, var(--brand-foreground) 20%, transparent);
}

.msg-content :deep(.md-inline-code) {
  background: color-mix(in oklab, var(--foreground) 8%, transparent);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 0.92em;
}

.msg-user .msg-content :deep(.md-inline-code) {
  background: color-mix(in oklab, var(--brand-foreground) 15%, transparent);
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

.msg.streaming .msg-content {
  border-color: var(--brand);
}
</style>
