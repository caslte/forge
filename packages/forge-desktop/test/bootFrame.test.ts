/**
 * 启动首帧探针（bootFrame.ts）单测。
 *
 * 这块代码的价值在于「把窗口上有没有内容变成可量化的事实」，所以测试的重点也是**判据本身**：
 * 1. 纯底色帧（空文档 / 只画了 backgroundColor）必须判为「无内容」——这正是用户报的白板；
 * 2. splash 这类真画面必须判为「有内容」，且内容占比落在与真实几何相符的量级
 *    （300px 字标带 + 一行小字在 1280x820 上是千分之几），据以确认 FRAME_CONTENT_RATIO_MIN
 *    这个阈值既不会漏判白板、也不会把真画面误判成白板；
 * 3. 异常输入（null / 尺寸为 0 / 缓冲区长度不足）一律返回空统计且不抛错——探针绝不能
 *    在启动路径上抛错。
 *
 * 位图按 BGRA 构造（与 NativeImage.toBitmap() 同序），故意让通道顺序在断言中可见：
 * 若实现误按 RGBA 解读，brandRatio 用例会立刻红。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FRAME_CONTENT_RATIO_MIN, statsFromBitmap } from '../src/bootFrame.ts';

/** BGRA 像素 */
interface Bgra {
  b: number;
  g: number;
  r: number;
  a: number;
}

const WHITE: Bgra = { b: 0xff, g: 0xff, r: 0xff, a: 0xff };
const BRAND: Bgra = { b: 0xeb, g: 0x63, r: 0x25, a: 0xff }; // #2563eb
const INK: Bgra = { b: 0x33, g: 0x33, r: 0x33, a: 0xff }; // 正文色（splash 兜底值）

/** 造一张纯色位图 */
function makeBitmap(width: number, height: number, fill: Bgra): Buffer {
  const buf = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i += 1) {
    buf[i * 4] = fill.b;
    buf[i * 4 + 1] = fill.g;
    buf[i * 4 + 2] = fill.r;
    buf[i * 4 + 3] = fill.a;
  }
  return buf;
}

/** 在位图上画一个实心矩形（坐标半开区间，越界部分裁掉） */
function paintRect(
  buf: Buffer,
  width: number,
  height: number,
  rect: { x: number; y: number; w: number; h: number },
  color: Bgra,
): void {
  for (let y = Math.max(0, rect.y); y < Math.min(height, rect.y + rect.h); y += 1) {
    for (let x = Math.max(0, rect.x); x < Math.min(width, rect.x + rect.w); x += 1) {
      const i = (y * width + x) * 4;
      buf[i] = color.b;
      buf[i + 1] = color.g;
      buf[i + 2] = color.r;
      buf[i + 3] = color.a;
    }
  }
}

/** 采样点数（与实现同一口径：闭开区间按步长抽稀） */
function sampleCount(size: number, step: number): number {
  return Math.ceil(size / step);
}

test('纯底色帧判为「无内容」——这正是用户看到的白板', () => {
  const w = 1280;
  const h = 820;
  const s = statsFromBitmap(makeBitmap(w, h, WHITE), w, h);

  assert.equal(s.width, w);
  assert.equal(s.height, h);
  assert.equal(s.sampled, sampleCount(w, 4) * sampleCount(h, 4));
  assert.equal(s.contentRatio, 0, '纯底色帧的内容占比必须为 0');
  assert.equal(s.brandRatio, 0);
  assert.equal(s.background, '#ffffff');
  assert.ok(s.contentRatio < FRAME_CONTENT_RATIO_MIN, '纯底色帧必须落在白板判据之下');
});

test('含字标与文案的 splash 帧判为「有内容」，且占比与真实几何同量级', () => {
  const w = 1280;
  const h = 820;
  const buf = makeBitmap(w, h, WHITE);
  // 居中 300px 字标带（与 index.html / BootWelcome.vue 的 splash 一致，实心占位偏保守）
  paintRect(buf, w, h, { x: 490, y: 330, w: 300, h: 40 }, INK);
  // 一行 phase 文案的粗略占位（spinner 已移除，splash 不再含品牌蓝像素）
  paintRect(buf, w, h, { x: 556, y: 408, w: 168, h: 13 }, INK);

  const s = statsFromBitmap(buf, w, h);

  // 内容占比 = (300*40 + 168*13) / (1280*820) ≈ 1.35%，按 4 抽稀后仍在同一量级
  assert.ok(s.contentRatio > FRAME_CONTENT_RATIO_MIN, `内容占比 ${s.contentRatio} 应高于白板判据`);
  assert.ok(s.contentRatio < 0.03, `内容占比 ${s.contentRatio} 不应高到像整屏涂满`);
  assert.equal(s.brandRatio, 0, 'splash 已无 spinner，不应出现品牌蓝像素');
  assert.equal(s.background, '#ffffff');
});

test('透明像素算底色：一张空图不得被误判成「有内容」', () => {
  const w = 64;
  const h = 64;
  const s = statsFromBitmap(makeBitmap(w, h, { b: 0, g: 0, r: 0, a: 0 }), w, h);

  assert.equal(s.contentRatio, 0);
  assert.equal(s.brandRatio, 0);
});

test('底色取左上角：整屏品牌蓝的帧内容占比为 0（判据只表达「与底色不同」）', () => {
  const w = 64;
  const h = 64;
  const s = statsFromBitmap(makeBitmap(w, h, BRAND), w, h);

  assert.equal(s.background, '#2563eb');
  assert.equal(s.contentRatio, 0);
  assert.equal(s.brandRatio, 1);
});

test('异常输入一律返回空统计且不抛错（探针不得阻断启动）', () => {
  const bad = [
    statsFromBitmap(null, 100, 100),
    statsFromBitmap(undefined, 100, 100),
    statsFromBitmap(Buffer.alloc(0), 100, 100),
    statsFromBitmap(Buffer.alloc(8), 100, 100), // 长度不足
    statsFromBitmap(Buffer.alloc(16), 0, 0), // 尺寸非法
    statsFromBitmap(Buffer.alloc(16), -4, 4),
  ];
  for (const s of bad) {
    assert.equal(s.sampled, 0);
    assert.equal(s.contentRatio, 0);
    assert.equal(s.brandRatio, 0);
    assert.equal(s.background, '#000000');
  }
});

test('step 可调（采样粒度）且非法 step 回退默认值', () => {
  const w = 100;
  const h = 100;
  const buf = makeBitmap(w, h, WHITE);
  paintRect(buf, w, h, { x: 40, y: 40, w: 20, h: 20 }, BRAND);

  const fine = statsFromBitmap(buf, w, h, 1);
  const coarse = statsFromBitmap(buf, w, h, 20);
  assert.equal(fine.sampled, 100 * 100);
  assert.equal(coarse.sampled, sampleCount(100, 20) * sampleCount(100, 20));
  assert.ok(fine.contentRatio > 0);
  assert.ok(coarse.contentRatio > 0);

  const zeroStep = statsFromBitmap(buf, w, h, 0);
  assert.equal(zeroStep.sampled, sampleCount(w, 4) * sampleCount(h, 4), '非法 step 应回退默认 4');
});
