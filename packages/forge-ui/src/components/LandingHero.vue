<script setup lang="ts">
import { ref, onMounted } from 'vue';
import type { ProjectPickerDescriptor } from '../types';
import InstructionInput from './InstructionInput.vue';
import logoMain from '../assets/logo-main.png';

/**
 * 落地 hero（v3.77）：零项目时的启动首屏，替换旧「选择项目」卡片。
 *
 * 与会话内空态 hero（ConversationView conv-hero）同一视觉语言：forge 字标 +
 * 居中输入框。此时没有任何项目可归属，输入框项目区由上层传入
 * `{ mode:'draft', currentPath:null, currentName:'打开项目', items:[] }`，
 * 菜单里只有「打开项目…」入口。
 *
 * 草稿直通：输入框是 InstructionInput（sessionId 恒空 → 草稿态统一 key），
 * 文本实时落在模块级草稿仓库（utils/composerDrafts）里；发送后回填的文本
 * 同样在仓。项目打开、本组件卸载后，项目视图的草稿输入框挂载即从同一 key
 * 回填，用户无感衔接——不再需要 carry-text 事件接力。
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
}>();

const inputRef = ref<InstanceType<typeof InstructionInput> | null>(null);

function onSend(text: string): void {
  if (props.projectPicker?.currentPath) return; // 落地态恒无项目；有值说明上层误用，丢弃
  // 视觉回填：目录选择取消时不丢字；选中则组件随即卸载，文本经草稿仓库直通
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

onMounted(() => {
  inputRef.value?.focus();
});
</script>

<template>
  <div class="landing-hero">
    <img class="landing-logo" :src="logoMain" alt="" aria-hidden="true" draggable="false" />
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

/* 巨型主视觉 LOGO（与 ConversationView .conv-hero-logo 同参数）；
   老浏览器兜底固定 180px */
.landing-logo {
  display: block;
  width: 180px;
  width: min(28cqw, 220px);
  height: auto;
  pointer-events: none;
  user-select: none;
}

/* 同 hero-mode 的输入框宽度：min(640px, 容器宽) */
.landing-input {
  width: min(640px, 100%);
}
</style>
