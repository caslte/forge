// 选区复制浮窗（CV-S13）：消息气泡/代码纸里选中文字后弹出「复制文本」小浮窗。
//
// 与 tooltip.ts 同款全局单例模式（main.ts 引入即生效）：
// - fixed + transform 视口坐标定位，免疫滚动容器偏移（同 tooltip.ts 头注的坐标系问题）；
// - 样式在 global.css（.selection-pop），反色底抄全局 tooltip（--foreground 底 / --background 字）；
// - 任意滚动即隐（fixed 留原地会盖住内容，同款口径）。
//
// 行为定稿（prototypes/selection-copy-demo.html，2026-09-29 用户选变体 B）：
// - 仅**已登记的区域**触发（见 SELECTABLE_REGIONS）：终端选区有 xterm 自己的 Ctrl+C/右键复制，
//   画布 iframe 事件不回传，均天然不冲突；而应用外壳（签条、面包屑、按钮）不该弹复制按钮。
// - 两种触发**各用各的锚点**：拖选松开鼠标 → 浮在选区上方；右键 → 落在光标处
//   （与 ContextMenu 同口径）。右键不能走选区锚点，见 placeAtPoint 的注释。
// - 复制 → 「已复制」打勾 1.4s → 收起并清空选区；
// - 重新按下鼠标 / Escape / 滚动 → 立即收起。
import { watch } from 'vue';
import { i18n } from './i18n/index.ts';

const GAP = 8;
const EDGE = 8;
const COPIED_FEEDBACK_MS = 1400;

/**
 * 允许触发复制浮窗的选区区域。
 *
 * 刻意是**清单**而不是「页面里任何文本」：终端由 xterm 自己管复制、画布 iframe 的事件
 * 不回传，而应用外壳（标签条 / 面包屑 / 按钮文案）选中后弹「复制文本」只会让人意外。
 * 新增可复制区域时往这里加一条，并确认该区域自己开了 `user-select: text`
 * ——全站 body 是 `user-select: none`，不显式开口就选不中（代码纸就踩过这个坑）。
 */
const SELECTABLE_REGIONS = ['.msg', '.cv-pre'] as const;

function inSelectableRegion(el: Element | null): boolean {
  return !!el && SELECTABLE_REGIONS.some((sel) => el.closest(sel));
}

/** 事件/选区落点转成可判定的元素（文本节点取父元素，null 原样传） */
function elementOf(node: Node | null): Element | null {
  if (!node) return null;
  return node.nodeType === 1 ? (node as Element) : node.parentElement;
}

const ICON_COPY =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></svg>';
const ICON_DONE =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="display:none"><polyline points="20 6 9 17 4 12" /></svg>';

const pop = document.createElement('div');
pop.className = 'selection-pop';
pop.setAttribute('aria-hidden', 'true');
const btn = document.createElement('button');
btn.type = 'button';
btn.className = 'selection-pop-btn';
btn.innerHTML = `${ICON_COPY}${ICON_DONE}<span></span>`;
pop.appendChild(btn);
document.body.appendChild(pop);

const labelEl = btn.querySelector('span') as HTMLSpanElement;
const iconCopy = btn.querySelector('svg') as SVGElement;
const iconDone = btn.querySelectorAll('svg')[1] as SVGElement;

let selectedText = '';
let copiedTimer: ReturnType<typeof setTimeout> | null = null;

function resetLabel(): void {
  if (copiedTimer) clearTimeout(copiedTimer);
  copiedTimer = null;
  labelEl.textContent = i18n.t('chat.copySelection');
  iconCopy.style.display = '';
  iconDone.style.display = 'none';
}

function hide(): void {
  pop.classList.remove('is-visible');
  pop.setAttribute('aria-hidden', 'true');
  resetLabel();
}

/** 当前选区的视口矩形；无选区/塌陷/零尺寸返回 null */
function selectionRect(): DOMRect | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const rect = sel.getRangeAt(0).getBoundingClientRect();
  return rect.width === 0 && rect.height === 0 ? null : rect;
}

/** 选区的文本与锚点元素；空/纯空白选区返回 null。mouseup 与 contextmenu 两条触发路径共用 */
function readSelection(): { text: string; anchorEl: Element | null } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const text = sel.toString().trim();
  if (!text) return null;
  return { text, anchorEl: elementOf(sel.anchorNode) };
}

function show(): void {
  resetLabel();
  pop.classList.add('is-visible');
  pop.setAttribute('aria-hidden', 'false');
}

function place(rect: DOMRect): void {
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  // 上方放不下（贴近视口顶部）时翻到选区下方；水平居中于选区并夹紧在视口内
  const below = rect.top - GAP - h < EDGE;
  const top = below ? rect.bottom + GAP : rect.top - GAP - h;
  const center = rect.left + rect.width / 2;
  const left = Math.min(Math.max(center, w / 2 + EDGE), window.innerWidth - w / 2 - EDGE);
  pop.style.transform = `translate(${left - w / 2}px, ${top}px)`;
}

/**
 * 右键路径的落点：浮窗左上角贴在光标处，贴边时钳进视口（与 ContextMenu 同一套落位口径）。
 *
 * 刻意不复用 place()：Ctrl+A 的选区矩形是**整篇文档**那么高（代码纸 310 行 ≈ 7000px，
 * 且上下都超出视口），「选区上方 8px 居中」算出来落在屏幕外——表现就是右键弹了但看不见。
 */
function placeAtPoint(x: number, y: number): void {
  const w = pop.offsetWidth;
  const h = pop.offsetHeight;
  const left = Math.min(x, window.innerWidth - w - EDGE);
  const top = Math.min(y, window.innerHeight - h - EDGE);
  pop.style.transform = `translate(${Math.max(EDGE, left)}px, ${Math.max(EDGE, top)}px)`;
}

document.addEventListener('mouseup', (e) => {
  // 只认主键。右键抬起时选区没变，而这次 mouseup 会跟在 contextmenu 之后把浮窗从
  // 光标处搬回「选区上方」——Ctrl+A 那一搬就把刚弹出来的浮窗搬出了视口。
  if (e.button !== 0) return;
  // mouseup 时 Chrome 选区已稳定，setTimeout 只是兜住个别引擎的收尾时序
  setTimeout(() => {
    const found = readSelection();
    if (!found || !inSelectableRegion(found.anchorEl)) {
      hide();
      return;
    }
    const rect = selectionRect();
    if (!rect) {
      hide();
      return;
    }
    selectedText = found.text;
    place(rect);
    show();
  }, 0);
});

document.addEventListener('contextmenu', (e) => {
  // 落在浮窗上（含「已复制」反馈态）不重开，让那一轮反馈走完
  if (pop.contains(e.target as Node | null)) return;
  const found = readSelection();
  if (!found || !inSelectableRegion(found.anchorEl)) return;
  // 右键点本身也要在登记区域内：选区还在代码纸上、鼠标却点到签条/面包屑时不该弹
  // （外壳元素自己 @contextmenu.prevent 掉了菜单，事件仍会冒泡到这里）
  if (!inSelectableRegion(elementOf(e.target as Node | null))) return;
  e.preventDefault();
  selectedText = found.text;
  placeAtPoint(e.clientX, e.clientY);
  show();
});

btn.addEventListener('click', async (e) => {
  e.stopPropagation();
  try {
    await navigator.clipboard.writeText(selectedText);
  } catch {
    // 剪贴板 API 失败（焦点丢失/权限）回退 execCommand，与 SettingsPanel 复制日志同款兜底
    const ta = document.createElement('textarea');
    ta.value = selectedText;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  labelEl.textContent = i18n.t('chat.copied');
  iconCopy.style.display = 'none';
  iconDone.style.display = '';
  copiedTimer = setTimeout(() => {
    hide();
    window.getSelection()?.removeAllRanges();
  }, COPIED_FEEDBACK_MS);
});

document.addEventListener('scroll', hide, true);
document.addEventListener('mousedown', (e) => {
  if (!pop.contains(e.target as Node)) hide();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hide();
    window.getSelection()?.removeAllRanges();
  }
});

// 浮窗常驻期间切语言：文案跟着走（已复制反馈态不覆盖，1.4s 后自然复位）
watch(i18n.activeLocale, () => {
  if (pop.classList.contains('is-visible') && !copiedTimer) {
    labelEl.textContent = i18n.t('chat.copySelection');
  }
});
