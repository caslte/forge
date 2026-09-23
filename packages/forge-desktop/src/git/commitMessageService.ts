/**
 * AI 生成提交说明（模块 11 GC-F05，docs/prd/11_git_commit_push.md）。
 *
 * 口径（用户 2026-09-23 确认）：**一次** OpenAI 兼容 `{baseUrl}/chat/completions`
 * 非流式调用，不起 agent 会话（TD-GC-02）。diff 上下文由 GitService.collectCommitDiff
 * 按 TD-GC-03 截断；生成语言跟随 app locale（TD-GC-05，UI 传 lang 参数，缺省 zh）。
 *
 * 设计决策：
 * 1. provider 解析（模型 → models.json 记录 → apiKey 明文）经注入的 resolveChatTarget
 *    端口完成——本文件不 import ModelService/keychain，组装在 createForgeCore。
 * 2. apiKey 即用即弃：只进请求头，绝不入日志、不进错误消息（§3.5 安全）。
 * 3. 错误码 6008（生成失败）统一兜底：无变更/未配置模型/解析失败/网络/非 2xx 均
 *    6008 + 可读 message；30s 超时（AbortSignal）。
 * 4. 响应后处理最小化（PRD 常规默认项）：剥 ``` 围栏、取首段非空、首尾 trim。
 * 5. fetch 可注入（测试 mock），默认 globalThis.fetch。
 */

import type { GitService, RpcResult } from '@forge/core';

/** OpenAI 兼容调用目标（apiKey 已解析为明文） */
export interface ChatTarget {
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** resolveChatTarget 端口结果 */
export type ChatTargetResult =
  | { ok: true; target: ChatTarget }
  | { ok: false; code: number; message: string };

/** 依赖（createForgeCore 组装注入） */
export interface CommitMessageDeps {
  gitService: GitService;
  /** 解析生成用的 provider 端点（sessionId 缺省时退全局默认模型） */
  resolveChatTarget: (sessionId: string | null) => Promise<ChatTargetResult>;
  /** path 注册判定（与其它 git 方法同口径返回 1002；缺省不校验） */
  isProjectRegistered?: (path: string) => boolean;
  /** 测试接缝：替换 fetch */
  fetchImpl?: typeof fetch;
  /** 调用超时 ms（默认 30s，PRD 常规默认项） */
  timeoutMs?: number;
}

/** 生成失败统一错误码（git 域顺延：6001 切换 / 6006 提交 / 6007 推送 / 6008 生成） */
const GENERATE_FAILED = 6008;

function ok<T>(data: T): RpcResult<T> {
  return { code: 0, message: 'success', data };
}

function fail(code: number, message: string): RpcResult<null> {
  return { code, message, data: null };
}

/** chat/completions 响应体（只取需要的字段，容错 content 为数组的分片形式） */
interface ChatCompletionResponse {
  choices?: Array<{
    finish_reason?: string;
    message?: { content?: string | Array<{ text?: string }>; reasoning_content?: string };
  }>;
  /** MiniMax 等网关用 HTTP 200 + base_resp.status_code≠0 表达业务错误 */
  base_resp?: { status_code?: number; status_msg?: string };
}

/** 响应文本 → 提交说明：剥 ``` 围栏、取首段非空、首尾 trim（PRD GC-F05 异常边界） */
export function extractCommitMessage(raw: string): string {
  const unfenced = raw.replace(/```[a-z]*\n?/gi, '').trim();
  const blocks = unfenced.split(/\n\s*\n/).map((b) => b.trim()).filter((b) => b !== '');
  return (blocks[0] ?? unfenced).trim();
}

/**
 * 构造 git/generateCommitMessage RPC 方法映射。
 * 参数：{ path: string; sessionId?: string; lang?: 'zh' | 'en' }。
 */
export function createCommitMessageMethods(
  deps: CommitMessageDeps,
): Record<string, (params: unknown) => Promise<RpcResult>> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch;
  const timeoutMs = deps.timeoutMs ?? 30_000;

  async function generate(params: unknown): Promise<RpcResult> {
    const p = (typeof params === 'object' && params !== null ? params : {}) as {
      path?: unknown;
      sessionId?: unknown;
      lang?: unknown;
    };
    if (typeof p.path !== 'string' || p.path.trim() === '') {
      return fail(1001, '参数错误：path 必须为非空字符串');
    }
    if (deps.isProjectRegistered?.(p.path) === false) {
      return fail(1002, `项目不存在: ${p.path}`);
    }
    const lang = p.lang === 'en' ? 'en' : 'zh';
    try {
      const diff = await deps.gitService.collectCommitDiff(p.path);
      if (!diff.hasChanges) {
        return fail(GENERATE_FAILED, '无变更可总结');
      }
      const sessionId =
        typeof p.sessionId === 'string' && p.sessionId.trim() !== '' ? p.sessionId : null;
      const target = await deps.resolveChatTarget(sessionId);
      if (!target.ok) {
        return fail(target.code, target.message);
      }
      const url = `${target.target.baseUrl.replace(/\/+$/, '')}/chat/completions`;
      const systemPrompt =
        lang === 'en'
          ? 'You are a senior software engineer. Based on the provided git file list and diff, write ONE concise commit message in Conventional Commits style (optional body bullets after a blank line). Output only the commit message itself: no quotes, no markdown fences, no explanations. Write in English.'
          : '你是资深软件工程师。根据提供的 git 变更文件清单与 diff，写一条简洁的 Conventional Commits 风格提交说明（可在空行后附正文要点）。只输出提交说明本身：不要引号、不要 markdown 代码块、不要解释。使用中文。';
      const body = JSON.stringify({
        model: target.target.model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: diff.text },
        ],
        temperature: 0.2,
        // 1024（原 300）：思考型模型（如 MiniMax-M3）输出预算先被 reasoning_content 消耗，
        // 300 易致 content 为空——真机「模型返回空内容」反馈，2026-09-23
        max_tokens: 1024,
        stream: false,
      });
      const res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${target.target.apiKey}`,
        },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!res.ok) {
        // 刻意不记响应体（可能回显请求内容）；日志仅状态码与模型名（§3.5 apiKey 纪律）
        console.warn(`[commitMessage] provider HTTP ${res.status} model=${target.target.model}`);
        return fail(GENERATE_FAILED, `生成失败：provider 返回 HTTP ${res.status}`);
      }
      const json = (await res.json()) as ChatCompletionResponse;
      // MiniMax 等网关 HTTP 200 但 body 带业务错误——不当「空内容」误报，直接透传
      const baseResp = json.base_resp;
      if (baseResp && typeof baseResp.status_code === 'number' && baseResp.status_code !== 0) {
        console.warn(
          `[commitMessage] provider base_resp=${baseResp.status_code} model=${target.target.model}`,
        );
        return fail(
          GENERATE_FAILED,
          `生成失败：provider 返回错误 ${baseResp.status_code}${baseResp.status_msg ? '（' + baseResp.status_msg + '）' : ''}`,
        );
      }
      const choice = json.choices?.[0];
      const content = choice?.message?.content;
      const raw =
        typeof content === 'string'
          ? content
          : Array.isArray(content)
            ? content.map((c) => c.text ?? '').join('')
            : '';
      const message = extractCommitMessage(raw);
      if (message === '') {
        const reasoning = choice?.message?.reasoning_content;
        // 诊断日志只记形状不记内容（避免回显 diff/模型原文）；apiKey 纪律同 §3.5
        console.warn(
          `[commitMessage] empty content model=${target.target.model} finish_reason=${choice?.finish_reason ?? 'n/a'} content_type=${typeof content} reasoning_chars=${typeof reasoning === 'string' ? reasoning.length : 0}`,
        );
        if (typeof reasoning === 'string' && reasoning.trim() !== '') {
          return fail(GENERATE_FAILED, '生成失败：模型只输出了思考内容没有正文，请换非思考模型或重试');
        }
        return fail(GENERATE_FAILED, '生成失败：模型返回空内容');
      }
      console.log(
        `[commitMessage] ok model=${target.target.model} files=${diff.fileCount} chars=${message.length}`,
      );
      return ok({ message });
    } catch (err) {
      const e = err as { name?: string; message?: string };
      const reason =
        e?.name === 'TimeoutError' || e?.name === 'AbortError'
          ? '请求超时'
          : (e?.message ?? String(err));
      console.warn(`[commitMessage] generate failed: ${reason}`);
      return fail(GENERATE_FAILED, `生成失败：${reason}`);
    }
  }

  return { 'git/generateCommitMessage': generate };
}
