/**
 * 模块 12 CE-S07：代码树的 Git 状态角标。
 *
 * 背景（真实缺陷）：`useCodeExplorer.loadGitStatus` 曾经用 `{ cwd }` 调
 * `git/getStatus`，而 core 的 `rpc/gitMethods.ts#getStatus` 收的是 `path`
 * （`requireString(params, 'path')`）。参数名对不上 → 恒 1001 →
 * `bridge.call` 抛错 → 被 loadGitStatus 的 `catch` 吞成 `[]` →
 * `.ctp-git` / `.cv-badge` / `dirBadge()` 全是**永不渲染的死代码**，
 * 且不报任何错。这是典型的「不报错、只是不出现」型缺陷。
 *
 * 测试策略：这里 mock 的是 **IPC 边界**（真正的外部系统），并且**忠实复刻
 * core 的参数校验**——`path` 缺失即回 1001。这样缺陷会自然复现，
 * 测试断言的是「loadGitStatus 返回变更文件列表」这个业务行为，
 * 而不是「某个 mock 被调用了几次」。
 *
 * 响应体按反模式 4 的要求**完整镜像** `GitStatusInfo` 的全部字段，
 * 而不是只给测试用得到的那几个。
 */
import { test, before } from 'node:test';
import assert from 'node:assert/strict';

import type { GitStatusInfo } from '../src/types.ts';
/** 真实响应形状：docs/api/11_git_commit_push.md §1 的全部字段 */
const STATUS_FIXTURE: GitStatusInfo = {
  isGitRepo: true,
  branch: 'main',
  detached: false,
  fileCount: 3,
  added: 40,
  removed: 5,
  stagedEmpty: false,
  stagedCount: 1,
  unpushedCount: 2,
  hasHead: true,
  files: [
    { path: 'src/a.ts', status: 'M', staged: false },
    { path: 'src/b.vue', status: 'A', staged: true },
    { path: 'src/c.md', status: '?', staged: false },
  ],
};

/**
 * `git/getStatus` 的忠实替身：镜像 core `rpc/gitMethods.ts` 的
 * `requireString(params, 'path')` 语义——path 缺失/非字符串/空白一律 1001。
 * 参数名漂移会在这里被真实地拒绝，而不是被 mock 放过去。
 */
function invoke(method: string, params?: Record<string, unknown>): { code: number; message: string; data: unknown } {
  if (method === 'git/getStatus') {
    const path = params?.['path'];
    if (typeof path !== 'string' || path.trim() === '') {
      return { code: 1001, message: '参数错误：path 必须为非空字符串', data: null };
    }
    if (path !== 'D:/work/aiwork/forge') {
      return { code: 1002, message: `项目不存在: ${path}`, data: null };
    }
    return { code: 0, message: 'success', data: STATUS_FIXTURE };
  }
  return { code: 1001, message: `未 mock 的方法: ${method}`, data: null };
}

/** 记录生产代码实际发出的参数名，用于契约断言 */
const sent: { method: string; params?: Record<string, unknown> }[] = [];

let loadGitStatus: (projectPath: string) => Promise<GitStatusInfo | null>;

// window 必须在 import useCodeExplorer 之前就位：模块顶层会按
// `typeof window.forge?.on === 'function'` 决定是否订阅事件。
before(async () => {
  (globalThis as Record<string, unknown>)['window'] = {
    // usePreferences 顶层要挂 resize 监听读视口宽：替身得能接住，
    // 否则模块加载就炸（window.addEventListener is not a function）
    innerWidth: 1440,
    addEventListener: () => {},
    forge: {
      invoke: (m: string, p?: Record<string, unknown>) => {
        sent.push({ method: m, params: p });
        return Promise.resolve(invoke(m, p));
      },
      // 真实 preload 的 on 返回取消订阅函数；这里只保证模块顶层订阅不炸
      on: () => () => {},
    },
  };
  const mod = await import('../src/composables/useCodeExplorer.ts');
  loadGitStatus = mod.useCodeExplorer().loadGitStatus;
});

// ===== 业务行为 =====

test('loadGitStatus：已注册项目 → 返回 git 报告的变更文件列表', async () => {
  const info = await loadGitStatus('D:/work/aiwork/forge');
  assert.ok(info, '应返回整份 GitStatusInfo（角标/变更视图/底栏条共用同一份）');
  assert.equal(info!.files.length, 3, '三个变更文件都应返回（回归：曾恒为空数组）');
  assert.deepEqual(
    info!.files.map((f) => f.status),
    ['M', 'A', '?'],
    '状态字母应原样透传，供树行尾角标消费',
  );
  assert.equal(info!.branch, 'main', '底栏提交条要 branch，整份返回才不会丢字段');
  assert.equal(info!.fileCount, 3);
});

test('loadGitStatus：未注册项目 → 返回 null 且不抛错（角标是锦上添花，不该报障）', async () => {
  const info = await loadGitStatus('D:/not-registered');
  assert.equal(info, null, '1002 应被吞成 null，而不是冒泡到 UI');
});

// ===== 契约：参数名必须与 core 一致 =====

test('loadGitStatus：以 path 为键发参（core getStatus 只认 path，不认 cwd）', async () => {
  sent.length = 0;
  await loadGitStatus('D:/work/aiwork/forge');
  const call = sent.find((s) => s.method === 'git/getStatus');
  assert.ok(call, '应调用 git/getStatus');
  assert.ok(
    call!.params && 'path' in call!.params,
    `请求参数必须含 path，实际收到：${JSON.stringify(call!.params)}`,
  );
  assert.ok(
    !call!.params || !('cwd' in call!.params),
    '不应再出现 cwd：core 会忽略它并因缺 path 判 1001',
  );
});
