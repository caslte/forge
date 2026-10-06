<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { ProjectPickerDescriptor } from '../types';
import InstructionInput from './InstructionInput.vue';

// v3.85.2：字标与 splash/BootWelcome/conv-hero 同一 URL、同一档尺寸（320px）
const logoWordmarkDark = import.meta.env.BASE_URL + 'logo-wordmark-on-dark.svg';
const logoWordmarkLight = import.meta.env.BASE_URL + 'logo-wordmark-on-light.svg';

/**
 * 落地 hero（v3.77 + v0.3）：零项目时的启动首屏。
 *
 * 与会话内空态 hero（ConversationView conv-hero）同一视觉语言：forge 字标 +
 * 居中输入框。此时没有任何项目可归属，输入框项目区由上层传入
 * `{ mode:'draft', currentPath:null, currentName:'自由对话', items:[], freeOption:true }`，
 * 菜单提供「自由对话」与「打开项目…」入口。
 *
 * 发送即创建自由会话（v0.3）：文本先 restoreQueuedText 落草稿仓库，再 emit
 * 'start-free-chat' —— 上层切自由草稿态重挂 ConversationView（同一草稿 key 回填）
 * 并携带 autoSendText 直发，用户无感衔接。
 *
 * 草稿直通：输入框是 InstructionInput（sessionId 恒空 → 草稿态统一 key）；
 * 打开项目、本组件卸载后，项目视图的草稿输入框挂载即从同一 key 回填。
 */
const props = defineProps<{
  models: string[];
  currentModel: string | null;
  /** 零项目时上层传入 currentPath:null + freeOption 的 draft 描述 */
  projectPicker?: ProjectPickerDescriptor;
}>();

const emit = defineEmits<{
  (e: 'model-change', model: string): void;
  (e: 'pick-project', path: string | null): void;
  (e: 'open-project-picker'): void;
  (e: 'remove-project', path: string): void;
  /** 发送即创建自由会话（v0.3）：携带输入文本，上层切自由草稿态并直发 */
  (e: 'start-free-chat', text: string): void;
}>();

const inputRef = ref<InstanceType<typeof InstructionInput> | null>(null);

function onSend(text: string): void {
  if (props.projectPicker?.currentPath) return; // 落地态恒无项目；有值说明上层误用，丢弃
  // 文本落草稿仓库：切到自由草稿态后 ConversationView 同 key 回填（autoSendText 直发）；
  // 用户若在直发前手动改走「打开项目」，文本同样在项目视图草稿输入框里
  inputRef.value?.restoreQueuedText([text]);
  emit('start-free-chat', text);
}

function onModelChange(model: string): void {
  emit('model-change', model);
}

function onPickProject(path: string | null): void {
  emit('pick-project', path);
}

function onRemoveProject(path: string): void {
  emit('remove-project', path);
}

onMounted(() => {
  inputRef.value?.focus();
});
</script>

<template>
  <div class="landing-hero">
    <img class="landing-wordmark wm-dark" :src="logoWordmarkDark" alt="FORGE" width="320" height="42" aria-hidden="true" draggable="false" />
    <img class="landing-wordmark wm-light" :src="logoWordmarkLight" alt="FORGE" width="320" height="42" aria-hidden="true" draggable="false" />
    <div class="landing-input">
      <InstructionInput
        ref="inputRef"
        session-status="idle"
        :models="models"
        :current-model="currentModel"
        :project-picker="projectPicker"
        @send="onSend"
        @model-change="onModelChange"
        @pick-project="onPickProject"
        @open-project-picker="emit('open-project-picker')"
        @remove-project="onRemoveProject"
      />
    </div>
  </div>
</template>

<style scoped>
/* 布局与会话内空态 hero 同构（ConversationView .conv-input-wrap / hero-mode）：
   字标 26cqw 跟随可视宽度，这里建立查询容器 */
.landing-hero {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  container-type: inline-size;
}

/* FORGE 字标主视觉（与会话内 conv-hero-wordmark 同参数），纯黑白不变灰 */
.landing-wordmark {
  display: none;
  width: min(40cqw, 320px);
  height: auto;
  margin-bottom: 16px;
  pointer-events: none;
  user-select: none;
}

:root:not([data-theme='light']) .landing-wordmark.wm-dark,
:root[data-theme='light'] .landing-wordmark.wm-light {
  display: block;
}

/* 浅色主题下纯黑字标对比过强，降透明度柔化 */
:root[data-theme='light'] .landing-wordmark.wm-light {
  opacity: 0.8;
}

/* 同 hero-mode 的输入框宽度：min(640px, 容器宽) */
.landing-input {
  width: min(640px, 100%);
}
</style>
