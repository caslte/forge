/**
 * thinking 内容兜底清洗（展示层过滤器）。
 *
 * forge 已在结构化数据层过滤思考内容（流式 thinking_delta 丢弃、assistant 消息仅提取
 * text 块、历史加载仅取 text part）。但部分模型（如 MiniMax-M3）会把思考过程以标签
 * 形式直接写进 text 流，本函数负责处理该残余，识别以下形态并整块剥离：
 *
 * 1. DeepSeek 风格标签（MiniMax-M3 实际使用）：&lt;think&gt;…&lt;/think&gt;。
 * 2. 其它包裹标签：&lt;thinking&gt;…&lt;/thinking&gt;、&lt;reasoning&gt;…&lt;/reasoning&gt;、
 *    [thinking]…[/thinking]、[reasoning]…[/reasoning]。
 * 3. 思考正文起手 + 收尾标记：文本以小写 `thinking` 起手、以独立 `response` 词收尾。
 *
 * 关键语义（流式安全）：开标签出现但闭合标签未到（流式进行中 / 模型忘记闭合）时，
 * 从开标签处截断到文本末尾——保证流式期间思考内容绝不外漏，此期间 forge 前端
 * 显示「助手正在思考」占位；闭合标签到达后正常保留其后正文。
 */

/** 需要剥离的包裹标签对（正则；大小写不敏感） */
const THINKING_TAG_PAIRS: Array<{ open: RegExp; close: RegExp }> = [
  { open: /<think\b/i, close: /<\/think\s*>/i },
  { open: /<thinking\b/i, close: /<\/thinking\s*>/i },
  { open: /<reasoning\b/i, close: /<\/reasoning\s*>/i },
  { open: /\[thinking\]/i, close: /\[\/thinking\]/i },
  { open: /\[reasoning\]/i, close: /\[\/reasoning\]/i },
];

/** 思考正文起手标记：小写 thinking（正常英文句子多为大写 Thinking） */
const THINKING_OPEN = /^\s*thinking/;

/**
 * 思考收尾标记：独立 `response` 词，且仅当其**后随换行或文本结束**时视为收尾
 * （思考块内出现的 "response." 等词尾不视为收尾，避免把正式回答截断）。
 */
const RESPONSE_CLOSE = /(^|\s)response(?=\r?\n|$)/gi;

/**
 * 剥离文本中的 thinking 内容（包裹标签 + 正文混流），返回清洗后文本。
 * @param text 原始文本（可为空串）
 * @returns 剥离思考内容后的文本
 */
export function stripThinkingContent(text: string): string {
  let out = text;
  let stripped = false;
  // 1) 包裹标签对：循环剥离，直到所有开标签（含未闭合的）都被处理
  for (const { open, close } of THINKING_TAG_PAIRS) {
    let next = stripFirstThinkingBlock(out, open, close);
    while (next !== out) {
      stripped = true;
      out = next;
      next = stripFirstThinkingBlock(out, open, close);
    }
  }
  // 2) 剥离 tag 后仍以小写 thinking 起手 → 正文混流形态
  if (THINKING_OPEN.test(out)) {
    const closeMatches = [...out.matchAll(RESPONSE_CLOSE)];
    if (closeMatches.length === 0) {
      // 无收尾标记：视为纯思考消息，整体置空（上层跳过空 assistant 气泡）
      return '';
    }
    const last = closeMatches[closeMatches.length - 1];
    if (last === undefined) return '';
    const tailStart = last.index + last[0].length;
    out = out.slice(tailStart).replace(/^\s*\n*/u, '');
    stripped = true;
  }
  if (stripped) {
    // 剥离思考块后，清理开头残留的空白/换行（思考块与正文间的分隔）
    return out.replace(/^\s+/u, '');
  }
  return out;
}

/**
 * 剥离文本中第一对 open..close 块；开标签存在但闭合标签缺失时（流式进行中 /
 * 模型未闭合），从开标签处截断到文本末尾（思考内容不外漏）。
 * @param text 原始文本
 * @param open 开标签正则
 * @param close 闭合标签正则
 * @returns 剥离/截断后的文本；无开标签时返回原文
 */
function stripFirstThinkingBlock(text: string, open: RegExp, close: RegExp): string {
  const openIdx = text.search(open);
  if (openIdx === -1) return text;
  // 只在开标签之后查找闭合标签，避免把开标签之前的孤立闭合误当配对
  const rest = text.slice(openIdx);
  const closeMatch = rest.match(close);
  if (closeMatch === null || closeMatch.index === undefined) {
    // 未闭合：截断到开标签处（其后全部视为思考内容，包括流式中途）
    return text.slice(0, openIdx);
  }
  const blockEnd = closeMatch.index + closeMatch[0].length;
  return text.slice(0, openIdx) + text.slice(openIdx + blockEnd);
}