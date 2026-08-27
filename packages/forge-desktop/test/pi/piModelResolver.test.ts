import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { resolvePiModel, getPiSupportedThinkingLevels, clampPiThinkingLevel } from '../../src/pi/piModelResolver.ts';

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

// ===== MP-S05 思考级别能力（消费 pi SDK，TD-MP-04） =====

test('U-MP-003：越界 max 经 clampPiThinkingLevel 就近收敛为可用级别（reasoning 模型仅至 high）', async () => {
  // 构造 reasoning 模型，thinkingLevelMap 显式提供 high（无 xhigh/max）
  const modelsPath = makeModelsFixture({
    'Reason Provider': {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      models: [{ id: 'reason-model', reasoning: true, thinkingLevelMap: { high: 'high' } }],
    },
  });

  // 经 pi SDK 真函数 clampThinkingLevel 就近收敛为 high（不发送不支持级别）
  const clamped = await clampPiThinkingLevel('reason-model', 'max', modelsPath);
  assert.equal(clamped, 'high', 'max 应就近收敛为 high');
});

test('U-MP-003：请求级别在支持范围内时经 clamp 原样返回', async () => {
  const modelsPath = makeModelsFixture({
    'Reason Provider': {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      models: [{ id: 'reason-model', reasoning: true, thinkingLevelMap: { high: 'high' } }],
    },
  });

  const clamped = await clampPiThinkingLevel('reason-model', 'high', modelsPath);
  assert.equal(clamped, 'high', '支持范围内级别应原样返回');
});

test('U-MP-006：非推理模型（reasoning=false）getPiSupportedThinkingLevels 仅返回 ["off"]', async () => {
  const modelsPath = makeModelsFixture({
    'Plain Provider': {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      models: [{ id: 'plain-model', reasoning: false }],
    },
  });

  const levels = await getPiSupportedThinkingLevels('plain-model', modelsPath);
  assert.deepEqual(levels, ['off'], '非推理模型只应返回 ["off"]');
});

test('推理模型 getPiSupportedThinkingLevels 返回包含 off 的可用级别列表', async () => {
  const modelsPath = makeModelsFixture({
    'Reason Provider': {
      baseUrl: 'https://example.com/v1',
      api: 'openai-completions',
      apiKey: 'sk-test',
      models: [{ id: 'reason-model', reasoning: true, thinkingLevelMap: { high: 'high' } }],
    },
  });

  const levels = await getPiSupportedThinkingLevels('reason-model', modelsPath);
  assert.ok(Array.isArray(levels));
  assert.ok(levels!.includes('off'), '列表应包含 off');
  assert.ok(levels!.includes('high'), '列表应包含 high');
  assert.ok(!levels!.includes('max'), '不支持的 max 不应出现');
});

test('模型解析失败时（不可用/未配置）getPiSupportedThinkingLevels 返回 null', async () => {
  const modelsPath = makeModelsFixture({ 'Empty Provider': { api: 'openai-completions', models: [] } });
  const levels = await getPiSupportedThinkingLevels('ghost-model', modelsPath);
  assert.equal(levels, null, '模型不可用应返回 null（上层映射 1004）');
});

test('模型解析失败时 clampPiThinkingLevel 返回 level 原值（上层兜底）', async () => {
  const modelsPath = makeModelsFixture({ 'Empty Provider': { api: 'openai-completions', models: [] } });
  const clamped = await clampPiThinkingLevel('ghost-model', 'high', modelsPath);
  assert.equal(clamped, 'high', '解析失败应返回原请求级别');
});
