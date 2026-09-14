/**
 * ask_user_question 面板纯逻辑单测（Path 2；契约 docs/plan/ask-user-question-contract.md §1.4 / §2.1）。
 *
 * 覆盖三处最容易漂移的约定：
 * 1. 推荐标记**双通道识别**（显式 `recommended` + label 后缀兜底）与「仅显示层剥离」；
 * 2. 草稿 → `details.answers[]` 的确定性转化（含部分作答 / 多选 / 自定义 / preview）；
 * 3. `tool.completed.details` 归约（畸形载荷、校验失败、无题目上下文三种不弹摘要的情形）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ASK_ANSWERED_AUTO_CLOSE_MS,
  RECOMMENDED_SUFFIX,
  applyAskUserCompletion,
  buildAskUserAnswers,
  canStepNext,
  canStepPrev,
  canSubmitAnswers,
  countAnswered,
  displayLabel,
  emptyDraft,
  isDraftAnswered,
  isLastStep,
  isRecommendedOption,
  questionHasPreview,
  remainingSeconds,
  shouldAutoAdvance,
  shouldAutoCloseAnswered,
  stepCount,
  summarizeAskAnswers,
  tabLabel,
  type AskDraft,
} from '../src/utils/askUserQuestion.ts';

// ===== 推荐标记（契约 §1.4）=====

test('isRecommendedOption：显式 recommended:true 与 label 后缀两条通道都能识别', () => {
  assert.equal(isRecommendedOption({ label: '内存缓存', recommended: true }), true);
  assert.equal(isRecommendedOption({ label: `路径拼接${RECOMMENDED_SUFFIX}` }), true);
  // 模型旧习惯可能带尾随空格
  assert.equal(isRecommendedOption({ label: `路径拼接${RECOMMENDED_SUFFIX}  ` }), true);
  assert.equal(isRecommendedOption({ label: '内存缓存' }), false);
  assert.equal(isRecommendedOption({ label: '内存缓存', recommended: false }), false);
  // 只认**尾部**后缀，句中出现不算
  assert.equal(isRecommendedOption({ label: `用${RECOMMENDED_SUFFIX}来做` }), false);
});

test('displayLabel：只剥离显示用的尾部后缀，不动其他文本', () => {
  assert.equal(displayLabel(`路径拼接${RECOMMENDED_SUFFIX}`), '路径拼接');
  assert.equal(displayLabel(`路径拼接${RECOMMENDED_SUFFIX} `), '路径拼接');
  assert.equal(displayLabel('内存缓存'), '内存缓存');
  assert.equal(displayLabel(`用${RECOMMENDED_SUFFIX}来做`), `用${RECOMMENDED_SUFFIX}来做`);
  assert.equal(displayLabel(''), '');
});

test('回填用 label 是**原始值**：带后缀的 label 在 answers 里不被剥离（剥离只发生在显示层）', () => {
  const questions = [
    {
      question: 'key 怎么拼？',
      header: 'Cache key',
      options: [{ label: `路径拼接${RECOMMENDED_SUFFIX}`, description: 'd' }],
    },
  ];
  const answers = buildAskUserAnswers(questions, { 0: { selected: [0], custom: '' } });
  assert.equal(answers[0]?.answer, `路径拼接${RECOMMENDED_SUFFIX}`);
});

// ===== 草稿 → details.answers =====

const QUESTIONS = [
  {
    question: '用哪个缓存实现？',
    header: 'Cache',
    options: [
      { label: '内存缓存', description: '快但进程内', preview: 'const m = new Map()' },
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
  {
    question: '部署到哪？',
    header: 'Deploy',
    options: [
      { label: '本机', description: 'a' },
      { label: '集群', description: 'b' },
    ],
  },
];

test('buildAskUserAnswers：单选命中选项 → kind=option，preview 随选项带出', () => {
  const answers = buildAskUserAnswers(QUESTIONS, { 0: { selected: [0], custom: '' } });
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], {
    questionIndex: 0,
    question: '用哪个缓存实现？',
    kind: 'option',
    answer: '内存缓存',
    preview: 'const m = new Map()',
  });
});

test('buildAskUserAnswers：选项无 preview 时不产出 preview 字段', () => {
  const answers = buildAskUserAnswers(QUESTIONS, { 0: { selected: [1], custom: '' } });
  assert.deepEqual(answers[0], {
    questionIndex: 0,
    question: '用哪个缓存实现？',
    kind: 'option',
    answer: 'Redis',
  });
  assert.equal('preview' in (answers[0] as object), false);
});

test('buildAskUserAnswers：自定义文本 → kind=custom（与选项互斥）', () => {
  const answers = buildAskUserAnswers(QUESTIONS, { 0: { selected: [], custom: '  用 memcached  ' } });
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], {
    questionIndex: 0,
    question: '用哪个缓存实现？',
    kind: 'custom',
    answer: '用 memcached',
  });
});

test('buildAskUserAnswers：多选 → kind=multi，answer=null，selected 为原始 label 列表', () => {
  const answers = buildAskUserAnswers(QUESTIONS, { 1: { selected: [1, 0], custom: '' } });
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], {
    questionIndex: 1,
    question: '要哪些能力？',
    kind: 'multi',
    answer: null,
    selected: ['LRU', 'TTL'],
  });
});

test('buildAskUserAnswers：多选自定义文本并入 selected 末位（与选项并列，不另起 kind=custom）', () => {
  const answers = buildAskUserAnswers(QUESTIONS, { 1: { selected: [0], custom: '  自定义能力  ' } });
  assert.equal(answers.length, 1);
  assert.deepEqual(answers[0], {
    questionIndex: 1,
    question: '要哪些能力？',
    kind: 'multi',
    answer: null,
    selected: ['TTL', '自定义能力'],
  });
});

test('buildAskUserAnswers：多选只填自定义、未勾任何选项 → 仍产出 kind=multi', () => {
  const answers = buildAskUserAnswers(QUESTIONS, { 1: { selected: [], custom: 'CDN 预热' } });
  assert.deepEqual(answers[0], {
    questionIndex: 1,
    question: '要哪些能力？',
    kind: 'multi',
    answer: null,
    selected: ['CDN 预热'],
  });
});

test('buildAskUserAnswers：多选空白自定义文本不并入 selected（不产出空条目）', () => {
  const answers = buildAskUserAnswers(QUESTIONS, { 1: { selected: [1], custom: '   ' } });
  assert.deepEqual((answers[0] as { selected: string[] }).selected, ['LRU']);
});

test('buildAskUserAnswers：部分作答只产出已答的题（未答的不产出条目）', () => {
  const drafts: Record<number, AskDraft> = {
    0: { selected: [1], custom: '' },
    2: { selected: [], custom: '本机 docker' },
  };
  const answers = buildAskUserAnswers(QUESTIONS, drafts);
  assert.deepEqual(
    answers.map((a) => a.questionIndex),
    [0, 2],
    '未作答的第 1 题不应产出条目，answers 由数组长度推导「已答 n/N」',
  );
});

test('buildAskUserAnswers：完全未作答 → 空数组（面板据此显示「已答 0/N」）', () => {
  assert.deepEqual(buildAskUserAnswers(QUESTIONS, {}), []);
});

test('buildAskUserAnswers：越界选项下标 / 空草稿 / 无草稿一律跳过，不抛错', () => {
  assert.deepEqual(buildAskUserAnswers(QUESTIONS, { 0: { selected: [9], custom: '' } }), []);
  assert.deepEqual(buildAskUserAnswers(QUESTIONS, { 0: emptyDraft() }), []);
  assert.deepEqual(buildAskUserAnswers([], { 0: { selected: [0], custom: '' } }), []);
});

// ===== 辅助判定 =====

test('isDraftAnswered / countAnswered：选项或非空文本都算已答', () => {
  assert.equal(isDraftAnswered(undefined), false);
  assert.equal(isDraftAnswered(emptyDraft()), false);
  assert.equal(isDraftAnswered({ selected: [0], custom: '' }), true);
  assert.equal(isDraftAnswered({ selected: [], custom: '  ' }), false);
  assert.equal(isDraftAnswered({ selected: [], custom: 'x' }), true);
  assert.equal(countAnswered(QUESTIONS, { 0: { selected: [0], custom: '' }, 2: { selected: [], custom: 'y' } }), 2);
});

test('summarizeAskAnswers：多选顿号连接、空值占位、全空回退「（已答）」', () => {
  assert.equal(summarizeAskAnswers([]), '（已答）');
  assert.equal(
    summarizeAskAnswers([
      { questionIndex: 0, question: 'q0', kind: 'option', answer: '内存缓存' },
      { questionIndex: 1, question: 'q1', kind: 'multi', answer: null, selected: ['TTL', 'LRU'] },
      { questionIndex: 2, question: 'q2', kind: 'custom', answer: '   ' },
    ]),
    '内存缓存 · TTL、LRU · （无输入）',
  );
});

test('questionHasPreview：仅单选且带非空 preview 才切左右分栏（多选不提供预览）', () => {
  assert.equal(questionHasPreview(QUESTIONS[0]!), true);
  assert.equal(questionHasPreview(QUESTIONS[1]!), false, 'multiSelect 恒不切分栏');
  assert.equal(questionHasPreview(QUESTIONS[2]!), false);
  assert.equal(
    questionHasPreview({
      question: 'q',
      header: 'h',
      options: [
        { label: 'a', description: 'a', preview: '' },
        { label: 'b', description: 'b' },
      ],
    }),
    false,
    '空字符串 preview 不算',
  );
});

test('remainingSeconds：向上取整且不为负', () => {
  assert.equal(remainingSeconds(1_000, 0), 1);
  assert.equal(remainingSeconds(1_000, 1), 1, '不足 1s 仍算 1s（ceil）');
  assert.equal(remainingSeconds(1_000, 1_000), 0);
  assert.equal(remainingSeconds(1_500, 0), 2);
  assert.equal(remainingSeconds(0, 5_000), 0);
});

test('tabLabel：超长截断加省略号（截 max-2 字符 + …，总长不超过 max）', () => {
  assert.equal(tabLabel('Cache'), 'Cache');
  assert.equal(tabLabel('12345678901234'), '12345678901234');
  assert.equal(tabLabel('123456789012345'), '123456789012…');
});

// ===== 步骤导航（向导式：末步才出现「提交答案」）=====

test('stepCount：多题 = 题目数 + 1（末位备注），单题 = 1（无 tab 栏即无步骤）', () => {
  assert.equal(stepCount(4), 5, '4 题 → 题0..题3 + 备注 = 5 步');
  assert.equal(stepCount(2), 3);
  assert.equal(stepCount(1), 1, '单题不出 tab 栏，也就没有步骤概念');
  assert.equal(stepCount(0), 1, '防御：空问卷退化为 1');
});

test('isLastStep：只有末步为真（提交按钮的渲染条件）；单题恒为真', () => {
  assert.equal(isLastStep(0, 4), false);
  assert.equal(isLastStep(3, 4), false, '第 4 题（下标 3）之后还有备注 tab，不是末步');
  assert.equal(isLastStep(4, 4), true, '备注 tab 才是末步');
  assert.equal(isLastStep(5, 4), true, '越界下标按末步处理，不会漏出提交按钮');
  assert.equal(isLastStep(0, 1), true, '单题：提交按钮常驻，与改造前一致');
});

test('canStepPrev：首步不可用，其余可用（含末步的备注 tab）', () => {
  assert.equal(canStepPrev(0), false);
  assert.equal(canStepPrev(1), true);
  assert.equal(canStepPrev(4), true, '末步仍可退回上一题');
});

test('canStepNext：末步不可用，其余可用；单题无「下一题」', () => {
  assert.equal(canStepNext(0, 4), true);
  assert.equal(canStepNext(3, 4), true, '第 4 题之后还有备注 tab');
  assert.equal(canStepNext(4, 4), false);
  assert.equal(canStepNext(0, 1), false, '单题：不出「下一题」');
});

test('末步时两个按钮互斥：只剩「上一题」+「提交答案」', () => {
  const index = 4;
  const count = 4;
  assert.equal(canStepNext(index, count), false);
  assert.equal(canStepPrev(index), true);
  assert.equal(isLastStep(index, count), true);
});

// ===== 自动前进（单选作答即切下一屏）=====

test('shouldAutoAdvance：单选且非末步 → 前进', () => {
  assert.equal(shouldAutoAdvance(false, 0, 4), true);
  assert.equal(shouldAutoAdvance(false, 2, 4), true);
});

test('shouldAutoAdvance：多选恒不前进（前进等于打断继续勾选）', () => {
  assert.equal(shouldAutoAdvance(true, 0, 4), false);
  assert.equal(shouldAutoAdvance(true, 2, 4), false);
});

test('shouldAutoAdvance：末步不前进（无路可走）', () => {
  assert.equal(shouldAutoAdvance(false, 4, 4), false, '备注 tab 是末步');
  assert.equal(shouldAutoAdvance(false, 0, 1), false, '单题无下一步');
  assert.equal(shouldAutoAdvance(true, 4, 4), false);
});

// ===== details 归约（契约 §2.1）=====

test('applyAskUserCompletion：合法 details → 已答态（questions 由调用方补齐）', () => {
  const state = applyAskUserCompletion(QUESTIONS, {
    answers: [{ questionIndex: 0, question: 'q', kind: 'option', answer: '内存缓存' }],
    cancelled: false,
    globalNote: '备注',
  });
  assert.ok(state);
  assert.equal(state.questions, QUESTIONS);
  assert.equal(state.cancelled, false);
  assert.equal(state.globalNote, '备注');
  assert.equal(state.answers.length, 1);
});

test('applyAskUserCompletion：取消态保留已答部分（超时/ESC 场景）', () => {
  const state = applyAskUserCompletion(QUESTIONS, {
    answers: [{ questionIndex: 0, question: 'q', kind: 'option', answer: '内存缓存' }],
    cancelled: true,
  });
  assert.ok(state);
  assert.equal(state.cancelled, true);
  assert.equal(state.answers.length, 1, 'cancelled 时 answers 仍带已答部分');
  assert.equal('globalNote' in state, false);
});

test('applyAskUserCompletion：全局备注为空白时不产出字段', () => {
  const state = applyAskUserCompletion(QUESTIONS, { answers: [], cancelled: false, globalNote: '   ' });
  assert.ok(state);
  assert.equal('globalNote' in state, false);
});

test('applyAskUserCompletion：畸形载荷 / 校验失败 / 无题目上下文一律返回 null（不弹空壳摘要）', () => {
  const valid = { answers: [], cancelled: false };
  assert.equal(applyAskUserCompletion(QUESTIONS, null), null);
  assert.equal(applyAskUserCompletion(QUESTIONS, undefined), null);
  assert.equal(applyAskUserCompletion(QUESTIONS, 'text'), null);
  assert.equal(applyAskUserCompletion(QUESTIONS, []), null, '数组不是合法 details');
  assert.equal(applyAskUserCompletion(QUESTIONS, { cancelled: false }), null, '缺 answers 数组');
  assert.equal(applyAskUserCompletion(QUESTIONS, { answers: 'x', cancelled: false }), null);
  assert.equal(
    applyAskUserCompletion(QUESTIONS, { ...valid, error: 'duplicate_question' }),
    null,
    '校验阶段就被拒 → 问卷从未投递，无「已答」可言',
  );
  assert.equal(applyAskUserCompletion([], valid), null, '无题目上下文 → 无法回显 n/N');
});

// ===== 提交可用性 / 已答后自动收起 =====

test('canSubmitAnswers：payload 为空时禁用提交（空 payload ≡ 取消，对模型是同一条 DECLINE）', () => {
  assert.equal(canSubmitAnswers([]), false, '一题未答 → 不给假的成功路径');
  assert.equal(
    canSubmitAnswers([{ questionIndex: 0, question: 'q', kind: 'option', answer: '内存缓存' }]),
    true,
  );
});

test('canSubmitAnswers：只填了备注、没选任何选项 → 仍禁用（备注单独不成答案）', () => {
  // 契约 §2.1：只有 globalNote、无任何答案 → 也走"取消"分支
  const drafts: Record<number, AskDraft> = { 0: { selected: [], custom: '' } };
  assert.equal(canSubmitAnswers(buildAskUserAnswers(QUESTIONS, drafts)), false);
});

test('canSubmitAnswers 与 countAnswered 在常规草稿上一致（payload 才是真判据）', () => {
  const drafts: Record<number, AskDraft> = { 0: { selected: [1], custom: '' } };
  assert.equal(countAnswered(QUESTIONS, drafts), 1);
  assert.equal(canSubmitAnswers(buildAskUserAnswers(QUESTIONS, drafts)), true);
});

test('shouldAutoCloseAnswered：正常作答 / 主动取消 / 超时归零都自动收起（答完就关）', () => {
  assert.equal(
    shouldAutoCloseAnswered({ answers: [{ questionIndex: 0, question: 'q', kind: 'option', answer: 'a' }], cancelled: false, questions: QUESTIONS }),
    true,
  );
  assert.equal(
    shouldAutoCloseAnswered({ answers: [], cancelled: true, questions: QUESTIONS }),
    true,
    '用户点了取消 → 没什么可留的',
  );
  assert.equal(
    shouldAutoCloseAnswered({
      answers: [{ questionIndex: 0, question: 'q', kind: 'option', answer: 'Redis' }],
      cancelled: true,
      questions: QUESTIONS,
    }),
    true,
    '⚠️ 超时归零：已答部分同样非空且 cancelled 为真，但那条路径答案已回填成功 → 必须收起',
  );
});

test('shouldAutoCloseAnswered：答案没送达 → 不收（否则答案静默丢失）', () => {
  assert.equal(
    shouldAutoCloseAnswered({
      answers: [{ questionIndex: 0, question: 'q', kind: 'option', answer: 'Redis' }],
      cancelled: true,
      questions: QUESTIONS,
      deliveryFailed: true,
    }),
    false,
    '答案没送达必须留在界面上让人看见',
  );
});

test('自动收起时长是正数（0 会让面板刚亮就消失，等于没有反馈）', () => {
  assert.ok(ASK_ANSWERED_AUTO_CLOSE_MS > 0);
});
