<script setup lang="ts">
import { onMounted, onUnmounted, computed, ref } from 'vue';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

const props = defineProps<{
  message: string;
  type: 'success' | 'info' | 'error';
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

/**
 * 交互逻辑对齐右下角系统通知（forge-desktop/src/notifyToast.ts）：
 * 从右侧滑入 → hover 暂停倒计时、离开按剩余时间续计 → 滑出后卸载。
 * 成功/信息 4.5s 足够确认类反馈；错误 6.5s 对齐系统通知 AUTO_DISMISS_MS。
 */
const AUTO_DISMISS_MS = props.type === 'error' ? 6500 : 4500;
/** 滑出动画时长（与下方 .toast.out transition 同值），播完再回报 close 卸载 */
const EXIT_ANIMATION_MS = 420;

const leaving = ref(false);
let timer: ReturnType<typeof setTimeout> | null = null;
let remain = AUTO_DISMISS_MS;
let last = 0;

function startCountdown(): void {
  last = Date.now();
  timer = setTimeout(dismiss, remain);
}
function stopCountdown(): void {
  if (timer === null) return;
  clearTimeout(timer);
  timer = null;
  remain -= Date.now() - last;
}
function dismiss(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  if (leaving.value) return;
  leaving.value = true;
  setTimeout(() => emit('close'), EXIT_ANIMATION_MS);
}

onMounted(() => {
  startCountdown();
});

onUnmounted(() => {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
});

// 长消息含全角冒号时拆为 label+value 富文本，模型名等关键值一眼可辨；
// 仅短值（≤32 字符）走该形态，长错误说明回落为普通文本，避免被行数截断
const parsed = computed(() => {
  const m = props.message;
  const idx = m.indexOf('：');
  if (idx > -1 && m.length > 20) {
    const value = m.slice(idx + 1);
    if (value.length <= 32) return { label: m.slice(0, idx), value };
  }
  return { label: null as string | null, value: m };
});
</script>

<template>
  <div
    class="toast"
    :class="[type, { out: leaving }]"
    role="status"
    aria-live="polite"
    @mouseenter="stopCountdown"
    @mouseleave="!leaving && startCountdown()"
  >
    <!-- 顶部品牌渐变细线：错误态染红，对齐系统通知的 error 红线 -->
    <span class="toast-accent" aria-hidden="true"></span>

    <div class="toast-head">
      <span class="toast-app" aria-hidden="true">Forge</span>
      <button
        class="ghost toast-close"
        :aria-label="t('common.close')"
        @click="dismiss"
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">
          <path d="M6 6l12 12M18 6L6 18" />
        </svg>
      </button>
    </div>

    <div class="toast-body">
      <span v-if="parsed.label" class="toast-label">{{ parsed.label }}</span>
      <span class="toast-message" :class="{ 'is-split': !!parsed.label }">
        <template v-if="parsed.label">
          <span class="toast-sep">：</span><span class="toast-value">{{ parsed.value }}</span>
        </template>
        <template v-else>{{ parsed.value }}</template>
      </span>
    </div>
  </div>
</template>

<style scoped>
/* 容器：右下角固定（对齐系统通知 EDGE_MARGIN=16px、宽 384px），右侧滑入滑出 */
.toast {
  position: fixed;
  right: 16px;
  bottom: 16px;
  z-index: 9999;
  width: 384px;
  max-width: calc(100vw - 32px);
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 10px 12px 14px;
  background: color-mix(in oklab, var(--card) 92%, transparent);
  backdrop-filter: blur(18px) saturate(1.35);
  -webkit-backdrop-filter: blur(18px) saturate(1.35);
  border: 1px solid color-mix(in oklab, var(--border) 80%, transparent);
  border-radius: 8px;
  box-shadow:
    0 14px 36px oklch(0 0 0 / 10%),
    0 3px 10px oklch(0 0 0 / 6%),
    inset 0 1px 0 color-mix(in oklab, white 55%, transparent);
  font-size: 13px;
  color: var(--foreground);
  overflow: hidden;
  animation: toastIn 420ms cubic-bezier(0.22, 1, 0.36, 1);
}

/* 滑出：与系统通知同款位移与缓动，播完由脚本回报 close 卸载 */
.toast.out {
  transform: translateX(calc(100% + 24px));
  opacity: 0;
  pointer-events: none;
  transition: transform 420ms cubic-bezier(0.22, 1, 0.36, 1), opacity 320ms cubic-bezier(0.4, 0, 0.2, 1);
}

:root[data-theme='dark'] .toast {
  background: color-mix(in oklab, var(--card) 92%, transparent);
  border-color: color-mix(in oklab, var(--border) 92%, transparent);
  box-shadow:
    0 20px 48px oklch(0 0 0 / 32%),
    0 6px 16px oklch(0 0 0 / 22%),
    inset 0 1px 0 color-mix(in oklab, white 7%, transparent);
}

/* 顶部品牌渐变细线：全类型统一中性品牌+暖琥珀；错误态染红对齐系统通知 */
.toast-accent {
  position: absolute;
  left: 0;
  right: 0;
  top: 0;
  height: 2px;
  background: linear-gradient(90deg,
    transparent 0%,
    color-mix(in oklab, var(--brand) 14%, transparent) 22%,
    color-mix(in oklab, var(--brand) 18%, var(--logo-gradient-accent) 14%) 50%,
    color-mix(in oklab, var(--brand) 14%, transparent) 78%,
    transparent 100%);
  opacity: 0.85;
}
.toast.error .toast-accent {
  background: linear-gradient(90deg, transparent 0%, color-mix(in oklab, var(--destructive) 22%, transparent) 24%, color-mix(in oklab, var(--destructive) 14%, var(--brand) 86%) 50%, transparent 100%);
}

/* 头部：应用名 + hover 浮现的关闭钮（对齐系统通知的头部结构与交互） */
.toast-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
}
.toast-app {
  font-size: 12px;
  color: var(--muted-foreground);
}
.toast-close {
  margin-left: auto;
  width: 26px;
  height: 26px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--muted-foreground);
  opacity: 0;
  transition: opacity 140ms ease, background var(--transition-fast), color var(--transition-fast);
}
.toast:hover .toast-close,
.toast-close:focus-visible {
  opacity: 1;
}
.toast-close:hover {
  background: color-mix(in oklab, var(--muted) 70%, transparent);
  color: var(--foreground);
}
.toast-close svg {
  width: 14px;
  height: 14px;
}

/* 文案：label 11/ muted + value 单行 inline，模型名突出；普通长文本最多 3 行截断
  （对齐系统通知正文的 3 行 clamp），拆分形态保持单行省略 */
.toast-body {
  min-width: 0;
  display: flex;
  align-items: baseline;
  flex-direction: row;
  gap: 4px;
  line-height: 1.5;
}
.toast-label {
  flex: none;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  color: var(--muted-foreground);
  white-space: nowrap;
}
.toast-message {
  min-width: 0;
  font-size: 13.4px;
  font-weight: 500;
  color: var(--foreground);
  white-space: normal;
  overflow-wrap: anywhere;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.toast-message.is-split {
  display: flex;
  align-items: baseline;
  gap: 0;
  flex-wrap: nowrap;
  -webkit-line-clamp: unset;
}
.toast-sep {
  color: var(--muted-foreground);
  margin-right: 1px;
}
.toast-value {
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--foreground);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}

@keyframes toastIn {
  from {
    transform: translateX(calc(100% + 24px));
    opacity: 0;
    filter: blur(6px);
  }
  to {
    transform: translateX(0);
    opacity: 1;
    filter: blur(0);
  }
}
</style>
