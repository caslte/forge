<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

defineProps<{
  sidebarCollapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
  (e: 'request-exit'): void;
}>();

const isMaximized = ref(false);

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
    <button
      class="titlebar-toggle"
      :aria-label="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
      :data-tooltip="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
      @click="emit('toggle-sidebar')"
    >
      <!-- SM-S07：默认显方形 LOGO 瓷片，hover 交叉淡入为缩放图标，点击行为不变 -->
      <span class="tb-logo" aria-hidden="true">F</span>
      <span class="tb-panel" aria-hidden="true">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <template v-if="sidebarCollapsed">
            <!-- 已折叠：面板描边+分隔线在右，箭头朝右=点击展开 -->
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M15 4v16" />
            <path d="m8 15 3-3-3-3" />
          </template>
          <template v-else>
            <!-- 展开中：面板描边+分隔线在左，箭头朝左=点击折叠 -->
            <rect x="3" y="4" width="18" height="16" rx="2.5" />
            <path d="M9 4v16" />
            <path d="m16 15-3-3 3-3" />
          </template>
        </svg>
      </span>
    </button>

    <div class="titlebar-spacer"></div>

    <div class="titlebar-controls">
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
  background: var(--background);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  position: relative;
  z-index: 200;
  padding-left: 8px;
}

.titlebar-toggle,
.titlebar-icon-btn {
  -webkit-app-region: no-drag;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0; /* 覆盖 global.css button 的 padding:6px 14px，避免挤压内部图标 */
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  margin-right: 4px;
}

/* LOGO 瓷片（SM-S07）：默认态；hover 让位于缩放图标 */
.titlebar-toggle {
  position: relative;
}

.tb-logo {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 5px;
  background: linear-gradient(135deg, var(--logo-gradient-accent) 0%, color-mix(in oklab, var(--logo-gradient-accent) 55%, oklch(0.6 0.12 60)) 100%);
  color: oklch(0.22 0.01 286.3);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  font-weight: 800;
  line-height: 1;
  box-shadow: inset 0 0 0 1px oklch(1 0 0 / 14%);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.tb-panel {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  opacity: 0;
  transform: scale(0.85);
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.titlebar-toggle:hover .tb-logo {
  opacity: 0;
  transform: scale(0.85);
}

.titlebar-toggle:hover .tb-panel {
  opacity: 1;
  transform: scale(1);
  color: var(--foreground);
}

.titlebar-toggle svg,
.titlebar-icon-btn svg {
  width: 16px;
  height: 16px;
}

.titlebar-toggle svg {
  width: 18px;
  height: 18px;
}

.titlebar-toggle:hover,
.titlebar-icon-btn:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
  color: var(--foreground);
  border-color: transparent;
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
