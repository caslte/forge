<script setup lang="ts">
/**
 * 消息流列表项渲染（单条消息 / 聚合工具组）。
 *
 * 结构动机（修复 Vue patch 崩溃）：
 * 旧实现把「单条消息 ↔ 工具组」的形态分支放在父级 v-for 的嵌套
 * template v-if/v-else 中，同一列表位置在流式期间（工具消息到达/聚组边界
 * 变化）会在 message vnode 与 group fragment vnode 间切换，且 key 依赖可变
 * 索引（idx/startIndex），触发 patch 错位（vnode.type=null → emitsOptions 空指针）。
 * 改为：父级只渲染一个组件列表（稳定唯一 key），形态分支隔离在本组件实例内，
 * 同一 key 的组件始终唯一，patch 不再跨列表位置错位。
 */
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import type { ConversationMessage, SessionStatus, ToolEvent } from '../types';
import type { ChangedFileSummary } from '../composables/useChangedFiles';
import { formatElapsed } from '../utils/formatElapsed';
import MessageCard from './MessageCard.vue';
import ToolCallCard from './ToolCallCard.vue';
import ChangedFilesCard from './ChangedFilesCard.vue';
import { useI18n } from '../i18n/index.ts';

const { t } = useI18n();

/** 展示项：单条消息 或 连续 ≥2 的工具组 */
export type DisplayItem =
  | {
      /** 稳定唯一 key（不随列表位置变化） */
      key: string;
      kind: 'message';
      msg: ConversationMessage;
      idx: number;
      /** assistant 分片 footer 轮次控制（仅 assistant 消息需要） */
      showFooter?: boolean;
      copyText?: string;
      /** 该轮首张 assistant 卡（false = 分片卡，不重播入场动画） */
      firstOfTurn?: boolean;
      /** 轮次 FORGE 字标挂载点（该轮首个 assistant/tool 展示项） */
      turnBrand?: boolean;
    }
  | {
      key: string;
      kind: 'tool-group';
      tools: ConversationMessage[];
      totalCount: number;
      collapsed: boolean;
      /** 轮次 FORGE 字标挂载点（该轮首个展示项即工具组） */
      turnBrand?: boolean;
    }
  | {
      key: string;
      kind: 'files-summary';
      summary: ChangedFileSummary;
    }
  | {
      key: string;
      /** CV-S07 上下文压缩边界：loader 由 pi compaction 条目派生，非真实消息 */
      kind: 'compaction-divider';
      ts: string;
    };

const props = defineProps<{
  item: DisplayItem;
  /** 是否流式渲染（仅消息项有效；用于 MessageCard streaming 样式与思考占位） */
  streaming: boolean;
  /** 工具事件归属会话（ToolCallCard event.sessionId） */
  sessionId: string;
  /** 会话项目根路径（改动文件汇总卡片的相对路径归一；空串按原路径展示） */
  projectPath?: string;
  /** 是否展示 diff（个性化偏好；关闭后工具 diff 与改动汇总卡片均不渲染） */
  showDiff?: boolean;
}>();

const showDiffEff = computed(() => props.showDiff !== false);

const emit = defineEmits<{
  (e: 'toggle-group', key: string, collapsed: boolean): void;
}>();

/** 组内任一工具仍为 started → 组在跑，头部切「正在执行中 · Xs」并本地读秒 */
const groupRunning = computed(() => {
  const it = props.item;
  return it.kind === 'tool-group' && it.tools.some((t) => t.status === 'started');
});

const groupElapsedSec = ref(0);
let groupTimer: ReturnType<typeof setInterval> | null = null;

watch(groupRunning, (running) => {
  if (groupTimer) {
    clearInterval(groupTimer);
    groupTimer = null;
  }
  if (!running) return;
  const it = props.item;
  const firstTs = it.kind === 'tool-group' ? it.tools[0]?.ts : undefined;
  const start = firstTs ? Date.parse(firstTs) : Number.NaN;
  const base = Number.isFinite(start) ? start : Date.now();
  const tick = (): void => {
    groupElapsedSec.value = Math.max(0, Math.floor((Date.now() - base) / 1000));
  };
  tick();
  groupTimer = setInterval(tick, 1000);
}, { immediate: true });

onUnmounted(() => {
  if (groupTimer) clearInterval(groupTimer);
});

const groupHeadText = computed(() => {
  const it = props.item;
  if (it.kind !== 'tool-group') return '';
  return groupRunning.value
    ? t('chat.toolGroupRunning', { elapsed: formatElapsed(groupElapsedSec.value) })
    : t('chat.toolGroupCount', { count: it.totalCount });
});

/** 计数形态拆成「数字前文案 + 滚动数字 + 数字后文案」，数字递增只滚数字、不闪整行 */
const countParts = computed(() => {
  const parts = t('chat.toolGroupCount', { count: '\u0000' }).split('\u0000');
  return [parts[0] ?? '', parts[1] ?? t('chat.toolGroupCountMid')];
});

const countDigits = computed(() => {
  const it = props.item;
  if (it.kind !== 'tool-group') return [];
  return String(it.totalCount).split('').map(Number);
});

/** 组内滚动视口：限高 + 上下边缘虚化（mask 随滚动状态切换，见 .tg-scroll 样式） */
const tgScrollRef = ref<HTMLElement | null>(null);
const tgAtTop = ref(true);
const tgAtBottom = ref(true);

/** 挂载即定位到最新行：切会话后消息重挂载，展开态视口若停在顶部会看不到最新工具；
 *  且后续流式追加的贴底跟随（下方 watch）依赖初始位置在底部 */
onMounted(() => {
  const it = props.item;
  if (it.kind !== 'tool-group' || it.collapsed) return;
  void nextTick(() => {
    const el = tgScrollRef.value;
    if (el) el.scrollTop = el.scrollHeight;
    updateTgFade();
  });
});

function updateTgFade(): void {
  const el = tgScrollRef.value;
  if (!el) return;
  tgAtTop.value = el.scrollTop <= 1;
  tgAtBottom.value = el.scrollTop + el.clientHeight >= el.scrollHeight - 1;
}

/** 流式追加工具行：视口原本贴在底部则跟随到最新行，否则保持用户阅读位置 */
watch(
  () => (props.item.kind === 'tool-group' ? props.item.tools.length : -1),
  () => {
    void nextTick(() => {
      const el = tgScrollRef.value;
      if (el && tgAtBottom.value) el.scrollTop = el.scrollHeight;
      updateTgFade();
    });
  }
);

/** 折叠/展开改变视口高度，动画结束后重算边缘虚化（250ms ≈ --transition-base） */
watch(
  () => (props.item.kind === 'tool-group' ? !props.item.collapsed : false),
  () => setTimeout(updateTgFade, 260)
);

/** 把 ConversationMessage（role=tool）转成 ToolCallCard 需要的 ToolEvent */
function toToolEvent(m: ConversationMessage): ToolEvent {
  return {
    toolEventId: m.toolEventId ?? '',
    sessionId: props.sessionId,
    status: (m.status ?? 'started') as ToolEvent['status'],
    toolName: m.toolName,
    summary: m.content || undefined,
    input: m.input,
  };
}

function isToolMessage(m: ConversationMessage): boolean {
  return m.role === 'tool';
}
</script>

<template>
  <template v-if="item.kind === 'message'">
    <div v-if="item.turnBrand" class="msg-brand">FORGE</div>
    <ToolCallCard v-if="isToolMessage(item.msg)" :event="toToolEvent(item.msg)" :hide-diff="!showDiffEff" />
    <MessageCard
      v-else
      :message="item.msg"
      :streaming="streaming"
      :show-footer="item.showFooter"
      :copy-text="item.copyText"
      :first-of-turn="item.firstOfTurn"
    />
  </template>

  <template v-else-if="item.kind === 'files-summary'">
    <ChangedFilesCard
      v-if="showDiffEff"
      :summary="item.summary"
      :project-path="projectPath"
    />
  </template>

  <template v-else-if="item.kind === 'compaction-divider'">
    <div class="compact-divider">
      <span class="cd-line"></span>
      <span class="cd-text">{{ t('chat.contextCompacted') }}</span>
      <span class="cd-line"></span>
    </div>
  </template>

  <template v-else>
    <div v-if="item.turnBrand" class="msg-brand">FORGE</div>
    <div class="tool-group" :class="{ open: !item.collapsed }">
    <button class="tool-group-head" @click="emit('toggle-group', item.key, item.collapsed)">
      <svg class="tg-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" /><polyline points="10 8 14 12 10 16" /></svg>
      <span class="tg-title">
        <Transition name="tg-head" mode="out-in">
          <span v-if="groupRunning" key="run" class="tg-head-text">{{ groupHeadText }}</span>
          <span v-else key="count" class="tg-head-text tg-count">
            <span class="tg-count-text">{{ countParts[0] }}</span>
            <span v-for="(d, i) in countDigits" :key="`${i}-${item.totalCount}`" class="tg-digit">
              <!-- 换计数时重挂载整位数字：仅改 CSS 变量不会重播动画，数字只会瞬间跳格不会滚 -->
              <span class="tg-digit-col" :style="{ '--tg-digit-shift': `-${d * 10}%` }">
                <span v-for="n in 10" :key="n">{{ n - 1 }}</span>
              </span>
              <span class="tg-digit-base">&#8203;</span>
            </span>
            <span class="tg-count-text">{{ countParts[1] }}</span>
          </span>
        </Transition>
      </span>
    </button>
    <div class="tool-group-body-shell">
      <div class="tg-inner">
        <div ref="tgScrollRef" class="tg-scroll" :class="{ 'at-top': tgAtTop, 'at-bottom': tgAtBottom }" @scroll.passive="updateTgFade">
          <TransitionGroup tag="div" name="tg-row" class="tg-rows">
            <ToolCallCard v-for="tm in item.tools" :key="tm.toolEventId ?? tm.ts" :event="toToolEvent(tm)" :hide-diff="!showDiffEff" />
          </TransitionGroup>
        </div>
      </div>
    </div>
    </div>
  </template>
</template>

<style scoped>
/* 轮次头部 FORGE 字标：小号、宽字距、弱化色（设计稿口径，与原 MessageCard .msg-brand 同）。
   字标与后续内容是消息流 flex 的兄弟项（gap 16px），负边距把实际间距收回原 6px 口径 */
.msg-brand {
  font-size: 11px;
  font-weight: 500;
  letter-spacing: 0.08em;
  line-height: 1.4;
  color: var(--muted-foreground);
  margin-bottom: -10px;
  user-select: none;
}
/* 工具组（连续 ≥2 的 tool 聚为一组）：扁平无卡底，头部一句话 + 圆形 chevron */
.tool-group {
  display: flex;
  flex-direction: column;
  /* flex 子项显式允许收缩，窄窗格内行内容不横向撑破 */
  min-width: 0;
  max-width: 100%;
}
.tool-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: fit-content;
  max-width: 100%;
  padding: 4px 6px;
  margin-left: -6px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--muted-foreground);
  border: none;
  background: transparent;
  cursor: pointer;
  user-select: none;
  text-align: left;
  transition: background var(--transition-fast);
}
.tool-group-head:hover {
  background: color-mix(in oklab, var(--muted) 60%, transparent);
}
.tg-chev {
  width: 15px;
  height: 15px;
  flex-shrink: 0;
  transition: transform var(--transition-base);
}
.tool-group.open .tg-chev {
  transform: rotate(90deg);
}
.tg-title {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-variant-numeric: tabular-nums;
}
/* 0fr↔1fr 网格折叠动画（同 demo；折叠时内容保留挂载，展开无二次渲染成本） */
.tool-group-body-shell {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows var(--transition-base);
}
.tool-group.open .tool-group-body-shell {
  grid-template-rows: 1fr;
}
.tg-inner {
  min-height: 0;
  overflow: hidden;
}
/* 滚动视口：限高约 5.5 行（露半行暗示可滚），上下边缘用 mask 让内容本身渐隐；
   at-top/at-bottom 由脚本按滚动位置切换——贴边一侧不虚化，短列表无 mask */
.tg-scroll {
  --tg-fade: 28px;
  max-height: 236px;
  overflow-y: auto;
  overscroll-behavior: contain;
  mask-image: linear-gradient(to bottom,
    transparent 0, black var(--tg-fade), black calc(100% - var(--tg-fade)), transparent 100%);
}
.tg-scroll.at-top {
  mask-image: linear-gradient(to bottom, black 0, black calc(100% - var(--tg-fade)), transparent 100%);
}
.tg-scroll.at-bottom {
  mask-image: linear-gradient(to bottom, transparent 0, black var(--tg-fade), black calc(100% - 2px));
}
.tg-scroll.at-top.at-bottom {
  mask-image: none;
}
/* 覆盖全局 8px 滚动条：组内用细条，避免窄列表里过抢眼 */
.tg-scroll::-webkit-scrollbar {
  width: 3px;
}
.tg-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.tg-scroll::-webkit-scrollbar-thumb {
  background: var(--scrollbar-thumb);
  border-radius: 2px;
}
/* 行缩进 23px = chevron 15 + 间距 8（组头 margin-left:-6 与 padding 6 相抵）：状态点与组头文字左缘对齐 */
.tg-rows {
  position: relative;
  display: flex;
  flex-direction: column;
  padding: 2px 0 6px 23px;
}
/* 左侧贯穿竖线：1px，与组头 chevron 中心（7.5px）同一条垂直线，从组头下方贯穿所有行；
   半透明化让线在深浅主题下都更淡 */
.tg-rows::before {
  content: '';
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 1px;
  background: color-mix(in oklab, var(--border) 55%, transparent);
}
/* 流式追加行的入场（0.5x 节奏，见 design-tokens --motion-*）：淡入+上浮 5px，
   只做 transform/opacity 不动高度，滚动跟随与 mask 逻辑不受影响；move 兜底兄弟行位移 */
.tg-row-enter-active {
  transition:
    opacity var(--motion-row-fade),
    transform var(--motion-row-move);
}
.tg-row-enter-from {
  opacity: 0;
  transform: translateY(5px);
}
.tg-row-move {
  transition: transform var(--motion-row-move);
}
/* 组头「正在执行中 · Xs」↔「执行工具 N 次」按 groupRunning 换 key 做 out-in 淡切（220ms×2）；
   计数递增不换 key、不淡切，只滚数字 */
.tg-head-text {
  display: inline-block;
}
.tg-head-enter-active,
.tg-head-leave-active {
  transition: opacity var(--motion-head-swap);
}
.tg-head-enter-from,
.tg-head-leave-to {
  opacity: 0;
}
/* 滚动数字：每位一列 0-9（grid 强制竖排，普通块级 shrink-to-fit 会排成一行），
   窗口高 1em + overflow 裁切，行高锁 1em 让位移百分比与行高严格对应；
   .tg-digit-base 是零宽空格，把 inline-block 的基线拉回与周围文案对齐 */
.tg-count {
  font-variant-numeric: tabular-nums;
}
.tg-digit {
  display: inline-block;
  height: 1em;
  overflow: hidden;
  line-height: 1em;
}
.tg-digit-col {
  display: grid;
  grid-auto-rows: 1em;
  line-height: 1em;
  will-change: transform;
  animation: tg-digit-roll 0.4s cubic-bezier(0.22, 1, 0.36, 1) both;
}
.tg-digit-col span {
  display: block;
}
@keyframes tg-digit-roll {
  from {
    transform: translateY(calc(var(--tg-digit-shift) - 10%));
  }
  to {
    transform: translateY(var(--tg-digit-shift));
  }
}
/* CV-S07 上下文压缩分界条：与 .conv-switch-banner 同款 line+文案形态，
   压缩前的对话照常显示在它上方（只有模型上下文被摘要替换） */
.compact-divider {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 6px 6px 2px;
  color: var(--muted-foreground);
  user-select: none;
}
.cd-line {
  flex: 1;
  height: 1px;
  background: color-mix(in oklab, var(--border) 80%, transparent);
}
.cd-text {
  flex-shrink: 0;
  font-size: 12px;
  white-space: nowrap;
}
</style>