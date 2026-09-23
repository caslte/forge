/**
 * Git 提交弹窗开关状态（模块 11，GC-S11）。
 *
 * 入口在深层组件（InstructionInput 状态行 / BranchBadge 浮窗），弹窗必须挂在
 * App.vue 根（对齐 ExitConfirmDialog），故用模块级单例状态驱动，同 useToast 套路。
 */
import { ref } from 'vue';

const visible = ref(false);
const projectPath = ref('');
const projectName = ref('');
/** AI 生成用的会话上下文（可选；缺省走全局默认模型） */
const sessionId = ref<string | undefined>(undefined);

function basenameOf(p: string): string {
  const trimmed = p.replace(/[\\/]+$/, '');
  const idx = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

export function openGitCommitDialog(opts: {
  projectPath: string;
  projectName?: string;
  sessionId?: string;
}): void {
  projectPath.value = opts.projectPath;
  projectName.value = opts.projectName?.trim() || basenameOf(opts.projectPath);
  sessionId.value = opts.sessionId;
  visible.value = true;
}

export function closeGitCommitDialog(): void {
  visible.value = false;
}

export function useGitCommitDialog() {
  return { visible, projectPath, projectName, sessionId };
}
