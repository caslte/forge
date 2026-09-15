<script setup lang="ts">
/**
 * 启动欢迎页（v3.76）：bootReady 门闩期间唯一可见界面。
 *
 * 硬约束：本组件在主进程 forge-core（含 pi SDK）组装完成期间显示，此时渲染进程
 * 主线程是唯一空闲资源——严禁在此 import renderMarkdown/hljs 等重模块或发任何
 * forge:invoke 请求（invoke handler 尚未注册）。样式与 App 底色 #f6f8fa 对齐。
 */
import { ref, onMounted, onUnmounted } from 'vue';

/**
 * 轮换文案：纯前端节奏，与主进程进度无关联（避免虚假进度条）。
 * v3.78：预热（pi 扩展加载，4.4~6s 同步冻结主进程）挪进了欢迎页窗口期，
 * 欢迎页常态时长从 ~2.7s 变 4~7s——轮换节奏放慢到 1600ms、档位加到四档，
 * 覆盖预热窗口；最后一档如实告知「还需几秒」，不承诺精确进度。
 */
const PHASES = [
  '正在准备运行环境',
  '正在加载 AI 引擎',
  '正在准备会话引擎',
  '马上就好，可能还需几秒',
] as const;
const phaseIndex = ref(0);
let timer: ReturnType<typeof setInterval> | null = null;

onMounted(() => {
  timer = setInterval(() => {
    if (phaseIndex.value < PHASES.length - 1) phaseIndex.value += 1;
  }, 1600);
});
onUnmounted(() => {
  if (timer !== null) clearInterval(timer);
});
</script>

<template>
  <div class="boot-welcome">
    <div class="boot-logo" aria-hidden="true">
      <svg viewBox="0 0 48 48" width="56" height="56">
        <rect x="4" y="4" width="40" height="40" rx="10" fill="#2563eb" />
        <path
          d="M15 33V15h13M15 24h10"
          stroke="#fff"
          stroke-width="4"
          stroke-linecap="round"
          fill="none"
        />
      </svg>
    </div>
    <div class="boot-name">Forge</div>
    <div class="boot-spinner" role="status" aria-label="加载中" />
    <div class="boot-phase">{{ PHASES[phaseIndex] }}…</div>
  </div>
</template>

<style scoped>
.boot-welcome {
  height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 14px;
  background: #f6f8fa;
  user-select: none;
}
.boot-logo {
  animation: boot-fade-in 0.4s ease-out;
}
.boot-name {
  font-size: 22px;
  font-weight: 700;
  color: #1f2328;
  letter-spacing: 0.5px;
}
.boot-spinner {
  width: 22px;
  height: 22px;
  border: 3px solid #dbe3ea;
  border-top-color: #2563eb;
  border-radius: 50%;
  animation: boot-spin 0.9s linear infinite;
}
.boot-phase {
  font-size: 13px;
  color: #57606a;
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
