<script setup lang="ts">
/**
 * 共享右键菜单（原先 ProjectTree 的 `project-action-menu*` 与 ChangedFilesCard 的
 * `cf-context-menu*` 两套几乎逐行相同的实现抽出来的）。
 *
 * 抽出来的原因不是洁癖：第三处（代码树）如果再抄一遍，就会有三份视口钳制公式、
 * 三份「点外面关闭」的 document 监听、三个 z-index，而它们各自漂移的速度还不一样。
 *
 * 行为与原来的两处**逐条对齐**，不要顺手改：
 *  - `position: fixed` + Teleport 到 body（不受祖先 overflow/transform 影响）
 *  - 视口钳制：贴边留 8px，右/下边界用「菜单实际宽高」而非魔法数字兜底
 *  - document **capture** 阶段的 click 关闭，且点到菜单自身内部不算关闭
 *  - Escape 关闭
 *  - window 滚动/缩放关闭（菜单是 fixed 定位，页面一动它就错位了）
 *  - 唯一对旧实现的有意扩展：`keepOpen` 条目选中后不自动关（旧 ProjectTree 的
 *    两阶段确认项本来就不关菜单，收尾关闭由消费方 handler 决定）
 *
 * 宽度/高度：原来两处都是写死 `min-width`（180 / 160）+ 硬编码的钳制宽高。
 * 这里改成先按 items 数量估一个值渲染、下一帧用真实 `getBoundingClientRect()` 再钳一次，
 * 免得中文长文案把菜单顶出视口。
 */
import { computed, onBeforeUnmount, onMounted, ref, watch, nextTick } from 'vue';

export interface ContextMenuItem {
  /** 稳定 key，仅用于 v-for 与测试定位 */
  key: string;
  /** 已翻译的文案 */
  label: string;
  /** 24x24 线性图标路径（内容），不传则不渲染图标列 */
  icon?: string;
  /** 危险项（删除类）：文字转 destructive，hover 淡染 */
  danger?: boolean;
  /** 二次确认态：实心底 + 加粗，配 confirmLabel 用 */
  confirming?: boolean;
  /** 禁用：不可点、不触发 */
  disabled?: boolean;
  /** 选中后保持菜单打开。两阶段确认项必须置位：首次点击只切确认文案，
   *  若这里照常 close，消费方的 closeMenu 会把确认态一并清掉，第二次点击
   *  永远等不到，表现为「清理所有会话/删除项目点了没反应」。确认后的
   *  收尾关闭由消费方 handler 自己调 close()（见 ProjectTree 两阶段流程）。 */
  keepOpen?: boolean;
}

const props = withDefaults(
  defineProps<{
    /** 视口坐标（clientX/clientY） */
    x: number;
    y: number;
    items: ContextMenuItem[];
    /** 最小宽度，默认与原实现一致（180） */
    minWidth?: number;
  }>(),
  { minWidth: 180 },
);

const emit = defineEmits<{ (e: 'select', key: string): void; (e: 'close'): void }>();

const menuRef = ref<HTMLElement | null>(null);
const posX = ref(props.x);
const posY = ref(props.y);
/** 打开时刻：用来给「拖动到边才发生的滚动」一个宽限期（见 onViewportChange） */
const openedAt = ref(0);

/** 视口内可见的边距：与原两处实现一致 */
const EDGE = 8;

function clamp(x: number, y: number): { x: number; y: number } {
  const el = menuRef.value;
  const w = el?.getBoundingClientRect().width || props.minWidth;
  const h = el?.getBoundingClientRect().height || props.items.length * 30 + 8;
  return {
    x: Math.max(EDGE, Math.min(x, window.innerWidth - w - EDGE)),
    y: Math.max(EDGE, Math.min(y, window.innerHeight - h - EDGE)),
  };
}

watch(
  () => [props.x, props.y, props.items.length] as const,
  async ([x, y]) => {
    posX.value = x;
    posY.value = y;
    // 先按估算值落位，拿到真实尺寸后再钳一次——否则长文案会被顶出视口。
    await nextTick();
    const c = clamp(x, y);
    posX.value = c.x;
    posY.value = c.y;
  },
  { immediate: true },
);

function close(): void {
  emit('close');
}

function onDocumentClick(ev: MouseEvent): void {
  const target = ev.target as Node | null;
  const el = menuRef.value;
  // capture 阶段监听：菜单内的 @click.stop 只能挡冒泡，挡不住已经到 document 的 capture
  if (el && target && el.contains(target)) return;
  close();
}

function onDocumentKeydown(ev: KeyboardEvent): void {
  if (ev.key === 'Escape') close();
}

function onViewportChange(): void {
  // fixed 定位：页面滚动或窗口缩放后菜单会与触发点脱节，直接收起（与 ProjectTree 一致）。
  //
  // 但要给刚打开的菜单一个**宽限期**：触发右键前，浏览器/自动化往往先把目标行
  // 滚进视野（scrollIntoViewIfNeeded），而那个 scroll 事件是异步派发的——
  // 即使滚动是瞬时的，事件也要等下一帧才到，也就是**晚于** contextmenu。
  // 不给宽限期的话，菜单会在打开后约 16ms 被自己刚触发的 scroll 关掉（实测：
  // 改动文件卡在可滚消息流里，E-CV-FILES-008 右键第一下菜单就没了）。
  if (performance.now() - openedAt.value < 150) return;
  close();
}

onMounted(() => {
  openedAt.value = performance.now();
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onDocumentKeydown);
  window.addEventListener('scroll', onViewportChange, true);
  window.addEventListener('resize', onViewportChange);
});

onBeforeUnmount(() => {
  document.removeEventListener('click', onDocumentClick, true);
  document.removeEventListener('keydown', onDocumentKeydown);
  window.removeEventListener('scroll', onViewportChange, true);
  window.removeEventListener('resize', onViewportChange);
});

function onItemClick(item: ContextMenuItem): void {
  if (item.disabled) return;
  // 顺序很关键：**先 select 后 close**。
  // 消费方的 handler（onMenuOpenDir / onContextMenuOpenDir…）都靠
  // `menuOpenPath` / `contextMenuPath` 这个 ref 拿目标路径，而 close 会把它置空；
  // 先发 close 就等于在 handler 跑之前把目标删了，表现为「点了菜单项但 shell 没被调用」。
  emit('select', item.key);
  if (!item.keepOpen) close();
}

const style = computed(() => ({ left: `${posX.value}px`, top: `${posY.value}px` }));
</script>

<template>
  <Teleport to="body">
    <div
      ref="menuRef"
      class="ctx-menu"
      :style="{ ...style, minWidth: minWidth + 'px' }"
      role="menu"
      @click.stop
      @contextmenu.prevent
    >
      <button
        v-for="item in items"
        :key="item.key"
        type="button"
        class="ctx-menu-item"
        :class="{ danger: item.danger, confirming: item.confirming, disabled: item.disabled }"
        :disabled="item.disabled"
        role="menuitem"
        @click="onItemClick(item)"
      >
        <svg
          v-if="item.icon"
          class="ctx-menu-icon"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
          aria-hidden="true"
        >
          <path :d="item.icon" />
        </svg>
        {{ item.label }}
      </button>
    </div>
  </Teleport>
</template>

<style scoped>
.ctx-menu {
  position: fixed;
  z-index: 1000;
  padding: 4px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  gap: 1px;
}
.ctx-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 7px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--foreground);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  transition: background var(--transition-fast);
}
.ctx-menu-item:hover {
  background: var(--muted);
  border-color: transparent;
  color: var(--foreground);
}
.ctx-menu-item.danger {
  color: var(--destructive);
}
.ctx-menu-item.danger:hover {
  background: color-mix(in oklab, var(--destructive) 10%, transparent);
  color: var(--destructive);
  border-color: transparent;
}
.ctx-menu-item.danger.confirming {
  background: var(--destructive);
  color: #fff;
  font-weight: 600;
}
.ctx-menu-item.danger.confirming:hover {
  background: color-mix(in oklab, var(--destructive) 85%, black);
  color: #fff;
}
.ctx-menu-item.disabled {
  opacity: 0.45;
  cursor: default;
}
.ctx-menu-icon {
  width: 14px;
  height: 14px;
  flex: 0 0 auto;
}
</style>
