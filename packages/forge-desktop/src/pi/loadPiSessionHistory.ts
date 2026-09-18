import fs from 'node:fs';

import { SessionManager } from '@earendil-works/pi-coding-agent';

import type { ConversationMessage } from '@forge/core';
import { stripThinkingContent } from './thinkingFilter.ts';

type PiContentPart = {
  type?: string;
  text?: string;
  /** 图片 part（P3-B 用户附件）：base64 数据 + MIME 类型 */
  data?: string;
  mimeType?: string;
  /** toolCall part（assistant 消息内）：id/name/arguments 用于恢复历史工具入参 */
  id?: string;
  name?: string;
  arguments?: Record<string, unknown>;
};

type PiMessage = {
  role?: string;
  content?: string | PiContentPart[];
  toolCallId?: string;
  toolName?: string;
};

export async function loadPiSessionHistory(sessionFile: string): Promise<ConversationMessage[]> {
  if (!fs.existsSync(sessionFile) || fs.statSync(sessionFile).size === 0) {
    return [];
  }

  let entries;
  try {
    const manager = SessionManager.open(sessionFile, undefined, undefined);
    entries = manager.buildContextEntries();
  } catch (err) {
    // P2-D：损坏的 session JSONL 给出稳定可读错误（前端提示重建/删除），不抛原始堆栈
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `会话历史文件已损坏，无法解析（${detail}）。请删除该会话重建，或从备份恢复原始对话。`,
    );
  }
  const messages: ConversationMessage[] = [];

  // 预扫描：assistant 消息的 toolCall parts → toolCallId → { name, arguments }。
  // 独立于主循环（不依赖条目顺序，也在空 assistant skip 之前完成），用于把工具入参
  // 回填到对应 toolResult 消息——前端据此渲染工具卡 diff 与每轮「改动文件汇总卡片」。
  const toolCallInputs = new Map<string, { name?: string; arguments?: Record<string, unknown> }>();
  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const message = (entry as { message?: PiMessage }).message;
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (part?.type === 'toolCall' && typeof part.id === 'string') {
        toolCallInputs.set(part.id, {
          name: typeof part.name === 'string' ? part.name : undefined,
          arguments:
            part.arguments && typeof part.arguments === 'object' ? part.arguments : undefined,
        });
      }
    }
  }

  for (const entry of entries) {
    if (entry.type !== 'message') continue;
    const raw = entry as { id?: string; timestamp: string; message?: PiMessage };
    const message = raw.message;
    if (!message?.role) continue;

    // P3-B：content parts 拆分——text 拼正文、image 提取为 images 字段（前端渲染图片）
    let content = '';
    let images: Array<{ data: string; mimeType: string }> | undefined;
    if (typeof message.content === 'string') {
      content = message.content;
    } else {
      const texts: string[] = [];
      const imgs: Array<{ data: string; mimeType: string }> = [];
      for (const part of message.content ?? []) {
        if (part.type === 'image' && typeof part.data === 'string' && part.data !== '') {
          imgs.push({ data: part.data, mimeType: part.mimeType ?? 'image/png' });
        } else if (typeof part.text === 'string' && part.text !== '') {
          texts.push(part.text);
        }
      }
      content = texts.join('\n');
      if (imgs.length > 0) images = imgs;
    }
    // 兜底展示过滤：剥离混入正文的 thinking/reasoning 包裹块（正常为 text part 提取）
    content = stripThinkingContent(content);

    // 跳过空的 assistant 占位（仅含 thinking/toolCall，无 text），避免空泡
    if (message.role === 'assistant' && content === '') continue;

    const role =
      message.role === 'user' ? 'user'
      : message.role === 'assistant' ? 'assistant'
      : 'tool';

    // 附件统一给路径：消息正文就是含路径行的原文，不再做附件片段剥离/占位
    if (role === 'tool') {
      const toolEventId = message.toolCallId ?? raw.id ?? `tool-${raw.timestamp}`;
      // 回填工具入参（条件性添加：无匹配 toolCall 时不加 input 字段，保持旧数据形态）
      const tc = toolCallInputs.get(message.toolCallId ?? raw.id ?? '');
      messages.push({
        role,
        content,
        ts: raw.timestamp,
        toolEventId,
        toolName: message.toolName ?? tc?.name,
        status: 'completed',
        ...(tc?.arguments ? { input: tc.arguments } : {}),
      } as unknown as ConversationMessage);
    } else {
      messages.push({
        role,
        content,
        ts: raw.timestamp,
        images,
      });
    }
  }

  return messages;
}
