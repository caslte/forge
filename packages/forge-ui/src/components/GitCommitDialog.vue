<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue';
import type { CommitData, GitStatusInfo, PushData } from '../types';
import { invokeRaw } from '../bridge';
import { useGitCommitDialog, closeGitCommitDialog } from '../composables/useGitCommitDialog';
import { useToast } from '../composables/useToast';
import { useI18n } from '../i18n/index.ts';

/**
 * 提交或推送弹窗（模块 11，GC-S11，docs/api/11_git_commit_push.md，视觉对齐
 * prototypes/terminal-git-prototype.html 定稿 demo）。
 * 全量语义：只操作整个仓库（add -A 可含未暂存），无按会话提交、无文件清单/diff 统计。
 * 失败（6006/6007/6008/5000）在弹窗内展示 git 原始 stderr 或 message，弹窗不关（AC-PM-017 同款）。
 * 加载中（working）时三按钮与关闭全部禁用，进行中的按钮换成 spinner+「提交中…/推送中…」；
 * 成功后关闭弹窗并 toast。
 */
const { t, activeLocale } = useI18n();
const { success: toastSuccess } = useToast();

const { visible, projectPath, projectName, sessionId } = useGitCommitDialog();

const info = ref<GitStatusInfo | null>(null);
const message = ref('');
const includeUnstaged = ref(true);
const generating = ref(false);
/** 进行中的写操作（提交中三按钮+关闭全禁用） */
const working = ref<null | 'commit' | 'push' | 'commit-push'>(null);
/** commit-push 的当前小阶段：驱动「提交并推送」按钮文案 提交中…→推送中… */
const phase = ref<'commit' | 'push'>('commit');
const errText = ref<string | null>(null);

const busy = computed(() => working.value !== null);
const branchLabel = computed(() => {
  const i = info.value;
  if (!i) return '…';
  if (!i.branch) return '—';
  return i.branch + (i.detached ? t('git.detachedSuffix') : '');
});
/** 提交禁用：进行中 / 状态未知 / 无变更 / 暂存空且未勾选包含未暂存 / 说明为空 */
const canCommit = computed(() => {
  const i = info.value;
  if (busy.value || !i || i.fileCount === 0) return false;
  if (i.stagedEmpty && !includeUnstaged.value) return false;
  return message.value.trim() !== '';
});
/** 推送独立可用（不依赖暂存区/说明）；detached 或分支不可解析时禁用 */
const canPush = computed(
  () => !busy.value && !!info.value?.branch && !info.value?.detached,
);
const footHint = computed(() => {
  const i = info.value;
  if (i && i.stagedEmpty && !includeUnstaged.value) return t('git.stagedEmptyTip');
  return '';
});

function stderrOf(res: { message: string; data: unknown }): string {
  const d = res.data as { stderr?: string } | null;
  return d?.stderr?.trim() ? d.stderr : res.message;
}

async function refresh(): Promise<void> {
  const res = await invokeRaw<GitStatusInfo>('git/getStatus', { path: projectPath.value });
  if (res.code === 0 && res.data) {
    info.value = res.data;
  } else {
    info.value = null;
    errText.value = res.message;
  }
}

async function doCommit(): Promise<{ ok: true; data: CommitData } | { ok: false }> {
  const res = await invokeRaw<CommitData>('git/commit', {
    path: projectPath.value,
    message: message.value.trim(),
    includeUnstaged: includeUnstaged.value,
  });
  if (res.code === 0 && res.data) return { ok: true, data: res.data };
  errText.value = stderrOf(res);
  return { ok: false };
}

async function doPush(): Promise<{ ok: true; data: PushData } | { ok: false }> {
  const res = await invokeRaw<PushData>('git/push', { path: projectPath.value });
  if (res.code === 0 && res.data) return { ok: true, data: res.data };
  errText.value = stderrOf(res);
  return { ok: false };
}

async function onCommit(): Promise<void> {
  if (!canCommit.value) return;
  working.value = 'commit';
  errText.value = null;
  try {
    const r = await doCommit();
    if (r.ok) {
      toastSuccess(t('git.toastCommitted', { hash: r.data.shortHash, count: r.data.fileCount }));
      closeGitCommitDialog();
    } else {
      await refresh();
    }
  } finally {
    working.value = null;
  }
}

async function onPush(): Promise<void> {
  if (!canPush.value) return;
  working.value = 'push';
  errText.value = null;
  try {
    const r = await doPush();
    if (r.ok) {
      toastSuccess(t('git.toastPushed', { remote: r.data.remote, branch: r.data.branch }));
      closeGitCommitDialog();
    }
  } finally {
    working.value = null;
  }
}

/** 提交并推送：成功只出一条合并 toast；提交成功但推送失败 → 弹窗不关并明示两态 */
async function onCommitPush(): Promise<void> {
  if (!canCommit.value) return;
  working.value = 'commit-push';
  phase.value = 'commit';
  errText.value = null;
  try {
    const c = await doCommit();
    if (!c.ok) {
      await refresh();
      return;
    }
    phase.value = 'push';
    const p = await doPush();
    if (p.ok) {
      toastSuccess(
        t('git.toastCommittedPushed', {
          hash: c.data.shortHash,
          count: c.data.fileCount,
          remote: p.data.remote,
          branch: p.data.branch,
        }),
      );
      closeGitCommitDialog();
    } else {
      errText.value = t('git.commitOkPushFail', { hash: c.data.shortHash }) + '\n' + (errText.value ?? '');
      await refresh();
    }
  } finally {
    working.value = null;
  }
}

async function onGenerate(): Promise<void> {
  if (busy.value || generating.value) return;
  generating.value = true;
  errText.value = null;
  try {
    const res = await invokeRaw<{ message: string }>('git/generateCommitMessage', {
      path: projectPath.value,
      ...(sessionId.value ? { sessionId: sessionId.value } : {}),
      lang: activeLocale.value === 'en' ? 'en' : 'zh',
    });
    if (res.code === 0 && res.data) {
      message.value = res.data.message;
    } else {
      errText.value = res.message;
    }
  } finally {
    generating.value = false;
  }
}

function tryClose(): void {
  if (busy.value || generating.value) return;
  closeGitCommitDialog();
}

/** 进行中按钮的进行时文案（真机反馈：只禁用不给提示像卡死）；未在该操作返 null */
function workingLabel(op: 'commit' | 'push' | 'commit-push'): string | null {
  if (working.value !== op) return null;
  if (op === 'push') return t('git.doingPush');
  if (op === 'commit') return t('git.doingCommit');
  return phase.value === 'commit' ? t('git.doingCommit') : t('git.doingPush');
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') tryClose();
}

onMounted(() => {
  document.addEventListener('keydown', onKeydown);
});
onUnmounted(() => {
  document.removeEventListener('keydown', onKeydown);
});

/* 组件常驻 App 根（v-if 在内部），onMounted 时 projectPath 还是空串——
   每次「打开」重置状态并拉取 getStatus，避免携带上一次的表单/错误 */
watch(visible, (v) => {
  if (!v) return;
  info.value = null;
  message.value = '';
  includeUnstaged.value = true;
  generating.value = false;
  working.value = null;
  phase.value = 'commit';
  errText.value = null;
  void refresh();
}, { immediate: true });
</script>

<template>
  <div v-if="visible" class="overlay" @click.self="tryClose">
    <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="git-dlg-title">
      <header class="dialog-header">
        <h2 id="git-dlg-title" class="dialog-title">{{ t('git.title') }}</h2>
        <button
          class="dialog-close"
          :aria-label="t('common.close')"
          :disabled="busy"
          @click="tryClose"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </header>

      <div class="dialog-sub">{{ t('git.subPre') }}<b>{{ projectName }}</b>{{ t('git.subPost') }}</div>

      <div class="dlg-branch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <line x1="6" y1="3" x2="6" y2="15" />
          <circle cx="18" cy="6" r="3" />
          <circle cx="6" cy="18" r="3" />
          <path d="M18 9a9 9 0 0 1-9 9" />
        </svg>
        <span>{{ branchLabel }}</span>
      </div>

      <textarea
        v-model="message"
        class="dlg-textarea"
        :placeholder="t('git.msgPlaceholder')"
        :disabled="busy"
        spellcheck="false"
      ></textarea>
      <div class="dlg-airow">
        <button type="button" class="dlg-ai" :disabled="busy || generating" @click="onGenerate">
          <span v-if="generating" class="spin"></span>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M9.937 15.5A2 2 0 0 0 8.5 14.063l-6.135-1.582a.5.5 0 0 1 0-.962L8.5 9.936A2 2 0 0 0 9.937 8.5l1.582-6.135a.5.5 0 0 1 .963 0L14.063 8.5A2 2 0 0 0 15.5 9.937l6.135 1.581a.5.5 0 0 1 0 .964L15.5 14.063a2 2 0 0 0-1.437 1.437l-1.582 6.135a.5.5 0 0 1-.963 0z" />
            <path d="M20 3v4" /><path d="M22 5h-4" /><path d="M4 17v2" /><path d="M5 18H3" />
          </svg>
          {{ t('git.aiGenerate') }}
        </button>
      </div>

      <div v-if="errText" class="dlg-stderr">{{ errText }}</div>

      <footer class="dialog-footer">
        <label class="dlg-check" :class="{ 'is-busy': busy }">
          <input v-model="includeUnstaged" type="checkbox" :disabled="busy" />
          <span class="box">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round">
              <polyline points="20 6 9 17 4 12" />
            </svg>
          </span>
          {{ t('git.includeUnstaged') }}
        </label>
        <span v-if="footHint" class="dlg-stat">{{ footHint }}</span>
        <span class="spacer"></span>
        <button type="button" :disabled="!canPush" @click="onPush">
          <span v-if="working === 'push'" class="spin" aria-hidden="true"></span>{{ workingLabel('push') ?? t('git.push') }}
        </button>
        <button type="button" :disabled="!canCommit" @click="onCommitPush">
          <span v-if="working === 'commit-push'" class="spin" aria-hidden="true"></span>{{ workingLabel('commit-push') ?? t('git.commitAndPush') }}
        </button>
        <button type="button" class="confirm-btn" :disabled="!canCommit" @click="onCommit">
          <span v-if="working === 'commit'" class="spin" aria-hidden="true"></span>{{ workingLabel('commit') ?? t('git.commit') }}
        </button>
      </footer>
    </div>
  </div>
</template>

<style scoped>
/* ExitConfirmDialog.vue 同款 overlay/dialog 骨架（460px 版），控件照 demo .dlg-* */
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

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

.dialog {
  width: 460px;
  max-width: calc(100vw - 48px);
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-3xl);
  box-shadow: var(--shadow-lg);
  padding: 22px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
  animation: dlg-rise var(--transition-base);
}

@keyframes dlg-rise {
  from { opacity: 0; transform: translateY(8px) scale(0.98); }
  to { opacity: 1; transform: none; }
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
  border: none;
  background: transparent;
  border-radius: var(--radius-sm);
  color: var(--muted-foreground);
}

.dialog-close:hover {
  background: var(--muted);
  color: var(--foreground);
}

.dialog-close svg {
  width: 16px;
  height: 16px;
}

.dialog-sub {
  font-size: 12.5px;
  color: var(--muted-foreground);
  margin-top: -10px;
}

.dialog-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  align-items: center;
  /* en 词长兜底：放不下时整组按钮换行右对齐，而非挤压换字 */
  flex-wrap: wrap;
}

/* 真机反馈：footer 按钮被挤压成竖排换行，全部锁单行 */
.dialog-footer button {
  white-space: nowrap;
  flex-shrink: 0;
  /* 进行中态 spinner 与文案水平对齐 */
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.dialog-footer .spacer {
  flex: 1;
}

.confirm-btn {
  background: #000;
  color: #fff;
  border-color: #000;
}

.confirm-btn:hover {
  background: #1f1f1f;
  color: #fff;
  border-color: #1f1f1f;
}

:root[data-theme='dark'] .confirm-btn {
  background: var(--primary);
  color: var(--primary-foreground);
  border-color: var(--primary);
}

:root[data-theme='dark'] .confirm-btn:hover {
  background: var(--primary-hover);
  border-color: var(--primary-hover);
}

.dlg-branch {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--secondary);
  font-size: 13px;
  font-weight: 500;
}

.dlg-branch svg {
  width: 13px;
  height: 13px;
  color: var(--muted-foreground);
  flex-shrink: 0;
}

.dlg-check {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--foreground);
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
  flex-shrink: 0;
}

.dlg-check input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}

.dlg-check .box {
  width: 17px;
  height: 17px;
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: 1px solid var(--border);
  border-radius: 5px;
  background: var(--background);
  color: transparent;
  transition: background var(--transition-fast), border-color var(--transition-fast);
}

.dlg-check .box svg {
  width: 11px;
  height: 11px;
}

.dlg-check input:checked + .box {
  background: var(--success);
  border-color: var(--success);
  color: #fff;
}

.dlg-check:hover .box {
  border-color: var(--muted-foreground);
}

.dlg-check.is-busy {
  opacity: 0.6;
  cursor: not-allowed;
}

.dlg-textarea {
  width: 100%;
  height: 78px;
  resize: vertical;
  font: inherit;
  font-size: 13px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: var(--background);
  color: var(--foreground);
  line-height: 1.6;
  box-sizing: border-box;
}

.dlg-textarea:focus {
  outline: none;
  border-color: var(--brand);
}

.dlg-airow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: -8px;
}

.dlg-ai {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 999px;
  border: none;
  color: var(--foreground);
  background: transparent;
}

.dlg-ai:hover {
  background: var(--muted);
}

.dlg-ai:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.dlg-ai svg {
  width: 12px;
  height: 12px;
}

.spin {
  display: inline-block;
  width: 11px;
  height: 11px;
  border: 2px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: dlg-spin 0.7s linear infinite;
}

@keyframes dlg-spin {
  to { transform: rotate(360deg); }
}

/* 错误区：BranchBadge .git-stderr 同款（弹窗不关、原文展示） */
.dlg-stderr {
  padding: 8px 10px;
  border-radius: 8px;
  background: color-mix(in oklab, var(--destructive) 10%, transparent);
  color: var(--destructive);
  font-size: 12px;
  white-space: pre-wrap;
  word-break: break-all;
  max-height: 140px;
  overflow-y: auto;
}

.dlg-stat {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--muted-foreground);
}
</style>
