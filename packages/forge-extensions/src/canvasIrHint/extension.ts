/**
 * `canvas_ir_hint` 内置扩展（阶段 1）：让模型在出图时改产出类型化 IR。
 *
 * 契约：docs/plan/canvas-ir-archify-analysis.md。
 *
 * ## 为什么必须有开关，且默认关
 *
 * 新链路与现状链路（canvasHint）是**两套互斥的指令**：
 * 前者说「别写 HTML/CSS，只给结构」，后者说「围栏里写 HTML+CSS，遵守 9 条排版规则」。
 * 同时注入会让模型收到矛盾指令，产出 HTML 与 IR 混杂的卡片。
 *
 * 但也不能无条件启用 —— 阶段 1 的出口判据是「20 轮真实对话首次通过率 ≥80%」，
 * **这个数字还没量出来**。在没有数据前把新契约推给所有用户，等于拿用户当试验田。
 *
 * 故：用环境变量开关，默认关。量出通过率、确认达标后再考虑转默认。
 *
 * ## 机制
 *
 * 与既有 canvasHint 同构：pi 的 `before_agent_start` 返回的 systemPrompt
 * 只对本轮生效，于是可以做「常驻极短偏好 + 命中出图意图才追加完整契约」的两段式。
 * 理由与代价见 canvasHint/extension.ts 的文件头，此处不重复。
 */

import type { ExtensionAPI, InlineExtension } from '@earendil-works/pi-coding-agent';

import { looksLikeDiagramRequest } from '../canvasHint/detect.ts';
import { IR_SPEC, IR_STANZA } from './promptIr.ts';

/**
 * ## 为什么默认开（2026-10-10 用户裁定）
 *
 * 用户明确要求「默认启动 dev 就 IR 开关开启」，以便直接真机验证。
 * 这是把上一阶段「备好但未接线」推到「已接线待验证」的决策。
 *
 * **风险已知**：默认开意味着 IR 链路的任何问题会直接出现在用户面前。
 * 故关闭能力必须保留为**显式 0**（不是靠「默认关」）：
 * 出问题立刻 `FORGE_IR_CANVAS=0` 即可回退到现状 HTML 链路，无需改代码。
 *
 * 回退后 canvasHint 会自动恢复注入（见 canvasHint/extension.ts 的互斥逻辑），
 * 两条链路都保证至少一条能工作。
 */

/**
 * 开关环境变量名。
 *
 * 用环境变量而非设置项：需要能在不改用户设置的前提下开关与灰度；
 * 新增设置项要动设置页 + 持久化 + i18n，超出本轮范围。
 */
export const IR_EXTENSION_ENV = 'FORGE_IR_CANVAS';

/** 进程 env 的最小形状（便于测试注入）。 */
export type EnvLike = Record<string, string | undefined>;

/**
 * 开关取值口径：**默认关**，显式 1 / on / true 才开（2026-10-10 用户回退裁定）。
 *
 * 历史轨迹：阶段 1 落地时默认关 → 用户要求默认开（便于真机验证）→ 真机跑完
 * 用户评价「不可用，还不如 html 直出，需要慢慢调优之后再用」→ 回退默认关。
 *
 * 这就是阶段 1 验收的真实结论：IR 首次通过率未达 80% 门槛（多次真机失败：
 * 漏头部字段、自创字段、连线鬼画符、缺层实体——各自已修但整体可用性未达标）。
 * 阶段 1 判定**不通过**，按预案「回去打磨提示词与排版，不加功能」。
 *
 * 开启方式（未来调优后再灰度）：FORGE_IR_CANVAS=1
 */
export function isIrExtensionEnabled(env: EnvLike): boolean {
  const raw = (env[IR_EXTENSION_ENV] ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'on' || raw === 'true';
}

/**
 * 组装本轮系统提示。
 *
 * 幂等：已含常驻段就原样返回。理由同 canvasHint/extension.ts——
 * 提示词链由第三方框架维护，累积的后果是**无声膨胀且无任何报错**。
 *
 * 注意这里不再判「是否开启」——开关已由 isIrExtensionEnabled 决定默认为开。
 * 关闭时由调用方（registerCanvasIrHint 读同一个 env）整体跳过注册内容，
 * 或通过显式 0 让本函数返回空串。
 */
export function applyIrHint(systemPrompt: string, prompt: string, env: EnvLike): string {
  const base = systemPrompt ?? '';
  // 显式关闭时一行不注入（回退路径）
  if (!isIrExtensionEnabled(env)) return base;
  if (base.includes(IR_STANZA)) return base;

  const withStanza = `${base}\n\n${IR_STANZA}`;
  if (!looksLikeDiagramRequest(prompt)) return withStanza;
  return `${withStanza}\n\n${IR_SPEC.join('\n')}`;
}

/** 注册 before_agent_start 钩子。 */
export function registerCanvasIrHint(pi: ExtensionAPI, env?: EnvLike): void {
  const e = env ?? process.env;
  // 默认开启 ⇒ 总是注册。若用户显式关闭，也仍注册但内部返回原串（少一层钩子开销差异，
  // 换来「两条链路的开关口径完全一致」，避免出现「IR 关了但 hook 行为不同」这类难查问题）。
  pi.on('before_agent_start', async (event) => ({
    systemPrompt: applyIrHint(event.systemPrompt, event.prompt, e),
  }));
}

/** InlineExtension 形态（`DefaultResourceLoaderOptions.extensionFactories` 直装）。 */
export const canvasIrHintExtension: InlineExtension = {
  name: 'forge-canvas-ir-hint',
  factory: (pi: ExtensionAPI) => registerCanvasIrHint(pi),
};