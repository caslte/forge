/**
 * 对话与消息服务（conversationService）单元测试。
 *
 * 覆盖 docs/test/03_conversation/coverage-matrix.md 本 WU 用例：
 * - U-CV-001：sendMessage 空/空白消息校验失败，不触发 adapter（AC-CV-002）
 * - A-CV-001：发送成功进入 streaming，adapter.sendMessage 调用一次（AC-CV-001）
 * - A-CV-002：provider 未配置返回 1004，不崩溃（AC-CV-003）
 * - A-CV-005：取消保留已生成内容、重复取消幂等（AC-CV-009/010）
 * - A-CV-006：历史全量加载、角色区分、顺序正确（AC-CV-011/012）
 * 以及本 WU 契约：会话不存在 1002、adapter 异常 5000 错误联合、多会话状态隔离。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；pi 会话操作经 MockPiConversationAdapter
 * 注入（服务不 import pi）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConversationService } from '../../src/conversation/conversationService.ts';
import type {
  ConversationMessage,
  ConversationRuntimeOptions,
  ConversationServiceOptions,
  ConversationStatus,
  PiConversationAdapter,
  SlashCommand,
} from '../../src/conversation/conversationService.ts';

/** 可注入的 pi 会话适配器 mock：记录调用、可配置历史与抛错 */
class MockPiConversationAdapter implements PiConversationAdapter {
  sendCalls: Array<{ sessionId: string; content: string }> = [];
  /** 记录 sendMessage 的 options（多模态门控断言用） */
  sendOptions: Array<ConversationRuntimeOptions | undefined> = [];
  cancelCalls: string[] = [];
  /** 会话历史（sessionId -> 消息列表），未设置返回空 */
  history: Map<string, ConversationMessage[]> = new Map();
  /** 置为非 null 时 loadHistory 抛出该异常（模拟历史加载失败） */
  loadError: Error | null = null;

  async sendMessage(sessionId: string, content: string, options?: ConversationRuntimeOptions): Promise<void> {
    this.sendCalls.push({ sessionId, content });
    this.sendOptions.push(options);
  }

  async loadHistory(sessionId: string): Promise<ConversationMessage[]> {
    if (this.loadError !== null) {
      throw this.loadError;
    }
    return this.history.get(sessionId) ?? [];
  }

  async cancelStream(sessionId: string): Promise<void> {
    this.cancelCalls.push(sessionId);
  }
}

/** 构造服务 + mock adapter（可选注入构造选项） */
function makeService(
  options?: ConversationServiceOptions,
): { service: ConversationService; adapter: MockPiConversationAdapter } {
  const adapter = new MockPiConversationAdapter();
  return { service: new ConversationService(adapter, options), adapter };
}

test('sendMessage：空/纯空白消息返回 1001，adapter 不被调用（U-CV-001/AC-CV-002）', async () => {
  const { service, adapter } = makeService();
  for (const content of ['', '   ', '\t\n']) {
    const result = await service.sendMessage('sess-1', content);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
      assert.equal(result.message, '消息不能为空');
    }
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('sendMessage：会话不存在返回 1002，adapter 不被调用', async () => {
  const { service, adapter } = makeService({ sessionExists: (id) => id === 'sess-known' });
  const result = await service.sendMessage('sess-unknown', 'hi');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1002);
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('sendMessage：provider 未配置返回 1004，adapter 不被调用（A-CV-002/AC-CV-003）', async () => {
  const { service, adapter } = makeService({ providerReady: () => false });
  const result = await service.sendMessage('sess-1', 'hi');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1004);
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('sendMessage：未注入 sessionExists/providerReady 时跳过校验', async () => {
  const { service, adapter } = makeService();
  const result = await service.sendMessage('sess-any', 'hi');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-any'), 'streaming');
  assert.equal(adapter.sendCalls.length, 1);
});

test('sendMessage：成功进入 streaming，adapter.sendMessage 调用一次（A-CV-001/AC-CV-001）', async () => {
  const { service, adapter } = makeService({ sessionExists: () => true, providerReady: () => true });
  const result = await service.sendMessage('sess-1', 'hi');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-1'), 'streaming');
  assert.deepEqual(adapter.sendCalls, [{ sessionId: 'sess-1', content: 'hi' }]);
});

test('sendMessage：streaming 中重复发送返回 1001，adapter 不被调用', async () => {
  const { service, adapter } = makeService();
  service.setStatus('sess-1', 'streaming', { lastDeltaText: 'partial' });

  const result = await service.sendMessage('sess-1', 'again');

  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1001);
    assert.match(result.message, /正在流式响应/);
  }
  assert.equal(adapter.sendCalls.length, 0);
});

test('cancelStream：streaming 中取消 -> canceled，adapter 调用，已生成内容保留（A-CV-005/AC-CV-009）', async () => {
  const { service, adapter } = makeService();
  service.setStatus('sess-1', 'streaming', { lastDeltaText: 'partial reply' });
  const result = await service.cancelStream('sess-1');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-1'), 'canceled');
  assert.deepEqual(adapter.cancelCalls, ['sess-1']);
  assert.equal(service.getStreamState('sess-1').lastDeltaText, 'partial reply');
});

test('cancelStream：重复取消幂等，adapter 只调用一次（AC-CV-009 幂等）', async () => {
  const { service, adapter } = makeService();
  service.setStatus('sess-1', 'streaming');
  await service.cancelStream('sess-1');
  await service.cancelStream('sess-1');
  await service.cancelStream('sess-1');
  assert.equal(service.getStatus('sess-1'), 'canceled');
  assert.deepEqual(adapter.cancelCalls, ['sess-1']);
});

test('cancelStream：idle 状态取消为无副作用成功', async () => {
  const { service, adapter } = makeService();
  const result = await service.cancelStream('sess-1');
  assert.ok(result.ok);
  assert.equal(service.getStatus('sess-1'), 'idle');
  assert.equal(adapter.cancelCalls.length, 0);
});

test('queryHistory：全量加载并按 ts 升序，角色保留（A-CV-006/AC-CV-011/012）', async () => {
  const { service, adapter } = makeService();
  adapter.history.set('sess-1', [
    { role: 'assistant', content: 'b', ts: '2026-01-01T00:00:02.000Z' },
    { role: 'user', content: 'a', ts: '2026-01-01T00:00:01.000Z' },
    { role: 'tool', content: 'c', ts: '2026-01-01T00:00:03.000Z' },
  ]);
  const result = await service.queryHistory('sess-1');
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(
      result.data.messages.map((m) => m.role),
      ['user', 'assistant', 'tool'],
    );
    assert.deepEqual(
      result.data.messages.map((m) => m.content),
      ['a', 'b', 'c'],
    );
  }
});

test('queryHistory：adapter 抛错返回 5000 错误联合，不崩溃', async () => {
  const { service, adapter } = makeService();
  adapter.loadError = new Error('jsonl read failed');
  const result = await service.queryHistory('sess-1');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 5000);
  }
});

test('onStatusChange：状态流转触发注入回调（rpc 接线注入点）', async () => {
  const changes: Array<{ sessionId: string; status: ConversationStatus }> = [];
  const { service } = makeService({
    onStatusChange: (sessionId, status) => {
      changes.push({ sessionId, status });
    },
  });
  await service.sendMessage('sess-1', 'hi');
  await service.cancelStream('sess-1');
  assert.deepEqual(changes, [
    { sessionId: 'sess-1', status: 'streaming' },
    { sessionId: 'sess-1', status: 'canceled' },
  ]);
});

test('多会话独立：10 会话交错状态流转互不干扰（状态隔离）', async () => {
  const { service, adapter } = makeService();
  const ids = Array.from({ length: 10 }, (_, i) => `sess-${i}`);
  for (const id of ids) {
    service.setStatus(id, 'streaming', { lastDeltaText: `partial-${id}` });
  }
  const toCancel = ids.filter((_, i) => i % 2 === 0);
  for (const id of toCancel) {
    await service.cancelStream(id);
  }
  for (const [i, id] of ids.entries()) {
    assert.equal(service.getStatus(id), i % 2 === 0 ? 'canceled' : 'streaming');
  }
  // 已取消会话保留各自累积内容，未取消会话内容不受影响
  assert.equal(service.getStreamState('sess-0').lastDeltaText, 'partial-sess-0');
  assert.equal(service.getStreamState('sess-1').lastDeltaText, 'partial-sess-1');
  assert.equal(service.getStreamState('sess-9').lastDeltaText, 'partial-sess-9');
  assert.deepEqual(adapter.cancelCalls, ['sess-0', 'sess-2', 'sess-4', 'sess-6', 'sess-8']);
});

// ===== 附件统一给路径：多模态门控机制移除 =====

test('附件门控移除：残留 attachments/modelSupportsImages 选项不影响发送，content 原样、data=null', async () => {
  const { service, adapter } = makeService({
    sessionExists: () => true,
    providerReady: () => true,
    resolveSendOptions: () => Promise.resolve({ cwd: undefined }),
    // 已删除的门控端口：以残留键传入，验证发送链路完全无视它
    modelSupportsImages: async () => false,
  } as ConversationServiceOptions);
  const result = await service.sendMessage('sess-1', '看下这张图\nC:\\repo\\a.png', {
    model: 'plain',
    attachments: [{ kind: 'image', name: 'a.png', mimeType: 'image/png', data: 'AAAA' }],
  } as ConversationRuntimeOptions);
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.data, null, 'skippedImages 机制已移除，恒返回 data=null');
  }
  assert.equal(adapter.sendCalls[0]?.content, '看下这张图\nC:\\repo\\a.png', '内容原样透传，不追加门控说明');
});

test('附件门控移除：纯文字发送行为不变', async () => {
  const { service, adapter } = makeService({
    sessionExists: () => true,
    providerReady: () => true,
    modelSupportsImages: async () => false,
  } as ConversationServiceOptions);
  const result = await service.sendMessage('sess-1', '纯文字', { model: 'plain' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.data, null);
  }
  assert.equal(adapter.sendCalls[0]?.content, '纯文字', '无附件时内容不追加说明');
});

// ===== P3-A：上下文用量与压缩 =====

test('getContextUsage：adapter 支持时返回用量，未支持时返回 null 数据（P3-A）', async () => {
  // 未实现 getContextUsage 的 adapter → null（UI 显示未知，不算错误）
  const { service } = makeService({ sessionExists: () => true });
  const none = await service.getContextUsage('sess-x');
  assert.ok(none.ok);
  assert.equal(none.data?.usage, null);

  // 实现 getContextUsage 的 adapter → 透传用量
  const usageAdapter = new MockPiConversationAdapter();
  usageAdapter.getContextUsage = () => ({ tokens: 4200, contextWindow: 128000, percent: 3.3 });
  const svc = new ConversationService(usageAdapter, { sessionExists: () => true });
  const res = await svc.getContextUsage('sess-x');
  assert.ok(res.ok);
  assert.equal(res.data?.usage?.tokens, 4200);
  assert.equal(res.data?.usage?.percent, 3.3);
});

test('getContextUsage：空参数 1001 / 会话不存在 1002', async () => {
  const { service } = makeService({ sessionExists: (id) => id === 'sess-known' });
  const empty = await service.getContextUsage('');
  assert.equal(empty.ok, false);
  if (!empty.ok) assert.equal(empty.code, 1001);
  const unknown = await service.getContextUsage('ghost');
  assert.equal(unknown.ok, false);
  if (!unknown.ok) assert.equal(unknown.code, 1002);
});

test('compact：adapter 支持时返回结果，不支持时明确失败不破坏历史（P3-A）', async () => {
  const { service } = makeService({ sessionExists: () => true });
  const unsupported = await service.compact('sess-x');
  assert.ok(unsupported.ok);
  assert.equal(unsupported.data?.result.ok, false);

  const compactAdapter = new MockPiConversationAdapter();
  compactAdapter.compact = async () => ({ ok: true, message: '压缩完成' });
  const svc = new ConversationService(compactAdapter, { sessionExists: () => true });
  const res = await svc.compact('sess-x');
  assert.ok(res.ok);
  assert.equal(res.data?.result.ok, true);
  assert.equal(res.data?.result.message, '压缩完成');
});

test('compact：压缩异常返回失败信息且不抛出（P3-A 手动压缩失败不破坏历史）', async () => {
  const failAdapter = new MockPiConversationAdapter();
  failAdapter.compact = async () => {
    throw new Error('provider 超时');
  };
  const svc = new ConversationService(failAdapter, { sessionExists: () => true });
  const res = await svc.compact('sess-x');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.code, 5000);
    assert.match(res.message, /压缩失败/);
  }
});

// ===== 扩展 CV-S08：斜杠命令清单（docs/api/03_conversation.md §9） =====

/** 斜杠命令资源查询 port mock：记录 projectPath 调用、可配置返回清单/抛错 */
class MockSlashCommandResources {
  /** 每次 listCommands 收到的 projectPath（草稿态透传断言用） */
  calls: Array<string | undefined> = [];
  /** 返回的命令清单（skills+模板两类，模拟轻量查询契约） */
  commands: SlashCommand[] = [
    { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
    { name: 'write-tests', description: '生成测试用例', source: 'prompt' },
  ];
  /** 置为非 null 时 listCommands 抛出该异常（模拟枚举失败降级） */
  error: Error | null = null;

  async listCommands(projectPath?: string): Promise<SlashCommand[]> {
    this.calls.push(projectPath);
    if (this.error !== null) {
      throw this.error;
    }
    return this.commands;
  }
}

/** 构造带斜杠命令资源 port 的服务 */
function makeSlashService(options: {
  sessionExists?: (sessionId: string) => boolean;
  resources?: MockSlashCommandResources;
}): { service: ConversationService; resources: MockSlashCommandResources } {
  const resources = options.resources ?? new MockSlashCommandResources();
  const service = new ConversationService(new MockPiConversationAdapter(), {
    sessionExists: options.sessionExists,
    slashCommandResources: resources,
  });
  return { service, resources };
}

/** 命令上报 fixture：三类全量（含 description 缺失归一项） */
const reportedThreeKinds: SlashCommand[] = [
  { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
  { name: 'review-pr', description: '审查拉取请求', source: 'extension' },
  { name: 'no-desc', description: null, source: 'prompt' },
];

test('getSlashCommands：会话模式缓存命中返回三类全量清单，不触发 port（A-CV-011）', async () => {
  const { service, resources } = makeSlashService({ sessionExists: () => true });
  service.ingestReportedCommands('sess-1', reportedThreeKinds);
  const result = await service.getSlashCommands({ sessionId: 'sess-1' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.data.commands, reportedThreeKinds);
  }
  assert.equal(resources.calls.length, 0, '缓存命中不走降级查询');
});

test('getSlashCommands：上报未到降级轻量查询（skills+模板），不报错（A-CV-011）', async () => {
  const { service, resources } = makeSlashService({ sessionExists: () => true });
  const result = await service.getSlashCommands({ sessionId: 'sess-1' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.data.commands, resources.commands);
  }
  assert.deepEqual(resources.calls, [undefined]);
});

test('getSlashCommands：未知会话返回 1002，不触发 port（A-CV-011）', async () => {
  const { service, resources } = makeSlashService({ sessionExists: (id) => id === 'sess-known' });
  const result = await service.getSlashCommands({ sessionId: 'sess-ghost' });
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1002);
  }
  assert.equal(resources.calls.length, 0);
});

test('getSlashCommands：sessionId/projectPath 非法类型返回 1001（A-CV-011）', async () => {
  const { service } = makeSlashService({ sessionExists: () => true });
  const badSession = await service.getSlashCommands({ sessionId: 123 as unknown as string });
  assert.ok(!badSession.ok);
  if (!badSession.ok) assert.equal(badSession.code, 1001);
  const badProject = await service.getSlashCommands({ projectPath: 42 as unknown as string });
  assert.ok(!badProject.ok);
  if (!badProject.ok) assert.equal(badProject.code, 1001);
});

test('getSlashCommands：草稿态（省略 sessionId）port 直查，projectPath 透传（A-CV-012）', async () => {
  const { service, resources } = makeSlashService({});
  const noPath = await service.getSlashCommands({});
  assert.ok(noPath.ok);
  if (noPath.ok) {
    assert.deepEqual(noPath.data.commands, resources.commands);
  }
  assert.deepEqual(resources.calls, [undefined]);
  const withPath = await service.getSlashCommands({ projectPath: 'C:\\repo\\demo' });
  assert.ok(withPath.ok);
  assert.deepEqual(resources.calls, [undefined, 'C:\\repo\\demo'], 'projectPath 原样透传给 port');
});

test('getSlashCommands：port 未注入返回空清单不报错（A-CV-033）', async () => {
  const service = new ConversationService(new MockPiConversationAdapter(), { sessionExists: () => true });
  const sessionMode = await service.getSlashCommands({ sessionId: 'sess-1' });
  assert.ok(sessionMode.ok);
  if (sessionMode.ok) assert.deepEqual(sessionMode.data.commands, []);
  const draftMode = await service.getSlashCommands({});
  assert.ok(draftMode.ok);
  if (draftMode.ok) assert.deepEqual(draftMode.data.commands, []);
});

test('getSlashCommands：port 抛错返回空清单不报错（A-CV-033 枚举失败降级）', async () => {
  const resources = new MockSlashCommandResources();
  resources.error = new Error('resource scan failed');
  const { service } = makeSlashService({ sessionExists: () => true, resources });
  const sessionMode = await service.getSlashCommands({ sessionId: 'sess-1' });
  assert.ok(sessionMode.ok);
  if (sessionMode.ok) assert.deepEqual(sessionMode.data.commands, []);
  const draftMode = await service.getSlashCommands({});
  assert.ok(draftMode.ok);
  if (draftMode.ok) assert.deepEqual(draftMode.data.commands, []);
});

test('ingestReportedCommands：幂等覆盖，重复上报后缓存为最新清单（A-CV-013）', async () => {
  const { service } = makeSlashService({ sessionExists: () => true });
  service.ingestReportedCommands('sess-1', reportedThreeKinds);
  const second: SlashCommand[] = [{ name: 'skill:new-cmd', description: '第二次上报', source: 'skill' }];
  service.ingestReportedCommands('sess-1', second);
  const result = await service.getSlashCommands({ sessionId: 'sess-1' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.data.commands, second, '后一次上报覆盖前一次');
  }
});

test('ingestReportedCommands：未注册会话静默忽略不抛错（A-CV-013）', async () => {
  const { service } = makeSlashService({ sessionExists: (id) => id === 'sess-1' });
  assert.doesNotThrow(() => service.ingestReportedCommands('sess-ghost', reportedThreeKinds));
  // 被忽略的上报不产生缓存：ghost 会话查询仍走 1002 未知会话路径
  const result = await service.getSlashCommands({ sessionId: 'sess-ghost' });
  assert.ok(!result.ok);
  if (!result.ok) assert.equal(result.code, 1002);
});

test('ingestReportedCommands：description 缺失归一为 null 非 undefined（A-CV-011）', async () => {
  const { service } = makeSlashService({ sessionExists: () => true });
  service.ingestReportedCommands('sess-1', [
    { name: 'no-desc', description: undefined as unknown as null, source: 'prompt' },
  ]);
  const result = await service.getSlashCommands({ sessionId: 'sess-1' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.data.commands, [{ name: 'no-desc', description: null, source: 'prompt' }]);
  }
});

test('clearSessionCommands：会话删除清理缓存，之后降级回 port 查询（desktop 层接线）', async () => {
  const { service, resources } = makeSlashService({ sessionExists: () => true });
  service.ingestReportedCommands('sess-1', reportedThreeKinds);
  service.clearSessionCommands('sess-1');
  const result = await service.getSlashCommands({ sessionId: 'sess-1' });
  assert.ok(result.ok);
  if (result.ok) {
    assert.deepEqual(result.data.commands, resources.commands, '清理后降级轻量查询');
  }
  assert.deepEqual(resources.calls, [undefined]);
});
