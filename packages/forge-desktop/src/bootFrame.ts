/**
 * 启动 splash「首帧内容探针」（v3.78.8）。
 *
 * 存在的理由：启动期白屏与否，取决于**合成器把哪一帧呈到了窗口表面**，而这件事渲染进程
 * 自证不了——渲染进程只能说「我画了」（rAF），不能说「屏幕上有了」。Electron 的
 * webContents.beginFrameSubscription 提供浏览器进程侧的 presentation 事件（每次合成帧
 * 呈出时回调一张 NativeImage），本模块把那张位图翻译成可量化的事实：这一帧里有没有内容
 * （字 / 标志块），还是纯底色。
 *
 * 设计为**纯函数、零 Electron 依赖**：入参就是 NativeImage.toBitmap() 的原始位图 + 尺寸，
 * 因此可以直接单测（合成位图 → 断言统计值），不必起真机。
 */

/** 位图统计结果（两个比例均为 0~1） */
export interface FrameStats {
  width: number;
  height: number;
  /** 实际参与统计的采样点数（按 step 抽稀后） */
  sampled: number;
  /** 与左上角底色明显不同的采样点占比 —— 「这一帧上有东西」 */
  contentRatio: number;
  /** 品牌蓝（#2563eb，spinner 顶弧等品牌像素）采样点占比 —— 诊断用特征信号 */
  brandRatio: number;
  /** 左上角采样到的底色，`#rrggbb` */
  background: string;
}

/** 采样步长（像素）。1280x820 窗口按 4 抽稀 ≈ 6.5 万点，统计耗时毫秒级 */
const SAMPLE_STEP = 4;

/** 与底色判「不同」的通道阈值。留一点余量以吃下抗锯齿/次像素渲染的中间色 */
const DIFF_THRESHOLD = 12;

/** 品牌蓝 #2563eb（App 图标/spinner 顶弧的品牌色） */
const BRAND_R = 0x25;
const BRAND_G = 0x63;
const BRAND_B = 0xeb;
/** 品牌蓝通道容差（色域/缩放插值会带来轻微偏移） */
const BRAND_TOLERANCE = 60;

/** 位图起点不可读时的空统计（调用方只需照常继续，不必区分「空帧」与「读不出」） */
function emptyStats(width: number, height: number): FrameStats {
  return {
    width,
    height,
    sampled: 0,
    contentRatio: 0,
    brandRatio: 0,
    background: '#000000',
  };
}

/**
 * 统计一张位图的「内容占比」。
 *
 * 位图字节序按 **BGRA**（Electron `NativeImage.toBitmap()` 的输出）、有测试锁住该假设、
 * 每像素 4 字节、预乘 alpha 解读。全透明像素（alpha < 8）一律算作底色——合成帧正常情况
 * 是整幅不透明，该分支只兜「探针拿到的是一张空图」的异常输入。
 */
export function statsFromBitmap(
  bitmap: Buffer | Uint8Array | null | undefined,
  width: number,
  height: number,
  step: number = SAMPLE_STEP,
): FrameStats {
  if (bitmap === null || bitmap === undefined || width <= 0 || height <= 0) {
    return emptyStats(width, height);
  }
  const stride = width * 4;
  if (bitmap.length < stride * height) {
    return emptyStats(width, height);
  }
  const safeStep = Number.isInteger(step) && step > 0 ? step : SAMPLE_STEP;
  // 底色取左上角：splash 的四角永远是被底色铺满的区域，不会落在字/图标上
  // （`?? 0` 只为满足 noUncheckedIndexedAccess；长度已在上方校验过）
  const bgB = bitmap[0] ?? 0;
  const bgG = bitmap[1] ?? 0;
  const bgR = bitmap[2] ?? 0;
  let sampled = 0;
  let content = 0;
  let brand = 0;
  for (let y = 0; y < height; y += safeStep) {
    const rowStart = y * stride;
    for (let x = 0; x < width; x += safeStep) {
      const i = rowStart + x * 4;
      const b = bitmap[i] ?? 0;
      const g = bitmap[i + 1] ?? 0;
      const r = bitmap[i + 2] ?? 0;
      const a = bitmap[i + 3] ?? 0;
      sampled += 1;
      if (a < 8) continue;
      const diff = Math.max(Math.abs(r - bgR), Math.abs(g - bgG), Math.abs(b - bgB));
      if (diff > DIFF_THRESHOLD) content += 1;
      if (
        Math.abs(r - BRAND_R) <= BRAND_TOLERANCE &&
        Math.abs(g - BRAND_G) <= BRAND_TOLERANCE &&
        Math.abs(b - BRAND_B) <= BRAND_TOLERANCE
      ) {
        brand += 1;
      }
    }
  }
  const hex = (v: number): string => v.toString(16).padStart(2, '0');
  return {
    width,
    height,
    sampled,
    contentRatio: sampled === 0 ? 0 : content / sampled,
    brandRatio: sampled === 0 ? 0 : brand / sampled,
    background: `#${hex(bgR)}${hex(bgG)}${hex(bgB)}`,
  };
}

/**
 * 「这一帧上有内容」的判据：内容占比达到该下限。
 * 纯底色帧（空文档 / 只画了 backgroundColor）恒为 0；splash 的字标 + 文案实测 ≥0.3%。
 * 取 0.05% 作阈值——远低于真实值，只用来把「白板」与「有画面」分开，不用来判好坏。
 */
export const FRAME_CONTENT_RATIO_MIN = 0.0005;
