/**
 * 工具事件 RPC 方法层（toolMethods）单元测试。
 *
 * 覆盖 docs/test/04_tool/coverage-matrix.md api 层用例：
 * - A-TE-001：tool.started 含 name/input 透传（卡片渲染数据完整）
 * - A-TE-002：tool.completed 含 result，同一 toolEventId 正确关联
 * - A-TE-003：tool.completed（edit）含 old_string/new_string 透传（Diff 字段完整）
 * - A-TE-005：started → completed 状态对，无跳跃缺失
 * 以及本 WU 契约：单向推送（无请求-响应错误码）、非法反向流转不发射事件、
 * 事件顺序、会话隔离、tool/queryToolEvents 读方法、createToolApi 工厂。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；事件经 EventEmitter 汇捕获。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ToolEventService } from '../../src/tool/toolService.ts';
import { ToolApi, createToolApi } from '../../src/rpc/toolMethods.ts';
import type { ToolDescriptor } from '../../src/rpc/toolMethods.ts';

/** 构造 api + 事件汇 + 服务 */
function makeApi(): { api: ToolApi; events: EventEmitter; service: ToolEventService } {
  const service = new ToolEventService();
  const events = new EventEmitter();
  const api = new ToolApi(service, events);
  return { api, events, service };
}

/** 构造 edit 类工具描述符（含 Diff 字段） */
function editTool(): ToolDescriptor {
  return {
    name: 'edit',
    input: { file_path: 'src/a.ts', old_string: 'old', new_string: 'new' },
  };
}

test('A-TE-001：emitToolStarted 发射 tool.started（精确载荷），服务层有记录', () => {
  const { api, events, service } = makeApi();
  const started: unknown[] = [];
  events.on('tool.started', (payload) => started.push(payload));
  const result = api.emitToolStarted('sess-1', 'evt-1', editTool());
  assert.deepEqual(result, { ok: true });
  assert.equal(started.length, 1, 'tool.started 应发射一次');
  assert.deepEqual(started[0], {
    sessionId: 'sess-1',
    toolEventId: 'evt-1',
    tool: { name: 'edit', input: { file_path: 'src/a.ts', old_string: 'old', new_string: 'new' } },
    status: 'running',
  });
  const stored = service.getSessionToolEvents('sess-1');
  assert.equal(stored.length, 1);
  assert.equal(stored[0]?.toolEventId, 'evt-1');
  assert.equal(stored[0]?.status, 'running');
});

test('A-TE-002：emitToolCompleted 发射 tool.completed（status=completed + result），服务层状态更新', () => {
  const { api, events, service } = makeApi();
  const completed: unknown[] = [];
  events.on('tool.completed', (payload) => completed.push(payload));
  api.emitToolStarted('sess-1', 'evt-1', editTool());
  const result = api.emitToolCompleted('sess-1', 'evt-1', { text: 'Edited 3 lines', image: null });
  assert.deepEqual(result, { ok: true });
  assert.equal(completed.length, 1, 'tool.completed 应发射一次');
  assert.deepEqual(completed[0], {
    sessionId: 'sess-1',
    toolEventId: 'evt-1',
    tool: { name: 'edit', input: { file_path: 'src/a.ts', old_string: 'old', new_string: 'new' } },
    status: 'completed',
    result: { text: 'Edited 3 lines', image: null },
  });
  assert.equal(service.getToolEvent('sess-1', 'evt-1')?.status, 'completed');
});

test('emitToolError 发射 tool.error（status=error + error），服务层状态更新', () => {
  const { api, events, service } = makeApi();
  const errors: unknown[] = [];
  events.on('tool.error', (payload) => errors.push(payload));
  api.emitToolStarted('sess-1', 'evt-1', { name: 'grep', input: { pattern: 'foo' } });
  const result = api.emitToolError('sess-1', 'evt-1', { message: 'No files matched' });
  assert.deepEqual(result, { ok: true });
  assert.equal(errors.length, 1, 'tool.error 应发射一次');
  assert.deepEqual(errors[0], {
    sessionId: 'sess-1',
    toolEventId: 'evt-1',
    tool: { name: 'grep', input: { pattern: 'foo' } },
    status: 'error',
    error: { message: 'No files matched' },
  });
  assert.equal(service.getToolEvent('sess-1', 'evt-1')?.status, 'error');
});

test('A-TE-003：edit 类 completed 保留 old_string/new_string，getDiffData 可访问', () => {
  const { api, events, service } = makeApi();
  const completed: unknown[] = [];
  events.on('tool.completed', (payload) => completed.push(payload));
  api.emitToolStarted('sess-1', 'evt-1', editTool());
  api.emitToolCompleted('sess-1', 'evt-1', { text: 'ok', image: null });
  const payload = completed[0] as { tool: { input: Record<string, unknown> } };
  assert.equal(payload.tool.input.old_string, 'old');
  assert.equal(payload.tool.input.new_string, 'new');
  assert.deepEqual(service.getDiffData('sess-1', 'evt-1'), {
    filePath: 'src/a.ts',
    oldString: 'old',
    newString: 'new',
  });
});

test('非法反向：completed 事件再次 emitToolCompleted 不发射事件，返回 ok:false', () => {
  const { api, events } = makeApi();
  const completed: unknown[] = [];
  events.on('tool.completed', (payload) => completed.push(payload));
  api.emitToolStarted('sess-1', 'evt-1', editTool());
  assert.deepEqual(api.emitToolCompleted('sess-1', 'evt-1', { text: 'a', image: null }), {
    ok: true,
  });
  const result = api.emitToolCompleted('sess-1', 'evt-1', { text: 'b', image: null });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 'invalid-transition');
  }
  assert.equal(completed.length, 1, '非法流转不发射 tool.completed');
});

test('非法反向：终态事件再次 emitToolStarted 不发射事件，返回 ok:false', () => {
  const { api, events } = makeApi();
  const started: unknown[] = [];
  events.on('tool.started', (payload) => started.push(payload));
  api.emitToolStarted('sess-1', 'evt-1', editTool());
  api.emitToolCompleted('sess-1', 'evt-1', { text: 'a', image: null });
  const result = api.emitToolStarted('sess-1', 'evt-1', editTool());
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 'invalid-transition');
  }
  assert.equal(started.length, 1, '终态事件不重复发射 tool.started');
});

test('事件不存在：emitToolCompleted 返回 not-found，不发射事件', () => {
  const { api, events } = makeApi();
  const completed: unknown[] = [];
  events.on('tool.completed', (payload) => completed.push(payload));
  const result = api.emitToolCompleted('sess-1', 'evt-missing', { text: 'x', image: null });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 'not-found');
  }
  assert.equal(completed.length, 0);
});

test('A-TE-005：事件顺序 started → completed 按序发射，无跳跃缺失', () => {
  const { api, events } = makeApi();
  const order: string[] = [];
  events.on('tool.started', () => order.push('started'));
  events.on('tool.completed', () => order.push('completed'));
  api.emitToolStarted('sess-1', 'evt-1', editTool());
  api.emitToolCompleted('sess-1', 'evt-1', { text: 'ok', image: null });
  assert.deepEqual(order, ['started', 'completed']);
});

test('会话隔离：不同 sessionId 事件互不串扰', () => {
  const { api, events, service } = makeApi();
  const started: unknown[] = [];
  events.on('tool.started', (payload) => started.push(payload));
  api.emitToolStarted('sess-a', 'evt-1', { name: 'read', input: { file_path: 'a.ts' } });
  api.emitToolStarted('sess-b', 'evt-1', { name: 'grep', input: { pattern: 'x' } });
  assert.equal(started.length, 2);
  assert.equal(service.getSessionToolEvents('sess-a').length, 1);
  assert.equal(service.getSessionToolEvents('sess-b').length, 1);
  assert.equal(service.getSessionToolEvents('sess-a')[0]?.tool.name, 'read');
  assert.equal(service.getSessionToolEvents('sess-b')[0]?.tool.name, 'grep');
});

test('getSessionToolEvents：返回 { events } 透传读', () => {
  const { api } = makeApi();
  api.emitToolStarted('sess-1', 'evt-1', editTool());
  const result = api.getSessionToolEvents('sess-1');
  assert.deepEqual(Object.keys(result), ['events']);
  assert.equal(result.events.length, 1);
  assert.equal(result.events[0]?.toolEventId, 'evt-1');
});

test('tool/queryToolEvents：方法映射返回 { events }，sessionId 缺失返回 1001', () => {
  const { api } = makeApi();
  api.emitToolStarted('sess-1', 'evt-1', editTool());
  const result = api.methods['tool/queryToolEvents']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const events = (result.data as { events: unknown[] }).events;
    assert.equal(events.length, 1);
  }
  const bad = api.methods['tool/queryToolEvents']({});
  assert.equal(bad.code, 1001);
});

test('信封：tool/queryToolEvents 返回 { code, message, data }', () => {
  const { api } = makeApi();
  const result = api.methods['tool/queryToolEvents']({ sessionId: 'sess-1' });
  assert.deepEqual(Object.keys(result).sort(), ['code', 'data', 'message']);
});

test('createToolApi 工厂：内部新建服务，可注入事件汇', () => {
  const events = new EventEmitter();
  const api = createToolApi(events);
  const started: unknown[] = [];
  events.on('tool.started', (payload) => started.push(payload));
  const result = api.emitToolStarted('sess-1', 'evt-1', editTool());
  assert.deepEqual(result, { ok: true });
  assert.equal(started.length, 1);
  assert.equal(api.getSessionToolEvents('sess-1').events.length, 1);
});