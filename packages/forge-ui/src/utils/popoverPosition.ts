/**
 * 浮窗定位纯函数（CV-S06，AC-CV-018）。
 *
 * 设计约束（docs/prd/03_conversation.md「CV-S06 会话历史导航」）：
 * - 纯 TS、零运行时依赖（无任何 import），Node type stripping 可直跑；
 * - 纯函数：同输入同输出，不读写全局、不持有可变状态；
 * - 定位规则（U-CV-007 / AC-CV-018）：
 *   1. 右侧空间足 → 右弹（x=锚点右缘+margin），垂直随锚点顶对齐；
 *   2. 右侧不足 → 翻左侧（x=锚点左缘-margin-浮窗宽）；
 *   3. 垂直越界（贴上/下缘）→ 夹取进视口；浮窗高超过视口可用高 → 贴顶；
 *   4. 两侧都放不下（极窄视口）→ 宽度收拢至较大可用侧的最大可用宽（并列取右）；
 *   5. 输出恒在视口内（含 margin）；0 宽/0 高锚点等退化输入不产生 NaN/Infinity。
 * - 矩形统一用 {x,y,width,height}（锚点传 getBoundingClientRect 的视口坐标，
 *   视口传 {x:0,y:0,width:innerWidth,height:innerHeight}）。
 */

/** 矩形（视口/锚点均用此结构） */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 浮窗尺寸 */
export interface PopoverSize {
  width: number;
  height: number;
}

/** 求解结果：placement 为弹出侧；width 为实际落位宽度（极窄视口可能小于请求宽） */
export interface PopoverPlacement {
  x: number;
  y: number;
  width: number;
  placement: 'right' | 'left';
}

/** 非有限数值归零（畸形输入不产生 NaN/Infinity） */
function finiteOr(value: number, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** 负数归零（尺寸/可用空间不为负） */
function nonNegative(value: number): number {
  return Math.max(0, value);
}

/**
 * 求解浮窗落位（AC-CV-018）：
 * @param anchor    锚点矩形（条目 getBoundingClientRect，视口坐标）
 * @param popover   浮窗期望尺寸（width≈320；height 可传测量值或名义值）
 * @param viewport  视口矩形（window.innerWidth/innerHeight）
 * @param margin    浮窗与视口边缘/锚点的间距（默认 8px）
 */
export function solvePopoverPosition(
  anchor: Rect,
  popover: PopoverSize,
  viewport: Rect,
  margin: number = 8,
): PopoverPlacement {
  const m = finiteOr(margin, 8);
  const ax = finiteOr(anchor.x);
  const ay = finiteOr(anchor.y);
  const aw = nonNegative(finiteOr(anchor.width));
  const pw = nonNegative(finiteOr(popover.width));
  const ph = nonNegative(finiteOr(popover.height));
  const vx = finiteOr(viewport.x);
  const vy = finiteOr(viewport.y);
  const vw = nonNegative(finiteOr(viewport.width));
  const vh = nonNegative(finiteOr(viewport.height));

  const anchorRight = ax + aw;
  const viewportRight = vx + vw;
  const viewportBottom = vy + vh;

  // 视口内最大可用宽（左右各留 margin）
  const innerMaxWidth = nonNegative(vw - 2 * m);
  // 右侧可用宽：锚点右缘+margin → 视口右缘-margin（锚点底缘越界时按 0 处理，见下方夹取）
  const rightAvail = anchorRight <= viewportRight ? viewportRight - m - (anchorRight + m) : 0;
  // 左侧可用宽：视口左缘+margin → 锚点左缘-margin
  const leftAvail = ax >= vx ? ax - m - (vx + m) : 0;

  let placement: 'right' | 'left';
  let width: number;
  let x: number;
  if (rightAvail >= pw) {
    // 1. 右侧空间足 → 右弹
    placement = 'right';
    width = pw;
    x = anchorRight + m;
  } else if (leftAvail >= pw) {
    // 2. 右侧不足 → 翻左侧
    placement = 'left';
    width = pw;
    x = ax - m - pw;
  } else {
    // 3. 两侧都放不下 → 收拢至较大可用侧的最大可用宽（并列取右），不超过视口内宽
    placement = rightAvail >= leftAvail ? 'right' : 'left';
    width = Math.min(nonNegative(placement === 'right' ? rightAvail : leftAvail), innerMaxWidth);
    x = placement === 'right' ? anchorRight + m : ax - m - width;
  }

  // 退化修正：x 夹进视口左界；右越界（锚点越出视口右缘等）则收拢宽度，保证恒在视口内
  const xMin = vx + m;
  if (x < xMin) x = xMin;
  const maxRight = viewportRight - m;
  if (x + width > maxRight) width = nonNegative(maxRight - x);

  // 垂直：随锚点顶对齐，越界夹取进视口；浮窗高超过视口可用高时贴顶（不产生负 y）
  const yMin = vy + m;
  const yMax = viewportBottom - m - ph;
  const y = yMax < yMin ? yMin : Math.min(Math.max(ay, yMin), yMax);

  return { x, y, width, placement };
}
