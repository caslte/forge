/**
 * 模型连通性测试（model/testProvider，模块 05）。
 *
 * 口径（与 git/generateCommitMessage 同源）：**一次** OpenAI 兼容
 * `{baseUrl}/chat/completions` 非流式调用，不起 agent 会话、不落盘。
 *
 * 设计决策：
 * 1. 参数直接取设置页表单当前值（未保存也可测）：baseUrl/model 必填，apiKey 可空
 *    （本地推理服务常无鉴权）——空则不发 authorization 头。
 * 2. apiKey 即用即弃：只进请求头，绝不入日志、不进错误消息（§3.5 安全）。
 * 3. 判定「通」= HTTP 200 且 body 无网关业务错误（MiniMax 等以 200 + base_resp 表达
 *    失败）。思考型模型 max_tokens 被 reasoning 吃满导致 content 为空的情况**不判失败**
 *    （链路已通），避免假阴性。
 * 4. 错误码 1006 统一兜底：参数非法 1001；网络失败/超时/非 2xx/网关错误均 1006 +
 *    人话 message（含 HTTP 状态码便于自查）。非 2xx 附 provider error 摘要（截断），
 *    该摘要可能含模型名，不含密钥。
 */

import type { RpcResult } from '@forge/core';

/** 依赖（测试可注入替身） */
export interface ModelTestDeps {
  /** 测试接缝：替换 fetch */
  fetchImpl?: typeof fetch;
  /** 调用超时 ms（默认 15s：探活不该让用户等 30s） */
  timeoutMs?: number;
}

/** 探活失败统一错误码（model 域 1xxx 顺延，见 docs/api/index.md） */
const TEST_FAILED = 1006;

function ok<T>(data: T): RpcResult<T> {
  return { code: 0, message: 'success', data };
}

function fail(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/** chat/completions 响应体（只取判定所需字段） */
interface ChatCompletionResponse {
  choices?: unknown[];
  /** MiniMax 等网关用 HTTP 200 + base_resp.status_code≠0 表达业务错误 */
  base_resp?: { status_code?: number; status_msg?: string };
  /** OpenAI 风格错误体（部分网关在 200 下也回） */
  error?: { message?: string; code?: string | number };
}

/** 非 2xx 状态码 → 人话提示（apiKey 绝不出现） */
function statusHint(status: number): string {
  if (status === 401 || status === 403) {
    return `API Key 无效或无权限（HTTP ${status}）`;
  }
  if (status === 404) {
    return '接口或模型不存在（HTTP 404），请检查 API 地址与模型 ID';
  }
  if (status === 429) {
    return '请求被限流（HTTP 429），可能额度不足或并发过高';
  }
  return `服务返回 HTTP ${status}`;
}

/** 尽力从错误体取一句摘要并截断（解析失败/无内容返回 null） */
async function readErrorDetail(res: Response): Promise<string | null> {
  try {
    const text = (await res.text()).slice(0, 500);
    if (text.trim() === '') return null;
    let detail = text.trim();
    try {
      const json = JSON.parse(text) as { error?: { message?: string }; base_resp?: { status_msg?: string } };
      const nested = json.error?.message ?? json.base_resp?.status_msg;
      if (typeof nested === 'string' && nested.trim() !== '') {
        detail = nested.trim();
      }
    } catch {
      /* 非 JSON 错误体（网关 HTML 页等）：用原文截断 */
    }
    return detail.length > 200 ? `${detail.slice(0, 200)}…` : detail;
  } catch {
    return null;
  }
}

/**
 * 构造 model/testProvider RPC 方法映射。
 * 参数：{ baseUrl: string; model: string; apiKey?: string }。
 * 成功 data：{ latencyMs: number }（往返耗时，UI 展示「连接成功 · 342ms」）。
 */
export function createModelTestMethods(
  deps: ModelTestDeps = {},
): Record<string, (params: unknown) => Promise<RpcResult>> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 15_000;

  async function testProvider(params: unknown): Promise<RpcResult> {
    const p = (typeof params === 'object' && params !== null ? params : {}) as {
      baseUrl?: unknown;
      model?: unknown;
      apiKey?: unknown;
    };
    const baseUrl = typeof p.baseUrl === 'string' ? p.baseUrl.trim() : '';
    const model = typeof p.model === 'string' ? p.model.trim() : '';
    const apiKey = typeof p.apiKey === 'string' ? p.apiKey.trim() : '';
    if (baseUrl === '' || model === '') {
      return fail(1001, '参数错误：baseUrl/model 必须为非空字符串');
    }
    if (!/^https?:\/\//i.test(baseUrl)) {
      return fail(1001, '参数错误：API 地址必须以 http:// 或 https:// 开头');
    }
    const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (apiKey !== '') {
      headers.authorization = `Bearer ${apiKey}`;
    }

    const startedAt = Date.now();
    let res: Response;
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
          // 探活只要最短确认；64（非 16）留出余量给先输出 reasoning 的模型
          max_tokens: 64,
          stream: false,
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      const name = err instanceof Error ? err.name : '';
      if (name === 'TimeoutError' || name === 'AbortError') {
        return fail(TEST_FAILED, `连接超时：${Math.round(timeoutMs / 1000)}s 内未收到响应`);
      }
      // Node fetch 失败原因在 cause（ENOTFOUND / ECONNREFUSED / 证书等）
      const cause = err instanceof Error && err.cause instanceof Error ? err.cause.message : '';
      return fail(TEST_FAILED, `无法连接到 API 地址${cause ? `（${cause}）` : ''}`);
    }

    const latencyMs = Date.now() - startedAt;
    if (!res.ok) {
      // 刻意不记响应体；日志仅状态码与模型名（§3.5 apiKey 纪律）
      console.warn(`[modelTest] provider HTTP ${res.status} model=${model}`);
      const detail = await readErrorDetail(res);
      return fail(TEST_FAILED, `${statusHint(res.status)}${detail ? `：${detail}` : ''}`);
    }

    let body: ChatCompletionResponse | null = null;
    try {
      body = (await res.json()) as ChatCompletionResponse;
    } catch {
      // 200 但非 JSON：链路通了，格式异常——按成功处理但提示
      console.warn(`[modelTest] non-JSON 200 response model=${model}`);
      return ok({ latencyMs });
    }
    const baseResp = body?.base_resp;
    if (baseResp && typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
      console.warn(`[modelTest] provider base_resp=${baseResp.status_code} model=${model}`);
      return fail(
        TEST_FAILED,
        `服务返回业务错误 ${baseResp.status_code}${baseResp.status_msg ? `（${baseResp.status_msg}）` : ''}`,
      );
    }
    const nested = body?.error;
    if (nested && (nested.message !== undefined || nested.code !== undefined)) {
      return fail(
        TEST_FAILED,
        `服务返回错误${nested.code !== undefined ? ` ${String(nested.code)}` : ''}${nested.message ? `：${nested.message}` : ''}`,
      );
    }
    return ok({ latencyMs });
  }

  return { 'model/testProvider': testProvider };
}
