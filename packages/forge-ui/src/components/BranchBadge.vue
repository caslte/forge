<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted, computed, nextTick } from 'vue';
import type { GitBranchInfo } from '../types';
import { filterBranches, shouldAskConfirm, displayBranch } from '../utils/branchBadge';
import { openGitCommitDialog } from '../composables/useGitCommitDialog';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

/**
 * 分支徽标与切换浮窗（PM-S05，AC-PM-013/014/016/017，docs/api/01_project.md §10/§11）。
 * 非 git 项目整体不渲染（isGitRepo=false）；busy 时禁用（会话执行中，AC-PM-016）。
 * 6001 切换失败：浮窗内展示 git 原始 stderr，浮窗不关、分支不变（AC-PM-017）。
 */
const props = defineProps<{
  /** 项目规范化路径（git 查询目标） */
  projectPath: string;
  /** 忙（当前会话自身 streaming）：禁用徽标；同项目其他会话执行中不锁（2026-09-23 口径修正） */
  busy: boolean;
  /** 项目显示名（GC-S11「提交或推送…」入口透传给弹窗副标题） */
  projectName?: string;
  /** 会话 id（GC-S11：AI 生成提交说明的模型上下文） */
  sessionId?: string;
}>();

const info = ref<GitBranchInfo | null>(null);
/** isGitRepo 变化外抛（GC-S11）：宿主据此决定「提交或推送」状态行入口是否渲染 */
const emit = defineEmits<{
  (e: 'git-repo', isGit: boolean): void;
}>();
const panelOpen = ref(false);
const query = ref('');
const confirming = ref(false);
const pendingBranch = ref('');
const stderr = ref<string | null>(null);
const rootRef = ref<HTMLElement | null>(null);
const filterRef = ref<HTMLInputElement | null>(null);

const currentLabel = computed(() => (info.value ? displayBranch(info.value) : null));
const filtered = computed(() =>
  info.value ? filterBranches(info.value.branches, query.value) : [],
);

async function refresh(): Promise<void> {
  try {
    const r = await window.forge.invoke('git/getBranchInfo', { path: props.projectPath });
    // 仅成功时更新 info；失败（1002/5000/网络）保留旧值，避免一过性错误让徽标闪烁消失
    if (r.code === 0 && r.data) {
      const data = r.data as GitBranchInfo;
      info.value = data;
      emit('git-repo', data.isGitRepo);
    }
  } catch {
    // 静默：保留旧 info
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
/** 开浮窗前保存的焦点元素，关闭后还原到输入框 */
let savedFocus: HTMLElement | null = null;
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
  // 还原开浮窗前的焦点（点击 git-pill 后焦点被按钮抢走，关闭后需还回输入框）
  if (savedFocus && document.contains(savedFocus)) {
    savedFocus.focus();
  }
  savedFocus = null;
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
  // 记录开浮窗前的焦点，关闭时还原
  savedFocus = (document.activeElement as HTMLElement | null) ?? null;
  query.value = '';
  stderr.value = null;
  panelOpen.value = true;
  // 打开即聚焦过滤框，可直接输入
  void nextTick(() => filterRef.value?.focus());
}

/** 浮窗内「提交或推送…」（GC-S11 第二入口）：先关浮窗还原焦点，再开弹窗 */
function onCommitEntry(): void {
  if (props.busy) return;
  const path = props.projectPath;
  const name = props.projectName;
  const sid = props.sessionId;
  closePanel();
  openGitCommitDialog({ projectPath: path, projectName: name, sessionId: sid });
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
      :data-tooltip="busy ? t('project.sessionBusy') : t('project.switchBranch')"
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

    <!-- 分支切换浮窗：向上弹出，参照 slash-menu 定位风格。
         注意不可加 @mousedown.prevent，否则会吞掉输入框聚焦的默认行为导致无法输入 -->
    <div v-if="panelOpen" class="git-panel">
      <template v-if="!confirming">
        <input
          ref="filterRef"
          v-model="query"
          class="git-filter"
          type="text"
          :placeholder="t('project.filterBranches')"
          spellcheck="false"
        />
        <div v-if="filtered.length === 0" class="git-empty">{{ t('project.noOtherBranches') }}</div>
        <button
          v-for="b in filtered"
          :key="b"
          type="button"
          class="git-item"
          :class="{ active: b === info?.branch }"
          @click="pickBranch(b)"
        >
          <span>{{ b }}</span>
          <span v-if="b === info?.branch" class="git-current">{{ t('project.current') }}</span>
        </button>
        <div class="git-sep"></div>
        <button type="button" class="git-item git-commit-entry" @click="onCommitEntry">
          <span class="git-commit-main">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <circle cx="12" cy="12" r="4" />
              <line x1="12" y1="2" x2="12" y2="8" />
              <line x1="12" y1="16" x2="12" y2="22" />
            </svg>
            <span>{{ t('git.branchEntry') }}</span>
          </span>
        </button>
        <div v-if="stderr" class="git-stderr">{{ stderr }}</div>
      </template>
      <template v-else>
        <div class="menu-hint">{{ t('project.confirmSwitchBranch') }}</div>
        <div class="git-confirm-desc">
          {{ t('project.dirtySwitchWarning') }}
        </div>
        <div class="git-confirm-actions">
          <button type="button" class="git-btn" @click="closePanel">{{ t('common.cancel') }}</button>
          <button type="button" class="git-btn git-btn-danger" @click="doSwitch(pendingBranch)">{{ t('project.switchAnyway') }}</button>
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

/* 与项目 pill 同排、去掉边框/背景/圆角，与其“提示性徽标”语义一致（UX 调整）。
   图标与文字顶部对齐：inline 默认基线对齐会让 13px 图标顶部高出文字（视觉不对齐） */
.git-pill {
  display: inline-flex;
  align-items: flex-start;
  gap: 2px;
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

/* 分支列表与「提交或推送…」入口之间的分隔（GC-S11 第二入口） */
.git-sep {
  height: 1px;
  margin: 4px 6px;
  background: var(--border);
}

.git-commit-main {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  color: var(--muted-foreground);
}

.git-commit-entry:hover .git-commit-main {
  color: var(--foreground);
}

.git-commit-main svg {
  width: 13px;
  height: 13px;
  flex-shrink: 0;
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
  justify-content: center;
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
