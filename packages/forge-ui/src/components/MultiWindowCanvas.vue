<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { SessionItem } from '../types';
import MultiWindowConversation from './MultiWindowConversation.vue';
import { useI18n } from '../i18n/index.ts';
import {
  detectSnapZone,
  snapRectFor,
  arrangeAutoLayout,
  clampWindowBounds,
  unshrinkLegacyBounds,
  MW_MIN_W,
  MW_MIN_H,
  type SnapZone,
} from '@forge/core/multiwin-layout';

/**
 * 多窗口画布（应用内多窗口，对应 PRD 02 SM-S05，TD-SM-02 方案 A）。
 *
 * 在单个视图内用绝对定位窗口模拟多窗口：从左侧会话池（HTML5 drag）拖入开窗，
 * 窗口可拖动（拖标题栏）、边缘/四角吸附、关闭回池、4 窗格排布。会话输出在
 * forge-core，窗口只是观察口。
 *
 * P3-C 打磨：
 * - 布局持久化：窗口位置/尺寸/所属会话写 localStorage，重进/重启画布恢复
 * - 会话删除自动关窗：外部 sessions 移除该会话时同步摘除窗口
 * - 最小窗口尺寸：开窗/拖动/缩放 clamp，避免小画布下挤压动画变形
 */
const props = defineProps<{
  /** 全部项目会话（会话池数据源） */
  sessions: SessionItem[];
  /** 可选模型列表（透传给窗口内对话输入，与单视图一致） */
  models: string[];
}>();

const emit = defineEmits<{
  (e: 'close'): void;
  (e: 'focus-session', sessionId: string): void;
  (e: 'opened-change', sessionIds: string[]): void;
}>();

const { t } = useI18n();

interface Win {
  id: string; // = sessionId
  sessionId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
}

const wins = ref<Win[]>([]);
let zCounter = 10;
const canvasRef = ref<HTMLElement | null>(null);
const snapPreview = ref<HTMLElement | null>(null);

// ===== P3-C：布局持久化（localStorage） =====
const LAYOUT_KEY = 'forge:multiwin:layout';

interface PersistedWin {
  sessionId: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 持久化布局：连同画布尺寸一起存，恢复时按比例缩放，避免画布尺寸变化后贴边/并排关系丢失 */
interface PersistedLayout {
  canvas?: { w: number; h: number };
  wins: PersistedWin[];
}

function saveLayout(): void {
  try {
    const canvas = canvasRef.value;
    const data: PersistedLayout = {
      canvas: canvas ? { w: canvas.clientWidth, h: canvas.clientHeight } : undefined,
      wins: wins.value.map((w) => ({
        sessionId: w.sessionId,
        x: w.x,
        y: w.y,
        w: w.w,
        h: w.h,
      })),
    };
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
  } catch {
    // 存储失败忽略（不影响运行）
  }
}

function loadLayout(): PersistedLayout {
  try {
    const raw = localStorage.getItem(LAYOUT_KEY);
    if (!raw) return { wins: [] };
    const parsed = JSON.parse(raw) as unknown;
    const isWin = (p: unknown): p is PersistedWin =>
      typeof p === 'object' &&
      p !== null &&
      typeof (p as PersistedWin).sessionId === 'string' &&
      typeof (p as PersistedWin).x === 'number' &&
      typeof (p as PersistedWin).y === 'number' &&
      typeof (p as PersistedWin).w === 'number' &&
      typeof (p as PersistedWin).h === 'number';
    // 旧格式：纯数组（无画布尺寸，恢复时不缩放）
    if (Array.isArray(parsed)) return { wins: parsed.filter(isWin) };
    if (typeof parsed === 'object' && parsed !== null && Array.isArray((parsed as PersistedLayout).wins)) {
      const layout = parsed as PersistedLayout;
      const canvas =
        typeof layout.canvas === 'object' &&
        layout.canvas !== null &&
        typeof layout.canvas.w === 'number' &&
        typeof layout.canvas.h === 'number' &&
        layout.canvas.w > 0 &&
        layout.canvas.h > 0
          ? { w: layout.canvas.w, h: layout.canvas.h }
          : undefined;
      return { canvas, wins: layout.wins.filter(isWin) };
    }
    return { wins: [] };
  } catch {
    return { wins: [] };
  }
}

/**
 * 恢复已持久化布局：仅在会话仍存在时开窗。
 * 画布尺寸与保存时不同则先等比缩放（与运行中 reflowOnResize 行为一致，
 * 保留贴边/并排关系），再按当前画布 clamp，避免越出画布/太小不可见。
 */
function restoreLayout(): void {
  const saved = loadLayout();
  if (saved.wins.length === 0) return;
  const cw = canvasRef.value?.clientWidth ?? 600;
  const ch = canvasRef.value?.clientHeight ?? 400;
  const sx = saved.canvas ? cw / saved.canvas.w : 1;
  const sy = saved.canvas ? ch / saved.canvas.h : 1;
  // 旧版 clamp 缺陷会把贴边满高/满宽窗口截短 2g 并持久化，先迁移还原再缩放
  const refW = saved.canvas?.w ?? cw;
  const refH = saved.canvas?.h ?? ch;
  for (const item of saved.wins) {
    if (!sessionOf(item.sessionId)) continue;
    const healed = unshrinkLegacyBounds(item, refW, refH);
    // 等比缩放后统一交给 clampWindowBounds：上界是画布边界本身，
    // 贴边满高窗口（h=ch）保持满高，底部不露缝隙
    const rect = clampWindowBounds(
      {
        x: Math.round(healed.x * sx),
        y: Math.round(healed.y * sy),
        w: Math.round(healed.w * sx),
        h: Math.round(healed.h * sy),
      },
      cw,
      ch,
    );
    openWindow(item.sessionId, rect.x, rect.y, { w: rect.w, h: rect.h });
  }
  // 恢复后写回一次（吸收 clamp 变更），并通知会话池
  saveLayout();
  emit('opened-change', wins.value.map((w) => w.sessionId));
}

// 当前画布上的会话 id 集合（会话池标记已开窗）
const onCanvasSessions = computed(() => new Set(wins.value.map((w) => w.sessionId)));

function sessionOf(id: string): SessionItem | undefined {
  return props.sessions.find((s) => s.sessionId === id);
}

function displayName(s: SessionItem): string {
  return s.alias || t('panels.multiwin.session', { id: s.sessionId.slice(-6) });
}

function projectNameOf(s: SessionItem): string {
  const parts = s.projectPath.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || s.projectPath;
}

// 开窗：默认随机散布（对齐原型，不整齐排列）；可传入指定位置与尺寸（如吸附矩形）
function openWindow(
  sessionId: string,
  x?: number,
  y?: number,
  size?: { w: number; h: number },
): void {
  if (wins.value.some((w) => w.sessionId === sessionId)) return;
  const cw = canvasRef.value?.clientWidth ?? 600;
  const ch = canvasRef.value?.clientHeight ?? 400;
  const w = Math.max(MW_MIN_W, Math.round((size?.w ?? cw * 0.46)));
  const h = Math.max(MW_MIN_H, Math.round((size?.h ?? ch * 0.46)));
  let px = x;
  let py = y;
  if (px === undefined || py === undefined) {
    // 无指定位置时随机散布（避免整齐排列）
    px = Math.random() * Math.max(0, cw - w - 20) + 10;
    py = Math.random() * Math.max(0, ch - h - 20) + 10;
  }
  px = Math.max(0, Math.min(px, Math.max(0, cw - w)));
  py = Math.max(0, Math.min(py, Math.max(0, ch - h)));
  wins.value.push({
    id: sessionId,
    sessionId,
    x: px,
    y: py,
    w,
    h,
    z: ++zCounter,
  });
  saveLayout();
}

function closeWindow(id: string): void {
  wins.value = wins.value.filter((w) => w.id !== id);
  saveLayout();
}

function focusWindow(id: string): void {
  const w = wins.value.find((x) => x.id === id);
  if (w) w.z = ++zCounter;
}

// 会话池拖入（HTML5 drag）
function onCanvasDragOver(e: DragEvent): void {
  e.preventDefault();
  // 拖拽悬停阶段：按指针位置显示吸附预览框，松开时在 drop 里真正贴边
  const canvas = canvasRef.value;
  const r = canvas?.getBoundingClientRect();
  if (!canvas || !r) return;
  const cx = e.clientX - r.left;
  const cy = e.clientY - r.top;
  const zone = detectSnapZone(cx, cy, canvas.clientWidth, canvas.clientHeight);
  if (zone) {
    showSnapPreview(snapRectFor(zone, canvas.clientWidth, canvas.clientHeight));
  } else {
    hideSnapPreview();
  }
}
function onCanvasDrop(e: DragEvent): void {
  e.preventDefault();
  const sid = e.dataTransfer?.getData('text/forge-session');
  if (!sid) return;
  const canvas = canvasRef.value;
  const r = canvas?.getBoundingClientRect();
  if (!canvas || !r) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  // 首次拖入同样判定吸附：落在边缘/四角区域内则直接贴边开窗
  const zone = detectSnapZone(px, py, cw, ch);
  if (zone) {
    const snap = snapRectFor(zone, cw, ch);
    openWindow(sid, snap.x, snap.y, { w: snap.w, h: snap.h });
  } else {
    // 窗口左上角对准 drop 点（略偏移，方便看到标题栏）
    const x = e.clientX - r.left - Math.round((r.width * 0.46) / 2);
    const y = e.clientY - r.top - 12;
    openWindow(sid, x, y);
  }
  // 松开后清理拖拽吸附预览
  hideSnapPreview();
}

// ===== 拖拽移动 + 吸附（几何计算复用 forge-core windowLayout 纯模块） =====
let dragging: {
  id: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  lastPx: number;
  lastPy: number;
} | null = null;

function onBarMouseDown(e: MouseEvent, w: Win): void {
  // 点标题栏内的按钮（眼睛/关闭）时不触发拖拽，避免 mouseup 时误吸附改变布局
  const target = e.target as HTMLElement | null;
  if (target && typeof target.closest === 'function' && target.closest('button')) return;
  e.preventDefault();
  focusWindow(w.id);
  const canvasRect = canvasRef.value?.getBoundingClientRect();
  dragging = {
    id: w.id,
    startX: e.clientX,
    startY: e.clientY,
    origX: w.x,
    origY: w.y,
    lastPx: canvasRect ? e.clientX - canvasRect.left : 0,
    lastPy: canvasRect ? e.clientY - canvasRect.top : 0,
  };
}

function onMove(e: MouseEvent): void {
  if (!dragging) return;
  const w = wins.value.find((x) => x.id === dragging!.id);
  const canvas = canvasRef.value;
  if (!w || !canvas) return;
  const dx = e.clientX - dragging!.startX;
  const dy = e.clientY - dragging!.startY;
  w.x = dragging!.origX + dx;
  w.y = dragging!.origY + dy;
  const r = canvas.getBoundingClientRect();
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const px = e.clientX - r.left;
  const py = e.clientY - r.top;
  dragging.lastPx = px;
  dragging.lastPy = py;
  const zone = detectSnapZone(px, py, cw, ch);
  if (zone) {
    showSnapPreview(snapRectFor(zone, cw, ch));
  } else {
    hideSnapPreview();
  }
}

function onUp(): void {
  if (!dragging) return;
  const w = wins.value.find((x) => x.id === dragging!.id);
  const canvas = canvasRef.value;
  if (w && canvas) {
    const cw = canvas.clientWidth;
    const ch = canvas.clientHeight;
    // 拖动结束统一 clamp（最小尺寸 + 画布边界）；满高窗口保持满高
    Object.assign(w, clampWindowBounds(w, cw, ch));
    const zone = detectSnapZone(dragging.lastPx, dragging.lastPy, cw, ch);
    if (zone) {
      Object.assign(w, snapRectFor(zone, cw, ch));
    }
    saveLayout();
  }
  hideSnapPreview();
  dragging = null;
}

function showSnapPreview(r: { x: number; y: number; w: number; h: number }): void {
  const el = snapPreview.value;
  if (!el) return;
  Object.assign(el.style, {
    display: 'block',
    left: r.x + 'px',
    top: r.y + 'px',
    width: r.w + 'px',
    height: r.h + 'px',
  });
}
function hideSnapPreview(): void {
  const el = snapPreview.value;
  if (el) el.style.display = 'none';
}

/**
 * 自动布局：按当前窗口个数自动铺满（几何复用 forge-core arrangeAutoLayout）。
 * 窗口按序应用布局矩形；对已存在的窗口保留 id/会话绑定，仅更新几何。
 */
function arrangeAuto(): void {
  const canvas = canvasRef.value;
  if (!canvas || wins.value.length === 0) return;
  const layouts = arrangeAutoLayout(
    wins.value.length,
    canvas.clientWidth,
    canvas.clientHeight,
  );
  wins.value.forEach((w, i) => {
    const cell = layouts[i];
    if (cell) Object.assign(w, cell);
  });
  saveLayout();
}

/** 全部关闭：清空窗口列表（会话不删，仅摘展示） */
function clearAll(): void {
  wins.value = [];
  saveLayout();
}

function onWinClick(e: MouseEvent, w: Win): void {
  focusWindow(w.id);
}
function goSession(w: Win): void {
  emit('focus-session', w.sessionId);
}

// 全局鼠标监听
function onDocMouseMove(e: MouseEvent): void {
  onMove(e);
}
function onDocMouseUp(): void {
  onUp();
}

// 开窗集合变化时通知外部（让会话池标记已开窗为灰）
watch(
  wins,
  (list) => {
    emit('opened-change', list.map((w) => w.sessionId));
  },
  { deep: true },
);

// P3-C：外部会话被删除时自动关闭对应窗口（避免残留会话已消失的窗口）
watch(
  () => props.sessions.map((s) => s.sessionId),
  (ids) => {
    const alive = new Set(ids);
    if (wins.value.some((w) => !alive.has(w.sessionId))) {
      wins.value = wins.value.filter((w) => alive.has(w.sessionId));
      saveLayout();
    }
  },
);

// ===== 画布尺寸变化：按比例缩放各窗口，让布局随窗口铺满 =====
let resizeObserver: ResizeObserver | null = null;
let traceCw = 0;
let traceCh = 0;

function reflowOnResize(): void {
  const canvas = canvasRef.value;
  if (!canvas) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (traceCw <= 0 || traceCh <= 0 || wins.value.length === 0) {
    traceCw = cw;
    traceCh = ch;
    return;
  }
  const sx = cw / traceCw;
  const sy = ch / traceCh;
  // 比例近似不变（仅因内边距微差）时不做无意义的缩放
  if (Math.abs(sx - 1) < 0.005 && Math.abs(sy - 1) < 0.005) {
    traceCw = cw;
    traceCh = ch;
    return;
  }
  wins.value.forEach((w) => {
    w.x = Math.round(w.x * sx);
    w.y = Math.round(w.y * sy);
    w.w = Math.max(MW_MIN_W, Math.round(w.w * sx));
    w.h = Math.max(MW_MIN_H, Math.round(w.h * sy));
  });
  traceCw = cw;
  traceCh = ch;
}

onMounted(() => {
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
  // P3-C：先恢复持久化布局（会话仍存在的窗口），再同步会话池状态
  restoreLayout();
  // 初始同步一次
  emit('opened-change', wins.value.map((w) => w.sessionId));
  // 监听画布尺寸变化做等比例铺满
  const canvas = canvasRef.value;
  if (canvas) {
    traceCw = canvas.clientWidth;
    traceCh = canvas.clientHeight;
    resizeObserver = new ResizeObserver(reflowOnResize);
    resizeObserver.observe(canvas);
  }
});
onUnmounted(() => {
  document.removeEventListener('mousemove', onDocMouseMove);
  document.removeEventListener('mouseup', onDocMouseUp);
  resizeObserver?.disconnect();
  resizeObserver = null;
});

// 顶部工具栏「自动布局 / 全部关闭」按钮通过 ref 调用
defineExpose({ arrangeAuto, clearAll });
</script>

<template>
  <div class="mw-view">
    <div
      ref="canvasRef"
      class="mw-canvas"
      @dragover.prevent="onCanvasDragOver"
      @drop="onCanvasDrop"
    >
      <div class="mw-hint" v-if="wins.length === 0">
        {{ t('panels.multiwin.canvasHint') }}
      </div>
      <div ref="snapPreview" class="snap-preview"></div>

      <div
        v-for="w in wins"
        :key="w.id"
        class="mw-win"
        :style="{ left: w.x + 'px', top: w.y + 'px', width: w.w + 'px', height: w.h + 'px', zIndex: w.z }"
        @mousedown="onWinClick($event, w)"
      >
        <div class="mw-bar" @mousedown.stop="onBarMouseDown($event, w)">
          <div class="mw-title">
            <b>{{ sessionOf(w.sessionId) ? displayName(sessionOf(w.sessionId)!) : t('panels.multiwin.sessionFallback') }}</b>
            <span v-if="sessionOf(w.sessionId)" class="mw-proj">{{ projectNameOf(sessionOf(w.sessionId)!) }}</span>
          </div>
          <button
            class="mw-icon-btn"
            :title="t('panels.multiwin.openInSingle')"
            :data-tooltip="t('panels.multiwin.openInSingle')"
            @click.stop="goSession(w)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button class="mw-close" :title="t('panels.multiwin.closeWindow')" :data-tooltip="t('panels.multiwin.closeWindow')" @click.stop="closeWindow(w.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div class="mw-body">
          <MultiWindowConversation
            :session-id="w.sessionId"
            :session="sessionOf(w.sessionId) ?? null"
            :models="models"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.mw-view {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 16px;
}

.mw-canvas {
  flex: 1;
  min-height: 0;
  position: relative;
  border: 1px dashed var(--border);
  border-radius: var(--radius-lg);
  background: color-mix(in oklab, var(--muted) 8%, var(--card));
  overflow: hidden;
}
.mw-canvas::before {
  content: '';
  position: absolute;
  inset: 0;
  opacity: 0.3;
  pointer-events: none;
  background-image:
    linear-gradient(var(--border) 1px, transparent 1px),
    linear-gradient(90deg, var(--border) 1px, transparent 1px);
  background-size: 48px 48px;
}

.mw-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--muted-foreground);
  font-size: 12px;
  pointer-events: none;
  padding: 16px;
  text-align: center;
}

.mw-win {
  position: absolute;
  min-width: 0;
  min-height: 0;
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: 11px;
  box-shadow: var(--shadow-lg);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.mw-bar {
  height: 30px;
  flex: 0 0 30px;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 8px;
  background: color-mix(in oklab, var(--muted) 35%, var(--card));
  border-bottom: 1px solid var(--border);
  cursor: grab;
  user-select: none;
}
.mw-bar:active {
  cursor: grabbing;
}
.mw-title {
  font-size: 11px;
  color: var(--muted-foreground);
  font-weight: 500;
  flex: 1;
  min-width: 0;
  display: flex;
  align-items: center;
  gap: 6px;
}
.mw-title b {
  color: var(--foreground);
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mw-proj {
  flex-shrink: 0;
  max-width: 60%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 10px;
  font-weight: 400;
  color: var(--muted-foreground);
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 999px;
  background: color-mix(in oklab, var(--muted) 30%, transparent);
}
.mw-icon-btn {
  width: 20px;
  height: 20px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--muted-foreground);
}
.mw-icon-btn:hover {
  background: var(--muted);
  color: var(--brand);
}

/* 暗色 --brand 接近纯白，图标瞬间变纯白太亮；保留 hover 反馈但降到 70% mix。
   light 不动。ponytail: 想再亮改 80、再压改 60。 */
:root[data-theme='dark'] .mw-icon-btn:hover {
  color: color-mix(in oklab, var(--brand) 70%, transparent);
}
.mw-icon-btn svg {
  width: 13px;
  height: 13px;
}
.mw-close {
  width: 20px;
  height: 20px;
  padding: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 50%;
  color: var(--muted-foreground);
}
.mw-close:hover {
  background: var(--destructive);
  color: #fff;
  border-color: transparent;
}
.mw-close svg {
  width: 12px;
  height: 12px;
}

.mw-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
  padding: 0;
  display: flex;
}

/* 窗口内会话视图根（ConversationView 根节点）：flex row 子项默认 min-width:auto，
   长行内容（超长 token/URL/代码行）的 min-content 会把整列撑宽越出窗口右缘，
   右下角的上下文用量+发送按钮被裁掉不可见（旧壳层同款防御，v3.43 合并后由本规则承接） */
.mw-body > * {
  min-width: 0;
  min-height: 0;
}

.snap-preview {
  position: absolute;
  display: none;
  border: 2px dashed var(--brand);
  background: color-mix(in oklab, var(--brand) 14%, transparent);
  border-radius: 11px;
  pointer-events: none;
  z-index: 999;
}
</style>