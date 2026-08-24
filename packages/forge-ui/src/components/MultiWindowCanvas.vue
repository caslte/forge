<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from 'vue';
import type { SessionItem } from '../types';
import MultiWindowConversation from './MultiWindowConversation.vue';

/**
 * 多窗口画布（应用内多窗口，对应 PRD 02 SM-S05，TD-SM-02 方案 A）。
 *
 * 在单个视图内用绝对定位窗口模拟多窗口：从左侧会话池（HTML5 drag）拖入开窗，
 * 窗口可拖动（拖标题栏）、边缘/四角吸附、关闭回池、4 窗格排布。会话输出在
 * forge-core，窗口只是观察口（附件逻辑留待，MVP 显示会话信息占位）。
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
/** 画布内边距（吸附/排布统一间距，对齐原型 G） */
const G = 4;
const canvasRef = ref<HTMLElement | null>(null);
const snapPreview = ref<HTMLElement | null>(null);

// 当前画布上的会话 id 集合（会话池标记已开窗）
const onCanvasSessions = computed(() => new Set(wins.value.map((w) => w.sessionId)));

function sessionOf(id: string): SessionItem | undefined {
  return props.sessions.find((s) => s.sessionId === id);
}

function displayName(s: SessionItem): string {
  return s.alias || '会话 ' + s.sessionId.slice(-6);
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
  const w = size?.w ?? Math.round(cw * 0.46);
  const h = size?.h ?? Math.round(ch * 0.46);
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
}

function closeWindow(id: string): void {
  wins.value = wins.value.filter((w) => w.id !== id);
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
  const zone = detectZone(cx, cy, canvas.clientWidth, canvas.clientHeight);
  if (zone) {
    showSnapPreview(snapRect(zone, canvas.clientWidth, canvas.clientHeight));
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
  const zone = detectZone(px, py, cw, ch);
  if (zone) {
    const snap = snapRect(zone, cw, ch);
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

// ===== 拖拽移动 + 吸附（对齐原型 mwDetectZone + mwSnapRect） =====
type Zone = 'left' | 'right' | 'top' | 'bottom' | 'tl' | 'tr' | 'bl' | 'br';
let dragging: {
  id: string;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  lastPx: number;
  lastPy: number;
} | null = null;

/** 吸附区（指针相对画布比例阈值：四角 0.13、边缘 0.16，对齐原型） */
function detectZone(px: number, py: number, cw: number, ch: number): Zone | null {
  if (px < 0 || py < 0 || px > cw || py > ch) return null;
  const rx = px / cw;
  const ry = py / ch;
  const CT = 0.13;
  const ET = 0.16;
  // 四角区收窄，避免"覆盖整条"被误判为四分之一窗格
  if (rx < CT && ry < CT) return 'tl';
  if (rx > 1 - CT && ry < CT) return 'tr';
  if (rx < CT && ry > 1 - CT) return 'bl';
  if (rx > 1 - CT && ry > 1 - CT) return 'br';
  if (rx < ET) return 'left';
  if (rx > 1 - ET) return 'right';
  if (ry < ET) return 'top';
  if (ry > 1 - ET) return 'bottom';
  return null;
}

/** 吸附矩形（带 G=6 内边距，对齐原型 mwSnapRect） */
function snapRect(zone: Zone, cw: number, ch: number): { x: number; y: number; w: number; h: number } {
  const hw = Math.round((cw - G * 3) / 2);
  const hh = Math.round((ch - G * 3) / 2);
  const L = G;
  const R = G * 2 + hw;
  const T = G;
  const B = G * 2 + hh;
  switch (zone) {
    case 'left':
      return { x: L, y: T, w: hw, h: ch - G * 2 };
    case 'right':
      return { x: R, y: T, w: hw, h: ch - G * 2 };
    case 'top':
      return { x: L, y: T, w: cw - G * 2, h: hh };
    case 'bottom':
      return { x: L, y: B, w: cw - G * 2, h: hh };
    case 'tl':
      return { x: L, y: T, w: hw, h: hh };
    case 'tr':
      return { x: R, y: T, w: hw, h: hh };
    case 'bl':
      return { x: L, y: B, w: hw, h: hh };
    case 'br':
      return { x: R, y: B, w: hw, h: hh };
  }
}

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
  const zone = detectZone(px, py, cw, ch);
  if (zone) {
    showSnapPreview(snapRect(zone, cw, ch));
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
    const zone = detectZone(dragging.lastPx, dragging.lastPy, cw, ch);
    if (zone) {
      Object.assign(w, snapRect(zone, cw, ch));
    }
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
 * 自动布局：按当前窗口个数自动铺满，间距与手动贴边（G）统一。
 * - 1 个：占左右二分之一（左半区）
 * - 2 个：左右各二分之一（整高）
 * - 3~4 个：四窗格（2×2）
 * - 超过 4 个：前 4 个填四窗格，其余居中散放交由用户手动调整
 */
function arrangeAuto(): void {
  const canvas = canvasRef.value;
  if (!canvas || wins.value.length === 0) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const n = wins.value.length;
  const hw = Math.round((cw - G * 3) / 2);
  const hh = Math.round((ch - G * 3) / 2);
  const L = G;
  const T = G;
  const R = G * 2 + hw;
  const B = G * 2 + hh;
  if (n <= 2) {
    const halves = [
      { x: L, y: T, w: hw, h: ch - G * 2 },
      { x: R, y: T, w: hw, h: ch - G * 2 },
    ];
    wins.value.forEach((w, i) => i < n && Object.assign(w, halves[i]));
  } else {
    const cells = [
      { x: L, y: T, w: hw, h: hh },
      { x: R, y: T, w: hw, h: hh },
      { x: L, y: B, w: hw, h: hh },
      { x: R, y: B, w: hw, h: hh },
    ];
    wins.value.forEach((w, i) => {
      if (i < 4) {
        Object.assign(w, cells[i]);
      } else {
        // 第 5 个起居中散放，交用户手动调整
        const ox = Math.round((cw - hw) / 2) + ((i - 4) % 3) * 18;
        const oy = Math.round((ch - hh) / 2) + Math.floor((i - 4) / 3) * 14;
        Object.assign(w, { x: ox, y: oy, w: hw, h: hh });
      }
    });
  }
}

/** 全部关闭：清空窗口列表（会话不删，仅摘展示） */
function clearAll(): void {
  wins.value = [];
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
    w.w = Math.max(120, Math.round(w.w * sx));
    w.h = Math.max(80, Math.round(w.h * sy));
  });
  traceCw = cw;
  traceCh = ch;
}

onMounted(() => {
  document.addEventListener('mousemove', onDocMouseMove);
  document.addEventListener('mouseup', onDocMouseUp);
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
</script>

<template>
  <div class="mw-view">
    <div class="mw-toolbar">
      <button class="mw-btn" @click="arrangeAuto">自动布局</button>
      <button class="mw-btn danger" @click="clearAll">
        全部关闭
      </button>
      <span class="mw-hints">从左侧会话拖到画布开窗 · 拖标题栏贴边吸附 · 点标题进会话</span>
    </div>

    <div
      ref="canvasRef"
      class="mw-canvas"
      @dragover.prevent="onCanvasDragOver"
      @drop="onCanvasDrop"
    >
      <div class="mw-hint" v-if="wins.length === 0">
        把左侧会话拖到画布开窗，多个会话可并排观察。
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
            <b>{{ sessionOf(w.sessionId) ? displayName(sessionOf(w.sessionId)!) : '会话' }}</b>
            <span v-if="sessionOf(w.sessionId)" class="mw-proj">{{ projectNameOf(sessionOf(w.sessionId)!) }}</span>
          </div>
          <button
            class="mw-icon-btn"
            title="在单视图打开"
            data-tooltip="在单视图打开"
            @click.stop="goSession(w)"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
            </svg>
          </button>
          <button class="mw-close" title="关闭窗口" data-tooltip="关闭窗口" @click.stop="closeWindow(w.id)">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        </div>
        <div class="mw-body">
          <MultiWindowConversation :session-id="w.sessionId" :models="models" />
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

.mw-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  flex-shrink: 0;
}
.mw-btn {
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: var(--muted);
  border: 1px solid var(--border);
  color: var(--foreground);
}
.mw-btn:hover {
  border-color: var(--brand);
  color: var(--brand);
}
.mw-btn.danger {
  background: color-mix(in oklab, var(--destructive) 8%, var(--background));
  border-color: color-mix(in oklab, var(--destructive) 24%, var(--border));
  color: var(--destructive);
}
.mw-hints {
  margin-left: auto;
  font-size: 11px;
  color: var(--muted-foreground);
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