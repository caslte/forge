<script setup lang="ts">
/**
 * 项目信任询问弹窗（P2-A）。
 *
 * 打开含项目资源（.pi 项目配置 / .agents/skills）的项目且权威信任未定时弹出：
 * - 信任：写入 pi 信任存储（持久），后续不再询问
 * - 信任一次：本次可用，下次打开重新询问
 * - 拒绝：不加载项目资源，基础会话仍可用
 */
import { ref } from 'vue';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  /** 项目路径 */
  projectPath: string;
  /** 项目显示名 */
  projectName: string;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'decide', decision: 'trust' | 'reject' | 'trustOnce'): void;
}>();

const deciding = ref(false);

function choose(decision: 'trust' | 'reject' | 'trustOnce'): void {
  if (deciding.value) return;
  deciding.value = true;
  emit('decide', decision);
}
</script>

<template>
  <div class="trust-overlay">
    <div class="trust-dialog" role="dialog" aria-modal="true" aria-labelledby="trust-title">
      <div class="trust-icon" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </div>
      <h3 id="trust-title" class="trust-title">{{ t('dialogs.trustAsk.title') }}</h3>
      <p class="trust-path">{{ projectName }}</p>
      <p class="trust-desc">{{ t('dialogs.trustAsk.desc') }}</p>
      <div class="trust-actions">
        <button class="t-btn t-primary" :disabled="deciding" @click="choose('trust')">{{ t('dialogs.trustAsk.trust') }}</button>
        <button class="t-btn" :disabled="deciding" @click="choose('trustOnce')">{{ t('dialogs.trustAsk.trustOnce') }}</button>
        <button class="t-btn" :disabled="deciding" @click="choose('reject')">{{ t('dialogs.trustAsk.reject') }}</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.trust-overlay {
  position: fixed;
  inset: 0;
  z-index: 4000;
  background: color-mix(in oklab, var(--background) 55%, transparent);
  backdrop-filter: blur(4px);
  display: grid;
  place-items: center;
}

.trust-dialog {
  width: min(420px, 86vw);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-2xl);
  padding: 26px 28px;
  box-shadow: var(--shadow-lg);
  animation: trust-in 0.2s ease-out;
}

@keyframes trust-in {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: translateY(0) scale(1); }
}

.trust-icon {
  width: 44px;
  height: 44px;
  margin-bottom: 14px;
  display: grid;
  place-items: center;
  border-radius: var(--radius-xl);
  background: color-mix(in oklab, var(--brand) 12%, transparent);
  color: var(--brand);
}
.trust-icon svg { width: 22px; height: 22px; }

.trust-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--foreground);
  margin-bottom: 4px;
}

.trust-path {
  font-size: 12px;
  color: var(--muted-foreground);
  font-family: var(--font-mono);
  word-break: break-all;
  margin-bottom: 12px;
}

.trust-desc {
  font-size: 12.5px;
  line-height: 1.6;
  color: var(--muted-foreground);
  margin-bottom: 20px;
}

.trust-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
}

.t-btn {
  padding: 7px 16px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  font-size: 12.5px;
  font-weight: 500;
  cursor: pointer;
}
.t-btn:hover:not(:disabled) {
  border-color: var(--brand);
  color: var(--brand);
}
.t-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.t-primary {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--brand-foreground);
}
.t-primary:hover:not(:disabled) {
  background: var(--brand-hover);
  color: var(--brand-foreground);
  border-color: var(--brand-hover);
}
</style>