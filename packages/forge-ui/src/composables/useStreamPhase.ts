import { computed, ref } from 'vue';

/**
 * 流式阶段指示（方案 A：由现有会话/工具事件推断当前动作）：
 * - thinking   流式中但无工具运行、无正文增量 → 「助手正在思考」
 * - outputting 正在接收正文增量 → 「正在输出…」
 * - tool       有未完成的工具调用 → 按工具名映射（写入/读取/执行命令/搜索…）
 *
 * 事件接线（单视图 ConversationView 与多窗口 MultiWindowConversation 一致）：
 * - delta / tool.started / tool.completed / tool.error / status(streaming) → 对应标记
 * - 工具结束仅在 toolEventId 匹配当前活动工具时回退 thinking（并行工具调用不误清）
 */

/** pi 内置工具名 → 动作文案；未知工具回退「正在执行 {name}」 */
function toolPhaseText(name: string | null): string {
  if (!name) return '正在执行工具';
  switch (name.toLowerCase()) {
    case 'write':
    case 'apply_patch':
      return '正在写入';
    case 'edit':
    case 'multi_edit':
      return '正在编辑';
    case 'read':
    case 'view':
      return '正在读取';
    case 'bash':
    case 'powershell':
    case 'shell':
      return '正在执行命令';
    case 'grep':
    case 'find':
    case 'ls':
    case 'glob':
      return '正在搜索';
    default:
      return `正在执行 ${name}`;
  }
}

export function useStreamPhase() {
  const phase = ref<'thinking' | 'outputting' | 'tool'>('thinking');
  /** 当前活动工具（tool.started 置入；tool.completed/error 匹配时清除） */
  const activeTool = ref<{ toolEventId: string; name: string | null } | null>(null);

  /** 轮次开始/结束：重置为思考态 */
  function reset(): void {
    phase.value = 'thinking';
    activeTool.value = null;
  }

  /** 收到正文增量 */
  function markOutputting(): void {
    phase.value = 'outputting';
  }

  /** 工具开始 */
  function markTool(toolEventId: string, name: string | null): void {
    phase.value = 'tool';
    activeTool.value = { toolEventId, name };
  }

  /** 工具结束（完成/失败）：仅当是当前活动工具时回退思考态 */
  function markToolEnd(toolEventId: string): void {
    if (activeTool.value?.toolEventId === toolEventId) {
      activeTool.value = null;
      phase.value = 'thinking';
    }
  }

  const streamPhaseText = computed(() => {
    if (phase.value === 'tool') return toolPhaseText(activeTool.value?.name ?? null);
    if (phase.value === 'outputting') return '正在输出';
    return '助手正在思考';
  });

  return { streamPhaseText, reset, markOutputting, markTool, markToolEnd };
}
