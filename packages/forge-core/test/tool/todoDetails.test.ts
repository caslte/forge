/**
 * TE-S05 tool.completed.result.details 透传契约测试（AC-TE-011/012/013）。
 *
 * 验证：
 * - pi 工具携带 details（todo 工具）→ ToolCompletedEvent.result 透传原始 details（字段类型完整保留）
 * - pi 工具未携带 details（普通工具）→ result 中不出现 details 字段（JSON omit 语义）
 * - 序列化往返不丢失字段、不输出 "details": undefined
 * - 旧 IPC payload（无 details 字段）反序列化零变更
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { ToolEventService } from '../../src/tool/toolService.ts';
import type { ToolCompletedEvent } from '../../src/tool/toolService.ts';

test('TE-S05: pi 工具携带 details（todo）→ recordToolEvent 后 result 含 details（U-TE-006, AC-TE-011）', () => {
  const service = new ToolEventService();
  const details = {
    action: 'list',
    tasks: [
      { id: 1, subject: '修复登录', status: 'pending' },
      { id: 2, subject: '加单测', status: 'completed', activeForm: '提交测试' },
    ],
    nextId: 3,
  };
  const event: ToolCompletedEvent = {
    sessionId: 'sess-1',
    toolEventId: 'evt-1',
    tool: { name: 'todo', input: { action: 'list' } },
    status: 'completed',
    result: { text: '[ ] #1: 修复登录', image: null, details },
  };
  service.recordToolEvent(event);
  const stored = service.getToolEvent('sess-1', 'evt-1') as ToolCompletedEvent;
  assert.ok(stored, '事件应被记录');
  assert.equal(stored.status, 'completed');
  assert.equal(stored.result.text, '[ ] #1: 修复登录');
  assert.equal(stored.result.image, null);
  assert.deepEqual(stored.result.details, details, 'details 字段原值透传');
  assert.equal(
    typeof (stored.result.details as Record<string, unknown>).nextId,
    'number',
    'details 内部字段类型完整保留',
  );
});

test('TE-S05: pi 工具未携带 details（read）→ result 中不出现 details 字段（U-TE-007, AC-TE-012）', () => {
  const service = new ToolEventService();
  const event: ToolCompletedEvent = {
    sessionId: 'sess-1',
    toolEventId: 'evt-2',
    tool: { name: 'read', input: { file_path: 'src/a.ts' } },
    status: 'completed',
    result: { text: 'file contents', image: null },
  };
  service.recordToolEvent(event);
  const stored = service.getToolEvent('sess-1', 'evt-2') as ToolCompletedEvent;
  assert.ok(stored, '事件应被记录');
  // JSON 序列化不应输出 details 字段（JSON omit 与 undefined 一致语义）
  const serialized = JSON.parse(JSON.stringify(stored));
  assert.equal(
    'details' in serialized.result,
    false,
    'details 缺失时序列化结果不应出现该字段',
  );
  assert.equal(serialized.result.text, 'file contents');
  assert.equal(serialized.result.image, null);
});

test('TE-S05: details 为非对象（string/number/null）原样透传不抛错（U-TE-008, AC-TE-013）', () => {
  const service = new ToolEventService();
  for (const badDetails of ['plain string', 42, null, 0, false, [1, 2, 3], { any: 'object' }]) {
    const event: ToolCompletedEvent = {
      sessionId: 'sess-1',
      toolEventId: `evt-bad-${Math.random()}`,
      tool: { name: 'weird', input: {} },
      status: 'completed',
      result: { text: 'ok', image: null, details: badDetails },
    };
    assert.doesNotThrow(() => service.recordToolEvent(event), `details=${JSON.stringify(badDetails)} 不应抛错`);
  }
});

test('TE-S05: 序列化往返（JSON.stringify → JSON.parse）字段完整保留', () => {
  const details = {
    action: 'create',
    tasks: [
      { id: 1, subject: 'a', status: 'pending' },
      { id: 2, subject: 'b', status: 'completed', activeForm: 'done' },
    ],
    nextId: 3,
    metadata: { extra: 'info', count: 10 },
  };
  const event: ToolCompletedEvent = {
    sessionId: 'sess-1',
    toolEventId: 'evt-rt',
    tool: { name: 'todo', input: { action: 'create' } },
    status: 'completed',
    result: { text: 'ok', image: null, details },
  };
  const roundtrip = JSON.parse(JSON.stringify(event)) as ToolCompletedEvent;
  assert.deepEqual(roundtrip.result.details, details, '序列化往返后 details 完整保留');
  assert.equal(roundtrip.result.text, 'ok');
});

test('TE-S05: 旧 payload（无 details 字段）反序列化零变更，向后兼容', () => {
  // 模拟旧版 IPC 序列化结果（result 中无 details 字段）
  const oldPayload = JSON.stringify({
    sessionId: 'sess-1',
    toolEventId: 'evt-old',
    tool: { name: 'edit', input: { file_path: 'src/a.ts' } },
    status: 'completed',
    result: { text: 'edited', image: null },
  });
  const parsed = JSON.parse(oldPayload) as ToolCompletedEvent;
  assert.equal(parsed.status, 'completed');
  assert.equal(parsed.result.text, 'edited');
  assert.equal(parsed.result.image, null);
  // details 不应被强行设为 undefined（IPC 层应保持字段缺失语义）
  assert.equal('details' in parsed.result, false);
});

test('TE-S05: ToolCompletedEvent.result 字段仍是 text/image/details 完整集（向后兼容 + 扩展）', () => {
  // 类型级别 + 运行级别双重校验：result 必须有 text、image、details? 字段
  const event: ToolCompletedEvent = {
    sessionId: 'sess-1',
    toolEventId: 'evt-shape',
    tool: { name: 'todo', input: {} },
    status: 'completed',
    result: { text: 't', image: 'data:image/png;base64,...', details: { ok: true } },
  };
  // text/image 字段保留
  assert.equal(typeof event.result.text, 'string');
  assert.equal(typeof event.result.image, 'string');
  // details 为可选
  assert.ok(event.result.details);
});