import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePiModel } from '../../src/pi/piModelResolver.ts';

/** 创建临时 models.json fixture */
function makeModelsFixture(providers: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-models-'));
  const modelsPath = path.join(root, 'models.json');
  fs.writeFileSync(modelsPath, JSON.stringify({ providers }), 'utf8');
  return modelsPath;
}

test('按模型 ID 从 pi models.json 解析出模型对象', async () => {
  const modelsPath = makeModelsFixture({
    'Test Provider': {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      models: [{ id: 'test-model', contextWindow: 128000, maxTokens: 8192 }],
    },
  });

  const model = await resolvePiModel('test-model', modelsPath);

  assert.equal(model.id, 'test-model');
  assert.equal(model.api, 'openai-completions');
});

test('解析不存在的模型时返回稳定错误', async () => {
  const modelsPath = makeModelsFixture({
    'Test Provider': {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      models: [{ id: 'test-model' }],
    },
  });

  await assert.rejects(
    resolvePiModel('missing-model', modelsPath),
    /模型未配置或不可用: missing-model/,
  );
});

test('用户配置的 provider 与内置 provider 同名模型时优先用户配置（回归：MiniMax-M3）', async () => {
  // 复现真实故障：pi 内置 minimax provider 也提供 id=MiniMax-M3 的模型
  // （https://api.minimax.io/anthropic），用户在 models.json 自建同名模型
  // （https://api.minimaxi.com/v1）。旧实现遍历先命中内置 provider，导致
  // 发消息用错端点且无凭据（No API key found）。
  const modelsPath = makeModelsFixture({
    'MiniMax-M3': {
      baseUrl: 'https://api.minimaxi.com/v1',
      api: 'openai-completions',
      apiKey: '$FORGE_MINIMAX_M3_API_KEY',
      models: [{ id: 'MiniMax-M3' }],
    },
  });

  const model = await resolvePiModel('MiniMax-M3', modelsPath);

  // 必须解析到用户配置的 provider（而非内置 minimax）
  assert.equal(model.provider, 'MiniMax-M3');
  assert.equal(model.baseUrl, 'https://api.minimaxi.com/v1');
  assert.equal(model.api, 'openai-completions');
});
