/**
 * 对话错误分类器（CV-ERR-01）表驱动单元测试。
 *
 * 用例来源全部是**真机出现过的原文**（见 daily/2026-09-29 排查记录），
 * 覆盖：每类归属判定、可重试性、归因、原文保真、降级标记、HTTP/provider 码提取、异常输入不抛。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyError } from '../../src/errors/errorClassifier.ts';
import type { ForgeErrorCategory, ForgeErrorSource } from '../../src/errors/errorClassifier.ts';

interface Case {
  raw: string;
  category: ForgeErrorCategory;
  source: ForgeErrorSource;
  retryable: boolean;
  note?: string;
}

const CASES: Case[] = [
  // —— 模型服务商（可自愈）——
  {
    raw: 'unknown error, 722 (1000)',
    category: 'provider',
    source: 'model-provider',
    retryable: true,
    note: 'MiniMax 流内错误帧（真机 2026-09-29）',
  },
  { raw: '500 Internal Server Error', category: 'provider', source: 'model-provider', retryable: true },
  { raw: 'Bad gateway (524)', category: 'provider', source: 'model-provider', retryable: true },
  { raw: 'The model server is overloaded', category: 'provider', source: 'model-provider', retryable: true },
  {
    raw: '429 rate_limit_error: requests per second exceeded',
    category: 'rate-limit',
    source: 'model-provider',
    retryable: true,
  },
  { raw: 'Too Many Requests', category: 'rate-limit', source: 'model-provider', retryable: true },
  {
    raw: 'Agent is already processing',
    category: 'busy',
    source: 'session-state',
    retryable: true,
    note: '并发撞车：上一轮还在跑（adapter 会先 abort 再让用户重发）',
  },
  {
    raw: '上一轮任务仍在后台执行，已将其结束，请重新发送',
    category: 'busy',
    source: 'session-state',
    retryable: true,
  },
  {
    raw: 'APIConnectionError: Connection error.\nENOTFOUND api.minimax.chat',
    category: 'network',
    source: 'local-network',
    retryable: true,
  },
  { raw: 'socket hang up', category: 'network', source: 'local-network', retryable: true },
  { raw: 'connect ETIMEDOUT 104.18.32.7:443', category: 'network', source: 'local-network', retryable: true },

  // —— 需用户处理（红色）——
  {
    raw: 'No API key found for model mx/MiniMax-M3.1-Flash-Preview',
    category: 'auth',
    source: 'user-config',
    retryable: false,
    note: 'pi 本地凭据缺失（adapter 原先单独打过补丁的文案）',
  },
  {
    raw: "401 {'error': {'message': 'Incorrect API key provided'}}",
    category: 'auth',
    source: 'user-config',
    retryable: false,
  },
  { raw: 'invalid_api_key', category: 'auth', source: 'user-config', retryable: false },
  { raw: '1008 insufficient balance', category: 'quota', source: 'user-account', retryable: false },
  {
    raw: '400 context_length_exceeded: maximum context length is 204800 tokens',
    category: 'context',
    source: 'session-state',
    retryable: false,
  },
  { raw: 'spawn git ENOENT', category: 'local-env', source: 'host-environment', retryable: false },
  { raw: "git: command not found", category: 'local-env', source: 'host-environment', retryable: false },
  {
    raw: "'node' 不是内部或外部命令",
    category: 'local-env',
    source: 'host-environment',
    retryable: false,
  },

  // —— 兜底 ——
  {
    raw: 'Weird happened :)) 前端把 undefined 传了进来',
    category: 'unknown',
    source: 'undetermined',
    retryable: true,
    note: '未识别按可重试处理（给用户一次机会，而不是直接判死）',
  },
];

test('CV-ERR-001 分类表：每类原文归到正确的 category/source/retryable', () => {
  for (const c of CASES) {
    const got = classifyError(c.raw);
    assert.equal(got.category, c.category, `category 不符：${c.raw}${c.note ? `（${c.note}）` : ''}`);
    assert.equal(got.source, c.source, `source 不符：${c.raw}`);
    assert.equal(got.retryable, c.retryable, `retryable 不符：${c.raw}`);
  }
});

test('CV-ERR-002 原文保真：raw 原样返回，不被分类过程加工', () => {
  const raw = "401 {'error': {'message': 'Incorrect API key provided'}}";
  assert.equal(classifyError(raw).raw, raw);
  assert.equal(classifyError('unknown error, 722 (1000)').raw, 'unknown error, 722 (1000)');
});

test('CV-ERR-003 降级标记：仅「本轮已有内容 + provider 错误」为 degraded', () => {
  // 真机场景：内容已完整输出，stopReason 却是 error
  const degraded = classifyError('unknown error, 722 (1000)', { hasVisibleContent: true });
  assert.equal(degraded.degraded, true, '有内容 + provider 错误应降级');

  const noContent = classifyError('unknown error, 722 (1000)', { hasVisibleContent: false });
  assert.equal(noContent.degraded, false, '无内容时不降级（是真空失败）');

  // 鉴权失败即使前面有内容也不降级：结论对下一轮同样成立
  const auth = classifyError('No API key found', { hasVisibleContent: true });
  assert.equal(auth.degraded, false, '非 provider 类不降级');

  // 缺省（调用方没给上下文）不降级
  assert.equal(classifyError('unknown error, 722 (1000)').degraded, false);
});

test('CV-ERR-004 HTTP 状态码：正文未命中规则时按状态码兜底归类', () => {
  const auth = classifyError('请求失败', { httpStatus: 401 });
  assert.equal(auth.category, 'auth');
  assert.equal(auth.retryable, false);

  const provider = classifyError('请求失败', { httpStatus: 503 });
  assert.equal(provider.category, 'provider');
  assert.equal(provider.retryable, true);

  // 显式传入优先于原文解析，且能覆盖「泛化」正文（unknown error + 401 → auth）
  const explicit = classifyError('unknown error, 722 (1000)', { httpStatus: 401 });
  assert.equal(explicit.category, 'auth', '显式 httpStatus 应覆盖泛化正文');
  assert.equal(explicit.retryable, false);

  // 但正文明确是本机/上下文问题时，状态码不得推翻（spawn 失败没有 HTTP 语义）
  const localWins = classifyError('spawn git ENOENT', { httpStatus: 500 });
  assert.equal(localWins.category, 'local-env', '明确正文优先于状态码');

  // 原文里能解析出状态码
  assert.equal(classifyError('HTTP 500 Internal error').httpStatus, 500);
});

test('CV-ERR-005 provider 错误码：提取括号尾码与具名码', () => {
  assert.equal(classifyError('unknown error, 722 (1000)').providerCode, '1000');
  assert.equal(classifyError('1008 insufficient balance').providerCode, '1008');
  assert.equal(classifyError('429 rate_limit_error: x').providerCode, 'rate_limit_error');
  assert.equal(classifyError('随便一段没有编码的话').providerCode, undefined);
});

test('CV-ERR-006 异常输入不抛：空串/非字符串一律降级为 unknown 且 raw 保真', () => {
  const empty = classifyError('');
  assert.equal(empty.category, 'unknown');
  assert.equal(empty.source, 'undetermined');
  assert.equal(empty.raw, '');

  const nonString = classifyError(undefined as unknown as string);
  assert.equal(nonString.category, 'unknown');
  assert.equal(nonString.raw, 'undefined');
});

test('CV-ERR-007 归因与可重试相互独立：不可重试的四类绝不出现「立即重试」', () => {
  const mustNotRetry = ['auth', 'quota', 'context', 'local-env'] as const;
  for (const raw of [
    'No API key found',
    '1008 insufficient balance',
    'context_length_exceeded',
    'spawn git ENOENT',
  ]) {
    const got = classifyError(raw);
    assert.equal(got.retryable, false, `${raw} 不应可重试`);
    assert.ok(mustNotRetry.includes(got.category as never), `${raw} 分类应为不可重试类，实际 ${got.category}`);
  }
});
