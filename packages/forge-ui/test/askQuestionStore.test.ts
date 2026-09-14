/**
 * 问卷会话状态仓（`composables/askQuestionStore.ts`）的回归锁。
 *
 * 首个用例是**核心回归锁** —— 真机上出现过的「右上角读秒一直是 0」：
 * 面板常驻挂载（`v-if="!showResultView"`），`deadline` computed 在首屏（尚无问卷）
 * 就会求值并把空值**缓存**；若倒计时表不是 `reactive`，后续 `set` 不产生依赖变更，
 * computed 永不重算 → 面板拿到的 `deadline` 恒为 `null` → `tick()` 直接 return。
 * 这里显式复刻「先读一次（缓存空值）→ 再 accept → 再读」的时序。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';
import { createAskQuestionStore } from '../src/composables/askQuestionStore.ts';
import type { AskUserQuestionItem, AskUserQuestionRequestPayload } from '../src/bridge.ts';

const QUESTIONS: AskUserQuestionItem[] = [
  {
    question: '用哪个缓存实现？',
    header: 'Cache',
    options: [
      { label: '内存缓存', description: '快但进程内' },
      { label: 'Redis', description: '跨进程' },
    ],
  },
  {
    question: '要哪些能力？',
    header: 'Features',
    options: [
      { label: 'TTL', description: '过期' },
      { label: 'LRU', description: '淘汰' },
    ],
    multiSelect: true,
  },
];

function payload(over: Partial<AskUserQuestionRequestPayload> = {}): AskUserQuestionRequestPayload {
  return {
    sessionId: 's1',
    requestId: 'r1',
    questions: QUESTIONS,
    timeoutMs: 60_000,
    ...over,
  };
}

// ===== 核心回归锁 =====

test('【回归锁】deadline 在「首屏已求值」之后仍随 accept 更新（读秒恒 0 的根因）', () => {
  const sessions = ref<string | null>('s1');
  let clock = 1_000_000;
  const store = createAskQuestionStore(() => sessions.value, () => clock);

  // 面板常驻挂载：还没有问卷时三个 computed 就已经求值过一轮
  assert.equal(store.deadline.value, null);
  assert.equal(store.request.value, null);
  assert.equal(store.answered.value, null);

  store.accept(payload({ timeoutMs: 60_000 }));

  // ⚠️ 若倒计时表写成普通 Map，下面这一行会拿到缓存的 null —— 面板读秒就恒显示 0
  assert.equal(store.deadline.value, 1_060_000, 'accept 后必须能读到新的截止时刻');
  assert.equal(store.request.value?.requestId, 'r1');
});

test('【回归锁】再次 accept（新一轮问卷）时 deadline 重新求值', () => {
  const sessions = ref<string | null>('s1');
  let clock = 1_000_000;
  const store = createAskQuestionStore(() => sessions.value, () => clock);
  store.accept(payload({ timeoutMs: 60_000 }));
  assert.equal(store.deadline.value, 1_060_000);

  clock = 2_000_000;
  store.accept(payload({ requestId: 'r2', timeoutMs: 30_000 }));
  assert.equal(store.deadline.value, 2_030_000, '倒计时以最新一份载荷的 timeoutMs 重算');
  assert.equal(store.request.value?.requestId, 'r2');
});

// ===== 会话隔离 / 切换 =====

test('按 sessionId 隔离；切换会话时三个 computed 跟随刷新，切回后原状还原', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 5_000);
  store.accept(payload());

  assert.equal(store.request.value?.sessionId, 's1');
  assert.equal(store.deadline.value, 65_000);

  sessions.value = 's2';
  assert.equal(store.request.value, null, '其他会话不得看到本会话的问卷');
  assert.equal(store.deadline.value, null);
  assert.equal(store.answered.value, null);

  sessions.value = null;
  assert.equal(store.request.value, null);
  assert.equal(store.deadline.value, null);

  sessions.value = 's1';
  assert.equal(store.request.value?.sessionId, 's1', '切回后问卷仍在（按会话内存隔离）');
  assert.equal(store.deadline.value, 65_000, '倒计时是绝对截止时刻，切走再切回不重置');
});

// ===== 认领 / 提交 / 工具收尾 =====

test('accept 让上一轮已答摘要让位', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.settle('s1', { answers: [], cancelled: true, questions: QUESTIONS });
  assert.notEqual(store.answered.value, null);

  store.accept(payload({ requestId: 'r2' }));
  assert.equal(store.answered.value, null, '新一轮问卷不应还压着上一轮的摘要');
});

test('accept 后 questionsOf / requestOf 可取到该会话的题目与请求', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());

  assert.equal(store.questionsOf('s1')?.length, 2);
  assert.equal(store.requestOf('s1')?.requestId, 'r1');
  assert.equal(store.questionsOf('s2'), undefined);
  assert.equal(store.requestOf('s2'), undefined);
});

test('settle：落已答摘要并释放 request / deadline；题目保留（折叠摘要回显 n/N 用）', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  store.settle('s1', {
    answers: [
      { questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' },
    ],
    cancelled: false,
    questions: QUESTIONS,
  });

  assert.equal(store.request.value, null, '提交后面板切到已答折叠态');
  assert.equal(store.deadline.value, null, '倒计时必须释放，否则会继续读秒');
  assert.equal(store.requestOf('s1'), undefined);
  assert.equal(store.answered.value?.answers.length, 1);
  assert.equal(store.answered.value?.cancelled, false);
  assert.equal(store.questionsOf('s1')?.length, 2);
});

test('applyCompletion：权威 details 覆盖乐观摘要，并释放 request / deadline', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  // 乐观摘要（用户点了取消）先落，随后工具返回权威 details → 必须被覆盖
  store.settle('s1', { answers: [], cancelled: true, questions: QUESTIONS });
  store.accept(payload({ requestId: 'r2' }));

  store.applyCompletion('s1', {
    answers: [
      {
        questionIndex: 1,
        question: QUESTIONS[1]!.question,
        kind: 'multi',
        answer: null,
        selected: ['TTL', '自定义能力'],
      },
    ],
    cancelled: false,
  });

  assert.equal(store.request.value, null);
  assert.equal(store.deadline.value, null);
  assert.deepEqual(store.answered.value?.answers[0]?.selected, ['TTL', '自定义能力']);
  assert.equal(store.answered.value?.cancelled, false);
});

test('applyCompletion：details 非法 / 含 error / 缺失时不产出摘要，但照样释放进行中请求', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);

  // 校验失败：问卷从未投递到面板，不该弹一个空壳摘要
  store.accept(payload());
  store.applyCompletion('s1', { error: 'no_ui', answers: [], cancelled: true });
  assert.equal(store.answered.value, null, '含 error 的 details 不产出摘要');
  assert.equal(store.request.value, null, '工具已返回 —— 面板不能继续停在交互态');
  assert.equal(store.deadline.value, null, '倒计时必须一并释放');

  // details 缺失（旧后端 / mock 未透传）：同样不得污染，且必须释放
  store.accept(payload({ requestId: 'r3' }));
  store.applyCompletion('s1', undefined);
  assert.equal(store.answered.value, null);
  assert.equal(store.request.value, null);
  assert.equal(store.deadline.value, null);
});

test('clearAnswered：清摘要但不动进行中的请求（避免孤儿化扩展侧 Promise）', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  store.settle('s1', { answers: [], cancelled: true, questions: QUESTIONS });
  assert.notEqual(store.answered.value, null);

  store.clearAnswered('s1');
  assert.equal(store.answered.value, null);

  store.accept(payload({ requestId: 'r3' }));
  store.clearAnswered('s1');
  assert.equal(store.request.value?.requestId, 'r3', '清摘要不得连带取消进行中的问卷');
  assert.equal(store.deadline.value, 60_000, '进行中请求的倒计时不受影响');
});

// ===== 已答后自动收起（答完就关） =====

test('【回归锁】dismissAnswered 后，迟到的 tool.completed 不得让面板重新弹出', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  // 乐观收尾：settle 先落摘要 → 面板亮一会儿 → 自动收起
  store.settle('s1', {
    answers: [
      { questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' },
    ],
    cancelled: false,
    questions: QUESTIONS,
  });
  assert.notEqual(store.answered.value, null, '收起前摘要可见');

  store.dismissAnswered('s1');
  assert.equal(store.answered.value, null, '收起后摘要不可见');

  // ⚠️ 权威 details 通常在收起之后才到（乐观收尾的固有顺序）。若只是删表，
  // 这一行会把摘要写回去 → 面板在用户眼前重新弹出。
  store.applyCompletion('s1', {
    answers: [
      { questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' },
    ],
    cancelled: false,
  });
  assert.equal(store.answered.value, null, '迟到的权威摘要不得重新点亮面板');
  assert.equal(store.request.value, null);
  assert.equal(store.deadline.value, null);
});

test('dismissAnswered 只作用于该会话；不影响其他会话', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.settle('s2', {
    answers: [{ questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' }],
    cancelled: false,
    questions: QUESTIONS,
  });
  store.dismissAnswered('s1');

  sessions.value = 's2';
  assert.notEqual(store.answered.value, null, '别的会话的摘要不受影响');
});

test('accept 解除已收起状态：新一轮问卷的摘要照常显示', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  store.settle('s1', { answers: [], cancelled: true, questions: QUESTIONS });
  store.dismissAnswered('s1');
  assert.equal(store.answered.value, null);

  store.accept(payload({ requestId: 'r2' }));
  store.settle('s1', {
    answers: [{ questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: '内存缓存' }],
    cancelled: false,
    questions: QUESTIONS,
  });
  assert.equal(store.answered.value?.answers[0]?.answer, '内存缓存', '新一轮的摘要必须能显示');
});

test('clearAnswered 同样抑制迟到的权威摘要（用户已推进对话，摘要不该再回来）', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  store.settle('s1', {
    answers: [{ questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' }],
    cancelled: false,
    questions: QUESTIONS,
  });
  store.clearAnswered('s1');

  store.applyCompletion('s1', {
    answers: [{ questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' }],
    cancelled: false,
  });
  assert.equal(store.answered.value, null, '用户已发下一条消息，摘要不得被迟到结果顶回来');
});

test('applyCompletion 保留 deliveryFailed：权威 details 不得抹掉「答案没送出去」这个事实', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  // 用户点了提交但回填失败（IPC 失败 / 扩展已不在等待）
  store.settle('s1', {
    answers: [{ questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' }],
    cancelled: true,
    questions: QUESTIONS,
    deliveryFailed: true,
  });

  // 扩展等到超时后返回 DECLINE，`details` 里当然没有这个本地标记
  store.applyCompletion('s1', { answers: [], cancelled: true });

  assert.equal(store.answered.value?.deliveryFailed, true, '标记必须活过权威覆盖');
  assert.equal(store.answered.value?.cancelled, true);
});

test('applyCompletion 不无中生有 deliveryFailed（正常送达的轮次不得被标成失败）', () => {
  const sessions = ref<string | null>('s1');
  const store = createAskQuestionStore(() => sessions.value, () => 0);
  store.accept(payload());
  store.settle('s1', {
    answers: [{ questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' }],
    cancelled: false,
    questions: QUESTIONS,
  });

  store.applyCompletion('s1', {
    answers: [{ questionIndex: 0, question: QUESTIONS[0]!.question, kind: 'option', answer: 'Redis' }],
    cancelled: false,
  });

  assert.equal(store.answered.value?.deliveryFailed, undefined);
});
