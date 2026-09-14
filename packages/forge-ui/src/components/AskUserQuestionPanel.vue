<!--
  ask_user_question 内嵌问卷面板（Path 2，契约 docs/plan/ask-user-question-contract.md）。

  数据源与生命周期由 `useSessionConversation` 持有（按 sessionId 内存隔离）：
  - `request` 非空 → **交互态**：N+1 tab（多题时）、选项单选/多选、自定义答案、
    全局备注、左右分栏 preview、「推荐」标记、**超时倒计时**
  - `request` 为空且 `answered` 非空 → **已答折叠态**：仅标题 + 「已回答」徽标 +
    「已答 n/N」摘要（不复渲染交互内容）
  - 两者皆空 → 不渲染（组件整体卸载）

  步骤导航（向导式，多题时）：**操作条整体挂在标题行**（标题右侧、状态徽标左侧），
  依次为「已答 n/N」「上一题」「下一题」「取消」「提交答案」；导航按 `activeTab ± 1` 走
  **完整 tab 序列**（题目 0..N-1 + 末位备注），「提交答案」**只在末步渲染**。
  理由：中间步就能提交时，用户在 `已答 0/N` 下误点提交会产出零段 envelope →
  模型收到 `DECLINE_MESSAGE`，与「点取消」**完全无法区分**（`envelope.ts:76`）。
  末步收敛后这条歧义路径消失。tab 仍可自由点击（不强制顺序），两种导航不冲突。
  单题无 tab 栏 → `stepCount=1` → 不出导航、提交按钮常驻（与改造前一致）。

  **单选即自动前进**（`autoAdvance`）：点中某个普通选项后自动切到下一步，
  「上一题 / 下一题」留给用户手动回看改答案。三条不前进的例外：
  1. 多选（还要继续勾，前进等于打断）；2. 点「自己答」选项（需要留时间输入）；
  3. 已在末步（无下一步可去）。

  自定义答案（「自己答」）**压缩成选项列表末位的一行**，与普通选项同款形态
  （单选 radio / 多选 checkbox），选中才在其下方整宽展开输入框。四条约束：
  1. **单选互斥**：勾任一普通选项即撤销「自己答」并清空已输入文本（契约 §2.1 的
     `kind` 只有 option / custom / multi 三态，`buildAskUserAnswers` 里 custom
     优先于 option —— 不清空会让残留文本静默覆盖用户刚勾的选项）；
  2. **多选并列**：多选时它是与其它选项平级的一项，勾普通选项**不动**它的文本，
     收起输入框也**不丢**文本（已计入 `selected`，故 `customRowSelected` 仍为真）；
     提交时文本并入 `selected` 末位，不额外产出 `kind='custom'` 条目；
  3. 展开态按 tab 记忆（`customOpenByTab`），切走再切回仍是展开的，不走 AskDraft
     （它是纯 UI 展开态，「选中自己答但没输入」不应计入「已答 n/N」）；
  4. 在 preview 分栏模式下也整宽展开（照抄 rpiv guideline：不要把它挤进窄窄的
     选项列里）。

  **尺寸稳定（禁止跳动）**：右侧 preview 面板固定高度 + 内部滚动，切换 / hover
  不同选项时高度不变形；否则每次 hover 到一个 preview 更长的选项，整个面板高度
  和下方输入框位置都会上下跳。

  浮窗形态与 TodoPanel 一致（opencode 风格）：与输入框 compose-box 同材质、同顶部
  圆角，底部以 -10px 负 margin 塞进输入框背后 —— 形成「从输入框延伸出去」的一体感，
  不遮挡消息流。

  超时（契约 §4.3 硬约束）：倒计时时长**取载荷下发的 `timeoutMs`，不硬编码**；
  归零时必须**主动回填**「已答部分 + cancelled:true」，否则「超时保留已答部分」失效
  （extension 侧只能看到超时那一刻的空快照）。

  已答态（收尾）：提交后摘要只亮 `ASK_ANSWERED_AUTO_CLOSE_MS`，随即 `emit('dismiss')`
  让父级把面板**折叠关闭** —— 答案已回填给模型，消息流里也有工具卡片留痕，没必要再占着
  输入框上方。唯一例外是「已作答但回填失败」（`shouldAutoCloseAnswered` 为假），
  那种情况必须留着让人看见，否则答案会静默丢失。
  另外，`提交答案` 在 payload 为空时**禁用**（`canSubmitAnswers`）—— 空 payload 落到
  扩展侧是与「取消」完全相同的 DECLINE 信号，禁用后这条信号只能由显式取消产出。

  推荐标记（契约 §1.4）：双通道识别 —— `recommended === true` 或 label 尾部
  `(Recommended)` 后缀；识别到后者时**仅显示层**剥离后缀，回填给模型的 label 不加改动。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { renderMarkdown } from '@forge/core/markdown';
import type {
  AskUserQuestionAnswer,
  AskUserQuestionItem,
  AskUserQuestionRequestPayload,
} from '../bridge';
import {
  ASK_ANSWERED_AUTO_CLOSE_MS,
  RECOMMENDED_SUFFIX,
  buildAskUserAnswers,
  canStepNext,
  canStepPrev,
  canSubmitAnswers,
  countAnswered,
  displayLabel,
  emptyDraft,
  isLastStep,
  isRecommendedOption,
  questionHasPreview,
  remainingSeconds,
  shouldAutoAdvance,
  shouldAutoCloseAnswered,
  summarizeAskAnswers,
  tabLabel,
  type AskDraft,
  type AskUserAnsweredState,
} from '../utils/askUserQuestion';

const props = defineProps<{
  /** 当前会话 id（仅用于调试/断言；归属判定在 composable 内完成） */
  sessionId: string | null;
  /** 当前会话待作答问卷；null = 无进行中的问卷 */
  request: AskUserQuestionRequestPayload | null;
  /**
   * 倒计时绝对截止时刻（epoch ms，由 composable 在请求到达时按 `timeoutMs` 算出）。
   *
   * **为什么用绝对时刻而不是每次挂载重新计时**：问卷在会话 A 进行中时用户切到会话 B
   * 再切回，本组件会重新挂载；若按 `timeoutMs` 重新起算，倒计时会被拉长到超过扩展侧
   * 的 `timeoutMs + graceMs` 真超时，归零回填时 extension 早已收敛（作答被丢弃）。
   * 用绝对时刻则切走/切回后剩余秒数连续。
   */
  deadline: number | null;
  /** 最近一次已答结果（request 为空时渲染折叠摘要） */
  answered: AskUserAnsweredState | null;
}>();

const emit = defineEmits<{
  (
    e: 'submit',
    payload: { answers: AskUserQuestionAnswer[]; cancelled: boolean; globalNote?: string },
  ): void;
  /**
   * 已答摘要展示完毕 → 请求父级收起（面板折叠关闭）。
   *
   * 收起动作**必须由父级执行**：摘要的存续由 composable 的状态仓持有（按 sessionId
   * 隔离），组件只负责渲染。组件自己藏起来的话，切走再切回来摘要会重新出现。
   */
  (e: 'dismiss'): void;
}>();

// ===== 交互态本地状态（按 requestId 重置） =====

const drafts = ref<Record<number, AskDraft>>({});
const activeTab = ref(0);
const globalNote = ref('');
const collapsed = ref(false);
const previewOptionIndex = ref<number | null>(null);
/**
 * 「自己答」选项的展开态，按 tab 下标记忆（不在 AskDraft 里 —— 它纯是 UI 展开态，
 * 「选中自己答但还没输入」不该计入「已答 n/N」）。缺失即未选中 / 未展开。
 */
const customOpenByTab = ref<Record<number, boolean>>({});

const questions = computed<AskUserQuestionItem[]>(() => props.request?.questions ?? []);
const isMultiQuestion = computed(() => questions.value.length > 1);
/** 备注 tab 的下标 = 题目数（仅多题时存在） */
const noteTabIndex = computed(() => questions.value.length);
const onNoteTab = computed(() => isMultiQuestion.value && activeTab.value === noteTabIndex.value);
const activeQuestion = computed<AskUserQuestionItem | null>(() =>
  onNoteTab.value ? null : (questions.value[activeTab.value] ?? null),
);
const activeDraft = computed<AskDraft>(
  () => drafts.value[activeTab.value] ?? emptyDraft(),
);
const previewMode = computed(() => {
  const q = activeQuestion.value;
  return q !== null && questionHasPreview(q);
});
/** 右侧预览面板当前展示的选项（显式 hover 优先 → 已选项 → 首个带 preview 的项） */
const previewOption = computed(() => {
  const q = activeQuestion.value;
  if (q === null) return null;
  const explicit = previewOptionIndex.value;
  if (explicit !== null) {
    const opt = q.options[explicit];
    if (opt !== undefined && typeof opt.preview === 'string' && opt.preview !== '') return opt;
  }
  const selectedIdx = activeDraft.value.selected[0];
  if (selectedIdx !== undefined) {
    const opt = q.options[selectedIdx];
    if (opt !== undefined && typeof opt.preview === 'string' && opt.preview !== '') return opt;
  }
  return q.options.find((o) => typeof o.preview === 'string' && o.preview !== '') ?? null;
});

const answeredCount = computed(() => countAnswered(questions.value, drafts.value));
/**
 * 当前草稿会产出的答案条目（提交按钮可用性 / 提交载荷共用同一份构造）。
 * 用它的长度而不是 `answeredCount` 判断「能不能提交」—— 二者理论上等价（见
 * `canSubmitAnswers` 注释），但 payload 才是真正发给模型的东西，以它为准不分叉。
 */
const draftAnswers = computed(() => buildAskUserAnswers(questions.value, drafts.value));
/** 当前题是否展开了「自己答」输入框（决定输入框是否渲染） */
const activeCustomOpen = computed(() => customOpenByTab.value[activeTab.value] === true);
/**
 * 「自己答」这一**行**的选中态。
 *
 * 单选下与 `activeCustomOpen` 等价（文本只能经本行输入，输入即展开）。
 * 多选下多一种情形：收起输入框后文本仍在 —— 它依旧计入 `selected`，行必须保持选中，
 * 否则界面会谎称「这一项没被选」，而提交出去的答案里却带着它。
 */
const customRowSelected = computed(
  () =>
    activeCustomOpen.value ||
    (activeQuestion.value?.multiSelect === true && activeDraft.value.custom.trim() !== ''),
);

function setCustomOpen(tab: number, open: boolean): void {
  const next = { ...customOpenByTab.value };
  if (open) next[tab] = true;
  else delete next[tab];
  customOpenByTab.value = next;
}

function isAnsweredTab(index: number): boolean {
  return index !== noteTabIndex.value && (drafts.value[index]?.selected.length ?? 0) > 0;
}
function isAnsweredTabCustom(index: number): boolean {
  return (drafts.value[index]?.custom.trim() ?? '') !== '';
}

/** 提交/超时共用的载荷构造 */
function collectPayload(cancelled: boolean): {
  answers: AskUserQuestionAnswer[];
  cancelled: boolean;
  globalNote?: string;
} {
  const note = globalNote.value.trim();
  return {
    answers: draftAnswers.value,
    cancelled,
    ...(note !== '' ? { globalNote: note } : {}),
  };
}

// ===== 倒计时（契约 §4.3：时长取载荷下发值；归零主动回填已答部分） =====

const remaining = ref(0);
let ticker: ReturnType<typeof setInterval> | null = null;
/** 本次请求是否已回填过（防「超时回填」与「用户提交」竞态重复上报） */
let settled = false;

function stopTicker(): void {
  if (ticker !== null) {
    clearInterval(ticker);
    ticker = null;
  }
}

function submit(cancelled: boolean): void {
  if (settled) return;
  settled = true;
  stopTicker();
  emit('submit', collectPayload(cancelled));
}

function tick(): void {
  const at = props.deadline;
  if (at === null) return;
  remaining.value = remainingSeconds(at, Date.now());
  if (remaining.value <= 0) {
    // 归零：主动回填已答部分（cancelled=true），而非干等主进程超时
    submit(true);
  }
}

function startTicker(): void {
  stopTicker();
  tick();
  ticker = setInterval(tick, 500);
}

/** requestId 变化 = 新的问卷：重置全部本地态 + 按绝对截止时刻重启倒计时 */
watch(
  () => props.request?.requestId ?? null,
  (requestId) => {
    settled = false;
    drafts.value = {};
    activeTab.value = 0;
    globalNote.value = '';
    collapsed.value = false;
    previewOptionIndex.value = null;
    customOpenByTab.value = {};
    stopTicker();
    if (requestId !== null) {
      startTicker();
    }
  },
  { immediate: true },
);

/**
 * 截止时刻变化的兜底启停。
 *
 * 面板是**常驻挂载**的（`v-if="!showResultView"`，首屏无问卷时也挂着），所以
 * 不能只靠上面那个 requestId watch：它 `immediate` 跑在挂载时拿不到 request，
 * 后续只在 requestId 真正变化时才重启。deadline 与 requestId 虽同批写入、
 * 理论上够用，但一旦某个路径只更新了 deadline（或上游 Map 忘了做成响应式），
 * 读秒就会静默停在 0 —— 这里做一层自愈：只要有有效截止时刻就保证表在跑，
 * 释放（提交 / tool.completed 清表）时停表归零。
 */
watch(
  () => props.deadline,
  (at) => {
    if (at === null) {
      stopTicker();
      remaining.value = 0;
      return;
    }
    if (props.request !== null) startTicker();
  },
);

// ===== 已答折叠态（三个「显示哪个形态」的开关，必须定义在下方 watch 之前）=====
//
// ⚠️ 顺序敏感：下面「已答后自动折叠关闭」的 watch 在 setup 期就会**同步求值一次**
// getter（Vue 的 `doWatch` 建 effect 时即 `effect.run()` 收集依赖，不需要 `immediate`）。
// 若 `showAnswered` 定义在它之后，那次求值会撞上 `const` 的 TDZ：
// `ReferenceError: Cannot access 'showAnswered' before initialization` →
// setup 抛错 → 本组件渲染中断 → **连累整个 ConversationView 更新失败，右侧对话区整块空白**
//（真机现象）。组件层没有单测设施，这类「声明顺序」回归只有 e2e（E-CV-028）兜得住。
const answeredSummary = computed(() => summarizeAskAnswers(props.answered?.answers ?? []));
const answeredTotal = computed(() => props.answered?.questions.length ?? 0);
const answeredCountFinal = computed(() => props.answered?.answers.length ?? 0);
const answeredHeading = computed(
  () => props.answered?.questions[0]?.question ?? '问卷已作答',
);

const showInteractive = computed(() => props.request !== null);
const showAnswered = computed(() => props.request === null && props.answered !== null);
const visible = computed(() => showInteractive.value || showAnswered.value);
const headingText = computed(() => {
  if (showAnswered.value) return answeredHeading.value;
  if (onNoteTab.value) return '备注';
  const q = activeQuestion.value;
  return q === null ? '' : q.question;
});

// ===== 已答后自动折叠关闭（对齐 TodoPanel 的自动收起节奏） =====

let closeTimer: ReturnType<typeof setTimeout> | null = null;

function cancelAutoClose(): void {
  if (closeTimer !== null) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/**
 * 已答摘要亮一小会儿就收起（用户要求：答完就关，AI 已经拿到答案了）。
 *
 * 挂在 `showAnswered`（布尔）而不是 `props.answered`（对象）上：`tool.completed`
 * 会用权威 `details` **整体替换**摘要对象，若监听对象引用，这次替换会重新触发
 * watch 并把计时器往后推 —— 面板的消失时机会随「权威结果什么时候到」飘。
 * 布尔量在这期间保持 true，不重复触发。
 *
 * 是否该自动收由 `shouldAutoCloseAnswered` 判定：**已作答但回填失败**时不收
 *（那种情况必须留在界面上，见该函数注释）。
 */
watch(
  () => showAnswered.value,
  (answeredNow) => {
    cancelAutoClose();
    if (!answeredNow) return;
    const state = props.answered;
    if (state === null || !shouldAutoCloseAnswered(state)) return;
    closeTimer = setTimeout(() => {
      closeTimer = null;
      emit('dismiss');
    }, ASK_ANSWERED_AUTO_CLOSE_MS);
  },
);

onBeforeUnmount(cancelAutoClose);

// ===== 选项 / 自定义答案 / 备注 =====

/** 单选作答后自动前进到下一步（多选与「自己答」不前进，见组件头注释） */
function autoAdvance(): void {
  const multiSelect = activeQuestion.value?.multiSelect === true;
  if (!shouldAutoAdvance(multiSelect, activeTab.value, questions.value.length)) return;
  switchTab(activeTab.value + 1);
}

function selectOption(optionIndex: number): void {
  const question = activeQuestion.value;
  if (question === null) return;
  const tab = activeTab.value;
  const current = drafts.value[tab] ?? emptyDraft();
  if (question.multiSelect === true) {
    // 多选：「自己答」是与其它选项**并列**的一项，勾/取消普通选项不动它的文本
    //（契约 §2.1 multi 的 selected 数组里它可以占末位，见 buildAskUserAnswers）。
    const next = current.selected.includes(optionIndex)
      ? current.selected.filter((i) => i !== optionIndex)
      : [...current.selected, optionIndex];
    drafts.value = { ...drafts.value, [tab]: { selected: next, custom: current.custom } };
    return; // 多选不自动前进：用户还要继续勾
  }
  // 单选：「自己答」与选项互斥 —— 勾任一普通选项即撤销它并清空文本。不清会让
  // buildAskUserAnswers 里 custom 优先的分支**静默吃掉刚勾的选项**（契约 §2.1 三态互斥）。
  drafts.value = { ...drafts.value, [tab]: { selected: [optionIndex], custom: '' } };
  setCustomOpen(tab, false);
  autoAdvance(); // 单选 = 该题作答完成，自动切到下一步
}

/**
 * 点「自己答」行。
 *
 * - 单选：选中（清空已选选项，互斥）+ 展开输入框，不自动前进（要留时间输入）。
 * - 多选：它与其它选项并列 → 行为是**开关**，且必须**不动**已勾选项；收起只折输入框、
 *   不丢文本（文本已计入答案，误触收起不该抹掉，故 `customRowSelected` 仍为真）。
 */
function selectCustom(): void {
  const question = activeQuestion.value;
  if (question === null) return;
  const tab = activeTab.value;
  if (question.multiSelect === true) {
    const open = customOpenByTab.value[tab] !== true;
    setCustomOpen(tab, open);
    if (open) void nextTick(() => focusCustom());
    return;
  }
  const current = drafts.value[tab] ?? emptyDraft();
  drafts.value = { ...drafts.value, [tab]: { selected: [], custom: current.custom } };
  setCustomOpen(tab, true);
  // textarea 是本轮渲染才出现的（v-if），等 DOM 落地再聚焦
  void nextTick(() => focusCustom());
}

function onCustomInput(value: string): void {
  const tab = activeTab.value;
  const current = drafts.value[tab] ?? emptyDraft();
  // 单选：输入即清空选项（互斥）；多选：保留已勾选项（并列，文本只是其中一项）
  const keepSelected = activeQuestion.value?.multiSelect === true ? current.selected : [];
  drafts.value = { ...drafts.value, [tab]: { selected: keepSelected, custom: value } };
}

const customRef = ref<HTMLTextAreaElement | null>(null);

function focusCustom(): void {
  const el = customRef.value;
  if (el === null) return;
  el.focus();
  el.setSelectionRange(el.value.length, el.value.length);
}

function switchTab(index: number): void {
  activeTab.value = index;
  previewOptionIndex.value = null;
}

/** 步骤导航（多题）：与点 tab 同路径 —— 同样重置 hover 预览，避免上一题的预览残留 */
function stepPrev(): void {
  if (!canStepPrev(activeTab.value)) return;
  switchTab(activeTab.value - 1);
}

function stepNext(): void {
  if (!canStepNext(activeTab.value, questions.value.length)) return;
  switchTab(activeTab.value + 1);
}

function toggleCollapsed(): void {
  collapsed.value = !collapsed.value;
}

// ESC = 取消（契约验收「取消路径（X / ESC / 超时）」）：仅在交互态生效
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape') return;
  if (props.request === null) return;
  submit(true);
}
if (typeof document !== 'undefined') {
  document.addEventListener('keydown', onKeydown);
}

onBeforeUnmount(() => {
  stopTicker();
  if (typeof document !== 'undefined') {
    document.removeEventListener('keydown', onKeydown);
  }
});

</script>

<template>
  <Transition name="ask-panel-hide">
    <div
      v-if="visible"
      class="ask-panel"
      :class="{ 'ask-panel-collapsed': showAnswered || collapsed }"
      data-testid="ask-panel"
    >
      <!-- 头部：折叠开关（图标 + 标题 + chevron）+ **操作条**（已答 n/N / 上一题 /
           下一题 / 取消 / 提交答案）+ 状态徽标（等待回答·倒计时 或 已回答）。
           操作条放这里而不是底部：底部是消息流方向，按钮沉在下面会被输入框挤到
           视野外；顶部一行常驻可见，也避免底部多一条视觉分隔。
           整行仍是折叠开关（照旧「点头部任意处切换」），故操作条必须 @click.stop ——
           否则点「提交答案」会顺带把面板折叠掉。
           已答态不可折叠（保留为完成汇总，与原型一致），也没有操作条。 -->
      <div
        class="ask-heading"
        :class="{ 'is-toggle': !showAnswered }"
        data-testid="ask-heading"
        role="button"
        tabindex="0"
        :aria-expanded="!(showAnswered || collapsed)"
        @click="showAnswered ? undefined : toggleCollapsed()"
        @keydown.enter.prevent="showAnswered ? undefined : toggleCollapsed()"
        @keydown.space.prevent="showAnswered ? undefined : toggleCollapsed()"
      >
        <span class="ask-heading-icon" aria-hidden="true">?</span>
        <span class="ask-heading-text" data-testid="ask-heading-text">{{ headingText }}</span>

        <!-- 操作条：折叠时随之隐藏（收起了就没有可操作的正文） -->
        <div v-if="showInteractive && !collapsed" class="ask-head-actions" @click.stop>
          <span class="ask-progress" data-testid="ask-progress">
            已答 {{ answeredCount }}/{{ questions.length }}
          </span>
          <button
            v-if="isMultiQuestion && canStepPrev(activeTab)"
            type="button"
            class="ask-btn ask-btn-mini ask-btn-nav"
            data-testid="ask-prev"
            @click="stepPrev"
          >上一题</button>
          <button
            v-if="isMultiQuestion && canStepNext(activeTab, questions.length)"
            type="button"
            class="ask-btn ask-btn-mini ask-btn-nav"
            data-testid="ask-next"
            @click="stepNext"
          >下一题</button>
          <button
            type="button"
            class="ask-btn ask-btn-mini"
            data-testid="ask-cancel"
            @click="submit(true)"
          >取消</button>
          <button
            v-if="isLastStep(activeTab, questions.length)"
            type="button"
            class="ask-btn ask-btn-mini primary"
            :disabled="!canSubmitAnswers(draftAnswers)"
            :title="
              canSubmitAnswers(draftAnswers)
                ? undefined
                : '至少要作答一题；只想拒绝作答请点「取消」'
            "
            data-testid="ask-submit"
            @click="submit(false)"
          >提交答案</button>
        </div>

        <span v-if="showAnswered" class="ask-meta done" data-testid="ask-meta-done">已回答</span>
        <span v-else class="ask-meta live" data-testid="ask-meta-live">
          等待回答 · {{ remaining }}s
        </span>
        <span v-if="!showAnswered" class="ask-chevron" aria-hidden="true">
          {{ collapsed ? '▸' : '▾' }}
        </span>
      </div>

      <!-- 已答折叠摘要 -->
      <div v-if="showAnswered" class="ask-answered" data-testid="ask-answered-summary">
        <span class="ask-pill">
          已答 {{ answeredCountFinal }}/{{ answeredTotal }}
          <template v-if="answered?.cancelled">（已取消）</template>
        </span>
        <span class="ask-answered-text">{{ answeredSummary }}</span>
        <span v-if="answered?.globalNote" class="ask-answered-note">
          备注：{{ answered.globalNote }}
        </span>
      </div>

      <!-- 交互态 body -->
      <div v-else class="ask-body">
        <div class="ask-body-inner">
          <div class="ask-body-content">
            <!-- tab 栏（多题时；末位固定「备注」） -->
            <div v-if="isMultiQuestion" class="ask-tabs" role="tablist">
              <button
                v-for="(q, i) in questions"
                :key="`tab-${i}`"
                type="button"
                class="ask-tab"
                :class="{ active: activeTab === i, done: isAnsweredTab(i) || isAnsweredTabCustom(i) }"
                :data-testid="`ask-tab-${i}`"
                role="tab"
                :aria-selected="activeTab === i"
                @click="switchTab(i)"
              >
                <span class="ask-tab-dot" aria-hidden="true" />
                <span class="ask-tab-label">{{ tabLabel(q.header || q.question) }}</span>
              </button>
              <button
                type="button"
                class="ask-tab"
                :class="{ active: onNoteTab }"
                data-testid="ask-tab-note"
                role="tab"
                :aria-selected="onNoteTab"
                @click="switchTab(noteTabIndex)"
              >
                <span class="ask-tab-dot" aria-hidden="true" />
                <span class="ask-tab-label">备注</span>
              </button>
            </div>

            <!-- 备注 tab：整块备注卡片 -->
            <div v-if="onNoteTab" class="ask-note-card">
              <textarea
                v-model="globalNote"
                class="ask-note-input"
                data-testid="ask-global-note"
                placeholder="备注…"
                rows="3"
              />
            </div>

            <!-- 题目 tab：多选提示 + 选项列表（带 preview 时左右分栏）+「自己答」选项 -->
            <template v-else-if="activeQuestion">
              <p v-if="activeQuestion.multiSelect" class="ask-multi-hint">可多选</p>
              <div class="ask-question-layout" :class="{ 'ask-split': previewMode }">
                <div class="ask-option-list" data-testid="ask-option-list">
                  <button
                    v-for="(option, oi) in activeQuestion.options"
                    :key="`opt-${oi}`"
                    type="button"
                    class="ask-option"
                    :class="{
                      selected: activeDraft.selected.includes(oi),
                      'is-multi': activeQuestion.multiSelect === true,
                    }"
                    :data-testid="`ask-option-${oi}`"
                    @click="selectOption(oi)"
                    @mouseenter="previewOptionIndex = oi"
                  >
                    <span class="ask-option-marker" aria-hidden="true" />
                    <span class="ask-option-label">
                      <span class="ask-option-name">{{ displayLabel(option.label) }}</span>
                      <span
                        v-if="isRecommendedOption(option)"
                        class="ask-recommended"
                        :title="RECOMMENDED_SUFFIX.slice(1, -1)"
                        data-testid="ask-recommended-tag"
                      >推荐</span>
                      <span class="ask-option-desc">{{ option.description }}</span>
                    </span>
                  </button>

                  <!-- 「自己答」＝选项列表末位的普通一行（同一套 radio / checkbox 形态），
                       选中才在下方整宽展开输入框。不再是常驻的大卡片。
                       多选时它与其它选项**并列**（可同时勾选），故这一行是同款 checkbox。 -->
                  <button
                    type="button"
                    class="ask-option ask-option-custom"
                    :class="{
                      selected: customRowSelected,
                      'is-multi': activeQuestion.multiSelect === true,
                    }"
                    data-testid="ask-option-custom"
                    @click="selectCustom"
                  >
                    <span class="ask-option-marker" aria-hidden="true" />
                    <span class="ask-option-label">
                      <span class="ask-option-name">✎ 自己答</span>
                      <span class="ask-option-desc">
                        {{ activeQuestion.multiSelect === true ? '可与其他选项同时选' : '输入自定义答案' }}
                      </span>
                    </span>
                  </button>
                </div>
                <div v-if="previewMode" class="ask-preview" data-testid="ask-preview">
                  <div class="ask-preview-caption">{{ previewOption ? displayLabel(previewOption.label) : '' }}</div>
                  <div
                    class="ask-preview-body"
                    v-html="renderMarkdown(previewOption?.preview ?? '')"
                  />
                </div>
              </div>

              <!-- 整宽展开（分栏时跨两列），照抄 rpiv guideline：不把它挤进窄选项列 -->
              <textarea
                v-if="activeCustomOpen"
                ref="customRef"
                class="ask-custom-input"
                data-testid="ask-custom-input"
                placeholder="输入自定义答案"
                :value="activeDraft.custom"
                @input="onCustomInput(($event.target as HTMLTextAreaElement).value)"
              />

              <!-- 单题场景没有备注 tab：备注卡片直接跟在选项下方 -->
              <div v-if="!isMultiQuestion" class="ask-note-card">
                <textarea
                  v-model="globalNote"
                  class="ask-note-input"
                  data-testid="ask-global-note"
                  placeholder="备注…"
                  rows="2"
                />
              </div>
            </template>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/*
 * 与 TodoPanel 同款「从输入框延伸出的浮窗」：同边框色 + 同顶部圆角 16px，
 * 下边沿无 border，底部 -10px 负 margin 塞进输入框背后（由输入框上边框充当视觉底边）。
 */
.ask-panel {
  position: relative;
  z-index: 0;
  border: 1px solid var(--input);
  border-bottom: 0;
  border-radius: 16px 16px 0 0;
  background: var(--background);
  margin: 0 0 -10px;
  padding: 8px 14px 14px;
  font-size: 13px;
  line-height: 1.55;
  transition: padding var(--transition-base);
}

.ask-panel-collapsed {
  padding: 6px 14px 12px;
}

/* 头部：折叠开关 + 操作条 + 状态徽标 同一行。
   标题 flex:1 会被长标题挤压 → 操作条与徽标 flex-shrink:0 优先保住。 */
.ask-heading {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 20px;
}
/* 交互态整行可点（沿用「点头部任意处折叠」）；已答态不可折叠 */
.ask-heading.is-toggle {
  cursor: pointer;
}
.ask-heading.is-toggle:focus-visible {
  outline: 2px solid var(--ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.ask-head-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  cursor: default;
}

.ask-heading-icon {
  width: 16px;
  height: 16px;
  border-radius: 4px;
  background: color-mix(in oklab, var(--brand-accent) 14%, transparent);
  color: var(--brand-accent);
  display: grid;
  place-items: center;
  font-size: 10px;
  font-weight: 700;
  flex-shrink: 0;
}

.ask-heading-text {
  flex: 1;
  min-width: 0;
  font-weight: 600;
  font-size: 13px;
  color: var(--foreground);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ask-meta {
  flex-shrink: 0;
  font-size: 10.5px;
  padding: 1px 7px;
  border-radius: 999px;
  font-weight: 500;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ask-meta.live {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  background: color-mix(in oklab, var(--warning) 18%, transparent);
  color: color-mix(in oklab, var(--warning) 70%, var(--foreground));
}
.ask-meta.live::before {
  content: '';
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
  animation: ask-pulse 1.4s infinite;
}
.ask-meta.done {
  background: color-mix(in oklab, var(--success) 18%, transparent);
  color: color-mix(in oklab, var(--success) 65%, var(--foreground));
}
@keyframes ask-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

.ask-chevron {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.7;
}

/* 折叠动画：高度 + 透明度（与 TodoPanel 同节奏） */
.ask-body {
  display: grid;
  grid-template-rows: 1fr;
  transition: grid-template-rows 200ms ease, opacity 180ms ease;
}
.ask-panel-collapsed .ask-body {
  grid-template-rows: 0fr;
  opacity: 0;
}
.ask-body-inner {
  min-height: 0;
  overflow: hidden;
}
.ask-body-content {
  padding: 8px 0 0;
}

/* 整块面板出现/消失（已答后淡出下沉，不占位） */
.ask-panel-hide-enter-active,
.ask-panel-hide-leave-active {
  transition: opacity 240ms ease, transform 240ms ease, max-height 240ms ease;
  overflow: hidden;
  max-height: 420px;
}
.ask-panel-hide-enter-from,
.ask-panel-hide-leave-to {
  max-height: 0 !important;
  opacity: 0;
  transform: translateY(10px);
  margin-bottom: 0 !important;
  padding-top: 0 !important;
  padding-bottom: 0 !important;
}

/* ===== tab ===== */
.ask-tabs {
  display: flex;
  gap: 0;
  margin: 0 -14px;
  padding: 0 12px;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: none;
}
.ask-tabs::-webkit-scrollbar {
  display: none;
}
.ask-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 0;
  background: transparent;
  color: var(--muted-foreground);
  padding: 8px 10px;
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  position: relative;
  white-space: nowrap;
}
.ask-tab:hover {
  color: var(--foreground);
}
.ask-tab.active {
  color: var(--foreground);
}
.ask-tab.active::after {
  content: '';
  position: absolute;
  left: 6px;
  right: 6px;
  bottom: -1px;
  height: 2px;
  border-radius: 1px;
  background: var(--brand-accent);
}
.ask-tab-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--muted-foreground);
  flex-shrink: 0;
}
.ask-tab.done .ask-tab-dot {
  background: var(--success);
}
.ask-tab.active .ask-tab-dot {
  background: var(--brand-accent);
}
.ask-tab-label {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ask-multi-hint {
  margin: 8px 0 4px;
  font-size: 10.5px;
  color: var(--muted-foreground);
}

/* ===== 选项 / 预览 ===== */
.ask-question-layout {
  display: block;
}
.ask-question-layout.ask-split {
  display: grid;
  /*
   * 选项列 : 预览列 = 1.4 : 1（预览刻意窄于选项）。
   * 分栏态下选项描述已被隐藏（见 `.ask-split .ask-option-desc`），左列只剩名称，
   * 不需要一半宽度；预览是 markdown 正文，窄一档也更贴近「图例」的定位。
   * 想调比例只改这一行。
   */
  grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr);
  gap: 10px;
  align-items: start;
  margin-top: 8px;
}

.ask-option-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 8px 0;
  min-width: 0;
}
.ask-split .ask-option-list {
  margin: 0;
}

.ask-option {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 8px 10px;
  border: 0;
  border-radius: var(--radius-md);
  background: transparent;
  cursor: pointer;
  text-align: left;
  font: inherit;
  color: inherit;
  transition: background var(--transition-fast);
  min-width: 0;
}
.ask-option:hover {
  background: color-mix(in oklab, var(--brand-accent) 8%, transparent);
}
.ask-option.selected {
  background: color-mix(in oklab, var(--brand-accent) 14%, transparent);
}

.ask-option-marker {
  width: 8px;
  height: 8px;
  margin-top: 5px;
  border-radius: 50%;
  border: 1.5px solid var(--muted-foreground);
  flex-shrink: 0;
  transition: all var(--transition-fast);
}
.ask-option.is-multi .ask-option-marker {
  border-radius: 2px;
}
.ask-option.selected .ask-option-marker {
  border-color: var(--brand-accent);
  background: var(--brand-accent);
}

.ask-option-label {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 500;
  line-height: 1.4;
}
.ask-option-name {
  flex-shrink: 0;
}
.ask-recommended {
  flex-shrink: 0;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 3px;
  font-weight: 600;
  background: color-mix(in oklab, var(--brand-accent) 18%, transparent);
  color: var(--brand-accent);
}
.ask-option-desc {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11.5px;
  font-weight: 400;
  color: var(--muted-foreground);
}
.ask-split .ask-option-desc {
  display: none;
}

.ask-preview {
  min-width: 0;
  /*
   * 固定高度 + 内部滚动（**不要**改回 height:auto / max-height）。
   * preview 是 markdown，各选项长短差很大；高度若随内容浮动，hover 到不同选项时
   * 整个分栏区、进而面板底部与下方输入框都会上下跳（用户反馈「会动会变形」）。
   */
  height: 240px;
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-md);
  background: color-mix(in oklab, var(--muted) 30%, var(--card));
  overflow: hidden;
}
.ask-preview-caption {
  flex-shrink: 0;
  padding: 6px 10px;
  font-size: 11px;
  font-weight: 600;
  color: var(--muted-foreground);
  border-bottom: 1px solid var(--border);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ask-preview-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 8px 10px;
  font-family: var(--font-mono);
  font-size: 11.5px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.ask-preview-body :deep(pre) {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.ask-preview-body :deep(code) {
  font-family: inherit;
}
.ask-preview-body :deep(p) {
  margin: 0 0 6px;
}

/*
 * 列表（预览里的 `- 优点：…` 这类）。
 *
 * ⚠️ 必须显式补 `padding-left`。`global.css` 有 `* { margin:0; padding:0 }` 通用重置，
 * 作者样式压过浏览器对 `ul/ol` 默认的 `padding-inline-start: 40px`，于是 `padding-left`
 * 变 0，而 `list-style-position` 仍是默认的 `outside` —— 黑点被推到内容盒**外**，
 * 只有 10px 内边距托不住，就露在圆角框外面了（用户反馈「黑点在框外」）。
 * 这里保留 `outside` + 悬挂缩进（换行文字与首行对齐），只把内边距还给列表。
 * `MessageCard.vue` 的 markdown 区是靠 `inside` 绕开同一个坑，两种都可行。
 *
 * `white-space: pre-wrap`（容器上那句，给纯文本预览用）会连标记之间的换行空白节点
 * 一起渲染成换行 —— marked 输出的 `<ul>\n<li>…</li>\n<li>…</li>\n</ul>` 于是每两个
 * 列表项之间多出一整行空隙。容器恢复 normal，`li` 内部仍保留 pre-wrap。
 */
.ask-preview-body :deep(ul),
.ask-preview-body :deep(ol) {
  margin: 0 0 6px;
  padding-left: 1.3em;
  list-style-position: outside;
  white-space: normal;
}
/* 末块不拖底部空隙（与 `.msg-content :last-child` 同思路） */
.ask-preview-body :deep(ul:last-child),
.ask-preview-body :deep(ol:last-child) {
  margin-bottom: 0;
}
/* 嵌套列表只靠自身 1.3em 缩进，不再叠加父级外边距 */
.ask-preview-body :deep(ul ul),
.ask-preview-body :deep(ul ol),
.ask-preview-body :deep(ol ul),
.ask-preview-body :deep(ol ol) {
  margin: 0;
}
.ask-preview-body :deep(li) {
  margin: 0;
  white-space: pre-wrap;
}
/* marked 的宽松列表会包一层 `<p>`，别再撑出块间距 */
.ask-preview-body :deep(li > p) {
  margin: 0;
}

/* ===== 「自己答」选项 + 展开的输入框 =====
   「自己答」不再是常驻大卡片，而是选项列表末位的一行（复用 .ask-option 全部形态），
   选中后在分栏区**下方整宽**展开输入框。 */
.ask-option-custom .ask-option-desc {
  color: var(--muted-foreground);
  opacity: 0.85;
}
.ask-custom-input {
  display: block;
  width: 100%;
  margin: 6px 0 2px;
  padding: 6px 8px;
  border: 1px solid var(--input);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  resize: vertical;
  min-height: 48px;
  outline: none;
}
.ask-custom-input:focus {
  border-color: var(--brand);
}

/* ===== 备注卡片 ===== */
.ask-note-card {
  margin: 6px 0 4px;
}
.ask-note-input {
  width: 100%;
  padding: 6px 8px;
  border: 1px solid var(--input);
  border-radius: var(--radius-sm);
  background: var(--background);
  color: var(--foreground);
  font-family: inherit;
  font-size: 12.5px;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}
.ask-note-input:focus {
  border-color: var(--brand);
}

/* ===== 头部操作条（进度 + 导航 + 取消 / 提交） ===== */
.ask-progress {
  font-size: 10.5px;
  color: var(--muted-foreground);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding-right: 2px;
}
.ask-btn {
  padding: 5px 14px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--background);
  color: var(--foreground);
  font: inherit;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all var(--transition-fast);
}
.ask-btn:hover {
  border-color: var(--brand);
}
.ask-btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--brand-foreground);
}
/* 头部操作条里的小号按钮：压在标题行内，必须比正文按钮收敛一号。
   「上一题 / 下一题」（.ask-btn-nav）再弱一档（透明底 + 次级文字色），
   「取消 / 提交答案」保留可见边框与主色，形成 导航 < 取消 < 提交 的视觉层级。 */
.ask-btn-mini {
  padding: 2px 9px;
  font-size: 11.5px;
  white-space: nowrap;
}
.ask-btn-nav {
  border-color: transparent;
  background: transparent;
  color: var(--muted-foreground);
}
.ask-btn-nav:hover {
  border-color: transparent;
  background: var(--muted);
  color: var(--foreground);
}

/* ===== 已答折叠摘要 ===== */
.ask-answered {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  padding: 6px 0 0;
  font-size: 11.5px;
  color: var(--muted-foreground);
}
.ask-pill {
  padding: 1px 7px;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 500;
  background: color-mix(in oklab, var(--success) 14%, transparent);
  color: color-mix(in oklab, var(--success) 65%, var(--foreground));
}
.ask-answered-text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ask-answered-note {
  flex-basis: 100%;
}

@media (prefers-reduced-motion: reduce) {
  .ask-panel,
  .ask-body,
  .ask-panel-hide-enter-active,
  .ask-panel-hide-leave-active {
    transition: none;
  }
  .ask-meta.live::before {
    animation: none;
  }
}
</style>
