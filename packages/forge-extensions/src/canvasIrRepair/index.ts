/**
 * 画布 IR 修复回路入口：校验失败自动回灌回执（预算 1 次，见 extension.ts）。
 */

export {
  IR_RETRY_TAG,
  decideIrRepair,
  messageText,
  registerCanvasIrRepair,
  canvasIrRepairExtension,
  type MinimalMessage,
} from './extension.ts';
