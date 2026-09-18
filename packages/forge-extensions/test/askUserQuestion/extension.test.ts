/**
 * `askUserQuestion` 核心往返逻辑（契约 §4.1 / §4.3）。
 *
 * 用假总线（同步派发）替代 `pi.events`，覆盖：
 * - 校验拒绝短路（不投递）
 * - 正常往返（先订阅后 emit，无竞态丢包）
 * - 通道 / 载荷不匹配时不被误采纳
 * - 超时兜底、AbortSignal 中止
 * - settle 后退订（不留悬挂监听，防长会话内存泄漏）
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_USER_REQUEST_CHANNEL,
  DEFAULT_ASK_USER_TIMEOUT_MS,
  askUserReplyChannel,
} from '../../src/askUserQuestion/channels.ts';
import { DECLINE_MESSAGE } from '../../src/askUserQuestion/envelope.ts';
import { askUserQuestion } from '../../src/askUserQuestion/extension.ts';
import type { AskUserEventBus } from '../../src/askUserQuestion/extension.ts';
import type { QuestionParams } from '../../src/askUserQuestion/schema.ts';
import type { QuestionAnswer, QuestionnaireResult } from '../../src/askUserQuestion/types.ts';

interface FakeBus extends AskUserEventBus {
  emitted: Array<{ channel: string; data: unknown }>;
  dispatch(channel: string, data: unknown): void;
  listenerCount(channel: string): number;
}

function createFakeBus(): FakeBus {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  const emitted: Array<{ channel: string; data: unknown }> = [];
  return {
    emitted,
    emit(channel, data) {
      emitted.push({ channel, data });
    },
    on(channel, handler) {
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
    dispatch(channel, data) {
      for (const handler of handlers.get(channel) ?? []) handler(data);
    },
    listenerCount(channel) {
      return handlers.get(channel)?.size ?? 0;
    },
  };
}

const params: QuestionParams = {
  questions: [
    {
      question: 'Which cache key scheme?',
      header: 'Cache key',
      options: [
        { label: 'Path + query', description: 'sorted' },
        { label: 'Path only', description: 'coarser' },
      ],
    },
  ],
};

function answer(overrides: Partial<QuestionAnswer> = {}): QuestionAnswer {
  return { questionIndex: 0, question: 'Which cache key scheme?', kind: 'option', answer: 'Path + query', ...overrides };
}

/** 当前测试的假总线（由 `bus()` 建立，供 `reply()` 复用，避免每处传参）。 */
let currentBus: FakeBus;

function bus(): FakeBus {
  currentBus = createFakeBus();
  return currentBus;
}

function reply(requestId: string, result: Partial<QuestionnaireResult> = {}): void {
  currentBus.dispatch(askUserReplyChannel(requestId), {
    requestId,
    answers: [],
    cancelled: false,
    ...result,
  });
}

test('校验失败 → 短路返回 cancelled + error，且不投递', async () => {
  const b = bus();
  const out = await askUserQuestion({ questions: [] }, b);
  assert.equal(out.details.cancelled, true);
  assert.equal(out.details.error, 'no_questions');
  assert.deepEqual(out.details.answers, []);
  assert.equal(out.content[0].text, 'Error: At least one question is required');
  assert.equal(b.emitted.length, 0);
});

test('正常往返：投递载荷正确，回填后组装 envelope 与 details', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-1' });

  assert.equal(b.emitted.length, 1);
  const emitted = b.emitted[0]!;
  assert.equal(emitted.channel, ASK_USER_REQUEST_CHANNEL);
  assert.deepEqual(emitted.data, {
    requestId: 'req-1',
    questions: params.questions,
    timeoutMs: DEFAULT_ASK_USER_TIMEOUT_MS,
  });

  reply('req-1', { answers: [answer({ notes: 'go with sorted' })], cancelled: false });
  const out = await pending;

  assert.equal(out.details.cancelled, false);
  assert.equal(out.details.answers.length, 1);
  assert.equal(
    out.content[0].text,
    'User has answered your questions: "Which cache key scheme?"="Path + query". user notes: go with sorted. You can now continue with the user\'s answers in mind.',
  );
});

test('先订阅后 emit —— emit 时刻已存在监听者', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-2' });
  // emit 是同步发生的；此刻监听必须已挂上，否则同步回填会丢包
  assert.equal(b.listenerCount(askUserReplyChannel('req-2')), 1);
  reply('req-2');
  await pending;
});

test('回填到错误通道不被采纳', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-3' });
  b.dispatch(askUserReplyChannel('someone-else'), {
    requestId: 'someone-else',
    answers: [answer({ answer: 'WRONG' })],
    cancelled: false,
  });
  reply('req-3', { answers: [answer({ answer: 'RIGHT' })], cancelled: false });
  const out = await pending;
  assert.equal(out.details.answers[0]?.answer, 'RIGHT');
});

test('同通道但载荷不合法 → 忽略，等待合法回填', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-4' });
  b.dispatch(askUserReplyChannel('req-4'), { garbage: true });
  reply('req-4', { answers: [answer({ answer: 'RIGHT' })], cancelled: false });
  const out = await pending;
  assert.equal(out.details.answers[0]?.answer, 'RIGHT');
});

test('超时 → cancelled + 空作答，且释放监听', async () => {
  const b = bus();
  const out = await askUserQuestion(params, b, {
    generateRequestId: () => 'req-5',
    timeoutMs: 10,
    graceMs: 5,
  });
  assert.equal(out.details.cancelled, true);
  assert.deepEqual(out.details.answers, []);
  assert.equal(out.content[0].text, DECLINE_MESSAGE);
  assert.equal(b.listenerCount(askUserReplyChannel('req-5')), 0);
});

test('调用前已 abort → 直接 cancelled，不投递', async () => {
  const b = bus();
  const controller = new AbortController();
  controller.abort();
  const out = await askUserQuestion(params, b, { generateRequestId: () => 'req-6' }, controller.signal);
  assert.equal(out.details.cancelled, true);
  assert.equal(b.emitted.length, 0);
});

test('调用后 abort → 提前 settle 为 cancelled 并退订', async () => {
  const b = bus();
  const controller = new AbortController();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-7' }, controller.signal);
  assert.equal(b.emitted.length, 1);
  controller.abort();
  const out = await pending;
  assert.equal(out.details.cancelled, true);
  assert.equal(b.listenerCount(askUserReplyChannel('req-7')), 0);
});

test('settle 后退订：正常回填路径同样不残留监听', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-8' });
  reply('req-8');
  await pending;
  assert.equal(b.listenerCount(askUserReplyChannel('req-8')), 0);
});

test('globalNote 非空 → 进入 envelope 与 details', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-9' });
  reply('req-9', { answers: [answer()], cancelled: false, globalNote: 'heads up' });
  const out = await pending;
  assert.equal(out.details.globalNote, 'heads up');
  assert.ok(out.content[0].text.includes('global note: heads up.'));
});

test('取消但保留已答部分 → cancelled=true 且 answers 不被清空', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-10' });
  reply('req-10', { answers: [answer()], cancelled: true });
  const out = await pending;
  assert.equal(out.details.cancelled, true);
  assert.equal(out.details.answers.length, 1);
  assert.equal(out.content[0].text, DECLINE_MESSAGE);
});

test('空 globalNote 被剔除（条件展开契约）', async () => {
  const b = bus();
  const pending = askUserQuestion(params, b, { generateRequestId: () => 'req-11' });
  reply('req-11', { answers: [answer()], cancelled: false, globalNote: '' });
  const out = await pending;
  assert.ok(!('globalNote' in out.details));
  assert.equal(out.details.cancelled, false);
});
