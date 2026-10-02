/**
 * 多窗口画布几何（P3-C）单元测试。
 *
 * 对应 docs/test/02_session/e2e.md E-SM-005 核心断言（吸附 8 区 / 4 窗格 / 最小尺寸），
 * 以纯函数形式在 forge-core 回归（对齐 buildSideBySideDiff 先例）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  detectSnapZone,
  snapRectFor,
  arrangeAutoLayout,
  clampWindowBounds,
  unshrinkLegacyBounds,
  MW_GAP,
} from '../../src/multiwin/windowLayout.ts';

test('E-SM-005-1：指针在画布外返回 null，正常区内无吸附', () => {
  assert.equal(detectSnapZone(-1, 10, 600, 400), null);
  assert.equal(detectSnapZone(10, 999, 600, 400), null);
  assert.equal(detectSnapZone(300, 200, 600, 400), null);
});

test('E-SM-005-2：四角吸附区判定（tl/tr/bl/br）', () => {
  assert.equal(detectSnapZone(5, 5, 600, 400), 'tl');
  assert.equal(detectSnapZone(595, 5, 600, 400), 'tr');
  assert.equal(detectSnapZone(5, 395, 600, 400), 'bl');
  assert.equal(detectSnapZone(595, 395, 600, 400), 'br');
});

test('E-SM-005-3：四边吸附区判定（left/right/top/bottom）', () => {
  assert.equal(detectSnapZone(30, 200, 600, 400), 'left');
  assert.equal(detectSnapZone(570, 200, 600, 400), 'right');
  assert.equal(detectSnapZone(300, 30, 600, 400), 'top');
  assert.equal(detectSnapZone(300, 370, 600, 400), 'bottom');
});

test('E-SM-005-4：左半区吸附矩形完全贴边铺满整高（不留画布缝隙）', () => {
  const g = MW_GAP;
  const r = snapRectFor('left', 600, 400);
  assert.deepEqual(r, { x: 0, y: 0, w: Math.round((600 - g) / 2), h: 400 });
});

test('E-SM-005-5：4 窗格排布 2×2 严丝合缝（四角不重叠不越界，贴边覆盖画布）', () => {
  const n = 4;
  const cw = 600;
  const ch = 400;
  const wins = arrangeAutoLayout(n, cw, ch);
  assert.equal(wins.length, 4);
  const g = MW_GAP;
  // 四个格角坐标应恰好拼接成 2×2（x0=x1、x2=x3、y0=y2、y1=y3）
  assert.equal(wins[0]!.x + wins[0]!.w + g, wins[1]!.x);
  assert.equal(wins[2]!.x + wins[2]!.w + g, wins[3]!.x);
  assert.equal(wins[0]!.y + wins[0]!.h + g, wins[2]!.y);
  assert.equal(wins[1]!.y + wins[1]!.h + g, wins[3]!.y);
  for (const w of wins) {
    assert.ok(w.x >= 0 && w.y >= 0, '窗口不越界');
    assert.ok(w.x + w.w <= cw && w.y + w.h <= ch, '窗口右/下不越界');
  }
  // 四角紧贴画布（顶/左 x=0、y=0；底/右恰好落在画布边界）
  assert.equal(wins[0]!.x, 0, '左上贴左');
  assert.equal(wins[0]!.y, 0, '左上贴上');
  assert.equal(wins[1]!.x + wins[1]!.w, cw, '右上贴右');
  assert.equal(wins[2]!.y + wins[2]!.h, ch, '左下贴下');
});

test('E-SM-005-6：2 窗口自动排布为左右各半（两端贴边，之间留 MW_GAP）', () => {
  const wins = arrangeAutoLayout(2, 600, 400);
  assert.equal(wins.length, 2);
  assert.equal(wins[0]!.x, 0, '左窗贴左');
  assert.equal(wins[0]!.x + wins[0]!.w + MW_GAP, wins[1]!.x);
  assert.equal(wins[1]!.x + wins[1]!.w, 600, '右窗贴右');
  assert.equal(wins[0]!.h, 400, '左窗顶底贴边');
  assert.equal(wins[1]!.h, 400, '右窗顶底贴边');
});

test('E-SM-005-7：最小尺寸 clamp（窗口不小于 180×120、不越界）', () => {
  const clamped = clampWindowBounds({ x: 0, y: 0, w: 40, h: 30 }, 600, 400);
  assert.equal(clamped.w, 180);
  assert.equal(clamped.h, 120);
  const overflow = clampWindowBounds({ x: 500, y: 300, w: 300, h: 200 }, 600, 400);
  assert.ok(overflow.x + overflow.w <= 600, '不越右界');
  assert.ok(overflow.y + overflow.h <= 400, '不越下界');
});

test('E-SM-005-9：clamp 不缩短贴边满高窗口（切回画布恢复/拖拽释放后底部不留缝隙）', () => {
  const cw = 600;
  const ch = 400;
  // snapRectFor('left') 与 arrangeAutoLayout(2) 产生的满高窗口（h = ch），
  // 经 clampWindowBounds（恢复布局/拖拽释放的钳制路径）后必须保持满高，
  // 否则底部露出 2×MW_GAP 的画布背景缝隙
  const kept = clampWindowBounds(snapRectFor('left', cw, ch), cw, ch);
  assert.equal(kept.y, 0);
  assert.equal(kept.h, ch, '满高窗口 clamp 后仍满高');
  const keptRight = clampWindowBounds(snapRectFor('right', cw, ch), cw, ch);
  assert.equal(keptRight.x + keptRight.w, cw, '右窗仍贴右');
  assert.equal(keptRight.h, ch, '右窗满高');
  // 上界仍是画布边界：超限窗口被钳回，不越界
  const oversize = clampWindowBounds({ x: -20, y: -10, w: cw + 50, h: ch + 50 }, cw, ch);
  assert.ok(oversize.w <= cw && oversize.h <= ch, '超限仍被钳回画布内');
  assert.ok(oversize.x >= 0 && oversize.y >= 0);
});

test('E-SM-005-10：迁移还原被旧版 clamp 截短的贴边窗口（差 2g 内补满，正常尺寸不动）', () => {
  // 旧缺陷持久化形态：满高 400 被截成 392、满宽 600 被截成 592
  const healed = unshrinkLegacyBounds({ x: 0, y: 0, w: 592, h: 392 }, 600, 400);
  assert.deepEqual(healed, { x: 0, y: 0, w: 600, h: 400 });
  // 正常排布尺寸（半宽 298 / 半高 198）不受迁移影响
  const half = unshrinkLegacyBounds({ x: 302, y: 198, w: 298, h: 198 }, 600, 400);
  assert.deepEqual(half, { x: 302, y: 198, w: 298, h: 198 });
});

test('E-SM-005-8：超过 4 个窗口时前 4 个四窗格，其余散放不重叠越界', () => {
  const wins = arrangeAutoLayout(7, 800, 600);
  assert.equal(wins.length, 7);
  for (let i = 0; i < 4; i += 1) {
    assert.ok(wins[i]!.x >= 0 && wins[i]!.y >= 0);
  }
  for (let i = 4; i < 7; i += 1) {
    const w = wins[i]!;
    assert.ok(w.x >= 0 && w.x + w.w <= 800);
    assert.ok(w.y >= 0 && w.y + w.h <= 600);
  }
});