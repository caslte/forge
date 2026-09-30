// 全局单例 tooltip（data-tooltip 属性触发）。
//
// 为什么不用纯 CSS（[data-tooltip]:hover::after + position: fixed）：
// fixed 伪元素未设置 top/left 时依赖"静态位置"定位，而该位置在滚动容器内是按
// 内容坐标系计算的，fixed 又不受祖先滚动偏移影响 —— 项目列表一滚动，tooltip
// 就整体向下偏移恰好等于 scrollTop，黑框会飘到侧边栏底部。
// 这里改为 mouseover 事件委托 + getBoundingClientRect 视口定位，天然免疫滚动偏移。
//
// 行为约定（与旧 CSS 版本保持一致）：
// - 仅 hover 触发（不做 focus 触发，避免点击后焦点残留导致 tooltip 常驻）；
// - 黑底白字、出现在锚点上方 8px，顶部放不下时翻到下方，水平夹紧在视口内；
// - 任意滚动时隐藏（fixed 定位不随内容滚动，留在原地只会盖住内容）。

const TIP_GAP = 8;
const EDGE = 4;

const tip = document.createElement('div');
tip.className = 'global-tooltip';
tip.setAttribute('role', 'tooltip');
tip.setAttribute('aria-hidden', 'true');
document.body.appendChild(tip);

let anchor: Element | null = null;

// 锚点停留在原地点击切换状态（如终端配色档三态循环）时，data-tooltip 属性变了
// 但不会有 mousemove/mouseover 再来重读——用 observer 让在显文案跟着属性走。
const tipTextObserver = new MutationObserver(() => {
  if (anchor === null) return;
  const text = anchor.getAttribute('data-tooltip');
  if (text) tip.textContent = text;
  else hide();
});

function setAnchor(target: Element, text: string): void {
  anchor = target;
  tip.textContent = text;
  tipTextObserver.disconnect();
  tipTextObserver.observe(target, { attributes: true, attributeFilter: ['data-tooltip'] });
}

function hide(): void {
  anchor = null;
  tipTextObserver.disconnect();
  tip.classList.remove('is-visible');
}

function place(): void {
  if (!anchor) return;
  const r = anchor.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) {
    hide();
    return;
  }
  const halfW = tip.offsetWidth / 2;
  const tipH = tip.offsetHeight;
  // 上方放不下（贴近视口顶部）时翻到锚点下方
  const below = r.top - TIP_GAP - tipH < EDGE;
  const top = below ? r.bottom + TIP_GAP : r.top - TIP_GAP - tipH;
  const center = r.left + r.width / 2;
  // left 夹取后减去半宽：transform 平移的是盒子左上角，需自行居中
  const left = Math.min(Math.max(center, halfW + EDGE), window.innerWidth - halfW - EDGE);
  tip.style.transform = `translate(${left - halfW}px, ${top}px)`;
}

window.addEventListener('mouseover', (e) => {
  const target = (e.target as Element | null)?.closest?.('[data-tooltip]');
  if (!target || target === anchor) return;
  const text = target.getAttribute('data-tooltip');
  if (!text) {
    hide();
    return;
  }
  setAnchor(target, text);
  place();
  tip.classList.add('is-visible');
}, true);

// mousemove 兜底：快速甩鼠标时 Chrome 会合并边界事件（mouseover 可能不派发到
// 最终落点，尤其落点是 hover 才恢复 pointer-events 的按钮），锚点会滞留在半路
// 经过带上一个元素上。mousemove 按最终位置重解析锚点，任何微小移动都能自愈。
window.addEventListener('mousemove', (e) => {
  const target = (e.target as Element | null)?.closest?.('[data-tooltip]');
  if (target === anchor) return;
  if (!target || !target.getAttribute('data-tooltip')) {
    hide();
    return;
  }
  setAnchor(target, target.getAttribute('data-tooltip') ?? '');
  place();
  tip.classList.add('is-visible');
}, true);

window.addEventListener('mouseout', (e) => {
  if (!anchor) return;
  const related = e.relatedTarget as Node | null;
  if (related && anchor.contains(related)) return; // 仍在同一锚点内部移动
  hide();
}, true);

window.addEventListener('scroll', () => hide(), true);
window.addEventListener('resize', () => place());
