<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';
import logoMain from '../assets/logo-main.png';

defineProps<{
  sidebarCollapsed: boolean;
}>();

const emit = defineEmits<{
  (e: 'toggle-sidebar'): void;
  (e: 'request-exit'): void;
}>();

const isMaximized = ref(false);

/**
 * macOS：窗口三键由系统 traffic lights 提供（主进程 titleBarStyle:'hidden' +
 * trafficLightPosition），自定义最小化/最大化/关闭按钮隐藏；标题栏左端为灯让位，
 * 避免 LOGO 折叠按钮压在灯下。红键=关窗（进程驻留 Dock，activate 重建窗口，见
 * forge-desktop main.ts），Cmd+Q 退出——遵循 macOS 惯例，不走 Windows 的退出确认框。
 * preload 未注入（纯浏览器无 mock）时按非 mac 处理。
 */
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
  <header class="titlebar" :class="{ 'titlebar-mac': isMac }">
    <button
      class="titlebar-toggle"
      :aria-label="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
      :data-tooltip="sidebarCollapsed ? '展开侧边栏' : '折叠侧边栏'"
      @click="emit('toggle-sidebar')"
    >
      <!-- SM-S07：默认显品牌 LOGO（锤子与铁砧切图），hover 交叉淡入为缩放图标，点击行为不变 -->
      <img class="tb-logo" :src="logoMain" alt="" aria-hidden="true" draggable="false" />
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
  background: var(--background);
  -webkit-app-region: drag;
  user-select: none;
  flex-shrink: 0;
  position: relative;
  z-index: 200;
  padding-left: 8px;
}

/* macOS：traffic lights 画在 (12, 12)、三灯总宽约 52px（至 x≈64），左端内容整体让位到
   78px，LOGO 折叠按钮落在灯右侧，拖拽区与交互不变（见主进程 trafficLightPosition） */
.titlebar-mac {
  padding-left: 78px;
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

/* LOGO 切图（SM-S07）：默认态；hover 让位于缩放图标 */
.titlebar-toggle {
  position: relative;
}

.tb-logo {
  position: absolute;
  inset: 0;
  margin: auto;
  width: 24px;
  height: 24px;
  object-fit: contain;
  pointer-events: none;
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
