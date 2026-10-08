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
    // 与 piModelsFileAdapter 同构：models.json 以 provider 别名（name）为 key，
    // 读回时 id === name —— 锚点语义（modelService 设计决策 6）依赖这条不变量
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

  listSessions(): SessionRecord[] {
    return [...this.sessions.values()].map((s) => ({ ...s }));
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

/** 合法保存参数（可覆盖）。name 即别名锚点，与 id 同名对齐 pi 侧口径（readProviders 的 id === name） */
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

/** 构造 provider 配置记录（id === name，与 pi models.json 的 provider key 口径一致） */
function makeProvider(id: string, models: string[]): ProviderFileRecord {
  return {
    id,
    name: id,
    type: 'openai-completions',
    baseUrl: 'https://example.test/v1',
    models,
    lastError: null,
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
  assert.equal(written.name, 'openai');
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

test('deleteProvider：删除 provider 并重置其全局默认（别名锚点与存量裸模型 ID 两种形态）', async () => {
  const { service, modelsFile, store } = makeService();
  await service.saveProvider(validInput({ id: 'openai', models: ['gpt-4o'] }));
  // 存量形态：defaultModel 存的是裸模型 ID，按其归属命中
  store.setSetting('defaultModel', 'gpt-4o');
  const result = await service.deleteProvider('openai');
  assert.ok(result.ok);
  assert.equal(modelsFile.providers.length, 0);
  assert.equal(store.getSetting('defaultModel'), null);

  await service.saveProvider(validInput({ id: 'openai', models: ['gpt-4o'] }));
  // 新形态：defaultModel 存别名锚点
  store.setSetting('defaultModel', 'openai');
  assert.ok((await service.deleteProvider('openai')).ok);
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

test('setDefault：合法别名持久化到 store；未保存的配置返回 1004', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('openai', ['gpt-4o']), makeProvider('anthropic', ['claude-sonnet-4'])];
  const ok = await service.setDefault('openai');
  assert.ok(ok.ok);
  assert.equal(store.getSetting('defaultModel'), 'openai');
  const unknown = await service.setDefault('nope');
  assert.ok(!unknown.ok);
  if (!unknown.ok) {
    assert.equal(unknown.code, 1004);
  }
  assert.equal(store.getSetting('defaultModel'), 'openai');
});

test('setDefault：别名可含空格（pi provider key 原样），不做模型 ID 形态校验', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('Grok 4.5', ['grok-4.5'])];
  assert.ok((await service.setDefault('Grok 4.5')).ok);
  assert.equal(store.getSetting('defaultModel'), 'Grok 4.5');
});

test('setDefault：改配置的模型 ID 后，主会话解析自动跟到新模型（本次回归的根因）', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3'])];
  assert.ok((await service.setDefault('mx')).ok);
  let models = await service.queryModels();
  assert.ok(models.ok);
  assert.deepEqual(models.data.options, [{ providerId: 'mx', model: 'MiniMax-M3' }]);

  // 用户在设置里把模型 ID 改成 MiniMax-M3.1-Flash-Preview（别名不变）
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3.1-Flash-Preview'])];
  models = await service.queryModels();
  assert.ok(models.ok);
  assert.equal(models.data.defaultProviderId, 'mx', '锚点不变，卡片徽标继续命中');
  assert.deepEqual(models.data.options, [{ providerId: 'mx', model: 'MiniMax-M3.1-Flash-Preview' }]);
  assert.equal(store.getSetting('defaultModel'), 'mx');
});

test('getSessionModel：会话覆盖锚点优先，无覆盖用全局默认锚点，两者都返回派生模型 ID', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3']), makeProvider('fs', ['ark-code-latest'])];
  store.sessions.set('sess-1', makeSession('sess-1', 'mx'));
  store.sessions.set('sess-2', makeSession('sess-2', null));
  store.setSetting('defaultModel', 'fs');
  const overridden = await service.getSessionModel('sess-1');
  assert.ok(overridden.ok);
  if (overridden.ok) {
    assert.equal(overridden.data.model, 'MiniMax-M3');
    assert.equal(overridden.data.providerId, 'mx');
    assert.equal(overridden.data.effective, 'session');
  }
  const global = await service.getSessionModel('sess-2');
  assert.ok(global.ok);
  if (global.ok) {
    assert.equal(global.data.model, 'ark-code-latest');
    assert.equal(global.data.providerId, 'fs');
    assert.equal(global.data.effective, 'global');
  }
});

test('getSessionModel：会话覆盖的模型 ID 被改后，该会话自动跟到新模型', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3'])];
  store.sessions.set('sess-1', makeSession('sess-1', 'mx'));
  const before = await service.getSessionModel('sess-1');
  assert.ok(before.ok);
  assert.equal(before.data.model, 'MiniMax-M3');

  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3.1-Flash-Preview'])];
  const after = await service.getSessionModel('sess-1');
  assert.ok(after.ok);
  assert.equal(after.data.model, 'MiniMax-M3.1-Flash-Preview');
  assert.equal(after.data.providerId, 'mx');
  assert.equal(after.data.effective, 'session');
});

test('getSessionModel：存量裸模型 ID 覆盖解析出归属后回写为别名（读时自愈，无需迁移脚本）', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3'])];
  store.sessions.set('sess-1', makeSession('sess-1', 'MiniMax-M3'));
  const first = await service.getSessionModel('sess-1');
  assert.ok(first.ok);
  assert.equal(first.data.model, 'MiniMax-M3');
  assert.equal(first.data.providerId, 'mx');
  // 读一次即落新形态
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'mx');
});

test('getSessionModel：全局默认的存量裸模型 ID 同样读时回写为别名', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3'])];
  store.setSetting('defaultModel', 'MiniMax-M3');
  store.sessions.set('sess-1', makeSession('sess-1', null));
  const global = await service.getSessionModel('sess-1');
  assert.ok(global.ok);
  if (global.ok) {
    assert.equal(global.data.providerId, 'mx');
    assert.equal(global.data.effective, 'global');
  }
  assert.equal(store.getSetting('defaultModel'), 'mx');
});

test('getSessionModel：覆盖悬空（配置已删）时降级到全局默认，不报错', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('fs', ['ark-code-latest'])];
  store.sessions.set('sess-1', makeSession('sess-1', 'gone'));
  store.setSetting('defaultModel', 'fs');
  const result = await service.getSessionModel('sess-1');
  assert.ok(result.ok);
  if (result.ok) {
    assert.equal(result.data.model, 'ark-code-latest');
    assert.equal(result.data.providerId, 'fs');
    assert.equal(result.data.effective, 'global');
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
  const set = await service.setSessionModel('sess-1', 'mx');
  assert.ok(set.ok);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'mx');
  assert.equal(store.sessions.get('sess-2')?.modelOverride, null);
  const clear = await service.setSessionModel('sess-1', null);
  assert.ok(clear.ok);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, null);
});

// ===== 回归：悬空模型 ID 不得被写入（改完模型后发消息报「模型未配置或不可用」）=====
//
// 现场：用户把 `MiniMax-M3.1-Flash-Preview` 手打成 `MiniMax M3.1-Flash-Preview`（空格版），
// saveProvider 只做 trim 就落盘 → 它成了全局默认与会话覆盖，而真正的解析发生在发消息时，
// 于是该会话此后每条消息都失败，只能进会话重选模型才能恢复。
// 守护点 1（唯一写入口 saveProvider）与守护点 2（会话覆盖写入）都要挡住。

test('saveProvider：模型 ID 含空格返回 1001，不写入（回归）', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(
    validInput({ models: ['MiniMax-M3.1-Flash-Preview', 'MiniMax M3.1-Flash-Preview'] }),
  );
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1001);
    assert.match(result.message, /空格/);
  }
  assert.equal(modelsFile.providers.length, 0);
  assert.equal(modelsFile.writeSnapshots.length, 0);
});

test('saveProvider：模型 ID 重复返回 1001，不写入', async () => {
  const { service, modelsFile } = makeService();
  const result = await service.saveProvider(validInput({ models: ['gpt-4o', 'gpt-4o'] }));
  assert.ok(!result.ok);
  if (!result.ok) {
    assert.equal(result.code, 1001);
  }
  assert.equal(modelsFile.providers.length, 0);
});

test('setSessionModel：providers 列表里没有的别名仍可写入（会话模型以 pi 运行时为准）', async () => {
  // 热切换场景：配置可能只存在于注入的 pi models.json，而不在本服务的 modelsFile 列表里。
  // 把列表当权威会凭空引入第二份真相，把合法切换误判成 1004。
  const { service, store, modelsFile } = makeService();
  modelsFile.providers = [];
  store.sessions.set('sess-1', makeSession('sess-1', null));
  const result = await service.setSessionModel('sess-1', 'forge-only-anchor');
  assert.ok(result.ok);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'forge-only-anchor');
});

test('setSessionModel：别名可含空格（写入口不按模型 ID 形态校验）；空别名返回 1001', async () => {
  const { service, store } = makeService();
  store.sessions.set('sess-1', makeSession('sess-1', null));
  // pi models.json 的 provider key 可以带空格（如 "Grok 4.5"），锚点必须照收
  const spaced = await service.setSessionModel('sess-1', 'Grok 4.5');
  assert.ok(spaced.ok);
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'Grok 4.5');
  const blank = await service.setSessionModel('sess-1', '   ');
  assert.ok(!blank.ok);
  if (!blank.ok) {
    assert.equal(blank.code, 1001);
  }
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

test('queryProviderList / queryModels：可选项按配置给出，默认给别名锚点', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('openai', ['gpt-4o']), makeProvider('anthropic', ['claude-sonnet-4'])];
  store.setSetting('defaultModel', 'anthropic');
  const list = await service.queryProviderList();
  assert.ok(list.ok);
  if (list.ok) {
    assert.equal(list.data.providers.length, 2);
    assert.equal(list.data.providers[0]?.id, 'openai');
  }
  const models = await service.queryModels();
  assert.ok(models.ok);
  if (models.ok) {
    assert.deepEqual(models.data.options, [
      { providerId: 'openai', model: 'gpt-4o' },
      { providerId: 'anthropic', model: 'claude-sonnet-4' },
    ]);
    assert.equal(models.data.defaultProviderId, 'anthropic');
  }
});

test('queryModels：无模型的空配置不进可选项（也无法成为默认）', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('openai', ['gpt-4o']), makeProvider('empty', [])];
  store.setSetting('defaultModel', 'empty');
  const models = await service.queryModels();
  assert.ok(models.ok);
  if (models.ok) {
    assert.deepEqual(models.data.options, [{ providerId: 'openai', model: 'gpt-4o' }]);
    // 锚点指向空配置：解析不出模型，默认按未配置降级
    assert.equal(models.data.defaultProviderId, null);
  }
  assert.ok(!(await service.setDefault('empty')).ok);
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

  await service.saveProvider(validInput({ name: 'test-provider', id: 'test-provider', models: ['m1'], apiKey: 'sk-super-sec-secret' }));
  assert.equal(auditEvents.length, 1);
  assert.equal(auditEvents[0]?.action, 'provider.saved');
  assert.equal(auditEvents[0]?.providerId, 'test-provider');
  assert.ok(auditEvents[0]?.ts);

  await service.setDefault('test-provider');
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
  const saved = await service.saveProvider(validInput({ id: 'no-audit', name: 'no-audit', models: ['m1'] }));
  assert.equal(saved.ok, true);
  assert.equal((await service.deleteProvider('no-audit')).ok, true);
});

// ===== 锚点语义（设计决策 6）：改别名才需要传播，改模型 ID 零传播 =====

test('saveProvider：改别名时传播锚点（全局默认 + 引用旧别名的会话一起改，其他会话不动）', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3']), makeProvider('fs', ['ark-code-latest'])];
  store.setSetting('defaultModel', 'mx');
  store.sessions.set('sess-1', makeSession('sess-1', 'mx'));
  store.sessions.set('sess-2', makeSession('sess-2', 'fs'));
  // 用户把别名 mx 改成 minimax（模型 ID 不变）——这是唯一需要传播的编辑
  const saved = await service.saveProvider(
    validInput({ id: 'mx', name: 'minimax', models: ['MiniMax-M3'] }),
  );
  assert.ok(saved.ok);
  assert.equal(store.getSetting('defaultModel'), 'minimax');
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'minimax');
  assert.equal(store.sessions.get('sess-2')?.modelOverride, 'fs');
  const defaultModel = await service.resolveDefault();
  assert.deepEqual(defaultModel, { providerId: 'minimax', model: 'MiniMax-M3' });
});

test('saveProvider：只改模型 ID 不动别名时不传播（存量引用继续命中）', async () => {
  const { service, modelsFile, store } = makeService();
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3'])];
  store.setSetting('defaultModel', 'mx');
  store.sessions.set('sess-1', makeSession('sess-1', 'mx'));
  const saved = await service.saveProvider(
    validInput({ id: 'mx', name: 'mx', models: ['MiniMax-M3.1-Flash-Preview'] }),
  );
  assert.ok(saved.ok);
  assert.equal(store.getSetting('defaultModel'), 'mx', '锚点原样保留');
  assert.equal(store.sessions.get('sess-1')?.modelOverride, 'mx');
  const session = await service.getSessionModel('sess-1');
  assert.ok(session.ok);
  if (session.ok) {
    assert.equal(session.data.model, 'MiniMax-M3.1-Flash-Preview', '会话模型自动跟过去');
    assert.equal(session.data.providerId, 'mx');
  }
});

test('resolveDefault：给出别名锚点与派生模型 ID；未配置/悬空返回 null', async () => {
  const { service, modelsFile, store } = makeService();
  assert.equal(await service.resolveDefault(), null);
  modelsFile.providers = [makeProvider('mx', ['MiniMax-M3'])];
  store.setSetting('defaultModel', 'mx');
  assert.deepEqual(await service.resolveDefault(), { providerId: 'mx', model: 'MiniMax-M3' });
  // 配置被删 -> 锚点悬空（deleteProvider 已负责清空，这里验解析层不抛错）
  modelsFile.providers = [];
  assert.equal(await service.resolveDefault(), null);
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
