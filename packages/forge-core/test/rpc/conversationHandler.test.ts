/**
 * 对话与消息 RPC 方法层（conversationMethods）单元测试。
 *
 * 覆盖 docs/test/03_conversation/coverage-matrix.md api 层用例：
 * - A-CV-001：sendMessage → code 0，adapter 调用正确，成功后发射 conversation.statusChanged
 * - A-CV-002：cancelStream → code 0，streaming 状态调用 adapter.cancelStream
 * - A-CV-003：queryHistory → 按 ts 升序返回消息列表
 * 以及本 WU 契约：参数校验 1001、provider 未配置 1004、会话不存在 1002、
 * 异常隔离 5000（不泄漏异常细节）、事件 conversation.statusChanged / conversation.delta /
 * conversation.message / conversation.error 发射、信封恒为 { code, message, data }。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；pi 会话操作经 MockConversationAdapter
 * 注入，事件经 EventEmitter 汇捕获。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ConversationService } from '../../src/conversation/conversationService.ts';
import { ConversationApi } from '../../src/rpc/conversationMethods.ts';
import type { PiConversationAdapter, ConversationMessage, SlashCommand } from '../../src/conversation/conversationService.ts';
import type { RpcResult } from '../../src/rpc/projectMethods.ts';

/** 可注入的 pi 会话适配器 mock：记录调用、可配置抛错 */
class MockConversationAdapter implements PiConversationAdapter {
  sendCalls: Array<{ sessionId: string; content: string }> = [];
  cancelCalls: string[] = [];
  history: ConversationMessage[] = [];
  /** 置为非 null 时 sendMessage 抛出该错误（模拟 pi 发送失败 → 5000） */
  sendError: Error | null = null;
  /** 置为非 null 时 cancelStream 抛出该错误（模拟取消失败 → 5000） */
  cancelError: Error | null = null;
  /** cancelStream 返回的被清空队列文本（CV-S09） */
  clearedOnCancel: string[] = [];
  /** 置为非 null 时 loadHistory 抛出该错误（模拟历史加载失败 → 5000） */
  loadError: Error | null = null;

  async sendMessage(sessionId: string, content: string): Promise<void> {
    this.sendCalls.push({ sessionId, content });
    if (this.sendError !== null) {
      throw this.sendError;
    }
  }

  async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    if (this.loadError !== null) {
      throw this.loadError;
    }
    return this.history;
  }

  async cancelStream(sessionId: string): Promise<string[]> {
    this.cancelCalls.push(sessionId);
    if (this.cancelError !== null) {
      throw this.cancelError;
    }
    return this.clearedOnCancel;
  }
}

/** 构造 api + 事件汇 + 服务 + mock adapter */
function makeApi(options: {
  sessionExists?: (sessionId: string) => boolean;
  providerReady?: () => boolean;
  slashCommandResources?: { listCommands(projectPath?: string): Promise<SlashCommand[]> };
} = {}): {
  api: ConversationApi;
  events: EventEmitter;
  service: ConversationService;
  adapter: MockConversationAdapter;
} {
  const adapter = new MockConversationAdapter();
  const service = new ConversationService(adapter, options);
  const events = new EventEmitter();
  const api = new ConversationApi(service, events);
  return { api, events, service, adapter };
}

test('A-CV-01：sendMessage 返回 0 + data null，adapter 调用正确', async () => {
  const { api, adapter } = makeApi();
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: '你好' });
  assert.equal(result.code, 0);
  assert.equal(result.data, null);
  assert.deepEqual(adapter.sendCalls, [{ sessionId: 'sess-1', content: '你好' }]);
});

test('conversation/sendMessage：成功后发射 conversation.statusChanged（streaming）', async () => {
  const { api, events } = makeApi();
  const changed: unknown[] = [];
  events.on('conversation.statusChanged', (payload) => changed.push(payload));
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' });
  assert.equal(result.code, 0);
  assert.equal(changed.length, 1, 'conversation.statusChanged 应发射一次');
  assert.deepEqual(changed[0], { sessionId: 'sess-1', status: 'streaming' });
});

test('conversation/sendMessage：content 为空/空白返回 1001，adapter 不被调用', async () => {
  const { api, adapter } = makeApi();
  assert.equal((await api.methods['conversation/sendMessage']({ sessionId: 'sess-1' })).code, 1001);
  assert.equal((await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: '   ' })).code, 1001);
  assert.equal((await api.methods['conversation/sendMessage']({ content: 'hi' })).code, 1001);
  assert.equal((await api.methods['conversation/sendMessage'](null)).code, 1001);
  assert.equal(adapter.sendCalls.length, 0);
});

test('conversation/sendMessage：provider 未配置返回 1004，adapter 不被调用', async () => {
  const { api, adapter } = makeApi({ providerReady: () => false });
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' });
  assert.equal(result.code, 1004);
  assert.equal(result.data, null);
  assert.equal(adapter.sendCalls.length, 0);
});

test('conversation/sendMessage：streaming 中发送 → 入队返 0，无状态变更事件（CV-S09）', async () => {
  const { api, service, adapter, events } = makeApi();
  service.setStatus('sess-1', 'streaming', { lastDeltaText: 'partial' });
  const changed: unknown[] = [];
  events.on('conversation.statusChanged', (payload) => changed.push(payload));

  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'queued' });

  assert.equal(result.code, 0);
  assert.equal(adapter.sendCalls.length, 1);
  assert.equal(changed.length, 0, '入队不触发状态事件（在途轮次不受影响）');
  assert.equal(service.getStatus('sess-1'), 'streaming');
});

test('conversation/sendMessage：会话不存在返回 1002，adapter 不被调用', async () => {
  const { api, adapter } = makeApi({ sessionExists: () => false });
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-ghost', content: 'hi' });
  assert.equal(result.code, 1002);
  assert.equal(result.data, null);
  assert.equal(adapter.sendCalls.length, 0);
});

test('A-CV-003：conversation/queryHistory 返回按 ts 升序的消息列表', async () => {
  const { api, adapter } = makeApi();
  adapter.history = [
    { role: 'assistant', content: 'b', ts: '2026-01-01T00:00:02Z' },
    { role: 'user', content: 'a', ts: '2026-01-01T00:00:01Z' },
  ];
  const result = await api.methods['conversation/queryHistory']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const messages = (result.data as { messages: ConversationMessage[] }).messages;
    assert.deepEqual(messages.map((m) => m.content), ['a', 'b'], '按 ts 升序');
    assert.deepEqual(messages.map((m) => m.role), ['user', 'assistant'], '角色保留');
  }
});

test('conversation/queryHistory：sessionId 缺失返回 1001', async () => {
  const { api } = makeApi();
  assert.equal((await api.methods['conversation/queryHistory']({})).code, 1001);
});

test('A-CV-002：conversation/cancelStream（streaming）返回 0 + clearedMessages，adapter 调用正确', async () => {
  const { api, service, adapter } = makeApi();
  service.setStatus('sess-1', 'streaming');
  adapter.clearedOnCancel = ['q1', 'q2'];
  const result = await api.methods['conversation/cancelStream']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.deepEqual((result.data as { clearedMessages: string[] }).clearedMessages, ['q1', 'q2']);
  assert.deepEqual(adapter.cancelCalls, ['sess-1']);
});

test('conversation/cancelStream：非 streaming 幂等成功，adapter 不被调用', async () => {
  const { api, adapter } = makeApi();
  const result = await api.methods['conversation/cancelStream']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0, '幂等：空闲取消无副作用');
  assert.equal(adapter.cancelCalls.length, 0);
});

test('conversation/cancelStream：sessionId 缺失返回 1001', async () => {
  const { api } = makeApi();
  assert.equal((await api.methods['conversation/cancelStream']({})).code, 1001);
});

test('异常隔离：adapter 抛错返回 5000，透传实际错误信息（便于定位 key/模型配置问题）', async () => {
  const { api, adapter } = makeApi();
  adapter.sendError = new Error('pi send failed');
  const result = await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' });
  assert.equal(result.code, 5000);
  assert.equal(result.data, null);
  assert.equal(result.message, 'pi send failed');
  assert.ok(result.message.includes('pi send failed'));
});

test('异常隔离：queryHistory adapter 抛错返回 5000，data null', async () => {
  const { api, adapter } = makeApi();
  adapter.loadError = new Error('load failed');
  const result = await api.methods['conversation/queryHistory']({ sessionId: 'sess-1' });
  assert.equal(result.code, 5000);
  assert.equal(result.data, null);
});

test('事件：pushStatus 发射 conversation.statusChanged（sessionId/status）', async () => {
  const { api, events } = makeApi();
  const changed: unknown[] = [];
  events.on('conversation.statusChanged', (payload) => changed.push(payload));
  api.pushStatus('sess-1', 'streaming');
  assert.equal(changed.length, 1, 'conversation.statusChanged 应发射一次');
  assert.deepEqual(changed[0], { sessionId: 'sess-1', status: 'streaming' });
});

test('事件：pushDelta 发射 conversation.delta（sessionId/delta）', async () => {
  const { api, events } = makeApi();
  const deltas: unknown[] = [];
  events.on('conversation.delta', (payload) => deltas.push(payload));
  api.pushDelta('sess-1', '修');
  assert.equal(deltas.length, 1, 'conversation.delta 应发射一次');
  assert.deepEqual(deltas[0], { sessionId: 'sess-1', delta: { text: '修', kind: 'text' } });
});

test('事件：emitMessage 发射 conversation.message（sessionId/message）', async () => {
  const { api, events } = makeApi();
  const messages: unknown[] = [];
  events.on('conversation.message', (payload) => messages.push(payload));
  api.emitMessage('sess-1', { role: 'assistant', content: 'hi', ts: '2026-01-01T00:00:00Z' });
  assert.equal(messages.length, 1, 'conversation.message 应发射一次');
  assert.deepEqual(messages[0], {
    sessionId: 'sess-1',
    message: { role: 'assistant', content: 'hi', ts: '2026-01-01T00:00:00Z' },
  });
});

test('事件：emitError 发射 conversation.error（sessionId/code/message）', async () => {
  const { api, events } = makeApi();
  const errors: unknown[] = [];
  events.on('conversation.error', (payload) => errors.push(payload));
  api.emitError('sess-1', 5000, 'stream interrupted');
  assert.equal(errors.length, 1, 'conversation.error 应发射一次');
  assert.deepEqual(errors[0], { sessionId: 'sess-1', code: 5000, message: 'stream interrupted' });
});

test('信封：所有方法返回 { code, message, data }', async () => {
  const { api } = makeApi();
  const results: RpcResult[] = [];
  results.push(await api.methods['conversation/sendMessage']({ sessionId: 'sess-1', content: 'hi' }));
  results.push(await api.methods['conversation/cancelStream']({ sessionId: 'sess-1' }));
  results.push(await api.methods['conversation/queryHistory']({ sessionId: 'sess-1' }));
  results.push(await api.methods['conversation/sendMessage']({}));
  results.push(await api.methods['conversation/queryHistory']({}));
  for (const r of results) {
    assert.deepEqual(Object.keys(r).sort(), ['code', 'data', 'message'], '信封恒为 { code, message, data }');
  }
});

test('conversation/sendMessage：附件统一给路径，不再读取 params.attachments 拼接片段', async () => {
  const { api, adapter } = makeApi();
  const result = await api.methods['conversation/sendMessage']({
    sessionId: 'sess-1',
    content: '读一下\nC:\\repo\\readme.md',
    attachments: [
      { kind: 'text', name: 'readme.md', content: '项目说明' },
      { kind: 'image', name: 'pic.png', mimeType: 'image/png', data: 'YWJj' },
    ],
  });
  assert.equal(result.code, 0);
  assert.equal(adapter.sendCalls.length, 1);
  const call0 = adapter.sendCalls[0]!;
  // 路径行已是消息文本的一部分：content 原样透传，不追加任何受控片段
  assert.equal(call0.content, '读一下\nC:\\repo\\readme.md');
});

// ===== conversation/getLastError：红点会话切回后的错误横幅数据源 =====

test('conversation/getLastError：返回服务层记录的最近错误消息', async () => {
  const { api, service } = makeApi();
  service.setStatus('sess-1', 'error', { lastError: '模型额度耗尽（429）：请检查账户额度' });
  const result = await api.methods['conversation/getLastError']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, { message: '模型额度耗尽（429）：请检查账户额度' });
});

test('conversation/getLastError：无错误记录返回 message null（不报错）', async () => {
  const { api } = makeApi();
  const result = await api.methods['conversation/getLastError']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.deepEqual(result.data, { message: null });
});

test('conversation/getLastError：sessionId 缺失返回 1001', async () => {
  const { api } = makeApi();
  const result = await api.methods['conversation/getLastError']({});
  assert.equal(result.code, 1001);
});

// ===== 扩展 CV-S08：斜杠命令清单（docs/api/03_conversation.md §9） =====

/** 斜杠命令资源查询 port mock（rpc 层注入用）：记录 projectPath、可配置抛错 */
class MockSlashResources {
  calls: Array<string | undefined> = [];
  /** 轻量查询返回 skills+模板（无扩展命令，模拟 port 契约） */
  commands: SlashCommand[] = [
    { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
    { name: 'write-tests', description: null, source: 'prompt' },
  ];
  error: Error | null = null;

  async listCommands(projectPath?: string): Promise<SlashCommand[]> {
    this.calls.push(projectPath);
    if (this.error !== null) {
      throw this.error;
    }
    return this.commands;
  }
}

test('A-CV-011：conversation/getSlashCommands 会话模式缓存命中返回三类全量清单（source 枚举/description null/信封）', async () => {
  const resources = new MockSlashResources();
  const { api, service } = makeApi({ sessionExists: () => true, slashCommandResources: resources });
  service.ingestReportedCommands('sess-1', [
    { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
    { name: 'review-pr', description: '审查拉取请求', source: 'extension' },
    { name: 'write-tests', description: null, source: 'prompt' },
  ]);
  const result = await api.methods['conversation/getSlashCommands']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.deepEqual(Object.keys(result).sort(), ['code', 'data', 'message'], '信封恒为 { code, message, data }');
  assert.ok(result.data !== null);
  if (result.data !== null) {
    assert.deepEqual((result.data as { commands: SlashCommand[] }).commands, [
      { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
      { name: 'review-pr', description: '审查拉取请求', source: 'extension' },
      { name: 'write-tests', description: null, source: 'prompt' },
    ]);
  }
  assert.equal(resources.calls.length, 0, '缓存命中不触发降级查询');
});

test('A-CV-011：会话模式上报未到降级轻量查询（skills+模板），code 0 不报错', async () => {
  const resources = new MockSlashResources();
  const { api } = makeApi({ sessionExists: () => true, slashCommandResources: resources });
  const result = await api.methods['conversation/getSlashCommands']({ sessionId: 'sess-1' });
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    assert.deepEqual((result.data as { commands: SlashCommand[] }).commands, resources.commands);
  }
  assert.deepEqual(resources.calls, [undefined]);
});

test('A-CV-011：未知会话 1002 / sessionId 非字符串 1001（信封 data=null）', async () => {
  const { api } = makeApi({ sessionExists: () => false });
  const unknown = await api.methods['conversation/getSlashCommands']({ sessionId: 'sess-ghost' });
  assert.equal(unknown.code, 1002);
  assert.equal(unknown.data, null);
  const badType = await api.methods['conversation/getSlashCommands']({ sessionId: 123 });
  assert.equal(badType.code, 1001);
  assert.equal(badType.data, null);
});

test('A-CV-012：草稿态 {} 与 { projectPath } port 直查，projectPath 透传，不含 extension', async () => {
  const resources = new MockSlashResources();
  const { api } = makeApi({ slashCommandResources: resources });
  const empty = await api.methods['conversation/getSlashCommands']({});
  assert.equal(empty.code, 0);
  assert.ok(empty.data !== null);
  if (empty.data !== null) {
    const commands = (empty.data as { commands: SlashCommand[] }).commands;
    assert.deepEqual(commands, resources.commands);
    assert.equal(commands.some((c) => c.source === 'extension'), false, '草稿态无扩展命令');
  }
  const withPath = await api.methods['conversation/getSlashCommands']({ projectPath: 'C:\\repo\\demo' });
  assert.equal(withPath.code, 0);
  assert.deepEqual(resources.calls, [undefined, 'C:\\repo\\demo'], 'projectPath 原样透传');
});

test('A-CV-033：port 抛错返回 code 0 + commands: []（非 5000，输入不受阻塞）', async () => {
  const resources = new MockSlashResources();
  resources.error = new Error('scan failed');
  const { api } = makeApi({ slashCommandResources: resources });
  const result = await api.methods['conversation/getSlashCommands']({});
  assert.equal(result.code, 0, '枚举失败降级为空清单而非 5000');
  assert.ok(result.data !== null);
  if (result.data !== null) {
    assert.deepEqual((result.data as { commands: SlashCommand[] }).commands, []);
  }
});

test('A-CV-033：port 未注入返回 code 0 + commands: []', async () => {
  const { api } = makeApi({});
  const result = await api.methods['conversation/getSlashCommands']({});
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    assert.deepEqual((result.data as { commands: SlashCommand[] }).commands, []);
  }
});

test('A-CV-013：emitSlashCommandsUpdated 载荷恰好 { sessionId }，发射一次', async () => {
  const { api, events } = makeApi();
  const updated: unknown[] = [];
  events.on('conversation.slashCommandsUpdated', (payload) => updated.push(payload));
  api.emitSlashCommandsUpdated('sess-1');
  assert.equal(updated.length, 1, '事件恰好发射一次');
  assert.deepEqual(updated[0], { sessionId: 'sess-1' }, '载荷恰好 { sessionId }');
});

test('A-CV-013：桥接上报更新缓存并转发事件；重复上报幂等覆盖；未注册会话不崩不泄漏', async () => {
  const resources = new MockSlashResources();
  const { api, service, events } = makeApi({
    sessionExists: (id) => id === 'sess-1',
    slashCommandResources: resources,
  });
  const updated: unknown[] = [];
  events.on('conversation.slashCommandsUpdated', (payload) => updated.push(payload));

  // 首次上报（会话激活后）：更新缓存 + 转发事件（各恰好一次）
  const first: SlashCommand[] = [{ name: 'review-pr', description: '审查拉取请求', source: 'extension' }];
  service.ingestReportedCommands('sess-1', first);
  api.emitSlashCommandsUpdated('sess-1');
  assert.equal(updated.length, 1);
  const afterFirst = await api.methods['conversation/getSlashCommands']({ sessionId: 'sess-1' });
  assert.equal(afterFirst.code, 0);
  assert.ok(afterFirst.data !== null);
  if (afterFirst.data !== null) {
    assert.deepEqual((afterFirst.data as { commands: SlashCommand[] }).commands, first);
  }

  // 重复上报：幂等覆盖缓存，事件再发射一次（共两次）
  const second: SlashCommand[] = [{ name: 'review-pr', description: '审查 PR（更新）', source: 'extension' }];
  service.ingestReportedCommands('sess-1', second);
  api.emitSlashCommandsUpdated('sess-1');
  assert.equal(updated.length, 2);
  const afterSecond = await api.methods['conversation/getSlashCommands']({ sessionId: 'sess-1' });
  assert.equal(afterSecond.code, 0);
  assert.ok(afterSecond.data !== null);
  if (afterSecond.data !== null) {
    assert.deepEqual((afterSecond.data as { commands: SlashCommand[] }).commands, second, '重复上报幂等覆盖缓存');
  }

  // 未注册会话的上报：静默忽略不崩、不写缓存（查询仍 1002，不泄漏）
  assert.doesNotThrow(() => service.ingestReportedCommands('sess-ghost', first));
  assert.equal(updated.length, 2, '未注册会话上报不产生额外事件');
  const ghost = await api.methods['conversation/getSlashCommands']({ sessionId: 'sess-ghost' });
  assert.equal(ghost.code, 1002, '未注册会话无缓存泄漏');
});
