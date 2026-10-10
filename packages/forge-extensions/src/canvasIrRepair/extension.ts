/**
 * `canvas_ir_repair` 内置扩展：IR 校验失败后自动回灌修复回执（阶段 1 闭环最后一块）。
 *
 * ## 为什么必须有（真机 17:33 截图证明）
 *
 * 模型产出缺头部字段的 IR ⇒ 渲染层显示红框回执 ⇒ **但模型不知道自己错了** ⇒
 * 用户看到的是红框 + 文字 fallback，图没了。没有修复回路，门禁就只是"报警器"不是"闭环"。
 *
 * ## 机制
 *
 * `agent_end`（拿到本轮全部消息）→ 提取 assistant 文本中的 canvas-ir 围栏 → judgeIr。
 * - 全部 ok ⇒ **静默**（绝大多数轮次零开销，一条消息都不发）
 * - 有 fail 且本轮不是重试 ⇒ `ctx.sendUserMessage(回执, {deliverAs:'followUp', triggerTurn:true})`
 *   由 forge 以用户身份发消息并触发新一轮，模型自动去修，用户零操作
 * - **重试轮再失败 ⇒ 不再回灌**，交还用户（预算上限=1 次自动修复，
 *   无限重试才是真的"重"，见 2026-09-16 评审结论）
 *
 * ## 防循环
 *
 * 回灌消息带 `[IR 修复回执]` 前缀；本轮最后一条 user 消息若已是回执 ⇒ 不再回灌。
 * 不用扩展内存标志（跨轮状态易泄漏），用消息内容自证——重试轮的输入就在 event.messages 里。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import { extractIrFences, judgeIr, formatIrReceipt } from '@forge/core/markdown';

export const IR_RETRY_TAG = '[IR 修复回执]';

/** event.messages 的最小形状（pi 的消息类型较宽，这里只依赖用到的字段）。 */
export interface MinimalMessage {
  role: string;
  content: unknown;
}

/** 把 pi 消息的 content 收敛成纯文本（string 或 text 块数组两种形态）。 */
export function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => (b && typeof b === 'object' && (b as { text?: unknown }).text ? String((b as { text: unknown }).text) : ''))
      .join('');
  }
  return '';
}

/**
 * 决策函数：本轮要不要回灌、回灌什么。
 *
 * 纯函数（ctx 交互剥离到调用侧），node:test 可锁全部分支。
 */
export function decideIrRepair(
  messages: readonly MinimalMessage[],
): { retry: boolean; text: string; code: string } | null {
  // 1) 收集 assistant 文本里的围栏并判定
  const failures: string[] = [];
  let sawFence = false;
  for (const m of messages) {
    if (m.role !== 'assistant') continue;
    for (const src of extractIrFences(messageText(m.content))) {
      sawFence = true;
      const j = judgeIr(src);
      if (j.verdict !== 'ok') {
        failures.push(formatIrReceipt(j) + '\n失败 IR 原文（重写整段围栏，不要只回 JSON 片段）：\n```canvas-ir\n' + src + '\n```');
      }
    }
  }
  if (!sawFence || failures.length === 0) return null;

  // 2) 防循环：本轮最后一条 user 消息已是回执 ⇒ 不再重试
  const lastUser = [...messages].reverse().find((m) => m.role === 'user');
  if (lastUser && messageText(lastUser.content).includes(IR_RETRY_TAG)) {
    return null;
  }

  return {
    retry: true,
    code: failures[0]!.slice(0, 4000),
    text:
      IR_RETRY_TAG + '\n'
      + failures[0]!.slice(0, 4000) + '\n\n'
      + '请只修复上述问题并重新输出完整的 ```canvas-ir 围栏（不要复述其他内容）。',
  };
}

/** 注册 agent_end 钩子。 */
export function registerCanvasIrRepair(pi: ExtensionAPI): void {
  pi.on('agent_end', async (event) => {
    const messages = ((event as { messages?: MinimalMessage[] }).messages ?? []) as readonly MinimalMessage[];
    const decision = decideIrRepair(messages);
    if (!decision) return;
    // 回灌用 pi.sendUserMessage（ExtensionAPI 方法）：它**总是触发 turn**（agent 空闲时
    // 立即开跑），无需 triggerTurn 选项；agent_end 的 ctx 上没有这个方法
    // （ExtensionCommandContext 才有）。deliverAs=followUp：等 agent 完全空闲再投递。
    await pi.sendUserMessage(decision.text, { deliverAs: 'followUp' });
  });
}

/** InlineExtension 形态。 */
export const canvasIrRepairExtension: InlineExtension = {
  name: 'forge-canvas-ir-repair',
  factory: (pi: ExtensionAPI) => registerCanvasIrRepair(pi),
};