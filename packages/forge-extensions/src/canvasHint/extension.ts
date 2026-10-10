/**
 * `canvas_hint` 内置扩展：让模型在合适的时候画图，并把画图的规矩告诉它。
 *
 * 契约：docs/plan/canvas-card.md。
 *
 * 机制：pi 的 `before_agent_start` 在用户提交提示词后、agent loop 开始前触发，
 * 拿到本轮用户原文（event.prompt），返回的 systemPrompt **只对本轮生效**。
 * 于是可以做两段式注入：
 *   - 常驻一段极短偏好（让模型知道「图优先于编号列表」）；
 *   - 命中出图意图时，再追加完整的输出契约（围栏名、禁 script、只能用注入的语义色…）。
 *
 * 为什么不直接改 forge 的系统提示词：forge 目前没有自定义系统提示
 * （createPiAgentSessionFactory 只传 agentDir/cwd/sessionManager/model/thinkingLevel），
 * 整块常驻会把 token 花在根本不需要画图的轮次上，且会一直压着用户自己的 SYSTEM.md。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import { looksLikeDiagramRequest } from './detect.ts';
import { CANVAS_SPEC, CANVAS_STANZA } from './prompt.ts';
import { IR_EXTENSION_ENV, isIrExtensionEnabled, type EnvLike } from '../canvasIrHint/extension.ts';

/**
 * 组装本轮系统提示。
 *
 * 幂等：已含常驻段就原样返回。pi 的文档说明 event.systemPrompt 是「本 handler 收到的
 * 链上当前值」，正常不会跨轮累积；但这条链由第三方 agent 框架维护，累积的后果是提示词
 * 无声膨胀且没有任何报错，一行 `includes` 换掉这个可能性是划算的。
 *
 * ## 互斥：IR 链路开启时本扩展让位（2026-10-10）
 *
 * 本契约说「围栏里写 HTML+CSS，遵守 9 条排版规则」，
 * IR 契约说「别写 HTML/CSS，只给 JSON 结构」。两者同时下发等于给模型矛盾指令，
 * 产出会是 HTML 与 IR 混杂的卡片。
 *
 * 故IR 开启时这里**一行都不注入**。回退（IR 关）时自动恢复，现状链路不受影响。
 * 环境变量名与判定口径都取自 IR 扩展，避免两处判断漂移。
 */
export function applyCanvasHint(systemPrompt: string, prompt: string, env?: EnvLike): string {
  const base = systemPrompt ?? '';
  // IR 链路接管 ⇒ 本扩展让位（两套互斥契约不可共存）
  if (isIrExtensionEnabled(env ?? process.env)) return base;
  if (base.includes(CANVAS_STANZA)) return base;
  const withStanza = `${base}\n\n${CANVAS_STANZA}`;
  if (!looksLikeDiagramRequest(prompt)) return withStanza;
  return `${withStanza}\n\n${CANVAS_SPEC.join('\n')}`;
}

/** 注册 before_agent_start 钩子。 */
export function registerCanvasHint(pi: ExtensionAPI, env?: EnvLike): void {
  const e = env ?? process.env;
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: applyCanvasHint(event.systemPrompt, event.prompt, e),
  }));
}

/** InlineExtension 形态（`DefaultResourceLoaderOptions.extensionFactories` 直装）。 */
export const canvasHintExtension: InlineExtension = {
  name: 'forge-canvas-hint',
  factory: (pi: ExtensionAPI) => registerCanvasHint(pi),
};
