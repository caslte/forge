/**
 * 超长粘贴转文件附件的阈值判定纯函数（输入框 onPaste 用）。
 *
 * 背景：输入框硬上限 MAX_CHARS=8000（静默截断），大文本粘贴既丢内容又撑爆输入框。
 * 策略（已确认）：纯文本超阈值整段转临时 txt 附件；以内走默认粘贴；落盘失败降级手插原文。
 * 纯 TS 零依赖（Node type stripping 可直跑，先例 utils/atCompletion.ts）。
 */

/** 粘贴文本超过该字数时转临时文件附件，不再内联进输入框 */
export const PASTE_TEXT_TO_FILE_CHARS = 2000;

/**
 * 判断粘贴文本是否应转为临时文件附件。
 * @param text 剪贴板纯文本
 * @returns 超过阈值返回 true（转文件）；以内返回 false（默认粘贴）
 */
export function shouldConvertPasteToFile(text: string): boolean {
  return text.length > PASTE_TEXT_TO_FILE_CHARS;
}
