/**
 * 模型与 Provider 配置服务（modelService）单元测试。
 *
 * 覆盖 docs/test/05_model/coverage-matrix.md 本 WU 用例：
 * - U-MP-001：非法 baseUrl / 空 apiKey / 空 models 校验失败，不写文件（AC-MP-003）
 * - U-MP-002：v1 明文落盘，models.json 直接含 apiKey 明文（AC-MP-002 放宽）
 * 以及本 WU 契约：幂等覆盖更新、删除联动重置默认、setDefault 校验、会话模型
 * 优先级与隔离。keychain 安全引用为后续迭代保留，v1 不启用。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；models.json / keychain / store 均注入
 * mock（服务不 import fs / pi / OS keychain）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  ModelService,
  THINKING_LEVELS,
  DEFAULT_THINKING_LEVELS,
  buildThinkingLevelMap,
} from '../../src/model/modelService.ts';
import type {
  KeychainAdapter,
  ModelStorePort,
  ModelsFileAdapter,
  ProviderFileRecord,
  SaveProviderInput,
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
  /** 是否支持读取明文（缺省支持，映射 providerId -> 明文） */
  readBack: Record<string, string> = {};
  /** 显式置 undefined 模拟不支持 readKey 的适配器 */
  supportReadKey = true;
  stored: Array<{ providerId: string; apiKey: string }> = [];

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async storeKey(providerId: string, apiKey: string): Promise<string> {
    this.stored.push({ providerId, apiKey });
    this.readBack[providerId] = apiKey;
    return `!forge-secret get ${providerId}`;
  }

  // class 实现可选接口方法无需 `?`（Node 原生 strip-types 支持标准方法）
  async readKey(providerId: string): Promise<string | null> {
    if (!this.supportReadKey) return null;
    return this.readBack[providerId] ?? null;
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

test('saveProvider：合法配置写入，apiKey 明文落盘（v1，与 pi 原生一致 U-MP-002/AC-MP-002）', async () => {
  const { service, modelsFile, keychain } = makeService();
  const result = await service.saveProvider(validInput());
  assert.ok(result.ok);
  assert.equal(modelsFile.providers.length, 1);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  // v1 明文直写
  assert.equal(written.apiKey, 'sk-secret-123');
  assert.equal(written.name, 'OpenAI');
  assert.equal(written.baseUrl, 'https://api.openai.com/v1');
  assert.deepEqual(written.models, ['gpt-4o', 'gpt-4o-mini']);
  // 文件内容即明文
  const fileText = JSON.stringify(modelsFile.writeSnapshots);
  assert.ok(fileText.includes('sk-secret-123'));
  // v1 不经 keychain
  assert.equal(keychain.stored.length, 0);
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

test('saveProvider：v1 明文不受 keychain 可用性影响，仍明文落盘', async () => {
  const { service, modelsFile, keychain } = makeService();
  keychain.available = false;
  const result = await service.saveProvider(validInput());
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.apiKey, 'sk-secret-123');
  assert.ok(JSON.stringify(modelsFile.writeSnapshots).includes('sk-secret-123'));
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

test('queryProviderList：引用形式 apiKey（$VAR/!cmd）且 keychain 支持读取时返回明文（编辑回显用）', async () => {
  const { service, modelsFile, keychain } = makeService();
  modelsFile.providers = [
    {
      id: 'minimax',
      name: 'MiniMax',
      type: 'openai-completions',
      baseUrl: 'https://api.minimax.com/v1',
      models: ['MiniMax-M3'],
      lastError: null,
      apiKey: '$FORGE_MINIMAX_M3_API_KEY',
    },
  ];
  keychain.readBack['minimax'] = 'sk-real-minimax-secret';
  const list = await service.queryProviderList();
  assert.ok(list.ok);
  if (list.ok) {
    assert.equal(list.data.providers[0]?.apiKey, 'sk-real-minimax-secret');
  }
});

test('queryProviderList：keychain 不支持读取时保留引用，不回显明文', async () => {
  const { service, modelsFile, keychain } = makeService();
  modelsFile.providers = [
    {
      id: 'minimax',
      name: 'MiniMax',
      type: 'openai-completions',
      baseUrl: 'https://api.minimax.com/v1',
      models: ['MiniMax-M3'],
      lastError: null,
      apiKey: '$FORGE_MINIMAX_M3_API_KEY',
    },
  ];
  keychain.supportReadKey = false;
  const list = await service.queryProviderList();
  assert.ok(list.ok);
  if (list.ok) {
    assert.equal(list.data.providers[0]?.apiKey, '$FORGE_MINIMAX_M3_API_KEY');
  }
});

test('queryProviderList：明文 apiKey 原样返回（与既有行为一致）', async () => {
  const { service, modelsFile } = makeService();
  modelsFile.providers = [
    {
      id: 'grok',
      name: 'Grok',
      type: 'openai-completions',
      baseUrl: 'https://xuseny.online/v1',
      models: ['grok-4.5'],
      lastError: null,
      apiKey: 'sk-plain-grok-key',
    },
  ];
  const list = await service.queryProviderList();
  assert.ok(list.ok);
  if (list.ok) {
    assert.equal(list.data.providers[0]?.apiKey, 'sk-plain-grok-key');
  }
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
// ===== P3-D：配置变更审计日志 =====

test('P3-D：saveProvider/deleteProvider/setDefault 触发审计且不含密钥', async () => {
  const modelsFile = new MockModelsFileAdapter();
  const keychain = new MockKeychainAdapter();
  const store = new MockModelStore();
  const auditEvents: Array<{ action: string; providerId: string; ts: string }> = [];
  const service = new ModelService({
    modelsFile,
    keychain,
    store,
    audit: (e) => auditEvents.push(e),
  });

  await service.saveProvider(validInput({ name: 'Test', id: 'test-provider', models: ['m1'], apiKey: 'sk-super-sec-secret' }));
  modelsFile.modelNames = ['m1']; // mock 的 readModelNames 独立于 providers（其余测试同约定）
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, 'provider.saved');
  assert.equal(auditEvents[0]?.providerId, 'test-provider');
  assert.ok(auditEvents[0]?.ts);

  await service.setDefault('m1');
  assert.equal(auditEvents.length, 2);
  assert.equal(auditEvents[1]?.action, 'model.defaultChanged');

  await service.deleteProvider('test-provider');
  assert.equal(auditEvents.length, 3);
  assert.equal(auditEvents[2]?.action, 'provider.deleted');
  assert.equal(auditEvents[2]?.providerId, 'test-provider');

  // 审计载荷绝不含 apiKey 明文
  const serialized = JSON.stringify(auditEvents);
  assert.ok(!serialized.includes('sk-super-sec-secret'), '审计日志不得含密钥明文');
});

test('P3-D：未注入审计回调时配置变更不报错', async () => {
  const { service } = makeService();
  const saved = await service.saveProvider(validInput({ id: 'no-audit', models: ['m1'] }));
  assert.equal(saved.ok, true);
  assert.equal((await service.deleteProvider('no-audit')).ok, true);
});

// ===== MP-S06：contextWindow 上下文窗口 =====
test('saveProvider：contextWindow=1000000 透传到 writeProviders 记录（AC-MP-015）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ id: 'openai', models: ['gpt-4o'], contextWindow: 1000000 }),
  );
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.contextWindow, 1000000);
});

test('saveProvider：contextWindow=null 透传移除字段（AC-MP-016/017）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ id: 'openai', models: ['gpt-4o'], contextWindow: null }),
  );
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.contextWindow, null);
});

test('saveProvider：非法 contextWindow（负数/字符串/0）返回 1001，不写入', async () => {
  const { service, modelsFile } = makeService();
  const negative = await service.saveProvider(validInput({ id: 'a', contextWindow: -1 }));
  assert.ok(!negative.ok);
  if (!negative.ok) {
    assert.equal(negative.code, 1001);
  }
  const str = await service.saveProvider(
    validInput({ id: 'b', models: ['m'], contextWindow: '1000000' as unknown as number }),
  );
  assert.ok(!str.ok);
  if (!str.ok) {
    assert.equal(str.code, 1001);
  }
  const zero = await service.saveProvider(validInput({ id: 'c', contextWindow: 0 }));
  assert.ok(!zero.ok);
  if (!zero.ok) {
    assert.equal(zero.code, 1001);
  }
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：未提供 contextWindow 时记录不携带该字段（缺省保留不篡改）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(validInput({ id: 'openai', models: ['gpt-4o'] }));
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.ok(!('contextWindow' in written), '缺省不应携带 contextWindow 字段');
});

test('queryProviderList：透出 contextWindow 原值（1000000 与 null，AC-MP-018）', async () => {
  const { service, modelsFile } = makeService();
  modelsFile.providers = [
    { id: 'a', name: 'A', type: 'openai', baseUrl: null, models: ['gpt-4o'], lastError: null, contextWindow: 1000000 },
    { id: 'b', name: 'B', type: 'openai', baseUrl: null, models: ['claude'], lastError: null, contextWindow: null },
  ];
  const list = await service.queryProviderList();
  assert.ok(list.ok);
  if (list.ok) {
    assert.equal(list.data.providers[0]?.contextWindow, 1000000);
    assert.equal(list.data.providers[1]?.contextWindow, null);
  }
});

// ===== MP-S05：思考级别端口与方法 =====

/** 思考级别端口 mock：model -> 级别列表；缺省视为模型未配置（返回 null → 1004） */
class MockThinkLevelsPort implements ThinkLevelsPort {
  partial: Record<string, string[] | null> = {};

  async getSupportedThinkingLevels(model: string): Promise<string[] | null> {
    return this.partial[model] === undefined ? null : this.partial[model];
  }
}

/** 构造注入 ThinkLevelsPort 的服务 */
function makeServiceWithThinkLevels(): {
  service: ModelService;
  modelsFile: MockModelsFileAdapter;
  keychain: MockKeychainAdapter;
  store: MockModelStore;
  thinkLevels: MockThinkLevelsPort;
} {
  const base = makeService();
  const thinkLevels = new MockThinkLevelsPort();
  const service = new ModelService({
    modelsFile: base.modelsFile,
    keychain: base.keychain,
    store: base.store,
    thinkLevels,
  });
  return { service, modelsFile: base.modelsFile, keychain: base.keychain, store: base.store, thinkLevels };
}

test('getModelThinkingLevels：成功返回级别列表；模型未配置返回 1004（AC-MP-010）', async () => {
  const { service, thinkLevels } = makeServiceWithThinkLevels();
  thinkLevels.partial['gpt-4o'] = ['off', 'low', 'medium', 'high'];
  const ok = await service.getModelThinkingLevels('gpt-4o');
  assert.ok(ok.ok);
  if (ok.ok) {
    // MP-S07：推理模型的可用级别不向对话框暴露 off
    assert.deepEqual(ok.data.levels, ['low', 'medium', 'high']);
  }
  const unconfigured = await service.getModelThinkingLevels('unknown-model');
  assert.ok(!unconfigured.ok);
  if (!unconfigured.ok) {
    assert.equal(unconfigured.code, 1004);
  }
});

test('getModelThinkingLevels：非推理模型 levels=["off"] 原样返回（切换器隐藏判断保留）', async () => {
  const { service, thinkLevels } = makeServiceWithThinkLevels();
  thinkLevels.partial['plain'] = ['off'];
  const ok = await service.getModelThinkingLevels('plain');
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.deepEqual(ok.data.levels, ['off']);
  }
});

test('getModelThinkingLevels：参数为空返回 1001；能力端口未注入返回 5000', async () => {
  const { service } = makeServiceWithThinkLevels();
  const empty = await service.getModelThinkingLevels('  ');
  assert.ok(!empty.ok);
  if (!empty.ok) {
    assert.equal(empty.code, 1001);
  }
  const noPort = makeService();
  const portless = await noPort.service.getModelThinkingLevels('gpt-4o');
  assert.ok(!portless.ok);
  if (!portless.ok) {
    assert.equal(portless.code, 5000);
  }
});

test('getSessionThinkingLevel：会话覆盖优先，无覆盖回退全局（effective 正确，AC-MP-012）', async () => {
  const { service, store } = makeService();
  store.setSetting('thinkingLevel', 'off');
  store.sessions.set('sess-1', { ...makeSession('sess-1'), thinkingLevel: 'high' });
  store.sessions.set('sess-2', { ...makeSession('sess-2'), thinkingLevel: null });
  const s1 = await service.getSessionThinkingLevel('sess-1');
  assert.ok(s1.ok);
  if (s1.ok) {
    assert.equal(s1.data.level, 'high');
    assert.equal(s1.data.effective, 'session');
  }
  const s2 = await service.getSessionThinkingLevel('sess-2');
  assert.ok(s2.ok);
  if (s2.ok) {
    assert.equal(s2.data.level, 'off');
    assert.equal(s2.data.effective, 'global');
  }
});

test('getSessionThinkingLevel：未知会话返回 1002', async () => {
  const { service } = makeService();
  const result = await service.getSessionThinkingLevel('nope');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1002);
  }
});

test('getSessionThinkingLevel：sessionId=null 查全局默认（草稿态，新会话继承全局）', async () => {
  const { service, store } = makeService();
  store.setSetting('thinkingLevel', 'medium');
  const res = await service.getSessionThinkingLevel(null);
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.data.level, 'medium');
    assert.equal(res.data.effective, 'global');
  }
});

test('getSessionThinkingLevel：settings 缺失 thinkingLevel（旧数据兜底）按 off 处理', async () => {
  const { service, store } = makeService();
  // 不写入 thinkingLevel —— 模拟旧数据缺失该键
  store.sessions.set('sess-1', { ...makeSession('sess-1'), thinkingLevel: null });
  const res = await service.getSessionThinkingLevel('sess-1');
  assert.ok(res.ok);
  if (res.ok) {
    assert.equal(res.data.level, 'off');
    assert.equal(res.data.effective, 'global');
  }
});

test('setSessionThinkingLevel：合法级别写会话并同步全局，其他会话不受污染（AC-MP-012）', async () => {
  const { service, store } = makeService();
  store.sessions.set('sess-1', { ...makeSession('sess-1'), thinkingLevel: null });
  store.sessions.set('sess-2', { ...makeSession('sess-2'), thinkingLevel: null });
  store.setSetting('thinkingLevel', 'off');
  const result = await service.setSessionThinkingLevel('sess-1', 'high');
  assert.ok(result.ok);
  assert.equal(store.sessions.get('sess-1')?.thinkingLevel, 'high');
  assert.equal(store.sessions.get('sess-2')?.thinkingLevel, null);
  assert.equal(store.getSetting('thinkingLevel'), 'high');
});

test('setSessionThinkingLevel：null 清除会话覆盖，不动全局默认（AC-MP-012）', async () => {
  const { service, store } = makeService();
  store.sessions.set('sess-1', { ...makeSession('sess-1'), thinkingLevel: 'high' });
  store.setSetting('thinkingLevel', 'high');
  const result = await service.setSessionThinkingLevel('sess-1', null);
  assert.ok(result.ok);
  assert.equal(store.sessions.get('sess-1')?.thinkingLevel, null);
  assert.equal(store.getSetting('thinkingLevel'), 'high');
});

test('setSessionThinkingLevel：非法级别返回 1001 不写入会话与全局（AC-MP-012）', async () => {
  const { service, store } = makeService();
  store.sessions.set('sess-1', { ...makeSession('sess-1'), thinkingLevel: null });
  store.setSetting('thinkingLevel', 'off');
  const bad = await service.setSessionThinkingLevel('sess-1', 'ultra');
  assert.ok(!bad.ok);
  if (!bad.ok) {
    assert.equal(bad.code, 1001);
  }
  assert.equal(store.sessions.get('sess-1')?.thinkingLevel, null);
  assert.equal(store.getSetting('thinkingLevel'), 'off');
});

test('setSessionThinkingLevel：未知会话返回 1002', async () => {
  const { service } = makeService();
  const result = await service.setSessionThinkingLevel('nope', 'high');
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1002);
  }
});

// ===== 多模态：vision 勾选（input 能力字段） =====

test('saveProvider：vision=true 透传到 writeProviders 记录（写 input:["text","image"] 由 adapter 落盘）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ id: 'minimax', models: ['MiniMax-M3'], vision: true }),
  );
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.vision, true);
});

test('saveProvider：vision=false 透传移除语义（adapter 移除 input 字段）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ id: 'text-only', models: ['plain'], vision: false }),
  );
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.vision, false);
});

test('saveProvider：非法 vision（非布尔）返回 1001，不写入', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ id: 'a', models: ['m'], vision: 'yes' as unknown as boolean }),
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1001);
  }
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：vision 缺省不携带字段（保留原值，不覆盖手工 input 能力）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(validInput({ id: 'b', models: ['m'] }));
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.vision, undefined);
});

// ===== MP-S07：思考强度（reasoning）与思考等级白名单（thinkingLevels） =====

test('buildThinkingLevelMap：选中=级别名，未选=null，全量 7 项（AC-MP-023）', () => {
  assert.deepEqual(buildThinkingLevelMap(['high', 'max'] as const), {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  });
  // 显式传 off 也可（纯函数，调用方决定；forge UI 不传 -> off:null 隐藏）
  assert.deepEqual(buildThinkingLevelMap(['off', 'high'] as const), {
    off: 'off',
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
    max: null,
  });
  // 全选
  const all = buildThinkingLevelMap(THINKING_LEVELS);
  assert.deepEqual(all, {
    off: 'off',
    minimal: 'minimal',
    low: 'low',
    medium: 'medium',
    high: 'high',
    xhigh: 'xhigh',
    max: 'max',
  });
  // 空选：全 null
  assert.deepEqual(buildThinkingLevelMap([]), {
    off: null,
    minimal: null,
    low: null,
    medium: null,
    high: null,
    xhigh: null,
    max: null,
  });
});

test('DEFAULT_THINKING_LEVELS：minimal/low/medium/high（xhigh/max 需显式开启，off 不参与）', () => {
  assert.deepEqual([...DEFAULT_THINKING_LEVELS], ['minimal', 'low', 'medium', 'high']);
});

test('saveProvider：reasoning + thinkingLevels 透传到 writeProviders 记录（AC-MP-023/024）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ id: 'openai', models: ['gpt-4o'], reasoning: true, thinkingLevels: ['high', 'max'] }),
  );
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.reasoning, true);
  assert.deepEqual(written.thinkingLevels, ['high', 'max']);
});

test('saveProvider：reasoning=false + thinkingLevels=null 透传（移除 thinkingLevelMap）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ id: 'openai', models: ['gpt-4o'], reasoning: false, thinkingLevels: null }),
  );
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal(written.reasoning, false);
  assert.equal(written.thinkingLevels, null);
});

test('saveProvider：非法 reasoning/thinkingLevels 返回 1001，不写入（AC-MP-026）', async () => {
  const { service, modelsFile } = makeService();
  // reasoning 非布尔
  const badReasoning = await service.saveProvider(
    validInput({ id: 'a', models: ['m'], reasoning: 'yes' as unknown as boolean }),
  );
  assert.ok(!badReasoning.ok);
  if (!badReasoning.ok) {
    assert.equal(badReasoning.code, 1001);
  }
  // thinkingLevels 含非法级别
  const badLevel = await service.saveProvider(
    validInput({ id: 'b', models: ['m'], thinkingLevels: ['off', 'ultra' as const] }),
  );
  assert.ok(!badLevel.ok);
  if (!badLevel.ok) {
    assert.equal(badLevel.code, 1001);
  }
  // thinkingLevels 重复
  const dupLevel = await service.saveProvider(
    validInput({ id: 'c', models: ['m'], thinkingLevels: ['off', 'off'] }),
  );
  assert.ok(!dupLevel.ok);
  if (!dupLevel.ok) {
    assert.equal(dupLevel.code, 1001);
  }
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：reasoning/thinkingLevels 缺省不携带字段（保留原值）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(validInput({ id: 'openai', models: ['gpt-4o'] }));
  assert.ok(result.ok);
  const written = modelsFile.writeSnapshots[0]?.[0];
  assert.ok(written !== undefined);
  assert.equal('reasoning' in written, false);
  assert.equal('thinkingLevels' in written, false);
});
