/**
 * Todo 面板纯函数（CV-S11，AC-CV-037~042，U-CV-016~021，v3.63 修正）。
 *
 * 数据源：pi `todo` 工具返回的 `result.details`（单数据源，与 pi TUI 端 rpiv-todo 同源）。
 * 前端无跨进程持久化、APP 退出随进程消失，按 sessionId 内存隔离（由 useSessionConversation
 * 持有 snapshot Map，切走再切回不丢视图）。
 *
 * 纯 TS 零依赖（Node type stripping 可直跑，先例 utils/slashCommand.ts / utils/atCompletion.ts）。
 * 所有函数对畸形输入（非对象、字段缺失、类型不符等）不抛错、不返回 undefined/NaN，
 * 仅对合法 todo 完成事件更新快照，其余事件（普通工具完成、todo 工具无 details、details 非法）
 * 一律静默忽略返回原快照引用。
 */
import { i18n } from '../i18n/index.ts';

/** 任务状态（与 pi `todo` 工具 status 枚举一致） */
export type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

/** 单个 todo 任务（pi 工具 details.tasks[i] 的最小可用字段集） */
export interface TodoTask {
  id: number;
  subject: string;
  status: TodoStatus;
  /** 进行中任务的当前动作描述（如「调查上下文」），仅 in_progress 时渲染 */
  activeForm?: string;
  /** 任务依赖的 id 列表（v1.2 不展示，保留字段以备后续迭代） */
  blockedBy?: number[];
  /** 任务归属（v1.2 不展示，保留字段以备后续迭代） */
  owner?: string;
}

/** 当前会话 todo 快照（useSessionConversation 持有，按 sessionId 隔离） */
export interface TodoSnapshot {
  tasks: TodoTask[];
  nextId: number;
  /**
   * 已完成且不再显示的任务 id（上一轮及更早完成）。数据层保留全量（与 pi 工具语义一致），
   * 仅显示层过滤 —— rpiv-todo TUI overlay 的 hiddenCompletedTaskIds 同款。
   * 两个集合恒为空则缺省省略字段（保持快照形状与旧版一致）。
   */
  hiddenCompletedIds?: number[];
  /**
   * 本轮内新完成、当前仍显示、下一轮起点转入 hiddenCompletedIds 的任务 id
   * （rpiv-todo overlay 的 completedTaskIdsPendingHide 同款）。
   */
  pendingHideCompletedIds?: number[];
}

/** tool.completed 事件 payload（CV-S11 关心的最小形状） */
export interface TodoCompletedEvent {
  toolName?: string;
  /** pi 工具返回的 details（透传字段，结构由工具自身定义；todo 工具 = { action, tasks, nextId }） */
  details?: unknown;
}

// ===== reducer =====

/** 收集 tasks 中合法的 completed 任务 id（缺 id / 非对象的畸形项跳过） */
function collectCompletedIds(tasks: TodoTask[]): Set<number> {
  const ids = new Set<number>();
  for (const t of tasks) {
    if (t && typeof t.id === 'number' && t.status === 'completed') ids.add(t.id);
  }
  return ids;
}

/**
 * 归约 todo 工具完成事件（AC-CV-037/041）。
 *
 * 合法 todo 事件（toolName='todo' 且 details 含 tasks 数组）→ 全量替换快照；
 * 非 todo 工具 / todo 工具无 details / details 非对象 / details.tasks 非数组
 * → 静默返回原快照引用（不抛错、不污染、引用稳定以便 Vue 跳过无效更新）。
 *
 * 上一轮 completed 的显示层隐藏（见 applyTodoTurnStart）：工具每次返回全量快照，
 * 旧 completed 会被反复带回，隐藏集必须随快照持久并在每次替换后重新生效：
 * - 隐藏集/待隐藏集透传，且按「新快照中仍是 completed」修剪（任务复活 → 重新显示）；
 * - 新出现的 completed（不在两个集合中）记入待隐藏集 —— 本轮内可见，下一轮起点隐藏
 *   （rpiv-todo overlay 渲染期把新 displayed completed 记入 pendingHide 的同款时序）；
 * - nextId 回退（clear 动作）→ 两个集合重置（resetCompletedDisplayState 同款）。
 */
export function applyTodoCompletion(
  prev: TodoSnapshot | null,
  event: TodoCompletedEvent,
): TodoSnapshot | null {
  if (!event || event.toolName !== 'todo') return prev;
  const d = event.details;
  if (!d || typeof d !== 'object' || Array.isArray(d)) return prev;
  const obj = d as Record<string, unknown>;
  if (!Array.isArray(obj.tasks)) return prev;
  const tasks = obj.tasks as TodoTask[];
  const nextId = typeof obj.nextId === 'number' ? obj.nextId : prev?.nextId ?? 0;
  const completedIds = collectCompletedIds(tasks);
  // clear 动作使 nextId 回退 → 列表已重置，历史隐藏态不再有意义
  const reset = prev !== null && nextId < prev.nextId;
  const hidden = new Set(reset ? [] : (prev?.hiddenCompletedIds ?? []));
  const pendingHide = new Set(reset ? [] : (prev?.pendingHideCompletedIds ?? []));
  // 修剪：不再是 completed 的 id 移出集合（复活的任务重新显示）
  for (const id of hidden) if (!completedIds.has(id)) hidden.delete(id);
  for (const id of pendingHide) if (!completedIds.has(id)) pendingHide.delete(id);
  // 新出现的 completed → 待隐藏（本轮保持可见）
  for (const id of completedIds) {
    if (!hidden.has(id) && !pendingHide.has(id)) pendingHide.add(id);
  }
  const snap: TodoSnapshot = { tasks, nextId };
  if (hidden.size > 0) snap.hiddenCompletedIds = [...hidden];
  if (pendingHide.size > 0) snap.pendingHideCompletedIds = [...pendingHide];
  return snap;
}

/**
 * 新轮次起点（conversation.statusChanged(streaming)）的显示层兑底：
 * 快照里所有 completed 任务都已归属上一轮 → 全部并入 hiddenCompletedIds，
 * 清空待隐藏集。对应 rpiv-todo overlay 在 agent_start 时的
 * hideCompletedTasksFromPreviousTurn()（数据层保留，仅面板不再显示）。
 * 无新增可隐藏任务时返回原引用（引用稳定，方便 Vue 跳过无效更新）。
 */
export function applyTodoTurnStart(prev: TodoSnapshot | null): TodoSnapshot | null {
  if (!prev) return prev;
  const completedIds = collectCompletedIds(prev.tasks);
  const hidden = new Set(prev.hiddenCompletedIds ?? []);
  const pendingHide = prev.pendingHideCompletedIds ?? [];
  for (const id of pendingHide) hidden.add(id);
  for (const id of completedIds) hidden.add(id);
  // 无新增可隐藏（已全部隐藏且无待隐藏）→ 原引用返回
  if (hidden.size === (prev.hiddenCompletedIds?.length ?? 0)) return prev;
  return { tasks: prev.tasks, nextId: prev.nextId, hiddenCompletedIds: [...hidden] };
}

/**
 * 会话终态兑底（done / canceled / error / idle）：把快照里残留的 in_progress
 * 任务标为 completed。避免 TodoPanel 永远挂着呼吸点。代理若忘了调用 todo 工具收尾，
 * 这里走兑底。与 isAllCompleted 叠加后走 TodoPanel 的“全部完成 → 折叠 → 隐藏”路径。
 * 快照为空或不含 in_progress 时返回原引用（引用稳定，方便 Vue 跳过无效更新）。
 */
export function applyTerminalCleanup(prev: TodoSnapshot | null): TodoSnapshot | null {
  if (!prev || !Array.isArray(prev.tasks) || !prev.tasks.some((t) => t?.status === 'in_progress')) {
    return prev;
  }
  return {
    ...prev,
    tasks: prev.tasks.map((t) => (t?.status === 'in_progress' ? { ...t, status: 'completed' } : t)),
  };
}

// ===== selectors =====

/**
 * 过滤墓碑（status='deleted'）与上一轮已完成（hiddenCompletedIds，见 applyTodoTurnStart）
 * 后的可见任务（AC-CV-038/040）。
 * 按 (completed, in_progress, pending) 三段顺序、组内按 id 升序；与 rpiv-todo TUI 端 selectOverlayTasks 同款。
 */
export function selectVisibleTasks(snapshot: TodoSnapshot | null): TodoTask[] {
  if (!snapshot || !Array.isArray(snapshot.tasks)) return [];
  const hidden = snapshot.hiddenCompletedIds;
  const hiddenSet = hidden !== undefined && hidden.length > 0 ? new Set(hidden) : null;
  const order: Record<TodoStatus, number> = { completed: 0, in_progress: 1, pending: 2, deleted: 3 };
  return snapshot.tasks
    .filter(
      (t) =>
        t &&
        t.status !== 'deleted' &&
        !(hiddenSet !== null && t.status === 'completed' && hiddenSet.has(t.id)),
    )
    .slice()
    .sort((a, b) => {
      const oa = order[a.status] ?? 9;
      const ob = order[b.status] ?? 9;
      if (oa !== ob) return oa - ob;
      return a.id - b.id;
    });
}

/**
 * 面板可见性门（AC-CV-040）：visible=0 → 卸载（DOM 不渲染、不留高度）。
 */
export function shouldRenderPanel(visibleTasks: readonly TodoTask[]): boolean {
  return visibleTasks.length > 0;
}

/**
 * 全部完成判定（自动折叠→隐藏的触发条件）：
 * visible 非空且每一条都是 completed（pending / in_progress 任一存在即未完成）。
 * deleted 已被 selectVisibleTasks 过滤，不参与判定。
 */
export function isAllCompleted(visibleTasks: readonly TodoTask[]): boolean {
  return visibleTasks.length > 0 && visibleTasks.every((t) => t?.status === 'completed');
}

/** 全部完成 → 自动折叠前的停留时长（让用户看清末态 ✓ + 数字翻滚，毫秒） */
export const TODO_AUTO_COLLAPSE_DELAY_MS = 2000;
/** 自动折叠 → 自动隐藏的间隔（折叠 200ms 动画播完即隐藏，毫秒） */
export const TODO_AUTO_HIDE_DELAY_MS = 200;

// ===== 行渲染（HTML/CSS class 输出，供 v-html 渲染）=====

/** 任务行最大码点（中文按 CJK 宽度 2 计的可视宽度不是这里的关注点；这里按码点截断防半代理对） */
const MAX_SUBJECT_CODEPOINTS = 80;

/** HTML 实体转义（XSS 防御：subject / activeForm 来自 pi 工具结果，必须转义后再嵌入 v-html） */
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** 状态 → glyph (字符 + CSS class) */
const GLYPH_MAP: Record<TodoStatus, { char: string; cls: string }> = {
  pending: { char: '○', cls: 'todo-glyph todo-glyph-pending' },
  // 进行中 = 实心呼吸点（● + todo-glyph-breathing 呼吸动画，用户裁定 2026-09-10，
  // 替代此前的半圆 ◐；待办保持空心 ○ 不变）
  in_progress: { char: '●', cls: 'todo-glyph todo-glyph-active todo-glyph-breathing' },
  completed: { char: '✓', cls: 'todo-glyph todo-glyph-done' },
  deleted: { char: '✗', cls: 'todo-glyph todo-glyph-deleted' },
};

/** 状态 → subject CSS class（颜色 / 删除线由 CSS 承载） */
const SUBJECT_CLASS_MAP: Record<TodoStatus, string> = {
  pending: 'todo-subject',
  in_progress: 'todo-subject todo-subject-active',
  completed: 'todo-subject todo-subject-done',
  deleted: 'todo-subject todo-subject-deleted',
};

/**
 * 渲染单行任务（AC-CV-038）：
 * - pending: ○ + 普通色 subject（无括号）
 * - in_progress: ● 呼吸点 + accent subject + 括号 activeForm（如有）
 * - completed: ✓ + muted 删除线 subject
 * - deleted: ✗ + muted 删除线 subject（selectVisibleTasks 已过滤；此处独立处理）
 * - subject 空 → 「（无标题）」占位；超长 → 截断 + 省略号
 *
 * 返回 HTML 字符串（CSS class 驱动样式），供 <span v-html="..."> 渲染。
 * **不**返回 ANSI 转义码（浏览器无法识别 ANSI，会显示为乱码）。
 * subject / activeForm 走 escapeHtml 防 XSS。
 */
export function formatTodoRow(task: TodoTask): string {
  const g = GLYPH_MAP[task.status];
  const subj = truncateSubject(task.subject ?? '', MAX_SUBJECT_CODEPOINTS);
  const subjectText = subj === '' ? i18n.t('panels.todo.untitled') : subj;
  const subjectCls = SUBJECT_CLASS_MAP[task.status];
  let html = `<span class="${g.cls}">${g.char}</span> <span class="${subjectCls}">${escapeHtml(subjectText)}</span>`;
  if (task.status === 'in_progress' && task.activeForm && task.activeForm.length > 0) {
    html += ` <span class="todo-active-form">（${escapeHtml(task.activeForm)}）</span>`;
  }
  return html;
}

/**
 * 按码点截断 subject（AC-CV-038 字段边界）：
 * - 短文本原样返回
 * - 超过 max → 前 max 码点 + …；恰好 max → 不加 …
 * - 不会切在代理对中间（按 codePointAt 切）
 * - max<=0 防御性降级：返回空串（不抛错）
 */
export function truncateSubject(subject: string, max: number): string {
  if (typeof subject !== 'string' || subject === '') return '';
  if (typeof max !== 'number' || !Number.isFinite(max) || max <= 0) return '';
  // 用 Array.from 把字符串拆为码点（代理对作为一个元素）
  const codePoints = Array.from(subject);
  if (codePoints.length <= max) return subject;
  return codePoints.slice(0, max).join('') + '…';
}