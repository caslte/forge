<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed } from 'vue';
import type { GitBranchInfo } from '../types';
import { filterBranches, shouldAskConfirm, displayBranch } from '../utils/branchBadge';

/**
 * 分支徽标与切换浮窗（PM-S05，AC-PM-013/014/016/017，docs/api/01_project.md §10/§11）。
 * 非 git 项目整体不渲染（isGitRepo=false）；busy 时禁用（会话执行中，AC-PM-016）。
 * 6001 切换失败：浮窗内展示 git 原始 stderr，浮窗不关、分支不变（AC-PM-017）。
 */
const props = defineProps<{
  /** 项目规范化路径（git 查询目标） */
  projectPath: string;
  /** 项目忙（任一会话 streaming）：禁用徽标 */
  busy: boolean;
}>();

const info = ref<GitBranchInfo | null>(null);
const panelOpen = ref(false);
const query = ref('');
const confirming = ref(false);
const pendingBranch = ref('');
const stderr = ref<string | null>(null);
const rootRef = ref<HTMLElement | null>(null);

const currentLabel = computed(() => (info.value ? displayBranch(info.value) : null));
const filtered = computed(() =>
  info.value ? filterBranches(info.value.branches, query.value) : [],
);

async function refresh(): Promise<void> {
  try {
    info.value = await window.forge
      .invoke('git/getBranchInfo', { path: props.projectPath })
      .then((r) => (r.code === 0 ? (r.data as GitBranchInfo) : null));
  } catch {
    info.value = null;
  }
}

watch(
  () => props.projectPath,
  () => {
    panelOpen.value = false;
    stderr.value = null;
    void refresh();
  },
);

let unsub: (() => void) | null = null;
function onFocus(): void {
  void refresh();
}
function onDocMouseDown(e: MouseEvent): void {
  const el = e.target as HTMLElement | null;
  if (el && typeof el.closest === 'function' && el.closest('.git-badge')) return;
  closePanel();
}
function onDocKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') closePanel();
}
function closePanel(): void {
  panelOpen.value = false;
  confirming.value = false;
  stderr.value = null;
}

onMounted(() => {
  void refresh();
  unsub = window.forge.on('git.branchChanged', (payload) => {
    const p = payload as { path?: string } | null;
    if (p?.path === props.projectPath) void refresh();
  });
  // AC-PM-023：窗口聚焦重查（外部 git 操作后回来刷新）
  window.addEventListener('focus', onFocus);
  document.addEventListener('mousedown', onDocMouseDown);
  document.addEventListener('keydown', onDocKeydown);
});
onUnmounted(() => {
  unsub?.();
  window.removeEventListener('focus', onFocus);
  document.removeEventListener('mousedown', onDocMouseDown);
  document.removeEventListener('keydown', onDocKeydown);
});

function togglePanel(): void {
  if (props.busy) return; // AC-PM-016：忙时点击无效
  if (panelOpen.value) {
    closePanel();
    return;
  }
  query.value = '';
  stderr.value = null;
  panelOpen.value = true;
}

/** 点选分支：dirty 且目标≠当前先确认；6001 时浮窗内展示 stderr、浮窗不关 */
async function pickBranch(branch: string): Promise<void> {
  if (!info.value) return;
  if (shouldAskConfirm(info.value.dirty, branch, info.value.branch)) {
    pendingBranch.value = branch;
    confirming.value = true;
    return;
  }
  await doSwitch(branch);
}

async function doSwitch(branch: string): Promise<void> {
  const res = await window.forge.invoke('git/switchBranch', {
    path: props.projectPath,
    branch,
  });
  if (res.code === 6001) {
    const d = res.data as { stderr?: string } | null;
    stderr.value = d?.stderr ?? res.message;
    confirming.value = false;
    return; // 浮窗不关、分支不变
  }
  confirming.value = false;
  stderr.value = null;
  closePanel();
  void refresh(); // 事件也会驱动刷新，此处立即回显
}
</script>

<template>
  <div v-if="currentLabel" ref="rootRef" class="git-badge">
    <button
      type="button"
      class="meta-link git-pill"
      :class="{ 'is-busy': busy }"
      :data-tooltip="busy ? '会话执行中' : '切换分支'"
      :aria-disabled="busy"
      @click="togglePanel"
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="6" y1="3" x2="6" y2="15" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <path d="M18 9a9 9 0 0 1-9 9" />
      </svg>
      <span class="git-pill-name">{{ currentLabel }}</span>
    </button>

    <!-- 分支切换浮窗：向上弹出，参照 slash-menu 定位风格 -->
    <div v-if="panelOpen" class="git-panel" @mousedown.prevent>
      <template v-if="!confirming">
        <input
          v-model="query"
          class="git-filter"
          type="text"
          placeholder="过滤分支…"
          spellcheck="false"
        />
        <div v-if="filtered.length === 0" class="git-empty">无其他分支</div>
        <button
          v-for="b in filtered"
          :key="b"
          type="button"
          class="git-item"
          :class="{ active: b === info?.branch }"
          @click="pickBranch(b)"
        >
          <span>{{ b }}</span>
          <span v-if="b === info?.branch" class="git-current">当前</span>
        </button>
        <div v-if="stderr" class="git-stderr">{{ stderr }}</div>
      </template>
      <template v-else>
        <div class="menu-hint">确认切换分支</div>
        <div class="git-confirm-desc">
          工作区有未提交更改，切换到 <b>{{ pendingBranch }}</b> 可能冲突或丢失修改。
        </div>
        <div class="git-confirm-actions">
          <button type="button" class="git-btn" @click="closePanel">取消</button>
          <button type="button" class="git-btn git-btn-danger" @click="doSwitch(pendingBranch)">仍要切换</button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.git-badge {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted-foreground);
  font-size: 12px;
  white-space: nowrap;
}

/* scoped 样式不会继承宿主（InstructionInput）的 .meta-link svg 尺寸规则，
   必须显式约束，否则 SVG 默认尺寸撑爆 compose-bar 盖住输入框（D5 集成修复） */
.git-pill svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
}

/* 与项目 pill 同排、去掉边框/背景/圆角，与其“提示性徽标”语义一致（UX 调整） */
.git-pill {
  border: none;
  background: transparent;
  padding: 4px 6px;
  border-radius: 6px;
  line-height: 1;
  font-weight: 500;
  color: inherit;
}

.git-pill:hover {
  background: var(--card);
}

/* busy 禁用态：语义对齐 .compose-input:disabled（灰置 + not-allowed） */
.git-pill.is-busy {
  opacity: 0.6;
  cursor: not-allowed;
}

.git-pill-name {
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.git-panel {
  position: absolute;
  left: 0;
  bottom: calc(100% + 10px);
  min-width: 240px;
  max-width: 320px;
  max-height: 40vh;
  overflow-y: auto;
  background: var(--popover);
  border: 1px solid var(--border);
  border-radius: 10px;
  box-shadow: var(--shadow-lg);
  padding: 4px;
  z-index: 700;
  animation: git-rise 0.15s ease both;
}

@keyframes git-rise {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.git-filter {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 4px;
  padding: 6px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--background);
  color: var(--foreground);
  font-size: 12px;
  outline: none;
}

.git-filter:focus {
  border-color: var(--brand);
}

.git-empty {
  padding: 10px;
  font-size: 12px;
  color: var(--muted-foreground);
  text-align: center;
}

.git-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}

.git-item:hover {
  background: var(--muted);
}

.git-item.active {
  background: color-mix(in oklab, var(--surface-active) 55%, transparent);
}

.git-current {
  font-size: 11px;
  color: var(--brand);
}

.git-stderr {
  margin-top: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--destructive) 10%, transparent);
  color: var(--destructive);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
}

.git-confirm-desc {
  padding: 6px 10px 10px;
  font-size: 12px;
  color: var(--foreground);
  line-height: 1.6;
  overflow-wrap: anywhere;
}

.git-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 0 10px 8px;
}

.git-btn {
  padding: 4px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  cursor: pointer;
}

.git-btn-danger {
  background: var(--destructive);
  border-color: var(--destructive);
  color: #fff;
}
</style>
