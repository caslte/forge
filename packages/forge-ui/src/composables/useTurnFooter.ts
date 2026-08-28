import type { ConversationMessage } from '../types';

/** assistant 消息的 footer（复制+时间）轮次信息 */
export interface TurnFooterInfo {
  /** 是否为该轮最后一条 assistant（只有末卡显示 footer） */
  showFooter: boolean;
  /** 整轮复制文本（末卡覆盖同轮全部 assistant 分片；非末卡为 undefined） */
  copyText?: string;
}

/**
 * 按"轮次"计算每条消息的 footer 归属。
 *
 * 背景：pi 每次 LLM 调用各发一条 assistant 消息，一次回复若穿插工具调用会被拆成
 * 多张卡片；footer 渲染条件"非流式即显示"导致一次回复出现多个复制按钮+时间。
 *
 * 规则：以 user 消息为轮次边界；同一轮内的多条 assistant 分片中，仅最后一条
 * 显示 footer，且其复制内容为该轮全部 assistant 文本（按顺序 \n\n 拼接）。
 *
 * @returns key 为消息在数组中的下标
 */
export function computeTurnFooters(
  messages: ConversationMessage[],
): Map<number, TurnFooterInfo> {
  const out = new Map<number, TurnFooterInfo>();
  // 轮次起点集合：user 消息之后（含开头）
  let turnStart = 0;
  const flushTurn = (end: number): void => {
    const assistants: number[] = [];
    for (let i = turnStart; i < end; i += 1) {
      if (messages[i]?.role === 'assistant') assistants.push(i);
    }
    if (assistants.length === 0) return;
    for (const idx of assistants) out.set(idx, { showFooter: false });
    const last = assistants[assistants.length - 1]!;
    const copyText = assistants
      .map((i) => messages[i]!.content)
      .filter((c) => c.trim() !== '')
      .join('\n\n');
    out.set(last, { showFooter: true, copyText });
  };
  for (let i = 0; i < messages.length; i += 1) {
    if (messages[i]?.role === 'user') {
      flushTurn(i);
      turnStart = i + 1;
    }
  }
  flushTurn(messages.length);
  return out;
}
