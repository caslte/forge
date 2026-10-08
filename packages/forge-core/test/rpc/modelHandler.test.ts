/**
 * 模型与 Provider 配置 RPC 方法层（modelMethods）单元测试。
 *
 * 覆盖 docs/test/05_model/coverage-matrix.md api 层用例：
 * - A-MP-001：saveProvider → code 0，models.json 写库，providersChanged 发射
 * - A-MP-002：apiKey 引用不明文泄漏（响应与事件载荷均剥离）
 * - A-MP-003：saveProvider 非法输入 → 1001，无写库
 * - A-MP-005：setDefault（参数为别名锚点 providerId）→ 全局默认生效
 * - A-MP-006：setSessionModel（参数为别名锚点 providerId）→ 仅会话覆盖
 * 以及本 WU 契约：queryProviderList / queryModels（{ options, defaultProviderId }）/
 * deleteProvider / getSessionModel（{ model, providerId, effective }）
 * 信封映射、1002 / 1004 / 5000 错误码、异常隔离 5000 安全消息、信封恒为
 * { code, message, data }。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；models.json / keychain / store 均注入
 * mock（服务不 import fs / pi / OS keychain）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ModelService } from '../../src/model/modelService.ts';
import { ModelApi } from '../../src/rpc/modelMethods.ts';
import type { RpcResult } from '../../src/rpc/projectMethods.ts';
import type {
  KeychainAdapter,
  ModelRegistry,
  ModelResult,
  ModelStorePort,
  ModelsFileAdapter,
  ProviderConfig,
  ProviderFileRecord,
  SaveProviderInput,
  ThinkingLevel,
  ThinkLevelsPort,
} from '../../src/model/modelService.ts';
import type { SessionRecord, StoreKey } from '../../src/types/forge-store.ts';

/** models.json 适配器 mock：内存 provider 列表，记录每次写入快照 */
class MockModelsFileAdapter implements ModelsFileAdapter {
  providers: ProviderFileRecord[] = [];
  modelNames: string[] = [];
  /** 每次 writeProviders 的入参快照（断言"文件内容"用） */
  writeSnapshots: ProviderFileRecord[][] = [];
  readError: Error | null = null;
  writeError: Error | null = null;

  async readProviders(): Promise<ProviderFileRecord[]> {
    if (this.readError !== null) {
      throw this.readError;
    }
    return this.providers.map((p) => ({ ...p }));
  }

  async writeProviders(providers: ProviderFileRecord[]): Promise<void> {
    if (this.writeError !== null) {
      throw this.writeError;
    }
    // 与 pi models.json 同构：provider key 按 name 落盘，读回时 id === name
    const byName = new Map<string, ProviderFileRecord>();
    for (const p of providers) {
      byName.set(p.name, { ...p, id: p.name });
    }
    this.providers = [...byName.values()].map((p) => ({ ...p }));
    this.writeSnapshots.push(this.providers.map((p) => ({ ...p })));
  }

  async readModelNames(): Promise<string[]> {
    if (this.readError !== null) {
      throw this.readError;
    }
    return [...this.modelNames];
  }
}

/** keychain 适配器 mock：可配置可用性，返回 `!forge-secret get <id>` 引用 */
class MockKeychainAdapter implements KeychainAdapter {
  available = true;
  stored: Array<{ providerId: string; apiKey: string }> = [];

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async storeKey(providerId: string, apiKey: string): Promise<string> {
    this.stored.push({ providerId, apiKey });
    return `!forge-secret get ${providerId}`;
  }
}

/** 最小 store mock：内存 settings 与 sessions */
class MockModelStore implements ModelStorePort {
  settings = new Map<StoreKey, unknown>();
  sessions = new Map<string, SessionRecord>();

  getSetting(key: StoreKey): unknown {
    return this.settings.get(key) ?? null;
  }

  setSetting(key: StoreKey, value: unknown): void {
    this.settings.set(key, value);
  }

  getSession(sessionId: string): SessionRecord | undefined {
    return this.sessions.get(sessionId);
  }

  saveSession(record: SessionRecord): void {
    this.sessions.set(record.sessionId, { ...record });
  }

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
  }
}

/** 构造会话记录（默认无覆盖） */
function makeSession(
  sessionId: string,
  modelOverride: string | null = null,
  thinkingLevel: string | null = null,
): SessionRecord {
  return {
    sessionId,
    projectPath: 'C:/demo/proj',
    alias: null,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelOverride,
    thinkingLevel,
  };
}

/** 思考级别端口 mock：model -> 级别列表（null 表示模型不可用） */
class MockThinkLevelsPort implements ThinkLevelsPort {
  levelsByModel = new Map<string, string[] | null>();

  async getSupportedThinkingLevels(model: string): Promise<string[] | null> {
    return this.levelsByModel.get(model) ?? null;
  }
}

/** 服务方法调用记录（setSessionThinkingLevel 同步全局默认语义验证） */
interface CallRecord {
  sessionId: string;
  level: ThinkingLevel | null;
}

/** 构造 api + 真实服务 + mock 依赖 + 思考级别端口 + 事件汇 */
function makeApi(): {
  api: ModelApi;
  modelsFile: MockModelsFileAdapter;
  keychain: MockKeychainAdapter;
  store: MockModelStore;
  thinkLevels: MockThinkLevelsPort;
  events: EventEmitter;
} {
  const modelsFile = new MockModelsFileAdapter();
  const keychain = new MockKeychainAdapter();
  const store = new MockModelStore();
  const thinkLevels = new MockThinkLevelsPort();
  const service = new ModelService({ modelsFile, keychain, store, thinkLevels });
  const events = new EventEmitter();
  const api = new ModelApi(service, events);
  return { api, modelsFile, keychain, store, thinkLevels, events };
}

/** 合法保存参数（可覆盖）。name 用字面 'openai'：pi 侧 id === name，别名锚点据此断言 */
function validInput(overrides: Partial<SaveProviderInput> = {}): SaveProviderInput {
  return {
    name: 'openai',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    apiKey: 'sk-secret-123',
    ...overrides,
  };
}

/** 构造已落盘的 provider 配置记录（id === name，同 pi） */
function providerRecord(
  id: string,
  models: string[],
  extra: Partial<ProviderFileRecord> = {},
): ProviderFileRecord {
  return {
    id,
    name: id,
    type: 'openai',
    baseUrl: null,
    models,
    lastError: null,
    ...extra,
  };
}

test('queryProviderList：返回 providers，保留 apiKey 供前端回显（回显设计）', async () => {
  const { api, modelsFile } = makeApi();
  // 适配器返回含 apiKey 引用的记录（ProviderFileRecord）
  modelsFile.providers = [
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o'],
      lastError: null,
      apiKey: '!forge-secret get openai',
    },
  ];
  const result = await api.methods['model/queryProviderList']({});
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const providers = (result.data as { providers: ProviderConfig[] }).providers;
    assert.equal(providers.length, 1);
    assert.equal(providers[0]?.id, 'openai');
    // 按用户「回显已存密钥」选择，apiKey 应被保留返回
    assert.equal(providers[0]?.apiKey, '!forge-secret get openai', 'apiKey 应回显');
  }
});

test('saveProvider：合法配置 → code 0 data null，写库并发射 providersChanged（A-MP-001）', async () => {
  const { api, modelsFile, events } = makeApi();
  const changed: unknown[] = [];
  events.on('model.providersChanged', (payload) => changed.push(payload));
  const result = await api.methods['model/saveProvider'](validInput());
  assert.equal(result.code, 0);
  assert.equal(result.data, null);
  assert.equal(modelsFile.providers.length, 1);
  assert.equal(modelsFile.providers[0]?.id, 'openai');
  // 事件发射一次，载荷含更新后的 provider 列表且保留 apiKey 回显
  assert.equal(changed.length, 1);
  if (changed[0] !== undefined) {
    const payload = changed[0] as { providers: ProviderConfig[] };
    assert.equal(payload.providers.length, 1);
    assert.equal(payload.providers[0]?.id, 'openai');
    // 按「回显已存密钥」选择，apiKey 引用在事件载荷中保留
    assert.ok(typeof payload.providers[0]?.apiKey === 'string', '事件载荷保留 apiKey 回显');
  }
});

test('saveProvider：name/type 缺失或空白、models 为空 → 1001，无写库（A-MP-003）', async () => {
  const { api, modelsFile } = makeApi();
  assert.equal((await api.methods['model/saveProvider']({})).code, 1001);
  assert.equal((await api.methods['model/saveProvider']({ name: 'x', type: 'y', models: [] })).code, 1001);
  assert.equal((await api.methods['model/saveProvider']({ name: '  ', type: 'y', models: ['gpt-4o'] })).code, 1001);
  assert.equal((await api.methods['model/saveProvider']({ name: 'x', type: '  ', models: ['gpt-4o'] })).code, 1001);
  assert.equal((await api.methods['model/saveProvider'](null)).code, 1001);
  assert.equal((await api.methods['model/saveProvider']({ name: 'x', type: 'y', models: ['a', 123] })).code, 1001);
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：非法 reasoning/thinkingLevels → 1001，无写库（MP-S07/AC-MP-026）', async () => {
  const { api, modelsFile } = makeApi();
  const badReasoning = await api.methods['model/saveProvider']({
    name: 'OpenAI',
    type: 'openai',
    models: ['gpt-4o'],
    reasoning: 'yes',
  });
  assert.equal(badReasoning.code, 1001);
  const badLevels = await api.methods['model/saveProvider']({
    name: 'OpenAI',
    type: 'openai',
    models: ['gpt-4o'],
    reasoning: true,
    thinkingLevels: ['off', 'nope'],
  });
  assert.equal(badLevels.code, 1001);
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：reasoning/thinkingLevels 合法透传 → 写库（MP-S07/AC-MP-023）', async () => {
  const { api, modelsFile } = makeApi();
  const ok = await api.methods['model/saveProvider'](
    validInput({ id: 'openai', models: ['gpt-4o'], reasoning: true, thinkingLevels: ['off', 'high', 'max'] }),
  );
  assert.equal(ok.code, 0);
  const snap = modelsFile.writeSnapshots[0];
  assert.ok(snap && snap[0]?.reasoning === true, '写库记录应含 reasoning=true');
  assert.deepEqual(snap[0]?.thinkingLevels, ['off', 'high', 'max']);
  // 重复项去重
  const dedup = await api.methods['model/saveProvider'](
    validInput({ id: 'openai', models: ['gpt-4o'], reasoning: true, thinkingLevels: ['off', 'off', 'high'] }),
  );
  assert.equal(dedup.code, 0);
  assert.deepEqual(modelsFile.writeSnapshots[1]?.[0]?.thinkingLevels, ['off', 'high']);
});

test('saveProvider：服务层返回 1004（provider 未配置）→ 透传 code 1004', async () => {
  // 真实服务 saveProvider 不产生 1004，此处用 stub 服务模拟服务层返回 1004
  const stubService = new ModelService({
    modelsFile: new MockModelsFileAdapter(),
    keychain: new MockKeychainAdapter(),
    store: new MockModelStore(),
  });
  stubService.saveProvider = async (_input: SaveProviderInput): Promise<ModelResult<null>> => {
    return { ok: false, code: 1004, message: 'provider 未配置' };
  };
  const api = new ModelApi(stubService, new EventEmitter());
  const result = await api.methods['model/saveProvider'](validInput());
  assert.equal(result.code, 1004);
  assert.equal(result.data, null);
});

test('deleteProvider：成功 → code 0 data null + providersChanged；未知 id → 1002', async () => {
  const { api, modelsFile, events } = makeApi();
  // 先保存一个 provider
  const saved = await api.methods['model/saveProvider'](validInput());
  assert.equal(saved.code, 0);
  const changed: unknown[] = [];
  events.on('model.providersChanged', (payload) => changed.push(payload));
  const result = await api.methods['model/deleteProvider']({ id: 'openai' });
  assert.equal(result.code, 0);
  assert.equal(result.data, null);
  assert.equal(modelsFile.providers.length, 0);
  assert.equal(changed.length, 1);
  if (changed[0] !== undefined) {
    const payload = changed[0] as { providers: ProviderConfig[] };
    assert.equal(payload.providers.length, 0);
  }
  // 未知 id → 1002
  const unknown = await api.methods['model/deleteProvider']({ id: 'nope' });
  assert.equal(unknown.code, 1002);
  // 缺 id → 1001
  assert.equal((await api.methods['model/deleteProvider']({})).code, 1001);
});

test('queryModels：返回 { options, defaultProviderId }，一个配置一项（A-MP-005 前置）', async () => {
  const { api, modelsFile, store } = makeApi();
  modelsFile.providers = [
    providerRecord('openai', ['gpt-4o', 'gpt-4o-mini']),
    providerRecord('anthropic', ['claude-sonnet-4']),
    providerRecord('empty', []), // 无可用模型：不进可选项
  ];
  store.setSetting('defaultModel', 'anthropic');
  const result = await api.methods['model/queryModels']({});
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const data = result.data as ModelRegistry;
    assert.deepEqual(data.options, [
      { providerId: 'openai', model: 'gpt-4o' },
      { providerId: 'anthropic', model: 'claude-sonnet-4' },
    ]);
    assert.equal(data.defaultProviderId, 'anthropic');
  }
});

test('queryModels：存量裸模型 ID 默认值读时自愈为别名（设计决策 6）', async () => {
  const { api, modelsFile, store } = makeApi();
  modelsFile.providers = [providerRecord('openai', ['gpt-4o'])];
  store.setSetting('defaultModel', 'gpt-4o');
  const result = await api.methods['model/queryModels']({});
  assert.equal(result.code, 0);
  assert.equal((result.data as ModelRegistry).defaultProviderId, 'openai');
  assert.equal(store.getSetting('defaultModel'), 'openai', '读一次即把裸模型 ID 回写为别名');
});

test('setDefault：合法别名 → code 0 data null 并持久化 + 发射 providersChanged；未知配置 / 空配置 → 1004（A-MP-005）', async () => {
  const { api, modelsFile, store, events } = makeApi();
  modelsFile.providers = [providerRecord('openai', ['gpt-4o']), providerRecord('empty', [])];
  const changed: unknown[] = [];
  events.on('model.providersChanged', (payload) => changed.push(payload));
  const ok = await api.methods['model/setDefault']({ providerId: 'openai' });
  assert.equal(ok.code, 0);
  assert.equal(ok.data, null);
  assert.equal(store.getSetting('defaultModel'), 'openai');
  // 成功后发射 providersChanged（同步草稿态全局默认展示）；清除默认同样发射
  assert.equal(changed.length, 1);
  await api.methods['model/setDefault']({ providerId: null });
  assert.equal(changed.length, 2);
  // 失败（配置未保存 / 无可用模型）不发射
  const unknown = await api.methods['model/setDefault']({ providerId: 'nope' });
  assert.equal(unknown.code, 1004);
  const noModel = await api.methods['model/setDefault']({ providerId: 'empty' });
  assert.equal(noModel.code, 1004);
  assert.equal(changed.length, 2);
  // 参数校验：providerId 缺失/空白/非字符串 → 1001
  assert.equal((await api.methods['model/setDefault']({})).code, 1001);
  assert.equal((await api.methods['model/setDefault']({ providerId: '  ' })).code, 1001);
  assert.equal((await api.methods['model/setDefault']({ providerId: 1 })).code, 1001);
});

test('setDefault + saveProvider 改模型 ID：主会话锚点不动、派生模型自动跟随（回归本次 bug）', async () => {
  const { api, modelsFile, store } = makeApi();
  modelsFile.providers = [providerRecord('mx', ['MiniMax-M3'])];
  assert.equal((await api.methods['model/setDefault']({ providerId: 'mx' })).code, 0);
  // 用户把模型 ID 改成 MiniMax-M3.1-Flash-Preview（别名不变）
  const saved = await api.methods['model/saveProvider'](
    validInput({ name: 'mx', models: ['MiniMax-M3.1-Flash-Preview'] }),
  );
  assert.equal(saved.code, 0);
  assert.equal(store.getSetting('defaultModel'), 'mx', '锚点仍是别名');
  const models = await api.methods['model/queryModels']({});
  assert.deepEqual((models.data as ModelRegistry).options, [
    { providerId: 'mx', model: 'MiniMax-M3.1-Flash-Preview' },
  ]);
  assert.equal((models.data as ModelRegistry).defaultProviderId, 'mx');
});

test('getSessionModel：会话覆盖优先，无覆盖用全局默认；返回派生模型 + 别名；未知会话 → 1002', async () => {
  const { api, modelsFile, store } = makeApi();
  modelsFile.providers = [
    providerRecord('openai', ['gpt-4o']),
    providerRecord('anthropic', ['claude-sonnet-4']),
  ];
  store.sessions.set('sess-1', makeSession('sess-1', 'openai'));
  store.sessions.set('sess-2', makeSession('sess-2', null));
  store.setSetting('defaultModel', 'anthropic');
  const overridden = await api.methods['model/getSessionModel']({ sessionId: 'sess-1' });
  assert.equal(overridden.code, 0);
  assert.ok(overridden.data !== null);
  if (overridden.data !== null) {
    const info = overridden.data as { model: string | null; providerId: string | null; effective: 'session' | 'global' };
    assert.equal(info.model, 'gpt-4o');
    assert.equal(info.providerId, 'openai');
    assert.equal(info.effective, 'session');
  }
  const global = await api.methods['model/getSessionModel']({ sessionId: 'sess-2' });
  assert.ok(global.data !== null);
  if (global.data !== null) {
    const info = global.data as { model: string | null; providerId: string | null; effective: 'session' | 'global' };
    assert.equal(info.model, 'claude-sonnet-4');
    assert.equal(info.providerId, 'anthropic');
    assert.equal(info.effective, 'global');
  }
  const unknown = await api.methods['model/getSessionModel']({ sessionId: 'nope' });
  assert.equal(unknown.code, 1002);
  assert.equal((await api.methods['model/getSessionModel']({})).code, 1001);
});

test('getSessionModel：存量裸模型 ID 覆盖回写别名；悬空覆盖降级全局默认', async () => {
  const { api, modelsFile, store } = makeApi();
  modelsFile.providers = [
    providerRecord('openai', ['gpt-4o']),
    providerRecord('anthropic', ['claude-sonnet-4']),
  ];
  store.sessions.set('sess-legacy', makeSession('sess-legacy', 'gpt-4o'));
  store.sessions.set('sess-dangling', makeSession('sess-dangling', 'deleted-provider'));
  store.setSetting('defaultModel', 'anthropic');
  const legacy = await api.methods['model/getSessionModel']({ sessionId: 'sess-legacy' });
  assert.equal(legacy.code, 0);
  const legacyInfo = legacy.data as { model: string | null; providerId: string | null; effective: string };
  assert.equal(legacyInfo.model, 'gpt-4o');
  assert.equal(legacyInfo.providerId, 'openai');
  assert.equal(legacyInfo.effective, 'session');
  assert.equal(store.sessions.get('sess-legacy')?.modelOverride, 'openai', '裸模型 ID 已回写为别名');
  const dangling = await api.methods['model/getSessionModel']({ sessionId: 'sess-dangling' });
  const danglingInfo = dangling.data as { model: string | null; providerId: string | null; effective: string };
  assert.equal(danglingInfo.effective, 'global');
  assert.equal(danglingInfo.providerId, 'anthropic');
});

test('setSessionModel：设置覆盖仅影响该会话；未知会话 → 1002（A-MP-006）', async () => {
  const { api, store } = makeApi();
  store.sessions.set('sess-1', makeSession('sess-1', null));
  store.sessions.set('sess-2', makeSession('sess-2', null));
  const ok = await api.methods['model/setSessionModel']({ sessionId: 'sess-1', providerId: 'openai' });
  assert.equal(ok.code, 0);
  assert.equal(ok.data, null);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'openai');
  assert.equal(store.sessions.get('sess-2')?.modelOverride, null);
  // 清除覆盖：写 null
  const cleared = await api.methods['model/setSessionModel']({ sessionId: 'sess-1', providerId: null });
  assert.equal(cleared.code, 0);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, null);
  const unknown = await api.methods['model/setSessionModel']({ sessionId: 'nope', providerId: 'openai' });
  assert.equal(unknown.code, 1002);
  // 参数校验：sessionId 缺失 / providerId 非法 → 1001
  assert.equal((await api.methods['model/setSessionModel']({})).code, 1001);
  assert.equal((await api.methods['model/setSessionModel']({ sessionId: 'sess-1', providerId: '  ' })).code, 1001);
});

test('adapter/service 抛错 → code 5000 安全消息（不泄漏异常细节）', async () => {
  // 服务层捕获 adapter 异常返回 5000 结果，RPC 层透传 code 5000
  const { api, modelsFile } = makeApi();
  modelsFile.readError = new Error('read boom');
  const result = await api.methods['model/queryProviderList']({});
  assert.equal(result.code, 5000);
  // 服务方法意外抛错（非服务层捕获路径）→ RPC 层隔离为 5000 安全消息
  const throwingService = new ModelService({
    modelsFile: new MockModelsFileAdapter(),
    keychain: new MockKeychainAdapter(),
    store: new MockModelStore(),
  });
  throwingService.queryModels = async (): Promise<ModelResult<ModelRegistry>> => {
    throw new Error('boom');
  };
  const api2 = new ModelApi(throwingService, new EventEmitter());
  const thrown = await api2.methods['model/queryModels']({});
  assert.equal(thrown.code, 5000);
  assert.equal(thrown.message, 'internal error');
  assert.ok(!thrown.message.includes('boom'), '5000 不得泄漏异常细节');
});

test('信封恒为 { code, message, data }，失败 data 为 null', async () => {
  const { api } = makeApi();
  const ok = await api.methods['model/queryModels']({});
  assert.deepEqual(Object.keys(ok).sort(), ['code', 'data', 'message']);
  const failResult = await api.methods['model/setDefault']({});
  assert.deepEqual(Object.keys(failResult).sort(), ['code', 'data', 'message']);
  assert.equal(failResult.data, null);
  const envelope = ok as RpcResult;
  assert.equal(typeof envelope.code, 'number');
  assert.equal(typeof envelope.message, 'string');
});

test('saveProvider：contextWindow=1000000 写库；null 移除；非法类型 → 1001（A-MP-009）', async () => {
  const { api, modelsFile } = makeApi();
  const ok = await api.methods['model/saveProvider'](validInput({ contextWindow: 1000000 }));
  assert.equal(ok.code, 0);
  // mock service 层断言入参写到 models.json（首模型 contextWindow）
  assert.equal(modelsFile.providers.length, 1);
  assert.equal(modelsFile.providers[0]?.contextWindow, 1000000);
  const snap = modelsFile.writeSnapshots[0];
  assert.ok(snap && snap[0]?.contextWindow === 1000000, '写库记录应含 contextWindow=1000000');

  // contextWindow=null → 字段移除
  const cleared = await api.methods['model/saveProvider'](
    validInput({ id: 'openai', contextWindow: null }),
  );
  assert.equal(cleared.code, 0);
  assert.equal(modelsFile.providers[0]?.contextWindow, null);

  // 非法类型（字符串）→ 1001，无写库
  const before = modelsFile.writeSnapshots.length;
  const bad = await api.methods['model/saveProvider'](
    validInput({ contextWindow: 'huge' as unknown as number }),
  );
  assert.equal(bad.code, 1001);
  assert.equal(bad.data, null);
  assert.equal(modelsFile.writeSnapshots.length, before, '非法 contextWindow 不写库');

  // 非法数值（负数）由服务层判 1001
  const neg = await api.methods['model/saveProvider'](validInput({ contextWindow: -1 }));
  assert.equal(neg.code, 1001);
});

test('queryProviderList：contextWindow 回显（1000000 与缺失 null）（A-MP-011）', async () => {
  const { api, modelsFile } = makeApi();
  modelsFile.providers = [
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o'],
      lastError: null,
      contextWindow: 1000000,
      apiKey: 'sk-secret-123',
    },
    {
      id: 'local',
      name: 'Local',
      type: 'openai',
      baseUrl: null,
      models: ['local-model'],
      lastError: null,
    },
  ];
  const result = await api.methods['model/queryProviderList']({});
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const providers = (result.data as { providers: ProviderConfig[] }).providers;
    assert.equal(providers[0]?.contextWindow, 1000000, '配置 1M 的 provider 回显 1000000');
    assert.equal(providers[1]?.contextWindow, null, '未配置的 provider 回显 null');
  }
});

test('queryProviderList：vision 回显（true 多模态 / false 纯文本）', async () => {
  const { api, modelsFile } = makeApi();
  modelsFile.providers = [
    {
      id: 'mini',
      name: 'MiniMax',
      type: 'openai',
      baseUrl: null,
      models: ['minimax-m3'],
      lastError: null,
      vision: true,
    },
    {
      id: 'plain',
      name: 'Plain',
      type: 'openai',
      baseUrl: null,
      models: ['plain-model'],
      lastError: null,
      vision: false,
    },
  ];
  const result = await api.methods['model/queryProviderList']({});
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const providers = (result.data as { providers: ProviderConfig[] }).providers;
    assert.equal(providers[0]?.vision, true, '多模态 provider 回显 vision=true');
    assert.equal(providers[1]?.vision, false, '纯文本 provider 回显 vision=false');
  }
});

test('saveProvider：勾选多模态后 providersChanged 载荷保留 vision（表单回显前置）', async () => {
  const { api, events } = makeApi();
  const changed: unknown[] = [];
  events.on('model.providersChanged', (payload) => changed.push(payload));
  const input = validInput({
    name: 'MiniMax',
    type: 'openai',
    models: ['minimax-m3'],
    vision: true,
  });
  const result = await api.methods['model/saveProvider'](input);
  assert.equal(result.code, 0);
  assert.equal(changed.length, 1);
  if (changed[0] !== undefined) {
    const payload = changed[0] as { providers: ProviderConfig[] };
    assert.equal(payload.providers[0]?.vision, true, '事件载荷保留 vision=true');
  }
});

test('queryProviderList：reasoning / thinkingLevels 回显（编辑对话框思考等级回填前置）', async () => {
  const { api, modelsFile } = makeApi();
  modelsFile.providers = [
    {
      id: 'think',
      name: 'Thinker',
      type: 'openai',
      baseUrl: null,
      models: ['think-model'],
      lastError: null,
      reasoning: true,
      thinkingLevels: ['low', 'medium', 'high'],
    },
    {
      id: 'plain',
      name: 'Plain',
      type: 'openai',
      baseUrl: null,
      models: ['plain-model'],
      lastError: null,
    },
  ];
  const result = await api.methods['model/queryProviderList']({});
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const providers = (result.data as { providers: ProviderConfig[] }).providers;
    assert.equal(providers[0]?.reasoning, true, '启用思考的 provider 回显 reasoning=true');
    assert.deepEqual(providers[0]?.thinkingLevels, ['low', 'medium', 'high'], '回显 thinkingLevels 白名单');
    assert.equal(providers[1]?.reasoning, undefined, '未配置思考的 provider 省略 reasoning');
    assert.equal(providers[1]?.thinkingLevels, undefined, '未配置思考的 provider 省略 thinkingLevels');
  }
});

test('saveProvider：设置思考等级后 providersChanged 载荷保留 reasoning / thinkingLevels', async () => {
  const { api, events } = makeApi();
  const changed: unknown[] = [];
  events.on('model.providersChanged', (payload) => changed.push(payload));
  const input = validInput({
    name: 'Thinker',
    type: 'openai',
    models: ['think-model'],
    reasoning: true,
    thinkingLevels: ['low', 'high'],
  });
  const result = await api.methods['model/saveProvider'](input);
  assert.equal(result.code, 0);
  assert.equal(changed.length, 1);
  if (changed[0] !== undefined) {
    const payload = changed[0] as { providers: ProviderConfig[] };
    assert.equal(payload.providers[0]?.reasoning, true, '事件载荷保留 reasoning=true');
    assert.deepEqual(payload.providers[0]?.thinkingLevels, ['low', 'high'], '事件载荷保留 thinkingLevels');
  }
});

test('getModelThinkingLevels：返回结构/顺序固定；未知模型 → 1004（A-MP-012）', async () => {
  const { api, thinkLevels } = makeApi();
  const full = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
  thinkLevels.levelsByModel.set('gpt-4o', full);
  thinkLevels.levelsByModel.set('gpt-4o-mini', ['off']);
  const reasoning = await api.methods['model/getModelThinkingLevels']({ model: 'gpt-4o' });
  assert.equal(reasoning.code, 0);
  assert.ok(reasoning.data !== null);
  if (reasoning.data !== null) {
    const data = reasoning.data as { levels: string[] };
    // MP-S07：推理模型可用级别不向对话框暴露 off（含存量配置缺省 off 的场景）
    assert.deepEqual(data.levels, [
      'minimal',
      'low',
      'medium',
      'high',
      'xhigh',
      'max',
    ]);
  }
  const nonReasoning = await api.methods['model/getModelThinkingLevels']({ model: 'gpt-4o-mini' });
  assert.equal(nonReasoning.code, 0);
  if (nonReasoning.data !== null) {
    assert.deepEqual((nonReasoning.data as { levels: string[] }).levels, ['off']);
  }
  // 未知模型 → 1004（判别联合错误码）
  const unknown = await api.methods['model/getModelThinkingLevels']({ model: 'nope' });
  assert.equal(unknown.code, 1004);
  assert.equal(unknown.data, null);
  // 参数校验：model 缺失 → 1001
  assert.equal((await api.methods['model/getModelThinkingLevels']({})).code, 1001);
});

test('getSessionThinkingLevel：会话覆盖生效；无覆盖继承全局；未知会话 → 1002（A-MP-013）', async () => {
  const { api, store } = makeApi();
  store.sessions.set('sess-1', makeSession('sess-1', null, 'high'));
  store.sessions.set('sess-2', makeSession('sess-2', null, null));
  store.settings.set('thinkingLevel', 'medium');
  const overridden = await api.methods['model/getSessionThinkingLevel']({ sessionId: 'sess-1' });
  assert.equal(overridden.code, 0);
  assert.ok(overridden.data !== null);
  if (overridden.data !== null) {
    const info = overridden.data as { level: string | null; effective: 'session' | 'global' };
    assert.equal(info.level, 'high');
    assert.equal(info.effective, 'session');
  }
  const inherited = await api.methods['model/getSessionThinkingLevel']({ sessionId: 'sess-2' });
  assert.equal(inherited.code, 0);
  assert.ok(inherited.data !== null);
  if (inherited.data !== null) {
    const info = inherited.data as { level: string | null; effective: 'session' | 'global' };
    assert.equal(info.level, 'medium');
    assert.equal(info.effective, 'global');
  }
  const unknown = await api.methods['model/getSessionThinkingLevel']({ sessionId: 'nope' });
  assert.equal(unknown.code, 1002);
  assert.equal(unknown.data, null);
  // sessionId 缺省（草稿态）：查全局默认；空串仍 1001
  const global = await api.methods['model/getSessionThinkingLevel']({});
  assert.equal(global.code, 0);
  if (global.data !== null) {
    const info = global.data as { level: string | null; effective: 'session' | 'global' };
    assert.equal(info.level, 'medium');
    assert.equal(info.effective, 'global');
  }
  assert.equal((await api.methods['model/getSessionThinkingLevel']({ sessionId: '' })).code, 1001);
});

test('setSessionThinkingLevel：写会话并同步全局默认；其他会话不变；错误码 1001/1002（A-MP-014）', async () => {
  const { api, store } = makeApi();
  store.sessions.set('sess-1', makeSession('sess-1', null, null));
  store.sessions.set('sess-2', makeSession('sess-2', null, null));
  const ok = await api.methods['model/setSessionThinkingLevel']({
    sessionId: 'sess-1',
    level: 'high',
  });
  assert.equal(ok.code, 0);
  assert.equal(ok.data, null);
  // mock service 层语义：写会话1 + 同步全局默认 ThinkLevel
  assert.equal(store.sessions.get('sess-1')?.thinkingLevel, 'high');
  assert.equal(store.getSetting('thinkingLevel'), 'high', 'setSessionThinkingLevel 应同步全局默认');
  assert.equal(
    store.sessions.get('sess-2')?.thinkingLevel,
    null,
    '其他会话不受影响',
  );
  // level=null 仅清除会话覆盖，不动全局默认
  const beforeClear = store.getSetting('thinkingLevel');
  const cleared = await api.methods['model/setSessionThinkingLevel']({
    sessionId: 'sess-1',
    level: null,
  });
  assert.equal(cleared.code, 0);
  assert.equal(store.sessions.get('sess-1')?.thinkingLevel, null);
  assert.equal(store.getSetting('thinkingLevel'), beforeClear, 'null 仅清覆盖不改全局默认');
  // 非法 level → 1001；未知会话 → 1002
  const badLevel = await api.methods['model/setSessionThinkingLevel']({
    sessionId: 'sess-1',
    level: 'ultra',
  });
  assert.equal(badLevel.code, 1001);
  const unknown = await api.methods['model/setSessionThinkingLevel']({
    sessionId: 'nope',
    level: 'high',
  });
  assert.equal(unknown.code, 1002);
  // 参数校验：sessionId 缺失 / level 非字符串 → 1001
  assert.equal((await api.methods['model/setSessionThinkingLevel']({})).code, 1001);
  assert.equal(
    (await api.methods['model/setSessionThinkingLevel']({ sessionId: 'sess-1', level: 1 })).code,
    1001,
  );
});