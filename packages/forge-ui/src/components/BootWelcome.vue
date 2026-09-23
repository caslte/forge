<script setup lang="ts">
/**
 * 启动欢迎页（v3.76）：bootReady 门闩期间唯一可见界面。
 *
 * 硬约束：本组件在主进程 forge-core（含 pi SDK）组装完成期间显示，此时渲染进程
 * 主线程是唯一空闲资源——严禁在此 import renderMarkdown/hljs 等重模块或发任何
 * forge:invoke 请求（invoke handler 尚未注册）。样式与 App 底色 #f6f8fa 对齐。
 */
import { ref, computed, onMounted, onUnmounted } from 'vue';
import logoMain from '../assets/logo-main.png';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

/**
 * 轮换文案：纯前端节奏，与主进程进度无关联（避免虚假进度条）。
 * v3.78：预热（pi 扩展加载，4.4~6s 同步冻结主进程）挪进了欢迎页窗口期，
 * 欢迎页常态时长从 ~2.7s 变 4~7s——轮换节奏放慢到 1600ms、档位加到四档，
 * 覆盖预热窗口；最后一档如实告知「还需几秒」，不承诺精确进度。
 */
const PHASES = computed(() => [
  t('app.bootPhasePrepareEnv'),
  t('app.bootPhaseLoadEngine'),
  t('app.bootPhaseSessionEngine'),
  t('app.bootPhaseAlmostReady'),
]);
const phaseIndex = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => {
    if (phaseIndex.value < PHASES.value.length - 1) phaseIndex.value += 1;
  }, 1600);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});
</script>

<template>
  <div class="boot-welcome">
    <div class="boot-logo" aria-hidden="true">
      <img class="boot-logo-img" :src="logoMain" alt="" draggable="false" />
    </div>
    <div class="boot-name">Forge</div>
    <div class="boot-spinner" role="status" :aria-label="t('app.bootLoading')" />
    <div class="boot-phase">{{ PHASES[phaseIndex] }}…</div>
  </div>
</template>

<style scoped>
.boot-welcome {
  height: 100vh;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: var(--background);
  user-select: none;
}
.boot-logo {
  animation: boot-fade-in 0.4s ease-out;
}
.boot-logo-img {
  display: block;
  width: 64px;
  height: 64px;
  object-fit: contain;
  user-select: none;
}
.boot-name {
  font-size: 22px;
  font-weight: 700;
  color: var(--foreground);
  letter-spacing: 0.5px;
}
.boot-spinner {
  width: 22px;
  height: 22px;
  border: 3px solid var(--border);
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: boot-spin 0.9s linear infinite;
}
.boot-phase {
  font-size: 13px;
  color: var(--muted-foreground);
  min-height: 1.4em; /* 文案轮换时高度稳定，不跳动 */
}
@keyframes boot-spin {
  to {
    transform: rotate(360deg);
  }
}
@keyframes boot-fade-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
</style>
