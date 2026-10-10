/**
 * 画布 IR 提示词契约入口（阶段 1）。
 *
 * 与 canvasHint/index.ts 同构：那套是现状链路（模型直出 HTML）的入口，
 * 本套是新链路（模型产出 IR）的入口。两者并存期，新链路尚未接管渲染，
 * 故各自独立导出，避免误用。
 */

export {
  IR_FENCE_LANGUAGE,
  IR_SPEC,
  IR_STANZA,
} from './promptIr.ts';

export {
  IR_EXTENSION_ENV,
  isIrExtensionEnabled,
  applyIrHint,
  registerCanvasIrHint,
  canvasIrHintExtension,
  type EnvLike,
} from './extension.ts';