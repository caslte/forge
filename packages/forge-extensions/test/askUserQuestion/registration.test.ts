/**
 * 注册形态与模型引导文本（契约 §1.3 / §3）。
 *
 * 守两件事：
 * 1. `registerTool` 的入参字段齐全且**不实现 renderCall/renderResult**（桌面端走
 *    自己的事件总线，那两个钩子只对 pi 的 TUI 有意义）。
 * 2. 三段模型引导文本与 rpiv 一致，**仅 guideline 3 末句有意改动**（推荐标记改为
 *    `recommended: true`）。一字之差会影响模型是否/如何调用本工具。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { askUserReplyChannel } from '../../src/askUserQuestion/channels.ts';
import {
  ASK_USER_QUESTION_TOOL_NAME,
  DEFAULT_PROMPT_GUIDELINES,
  DEFAULT_PROMPT_SNIPPET,
  DEFAULT_TOOL_DESCRIPTION,
  askUserQuestionExtension,
} from '../../src/askUserQuestion/extension.ts';
import { QuestionParamsSchema } from '../../src/askUserQuestion/schema.ts';
import type { QuestionParams } from '../../src/askUserQuestion/schema.ts';

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
    params: QuestionParams,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: Array<{ type: string; text: string }>; details: { cancelled: boolean } }>;
}

function createMockPi() {
  const tools: CapturedTool[] = [];
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    tools,
    emitted,
    pi: {
      registerTool(def: CapturedTool) {
        tools.push(def);
      },
      events: {
        emit(channel: string, data: unknown) {
          emitted.push({ channel, data });
        },
        on(channel: string, handler: (data: unknown) => void) {
          let set = handlers.get(channel);
          if (!set) {
            set = new Set();
            handlers.set(channel, set);
          }
          set.add(handler);
          return () => {
            set.delete(handler);
          };
        },
      },
    },
    dispatch(channel: string, data: unknown) {
      for (const h of handlers.get(channel) ?? []) h(data);
    },
  };
}

const params: QuestionParams = {
  questions: [
    {
      question: 'Which cache key scheme?',
      header: 'Cache key',
      options: [
        { label: 'Path + query', description: 'sorted', recommended: true },
        { label: 'Path only', description: 'coarser' },
      ],
    },
  ],
};

test('InlineExtension 名称与形态正确', () => {
  assert.equal(askUserQuestionExtension.name, 'forge-ask-user-question');
  assert.equal(typeof askUserQuestionExtension.factory, 'function');
});

test('factory 注册唯一工具，字段齐全', () => {
  const { pi, tools } = createMockPi();
  askUserQuestionExtension.factory(pi as never);
  assert.equal(tools.length, 1);
  const tool = tools[0]!;
  assert.equal(tool.name, ASK_USER_QUESTION_TOOL_NAME);
  assert.equal(tool.name, 'ask_user_question');
  assert.equal(tool.label, 'Ask User Question');
  assert.equal(tool.description, DEFAULT_TOOL_DESCRIPTION);
  assert.equal(tool.promptSnippet, DEFAULT_PROMPT_SNIPPET);
  assert.deepEqual(tool.promptGuidelines, [...DEFAULT_PROMPT_GUIDELINES]);
  assert.equal(tool.parameters, QuestionParamsSchema);
});

test('不实现 renderCall / renderResult（桌面端自渲染）', () => {
  const { pi, tools } = createMockPi();
  askUserQuestionExtension.factory(pi as never);
  assert.equal(tools[0]!.renderCall, undefined);
  assert.equal(tools[0]!.renderResult, undefined);
});

test('promptGuidelines 4 条，且仅 guideline 3 末句偏离 rpiv', () => {
  assert.equal(DEFAULT_PROMPT_GUIDELINES.length, 4);
  const g3 = DEFAULT_PROMPT_GUIDELINES[2]!;
  assert.ok(g3.includes('set `recommended: true` on it'));
  assert.ok(!g3.includes('append "(Recommended)" to its label'));
  // 其余 3 条不得含推荐相关字样（避免重复引导）
  assert.ok(!DEFAULT_PROMPT_GUIDELINES[0]!.includes('Recommended'));
  assert.ok(!DEFAULT_PROMPT_GUIDELINES[1]!.includes('Recommended'));
  assert.ok(!DEFAULT_PROMPT_GUIDELINES[3]!.includes('Recommended'));
});

test('description 含 Preview feature 小节（照抄 rpiv）', () => {
  assert.ok(DEFAULT_TOOL_DESCRIPTION.includes('Preview feature:'));
  assert.ok(DEFAULT_TOOL_DESCRIPTION.includes('(Recommended)'));
});

test('execute 端到端：投递 → 回填 → envelope', async () => {
  const mock = createMockPi();
  askUserQuestionExtension.factory(mock.pi as never);
  const tool = mock.tools[0]!;

  const pending = tool.execute('tc-1', params, undefined, undefined, {});
  assert.equal(mock.emitted.length, 1);
  const requestId = (mock.emitted[0]!.data as { requestId: string }).requestId;
  assert.equal(typeof requestId, 'string');

  mock.dispatch(askUserReplyChannel(requestId), {
    requestId,
    answers: [
      { questionIndex: 0, question: 'Which cache key scheme?', kind: 'option', answer: 'Path + query' },
    ],
    cancelled: false,
  });

  const out = await pending;
  assert.equal(out.details.cancelled, false);
  assert.ok(out.content[0]!.text.startsWith('User has answered your questions:'));
});
