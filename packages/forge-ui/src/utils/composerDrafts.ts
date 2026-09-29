/**
 * 会话输入草稿仓库（内存级，模块级单例）。
 *
 * 背景：输入缓冲此前只有一份全局的（InstructionInput 的 text ref）——切会话时
 * 要么把上一会话的草稿带过去（串味）要么直接清空（丢失）；切设置页整列组件
 * 重挂载草稿更是必丢。改为按会话 key 存 { text, attachments }：InstructionInput
 * 每次编辑实时落仓，切会话 / 卸载重挂时按 key 回填。
 *
 * 只活到本次运行（不写 localStorage）：重启后草稿消失是刻意的，避免旧文本
 * 莫名复活。Map 跨组件实例共享，多窗口画布各窗按自己的会话 key 天然隔离。
 * 草稿态（新建会话未发首条 / 落地 hero）共用一个固定 key——「新会话草稿
 * 全局共享一份」为用户拍板口径；首条消息发出后草稿仓清空，内容随会话创建转由
 * 真实会话 key 管理。
 */
import type { PendingAttachment } from '../bridge';

/** 草稿态（无 sessionId）的统一 key */
export const NEW_SESSION_DRAFT_KEY = '__new_session__';

export interface ComposerDraft {
  text: string;
  attachments: PendingAttachment[];
}

const drafts = new Map<string, ComposerDraft>();

export function draftKeyOf(sessionId: string | null | undefined): string {
  return sessionId ?? NEW_SESSION_DRAFT_KEY;
}

/** 空草稿即删条目：仓库只留真正有未发送内容的会话 */
export function saveDraft(key: string, draft: ComposerDraft): void {
  if (draft.text === '' && draft.attachments.length === 0) {
    drafts.delete(key);
    return;
  }
  drafts.set(key, { text: draft.text, attachments: [...draft.attachments] });
}

/** 恒返回可回填值（无草稿时为空草稿），调用方无需判存 */
export function loadDraft(key: string): ComposerDraft {
  const d = drafts.get(key);
  return d ? { text: d.text, attachments: [...d.attachments] } : { text: '', attachments: [] };
}

/** 会话删除后清理，避免已删会话的草稿滞留 Map */
export function dropDraft(sessionId: string): void {
  drafts.delete(sessionId);
}
