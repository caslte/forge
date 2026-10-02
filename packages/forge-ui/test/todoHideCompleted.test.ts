/**
 * rpiv-todo 同款「上一轮已完成任务隐藏」规则（显示层过滤，数据层保留全量）。
 *
 * 背景（用户报告 2026-10-02）：pi `todo` 工具（rpiv-todo 插件）的状态只增不自动删，
 * 每次调用都返回包含所有已完成任务的全量快照；pi 终端 TUI 的 overlay 在 agent_start
 * 时调用 hideCompletedTasksFromPreviousTurn() 把上一轮完成的行从显示中过滤掉，
 * forge TodoPanel 缺这条规则，导致旧 completed 跨轮次累积（「已完成 15 / 共 20 个」）。
 *
 * 语义对齐 rpiv-todo todo-overlay.ts：
 * - 工具完成事件里「新出现的 completed」→ 本轮内保持可见，记入 pendingHideCompletedIds；
 * - 新轮次起点（conversation.statusChanged(streaming)）→ 全部 completed 并入
 *   hiddenCompletedIds（对应 hideCompletedTasksFromPreviousTurn），面板不再显示；
 * - 全量快照反复带回的旧 completed 必须持续被过滤（隐藏集随快照持久，不能只滤一次）；
 * - 任务复活（completed → pending/in_progress）→ 移出隐藏集重新显示；
 * - clear 动作使 nextId 回退 → 隐藏集重置（对应 resetCompletedDisplayState）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTodoCompletion,
  applyTodoTurnStart,
  isAllCompleted,
  selectVisibleTasks,
  type TodoCompletedEvent,
  type TodoSnapshot,
  type TodoTask,
} from '../src/utils/todoPanel.ts';

/** 构造一条 n 个 completed 任务（id 1..n）的首轮 todo 事件 */
function completedBatchEvent(n: number): TodoCompletedEvent {
  const tasks: TodoTask[] = Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    subject: `旧任务${i + 1}`,
    status: 'completed',
  }));
  return { toolName: 'todo', details: { action: 'create', tasks, nextId: n + 1 } };
}

test('applyTodoTurnStart：null 快照 → 返回 null', () => {
  assert.equal(applyTodoTurnStart(null), null);
});

test('applyTodoTurnStart：无 completed 任务 → 返回原引用（引用稳定）', () => {
  const snap: TodoSnapshot = {
    tasks: [
      { id: 1, subject: 'a', status: 'pending' },
      { id: 2, subject: 'b', status: 'in_progress' },
    ],
    nextId: 3,
  };
  assert.equal(applyTodoTurnStart(snap), snap, '无可隐藏任务时返回原引用');
});

test('新轮次起点：上一轮 15 个已完成任务全部转入隐藏集，面板只显示本轮任务（用户报告场景）', () => {
  // 上一轮收尾后的快照：15 个 completed
  const turn1Snap = applyTodoCompletion(null, completedBatchEvent(15));
  assert.equal(selectVisibleTasks(turn1Snap).length, 15, '本轮内 completed 保持可见');
  assert.equal(isAllCompleted(selectVisibleTasks(turn1Snap)), true);

  // 新轮次起点（statusChanged(streaming)）
  const turn2Snap = applyTodoTurnStart(turn1Snap);
  assert.notEqual(turn2Snap, turn1Snap, '有可隐藏任务时应返回新快照');
  assert.deepEqual(selectVisibleTasks(turn2Snap), [], '上一轮 completed 全部隐藏 → 面板卸载');
});

test('新轮次后工具全量快照带回旧 completed：持续被过滤，只显示本轮新任务（核心缺陷回归）', () => {
  const turn1Snap = applyTodoCompletion(null, completedBatchEvent(15));
  const turn2Snap = applyTodoTurnStart(turn1Snap);

  // 真实工具行为：create #16~#20 时返回包含全部 20 条的全量快照
  const newTasks: TodoTask[] = [
    ...Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      subject: `旧任务${i + 1}`,
      status: 'completed' as const,
    })),
    { id: 16, subject: '调研右键菜单', status: 'pending' },
    { id: 17, subject: '抽取共享 ContextMenu', status: 'pending' },
    { id: 18, subject: '代码树右键菜单', status: 'pending' },
    { id: 19, subject: '新增「用外部编辑器打开」', status: 'pending' },
    { id: 20, subject: 'tab 拖拽排序', status: 'pending' },
  ];
  const afterCreate = applyTodoCompletion(turn2Snap, {
    toolName: 'todo',
    details: { action: 'create', tasks: newTasks, nextId: 21 },
  });

  const visible = selectVisibleTasks(afterCreate);
  assert.deepEqual(
    visible.map((t) => t.id),
    [16, 17, 18, 19, 20],
    '旧 15 条 completed 即使被全量快照带回也不得再显示',
  );
  assert.equal(isAllCompleted(visible), false, '有新 pending 时面板不得自动收起');
});

test('本轮内新完成的任务保持可见，下一轮起点才隐藏（rpiv-todo 同款时序）', () => {
  const turn1Snap = applyTodoCompletion(null, completedBatchEvent(2));
  const turn2Snap = applyTodoTurnStart(turn1Snap);

  // 本轮 #3 完成后，同轮后续事件仍返回它 completed → 必须保持可见
  const midTurn = applyTodoCompletion(turn2Snap, {
    toolName: 'todo',
    details: {
      action: 'update',
      tasks: [
        { id: 1, subject: '旧1', status: 'completed' },
        { id: 2, subject: '旧2', status: 'completed' },
        { id: 3, subject: '新3', status: 'completed' },
      ],
      nextId: 4,
    },
  });
  assert.deepEqual(
    selectVisibleTasks(midTurn).map((t) => t.id),
    [3],
    '本轮新完成的任务在本轮内保持可见（✓ 停留到本轮结束）',
  );

  // 再来一轮 → #3 也隐藏
  const turn3Snap = applyTodoTurnStart(midTurn);
  assert.deepEqual(selectVisibleTasks(turn3Snap), []);
});

test('任务复活：已隐藏任务回到 pending → 移出隐藏集重新显示', () => {
  const turn1Snap = applyTodoCompletion(null, completedBatchEvent(2));
  const turn2Snap = applyTodoTurnStart(turn1Snap);
  assert.deepEqual(selectVisibleTasks(turn2Snap), []);

  const revived = applyTodoCompletion(turn2Snap, {
    toolName: 'todo',
    details: {
      action: 'update',
      tasks: [
        { id: 1, subject: '旧1', status: 'pending' },
        { id: 2, subject: '旧2', status: 'completed' },
      ],
      nextId: 3,
    },
  });
  assert.deepEqual(
    selectVisibleTasks(revived).map((t) => t.id),
    [1],
    '#1 复活为 pending 必须重新显示；#2 仍隐藏',
  );
});

test('clear 动作（nextId 回退）→ 隐藏集重置，新快照 completed 本轮内可见', () => {
  const turn1Snap = applyTodoCompletion(null, completedBatchEvent(3));
  const turn2Snap = applyTodoTurnStart(turn1Snap);

  const cleared = applyTodoCompletion(turn2Snap, {
    toolName: 'todo',
    details: {
      action: 'clear',
      tasks: [{ id: 1, subject: '重来的任务', status: 'completed' }],
      nextId: 2,
    },
  });
  assert.deepEqual(
    selectVisibleTasks(cleared).map((t) => t.id),
    [1],
    'nextId 回退表示列表已重置，隐藏集必须清空',
  );
});

test('applyTodoCompletion：首轮事件中的 completed 记入待隐藏集（本轮可见、下轮隐藏）', () => {
  const snap = applyTodoCompletion(null, {
    toolName: 'todo',
    details: {
      action: 'create',
      tasks: [
        { id: 1, subject: 'a', status: 'completed' },
        { id: 2, subject: 'b', status: 'pending' },
      ],
      nextId: 3,
    },
  });
  assert.deepEqual(snap.pendingHideCompletedIds, [1], '新出现的 completed 记入待隐藏集');
  assert.equal(snap.hiddenCompletedIds, undefined, '首轮无历史隐藏');
  assert.deepEqual(
    selectVisibleTasks(snap).map((t) => t.id),
    [1, 2],
    '本轮内两种状态都可见',
  );
});

test('畸形任务项（缺 id / 非对象）不污染隐藏集计算', () => {
  const snap = applyTodoCompletion(null, {
    toolName: 'todo',
    details: {
      action: 'create',
      tasks: [
        null,
        { subject: 'no-id', status: 'completed' },
        { id: 1, subject: 'ok', status: 'completed' },
      ] as unknown as TodoTask[],
      nextId: 2,
    },
  });
  assert.deepEqual(snap.pendingHideCompletedIds, [1], '只有合法 completed id 进入待隐藏集');
});
