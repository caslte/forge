<!--
  pi-goal 宿主交互弹窗（goal 接入，2026-10-10）。

  为什么必须有这个组件：**它是修复「静默拒绝」的唯一出口。**
  pi-goal 替换一个未完成目标时会 `await ctx.ui.confirm("Replace goal?", …)`
  （pi-goal commands.ts:59）。接入前 forge 不给扩展 `uiContext`，pi 回落
  `noOpUIContext`，其 `confirm` 是 `async () => false` —— 恒定返回「否」，
  于是目标**永远换不掉**，而用户既看不到失败、也看不到原因。
  同一个空实现还吞掉了 `notify` 与 `setStatus`，导致「目标已启动 / 预算耗尽 /
  进度到第几轮」全部静默。本组件承载 confirm/input/editor/select 四类交互，
  GoalBadge 承载状态行，二者合起来才把 pi-goal 的用户可见面补齐。

  四类交互的映射（pi-goal 的调用点见 menu.ts / settings-ui.ts）：
  - confirm：替换目标 / 提高预算 / 清除目标前的确认 → 两个按钮
  - input：自定义 token 数额 → 单行输入
  - editor：设置 / 替换目标全文 → 多行输入（pi-goal 用 editor 只是为了取长文本，
    SDK 的 editor 本是终端编辑器组件，在 GUI 下按多行 input 处理）
  - select：候选选择 → 列表单选

  超时：倒计时取载荷的 `timeoutMs`，**不硬编码**；归零主动回填
  `cancelled: true` 并撤掉面板 —— 与 ask_user_question 同一纪律，避免扩展侧
  只能看到空快照。宿主侧还有一层宽限兜底（GOAL_UI_REPLY_GRACE_MS），
  两侧独立收敛，幂等。

  形态：与 AskUserQuestionPanel / TodoPanel 一致（compose-box 同材质、
  顶部圆角、底部 -10px 负 margin 塞进输入框背后），避免另起一套视觉语言。
-->
<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import type { GoalUiRequestedPayload } from '../bridge';

/** 载荷自带 sessionId：多窗格各窗格按它认领，只在发起会话的窗格弹窗。 */
const props = defineProps<{
  /** 当前请求；null 表示不渲染（组件整体卸载） */
  request: GoalUiRequestedPayload | null;
  /** 剩余秒数（由父级倒计时驱动，组件不自己起定时器） */
  remainingSec: number;
}>();

const emit = defineEmits<{
  /** 回填裁决：value=null+cancelled=true 等价「取消」 */
  (e: 'reply', payload: { value: string | boolean | null; cancelled: boolean }): void;
}>();

const text = ref('');
const inputRef = ref<HTMLInputElement | HTMLTextAreaElement | null>(null);

const isTextKind = computed(() => {
  const kind = props.request?.kind;
  return kind === 'input' || kind === 'editor';
});

const isConfirm = computed(() => props.request?.kind === 'confirm');
const isSelect = computed(() => props.request?.kind === 'select');

/** confirm 的正文是「当前目标 / 新目标」对照文本，可能很长：限高滚动，不撑破面板 */
const bodyText = computed(() => props.request?.message ?? '');

const dialogTitle = computed(() => {
  if (!props.request) return '';
  // pi-goal 给的是英文标题（"Replace goal?" 等），此处只做首字母大写与去问号冗余，
  // 不做翻译：翻译表会把「Replace goal?」这类动态语义硬编码成易过期的字符串。
  return props.request.title;
});

/** 目标全文（editor 场景）建议给多行；input 场景单行更合适 */
const isMultiline = computed(() => props.request?.kind === 'editor');

const canSubmitText = computed(() => text.value.trim() !== '');

watch(
  () => props.request?.requestId,
  () => {
    text.value = '';
    // 打开即聚焦：confirm 先聚焦「确定」，文本类聚焦输入框
    void nextTick(() => inputRef.value?.focus());
  },
);

/** 倒计时文案（<60s 才显示，避免「10 分钟」这种长挂在标题上） */
const countdown = computed(() => (props.remainingSec > 0 && props.remainingSec <= 60 ? `${props.remainingSec}s` : ''));

function reply(value: string | boolean | null, cancelled: boolean): void {
  emit('reply', { value, cancelled });
}

function onConfirm(): void {
  reply(true, false);
}
function onCancel(): void {
  reply(false, true);
}
function onSubmitText(): void {
  if (!canSubmitText.value) return;
  reply(text.value, false);
}
function onSelectOption(option: string): void {
  reply(option, false);
}

/** 键盘：confirm 显式接 Esc=取消 / Enter=确定（原生 dialog 无 role=dialog 语义时兜底） */
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    onCancel();
  }
}
onBeforeUnmount(() => {
  // 卸载不自动回填：由父级（持 request 状态）在超时路径上决定，
  // 组件卸载可能只是会话切换，避免在这里产生一次意外的 cancel。
});
</script>

<template>
  <div v-if="request" class="goal-dialog" role="dialog" aria-modal="false" :aria-label="dialogTitle" @keydown="onKeydown">
    <div class="head">
      <span class="title">{{ dialogTitle }}</span>
      <span v-if="countdown" class="countdown">{{ countdown }}</span>
    </div>

    <!-- 正文：confirm 的对照文本 / input·editor 的提示 / select 的说明 -->
    <p v-if="bodyText" class="body">{{ bodyText }}</p>

    <!-- confirm：两个按钮 -->
    <div v-if="isConfirm" class="actions">
      <button class="btn" @click="onCancel">取消</button>
      <button ref="inputRef" class="btn primary" @click="onConfirm">确定</button>
    </div>

    <!-- select：候选项单选 -->
    <ul v-else-if="isSelect" class="options">
      <li v-for="opt in request.options ?? []" :key="opt">
        <button class="option" @click="onSelectOption(opt)">{{ opt }}</button>
      </li>
      <li v-if="(request.options ?? []).length === 0" class="empty">无可选项</li>
    </ul>

    <!-- input / editor：文本输入 -->
    <div v-else-if="isTextKind" class="text-block">
      <textarea
        v-if="isMultiline"
        ref="inputRef"
        v-model="text"
        class="input multiline"
        :placeholder="request.placeholder ?? ''"
        rows="4"
      ></textarea>
      <input
        v-else
        ref="inputRef"
        v-model="text"
        class="input"
        :placeholder="request.placeholder ?? ''"
        @keydown.enter.prevent="onSubmitText"
      />
      <div class="actions">
        <button class="btn" @click="onCancel">取消</button>
        <button class="btn primary" :disabled="!canSubmitText" @click="onSubmitText">确定</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.goal-dialog {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: -10px;
  padding: 12px 14px;
  border-radius: 12px 12px 0 0;
  background: var(--bg-secondary, #f7f7f5);
  border: 1px solid var(--border-tertiary, rgba(0, 0, 0, 0.15));
  border-bottom: none;
  box-shadow: 0 -2px 8px rgba(0, 0, 0, 0.04);
}

.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary, #2c2c2a);
}

.countdown {
  font-size: 12px;
  color: var(--text-tertiary, #888780);
  font-variant-numeric: tabular-nums;
}

/* 正文限高滚动：confirm 的「当前/新目标」对照可能很长，不能撑破输入框 */
.body {
  margin: 0;
  font-size: 12px;
  line-height: 1.6;
  color: var(--text-secondary, #5f5e5a);
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 120px;
  overflow-y: auto;
}

.actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.btn {
  height: 26px;
  padding: 0 12px;
  border-radius: 6px;
  font-size: 12px;
  border: 1px solid var(--border-tertiary, rgba(0, 0, 0, 0.15));
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #2c2c2a);
  cursor: pointer;
}
.btn:hover:not(:disabled) { border-color: var(--border-secondary, rgba(0, 0, 0, 0.3)); }
.btn.primary {
  background: var(--accent, #534ab7);
  border-color: var(--accent, #534ab7);
  color: #fff;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }

.options {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 160px;
  overflow-y: auto;
}
.option {
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  font-size: 12px;
  border-radius: 6px;
  border: 1px solid var(--border-tertiary, rgba(0, 0, 0, 0.15));
  background: var(--bg-primary, #fff);
  color: var(--text-primary, #2c2c2a);
  cursor: pointer;
}
.option:hover { border-color: var(--accent, #534ab7); }

.empty {
  font-size: 12px;
  color: var(--text-tertiary, #888780);
  padding: 6px 2px;
}

.text-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.input {
  width: 100%;
  box-sizing: border-box;
  padding: 7px 9px;
  font-size: 12px;
  font-family: inherit;
  color: var(--text-primary, #2c2c2a);
  background: var(--bg-primary, #fff);
  border: 1px solid var(--border-tertiary, rgba(0, 0, 0, 0.15));
  border-radius: 6px;
  outline: none;
}
.input:focus { border-color: var(--accent, #534ab7); }
.multiline { resize: vertical; min-height: 72px; line-height: 1.6; }
</style>
