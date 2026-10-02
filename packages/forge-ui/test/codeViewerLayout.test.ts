/**
 * 模块 12：代码浏览器布局逻辑（CE-S01 ~ CE-S04）。
 *
 * 这里只测「算法」不测「渲染」：仓库的测试跑在 `node --experimental-strip-types`
 * 下，没有 DOM 与 Vue 挂载能力。真正难测的恰好也是算法——保底钳制、拖拽增量、
 * 窄窗降级三件事一旦算错，现象都是「看起来差不多但就是不对」，很难靠手点发现。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODE_LAYOUT_MIN_WINDOW,
  CODE_SIDE_MIN_PX,
  CODE_SPLIT_PCT_DEFAULT,
  CODE_SPLIT_STEP,
  clampCodeSplitPct,
  effectiveCodeLayout,
  nextSplitPct,
} from '../src/composables/usePreferences.ts';

const W = 1280; // 参照窗宽

// ===== clampCodeSplitPct：两侧各保底 320px =====

test('clamp：默认 46% 在正常窗宽下原样返回', () => {
  assert.equal(clampCodeSplitPct(CODE_SPLIT_PCT_DEFAULT, W), 46);
});

test('clamp：拖到最小被钳到 320px 占比，不是 0', () => {
  assert.equal(clampCodeSplitPct(0, W), (CODE_SIDE_MIN_PX / W) * 100);
  assert.equal(clampCodeSplitPct(-80, W), (CODE_SIDE_MIN_PX / W) * 100);
});

test('clamp：拖到最大被钳到 100−保底，两侧都留够 320px', () => {
  assert.equal(clampCodeSplitPct(100, W), 100 - (CODE_SIDE_MIN_PX / W) * 100);
  assert.equal(clampCodeSplitPct(180, W), 100 - (CODE_SIDE_MIN_PX / W) * 100);
});

test('clamp：钳制后两侧实际像素都 >= 320px（各种窗宽都验一遍）', () => {
  for (const w of [700, 820, 1024, 1280, 1600, 2560, 3840]) {
    const pct = clampCodeSplitPct(1, w); // 极端往左拖
    const codePx = (pct / 100) * w;
    const convPx = w - codePx;
    assert.ok(codePx >= CODE_SIDE_MIN_PX - 0.001, `窗宽 ${w}: 代码区 ${codePx}px < 320`);
    assert.ok(convPx >= CODE_SIDE_MIN_PX - 0.001, `窗宽 ${w}: 对话区 ${convPx}px < 320`);
  }
});

test('clamp：NaN / Infinity / 非数字 → 回默认 46%', () => {
  assert.equal(clampCodeSplitPct(Number.NaN, W), CODE_SPLIT_PCT_DEFAULT);
  assert.equal(clampCodeSplitPct(Number.POSITIVE_INFINITY, W), CODE_SPLIT_PCT_DEFAULT);
  assert.equal(clampCodeSplitPct(Number.NEGATIVE_INFINITY, W), CODE_SPLIT_PCT_DEFAULT);
});

test('clamp：窗宽不足 2×320 时退回 50% 居中口径（上下限交叉的守卫）', () => {
  assert.equal(clampCodeSplitPct(46, 500), CODE_SPLIT_PCT_DEFAULT);
  assert.equal(clampCodeSplitPct(10, 640), CODE_SPLIT_PCT_DEFAULT);
  // 边界：正好 640 = 2×320 仍走居中口径
  assert.equal(clampCodeSplitPct(10, 640), CODE_SPLIT_PCT_DEFAULT);
});

test('clamp：容器宽 0（尚未布局/已卸载）不崩，也不返回 NaN', () => {
  const r = clampCodeSplitPct(46, 0);
  assert.ok(Number.isFinite(r));
});

// ===== effectiveCodeLayout：窄窗临时降级 =====

test('eff：偏好 cover → 任何窗宽都是 cover', () => {
  assert.equal(effectiveCodeLayout('cover', 1440), 'cover');
  assert.equal(effectiveCodeLayout('cover', 320), 'cover');
});

test('eff：偏好 split + 宽窗 → split', () => {
  assert.equal(effectiveCodeLayout('split', 1440), 'split');
  assert.equal(effectiveCodeLayout('split', CODE_LAYOUT_MIN_WINDOW), 'split');
});

test('eff：偏好 split + 窄窗 → 临时 cover', () => {
  assert.equal(effectiveCodeLayout('split', CODE_LAYOUT_MIN_WINDOW - 1), 'cover');
  assert.equal(effectiveCodeLayout('split', 800), 'cover');
});

test('eff：降级阈值正是 820px（PRD §3.3 写死的一致性）', () => {
  assert.equal(CODE_LAYOUT_MIN_WINDOW, 820);
  assert.equal(effectiveCodeLayout('split', 819), 'cover');
  assert.equal(effectiveCodeLayout('split', 821), 'split');
});

test('eff：降级是纯函数——不修改偏好（同输入同输出，可反复求值）', () => {
  const pref = 'split' as const;
  assert.equal(effectiveCodeLayout(pref, 700), 'cover');
  assert.equal(effectiveCodeLayout(pref, 700), 'cover');
  assert.equal(effectiveCodeLayout(pref, 1400), 'split'); // 拉宽后自动恢复
});

// ===== nextSplitPct：拖拽增量（沟在代码纸左缘：左拖 = 代码纸变宽）=====

test('next：无移动 → 比例不变', () => {
  assert.equal(nextSplitPct(46, 500, 500, W), 46);
});

test('next：右移 10% 窗宽 → 代码纸变窄 10', () => {
  assert.ok(Math.abs(nextSplitPct(46, 500, 500 + W * 0.1, W) - 36) < 1e-9);
});

test('next：左移 20% 窗宽 → 代码纸变宽 20', () => {
  assert.ok(Math.abs(nextSplitPct(46, 500, 500 - W * 0.2, W) - 66) < 1e-9);
});

test('next：增量式——同一段位移在钳住后仍可「走回」（防死手感）', () => {
  // 场景：起点 46%，一路向左拖到最左（增量 +40 → 86%），再往回（右）拖 10px。
  // 若实现是「当前值 + 增量」，被钳到 75% 后回拖 10px 只会得到 74.2%；
  // 起点式应该从 86% 起算，得到 85.2% 这种单调恢复的值。
  const startPct = 46;
  const startX = 500;
  const farX = 500 - W * 0.4;
  const far = nextSplitPct(startPct, startX, farX, W);
  const back = nextSplitPct(startPct, startX, farX + 10, W);
  assert.ok(back < far, '往回（右）拖必须让比例下降，否则手感是死的');
  assert.ok(Math.abs(back - (far - (10 / W) * 100)) < 1e-9);
});

test('next：容器宽 0（未布局）→ 原样返回，不产生 Infinity/NaN', () => {
  assert.equal(nextSplitPct(46, 100, 300, 0), 46);
});

// ===== 键盘与手势契约（值本身在组件里，这里钉住契约常量）=====

test('键盘步长为 2 个百分点', () => {
  assert.equal(CODE_SPLIT_STEP, 2);
});

test('默认分割比例与双击复位目标都是 46%', () => {
  assert.equal(CODE_SPLIT_PCT_DEFAULT, 46);
});

test('保底 320px：窄窗下钳制后代码区恰好 320px（原型 tight 态）', () => {
  const w = 1130; // 原型实测的对话区宽度
  const pct = clampCodeSplitPct(0, w);
  assert.ok(Math.abs((pct / 100) * w - 320) < 0.001);
});
