<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import type { ThemeMode } from '../types';

defineProps<{
  sidebarCollapsed: boolean;
  themeMode: ThemeMode;
}>();

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
  (e: 'toggle-theme'): void;
  (e: 'open-settings'): void;
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
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <template v-if="sidebarCollapsed">
          <rect x="3" y="4" width="18" height="16" rx="2" opacity="0.3" stroke="none" />
          <path d="M9 4v16M15 8l4 4-4 4" />
        </template>
        <template v-else>
          <rect x="3" y="4" width="18" height="16" rx="2" opacity="0.3" stroke="none" />
          <path d="M9 4v16M15 8l-4 4 4 4" />
        </template>
      </svg>
    </button>

    <button
      class="titlebar-icon-btn"
      data-tooltip="切换主题"
      @click="emit('toggle-theme')"
    >
      <svg v-if="themeMode === 'light'" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>
      <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="5" />
        <line x1="12" y1="1" x2="12" y2="3" />
        <line x1="12" y1="21" x2="12" y2="23" />
        <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
        <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
        <line x1="1" y1="12" x2="3" y2="12" />
        <line x1="21" y1="12" x2="23" y2="12" />
        <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
        <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
      </svg>
    </button>

    <button
      class="titlebar-icon-btn"
      data-tooltip="设置"
      @click="emit('open-settings')"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
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
  border-bottom: 1px solid var(--border);
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
  background: transparent;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  margin-right: 4px;
}

.titlebar-toggle svg,
.titlebar-icon-btn svg {
  width: 16px;
  height: 16px;
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
