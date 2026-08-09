/**
 * 模型与 Provider 配置服务（modelService）单元测试。
 *
 * 覆盖 docs/test/05_model/coverage-matrix.md 本 WU 用例：
 * - U-MP-001：非法 baseUrl / 空 apiKey / 空 models 校验失败，不写文件（AC-MP-003）
 * - U-MP-002：apiKey 不明文落盘，models.json 只含安全引用（AC-MP-002）
 * 以及本 WU 契约：幂等覆盖更新、删除联动重置默认、setDefault 校验、会话模型
 * 优先级与隔离、keychain 不可用降级 $ENV_VAR。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；models.json / keychain / store 均注入
 * mock（服务不 import fs / pi / OS keychain）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ModelService } from '../../src/model/modelService.ts';
import type {
  KeychainAdapter,
  ModelStorePort,
  ModelsFileAdapter,
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

/** keychain 适配器 mock：可配置可用性，记录存储调用，返回 `!forge-secret get <id>` 引用 */
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

/** 构造服务 + 三个 mock 依赖 */
function makeService(): {
  service: ModelService;
  modelsFile: MockModelsFileAdapter;
  keychain: MockKeychainAdapter;
  store: MockModelStore;
} {
  const modelsFile = new MockModelsFileAdapter();
  const keychain = new MockKeychainAdapter();
  const store = new MockModelStore();
  const service = new ModelService({ modelsFile, keychain, store });
  return { service, modelsFile, keychain, store };
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

test('saveProvider：合法配置写入，apiKey 不明文落盘（U-MP-002/AC-MP-002）', async () => {
  const { service, modelsFile, keychain } = makeService();
  const result = await service.saveProvider(validInput());
  assert.ok(result.ok);
  assert.equal(modelsFile.providers.length, 1);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.apiKey, '!forge-secret get openai');
  assert.equal(written.name, 'OpenAI');
  assert.equal(written.baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(written.models, ['gpt-4o', 'gpt-4o-mini']);
  // 文件内容不含明文 key
  const fileText = JSON.stringify(modelsFile.writeSnapshots);
  assert.ok(!fileText.includes('sk-secret-123'));
  // keychain 收到明文
  assert.equal(keychain.stored.length, 1);
  assert.equal(keychain.stored[0]?.apiKey, 'sk-secret-123');
});

test('saveProvider：非法 baseUrl 返回 1001，不写入（U-MP-001/AC-MP-003）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(validInput({ baseUrl: 'http://' }));
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1001);
  }
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：空 models / 缺失 name 返回 1001，不写入（U-MP-001/AC-MP-003）', async () => {
  const { service, modelsFile } = makeService();
  const emptyModels = await service.saveProvider(validInput({ models: [] }));
  assert.ok(!emptyModels.ok);
  if (!emptyModels.ok) {
    assert.equal(emptyModels.code, 1001);
  }
  const missingName = await service.saveProvider(validInput({ name: '  ' }));
  assert.ok(!missingName.ok);
  if (!missingName.ok) {
    assert.equal(missingName.code, 1001);
  }
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：空 apiKey 返回 1001，不写入（U-MP-001/AC-MP-003）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(validInput({ apiKey: '   ' }));
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1001);
  }
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：同 id 重复保存覆盖更新，幂等（AC-MP-001 幂等）', async () => {
  const { service, modelsFile } = makeService();
  const first = await service.saveProvider(validInput({ id: 'openai', models: ['gpt-4o'] }));
  assert.ok(first.ok);
  const second = await service.saveProvider(
    validInput({ id: 'openai', models: ['gpt-4o', 'gpt-4o-mini'] }),
  );
  assert.ok(second.ok);
  assert.equal(modelsFile.providers.length, 1);
  assert.deepEqual(modelsFile.providers[0]?.models, ['gpt-4o', 'gpt-4o-mini']);
});

test('saveProvider：keychain 不可用降级 $ENV_VAR 引用，仍保存（AC-MP-004）', async () => {
  const { service, modelsFile, keychain } = makeService();
  keychain.available = false;
  const result = await service.saveProvider(validInput());
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.apiKey, '$FORGE_OPENAI_API_KEY');
  assert.ok(!JSON.stringify(modelsFile.writeSnapshots).includes('sk-secret-123'));
  assert.equal(keychain.stored.length, 0);
});

test('deleteProvider：删除 provider 并重置其所属全局默认模型', async () => {
  const { service, modelsFile, store } = makeService();
  await service.saveProvider(validInput({ id: 'openai', models: ['gpt-4o'] }));
  store.setSetting('defaultModel', 'gpt-4o');
  const result = await service.deleteProvider('openai');
  assert.ok(result.ok);
  assert.equal(modelsFile.providers.length, 0);
  assert.equal(store.getSetting('defaultModel'), null);
});

test('deleteProvider：未知 provider 返回 1002', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.deleteProvider('nope');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1002);
  }
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('setDefault：合法模型持久化到 store；未知模型返回 1004', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.modelNames = ['gpt-4o', 'claude-sonnet-4'];
  const ok = await service.setDefault('gpt-4o');
  assert.ok(ok.ok);
  assert.equal(store.getSetting('defaultModel'), 'gpt-4o');
  const unknown = await service.setDefault('nope');
  assert.ok(!unknown.ok);
  if (!unknown.ok) {
    assert.equal(unknown.code, 1004);
  }
  assert.equal(store.getSetting('defaultModel'), 'gpt-4o');
});

test('getSessionModel：会话覆盖优先，无覆盖用全局默认', async () => {
  const { service, store } = makeService();
  store.sessions.set('sess-1', makeSession('sess-1', 'gpt-4o'));
  store.sessions.set('sess-2', makeSession('sess-2', null));
  store.setSetting('defaultModel', 'claude-sonnet-4');
  const overridden = await service.getSessionModel('sess-1');
  assert.ok(overridden.ok);
  if (overridden.ok) {
    assert.equal(overridden.data.model, 'gpt-4o');
    assert.equal(overridden.data.effective, 'session');
  }
  const global = await service.getSessionModel('sess-2');
  assert.ok(global.ok);
  if (global.ok) {
    assert.equal(global.data.model, 'claude-sonnet-4');
    assert.equal(global.data.effective, 'global');
  }
});

test('getSessionModel：未知会话返回 1002', async () => {
  const { service } = makeService();
  const result = await service.getSessionModel('nope');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1002);
  }
});

test('setSessionModel：设置/清除覆盖，仅影响该会话', async () => {
  const { service, store } = makeService();
  store.sessions.set('sess-1', makeSession('sess-1', null));
  store.sessions.set('sess-2', makeSession('sess-2', null));
  const set = await service.setSessionModel('sess-1', 'gpt-4o');
  assert.ok(set.ok);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'gpt-4o');
  assert.equal(store.sessions.get('sess-2')?.modelOverride, null);
  const clear = await service.setSessionModel('sess-1', null);
  assert.ok(clear.ok);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, null);
});

test('queryProviderList / queryModels：从适配器与 store 读取', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [
    {
      id: 'openai',
      name: 'OpenAI',
      type: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      models: ['gpt-4o'],
      lastError: null,
    },
  ];
  modelsFile.modelNames = ['gpt-4o', 'claude-sonnet-4'];
  store.setSetting('defaultModel', 'claude-sonnet-4');
  const list = await service.queryProviderList();
  assert.ok(list.ok);
  if (list.ok) {
    assert.equal(list.data.providers.length, 1);
    assert.equal(list.data.providers[0]?.id, 'openai');
  }
  const models = await service.queryModels();
  assert.ok(models.ok);
  if (models.ok) {
    assert.deepEqual(models.data.models, ['gpt-4o', 'claude-sonnet-4']);
    assert.equal(models.data.defaultModel, 'claude-sonnet-4');
  }
});

test('adapter 异常统一返回 5000 错误联合', async () => {
  const { service, modelsFile } = makeService();
  modelsFile.readError = new Error('read boom');
  const list = await service.queryProviderList();
  assert.ok(!list.ok);
  if (!list.ok) {
    assert.equal(list.code, 5000);
  }
  modelsFile.readError = null;
  modelsFile.writeError = new Error('write boom');
  const save = await service.saveProvider(validInput());
  assert.ok(!save.ok);
  if (!save.ok) {
    assert.equal(save.code, 5000);
  }
});