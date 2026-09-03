import { test } from 'node:test';
import assert from 'node:assert/strict';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import {
  slashCommandReporter,
  SLASH_COMMANDS_REPORTED_CHANNEL,
} from '../../../forge-extensions/src/slashCommandReporter.ts';
import {
  PiConversationAdapter,
  type PiAgentSessionFactory,
} from '../../src/pi/piConversationAdapter.ts';

/** pi getCommands 返回的最小命令形态（SlashCommandInfo 子集，三类 source） */
interface FakeSlashCommand {
  name: string;
  description?: string;
  source: 'extension' | 'prompt' | 'skill';
}

/** fake pi API：记录 events.emit，捕获 session_start 订阅 */
function createFakePi(commands: FakeSlashCommand[] | Error) {
  const emissions: Array<{ channel: string; data: unknown }> = [];
  const sessionStartHandlers: Array<(event: unknown) => unknown> = [];
  const pi = {
    on(event: string, handler: (event: unknown) => unknown): void {
      if (event === 'session_start') sessionStartHandlers.push(handler);
    },
    getCommands(): FakeSlashCommand[] {
      if (commands instanceof Error) throw commands;
      return commands;
    },
    events: {
      emit(channel: string, data: unknown): void {
        emissions.push({ channel, data });
      },
      on(): () => void {
        return () => undefined;
      },
    },
  };
  return {
    pi,
    emissions,
    fireSessionStart(): void {
      for (const handler of [...sessionStartHandlers]) {
        handler({ type: 'session_start', reason: 'startup' });
      }
    },
  };
}

// ===== 扩展本身：session_start 上报载荷结构与映射 =====

test('session_start 时上报三类命令：载荷结构与映射正确（description 缺省为 null）', async () => {
  const fake = createFakePi([
    { name: 'review-pr', description: '审查拉取请求', source: 'extension' },
    { name: 'write-tests', source: 'prompt' },
    { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
  ]);

  await slashCommandReporter(fake.pi as unknown as ExtensionAPI);
  fake.fireSessionStart();

  assert.equal(fake.emissions.length, 1, '应恰好 emit 一次');
  assert.equal(fake.emissions[0]?.channel, SLASH_COMMANDS_REPORTED_CHANNEL);
  assert.equal(fake.emissions[0]?.channel, 'slash-commands:reported');
  assert.deepEqual(fake.emissions[0]?.data, {
    commands: [
      { name: 'review-pr', description: '审查拉取请求', source: 'extension' },
      { name: 'write-tests', description: null, source: 'prompt' },
      { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
    ],
  });
});

test('getCommands 抛错时静默：不 emit、不崩、不阻断 session_start', async () => {
  const fake = createFakePi(new Error('command enumeration failed'));

  await slashCommandReporter(fake.pi as unknown as ExtensionAPI);
  assert.doesNotThrow(() => fake.fireSessionStart());
  assert.equal(fake.emissions.length, 0, '抛错时不应 emit 上报');
});

test('多会话并发：两个 pi 实例各自上报互不串扰（模块级无可变状态）', async () => {
  const a = createFakePi([{ name: 'cmd-a', description: 'A', source: 'extension' }]);
  const b = createFakePi([{ name: 'skill:cmd-b', source: 'skill' }]);

  await slashCommandReporter(a.pi as unknown as ExtensionAPI);
  await slashCommandReporter(b.pi as unknown as ExtensionAPI);
  a.fireSessionStart();
  b.fireSessionStart();

  assert.deepEqual(
    a.emissions.map((e) => e.channel),
    ['slash-commands:reported'],
  );
  assert.deepEqual(
    b.emissions.map((e) => e.channel),
    ['slash-commands:reported'],
  );
  const payloadA = (a.emissions[0]?.data as { commands: Array<{ name: string }> }).commands;
  const payloadB = (b.emissions[0]?.data as { commands: Array<{ name: string }> }).commands;
  assert.deepEqual(payloadA.map((c) => c.name), ['cmd-a']);
  assert.deepEqual(payloadB.map((c) => c.name), ['skill:cmd-b']);
});

// ===== 适配器桥接：订阅 / 上抛 / 退订 / 防重复 =====

/** 最小 pi 会话 fake（adapter 契约子集） */
class SlashReporterFakeSession {
  readonly listeners = new Set<(event: unknown) => void>();
  readonly promptCalls: string[] = [];

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async prompt(text: string): Promise<void> {
    this.promptCalls.push(text);
  }

  async abort(): Promise<void> {}
}

/** 扩展事件总线 fake（pi.events 结构） */
class SlashReporterTestBus {
  readonly handlers = new Map<string, Set<(data: unknown) => void>>();

  emit(channel: string, data: unknown): void {
    for (const handler of [...(this.handlers.get(channel) ?? [])]) handler(data);
  }

  on(channel: string, handler: (data: unknown) => void): () => void {
    let set = this.handlers.get(channel);
    if (set === undefined) {
      set = new Set();
      this.handlers.set(channel, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }
}

const SAMPLE_REPORT = {
  commands: [
    { name: 'skill:git-push', description: '推送当前分支', source: 'skill' },
    { name: 'review-pr', description: null, source: 'extension' },
    { name: 'write-tests', description: '生成测试用例', source: 'prompt' },
  ],
};

test('适配器订阅 slash-commands:reported 并经 onSlashCommandsReported 上抛（按会话归组）', async () => {
  const bus = new SlashReporterTestBus();
  const fake = new SlashReporterFakeSession();
  const factory: PiAgentSessionFactory<SlashReporterFakeSession> = async () => ({
    session: fake,
    dispose: () => undefined,
    events: bus,
  });
  const adapter = new PiConversationAdapter(factory);

  const reported: Array<{ sessionId: string; commands: unknown }> = [];
  adapter.setEventHandlers({
    onSlashCommandsReported: (sessionId, commands) => reported.push({ sessionId, commands }),
  });

  await adapter.sendMessage('s-slash', '你好');

  bus.emit('slash-commands:reported', SAMPLE_REPORT);

  assert.equal(reported.length, 1, '应上抛一次');
  assert.equal(reported[0]?.sessionId, 's-slash', '应携带 lease 所属会话 ID');
  assert.deepEqual(reported[0]?.commands, SAMPLE_REPORT.commands);
});

test('重复 sendMessage 不重复绑定：同一上报只上抛一次', async () => {
  const bus = new SlashReporterTestBus();
  const fake = new SlashReporterFakeSession();
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => undefined,
    events: bus,
  }));

  const reported: unknown[][] = [];
  adapter.setEventHandlers({
    onSlashCommandsReported: (_sessionId, commands) => reported.push(commands),
  });

  await adapter.sendMessage('s-dup', '第一条');
  await adapter.sendMessage('s-dup', '第二条');
  bus.emit('slash-commands:reported', SAMPLE_REPORT);

  assert.equal(reported.length, 1, '同一会话多次发送不得造成重复订阅');
});

test('removeSession 退订 slash-commands:reported：迟到上报不再上抛', async () => {
  const bus = new SlashReporterTestBus();
  const fake = new SlashReporterFakeSession();
  let disposed = false;
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => {
      disposed = true;
    },
    events: bus,
  }));

  const reported: unknown[][] = [];
  adapter.setEventHandlers({
    onSlashCommandsReported: (_sessionId, commands) => reported.push(commands),
  });

  await adapter.sendMessage('s-del', '任务');
  bus.emit('slash-commands:reported', SAMPLE_REPORT);
  assert.equal(reported.length, 1, '删除前应正常上抛');

  await adapter.removeSession('s-del');
  assert.ok(disposed, 'lease 应被 dispose');

  bus.emit('slash-commands:reported', SAMPLE_REPORT);
  assert.equal(reported.length, 1, '退订后迟到上报不应再上抛');

  // removeSession 幂等
  await adapter.removeSession('s-del');
});

test('lease 无事件总线时静默降级：不订阅、无副作用', async () => {
  const fake = new SlashReporterFakeSession();
  const adapter = new PiConversationAdapter(async () => ({
    session: fake,
    dispose: () => undefined,
  }));

  const reported: unknown[][] = [];
  adapter.setEventHandlers({
    onSlashCommandsReported: (_sessionId, commands) => reported.push(commands),
  });

  await adapter.sendMessage('s-plain', '普通问题');
  assert.equal(fake.promptCalls.length, 1);
  assert.equal(reported.length, 0);
});
