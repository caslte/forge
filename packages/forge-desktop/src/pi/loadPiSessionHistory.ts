import fs from 'node:fs';

import { SessionManager } from '@earendil-works/pi-coding-agent';

import type { ConversationMessage } from '@forge/core';
import { TEXT_ATTACHMENT_PREAMBLE } from '@forge/core';
import { stripThinkingContent } from './thinkingFilter.ts';

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

/**
 * 剥离文本附件受控片段（P3-B）：RPC 层把文件内容以 `[附件：<name>]\n<内容>` 拼进消息
 * 发给模型（上下文需要全文），展示层只保留文件名占位。多附件以「空行+片段头」切分。
 * ponytail: 按固定格式解析；附件内容自身含 `\n\n[附件：x]\n` 会被误切，真遇到再上结构化存储。
 */
const ATTACHMENT_SPLIT = /\n\n(?=\[附件：[^\]\n]+\]\n)/;
const ATTACHMENT_HEAD = /^\[附件：([^\]\n]+)\]\n/;

function extractAttachmentFiles(content: string): { text: string; files: string[] } {
  const parts = content.split(ATTACHMENT_SPLIT);
  if (parts.length < 2) return { text: content, files: [] };
  const files: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    const name = ATTACHMENT_HEAD.exec(parts[i] ?? '')?.[1];
    if (name) files.push(name);
  }
  return { text: parts[0] ?? '', files };
}

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
    // 兜底展示过滤：剥离混入正文的 thinking/reasoning 包裹块（正常为 text part 提取）
    content = stripThinkingContent(content);

    // 跳过空的 assistant 占位（仅含 thinking/toolCall，无 text），避免空泡
    if (message.role === 'assistant' && content === '') continue;

    const role =
      message.role === 'user' ? 'user'
      : message.role === 'assistant' ? 'assistant'
      : 'tool';

    // 文本附件片段只留文件名占位（内容已随 prompt 进入模型上下文，气泡里不重复展示全文）
    let files: string[] | undefined;
    if (role === 'user') {
      const parsed = extractAttachmentFiles(content);
      if (parsed.files.length > 0) {
        // 同步剥离 RPC 层前置的不可信数据声明，避免气泡里展示给用户看
        let text = parsed.text;
        if (text.endsWith(TEXT_ATTACHMENT_PREAMBLE)) {
          text = text.slice(0, text.length - TEXT_ATTACHMENT_PREAMBLE.length).trimEnd();
        }
        content = text;
        files = parsed.files;
      }
    }

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
        files,
      });
    }
  }

  return messages;
}
