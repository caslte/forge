<script setup lang="ts">
import { ref, onMounted } from 'vue';

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'confirm', path: string): void;
}>();

const STORAGE_KEY = 'forge:recent-paths';
const MAX_RECENT = 6;

const path = ref('');
const recentPaths = ref<string[]>([]);

// 从 localStorage 读取最近路径
function loadRecent(): void {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) {
      recentPaths.value = arr
        .filter((p): p is string => typeof p === 'string' && p.length > 0)
        .slice(0, MAX_RECENT);
    }
  } catch {
    // 数据损坏忽略
  }
}

// 写入最近路径（去重、置顶、截断）
function pushRecent(p: string): void {
  const trimmed = p.trim();
  if (!trimmed) return;
  const next = [trimmed, ...recentPaths.value.filter((x) => x !== trimmed)].slice(0, MAX_RECENT);
  recentPaths.value = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // 存储失败忽略
  }
}

function onConfirm(): void {
  const p = path.value.trim();
  if (!p) return;
  pushRecent(p);
  emit('confirm', p);
}

function onPickRecent(p: string): void {
  path.value = p;
}

// 打开系统目录选择，把选中路径填入输入框
async function onBrowse(): Promise<void> {
  try {
    const dir = await window.forge.dialog.selectDirectory();
    if (dir) path.value = dir;
  } catch (e) {
    // 忽略取消/失败，保持当前输入
  }
}

onMounted(loadRecent);
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="ppd-title">
      <header class="dialog-header">
        <h2 id="ppd-title" class="dialog-title">选择项目目录</h2>
        <button class="ghost dialog-close" aria-label="关闭" @click="emit('close')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div class="dialog-body">
        <div class="path-row">
          <input
            v-model="path"
            class="path-input"
            type="text"
            placeholder="例如: D:\work\my-project"
            autofocus
            @keydown.enter.prevent="onConfirm"
          />
          <!-- 系统原生目录选择 -->
          <button class="browse-btn" type="button" title="打开系统目录选择" @click="onBrowse">浏览…</button>
        </div>
        <p class="hint">可点击「浏览…」选择目录，或手动输入路径</p>

        <div v-if="recentPaths.length" class="recent">
          <span class="recent-label">最近：</span>
          <button
            v-for="p in recentPaths"
            :key="p"
            class="chip"
            :title="p"
            @click="onPickRecent(p)"
          >{{ p }}</button>
        </div>
      </div>

      <footer class="dialog-footer">
        <button @click="emit('close')">取消</button>
        <button class="primary" :disabled="!path.trim()" @click="onConfirm">创建项目</button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  z-index: 2000;
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--transition-base);
}

.dialog {
  width: 520px;
  max-width: calc(100vw - 48px);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-lg);
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.dialog-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.dialog-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.dialog-close {
  width: 28px;
  height: 28px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.dialog-close svg {
  width: 16px;
  height: 16px;
}

.dialog-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.path-row {
  display: flex;
  gap: 8px;
}

.path-input {
  flex: 1;
  min-width: 0;
}

.browse-btn {
  flex-shrink: 0;
}

.hint {
  font-size: 12px;
  color: var(--muted-foreground);
}

.recent {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}

.recent-label {
  font-size: 12px;
  color: var(--muted-foreground);
}

.chip {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  padding: 3px 10px;
  background: var(--muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
  transition: background var(--transition-fast), color var(--transition-fast);
}

.chip:hover {
  background: var(--surface-hover);
  color: var(--foreground);
  border-color: var(--brand);
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
