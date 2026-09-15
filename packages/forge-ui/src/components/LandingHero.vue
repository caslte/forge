<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue';
import type { ProjectPickerDescriptor } from '../types';
import InstructionInput from './InstructionInput.vue';

/**
 * 落地 hero（v3.77）：零项目时的启动首屏，替换旧「选择项目」卡片。
 *
 * 与会话内空态 hero（ConversationView conv-hero）同一视觉语言：forge 字标 +
 * 居中输入框。此时没有任何项目可归属，输入框项目区由上层传入
 * `{ mode:'draft', currentPath:null, currentName:'打开项目', items:[] }`，
 * 菜单里只有「打开项目…」入口。
 *
 * 草稿直通：发送（或选中项目）→ 上层弹目录选择器 → 项目打开后本组件卸载，
 * 卸载时把未发送文本经 carry-text 上抛；App 在分支切换后的 post-flush 把它
 * 回填进项目视图的草稿输入框（经 ConversationView.restoreDraft），用户无感衔接。
 */
const props = defineProps<{
  models: string[];
  currentModel: string | null;
  /** 零项目时上层固定传 currentPath:null 的 draft 描述（驱动「打开项目…」菜单） */
  projectPicker?: ProjectPickerDescriptor;
}>();

const emit = defineEmits<{
  (e: 'model-change', model: string): void;
  (e: 'pick-project', path: string): void;
  (e: 'open-project-picker'): void;
  (e: 'remove-project', path: string): void;
  /** 卸载时上抛未发送的输入文本（App 暂存，项目打开后回填草稿输入框） */
  (e: 'carry-text', text: string): void;
}>();

const inputRef = ref<InstanceType<typeof InstructionInput> | null>(null);
/** 发送路径的文本暂存：onSend 会先清空输入框再 emit，目录选择取消时文本已回填 */
let sentCarry = '';

function onSend(text: string): void {
  if (props.projectPicker?.currentPath) return; // 落地态恒无项目；有值说明上层误用，丢弃
  sentCarry = text;
  // 视觉回填：目录选择取消时不丢字；选中则组件随即卸载，回填无副作用
  inputRef.value?.restoreQueuedText([text]);
  emit('open-project-picker');
}

function onModelChange(model: string): void {
  emit('model-change', model);
}

function onPickProject(path: string): void {
  emit('pick-project', path);
}

function onRemoveProject(path: string): void {
  emit('remove-project', path);
}

onBeforeUnmount(() => {
  const current = inputRef.value?.getText() ?? '';
  const carry = current.trim() !== '' ? current : sentCarry;
  if (carry.trim() !== '') emit('carry-text', carry);
});

onMounted(() => {
  inputRef.value?.focus();
});
</script>

<template>
  <div class="landing-hero">
    <span class="landing-wordmark" aria-hidden="true">forge</span>
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

/* 巨型 forge 字标：参数照抄 .conv-wordmark（实底 + 下缘蒙版渐隐，融进背板） */
.landing-wordmark {
  font-family: var(--font-mono);
  font-weight: 600;
  letter-spacing: -0.05em;
  line-height: 1;
  color: var(--foreground);
  opacity: 0.14;
  font-size: 96px;
  font-size: min(26cqw, 180px);
  -webkit-mask-image: linear-gradient(180deg, #000 25%, transparent 100%);
  mask-image: linear-gradient(180deg, #000 25%, transparent 100%);
  pointer-events: none;
  user-select: none;
}

/* 同 hero-mode 的输入框宽度：min(640px, 容器宽) */
.landing-input {
  width: min(640px, 100%);
}
</style>
