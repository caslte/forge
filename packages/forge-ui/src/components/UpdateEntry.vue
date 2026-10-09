<script setup lang="ts">
/**
 * 侧栏更新入口（07 改造）：紧跟「设置」的纯图标控件。
 *
 * 形态口径（demo 定稿）：
 * - 仅更新相关时出现（无新版侧栏零变化），发现新版不再弹 toast；
 * - found=入盘下载图标（圆角方块底），点击开始下载；hover 动画展开「新版本」；
 * - downloading=外圈进度环即进度，无百分比无文字；
 * - ready（downloaded/失败重试）=环形箭头图标（圆底），hover 展开「更新」，点击弹安装确认；
 * - installing=转圈 busy。
 * 入口控件配色用品牌青绿 --brand-accent（双主题各一档）；弹窗内按钮复用全局 button.primary
 * 的中性 --brand，与其余弹窗（关于页 / 退出确认）保持一致，不引入第二套按钮色。
 */
import { computed, onMounted, ref, watch } from 'vue';
import { useI18n } from '../i18n/index.ts';
import { useUpdater } from '../composables/useUpdater';

const { t } = useI18n();
const {
  snapshot, entryVisible, entryMode, downloadPct,
  download, quitAndInstall, ensureSubscribed, refresh,
} = useUpdater();

onMounted(() => {
  ensureSubscribed();
  void refresh();
});

/** 安装确认弹窗显隐（本组件局部态；状态离开 downloaded 自动收起） */
const confirming = ref(false);
watch(
  () => snapshot.value?.status,
  (status) => {
    if (status !== 'downloaded' && confirming.value) confirming.value = false;
  },
);

const RING_C = 62.83; // 2πr, r=10
const ringOffset = computed(() => RING_C * (1 - downloadPct.value / 100));

function onClick(): void {
  if (entryMode.value === 'found') void download();
  if (entryMode.value === 'ready') confirming.value = true;
}

const entryTitle = computed(() => {
  if (entryMode.value === 'found') return t('settings.update.foundVersion', { version: snapshot.value?.latestVersion ?? '' });
  if (entryMode.value === 'downloading') return t('settings.update.entryDownloading');
  if (entryMode.value === 'installing') return t('settings.update.entryInstalling');
  return t('settings.update.entryReady');
});
</script>

<template>
  <button
    v-if="entryVisible"
    class="up-entry"
    data-onboarding="update"
    :class="[entryMode === 'ready' || entryMode === 'installing' ? 'is-round' : 'is-square', entryMode === 'ready' ? 'is-expandable' : '']"
    :disabled="entryMode === 'downloading' || entryMode === 'installing'"
    :data-mode="entryMode"
    :title="entryTitle"
    :aria-label="entryTitle"
    @click="onClick"
  >
    <!-- found：入盘下载箭头 -->
    <span v-if="entryMode === 'found'" class="up-ico">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="12" y1="3.5" x2="12" y2="14" /><polyline points="7 9 12 14.5 17 9" /><path d="M4 16.5v2A2 2 0 0 0 6 20.5h12a2 2 0 0 0 2-2v-2" />
      </svg>
    </span>
    <!-- downloading：进度环即进度 -->
    <span v-else-if="entryMode === 'downloading'" class="up-ico up-ico-ring">
      <svg viewBox="0 0 22 22" fill="none" stroke-width="1.8">
        <circle cx="11" cy="11" r="10" stroke="color-mix(in oklab, currentColor 35%, transparent)" />
        <circle
          cx="11" cy="11" r="10" stroke="currentColor"
          :stroke-dasharray="RING_C" :stroke-dashoffset="ringOffset"
          stroke-linecap="round" transform="rotate(-90 11 11)"
        />
        <g transform="translate(5.9 5.9) scale(0.42)" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round" fill="none">
          <line x1="12" y1="4" x2="12" y2="15" /><polyline points="6 10 12 16 18 10" /><path d="M4 19.5h16" />
        </g>
      </svg>
    </span>
    <!-- ready：环形箭头（重启应用更新） -->
    <span v-else-if="entryMode === 'ready'" class="up-ico">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="20.5 4.5 20.5 10 15 10" /><path d="M20.5 10A8.8 8.8 0 1 0 21.3 14.5" />
      </svg>
    </span>
    <!-- installing：转圈 -->
    <span v-else class="up-ico"><span class="up-spin"></span></span>
    <span v-if="entryMode === 'found'" class="up-txt">{{ t('settings.update.entryFound') }}</span>
    <span v-else-if="entryMode === 'ready'" class="up-txt">{{ t('settings.update.update') }}</span>
  </button>

  <!-- 安装确认（与关于页共享语义；Teleport 保证侧栏折叠时仍可呈现） -->
  <Teleport to="body">
    <div v-if="confirming" class="up-entry-confirm" role="dialog" aria-modal="true" @click.self="confirming = false">
      <div class="uec-box">
        <div class="uec-main">
          <span class="uec-title">{{ t('settings.update.installTitle', { version: snapshot?.latestVersion ?? '' }) }}</span>
          <span class="uec-desc">{{ t('settings.update.installDesc') }}</span>
        </div>
        <div class="uec-actions">
          <button class="ghost small" @click="confirming = false">{{ t('common.cancel') }}</button>
          <button class="primary small" @click="confirming = false; void quitAndInstall()">{{ t('settings.update.confirmInstall') }}</button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.up-entry {
  display: inline-flex;
  align-items: center;
  height: 22px;
  padding: 0;
  border: 0;
  cursor: pointer;
  font-family: inherit;
  overflow: hidden;
  background: var(--brand-accent);
  color: oklch(0.985 0 0);
  transition: background var(--transition-fast);
}

:root[data-theme='dark'] .up-entry {
  color: oklch(0.2 0.02 170);
}

.up-entry:hover {
  background: color-mix(in oklab, var(--brand-accent) 85%, var(--foreground));
}

.up-entry:disabled {
  cursor: default;
}

.up-entry.is-square {
  border-radius: 7px;
}

.up-entry.is-round {
  border-radius: 999px;
}

.up-ico {
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.up-ico > svg {
  width: 13px;
  height: 13px;
}

.up-ico-ring > svg {
  width: 17px;
  height: 17px;
}

/* hover 动画展开文字：仅 found/ready 两个可点击态；过程态零文字 */
.up-entry .up-txt {
  max-width: 0;
  opacity: 0;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  line-height: 1;
  transition: max-width 0.25s ease, opacity 0.2s ease 0.05s, margin-right 0.25s ease;
}

.up-entry[data-mode='found']:hover .up-txt,
.up-entry.is-expandable:hover .up-txt {
  max-width: 52px;
  opacity: 1;
  margin-right: 10px;
}

.up-spin {
  width: 11px;
  height: 11px;
  border-radius: 50%;
  border: 1.6px solid color-mix(in oklab, currentColor 35%, transparent);
  border-top-color: currentColor;
  animation: up-spin-kf 0.8s linear infinite;
}

@keyframes up-spin-kf {
  to {
    transform: rotate(360deg);
  }
}

/* ===== 安装确认弹窗 =====
   与关于页 up-confirm / ExitConfirmDialog 同一份配方：遮罩 --overlay + 10px 模糊、
   盒子 --card / --radius-3xl / --shadow-lg、按钮走全局 button.primary（--brand 中性色）。
   这里不覆盖按钮样式 —— 青绿 --brand-accent 只留给侧栏入口控件，弹窗内不引入新色，
   浅色/深色各由 --brand / --brand-foreground 自行取档，无需主题补丁。 */
.up-entry-confirm {
  position: fixed;
  inset: 0;
  z-index: 2000;
  background: var(--overlay);
  backdrop-filter: blur(10px);
  -webkit-backdrop-filter: blur(10px);
  display: flex;
  align-items: center;
  justify-content: center;
  animation: fadeIn var(--transition-base);
}

.uec-box {
  width: 380px;
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

.uec-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.uec-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--foreground);
}

.uec-desc {
  font-size: 13px;
  color: var(--muted-foreground);
  line-height: 1.5;
}

.uec-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
</style>
