import fs from 'node:fs';

import { SessionManager } from '@earendil-works/pi-coding-agent';

import type { ConversationMessage } from '@forge/core';

type PiContentPart = {
  type?: string;
  text?: string;
  /** 图片 part（P3-B 用户附件）：base64 数据 + MIME 类型 */
  data?: string;
  mimeType?: string;
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

    // 跳过空的 assistant 占位（仅含 thinking/toolCall，无 text），避免空泡
    if (message.role === 'assistant' && content === '') continue;

    const role =
      message.role === 'user' ? 'user'
      : message.role === 'assistant' ? 'assistant'
      : 'tool';

    if (role === 'tool') {
      const toolEventId = message.toolCallId ?? raw.id ?? `tool-${raw.timestamp}`;
      messages.push({
        role,
        content,
        ts: raw.timestamp,
        toolEventId,
        toolName: message.toolName,
        status: 'completed',
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
