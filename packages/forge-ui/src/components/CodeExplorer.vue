<script setup lang="ts">
/**
 * 内置代码纸（模块 12 CE-S01 ~ CE-S05）。
 *
 * 位置约定（与原型一致，三者各司其职）：
 * - 左栏：ProjectTree ↔ CodeTreePanel 互斥切换（整栏替换，退出后项目树原样保留）
 * - 右栏：本组件，覆盖或并置于 `.content`（对话纸所在处）
 * - 状态：两者共享 useCodeExplorer 的项目级状态，所以切布局、切左右栏都不丢展开态
 *
 * 它只做两件事：
 * 1. 选出「本次实际生效」的布局：偏好是 split 但窗口太窄时，**临时**降级 cover，
 *    且**不写回偏好**（CE-S04）。拉宽窗口后自动恢复 split。
 * 2. 把 split 的百分比钳一次（两侧各保底 320px），避免多处各算一遍算出不同结果。
 *
 * 布局 A（cover）之所以必须是 `position:absolute; inset:0` 的 overlay 而非替换：
 * AI 可能正在流式输出、用户滚动位置可能停在中间，看一眼代码不该把这些全丢掉。
 * 对话纸的 DOM 保持挂载、宽度零变化，是 A 相对 B 的全部理由。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import CodeViewer from './CodeViewer.vue';
import CodeSplitter from './CodeSplitter.vue';
import { useCodeExplorer } from '../composables/useCodeExplorer';
import type { GitStatusFile } from '../types';
import {
  clampCodeSplitPct,
  codeLayoutDegraded,
  effectiveCodeLayout,
  viewportWidth,
  usePreferences,
  type CodeViewerLayout,
} from '../composables/usePreferences';
import { useI18n } from '../i18n/index.ts';

const props = defineProps<{
  /** 正在浏览代码的项目；null = 不显示代码纸，组件退化为「只提供行布局的容器」 */
  projectPath: string | null;
}>();

const { t } = useI18n();
const { codeViewerLayout, codeViewerSplitPct, setCodeViewerSplitPct } = usePreferences();
const { getState, setActive, closeFile, moveFile, loadGitStatus } = useCodeExplorer();

/** 宿主的像素宽度：拖拽增量与保底换算都要用它 */
const hostWidth = ref(0);
const host = ref<HTMLElement | null>(null);

const state = computed(() => getState(props.projectPath ?? ''));
const openFiles = computed(() => (props.projectPath ? state.value.openFiles : []));
const activeRel = computed(() => state.value.activeRel);

/**
 * 代码纸真正显示的条件：进了代码态 **且至少打开了一个文件**。
 * demo 定稿的进入语义：点 `<>` 只把左栏切成代码树，右列保持对话原样；
 * 点开第一个文件才把代码纸叫出来，关掉最后一个标签自动收回。
 * 否则一进代码态就被一块「请选择文件」的空态盖住对话——这就是用户反馈的
 * 「进来的页面有问题」。
 */
const showEditor = computed(() => props.projectPath !== null && openFiles.value.length > 0);

/** 实际生效的布局：偏好 + 窗口宽度共同决定（与 App 侧同一个函数，避免两处漂移） */
const effectiveLayout = computed<CodeViewerLayout>(() =>
  showEditor.value ? effectiveCodeLayout(codeViewerLayout.value, viewportWidth.value) : 'cover',
);

/** 是否因窗口太窄而临时降级（纸底要说明，否则用户以为偏好丢了）。
 *  判定公式只存在于 usePreferences.codeLayoutDegraded 一处，这里只补一个「代码纸在场」的前提。 */
const isDegraded = computed(() => showEditor.value && codeLayoutDegraded.value);

const splitPct = computed(() => clampCodeSplitPct(codeViewerSplitPct.value, hostWidth.value));

/** 当前文件的 Git 徽标：切文件时做一次本地查表，不重新拉 git */
const activeGit = ref<GitStatusFile | null>(null);

async function syncGit(): Promise<void> {
  if (!props.projectPath) {
    activeGit.value = null;
    return;
  }
  const files = await loadGitStatus(props.projectPath);
  activeGit.value = files.find((f) => f.path === activeRel.value) ?? null;
}

function onResize(): void {
  // 窗口宽度由 usePreferences 的模块级 viewportWidth 自己监听，这里只管宿主宽度
  if (host.value) hostWidth.value = host.value.clientWidth;
}

let ro: ResizeObserver | null = null;
onMounted(() => {
  onResize();
  window.addEventListener('resize', onResize);
  if (host.value && typeof ResizeObserver !== 'undefined') {
    // 终端面板开合会改变宿主宽度（不只是窗口 resize），所以观察宿主本身
    ro = new ResizeObserver(() => {
      if (host.value) hostWidth.value = host.value.clientWidth;
    });
    ro.observe(host.value);
  }
  void syncGit();
});
onBeforeUnmount(() => {
  window.removeEventListener('resize', onResize);
  ro?.disconnect();
});

// 切激活文件 → 只做一次本地查表，不重新拉 git（CE-S07：进代码态时读一次并缓存）
const watchedActive = computed(() => `${props.projectPath ?? ''}::${activeRel.value ?? ''}`);
watch(watchedActive, () => {
  void syncGit();
});

/** 拖拽中：只改 ref 不落盘。一次拖拽上百次变更，没必要每次写 localStorage */
const dragging = ref(false);

function onUpdatePct(v: number): void {
  if (dragging.value) {
    codeViewerSplitPct.value = v;
    return;
  }
  setCodeViewerSplitPct(v);
}

function onDragging(v: boolean): void {
  dragging.value = v;
  if (!v) setCodeViewerSplitPct(codeViewerSplitPct.value);
}

function onSelectTab(relPath: string): void {
  if (props.projectPath) setActive(props.projectPath, relPath);
}

function onCloseTab(relPath: string): void {
  if (props.projectPath) closeFile(props.projectPath, relPath);
}

/** 拖拽排序 / 左移右移：只改签顺序，不改激活签（手势不做额外的事） */
function onMoveTab(relPath: string, toIndex: number): void {
  if (props.projectPath) moveFile(props.projectPath, relPath, toIndex);
}

/** Esc 逐级退出（PRD）由 App 的 window keydown 统一决定，这里只渲染宽度读数 */
const splitPctLabel = computed(() => `${Math.round(splitPct.value)}%`);
</script>

<template>
  <!--
    本组件是 .content 内部的**布局所有者**。把对话列做成 slot 交进来，而不是
    在 App 里和代码纸平级摆两个 flex 子项：
    百分比基准必须落在「宽度已确定」的元素上。若 .content 直接摆两个子项，
    代码纸的 flex-basis:46% 会去参照一个自身内容也依赖这个百分比的元素，
    浏览器只能按内容猜——实测拖到最左时算出 209px 而非 320px 保底。
    自己拥有这行 flex，基准就是自己量出来的 clientWidth，永远自洽。
  -->
  <div ref="host" class="cex" :data-layout="effectiveLayout">
    <!-- 对话列：cover 布局下占满全宽（宽度零变化），split 布局下吃掉代码纸之外的剩余空间 -->
    <div class="cex-conv">
      <slot />
    </div>

    <!-- v-if 必须挂在 Transition 的直接子元素上：外层再包一层 v-if 的话，
         整棵子树被一次性卸载，leave 动画没有机会跑（进出都必须是 Transition 说了算） -->
    <template v-if="effectiveLayout === 'cover'">
      <!-- A：整屏覆盖。代码纸绝对定位盖住对话区，对话 DOM 与宽度都不动 -->
      <Transition name="cex-dock">
        <div v-if="showEditor" class="cex-cover">
          <CodeViewer
            :files="openFiles"
            :active-rel="activeRel"
            :git-status="activeGit"
            @select="onSelectTab"
            @close="onCloseTab"
            @move="onMoveTab"
          />
          <div v-if="isDegraded" class="cex-note">{{ t('code.layoutDegraded') }}</div>
        </div>
      </Transition>
    </template>

    <template v-else>
      <!-- B：左右分割。flex:0 0 <pct>% 锁死宽度，两纸平级并排；
           沟画在代码纸左缘——它分隔的是「对话 ⇄ 代码」，不是「代码 ⇄ 窗边」 -->
      <CodeSplitter
        v-if="showEditor"
        :pct="splitPct"
        :container-width="hostWidth"
        @update:pct="onUpdatePct"
        @dragging="onDragging"
      />
      <Transition name="cex-dock">
        <div v-if="showEditor" class="cex-split" :style="{ flexBasis: `${splitPct}%` }">
          <CodeViewer
            :files="openFiles"
            :active-rel="activeRel"
            :git-status="activeGit"
            @select="onSelectTab"
            @close="onCloseTab"
            @move="onMoveTab"
          />
          <footer class="cex-foot">
            <span class="cex-pct" :title="t('code.splitterHint')">
              {{ t('code.widthPct', { n: splitPctLabel }) }}
            </span>
          </footer>
        </div>
      </Transition>
    </template>
  </div>
</template>

<style scoped>
.cex {
  display: flex;
  min-width: 0;
  min-height: 0;
  /* 撑满 .content。cover 布局也保持行 flex：单孩子 .cex-conv 靠 flex:1 吃满
     宽高，与 block 等效；一旦切成 block，对话列失去高度拉伸，首页终端面板会
     悬在半空、hero 被压扁（曾因此被报「启动首页变形」）。 */
  flex: 1 1 auto;
  outline: none;
}

/* 对话列。min-width:0 必需：没有它，内部的 pre / 代码块会按内容宽度把纸撑破，
   overflow 失效。 */
.cex-conv {
  display: flex;
  flex-direction: column;
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
}

/* A：整屏。absolute + inset:0 是整件事的技术核心——对话纸留在原位、宽度零变化。
   参照系是 .content（position:relative），所以这里不能用相对自身。 */
.cex-cover {
  position: absolute;
  inset: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  background: var(--background);
  border-radius: 12px;
  /* 「盖上去」语义：比对话纸高一层 */
  box-shadow: var(--elev-sheet);
  overflow: hidden;
}
.cex-note {
  flex: none;
  padding: 4px 12px;
  border-top: 1px solid var(--border);
  font-size: 11px;
  color: var(--warning);
  background: color-mix(in oklab, var(--warning) 8%, transparent);
}

/* B：分割。flex 简写的 grow/shrink 都给 0，锁死 flex-basis 给出的宽度；
   min-width:0 允许它被父级压到 320px 保底而不是撑破容器。 */
.cex-split {
  flex: 0 0 auto;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--background);
  border-radius: 12px 0 0 12px;
  /* 与对话纸同级：「并排站」而非「盖上去」，故不加投影 */
  box-shadow: var(--elev-sheet);
  overflow: hidden;
}
/* 代码纸进出场（demo dock-in 口径）：入 = 从右缘 24px 减速滑入，出 = 加速滑回右缘。
   v-if 挂在 Transition 直接子元素上，收起标签页 / 退出代码态时 leave 才跑得到 */
.cex-dock-enter-active {
  animation: cex-dock-in 260ms cubic-bezier(0.22, 1, 0.36, 1);
}
.cex-dock-leave-active {
  animation: cex-dock-out 200ms cubic-bezier(0.55, 0, 0.85, 0.5);
}
@keyframes cex-dock-in {
  from {
    transform: translateX(24px);
    opacity: 0.4;
  }
}
@keyframes cex-dock-out {
  to {
    transform: translateX(24px);
    opacity: 0.4;
  }
}
.cex-foot {
  flex: none;
  display: flex;
  justify-content: flex-end;
  padding: 3px 10px;
  border-top: 1px solid var(--border);
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted-foreground);
}
.cex-pct {
  white-space: nowrap;
}
</style>
