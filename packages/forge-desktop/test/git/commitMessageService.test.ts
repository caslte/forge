/**
 * AI 生成提交说明（模块 11 GC-F05，git/generateCommitMessage）单元测试。
 *
 * 覆盖 docs/prd/11_git_commit_push.md 服务层契约：
 * - 成功：diff 收集 → 单次 chat/completions（Authorization 头 / URL 归一 / 非流式 body）
 *   → extractCommitMessage 剥围栏取首段（AC-11-10 后处理口径）
 * - lang：缺省 zh（提示词要求中文）、en 走英文提示词（TD-GC-05）
 * - 无变更 6008「无变更可总结」不发请求；resolveChatTarget 失败原样透传码与消息（AC 边界
 *   「未配置模型即报不发请求」）；HTTP 非 2xx / fetch 抛错统一 6008（AC-11-11）
 * - 参数：path 缺失 1001；未注册项目 1002
 *
 * gitService / resolveChatTarget / fetch 全部注入 fake，不触网不跑 git。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { GitService, CommitDiffContext } from '@forge/core';
import {
  createCommitMessageMethods,
  extractCommitMessage,
  type ChatTargetResult,
} from '../../src/git/commitMessageService.ts';

interface FetchCall {
  url: string;
  init: {
    method: string;
    headers: Record<string, string>;
    body: string;
  };
}

function makeFakes(opts: {
  diff?: CommitDiffContext;
  target?: ChatTargetResult;
  fetchResponse?: { ok: boolean; status?: number; json?: unknown; text?: string };
  fetchThrows?: Error;
  registered?: boolean;
}) {
  const diff: CommitDiffContext = opts.diff ?? {
    hasChanges: true,
    fileCount: 2,
    text: 'Files (2):\nM  a.ts\n?? b.ts\n\nDiffs:\ndiff --git a/a.ts b/a.ts\n+x\n',
  };
  const calls: { fetch: FetchCall[] } = { fetch: [] };
  const gitService = {
    collectCommitDiff: async () => diff,
  } as unknown as GitService;
  const target: ChatTargetResult = opts.target ?? {
    ok: true,
    target: { baseUrl: 'https://api.example.com/v1/', apiKey: 'sk-secret-123', model: 'm-1' },
  };
  const fetchImpl = (async (url: unknown, init: unknown) => {
    calls.fetch.push({ url: String(url), init: init as FetchCall['init'] });
    if (opts.fetchThrows !== undefined) {
      throw opts.fetchThrows;
    }
    const res = opts.fetchResponse ?? { ok: true, json: { choices: [{ message: { content: 'feat: 生成结果\n\n第二段落忽略' } }] } };
    return {
      ok: res.ok,
      status: res.status ?? 200,
      async json() {
        return res.json ?? {};
      },
      async text() {
        return res.text ?? '';
      },
    };
  }) as unknown as typeof fetch;
  const methods = createCommitMessageMethods({
    gitService,
    resolveChatTarget: async () => target,
    isProjectRegistered: () => opts.registered ?? true,
    fetchImpl,
  });
  return { methods, calls };
}

test('git/generateCommitMessage：成功单次调用并返回剥围栏后的首段文本', async () => {
  const { methods, calls } = makeFakes({});
  const r = await methods['git/generateCommitMessage']({ path: 'C:/dev/a' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { message: 'feat: 生成结果' });
  assert.equal(calls.fetch.length, 1);
  const call = calls.fetch[0]!;
  // URL 归一：baseUrl 尾斜杠不产生双斜杠
  assert.equal(call.url, 'https://api.example.com/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.authorization, 'Bearer sk-secret-123');
  const body = JSON.parse(call.init.body) as Record<string, unknown>;
  assert.equal(body.model, 'm-1');
  assert.equal(body.stream, false);
  const messages = body.messages as Array<{ role: string; content: string }>;
  assert.equal(messages.length, 2);
  assert.ok(messages[1]!.content.includes('Files (2):'));
});

test('git/generateCommitMessage：lang 缺省走中文提示词，en 走英文（TD-GC-05）', async () => {
  const zh = makeFakes({});
  await zh.methods['git/generateCommitMessage']({ path: 'C:/dev/a' });
  const zhBody = JSON.parse(zh.calls.fetch[0]!.init.body) as { messages: Array<{ content: string }> };
  assert.ok(zhBody.messages[0]!.content.includes('使用中文'));

  const en = makeFakes({});
  await en.methods['git/generateCommitMessage']({ path: 'C:/dev/a', lang: 'en' });
  const enBody = JSON.parse(en.calls.fetch[0]!.init.body) as { messages: Array<{ content: string }> };
  assert.ok(enBody.messages[0]!.content.includes('Write in English'));
});

test('git/generateCommitMessage：无变更 6008 且不发请求（AC 边界）', async () => {
  const { methods, calls } = makeFakes({ diff: { hasChanges: false, fileCount: 0, text: '' } });
  const r = await methods['git/generateCommitMessage']({ path: 'C:/dev/a' });
  assert.equal(r.code, 6008);
  assert.match(r.message, /无变更/);
  assert.equal(calls.fetch.length, 0);
});

test('git/generateCommitMessage：provider 解析失败原样透传码与消息，不发请求', async () => {
  const { methods, calls } = makeFakes({
    target: { ok: false, code: 6008, message: '未配置模型：请先在设置页配置 provider 与默认模型' },
  });
  const r = await methods['git/generateCommitMessage']({ path: 'C:/dev/a' });
  assert.equal(r.code, 6008);
  assert.match(r.message, /未配置模型/);
  assert.equal(calls.fetch.length, 0);
});

test('git/generateCommitMessage：HTTP 非 2xx → 6008（AC-11-11），错误消息不含 apiKey', async () => {
  const { methods } = makeFakes({
    fetchResponse: { ok: false, status: 500, text: 'internal error for key sk-secret-123' },
  });
  const r = await methods['git/generateCommitMessage']({ path: 'C:/dev/a' });
  assert.equal(r.code, 6008);
  assert.match(r.message, /HTTP 500/);
  assert.ok(!r.message.includes('sk-secret-123'));
});

test('git/generateCommitMessage：fetch 网络抛错 → 6008 生成失败带原因', async () => {
  const { methods } = makeFakes({ fetchThrows: new Error('fetch failed: ECONNREFUSED') });
  const r = await methods['git/generateCommitMessage']({ path: 'C:/dev/a' });
  assert.equal(r.code, 6008);
  assert.match(r.message, /ECONNREFUSED/);
});

test('git/generateCommitMessage：模型返回空内容 → 6008', async () => {
  const { methods } = makeFakes({ fetchResponse: { ok: true, json: { choices: [{ message: { content: '  ' } }] } } });
  const r = await methods['git/generateCommitMessage']({ path: 'C:/dev/a' });
  assert.equal(r.code, 6008);
  assert.match(r.message, /空内容/);
});

test('git/generateCommitMessage：path 缺失 1001；未注册项目 1002', async () => {
  const { methods } = makeFakes({});
  assert.equal((await methods['git/generateCommitMessage']({})).code, 1001);
  assert.equal((await methods['git/generateCommitMessage']({ path: '  ' })).code, 1001);
  const unreg = makeFakes({ registered: false });
  assert.equal((await unreg.methods['git/generateCommitMessage']({ path: 'C:/nope' })).code, 1002);
});

test('extractCommitMessage：围栏与多形态响应归一', () => {
  assert.equal(extractCommitMessage('```\nfeat: a\n```'), 'feat: a');
  assert.equal(extractCommitMessage('```markdown\nfix: b\n\n正文要点\n```'), 'fix: b');
  assert.equal(extractCommitMessage('  doc: c  '), 'doc: c');
  assert.equal(extractCommitMessage('第一行标题\n第二行属于同段'), '第一行标题\n第二行属于同段');
});
