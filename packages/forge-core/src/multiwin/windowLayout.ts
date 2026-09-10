/**
 * 多窗口画布几何计算（P3-C）。
 *
 * 把 MultiWindowCanvas 的吸附区判定、吸附矩形、自动排布抽为纯函数，供 UI 引用，
 * 并在 forge-core 以 node:test 回归（对齐 buildSideBySideDiff 先例；E-SM-005 的
 * 吸附 8 区 / 4 窗格 / 最小尺寸核心断言落在这里）。
 *
 * 纯 Node 模块：不 import Electron / Vue / pi。
 */

/** 画布统一内边距（吸附/排布间距） */
export const MW_GAP = 4;

/** 窗口最小尺寸（防小画布下挤压变形） */
export const MW_MIN_W = 180;
export const MW_MIN_H = 120;

/** 吸附区：四角 + 四边 */
export type SnapZone = 'left' | 'right' | 'top' | 'bottom' | 'tl' | 'tr' | 'bl' | 'br';

export interface SnapRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 吸附区判定：指针相对画布比例阈值（四角 0.13、边缘 0.16）。
 * @param px 指针相对画布左上角 x
 * @param py 指针相对画布左上角 y
 * @param cw 画布宽
 * @param ch 画布高
 * @returns 命中吸附区；指针在画布外返回 null
 */
export function detectSnapZone(px: number, py: number, cw: number, ch: number): SnapZone | null {
  if (px < 0 || py < 0 || px > cw || py > ch) return null;
  const rx = px / cw;
  const ry = py / ch;
  const CT = 0.13;
  const ET = 0.16;
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

/**
 * 吸附矩形：按吸附区计算铺满矩形。贴边窗口完全覆盖画布边缘（不留缝隙露出画布背景），
 * 仅在窗口与窗口之间保留统一间距 MW_GAP。
 * @param zone 吸附区
 * @param cw 画布宽
 * @param ch 画布高
 */
export function snapRectFor(zone: SnapZone, cw: number, ch: number): SnapRect {
  const g = MW_GAP;
  // hw/hh = 单窗贴边占满后的半区尺寸；两边都贴边，中间仅留 g 间距
  const hw = Math.round((cw - g) / 2);
  const hh = Math.round((ch - g) / 2);
  const L = 0;
  const R = hw + g;
  const T = 0;
  const B = hh + g;
  switch (zone) {
    case 'left':
      return { x: L, y: T, w: hw, h: ch };
    case 'right':
      return { x: R, y: T, w: cw - R, h: ch };
    case 'top':
      return { x: L, y: T, w: cw, h: hh };
    case 'bottom':
      return { x: L, y: B, w: cw, h: ch - B };
    case 'tl':
      return { x: L, y: T, w: hw, h: hh };
    case 'tr':
      return { x: R, y: T, w: cw - R, h: hh };
    case 'bl':
      return { x: L, y: B, w: hw, h: ch - B };
    case 'br':
      return { x: R, y: B, w: cw - R, h: ch - B };
  }
}

/** 自动排布中的窗口几何（仅布局字段） */
export interface AutoWin {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 自动排布：按窗口个数铺满。
 * - 1 个：左半区
 * - 2 个：左右各半（整高）
 * - 3~4 个：2×2 四窗格
 * - >4 个：前 4 个四窗格，其余中心散放（供手动调整）
 * @param n 窗口个数
 * @param cw 画布宽
 * @param ch 画布高
 */
export function arrangeAutoLayout(n: number, cw: number, ch: number): AutoWin[] {
  const g = MW_GAP;
  // 贴边占满；窗口之间留 g 间距
  const hw = Math.round((cw - g) / 2);
  const hh = Math.round((ch - g) / 2);
  const L = 0;
  const T = 0;
  const R = hw + g;
  const B = hh + g;
  const out: AutoWin[] = [];
  if (n <= 2) {
    const halves: AutoWin[] = [
      { x: L, y: T, w: hw, h: ch },
      { x: R, y: T, w: cw - R, h: ch },
    ];
    for (let i = 0; i < n; i += 1) out.push(halves[i]!);
  } else {
    const cells: AutoWin[] = [
      { x: L, y: T, w: hw, h: hh },
      { x: R, y: T, w: cw - R, h: hh },
      { x: L, y: B, w: hw, h: ch - B },
      { x: R, y: B, w: cw - R, h: ch - B },
    ];
    for (let i = 0; i < n; i += 1) {
      if (i < 4) {
        out.push(cells[i]!);
      } else {
        const ox = Math.round((cw - hw) / 2) + ((i - 4) % 3) * 18;
        const oy = Math.round((ch - hh) / 2) + Math.floor((i - 4) / 3) * 14;
        out.push({ x: ox, y: oy, w: hw, h: hh });
      }
    }
  }
  return out;
}

/**
 * 尺寸/位置 clamp：保证窗口不小于最小尺寸、不越出画布。
 * @param w 当前窗口几何
 * @param cw 画布宽
 * @param ch 画布高
 */
export function clampWindowBounds(
  w: { x: number; y: number; w: number; h: number },
  cw: number,
  ch: number,
): { x: number; y: number; w: number; h: number } {
  const gw = Math.max(MW_MIN_W, Math.min(w.w, cw - MW_GAP * 2));
  const gh = Math.max(MW_MIN_H, Math.min(w.h, ch - MW_GAP * 2));
  const x = Math.max(0, Math.min(w.x, Math.max(0, cw - gw)));
  const y = Math.max(0, Math.min(w.y, Math.max(0, ch - gh)));
  return { x, y, w: gw, h: gh };
}