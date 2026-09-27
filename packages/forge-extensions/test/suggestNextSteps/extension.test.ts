/**
 * suggest_next_steps 注册形态与执行逻辑（契约 docs/plan/suggest-next-steps.md）。
 *
 * 守四件事：
 * 1. InlineExtension 注册唯一工具、字段齐全、不实现 renderCall/renderResult；
 * 2. validateSteps 二层校验（空白条目 / 重复条目整体拒绝）；
 * 3. execute 非阻塞往返：合法入参立即返回展示回执，非法返回 Rejected 文案；
 * 4. 轮次收束（AC-SG-05）：合法→terminate:true 让 pi 跳过工具批次后的补跑；
 *    非法→不带 terminate，把重试空间留给模型。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SUGGEST_NEXT_STEPS_TOOL_NAME,
  SUGGEST_PROMPT_GUIDELINES,
  SUGGEST_PROMPT_SNIPPET,
  SUGGEST_TOOL_DESCRIPTION,
  suggestNextSteps,
  suggestNextStepsExtension,
  validateSteps,
} from '../../src/suggestNextSteps/extension.ts';
import { SuggestParamsSchema } from '../../src/suggestNextSteps/schema.ts';
import type { SuggestParams } from '../../src/suggestNextSteps/schema.ts';

interface CapturedTool {
  name: string;
  label: string;
  description: string;
  promptSnippet?: string;
  promptGuidelines?: string[];
  parameters: unknown;
  renderCall?: unknown;
  renderResult?: unknown;
  execute: (
    toolCallId: string,
    params: SuggestParams,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: { steps: string[]; error?: string }; terminate?: boolean }>;
}

function createMockPi() {
  const tools: CapturedTool[] = [];
  return {
    tools,
    pi: {
      registerTool(def: CapturedTool) {
        tools.push(def);
      },
      events: {
        emit() {},
        on() {
          return () => {};
        },
      },
    },
  };
}

test('InlineExtension 名称与形态正确', () => {
  assert.equal(suggestNextStepsExtension.name, 'forge-suggest-next-steps');
  assert.equal(typeof suggestNextStepsExtension.factory, 'function');
});

test('factory 注册唯一工具，字段齐全', () => {
  const { pi, tools } = createMockPi();
  suggestNextStepsExtension.factory(pi as never);
  assert.equal(tools.length, 1);
  const tool = tools[0]!;
  assert.equal(tool.name, SUGGEST_NEXT_STEPS_TOOL_NAME);
  assert.equal(tool.name, 'suggest_next_steps');
  assert.equal(tool.label, 'Suggest Next Steps');
  assert.equal(tool.description, SUGGEST_TOOL_DESCRIPTION);
  assert.equal(tool.promptSnippet, SUGGEST_PROMPT_SNIPPET);
  assert.deepEqual(tool.promptGuidelines, [...SUGGEST_PROMPT_GUIDELINES]);
  assert.equal(tool.parameters, SuggestParamsSchema);
  assert.equal(tool.renderCall, undefined);
  assert.equal(tool.renderResult, undefined);
});

test('promptGuidelines 恰 5 条（何时调用/怎么写/不做什么/收尾时机/不许自己开工）', () => {
  assert.equal(SUGGEST_PROMPT_GUIDELINES.length, 5);
  // 末条锁死「建议之后不再动手」，缺了它模型会在补跑里自己执行第 1 条建议
  assert.match(SUGGEST_PROMPT_GUIDELINES[4]!, /do not|wait|never/i);
});

test('validateSteps：合法入参 trim 后原样通过', () => {
  const out = validateSteps({ steps: [' 落设计文档并评审 ', '跑一轮单测'] });
  assert.deepEqual(out, { ok: true, steps: ['落设计文档并评审', '跑一轮单测'] });
});

test('validateSteps：空白条目整体拒绝', () => {
  const out = validateSteps({ steps: ['ok', '   '] });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.message : '', /blank/);
});

test('validateSteps：重复条目整体拒绝', () => {
  const out = validateSteps({ steps: ['同一句', '同一句'] });
  assert.equal(out.ok, false);
  assert.match(out.ok === false ? out.message : '', /distinct/);
});

test('suggestNextSteps：合法 → 展示回执 + details.steps', () => {
  const res = suggestNextSteps({ steps: ['落设计文档并评审'] });
  assert.equal(res.content[0]!.text, 'Next-step suggestions displayed to the user.');
  assert.deepEqual(res.details, { steps: ['落设计文档并评审'] });
});

// AC-SG-05：建议是本轮最后一个动作。pi 在工具批次后会默认补跑一次 LLM，
// 不带 terminate 时模型会在补跑里自己执行第 1 条建议（表现为「拼命往下钻」）。
test('suggestNextSteps：合法 → terminate:true（建议后不再补 LLM 调用）', () => {
  const res = suggestNextSteps({ steps: ['落设计文档并评审'] });
  assert.equal(res.terminate, true);
});

test('suggestNextSteps：非法 → 不带 terminate（留重试空间给模型）', () => {
  const res = suggestNextSteps({ steps: ['', 'x'] });
  assert.equal(res.terminate, undefined);
});

test('suggestNextSteps：非法 → Rejected 文案回流模型', () => {
  const res = suggestNextSteps({ steps: ['', 'x'] });
  assert.equal(res.details.steps.length, 0);
  assert.ok(res.details.error);
  assert.match(res.content[0]!.text, /^Rejected: /);
});

test('execute 立即返回（非阻塞，无事件投递）', async () => {
  const { pi, tools } = createMockPi();
  suggestNextStepsExtension.factory(pi as never);
  const tool = tools[0]!;
  const out = await tool.execute('tc-1', { steps: ['继续'] });
  assert.deepEqual(out.details, { steps: ['继续'] });
});

test('execute 透传 terminate:true（注册工具与原函数口径一致）', async () => {
  const { pi, tools } = createMockPi();
  suggestNextStepsExtension.factory(pi as never);
  const tool = tools[0]!;
  const ok = await tool.execute('tc-1', { steps: ['继续'] });
  assert.equal(ok.terminate, true);
  const bad = await tool.execute('tc-2', { steps: ['dup', 'dup'] });
  assert.equal(bad.terminate, undefined);
});
