<script setup lang="ts">
/**
 * 消息流列表项渲染（单条消息 / 聚合工具组）。
 *
 * 结构动机（修复 Vue patch 崩溃）：
 * 旧实现把「单条消息 ↔ 工具组」的形态分支放在父级 v-for 的嵌套
 * template v-if/v-else 中，同一列表位置在流式期间（工具消息到达/聚组边界
 * 变化）会在 message vnode 与 group fragment vnode 间切换，且 key 依赖可变
 * 索引（idx/startIndex），触发 patch 错位（vnode.type=null → emitsOptions 空指针）。
 * 改为：父级只渲染一个组件列表（稳定唯一 key），形态分支隔离在本组件实例内，
 * 同一 key 的组件始终唯一，patch 不再跨列表位置错位。
 */
import { computed } from 'vue';
import type { ConversationMessage, SessionStatus, ToolEvent } from '../types';
import type { ChangedFileSummary } from '../composables/useChangedFiles';
import MessageCard from './MessageCard.vue';
import DiffView from './DiffView.vue';
import ToolCallCard from './ToolCallCard.vue';
import ChangedFilesCard from './ChangedFilesCard.vue';

/** 工具调用 diff（Edit 类工具入参渲染用） */
export type ToolDiff = {
  id: string;
  filePath: string | null;
  oldString: string | null;
  newString: string | null;
};

/** 展示项：单条消息 或 连续 ≥2 的工具组 */
export type DisplayItem =
  | {
      /** 稳定唯一 key（不随列表位置变化） */
      key: string;
      kind: 'message';
      msg: ConversationMessage;
      idx: number;
      /** assistant 分片 footer 轮次控制（仅 assistant 消息需要） */
      showFooter?: boolean;
      copyText?: string;
    }
  | {
      key: string;
      kind: 'tool-group';
      tools: ConversationMessage[];
      toolCounts: Array<{ name: string; count: number }>;
      totalCount: number;
      diffs: ToolDiff[];
      collapsed: boolean;
    }
  | {
      key: string;
      kind: 'files-summary';
      summary: ChangedFileSummary;
    };

const props = defineProps<{
  item: DisplayItem;
  /** 是否流式渲染（仅消息项有效；用于 MessageCard streaming 样式与思考占位） */
  streaming: boolean;
  /** 工具事件归属会话（ToolCallCard event.sessionId） */
  sessionId: string;
  /** 会话项目根路径（改动文件汇总卡片的相对路径归一；空串按原路径展示） */
  projectPath?: string;
  /** 是否展示 diff（个性化偏好；关闭后工具 diff 与改动汇总卡片均不渲染） */
  showDiff?: boolean;
}>();

const showDiffEff = computed(() => props.showDiff !== false);

const emit = defineEmits<{
  (e: 'toggle-group', key: string): void;
}>();

/** 把 ConversationMessage（role=tool）转成 ToolCallCard 需要的 ToolEvent */
function toToolEvent(m: ConversationMessage): ToolEvent {
  return {
    toolEventId: m.toolEventId ?? '',
    sessionId: props.sessionId,
    status: (m.status ?? 'started') as ToolEvent['status'],
    toolName: m.toolName,
    summary: m.content || undefined,
    input: m.input,
  };
}

function isToolMessage(m: ConversationMessage): boolean {
  return m.role === 'tool';
}
</script>

<template>
  <template v-if="item.kind === 'message'">
    <ToolCallCard v-if="isToolMessage(item.msg)" :event="toToolEvent(item.msg)" :hide-diff="!showDiffEff" />
    <MessageCard
      v-else
      :message="item.msg"
      :streaming="streaming"
      :show-footer="item.showFooter"
      :copy-text="item.copyText"
    />
  </template>

  <template v-else-if="item.kind === 'files-summary'">
    <ChangedFilesCard
      v-if="showDiffEff"
      :summary="item.summary"
      :project-path="projectPath"
    />
  </template>

  <div v-else class="tool-group" :class="{ collapsed: item.collapsed }">
    <button class="tool-group-head" @click="emit('toggle-group', item.key)">
      <svg class="tg-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" /><path d="M5 21l1.5-4.5" /></svg>
      <span class="tg-label">工具调用</span>
      <span class="tg-count">{{ item.totalCount }} 次</span>
      <span class="tg-names">
        <span v-for="tc in item.toolCounts" :key="tc.name" class="tg-chip"><span class="tg-chip-name">{{ tc.name }}</span><span v-if="tc.count > 1" class="tg-chip-count">×{{ tc.count }}</span></span>
      </span>
      <span class="tg-collapse">{{ item.collapsed ? '▸' : '▾' }}</span>
    </button>
    <div class="tool-group-body-shell" :class="{ 'is-collapsed': item.collapsed }">
      <div class="tool-group-body">
        <ToolCallCard v-for="tm in item.tools" :key="tm.toolEventId ?? tm.ts" :event="toToolEvent(tm)" hide-diff />
      </div>
    </div>
    <div v-if="showDiffEff && item.diffs.length > 0" class="tool-group-diffs">
      <DiffView
        v-for="diff in item.diffs"
        :key="diff.id"
        class="tool-group-diff"
        :file-path="diff.filePath"
        :old-string="diff.oldString"
        :new-string="diff.newString"
      />
    </div>
  </div>
</template>

<style scoped>
/* 工具组折叠（连续 ≥2 的 tool 聚为一组） */
.tool-group {
  border: none;
  border-radius: 12px;
  background: color-mix(in oklab, var(--muted) 58%, transparent);
  overflow: hidden;
  /* flex 子项显式允许收缩，窄窗格内 diff/工具卡不再横向撑破 */
  min-width: 0;
  max-width: 100%;
}
.tool-group-head {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 9px 12px;
  font-size: 12px;
  color: var(--muted-foreground);
  border: none;
  background: transparent;
  cursor: pointer;
  user-select: none;
  text-align: left;
}
.tool-group-head:hover { background: var(--muted); }
.tg-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--muted-foreground); }
.tg-label { font-weight: 600; color: var(--foreground); white-space: nowrap; }
.tg-count { font-weight: 500; color: var(--muted-foreground); white-space: nowrap; }
.tg-names { display: inline-flex; align-items: center; gap: 6px; flex: 1; min-width: 0; overflow: hidden; flex-wrap: nowrap; }
.tg-chip { display: inline-flex; align-items: center; gap: 1px; font-family: var(--font-mono); font-size: 11px; color: var(--muted-foreground); background: color-mix(in oklab, var(--muted) 55%, transparent); border: 1px solid var(--border); border-radius: 999px; padding: 1px 7px; white-space: nowrap; }
.tg-chip-count { font-weight: 600; color: var(--foreground); }
.tg-collapse { flex-shrink: 0; color: var(--muted-foreground); font-size: 12px; }
.tool-group-body-shell { display: grid; grid-template-rows: 1fr; transition: grid-template-rows 200ms cubic-bezier(0.4,0,0.2,1); overflow: hidden; }
.tool-group-body-shell.is-collapsed { grid-template-rows: 0fr; }
.tool-group-body { min-height: 0; overflow: hidden; display: flex; flex-direction: column; gap: 8px; padding: 8px 8px 10px; transition: padding 200ms cubic-bezier(0.4,0,0.2,1), gap 200ms cubic-bezier(0.4,0,0.2,1); }
.tool-group-body-shell.is-collapsed .tool-group-body { padding-top: 0; padding-bottom: 0; gap: 0; }
.tool-group-diffs {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 100%;
}
.tool-group-diff {
  background: var(--card);
}
</style>