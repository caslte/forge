/**
 * CV-S11 兜底：会话进入终态（done / canceled / error / idle）时，
 * todo 快照里残留的 in_progress 任务应自动标为 completed，
 * 避免 TodoPanel 永远挂着呼吸点。
 *
 * 这里测试的是纯函数 applyTerminalCleanup（composable 内联调用）；
 * 它在快照无 in_progress 时返回原引用（稳定），有 in_progress 时返回新快照。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { applyTerminalCleanup, type TodoSnapshot } from '../src/utils/todoPanel.ts';

test('applyTerminalCleanup：快照为空 → 返回 null', () => {
  assert.equal(applyTerminalCleanup(null), null, 'null 快照应原样返回');
});

test('applyTerminalCleanup：快照里无 in_progress → 返回原引用（引用稳定）', () => {
  const snap: TodoSnapshot = {
    tasks: [
      { id: 1, subject: 'done', status: 'completed' },
      { id: 2, subject: 'queued', status: 'pending' },
    ],
    nextId: 3,
  };
  const next = applyTerminalCleanup(snap);
  assert.equal(next, snap, '无 in_progress 时返回原引用（Vue 跳过无效更新）');
});

test('applyTerminalCleanup：单个 in_progress → 标为 completed，其他字段保留', () => {
  const snap: TodoSnapshot = {
    tasks: [{ id: 1, subject: 'stuck', status: 'in_progress', activeForm: '处理中' }],
    nextId: 2,
  };
  const next = applyTerminalCleanup(snap);
  assert.ok(next, '应返回新快照');
  assert.notEqual(next, snap, '有 in_progress 时返回新引用');
  assert.equal(next!.tasks[0].status, 'completed', 'in_progress → completed');
  assert.equal(next!.tasks[0].subject, 'stuck', 'subject 保留');
  assert.equal(next!.tasks[0].activeForm, '处理中', 'activeForm 保留');
  assert.equal(next!.nextId, 2, 'nextId 保留');
});

test('applyTerminalCleanup：混合状态 → 仅 in_progress 被替换', () => {
  const snap: TodoSnapshot = {
    tasks: [
      { id: 1, subject: 'a', status: 'pending' },
      { id: 2, subject: 'b', status: 'in_progress' },
      { id: 3, subject: 'c', status: 'completed' },
      { id: 4, subject: 'd', status: 'in_progress' },
    ],
    nextId: 5,
  };
  const next = applyTerminalCleanup(snap);
  assert.ok(next);
  const byId = new Map(next!.tasks.map((t) => [t.id, t.status]));
  assert.equal(byId.get(1), 'pending', 'pending 不动');
  assert.equal(byId.get(2), 'completed', 'in_progress → completed');
  assert.equal(byId.get(3), 'completed', 'completed 不动');
  assert.equal(byId.get(4), 'completed', 'in_progress → completed');
});

test('applyTerminalCleanup：空 tasks 数组 → 返回原引用', () => {
  const snap: TodoSnapshot = { tasks: [], nextId: 0 };
  const next = applyTerminalCleanup(snap);
  assert.equal(next, snap, '空 tasks 无 in_progress，原引用返回');
});

test('applyTerminalCleanup：全 completed → 返回原引用（已收尾不需要再清理）', () => {
  const snap: TodoSnapshot = {
    tasks: [
      { id: 1, subject: 'a', status: 'completed' },
      { id: 2, subject: 'b', status: 'completed' },
    ],
    nextId: 3,
  };
  const next = applyTerminalCleanup(snap);
  assert.equal(next, snap, '已完成的会话不重复处理');
});
