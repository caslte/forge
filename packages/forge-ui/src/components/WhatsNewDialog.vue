<script setup lang="ts">
/**
 * 版本更新说明弹窗（升级后首启自动弹 + 设置「关于」页回看）。
 *
 * 显隐由 useWhatsNew 模块级单例驱动（本组件挂 App.vue 根，对齐 GitCommitDialog）；
 * 正文 = 安装包内置 release-notes.md 经 renderMarkdown 渲染（sanitize 白名单兜底），
 * 链接点击复用 markdownLinks 的 openExternal 委托——绝不让应用窗口导航。
 * 弹窗配方与 ExitConfirmDialog 同一份：遮罩 --overlay + 10px 模糊、盒子 --card /
 * --radius-3xl / --shadow-lg、按钮走全局 button.primary。
 */
import { onMounted, onUnmounted } from 'vue';
import { useI18n } from '../i18n/index.ts';
import { useWhatsNew } from '../composables/useWhatsNew';
import { onMarkdownContentClick } from '../utils/markdownLinks';

const { t } = useI18n();
const { payload, visible, notesHtml, close } = useWhatsNew();

/** Esc 关闭（App 级常挂组件，随挂载注册） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape' && visible.value) close();
}
onMounted(() => window.addEventListener('keydown', onKeydown));
onUnmounted(() => window.removeEventListener('keydown', onKeydown));
</script>

<template>
  <div v-if="visible" class="wn-overlay" role="dialog" aria-modal="true" @click.self="close">
    <div class="wn-box">
      <div class="wn-head">
        <div class="wn-tt">
          <span class="wn-title">{{ t('settings.update.whatsNewTitle', { version: payload?.version ?? '' }) }}</span>
          <span class="wn-sub">{{ t('settings.update.whatsNewSubtitle') }}</span>
        </div>
        <button class="wn-close" :aria-label="t('settings.update.whatsNewClose')" @click="close">✕</button>
      </div>
      <div class="wn-notes" v-html="notesHtml" @click="onMarkdownContentClick"></div>
      <div class="wn-actions">
        <button class="primary" @click="close">{{ t('settings.update.whatsNewStart') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.wn-overlay {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: var(--overlay);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--transition-base);
}

.wn-box {
  width: 460px;
  max-width: calc(100vw - 48px);
  max-height: 80vh;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-lg);
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 14px;
  animation: fadeIn var(--transition-base);
}

.wn-head {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.wn-tt {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.wn-title {
  font-size: 15px;
  font-weight: 700;
  color: var(--foreground);
}

.wn-sub {
  font-size: 12px;
  color: var(--muted-foreground);
}

.wn-close {
  margin-left: auto;
  background: none;
  border: 0;
  color: var(--muted-foreground);
  font-size: 15px;
  line-height: 1;
  cursor: pointer;
  padding: 4px;
}

.wn-close:hover {
  color: var(--foreground);
}

/* 正文：renderMarkdown 输出（h3 分组标题 + ul 列表 + 链接）。
   overflow-x 恒隐藏：说明文字天然换行，横向滚动条只会带来无意义的角落块 */
.wn-notes {
  overflow-y: auto;
  overflow-x: hidden;
  min-height: 0;
  font-size: 13px;
  line-height: 1.7;
  color: var(--foreground);
}

.wn-notes:empty {
  display: none;
}

.wn-notes :deep(h1),
.wn-notes :deep(h2),
.wn-notes :deep(h3) {
  font-size: 13px;
  font-weight: 700;
  color: var(--brand);
  margin: 14px 0 4px;
}

.wn-notes :deep(h1:first-child),
.wn-notes :deep(h2:first-child),
.wn-notes :deep(h3:first-child) {
  margin-top: 0;
}

.wn-notes :deep(ul) {
  padding-left: 18px;
  margin: 4px 0 8px;
}

.wn-notes :deep(li) {
  margin: 3px 0;
}

.wn-notes :deep(a) {
  color: var(--brand);
  text-decoration: none;
}

.wn-notes :deep(a:hover) {
  text-decoration: underline;
}

.wn-actions {
  display: flex;
  justify-content: flex-end;
  flex-shrink: 0;
}
</style>
