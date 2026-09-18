import test from 'node:test';
import assert from 'node:assert/strict';

import {
  applyTodoCompletion,
  selectVisibleTasks,
  shouldRenderPanel,
  isAllCompleted,
  TODO_AUTO_COLLAPSE_DELAY_MS,
  TODO_AUTO_HIDE_DELAY_MS,
  formatTodoRow,
  truncateSubject,
  type TodoSnapshot,
  type TodoTask,
  type TodoCompletedEvent,
} from '../src/utils/todoPanel.ts';

// ===== applyTodoCompletion: reducer =====

test('applyTodoCompletion: initial null + 合法 todo 完成事件 → 全量替换快照', () => {
  const prev: TodoSnapshot = null;
  const event: TodoCompletedEvent = {
    toolName: 'todo',
    details: {
      action: 'create',
      tasks: [
        { id: 1, subject: '修复登录', status: 'pending' },
        { id: 2, subject: '加单元测试', status: 'completed', activeForm: '提交测试' },
      ],
      nextId: 3,
    },
  };
  const next = applyTodoCompletion(prev, event);
  assert.deepEqual(next, {
    tasks: [
      { id: 1, subject: '修复登录', status: 'pending' },
      { id: 2, subject: '加单元测试', status: 'completed', activeForm: '提交测试' },
    ],
    nextId: 3,
  });
});

test('applyTodoCompletion: 已有快照 + 新完成事件 → 全量替换为新 details（不留旧）', () => {
  const prev: TodoSnapshot = {
    tasks: [{ id: 1, subject: '旧任务', status: 'pending' }],
    nextId: 2,
  };
  const event: TodoCompletedEvent = {
    toolName: 'todo',
    details: {
      action: 'update',
      tasks: [{ id: 2, subject: '新任务', status: 'in_progress' }],
      nextId: 3,
    },
  };
  const next = applyTodoCompletion(prev, event);
  assert.deepEqual(next, {
    tasks: [{ id: 2, subject: '新任务', status: 'in_progress' }],
    nextId: 3,
  });
});

test('applyTodoCompletion: 非 todo 工具完成 → 静默忽略，不改快照', () => {
  const prev: TodoSnapshot = {
    tasks: [{ id: 1, subject: '原任务', status: 'pending' }],
    nextId: 2,
  };
  const event = {
    toolName: 'read',
    details: { foo: 'bar' },
  } as unknown as TodoCompletedEvent;
  const next = applyTodoCompletion(prev, event);
  assert.equal(next, prev, '非 todo 工具必须返回同一引用，不污染快照');
});

test('applyTodoCompletion: todo 工具但 details 缺失 → 静默忽略', () => {
  const prev: TodoSnapshot = {
    tasks: [{ id: 1, subject: '保留', status: 'pending' }],
    nextId: 2,
  };
  const event = { toolName: 'todo' } as TodoCompletedEvent;
  const next = applyTodoCompletion(prev, event);
  assert.equal(next, prev);
});

test('applyTodoCompletion: todo 工具但 details 非对象 → 静默忽略', () => {
  const prev: TodoSnapshot = {
    tasks: [{ id: 1, subject: '保留', status: 'pending' }],
    nextId: 2,
  };
  for (const bad of ['string', 42, null, true, [], false]) {
    const event = { toolName: 'todo', details: bad } as unknown as TodoCompletedEvent;
    assert.equal(applyTodoCompletion(prev, event), prev, `details=${JSON.stringify(bad)} 不应污染`);
  }
});

test('applyTodoCompletion: todo 工具但 tasks 非数组 → 静默忽略', () => {
  const prev: TodoSnapshot = {
    tasks: [{ id: 1, subject: '保留', status: 'pending' }],
    nextId: 2,
  };
  for (const badTasks of [null, 'str', 42, {}, true]) {
    const event = {
      toolName: 'todo',
      details: { action: 'list', tasks: badTasks, nextId: 3 },
    } as unknown as TodoCompletedEvent;
    assert.equal(applyTodoCompletion(prev, event), prev, `tasks=${JSON.stringify(badTasks)} 不应污染`);
  }
});

test('applyTodoCompletion: 持续多次非法事件不污染上一份有效快照', () => {
  let snap: TodoSnapshot = null;
  snap = applyTodoCompletion(snap, {
    toolName: 'todo',
    details: {
      action: 'create',
      tasks: [{ id: 1, subject: 'A', status: 'pending' }],
      nextId: 2,
    },
  });
  const before = snap;
  // 连续 10 次非法
  for (let i = 0; i < 10; i++) {
    snap = applyTodoCompletion(snap, { toolName: 'todo' } as TodoCompletedEvent);
    snap = applyTodoCompletion(snap, {
      toolName: 'todo',
      details: 'str',
    } as unknown as TodoCompletedEvent);
  }
  assert.equal(snap, before, '10 次非法事件后快照引用与最后一份有效快照一致');
});

// ===== selectVisibleTasks: 过滤 deleted =====

test('selectVisibleTasks: 过滤 status=deleted 墓碑，按 (completed, in_progress, pending) 顺序 + id 升序', () => {
  const snap: TodoSnapshot = {
    tasks: [
      { id: 1, subject: 'a', status: 'deleted' },
      { id: 2, subject: 'b', status: 'pending' },
      { id: 3, subject: 'c', status: 'completed' },
      { id: 4, subject: 'd', status: 'deleted' },
      { id: 5, subject: 'e', status: 'in_progress' },
      { id: 6, subject: 'f', status: 'completed' },
    ],
    nextId: 7,
  };
  const visible = selectVisibleTasks(snap);
  assert.deepEqual(
    visible.map((t) => ({ id: t.id, status: t.status })),
    [
      { id: 3, status: 'completed' },
      { id: 6, status: 'completed' },
      { id: 5, status: 'in_progress' },
      { id: 2, status: 'pending' },
    ],
  );
});

test('selectVisibleTasks: 全 deleted → 空数组', () => {
  const snap: TodoSnapshot = {
    tasks: [
      { id: 1, subject: 'a', status: 'deleted' },
      { id: 2, subject: 'b', status: 'deleted' },
    ],
    nextId: 3,
  };
  assert.deepEqual(selectVisibleTasks(snap), []);
});

test('selectVisibleTasks: 空快照/null → 空数组', () => {
  assert.deepEqual(selectVisibleTasks(null), []);
  assert.deepEqual(selectVisibleTasks({ tasks: [], nextId: 0 }), []);
});

// ===== shouldRenderPanel: 可见性门 =====

test('shouldRenderPanel: visible=0 → false（面板卸载）', () => {
  assert.equal(shouldRenderPanel([]), false);
});

test('shouldRenderPanel: visible>0 → true', () => {
  assert.equal(
    shouldRenderPanel([{ id: 1, subject: 'a', status: 'pending' } as TodoTask]),
    true,
  );
});

// ===== isAllCompleted: 自动折叠→隐藏触发条件 =====

test('isAllCompleted: 空数组 → false（空快照走卸载门，不走自动收起）', () => {
  assert.equal(isAllCompleted([]), false);
});

test('isAllCompleted: 非空且全 completed → true', () => {
  assert.equal(
    isAllCompleted([
      { id: 1, subject: 'a', status: 'completed' },
      { id: 2, subject: 'b', status: 'completed' },
    ] as TodoTask[]),
    true,
  );
});

test('isAllCompleted: 含 pending/in_progress 任一 → false', () => {
  assert.equal(
    isAllCompleted([
      { id: 1, subject: 'a', status: 'completed' },
      { id: 2, subject: 'b', status: 'pending' },
    ] as TodoTask[]),
    false,
  );
  assert.equal(
    isAllCompleted([
      { id: 1, subject: 'a', status: 'completed' },
      { id: 2, subject: 'b', status: 'in_progress' },
    ] as TodoTask[]),
    false,
  );
});

test('自动收起延迟常量：折叠停留 > 隐藏间隔，且均为正整数', () => {
  assert.ok(Number.isInteger(TODO_AUTO_COLLAPSE_DELAY_MS) && TODO_AUTO_COLLAPSE_DELAY_MS > 0);
  assert.ok(Number.isInteger(TODO_AUTO_HIDE_DELAY_MS) && TODO_AUTO_HIDE_DELAY_MS > 0);
  assert.ok(
    TODO_AUTO_COLLAPSE_DELAY_MS > TODO_AUTO_HIDE_DELAY_MS,
    '先让用户看清末态，再播折叠+隐藏两段动画',
  );
});

// ===== formatTodoRow: 行渲染（HTML/CSS 输出）=====

test('formatTodoRow: pending 任务 → 包含 ○ glyph span + subject span（不带括号）', () => {
  const row = formatTodoRow({ id: 1, subject: '写文档', status: 'pending' });
  // HTML 输出含 glyph span 与 subject span，状态使用 CSS class（不再用 ANSI 码）
  assert.match(row, /<span class="todo-glyph todo-glyph-pending">○<\/span>/);
  assert.match(row, /<span class="todo-subject">写文档<\/span>/);
  assert.doesNotMatch(row, /\(/, 'pending 不应渲染括号');
  assert.doesNotMatch(row, /\x1b\[/, '不应输出 ANSI 转义码（浏览器无法解释）');
});

test('formatTodoRow: in_progress 任务 + activeForm → ● 呼吸点 glyph span + subject span + 括号 activeForm span', () => {
  const row = formatTodoRow({
    id: 2,
    subject: '修复缓存',
    activeForm: '调查调用方',
    status: 'in_progress',
  });
  assert.match(row, /<span class="todo-glyph todo-glyph-active todo-glyph-breathing">●<\/span>/);
  assert.match(row, /<span class="todo-subject todo-subject-active">修复缓存<\/span>/);
  assert.match(row, /<span class="todo-active-form">（调查调用方）<\/span>/);
  assert.doesNotMatch(row, /\x1b\[/, '不应输出 ANSI 转义码');
});

test('formatTodoRow: in_progress 但无 activeForm → 不渲染括号 span', () => {
  const row = formatTodoRow({ id: 2, subject: '修复缓存', status: 'in_progress' });
  assert.match(row, /todo-glyph-active/);
  assert.match(row, /todo-subject-active/);
  assert.doesNotMatch(row, /todo-active-form/, '无 activeForm 时不渲染括号 span');
});

test('formatTodoRow: completed 任务 → ✓ glyph span + subject span 含 done class（删除线由 CSS class 表达，不用 ANSI）', () => {
  const row = formatTodoRow({ id: 3, subject: '已完成项', status: 'completed' });
  assert.match(row, /<span class="todo-glyph todo-glyph-done">✓<\/span>/);
  assert.match(row, /<span class="todo-subject todo-subject-done">已完成项<\/span>/);
  assert.doesNotMatch(row, /\x1b\[/, '不应输出 ANSI 转义码（删除线由 CSS class 承载）');
});

test('formatTodoRow: deleted 任务 → ✗ glyph span + subject span 含 deleted class', () => {
  const row = formatTodoRow({ id: 4, subject: '被删项', status: 'deleted' });
  assert.match(row, /<span class="todo-glyph todo-glyph-deleted">✗<\/span>/);
  assert.match(row, /<span class="todo-subject todo-subject-deleted">被删项<\/span>/);
});

test('formatTodoRow: 空 subject → 「（无标题）」占位文本（不渲染 raw HTML 标签）', () => {
  const row = formatTodoRow({ id: 5, subject: '', status: 'pending' });
  assert.match(row, /（无标题）/);
});

test('formatTodoRow: 含 owner 字段 → 不渲染 owner（v1.2 简化）', () => {
  const row = formatTodoRow({
    id: 6,
    subject: 'task',
    status: 'pending',
    owner: 'some-agent',
  });
  assert.doesNotMatch(row, /some-agent/);
  assert.doesNotMatch(row, /owner/);
});

test('formatTodoRow: 超长 subject → 按码点截断 + 省略号', () => {
  const longSubj = '修复一个'.repeat(50); // 200 个 CJK 字符
  const row = formatTodoRow({ id: 7, subject: longSubj, status: 'pending' });
  assert.ok(!row.includes(longSubj), '超长 subject 必须被截断');
  assert.match(row, /…/, '截断后应带省略号');
});

test('formatTodoRow: 恰好达上限 → 不加省略号', () => {
  const exactSubj = 'a'.repeat(80);
  const row = formatTodoRow({ id: 8, subject: exactSubj, status: 'pending' });
  assert.match(row, /a{80}/);
  assert.doesNotMatch(row, /…/);
});

test('formatTodoRow: subject 含 HTML 特殊字符 → 必须 HTML 转义（XSS 防御）', () => {
  const row = formatTodoRow({
    id: 9,
    subject: '<script>alert("xss")</script>',
    status: 'pending',
  });
  assert.doesNotMatch(row, /<script>/, 'subject 中的 HTML 标签必须被转义，不能原样出现');
  assert.match(row, /&lt;script&gt;/, '应转义为 HTML 实体');
});

test('formatTodoRow: activeForm 含 HTML 特殊字符 → 必须 HTML 转义', () => {
  const row = formatTodoRow({
    id: 10,
    subject: 'task',
    activeForm: '<img src=x onerror=alert(1)>',
    status: 'in_progress',
  });
  assert.doesNotMatch(row, /<img/, 'activeForm 中的 HTML 标签必须被转义');
  assert.match(row, /&lt;img/, '应转义为 HTML 实体');
});

// ===== truncateSubject: 文本工具 =====

test('truncateSubject: 短文本不变', () => {
  assert.equal(truncateSubject('hello', 80), 'hello');
});

test('truncateSubject: 超过 max → 截断 + 省略号（按码点）', () => {
  assert.equal(truncateSubject('a'.repeat(100), 80), 'a'.repeat(80) + '…');
});

test('truncateSubject: 恰好 max → 不加省略号', () => {
  assert.equal(truncateSubject('a'.repeat(80), 80), 'a'.repeat(80));
});

test('truncateSubject: emoji + CJK 混合 → 按码点截断，不切半代理对', () => {
  // 😀 是 1 码点（U+1F600），CJK 是 1 码点
  const text = '修复 😀 '.repeat(50); // 100 码点
  const truncated = truncateSubject(text, 80);
  // 截断后码点数 ≤ max + 1（省略号）
  assert.ok(Array.from(truncated).length <= 81, '截断后最多 80 码点 + 省略号');
  assert.match(truncated, /…$/);
  // 不能含半个代理对（无未匹配高/低代理）
  assert.doesNotMatch(truncated.slice(0, -1), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  assert.doesNotMatch(truncated.slice(0, -1), /(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/);
});

test('truncateSubject: 空串 → 空串', () => {
  assert.equal(truncateSubject('', 80), '');
});

test('truncateSubject: max<=0 → 抛错或返回空（防御）', () => {
  // 防御性：非法 max 应安全降级（不抛错）
  assert.doesNotThrow(() => truncateSubject('hello', 0));
  assert.doesNotThrow(() => truncateSubject('hello', -1));
});