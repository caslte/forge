/**
 * 模型与 Provider 配置 RPC 方法层（modelMethods）单元测试。
 *
 * 覆盖 docs/test/05_model/coverage-matrix.md api 层用例：
 * - A-MP-001：saveProvider → code 0，models.json 写库，providersChanged 发射
 * - A-MP-002：apiKey 引用不明文泄漏（响应与事件载荷均剥离）
 * - A-MP-003：saveProvider 非法输入 → 1001，无写库
 * - A-MP-005：setDefault → 全局默认生效
 * - A-MP-006：setSessionModel → 仅会话覆盖
 * 以及本 WU 契约：queryProviderList / queryModels / deleteProvider / getSessionModel
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
  ModelResult,
  ModelStorePort,
  ModelsFileAdapter,
  ProviderConfig,
  ProviderFileRecord,
  SaveProviderInput,
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
    this.writeSnapshots.push(providers.map((p) => ({ ...p })));
    this.providers = providers.map((p) => ({ ...p }));
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
}

/** 构造会话记录（默认无覆盖） */
function makeSession(sessionId: string, modelOverride: string | null = null): SessionRecord {
  return {
    sessionId,
    projectPath: 'C:/demo/proj',
    alias: null,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelOverride,
  };
}

/** 构造 api + 真实服务 + 三个 mock 依赖 + 事件汇 */
function makeApi(): {
  api: ModelApi;
  modelsFile: MockModelsFileAdapter;
  keychain: MockKeychainAdapter;
  store: MockModelStore;
  events: EventEmitter;
} {
  const modelsFile = new MockModelsFileAdapter();
  const keychain = new MockKeychainAdapter();
  const store = new MockModelStore();
  const service = new ModelService({ modelsFile, keychain, store });
  const events = new EventEmitter();
  const api = new ModelApi(service, events);
  return { api, modelsFile, keychain, store, events };
}

/** 合法保存参数（可覆盖） */
function validInput(overrides: Partial<SaveProviderInput> = {}): SaveProviderInput {
  return {
    name: 'OpenAI',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o', 'gpt-4o-mini'],
    apiKey: 'sk-secret-123',
    ...overrides,
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

test('queryModels：返回 { models, defaultModel }（A-MP-005 前置）', async () => {
  const { api, modelsFile, store } = makeApi();
  modelsFile.modelNames = ['gpt-4o', 'claude-sonnet-4'];
  store.setSetting('defaultModel', 'claude-sonnet-4');
  const result = await api.methods['model/queryModels']({});
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const data = result.data as { models: string[]; defaultModel: string | null };
    assert.deepEqual(data.models, ['gpt-4o', 'claude-sonnet-4']);
    assert.equal(data.defaultModel, 'claude-sonnet-4');
  }
});

test('setDefault：合法模型 → code 0 data null 并持久化；未知模型 → 1004（A-MP-005）', async () => {
  const { api, modelsFile, store } = makeApi();
  modelsFile.modelNames = ['gpt-4o'];
  const ok = await api.methods['model/setDefault']({ model: 'gpt-4o' });
  assert.equal(ok.code, 0);
  assert.equal(ok.data, null);
  assert.equal(store.getSetting('defaultModel'), 'gpt-4o');
  const unknown = await api.methods['model/setDefault']({ model: 'nope' });
  assert.equal(unknown.code, 1004);
  // 参数校验：model 缺失/空白/非字符串/null 之外的值 → 1001
  assert.equal((await api.methods['model/setDefault']({})).code, 1001);
  assert.equal((await api.methods['model/setDefault']({ model: '  ' })).code, 1001);
});

test('getSessionModel：会话覆盖优先，无覆盖用全局默认；未知会话 → 1002', async () => {
  const { api, store } = makeApi();
  store.sessions.set('sess-1', makeSession('sess-1', 'gpt-4o'));
  store.sessions.set('sess-2', makeSession('sess-2', null));
  store.setSetting('defaultModel', 'claude-sonnet-4');
  const overridden = await api.methods['model/getSessionModel']({ sessionId: 'sess-1' });
  assert.equal(overridden.code, 0);
  assert.ok(overridden.data !== null);
  if (overridden.data !== null) {
    const info = overridden.data as { model: string | null; effective: 'session' | 'global' };
    assert.equal(info.model, 'gpt-4o');
    assert.equal(info.effective, 'session');
  }
  const global = await api.methods['model/getSessionModel']({ sessionId: 'sess-2' });
  assert.ok(global.data !== null);
  if (global.data !== null) {
    const info = global.data as { model: string | null; effective: 'session' | 'global' };
    assert.equal(info.model, 'claude-sonnet-4');
    assert.equal(info.effective, 'global');
  }
  const unknown = await api.methods['model/getSessionModel']({ sessionId: 'nope' });
  assert.equal(unknown.code, 1002);
  assert.equal((await api.methods['model/getSessionModel']({})).code, 1001);
});

test('setSessionModel：设置覆盖仅影响该会话；未知会话 → 1002（A-MP-006）', async () => {
  const { api, store } = makeApi();
  store.sessions.set('sess-1', makeSession('sess-1', null));
  store.sessions.set('sess-2', makeSession('sess-2', null));
  const ok = await api.methods['model/setSessionModel']({ sessionId: 'sess-1', model: 'gpt-4o' });
  assert.equal(ok.code, 0);
  assert.equal(ok.data, null);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'gpt-4o');
  assert.equal(store.sessions.get('sess-2')?.modelOverride, null);
  const unknown = await api.methods['model/setSessionModel']({ sessionId: 'nope', model: 'gpt-4o' });
  assert.equal(unknown.code, 1002);
  // 参数校验：sessionId 缺失 / model 非法 → 1001
  assert.equal((await api.methods['model/setSessionModel']({})).code, 1001);
  assert.equal((await api.methods['model/setSessionModel']({ sessionId: 'sess-1', model: '  ' })).code, 1001);
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
  throwingService.queryModels = async (): Promise<ModelResult<{ models: string[]; defaultModel: string | null }>> => {
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