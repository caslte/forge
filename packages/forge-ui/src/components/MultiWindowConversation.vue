<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { call, subscribe } from '../bridge';
import type { ProjectItem, ProjectPickerDescriptor, SessionItem, ModelOption } from '../types';
import ConversationView from './ConversationView.vue';
import { useI18n } from '../i18n/index.ts';

/**
 * 多窗口画布内单个窗口的会话宿主（think-1788488643459 合并重构）。
 *
 * 会话视图直接复用单视图 ConversationView——时间线/历史浮窗/回看/欢迎页/
 * 模型切换横幅/子 Agent/停止确认全部单实现，单视图消息流修复自动覆盖多窗口
 * （此前双壳层曾连续发生 footer 重复、读秒、工具条压缩三类单边事故）。
 *
 * 本组件只剩多窗口专属的两件事：
 * 1. 每窗口独立的会话模型状态（model/getSessionModel · model/setSessionModel）
 * 2. 由 session.projectPath 合成 ConversationView 所需 ProjectItem（其内部只消费 path）
 */
const props = defineProps<{
  sessionId: string;
  /** 所属会话（状态提示源 + projectPath 来源；会话删除时画布会同步摘窗，可为 null 防御） */
  session: SessionItem | null;
  /** 模型可选项（透传给窗口内对话输入，与单视图一致） */
  modelOptions: ModelOption[];
}>();

const { t } = useI18n();

const currentProviderId = ref<string | null>(null);

/**
 * 归属项目：自由会话（projectPath=null）传 null —— ConversationView 内部
 * 分支徽标/@ 补全/git 入口全部以 project 可空降级（v0.3 自由对话）。
 */
const project = computed<ProjectItem | null>(() => {
  const p = props.session?.projectPath;
  if (!p) return null;
  return { path: p, alias: null, lastOpenedAt: '', trust: 'trusted' };
});

/**
 * 输入框下方状态行的项目徽标（session 只读态）；显示名=路径末段。
 * 自由会话显示只读「自由对话」标签（归属变更走侧栏，不做窗口内绑定入口）。
 */
const projectPicker = computed<ProjectPickerDescriptor | undefined>(() => {
  const p = props.session?.projectPath;
  if (!p) {
    return { mode: 'session', currentPath: null, currentName: t('panels.multiwin.freeTag'), items: [], freeOption: false };
  }
  const segs = p.replace(/\\/g, '/').split('/');
  return { mode: 'session', currentPath: p, currentName: segs[segs.length - 1] || p, items: [], freeOption: false };
});

async function loadModel(): Promise<void> {
  try {
    const res = await call<{ model: string | null; providerId: string | null }>(
      'model/getSessionModel',
      { sessionId: props.sessionId },
    );
    currentProviderId.value = res.providerId;
  } catch {
    currentProviderId.value = null;
  }
}

async function onModelChange(providerId: string): Promise<void> {
  try {
    await call('model/setSessionModel', { sessionId: props.sessionId, providerId });
    currentProviderId.value = providerId;
  } catch {
    // 持久化失败静默：ref 不更新，输入框保持回显真实值；切换横幅由 ConversationView 自管
  }
}

/** model.providersChanged 退订句柄（设置里改配置后本窗口要重解析生效模型） */
let unsubProvidersChanged: (() => void) | null = null;

onMounted(() => {
  void loadModel();
  // 设置里改某个配置的模型 ID 后，本窗口的展示与生效模型都跟着重解析（锚点不变）
  unsubProvidersChanged = subscribe('model.providersChanged', () => void loadModel());
});

onUnmounted(() => {
  unsubProvidersChanged?.();
  unsubProvidersChanged = null;
});
</script>

<template>
  <ConversationView
    :session-id="sessionId"
    :project="project"
    :session="session"
    :model-options="modelOptions"
    :current-provider-id="currentProviderId"
    :project-picker="projectPicker"
    @model-change="onModelChange"
  />
</template>
