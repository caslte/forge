/**
 * `canvas_hint` 内置扩展公开出口。
 *
 * 契约：docs/plan/canvas-card.md
 */

export {
  applyCanvasHint,
  canvasHintExtension,
  registerCanvasHint,
} from './extension.ts';

export { looksLikeDiagramRequest } from './detect.ts';
export { CANVAS_FENCE_LANGUAGE, CANVAS_SPEC, CANVAS_STANZA } from './prompt.ts';
