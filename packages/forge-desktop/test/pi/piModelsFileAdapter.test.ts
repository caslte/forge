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
