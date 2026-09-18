/**
 * 队列文本前置拼接纯函数（InstructionInput.restoreQueuedText 用）。
 *
 * 背景（QC-003 + 用户复现的"输入框重复"路径）：
 * - stop / cancel 时把被清空的待发文本按 \n\n 段落拼接回填到当前输入之前；
 * - 同一份 queued 文本在 cancel / re-cancel / 重发 / 跨会话还原 等路径里可能被回填多次，
 *   旧实现直接拼接会造成"同一段文字前缀拼两遍"。
 *
 * 修复要点：入参 items 与当前 text 已经以 items 拼接内容打头时，判定为"已回填过"，原样返回。
 *
 * 纯 TS 零依赖（Node type stripping 可直跑，先例 utils/pasteText.ts）。
 */

/**
 * 把队列文本前置拼到当前输入文本之前；重复传入同一份队列文本不会重复前缀。
 * @param currentText 输入框当前内容
 * @param items 待回填的队列文本数组（空白 / 非字符串会被丢弃）
 * @returns 新输入框文本
 */
export function prependQueuedText(currentText: string, items: readonly string[]): string {
  const valid = items.filter((s): s is string => typeof s === 'string' && s.trim() !== '');
  if (valid.length === 0) return currentText;
  const queued = valid.join('\n\n');
  const current = currentText.trim();
  // 幂等保护：当前文本若已经以 `queued\n\n` 或 `queued`（无候选时）开头，视为重复回填，直接返回原文。
  if (currentText.startsWith(queued)) return currentText;
  return current ? `${queued}\n\n${current}` : queued;
}