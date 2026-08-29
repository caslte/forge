/**
 * U-CV-007 浮窗定位纯函数单测（AC-CV-018，docs/test/03_conversation/coverage-matrix.md）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts，先例 conversationTimeline.test.ts）。
 * 覆盖输入变体（注入条目/视口/浮窗尺寸矩形组合）：
 * - 右侧空间充足 → 右弹（垂直随锚点）；
 * - 贴右缘 → 翻左侧；
 * - 贴上缘/下缘 → 垂直夹取进视口；
 * - 极窄视口两侧都放不下 → 宽度收拢至最大可用宽；
 * - 0 宽/0 高锚点 → 无 NaN/Infinity；
 * - 同输入输出稳定（两次调用深 equal）；
 * - 负向：输出恒在视口内（含 margin）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { solvePopoverPosition } from '../src/utils/popoverPosition.ts';
import type { Rect, PopoverSize } from '../src/utils/popoverPosition.ts';

const M = 8; // 默认 margin

function rect(x: number, y: number, width: number, height: number): Rect {
  return { x, y, width, height };
}

/** 断言输出全部为有限数值（无 NaN/Infinity） */
function assertFinite(p: { x: number; y: number; width: number }): void {
  assert.ok(Number.isFinite(p.x), `x 必须有限，实际 ${p.x}`);
  assert.ok(Number.isFinite(p.y), `y 必须有限，实际 ${p.y}`);
  assert.ok(Number.isFinite(p.width), `width 必须有限，实际 ${p.width}`);
}

/** 负向断言：浮窗矩形（x,y,width×height）完整落在视口内（含 margin 容差 EPS） */
function assertInsideViewport(
  p: { x: number; y: number; width: number },
  size: PopoverSize,
  viewport: Rect,
  margin = M,
): void {
  const EPS = 0.5;
  assert.ok(p.x >= viewport.x + margin - EPS, `x=${p.x} 不得越过视口左缘+margin（${viewport.x + margin}）`);
  assert.ok(
    p.x + p.width <= viewport.x + viewport.width - margin + EPS,
    `x+width=${p.x + p.width} 不得越过视口右缘-margin（${viewport.x + viewport.width - margin}）`,
  );
  assert.ok(p.y >= viewport.y + margin - EPS, `y=${p.y} 不得越过视口上缘+margin（${viewport.y + margin}）`);
  assert.ok(
    p.y + size.height <= viewport.y + viewport.height - margin + EPS,
    `y+height=${p.y + size.height} 不得越过视口下缘-margin（${viewport.y + viewport.height - margin}）`,
  );
}

// ===== 右侧空间充足：右弹、垂直随锚点 =====

test('右侧空间充足：右弹，x=锚点右缘+margin，垂直随锚点不夹取', () => {
  const anchor = rect(40, 100, 20, 30);
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 1280, 800);
  const p = solvePopoverPosition(anchor, size, viewport);
  assertFinite(p);
  assert.equal(p.placement, 'right');
  assert.equal(p.x, 40 + 20 + M);
  assert.equal(p.y, 100); // 锚点顶对齐，未触边不夹取
  assert.equal(p.width, 320);
  assertInsideViewport(p, size, viewport);
});

test('垂直随锚点：锚点在视口中部，右弹 y 与锚点一致', () => {
  const anchor = rect(0, 300, 24, 24);
  const size: PopoverSize = { width: 320, height: 120 };
  const viewport = rect(0, 0, 1024, 768);
  const p = solvePopoverPosition(anchor, size, viewport);
  assert.equal(p.placement, 'right');
  assert.equal(p.y, 300);
});

// ===== 贴右缘：翻左侧 =====

test('贴右缘：右侧放不下翻左侧，x=锚点左缘-margin-浮窗宽', () => {
  // 视口 800 宽，锚点右缘 790：右侧可用 = 800-8-798 = -6 → 翻左
  const anchor = rect(700, 100, 90, 30);
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 800, 600);
  const p = solvePopoverPosition(anchor, size, viewport);
  assertFinite(p);
  assert.equal(p.placement, 'left');
  assert.equal(p.x, 700 - M - 320);
  assert.equal(p.y, 100);
  assert.equal(p.width, 320);
  assertInsideViewport(p, size, viewport);
});

test('右侧差一点放不下（重叠 margin 也算放不下）→ 翻左侧', () => {
  // 右侧可用 = 800-8-(600+100+8) = 84 < 320 → 左侧可用 = 608-8 = 600 ≥ 320 → 翻左
  const anchor = rect(600, 50, 100, 30);
  const size: PopoverSize = { width: 320, height: 120 };
  const viewport = rect(0, 0, 800, 600);
  const p = solvePopoverPosition(anchor, size, viewport);
  assert.equal(p.placement, 'left');
  assert.equal(p.x, 600 - M - 320);
  assertInsideViewport(p, size, viewport);
});

// ===== 贴上/下缘：垂直夹取 =====

test('贴上缘：y 低于视口上缘+margin 时夹取到 margin', () => {
  const anchor = rect(40, 0, 20, 12); // 条目贴视口顶（y=0）
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 1280, 800);
  const p = solvePopoverPosition(anchor, size, viewport);
  assert.equal(p.placement, 'right');
  assert.equal(p.y, M);
  assertInsideViewport(p, size, viewport);
});

test('贴下缘：y+浮窗高越过下缘时向上夹取到下缘-margin', () => {
  // 锚点 y=780：不夹取时 y+200=980 > 792 → 夹到 800-8-200=592
  const anchor = rect(40, 780, 20, 12);
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 1280, 800);
  const p = solvePopoverPosition(anchor, size, viewport);
  assert.equal(p.placement, 'right');
  assert.equal(p.y, 800 - M - 200);
  assertInsideViewport(p, size, viewport);
});

test('浮窗高超过视口可用高（除 margin）→ 贴顶放置，不产生负 y', () => {
  const anchor = rect(40, 300, 20, 12);
  const size: PopoverSize = { width: 320, height: 900 };
  const viewport = rect(0, 0, 1280, 800);
  const p = solvePopoverPosition(anchor, size, viewport);
  assertFinite(p);
  assert.equal(p.y, M);
});

// ===== 极窄视口：两侧都放不下 → 收拢至最大可用宽 =====

test('极窄视口两侧放不下：收拢至较大可用侧的最大可用宽（右≈左取右）', () => {
  // 视口 200 宽：右可用 = 192-118=74，左可用 = 82-8=74 → 平局取右，width=74
  const anchor = rect(90, 100, 20, 30);
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 200, 600);
  const p = solvePopoverPosition(anchor, size, viewport);
  assertFinite(p);
  assert.equal(p.placement, 'right');
  assert.equal(p.width, 74);
  assert.equal(p.x, 90 + 20 + M);
  assert.equal(p.x + p.width, 200 - M);
  assertInsideViewport(p, { width: 74, height: 200 }, viewport);
});

test('极窄视口锚点偏左：左侧可用更大 → 左侧收拢', () => {
  // 左可用 = (30-8)-8 = 14 < 右可用 = 192-58 = 134 → 取右。改锚点更贴左验证翻转侧：
  const anchor = rect(4, 100, 20, 30);
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 200, 600);
  const p = solvePopoverPosition(anchor, size, viewport);
  // 左可用 = max(0, (4-8)-8)=0；右可用 = 192-(24+8)=160 → 右侧收拢
  assert.equal(p.placement, 'right');
  assert.equal(p.width, 160);
  assertInsideViewport(p, { width: 160, height: 200 }, viewport);
});

test('锚点越出视口右缘（退化）：仍收拢出有限值且在视口内', () => {
  const anchor = rect(210, 100, 20, 30); // 完全在 200 宽视口右缘之外
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 200, 600);
  const p = solvePopoverPosition(anchor, size, viewport);
  assertFinite(p);
  assertInsideViewport(p, { width: p.width, height: 200 }, viewport);
});

// ===== 0 宽/0 高锚点：无 NaN/Infinity =====

test('0 高锚点：输出无 NaN/Infinity 且在视口内', () => {
  const anchor = rect(50, 50, 100, 0);
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 1280, 800);
  const p = solvePopoverPosition(anchor, size, viewport);
  assertFinite(p);
  assert.equal(p.placement, 'right');
  assert.equal(p.x, 150 + M);
  assert.equal(p.y, 50);
  assertInsideViewport(p, size, viewport);
});

test('0 宽锚点：输出无 NaN/Infinity 且在视口内', () => {
  const anchor = rect(50, 50, 0, 30);
  const size: PopoverSize = { width: 320, height: 200 };
  const viewport = rect(0, 0, 1280, 800);
  const p = solvePopoverPosition(anchor, size, viewport);
  assertFinite(p);
  assertInsideViewport(p, size, viewport);
});

test('0 宽 0 高锚点 + 0 尺寸浮窗：无 NaN/Infinity', () => {
  const p = solvePopoverPosition(rect(0, 0, 0, 0), { width: 0, height: 0 }, rect(0, 0, 100, 100));
  assertFinite(p);
  assert.ok(p.x >= M - 0.5);
  assert.ok(p.y >= M - 0.5);
});

// ===== 稳定性：同输入同输出 =====

test('纯函数稳定：同一输入两次调用结果深 equal', () => {
  const anchor = rect(300, 220, 32, 24);
  const size: PopoverSize = { width: 320, height: 180 };
  const viewport = rect(0, 0, 1024, 768);
  const a = solvePopoverPosition(anchor, size, viewport);
  const b = solvePopoverPosition(anchor, size, viewport);
  assert.deepEqual(b, a);
  // 不同输入不得共享可变状态
  const c = solvePopoverPosition(rect(1200, 220, 32, 24), size, viewport);
  assert.notDeepEqual(c, a);
});

test('自定义 margin 生效：右弹间距按传入 margin', () => {
  const p = solvePopoverPosition(rect(40, 100, 20, 30), { width: 320, height: 200 }, rect(0, 0, 1280, 800), 12);
  assert.equal(p.x, 40 + 20 + 12);
});

// ===== 负向：输出恒在视口内（含 margin） =====

test('负向：一组贴边锚点的输出恒在视口内（含 margin）', () => {
  const viewport = rect(0, 0, 720, 480);
  const size: PopoverSize = { width: 320, height: 160 };
  const anchors: Rect[] = [
    rect(0, 0, 20, 20), // 左上角
    rect(0, 230, 20, 20), // 左中
    rect(0, 470, 20, 10), // 左下贴底
    rect(700, 0, 20, 20), // 右上贴右
    rect(700, 460, 20, 20), // 右下角
    rect(360, 470, 20, 10), // 中下
    rect(719, 240, 1, 0), // 右缘 0 高
    rect(0, 479, 1, 1), // 左下角 1px
  ];
  for (const anchor of anchors) {
    const p = solvePopoverPosition(anchor, size, viewport);
    assertFinite(p);
    assertInsideViewport(p, { width: p.width, height: size.height }, viewport);
  }
});
