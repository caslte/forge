/**
 * 工具事件服务（toolService）单元测试。
 *
 * 覆盖 docs/test/04_tool/coverage-matrix.md 本 WU 用例：
 * - U-TE-001：长结果折叠阈值（isLongResult 边界，AC-TE-004）
 * - U-TE-005：卡片状态机（running→completed/error 合法；非法反向被阻止，AC-TE-009）
 * 以及本 WU 契约：事件记录幂等（一事件一卡片）、会话隔离、Diff 数据提取与降级
 * （U-TE-003 / AC-TE-006）、事件不存在 not-found。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；服务为纯内存状态机，无外部依赖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ToolEventService } from '../../src/tool/toolService.ts';
import type { ToolStartedEvent } from '../../src/tool/toolService.ts';

/** 构造 started 事件（默认 edit 工具，可覆盖 name/input） */
function startedEvent(
  sessionId: string,
  toolEventId: string,
  name = 'edit',
  input: Record<string, unknown> = {},
): ToolStartedEvent {
  return { sessionId, toolEventId, tool: { name, input }, status: 'running' };
}

test('recordToolEvent：started 事件记录，可读取（A-TE-001/AC-TE-001）', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1', 'edit', { file_path: 'src/a.ts' }));
  const events = service.getSessionToolEvents('sess-1');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.toolEventId, 'evt-1');
  assert.equal(events[0]?.status, 'running');
  assert.equal(events[0]?.tool.name, 'edit');
  assert.equal(service.getToolEvent('sess-1', 'evt-1')?.toolEventId, 'evt-1');
  assert.equal(service.getToolEvent('sess-1', 'evt-missing'), undefined);
});

test('recordToolEvent：同一 toolEventId 重复推送不产生第二条记录（幂等，一事件一卡片）', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  assert.equal(service.getSessionToolEvents('sess-1').length, 1);
});

test('recordToolEvent：会话隔离，两个会话事件不混', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  service.recordToolEvent(startedEvent('sess-2', 'evt-2'));
  assert.equal(service.getSessionToolEvents('sess-1').length, 1);
  assert.equal(service.getSessionToolEvents('sess-2').length, 1);
  assert.equal(service.getSessionToolEvents('sess-1')[0]?.toolEventId, 'evt-1');
  assert.equal(service.getSessionToolEvents('sess-2')[0]?.toolEventId, 'evt-2');
});

test('setToolStatus：running→completed 合法，记录原地更新为完成态（A-TE-002/AC-TE-009）', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  const result = service.setToolStatus('sess-1', 'evt-1', 'completed', {
    result: { text: 'Edited 3 lines', image: null },
  });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.data.status, 'completed');
    if (result.data.status === 'completed') {
      assert.deepEqual(result.data.result, { text: 'Edited 3 lines', image: null });
    }
  }
  const events = service.getSessionToolEvents('sess-1');
  assert.equal(events.length, 1); // 原地更新，不新增记录
  assert.equal(events[0]?.status, 'completed');
});

test('setToolStatus：running→error 合法，记录更新为错误态（AC-TE-010）', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  const result = service.setToolStatus('sess-1', 'evt-1', 'error', {
    error: { message: 'No files matched' },
  });
  assert.ok(result.ok);
  const events = service.getSessionToolEvents('sess-1');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, 'error');
  if (events[0]?.status === 'error') {
    assert.equal(events[0].error.message, 'No files matched');
  }
});

test('setToolStatus：completed→running 非法反向被拒绝，记录不变（U-TE-005）', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  service.setToolStatus('sess-1', 'evt-1', 'completed', {
    result: { text: 'ok', image: null },
  });
  const result = service.setToolStatus('sess-1', 'evt-1', 'running');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 'invalid-transition');
  }
  const events = service.getSessionToolEvents('sess-1');
  assert.equal(events.length, 1);
  assert.equal(events[0]?.status, 'completed'); // 记录未被修改
});

test('setToolStatus：error→running 非法反向被拒绝，记录不变', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  service.setToolStatus('sess-1', 'evt-1', 'error', { error: { message: 'boom' } });
  const result = service.setToolStatus('sess-1', 'evt-1', 'running');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 'invalid-transition');
  }
  assert.equal(service.getSessionToolEvents('sess-1')[0]?.status, 'error');
});

test('setToolStatus：事件不存在返回 not-found', () => {
  const service = new ToolEventService();
  const result = service.setToolStatus('sess-1', 'evt-missing', 'completed', {
    result: { text: 'x', image: null },
  });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 'not-found');
  }
});

test('isLongResult：阈值边界（≤阈值 false，>阈值 true）（U-TE-001/AC-TE-004）', () => {
  const service = new ToolEventService();
  assert.equal(service.isLongResult('a'.repeat(5000)), false);
  assert.equal(service.isLongResult('a'.repeat(5001)), true);
  assert.equal(service.isLongResult('short'), false);
  // 自定义阈值
  assert.equal(service.isLongResult('a'.repeat(100), 100), false);
  assert.equal(service.isLongResult('a'.repeat(101), 100), true);
});

test('getDiffData：edit 事件含 old_string/new_string/file_path 返回三元组（U-TE-003/AC-TE-006）', () => {
  const service = new ToolEventService();
  service.recordToolEvent(
    startedEvent('sess-1', 'evt-1', 'edit', {
      file_path: 'src/a.ts',
      old_string: 'old',
      new_string: 'new',
    }),
  );
  assert.deepEqual(service.getDiffData('sess-1', 'evt-1'), {
    filePath: 'src/a.ts',
    oldString: 'old',
    newString: 'new',
  });
});

test('getDiffData：old_string 缺失 → oldString null，newString 保留（降级显示 newText）', () => {
  const service = new ToolEventService();
  service.recordToolEvent(
    startedEvent('sess-1', 'evt-1', 'edit', {
      file_path: 'src/a.ts',
      new_string: 'new',
    }),
  );
  assert.deepEqual(service.getDiffData('sess-1', 'evt-1'), {
    filePath: 'src/a.ts',
    oldString: null,
    newString: 'new',
  });
});

test('getDiffData：非 edit 类事件返回 null', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1', 'grep', { pattern: 'foo' }));
  assert.equal(service.getDiffData('sess-1', 'evt-1'), null);
});

test('U-TE-005 状态机：合法流转通过，非法反向被阻止', () => {
  const service = new ToolEventService();
  service.recordToolEvent(startedEvent('sess-1', 'evt-1'));
  // 合法：running → completed
  assert.ok(
    service
      .setToolStatus('sess-1', 'evt-1', 'completed', { result: { text: 'ok', image: null } })
      .ok,
  );
  // 非法反向：completed → running
  assert.ok(!service.setToolStatus('sess-1', 'evt-1', 'running').ok);
  // 非法：终态 completed → error
  assert.ok(
    !service.setToolStatus('sess-1', 'evt-1', 'error', { error: { message: 'x' } }).ok,
  );

  service.recordToolEvent(startedEvent('sess-1', 'evt-2'));
  // 合法：running → error
  assert.ok(service.setToolStatus('sess-1', 'evt-2', 'error', { error: { message: 'boom' } }).ok);
  // 非法反向：error → running
  assert.ok(!service.setToolStatus('sess-1', 'evt-2', 'running').ok);
  // 非法：终态 → completed
  assert.ok(
    !service.setToolStatus('sess-1', 'evt-2', 'completed', { result: { text: 'x', image: null } })
      .ok,
  );
});

test('多会话独立：10 会话交错工具事件互不干扰（会话隔离）', () => {
  const service = new ToolEventService();
  const ids = Array.from({ length: 10 }, (_, i) => `sess-${i}`);
  for (const [i, id] of ids.entries()) {
    service.recordToolEvent(startedEvent(id, `evt-${i}`, 'run', { file: `src/${i}.ts` }));
  }
  // 偶数会话完成，奇数会话出错
  for (const [i, id] of ids.entries()) {
    if (i % 2 === 0) {
      service.setToolStatus(id, `evt-${i}`, 'completed', {
        result: { text: `done-${i}`, image: null },
      });
    } else {
      service.setToolStatus(id, `evt-${i}`, 'error', { error: { message: `err-${i}` } });
    }
  }
  for (const [i, id] of ids.entries()) {
    const events = service.getSessionToolEvents(id);
    assert.equal(events.length, 1);
    assert.equal(events[0]?.toolEventId, `evt-${i}`);
    assert.equal(events[0]?.status, i % 2 === 0 ? 'completed' : 'error');
  }
});