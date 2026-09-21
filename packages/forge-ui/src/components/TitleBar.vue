<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

/**
 * 一体化壳层（prototypes/unified-shell-full.html）：本组件退化为「右列顶栏」——
 * 只保留拖拽区与窗口三键。LOGO/侧栏 toggle 已上提到 App.vue 成为窗口级悬浮元素
 * （折叠时侧栏从按钮底下抽走，按钮零位移）；traffic lights 落在侧栏列顶行上方，
 * mac 让位由 App.vue 的 shell-toggle-mac 处理，本栏不再需要左内边距。
 */
const emit = defineEmits<{
  (e: 'request-exit'): void;
}>();

const isMaximized = ref(false);

const isMac = window.forge?.platform === 'darwin';

async function refreshMaximized(): Promise<void> {
  try {
    isMaximized.value = await window.forge.window.isMaximized();
  } catch {
    // dev 浏览器模式无 window 控制
  }
}

function onToggleMaximize(): void {
  window.forge.window.toggleMaximize();
  setTimeout(refreshMaximized, 50);
}

function onMinimize(): void {
  window.forge.window.minimize();
}

onMounted(() => {
  void refreshMaximized();
});

onUnmounted(() => {
  // noop
});
</script>

<template>
  <header class="titlebar">
    <div class="titlebar-spacer"></div>

    <div v-if="!isMac" class="titlebar-controls">
      <button class="titlebar-btn minimize" aria-label="最小化" @click="onMinimize">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M2 5h6" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>
      </button>
      <button class="titlebar-btn maximize" :aria-label="isMaximized ? '还原' : '最大化'" @click="onToggleMaximize">
        <svg v-if="isMaximized" width="10" height="10" viewBox="0 0 10 10">
          <rect x="2.5" y="0.5" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none"/>
          <rect x="0.5" y="2.5" width="6" height="6" stroke="currentColor" stroke-width="1" fill="none"/>
        </svg>
        <svg v-else width="10" height="10" viewBox="0 0 10 10">
          <rect x="1.5" y="1.5" width="7" height="7" stroke="currentColor" stroke-width="1" fill="none"/>
        </svg>
      </button>
      <button class="titlebar-btn close" aria-label="关闭" @click="emit('request-exit')">
        <svg width="10" height="10" viewBox="0 0 10 10"><path d="M1.5 1.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1" stroke-linecap="square"/></svg>
      </button>
    </div>
  </header>
</template>

<style scoped>
.titlebar {
  height: 36px;
  min-height: 36px;
  display: flex;
  align-items: center;
  width: 100%;
  /* 同底色一体化：透明让整窗反光层与窗口底色直接透出，与侧栏顶行无缝衔接 */
  background: transparent;
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  position: relative;
  z-index: 200;
}

.titlebar-spacer {
  flex: 1;
}

.titlebar-controls {
  display: flex;
  align-items: stretch;
  height: 100%;
  margin-left: auto;
  -webkit-app-region: no-drag;
}

.titlebar-btn {
  width: 46px;
  height: 100%;
  border: none;
  border-radius: 0;
  background: transparent;
  color: var(--muted-foreground);
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.titlebar-btn:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
  color: var(--foreground);
  border-color: transparent;
}

.titlebar-btn.close:hover {
  background: #e81123;
  color: #fff;
}

.titlebar-btn:disabled {
  opacity: 0.3;
  cursor: default;
}
</style>
