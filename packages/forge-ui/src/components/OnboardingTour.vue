<script setup lang="ts">
/**
 * 首次使用指引（形态 A · 分步聚光灯，2026-10-09 由 prototypes/onboarding-overlay-variants.html
 * 对比后拍板）。六步逐个高亮，走完/跳过才放行；遮罩吃掉全部指针事件，**洞内元素同样点不到**
 * （拍板口径：全部不可操作，不做逐锚点放行）。
 *
 * 三个必须记住的实测结论（都是 rect 量出来的，改代码前先看它们）：
 * 1. 洞有最小尺寸 76×30：设置入口实测 49×19、「浏览目录」图标 22×20，原样挖洞是针眼。
 * 2. 卡片落位顺序必须「右侧优先」但终端那步会退到左侧：终端图标钉在工具条右端（x≈1124），
 *    右侧无余量，四个候选位由 placeBox 依次试并避开洞本身。
 * 3. 锚点缺失自动跳过该步：更新入口行有 v-if，没新版本时这一步不出现，所以实际步数不是写死的 6，
 *    计数与圆点都按剔除后的 order 走。零项目新装原本会把「浏览目录」也剪掉（实测只剩 4 步），
 *    故该步配了备用锚点 + 配套文案，见 TourStep.alt。
 *
 * 锚点契约 = 真实元素上的 `data-onboarding` 标记（App.vue / ProjectTree.vue / UpdateEntry.vue），
 * 不是 class——class 会随重构漂移，标记漂移了单测和这里都咬得住。
 * z 档 6000：压在 ConversationView 的 5000 层之上（demo 同款口径）。
 */
import { computed, nextTick, onUnmounted, ref, watch } from 'vue';
import { useI18n } from '../i18n/index.ts';
import type { MessageKey } from '../i18n/index.ts';
import { useOnboarding } from '../composables/useOnboarding.ts';

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface TourStep {
  anchor: string;
  title: MessageKey;
  desc: MessageKey;
  /**
   * 主锚点不在位时的退路，锚点和配套文案一起换。
   * 现在只有第 2 步用得上：「<>」挂在项目行上，而全新装首启必然是零项目（实测 2026-10-09：
   * 清空项目后 codeentry 锚点 MISSING，这一步会被剪成 4 步）。备用锚点 = 侧栏「暂无项目」空态行，
   * 文案同时改成「先添加项目，行尾才会出现 <>」——对着还没有的图标讲「点这个图标」是假话。
   */
  alt?: { anchor: string; title: MessageKey; desc: MessageKey };
}

/** 步骤顺序即教学顺序：先认门（树）→ 再看目录 → 开新会话 → 终端 → 设置 → 更新提示 */
const STEPS: TourStep[] = [
  { anchor: 'treelist', title: 'onboarding.step.tree.title', desc: 'onboarding.step.tree.desc' },
  {
    anchor: 'codeentry',
    title: 'onboarding.step.code.title',
    desc: 'onboarding.step.code.desc',
    alt: {
      anchor: 'codeentry-empty',
      title: 'onboarding.step.code.empty.title',
      desc: 'onboarding.step.code.empty.desc',
    },
  },
  { anchor: 'newsession', title: 'onboarding.step.new.title', desc: 'onboarding.step.new.desc' },
  { anchor: 'terminal', title: 'onboarding.step.term.title', desc: 'onboarding.step.term.desc' },
  { anchor: 'settings', title: 'onboarding.step.settings.title', desc: 'onboarding.step.settings.desc' },
  { anchor: 'update', title: 'onboarding.step.update.title', desc: 'onboarding.step.update.desc' },
];

/** 洞：锚点外扩 6px，再兜最小尺寸（见文件头结论 1） */
const HOLE_PAD = 6;
const HOLE_MIN_W = 76;
const HOLE_MIN_H = 30;
/** 卡片：定宽与兜底高度（兜底值只在量不到 DOM 时用，正常路径会被实测值替换） */
const CARD_W = 296;
const CARD_H_FALLBACK = 160;
/** 落位：离窗口边缘留 12px，卡片与洞之间留 16px */
const EDGE_PAD = 12;
const GAP = 16;

const { t } = useI18n();
const { visible, closeTour } = useOnboarding();

const cardEl = ref<HTMLDivElement | null>(null);
/** 本次实际会走到的步骤下标（开蒙层时按锚点在不在筛一遍） */
const order = ref<number[]>([]);
/** 与 order 等长：该位是否落到了备用锚点上（开蒙层时一次性定，中途不再翻） */
const altAt = ref<boolean[]>([]);
/** order 里的位置，不是 STEPS 下标 */
const pos = ref(0);
/** 首帧就位后才置真：否则洞会从窗口左上角飞进来（position 过渡是常驻的） */
const opened = ref(false);
const spotStyle = ref<Record<string, string>>({});
const cardStyle = ref<Record<string, string>>({});

const step = computed<TourStep | null>(() => STEPS[order.value[pos.value] ?? -1] ?? null);
/** 当前这一步实际展示的那份：走了备用锚点就连文案一起换 */
const shown = computed<TourStep | null>(() => {
  const s = step.value;
  if (!s) return null;
  return s.alt && altAt.value[pos.value] ? s.alt : s;
});
const isLast = computed(() => pos.value >= order.value.length - 1);

function viewport(): { w: number; h: number } {
  const el = document.documentElement;
  return { w: el.clientWidth, h: el.clientHeight };
}

/** 锚点矩形（视口坐标）；不存在或塌成一条线都算「没有这个锚点」 */
function rectOf(anchor: string): Rect | null {
  const el = document.querySelector<HTMLElement>(`[data-onboarding="${anchor}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return null;
  return { x: r.left, y: r.top, w: r.width, h: r.height };
}

/** 挖洞矩形：外扩 + 最小尺寸兜底 + 整体夹回视口（小锚点靠边时不能被撑出窗外） */
function holeOf(anchor: string): Rect | null {
  const r = rectOf(anchor);
  if (!r) return null;
  const w = Math.max(r.w + HOLE_PAD * 2, HOLE_MIN_W);
  const h = Math.max(r.h + HOLE_PAD * 2, HOLE_MIN_H);
  const { w: W, h: H } = viewport();
  return {
    x: Math.min(W - w, Math.max(0, r.x + r.w / 2 - w / 2)),
    y: Math.min(H - h, Math.max(0, r.y + r.h / 2 - h / 2)),
    w,
    h,
  };
}

const hits = (a: Rect, b: Rect): boolean =>
  !(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y);

/**
 * 落位（demo 同一套算法移植）：右 → 左 → 下 → 上 依次试，候选先水平夹取，再要求完整
 * 在窗内且不压住避让清单（清单里至少含自己的洞——压上去等于把讲解对象盖掉）。
 * 四个方向都不合身才兜底：贴洞下方并把 y 夹回窗内，然后逐步上移让开清单。
 */
function placeBox(box: Rect, cw: number, ch: number, avoid: Rect[]): { x: number; y: number } {
  const { w: W, h: H } = viewport();
  const clampX = (x: number): number => Math.min(W - cw - EDGE_PAD, Math.max(EDGE_PAD, x));
  const cands = [
    { x: clampX(box.x + box.w + GAP), y: box.y },
    { x: clampX(box.x - cw - GAP), y: box.y },
    { x: clampX(box.x + box.w / 2 - cw / 2), y: box.y + box.h + GAP },
    { x: clampX(box.x + box.w / 2 - cw / 2), y: box.y - ch - GAP },
  ];
  for (const c of cands) {
    const me: Rect = { x: c.x, y: c.y, w: cw, h: ch };
    if (c.x < EDGE_PAD || c.y < EDGE_PAD || c.x + cw > W - EDGE_PAD || c.y + ch > H - EDGE_PAD) {
      continue;
    }
    if (avoid.some((a) => hits(me, a))) continue;
    return c;
  }
  let y = Math.max(EDGE_PAD, Math.min(H - ch - EDGE_PAD, box.y + box.h + GAP));
  const me: Rect = { x: clampX(box.x + box.w / 2 - cw / 2), y, w: cw, h: ch };
  while (y > EDGE_PAD && avoid.some((a) => hits(me, a))) {
    y -= 8;
    me.y = y;
  }
  return me;
}

/** 画当前这一步；锚点在途中消失就顺延，走到头即收尾 */
async function renderCurrent(): Promise<void> {
  for (;;) {
    const s = shown.value;
    if (!s) {
      closeTour();
      return;
    }
    const hole = holeOf(s.anchor);
    if (hole) {
      spotStyle.value = {
        left: `${hole.x}px`,
        top: `${hole.y}px`,
        width: `${hole.w}px`,
        height: `${hole.h}px`,
      };
      // 文案随 pos 变了要先刷进 DOM，才量得到卡片真实高度（六步文案长短差一倍）
      await nextTick();
      const cw = cardEl.value?.offsetWidth || CARD_W;
      const ch = cardEl.value?.offsetHeight || CARD_H_FALLBACK;
      const p = placeBox(hole, cw, ch, [hole]);
      cardStyle.value = { left: `${p.x}px`, top: `${p.y}px` };
      return;
    }
    if (isLast.value) {
      closeTour();
      return;
    }
    pos.value += 1;
    await nextTick();
  }
}

function buildOrder(): void {
  const idx: number[] = [];
  const alt: boolean[] = [];
  STEPS.forEach((s, i) => {
    if (rectOf(s.anchor) !== null) {
      idx.push(i);
      alt.push(false);
    } else if (s.alt && rectOf(s.alt.anchor) !== null) {
      idx.push(i);
      alt.push(true);
    }
  });
  order.value = idx;
  altAt.value = alt;
}

function onResize(): void {
  if (visible.value) void renderCurrent();
}

function keydown(ev: KeyboardEvent): void {
  if (!visible.value) return;
  if (ev.key === 'Escape') {
    ev.preventDefault();
    // 指引期间的 Esc 归这里，不许再冒给 App 的分层退出逻辑
    ev.stopPropagation();
    closeTour();
    return;
  }
  if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight' || ev.key === 'Enter') {
    ev.preventDefault();
    ev.stopPropagation();
    if (ev.key === 'ArrowLeft') void goPrev();
    else void goNext();
  }
}

async function goNext(): Promise<void> {
  if (isLast.value) {
    closeTour();
    return;
  }
  pos.value += 1;
  await renderCurrent();
}

async function goPrev(): Promise<void> {
  if (pos.value === 0) return;
  pos.value -= 1;
  await renderCurrent();
}

watch(visible, async (v) => {
  // 让被高亮的控件在蒙层下仍然看得见（ProjectTree 认这个类，详见那里的注释）
  document.documentElement.classList.toggle('ob-tour-active', v);
  if (!v) {
    opened.value = false;
    window.removeEventListener('resize', onResize);
    return;
  }
  buildOrder();
  pos.value = 0;
  if (order.value.length === 0) {
    // 一个锚点都没找到（窗口还没铺好 / 全被隐藏）：立刻散场，不许留一层点不动的蒙层
    closeTour();
    return;
  }
  await nextTick();
  await renderCurrent();
  opened.value = true;
  window.addEventListener('resize', onResize);
});

onUnmounted(() => {
  document.documentElement.classList.remove('ob-tour-active');
  window.removeEventListener('resize', onResize);
  window.removeEventListener('keydown', keydown, true);
});

// 键盘监听常驻（捕获阶段）：组件本身只在 App 根挂一次，visible 为假时 keydown 直接 return
window.addEventListener('keydown', keydown, true);
</script>

<template>
  <Teleport to="body">
    <div v-if="visible" class="ob-root" :class="{ 'is-open': opened }">
      <!-- 遮罩本体在 A 形态下是透明的：压暗由洞的 9999px 反遮罩完成，两层都铺会加深一档。
           它仍然吃下全部指针事件——点空白处 = 跳过。 -->
      <div class="ob-backdrop" @click="closeTour"></div>
      <div class="ob-spot" :style="spotStyle" aria-hidden="true"></div>
      <div
        v-if="shown"
        ref="cardEl"
        class="ob-card"
        :style="cardStyle"
        role="dialog"
        aria-modal="true"
        :aria-label="t('onboarding.eyebrow')"
      >
        <div class="ob-eyebrow">{{ t('onboarding.eyebrow') }}</div>
        <div class="ob-title">{{ t(shown.title) }}</div>
        <div class="ob-desc">{{ t(shown.desc) }}</div>
        <div class="ob-foot">
          <button v-if="pos > 0" class="ob-btn" @click="goPrev">{{ t('onboarding.prev') }}</button>
          <button v-else class="ob-btn skip" @click="closeTour">{{ t('onboarding.skip') }}</button>
          <div class="ob-dots" aria-hidden="true">
            <span v-for="(si, di) in order" :key="si" class="ob-dot" :class="{ on: di === pos }"></span>
          </div>
          <span class="ob-count">{{ pos + 1 }}/{{ order.length }}</span>
          <button class="ob-btn primary" @click="goNext">
            {{ isLast ? t('onboarding.done') : t('onboarding.next') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.ob-root {
  position: fixed;
  inset: 0;
  z-index: 6000;
}

.ob-backdrop {
  position: fixed;
  inset: 0;
  z-index: 6000;
  background: transparent;
  opacity: 0;
  pointer-events: none;
  transition: opacity 220ms ease;
}
.ob-root.is-open .ob-backdrop {
  opacity: 1;
  pointer-events: auto;
}

.ob-spot {
  position: fixed;
  z-index: 6001;
  pointer-events: none;
  border-radius: 12px;
  opacity: 0;
  box-shadow:
    0 0 0 9999px var(--overlay),
    0 0 0 1px color-mix(in oklab, var(--brand-accent) 62%, transparent),
    0 0 22px color-mix(in oklab, var(--brand-accent) 16%, transparent);
  transition:
    left var(--transition-decelerate),
    top var(--transition-decelerate),
    width var(--transition-decelerate),
    height var(--transition-decelerate),
    opacity 180ms ease;
}
.ob-root.is-open .ob-spot {
  opacity: 1;
}

.ob-card {
  position: fixed;
  z-index: 6002;
  width: 296px;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 14px 16px 12px;
  opacity: 0;
  transform: translateY(6px);
  pointer-events: none;
  transition: opacity 200ms ease, transform 240ms cubic-bezier(0.22, 1, 0.36, 1);
}
.ob-root.is-open .ob-card {
  opacity: 1;
  transform: none;
  pointer-events: auto;
}

.ob-eyebrow {
  font-size: 11px;
  color: var(--brand-accent);
  letter-spacing: 0.06em;
  margin: 0 0 6px;
  font-weight: 600;
}
.ob-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--foreground);
  margin: 0 0 6px;
  line-height: 1.4;
}
.ob-desc {
  font-size: 12.5px;
  line-height: 1.7;
  color: var(--muted-foreground);
  margin: 0 0 12px;
}

.ob-foot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ob-dots {
  display: flex;
  gap: 5px;
  margin-right: auto;
}
.ob-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: color-mix(in oklab, var(--muted-foreground) 45%, transparent);
  transition: background var(--transition-base), transform var(--transition-base);
}
.ob-dot.on {
  background: var(--brand-accent);
  transform: scale(1.35);
}

.ob-btn {
  border: 1px solid var(--border);
  background: transparent;
  color: var(--muted-foreground);
  font: 500 12.5px var(--font-sans);
  padding: 6px 12px;
  border-radius: 8px;
  cursor: pointer;
}
.ob-btn:hover {
  color: var(--foreground);
  background: var(--surface-hover);
}
.ob-btn.primary {
  border: 0;
  background: var(--primary);
  color: var(--primary-foreground);
  font-weight: 600;
}
.ob-btn.primary:hover {
  background: color-mix(in oklab, var(--primary) 88%, white);
  color: var(--primary-foreground);
}
.ob-btn.skip {
  border: 0;
  padding: 6px 4px;
}
.ob-count {
  font-size: 11.5px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  margin-left: 2px;
}
</style>
