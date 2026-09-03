import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  createPiAgentSessionFactory,
  type PiSessionHandle,
} from '../../src/pi/createPiAgentSessionFactory.ts';
import { PiConversationAdapter } from '../../src/pi/piConversationAdapter.ts';

test('按 forge 会话 ID 创建并恢复持久化 pi 会话', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-factory-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const first = await createPiAgentSessionFactory({ agentDir })({
      cwd: projectDir,
      sessionId: 'forge-session-1',
    });

    assert.equal(first.session.sessionId, 'forge-forge-session-1');
    const sessionFile = (first as unknown as { handle?: PiSessionHandle }).handle?.sessionFile;
    assert.ok(sessionFile && fs.existsSync(sessionFile));

    const second = await createPiAgentSessionFactory({ agentDir })({
      cwd: projectDir,
      sessionId: 'forge-session-1',
    });

    assert.equal(second.session.sessionId, 'forge-forge-session-1');
    assert.equal((second as unknown as { handle?: PiSessionHandle }).handle?.sessionFile, sessionFile);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工厂按 models.json 解析模型字符串并注入新会话', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-model-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);
    const modelsPath = path.join(root, 'models.json');
    fs.writeFileSync(
      modelsPath,
      JSON.stringify({
        providers: {
          'Test Provider': {
            baseUrl: 'https://example.com/v1',
            api: 'openai-completions',
            apiKey: 'sk-test',
            models: [{ id: 'test-model', contextWindow: 128000, maxTokens: 8192 }],
          },
        },
      }),
      'utf8',
    );

    const lease = await createPiAgentSessionFactory({ agentDir, modelsPath })({
      cwd: projectDir,
      sessionId: 'forge-model-1',
      model: 'test-model',
    });

    assert.equal(lease.session.model?.id, 'test-model', '新会话应使用目标模型');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工厂解析不到模型时抛出稳定错误', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-model-miss-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);
    const modelsPath = path.join(root, 'models.json');
    fs.writeFileSync(modelsPath, JSON.stringify({ providers: {} }), 'utf8');

    await assert.rejects(
      createPiAgentSessionFactory({ agentDir, modelsPath })({
        cwd: projectDir,
        sessionId: 'forge-model-2',
        model: 'ghost-model',
      }),
      /模型未配置或不可用: ghost-model/,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工厂可注入 PiConversationAdapter 并完成一次文本流映射', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-adapter-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const adapter = new PiConversationAdapter(createPiAgentSessionFactory({ agentDir }));
    let final = '';
    adapter.onMessage('session-id-2', (message) => {
      if (message.role === 'assistant') final = message.content;
    });

    try {
      await adapter.sendMessage('session-id-2', '只回复 OK', { cwd: projectDir });
    } catch (error) {
      assert.match(
        String(error),
        /模型凭据未配置/,
        '无模型凭据时应抛出用户可读错误',
      );
      return;
    }

    assert.equal(final.toUpperCase().includes('OK'), true, `应包含 OK，实际：${final}`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== wu-06：事件总线注入与 cross-extension-rpc stop 通道 =====

interface RecordedRequest {
  requestId: string;
  agentId: string;
}

test('工厂注入 eventBus：lease 暴露总线与 stop 通道（subagents:rpc:stop 协议）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-bus-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const handlers = new Map<string, Set<(data: unknown) => void>>();
    const requests: RecordedRequest[] = [];
    const bus = {
      emit(channel: string, data: unknown): void {
        if (channel === 'subagents:rpc:stop') {
          requests.push(data as RecordedRequest);
        }
        for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void): () => void {
        let set = handlers.get(channel);
        if (set === undefined) {
          set = new Set();
          handlers.set(channel, set);
        }
        set.add(handler);
        return () => set.delete(handler);
      },
    };

    const lease = await createPiAgentSessionFactory({ agentDir, eventBus: bus })({
      cwd: projectDir,
      sessionId: 'forge-bus-1',
    });

    // lease 暴露注入的总线（扩展 pi.events === 该总线）
    assert.equal(
      (lease as unknown as { events?: unknown }).events,
      bus,
      'lease 应暴露注入的事件总线',
    );

    // 句柄暴露 stop 通道：发 subagents:rpc:stop { requestId, agentId } 并等回复信封
    const stop = (lease as unknown as { handle?: { stopSubagent?: (agentId: string) => Promise<void> } })
      .handle?.stopSubagent;
    assert.equal(typeof stop, 'function', '句柄应暴露 stopSubagent 通道');

    // 成功回复 → resolve
    const okPromise = stop!('agent-1');
    assert.equal(requests.length, 1, '应发出一次 stop RPC 请求');
    assert.ok(
      typeof requests[0]?.requestId === 'string' && requests[0].requestId.length > 0,
      '请求应携带 requestId',
    );
    assert.equal(requests[0]?.agentId, 'agent-1');
    bus.emit(`subagents:rpc:stop:reply:${requests[0]!.requestId}`, { success: true });
    await assert.doesNotReject(okPromise);

    // 失败回复 → reject(error message)
    const failPromise = stop!('agent-2');
    const second = requests[1]!;
    bus.emit(`subagents:rpc:stop:reply:${second.requestId}`, { success: false, error: 'Agent not found' });
    await assert.rejects(failPromise, /Agent not found/);

    // 请求的 reply channel 与 requestId 一一对应
    assert.notEqual(requests[0]?.requestId, requests[1]?.requestId, '每次请求应有独立 requestId');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('未注入 eventBus 时工厂为每会话创建独立总线（事件绑定会话）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-bus-auto-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const factory = createPiAgentSessionFactory({ agentDir });
    const leaseA = await factory({ cwd: projectDir, sessionId: 'forge-bus-a' });
    const leaseB = await factory({ cwd: projectDir, sessionId: 'forge-bus-b' });

    const eventsA = (leaseA as unknown as { events?: unknown }).events;
    const eventsB = (leaseB as unknown as { events?: unknown }).events;
    assert.ok(eventsA !== undefined && eventsB !== undefined, '每会话应有独立事件总线');
    assert.notEqual(eventsA, eventsB, '两个会话的总线互不共享（事件归组隔离）');

    // stop 通道可用（扩展缺失时经超时/错误回复映射，不在本测试展开）
    const stop = (leaseA as unknown as { handle?: { stopSubagent?: unknown } }).handle?.stopSubagent;
    assert.equal(typeof stop, 'function');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工厂 stop 通道：回复超时 reject（扩展无响应时终止请求不挂起）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-stop-timeout-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    // 静默总线：只转发订阅，不产生任何回复（模拟扩展缺失/事件丢失）
    const handlers = new Map<string, Set<(data: unknown) => void>>();
    const silentBus = {
      emit(channel: string, data: unknown): void {
        for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void): () => void {
        let set = handlers.get(channel);
        if (set === undefined) {
          set = new Set();
          handlers.set(channel, set);
        }
        set.add(handler);
        return () => set.delete(handler);
      },
    };

    const lease = await createPiAgentSessionFactory({
      agentDir,
      eventBus: silentBus,
      stopRpcTimeoutMs: 80,
    })({ cwd: projectDir, sessionId: 'forge-bus-timeout' });
    const stop = (lease as unknown as { handle?: { stopSubagent?: (agentId: string) => Promise<void> } })
      .handle?.stopSubagent;
    assert.equal(typeof stop, 'function');

    const startedAt = Date.now();
    await assert.rejects(stop!('agent-x'), /超时/, '无回复时应在窗口到期后 reject');
    const elapsed = Date.now() - startedAt;
    assert.ok(elapsed >= 60 && elapsed < 5_000, `应在注入的小窗口（80ms）附近超时，实际 ${elapsed}ms`);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('工厂总线桥接：会话总线注入 pi 扩展加载（DefaultResourceLoader eventBus）', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-bridge-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const handlers = new Map<string, Set<(data: unknown) => void>>();
    const bus = {
      emit(channel: string, data: unknown): void {
        for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void): () => void {
        let set = handlers.get(channel);
        if (set === undefined) {
          set = new Set();
          handlers.set(channel, set);
        }
        set.add(handler);
        return () => set.delete(handler);
      },
    };

    const lease = await createPiAgentSessionFactory({ agentDir, eventBus: bus })({
      cwd: projectDir,
      sessionId: 'forge-bridge-1',
    });
    // lease.events 即注入总线：桥接后扩展的 pi.events 与 forge 订阅源同源
    assert.equal((lease as unknown as { events?: unknown }).events, bus, 'lease.events 应为注入总线');

    // 端到端协议校验：模拟扩展按 pi-subagents 契约在总线上发生命周期事件，
    // forge 侧订阅（PiConversationAdapter.bindSubagentBus 同款）应原样收到
    const seen: Array<{ channel: string; data: unknown }> = [];
    const offs = ['subagents:created', 'subagents:started', 'subagents:completed'].map((channel) =>
      bus.on(channel, (data) => seen.push({ channel, data })),
    );
    bus.emit('subagents:created', { id: 'ag-1', type: 'general-purpose', description: '扫描' });
    bus.emit('subagents:started', { id: 'ag-1' });
    bus.emit('subagents:completed', { id: 'ag-1', status: 'completed', result: '完成', tokens: { input: 1, output: 2 } });
    for (const off of offs) off();
    assert.deepEqual(
      seen.map((e) => e.channel),
      ['subagents:created', 'subagents:started', 'subagents:completed'],
      '注入总线应可承载扩展生命周期事件（桥接通道成立）',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ===== CV-S08：命令上报扩展随会话装载（extensionFactories） =====

test('命令上报扩展随会话装载：session_start 后总线上报 slash-commands:reported', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-slash-'));
  try {
    const projectDir = path.join(root, 'project');
    const agentDir = path.join(root, '.pi-agent');
    fs.mkdirSync(projectDir);

    const handlers = new Map<string, Set<(data: unknown) => void>>();
    const reports: unknown[] = [];
    const bus = {
      emit(channel: string, data: unknown): void {
        if (channel === 'slash-commands:reported') reports.push(data);
        for (const handler of [...(handlers.get(channel) ?? [])]) handler(data);
      },
      on(channel: string, handler: (data: unknown) => void): () => void {
        let set = handlers.get(channel);
        if (set === undefined) {
          set = new Set();
          handlers.set(channel, set);
        }
        set.add(handler);
        return () => set.delete(handler);
      },
    };

    await createPiAgentSessionFactory({ agentDir, eventBus: bus })({
      cwd: projectDir,
      sessionId: 'forge-slash-1',
    });

    // session_start 扩展 handler 异步执行：轮询等待上报到达（上限 5s）
    const deadline = Date.now() + 5_000;
    while (reports.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    assert.ok(reports.length >= 1, '总线应收到 slash-commands:reported 上报（真实扩展经 extensionFactories 装载）');
    const payload = reports[0] as {
      commands: Array<{ name: unknown; description: unknown; source: unknown }>;
    };
    assert.ok(Array.isArray(payload.commands), '载荷应为 { commands: [...] }');
    for (const command of payload.commands) {
      assert.equal(typeof command.name, 'string', '命令名应为字符串');
      assert.ok(
        command.description === null || typeof command.description === 'string',
        '命令描述应为字符串或 null',
      );
      assert.ok(
        command.source === 'extension' || command.source === 'prompt' || command.source === 'skill',
        `命令来源应为三值之一，实际：${String(command.source)}`,
      );
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
