/**
 * 模型连通性测试（模块 05，model/testProvider）单元测试。
 *
 * 覆盖口径（src/model/modelTestService.ts 头注释）：
 * - 成功：单次 chat/completions（URL 归一 / 非流式 / Authorization 头）→ data.latencyMs
 * - apiKey 为空（本地服务无鉴权）→ 不发 authorization 头
 * - 参数：baseUrl/model 缺失或地址无 http(s) 前缀 → 1001 且不发请求
 * - 失败统一 1006：网络抛错（透传 cause 一句）/ 超时 / 非 2xx（状态码人话 + 错误体摘要）
 *   / HTTP 200 + base_resp 业务错误（MiniMax 形态）
 * - 安全：任何 message 不含 apiKey
 * - 假阴性防线：200 + choices 存在但 content 为空（思考模型吃满 max_tokens）仍判成功
 *
 * fetch 注入 fake，不触网。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModelTestMethods } from '../../src/model/modelTestService.ts';

interface FetchCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body: string };
}

function makeMethods(opts: {
  response?: { ok: boolean; status?: number; json?: unknown; text?: string };
  throws?: Error;
  timeoutMs?: number;
}) {
  const calls: FetchCall[] = [];
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as FetchCall['init'] });
    if (opts.throws !== undefined) {
      throw opts.throws;
    }
    const res = opts.response ?? { ok: true, json: { choices: [{ message: { content: 'ok' } }] } };
    const bodyText = res.text ?? (res.json !== undefined ? JSON.stringify(res.json) : '');
    return {
      ok: res.ok,
      status: res.status ?? 200,
      async json() {
        return res.json ?? {};
      },
      async text() {
        return bodyText;
      },
    };
  }) as unknown as typeof fetch;
  return {
    calls,
    methods: createModelTestMethods({ fetchImpl, timeoutMs: opts.timeoutMs }),
  };
}

const VALID = { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-secret-123', model: 'm-1' };

test('model/testProvider：成功单次调用并返回耗时', async () => {
  const { calls, methods } = makeMethods({});
  const r = await methods['model/testProvider'](VALID);
  assert.equal(r.code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(calls[0]?.init.headers.authorization, 'Bearer sk-secret-123');
  const body = JSON.parse(String(calls[0]?.init.body)) as Record<string, unknown>;
  assert.equal(body.model, 'm-1');
  assert.equal(body.stream, false);
  assert.equal(typeof r.data?.latencyMs, 'number');
});

test('model/testProvider：apiKey 为空不发 authorization 头（本地服务无鉴权）', async () => {
  const { calls, methods } = makeMethods({});
  const r = await methods['model/testProvider']({ ...VALID, apiKey: '  ' });
  assert.equal(r.code, 0);
  assert.equal(calls[0]?.init.headers.authorization, undefined);
});

test('model/testProvider：baseUrl/model 缺失或地址非法 → 1001 且不发请求', async () => {
  const { calls, methods } = makeMethods({});
  assert.equal((await methods['model/testProvider']({ model: 'm-1' })).code, 1001);
  assert.equal((await methods['model/testProvider']({ baseUrl: 'https://a.com' })).code, 1001);
  assert.equal((await methods['model/testProvider']({ baseUrl: 'api.com/v1', model: 'm-1' })).code, 1001);
  assert.equal(calls.length, 0);
});

test('model/testProvider：HTTP 401 → 1006 提示 Key 无效，message 不含密钥', async () => {
  const { methods } = makeMethods({ response: { ok: false, status: 401, json: { error: { message: 'invalid api key' } } } });
  const r = await methods['model/testProvider'](VALID);
  assert.equal(r.code, 1006);
  assert.match(String(r.message), /API Key 无效/);
  assert.match(String(r.message), /invalid api key/);
  assert.ok(!String(r.message).includes('sk-secret-123'));
});

test('model/testProvider：404/429 各给对应人话提示', async () => {
  const nf = makeMethods({ response: { ok: false, status: 404, text: '' } });
  assert.match(String((await nf.methods['model/testProvider'](VALID)).message), /HTTP 404/);
  const rl = makeMethods({ response: { ok: false, status: 429, text: 'rate limited' } });
  const r = await rl.methods['model/testProvider'](VALID);
  assert.match(String(r.message), /限流/);
  assert.match(String(r.message), /rate limited/);
});

test('model/testProvider：非 JSON 错误体原文截断进 message（不抛异常）', async () => {
  const { methods } = makeMethods({ response: { ok: false, status: 502, text: `<html>${'x'.repeat(400)}</html>` } });
  const r = await methods['model/testProvider'](VALID);
  assert.equal(r.code, 1006);
  assert.ok(String(r.message).length < 260);
});

test('model/testProvider：网络抛错 → 1006 无法连接并透传 cause', async () => {
  const { methods } = makeMethods({ throws: Object.assign(new Error('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND api.example.com') }) });
  const r = await methods['model/testProvider'](VALID);
  assert.equal(r.code, 1006);
  assert.match(String(r.message), /无法连接到 API 地址/);
  assert.match(String(r.message), /ENOTFOUND/);
});

test('model/testProvider：超时 → 1006 连接超时带秒数', async () => {
  const { methods } = makeMethods({ throws: Object.assign(new Error('timeout'), { name: 'TimeoutError' }), timeoutMs: 15_000 });
  const r = await methods['model/testProvider'](VALID);
  assert.equal(r.code, 1006);
  assert.match(String(r.message), /连接超时：15s/);
});

test('model/testProvider：HTTP 200 + base_resp 业务错误 → 1006 透传（MiniMax 形态）', async () => {
  const { methods } = makeMethods({ response: { ok: true, json: { base_resp: { status_code: 1004, status_msg: 'authentication fail' } } } });
  const r = await methods['model/testProvider'](VALID);
  assert.equal(r.code, 1006);
  assert.match(String(r.message), /业务错误 1004/);
  assert.match(String(r.message), /authentication fail/);
});

test('model/testProvider：200 但 content 为空（思考模型吃满预算）仍判连通成功', async () => {
  const { methods } = makeMethods({
    response: { ok: true, json: { choices: [{ message: { content: '', reasoning_content: 'thinking…' } }] } },
  });
  const r = await methods['model/testProvider'](VALID);
  assert.equal(r.code, 0);
});
