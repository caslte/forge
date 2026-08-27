/**
 * PiModelsFileAdapter 单测。
 *
 * 验证真实 pi models.json 双向同步：
 * - readProviders：pi provider -> forge ProviderConfig 映射（api->type、models[].id 展开）
 * - readModelNames：聚合所有模型 id
 * - writeProviders：写回 pi 结构、保留 models[].contextWindow 等附加字段、保留 apiKey 引用
 * - 文件不存在：按空配置返回，不抛错
 *
 * 使用 node:test + Node 22 --experimental-strip-types；临时目录 finally 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiModelsFileAdapter } from '../../src/pi/piModelsFileAdapter.ts';

/** 写一个临时 pi models.json，返回文件路径 */
function makePiFile(content: object): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-'));
  const file = path.join(dir, 'models.json');
  fs.writeFileSync(file, JSON.stringify(content, null, 2), 'utf-8');
  return file;
}

test('readProviders：pi provider -> forge ProviderConfig 映射', async () => {
  const file = makePiFile({
    providers: {
      'Grok 4.5': {
        baseUrl: 'https://xuseny.online/v1',
        api: 'openai-completions',
        apiKey: 'sk-secret',
        models: [{ id: 'grok-4.5' }, { id: 'grok-4-fast' }],
      },
      huo_shan: {
        baseUrl: 'https://ark.cn-beijing.volces.com/api/coding/v3',
        api: 'openai-completions',
        models: [{ id: 'ark-code-latest', contextWindow: 1000000, reasoning: true }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);
  const providers = await adapter.readProviders();

  assert.equal(providers.length, 2);
  const grok = providers.find((p) => p.id === 'Grok 4.5');
  assert.ok(grok);
  assert.equal(grok.name, 'Grok 4.5');
  assert.equal(grok.type, 'openai-completions');
  assert.equal(grok.baseUrl, 'https://xuseny.online/v1');
  assert.deepEqual(grok.models, ['grok-4.5', 'grok-4-fast']);

  const huo = providers.find((p) => p.id === 'huo_shan');
  assert.ok(huo);
  assert.deepEqual(huo.models, ['ark-code-latest']);
});

test('readModelNames：聚合所有模型 id', async () => {
  const file = makePiFile({
    providers: {
      A: { api: 'openai-completions', models: [{ id: 'm1' }, { id: 'm2' }] },
      B: { api: 'openai-completions', models: [{ id: 'm2' }, { id: 'm3' }] },
    },
  });
  const adapter = new PiModelsFileAdapter(file);
  const names = await adapter.readModelNames();
  assert.deepEqual([...names].sort(), ['m1', 'm2', 'm3']);
});

test('writeProviders：写回 pi 结构并保留附加字段与 apiKey 引用', async () => {
  const file = makePiFile({
    providers: {
      huo_shan: {
        baseUrl: 'https://old.example.com',
        api: 'openai-completions',
        apiKey: '!command:some-keychain-ref',
        models: [{ id: 'ark-code-latest', contextWindow: 1000000, reasoning: true }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);

  // 模拟 forge 修改：更新 baseUrl、追加一个模型
  await adapter.writeProviders([
    {
      id: 'huo_shan',
      name: 'huo_shan',
      type: 'openai-completions',
      baseUrl: 'https://new.example.com',
      models: ['ark-code-latest', 'ark-code-pro'],
      lastError: null,
    },
  ]);

  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    providers: {
      huo_shan: {
        baseUrl: string;
        api: string;
        apiKey: string;
        models: Array<{ id: string; contextWindow?: number; reasoning?: boolean }>;
      };
    };
  };
  const p = raw.providers.huo_shan;
  assert.equal(p.baseUrl, 'https://new.example.com', 'baseUrl 应被更新');
  assert.equal(p.api, 'openai-completions');
  assert.equal(p.apiKey, '!command:some-keychain-ref', 'apiKey 引用应保留');
  assert.equal(p.models.length, 2);
  // 既有模型的附加字段应保留
  const first = p.models.find((m) => m.id === 'ark-code-latest');
  assert.equal(first?.contextWindow, 1000000, 'contextWindow 应保留');
  assert.equal(first?.reasoning, true, 'reasoning 应保留');
});

test('文件不存在：按空配置返回，不抛错', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pi-none-'));
  const file = path.join(dir, 'missing', 'models.json');
  const adapter = new PiModelsFileAdapter(file);
  const providers = await adapter.readProviders();
  assert.deepEqual(providers, []);
});

// ===== MP-S06 contextWindow 读写 =====

/** 从临时 pi models.json 读取首模型记录 */
function readFirstModel(file: string): { contextWindow?: number; reasoning?: boolean; compat?: unknown } {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    providers: Record<string, { models: Array<Record<string, unknown>> }>;
  };
  const provider = Object.values(raw.providers)[0];
  return provider?.models?.[0] as { contextWindow?: number; reasoning?: boolean; compat?: unknown };
}

test('U-MP-004：存量 contextWindow=200000 传 contextWindow=null -> 移除字段且保留其他字段', async () => {
  const file = makePiFile({
    providers: {
      huo_shan: {
        api: 'openai-completions',
        models: [{ id: 'ark-code-latest', contextWindow: 200000, reasoning: true, compat: { preserve: true } }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);

  // 模拟 forge 未勾选 1M：contextWindow=null -> 移除该字段（回退 pi 默认）
  await adapter.writeProviders([
    {
      id: 'huo_shan',
      name: 'huo_shan',
      type: 'openai-completions',
      baseUrl: null,
      models: ['ark-code-latest'],
      lastError: null,
      contextWindow: null,
    },
  ]);

  const first = readFirstModel(file);
  assert.equal(first.contextWindow, undefined, 'contextWindow 字段应被移除');
  assert.equal(first.reasoning, true, 'reasoning 字段应保留');
  const compat = first.compat as { preserve: boolean } | undefined;
  assert.deepEqual(compat, { preserve: true }, 'compat 等其他 pi 字段应保留');
});

test('U-MP-005：contextWindow=1000000 写库并 readProviders 回显；缺失回显 null', async () => {
  const file = makePiFile({
    providers: {
      openai: {
        api: 'openai-completions',
        models: [{ id: 'gpt-1m' }, { id: 'gpt-plain' }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);

  // 勾选 1M：首模型写入 contextWindow=1000000
  await adapter.writeProviders([
    {
      id: 'openai',
      name: 'openai',
      type: 'openai-completions',
      baseUrl: null,
      models: ['gpt-1m', 'gpt-plain'],
      lastError: null,
      contextWindow: 1000000,
    },
  ]);

  const first = readFirstModel(file);
  assert.equal(first.contextWindow, 1000000, '首模型 contextWindow 应写为 1000000');

  // readProviders 回显 1000000
  const providers = await adapter.readProviders();
  const openai = providers.find((p) => p.id === 'openai');
  assert.ok(openai);
  assert.equal(openai.contextWindow, 1000000, '首模型 contextWindow 应回显 1000000');

  // 缺失/无 contextWindow 的 provider -> 回显 null
  const fileNoCw = makePiFile({
    providers: {
      plain: { api: 'openai-completions', models: [{ id: 'm' }] },
    },
  });
  const noCw = await new PiModelsFileAdapter(fileNoCw).readProviders();
  assert.equal(noCw[0]?.contextWindow, null, '缺失 contextWindow 应回显 null');
});

test('U-MP-005：contextWindow undefined 传入时不触碰现有字段', async () => {
  const file = makePiFile({
    providers: {
      openai: {
        api: 'openai-completions',
        models: [{ id: 'gpt-200k', contextWindow: 200000, reasoning: true }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);

  // 未传 contextWindow（undefined）：provider 内部缺省保留原值，不篡改
  await adapter.writeProviders([
    {
      id: 'openai',
      name: 'openai',
      type: 'openai-completions',
      baseUrl: null,
      models: ['gpt-200k'],
      lastError: null,
    },
  ]);

  const first = readFirstModel(file);
  assert.equal(first.contextWindow, 200000, 'contextWindow 应保留原值 200000');
  assert.equal(first.reasoning, true, 'reasoning 应保留');
});

// ===== 多模态：vision 勾选读写（input 能力字段） =====

test('uid-x-001：vision=true 写首模型 input:["text","image"]，readProviders 回显 vision=true', async () => {
  const file = makePiFile({
    providers: {
      minimax: {
        api: 'openai-completions',
        models: [{ id: 'MiniMax-M3', contextWindow: 1000000, reasoning: true }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);

  // 勾选多模态：首模型写 input:["text","image"]
  await adapter.writeProviders([
    {
      id: 'minimax',
      name: 'minimax',
      type: 'openai-completions',
      baseUrl: null,
      models: ['MiniMax-M3'],
      lastError: null,
      vision: true,
    },
  ]);

  const first = readFirstModel(file) as { input?: string[]; contextWindow?: number; reasoning?: boolean };
  assert.deepEqual(first.input, ['text', 'image'], '勾选后 input 应为 ["text","image"]');
  assert.equal(first.contextWindow, 1000000, 'contextWindow 等其它字段应保留');
  assert.equal(first.reasoning, true, 'reasoning 应保留');

  // 回显：首模型 input 含 "image" -> vision=true
  const providers = await adapter.readProviders();
  const provider = providers.find((p) => p.id === 'minimax');
  assert.ok(provider);
  assert.equal(provider.vision, true, 'readProviders 应回显 vision=true');
});

test('uid-x-002：vision=false 移除 input 字段（回退 pi 默认纯文本），readProviders 回显 false', async () => {
  const file = makePiFile({
    providers: {
      minimax: {
        api: 'openai-completions',
        models: [{ id: 'MiniMax-M3', input: ['text', 'image'], reasoning: true }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);

  // 取消勾选：移除 input 字段
  await adapter.writeProviders([
    {
      id: 'minimax',
      name: 'minimax',
      type: 'openai-completions',
      baseUrl: null,
      models: ['MiniMax-M3'],
      lastError: null,
      vision: false,
    },
  ]);

  const first = readFirstModel(file) as { input?: string[]; reasoning?: boolean };
  assert.equal(first.input, undefined, '取消勾选应移除 input 字段');
  assert.equal(first.reasoning, true, 'reasoning 应保留');

  // 回显：缺失 input -> vision=false
  const providers = await adapter.readProviders();
  const provider = providers.find((p) => p.id === 'minimax');
  assert.ok(provider);
  assert.equal(provider.vision, false, 'readProviders 应回显 vision=false');
});

test('uid-x-003：vision undefined 传入时不触碰手工 input 能力声明', async () => {
  const file = makePiFile({
    providers: {
      multi: {
        api: 'openai-completions',
        models: [{ id: 'm-video', input: ['text', 'image', 'video'] }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);

  // 未传 vision：保留原 input（不覆盖用户手工声明的复杂能力）
  await adapter.writeProviders([
    {
      id: 'multi',
      name: 'multi',
      type: 'openai-completions',
      baseUrl: null,
      models: ['m-video'],
      lastError: null,
    },
  ]);

  const first = readFirstModel(file) as { input?: string[] };
  assert.deepEqual(first.input, ['text', 'image', 'video'], '未传 vision 应保留原 input');
});

test('uid-x-004：readProviders 对 input 非数组/含 video 不误判；未声明 input 回显 false', async () => {
  // 未声明 input -> false
  const filePlain = makePiFile({
    providers: { plain: { api: 'openai-completions', models: [{ id: 'm' }] } },
  });
  const plain = await new PiModelsFileAdapter(filePlain).readProviders();
  assert.equal(plain[0]?.vision, false, '未声明 input 应回显 false');

  // input 声明了 video 但无 image -> false（严格按含 "image" 判定）
  const fileVideo = makePiFile({
    providers: { video: { api: 'openai-completions', models: [{ id: 'm', input: ['text', 'video'] }] } },
  });
  const video = await new PiModelsFileAdapter(fileVideo).readProviders();
  assert.equal(video[0]?.vision, false, '仅 text/video 不应判定为支持图片');
});

// ===== MP-S07：思考强度（reasoning）与思考等级白名单（thinkingLevelMap）读写 =====

/** 读取首模型原始记录（MP-S07 断言用） */
function readFirstModelRaw(file: string): Record<string, unknown> {
  const raw = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    providers: Record<string, { models: Array<Record<string, unknown>> }>;
  };
  const provider = Object.values(raw.providers)[0];
  return (provider?.models?.[0] ?? {}) as Record<string, unknown>;
}

test('writeProviders：reasoning=true + thinkingLevels -> 写 reasoning 与 thinkingLevelMap（选中=级别名，未选=null），保留其他字段', async () => {
  const file = makePiFile({
    providers: {
      huo_shan: {
        api: 'openai-completions',
        models: [{ id: 'ark-code-latest', contextWindow: 1000000, compat: { preserve: true } }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);
  await adapter.writeProviders([
    {
      id: 'huo_shan',
      name: 'huo_shan',
      type: 'openai-completions',
      baseUrl: null,
      models: ['ark-code-latest'],
      lastError: null,
      reasoning: true,
      thinkingLevels: ['off', 'high', 'max'],
    },
  ]);
  const first = readFirstModelRaw(file);
  assert.equal(first.reasoning, true);
  assert.deepEqual(first.thinkingLevelMap, {
    off: 'off',
    minimal: null,
    low: null,
    medium: null,
    high: 'high',
    xhigh: null,
    max: 'max',
  });
  // 其他字段保留
  assert.equal(first.compat?.preserve, true);
  assert.equal(first.contextWindow, 1000000);
});

test('writeProviders：reasoning=false + thinkingLevels=null -> 写 reasoning:false 并移除 thinkingLevelMap', async () => {
  const file = makePiFile({
    providers: {
      huo_shan: {
        api: 'openai-completions',
        models: [{ id: 'ark-code-latest', reasoning: true, thinkingLevelMap: { high: 'high', max: 'max' } }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);
  await adapter.writeProviders([
    {
      id: 'huo_shan',
      name: 'huo_shan',
      type: 'openai-completions',
      baseUrl: null,
      models: ['ark-code-latest'],
      lastError: null,
      reasoning: false,
      thinkingLevels: null,
    },
  ]);
  const first = readFirstModelRaw(file);
  assert.equal(first.reasoning, false);
  assert.equal('thinkingLevelMap' in first, false, 'thinkingLevels=null 应移除 thinkingLevelMap');
});

test('writeProviders：reasoning/thinkingLevels 缺省不触碰（保留手工配置）', async () => {
  const file = makePiFile({
    providers: {
      huo_shan: {
        api: 'openai-completions',
        models: [{ id: 'ark-code-latest', reasoning: true, thinkingLevelMap: { high: 'custom' } }],
      },
    },
  });
  const adapter = new PiModelsFileAdapter(file);
  await adapter.writeProviders([
    {
      id: 'huo_shan',
      name: 'huo_shan',
      type: 'openai-completions',
      baseUrl: null,
      models: ['ark-code-latest'],
      lastError: null,
    },
  ]);
  const first = readFirstModelRaw(file);
  assert.equal(first.reasoning, true, '缺省不触碰 reasoning');
  assert.deepEqual(first.thinkingLevelMap, { high: 'custom' }, '缺省保留手工 thinkingLevelMap');
});

test('readProviders：reasoning=true 时按 pi 语义推导 thinkingLevels（null 隐藏；xhigh/max 缺省不可用）', async () => {
  // 显式 map：off/medium/max 非 null；minimal/low/high 缺省项按 pi 语义仍可用（缺省=可用）
  const fileFull = makePiFile({
    providers: {
      full: {
        api: 'openai-completions',
        models: [{ id: 'm', reasoning: true, thinkingLevelMap: { off: 'off', medium: 'medium', max: 'max' } }],
      },
    },
  });
  const full = await new PiModelsFileAdapter(fileFull).readProviders();
  assert.equal(full[0]?.reasoning, true);
  assert.deepEqual(full[0]?.thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high', 'max']);

  // 缺省 map：off/minimal/low/medium/high 可用（pi 缺省），xhigh/max 缺省不可用
  const fileDefault = makePiFile({
    providers: {
      def: { api: 'openai-completions', models: [{ id: 'm', reasoning: true }] },
    },
  });
  const def = await new PiModelsFileAdapter(fileDefault).readProviders();
  assert.equal(def[0]?.reasoning, true);
  assert.deepEqual(def[0]?.thinkingLevels, ['off', 'minimal', 'low', 'medium', 'high']);

  // 未启用思考：不回显 thinkingLevels，reasoning=false
  const filePlain = makePiFile({
    providers: { plain: { api: 'openai-completions', models: [{ id: 'm' }] } },
  });
  const plain = await new PiModelsFileAdapter(filePlain).readProviders();
  assert.equal(plain[0]?.reasoning, false);
  assert.equal('thinkingLevels' in (plain[0] ?? {}), false);
});
