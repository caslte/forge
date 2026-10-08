/**
 * Git RPC 方法层（gitMethods）单元测试（wu-01-project-git-core）。
 *
 * 覆盖 docs/api/01_project.md §10/§11 RPC 层契约：
 * - git/getBranchInfo：code 0 透传服务层分支信息；path 缺失 1001；未注册 1002；异常 5000
 * - git/switchBranch：成功 code 0 且分支变化时发射 git.branchChanged {path,branch}；
 *   幂等（changed=false）不发射；6001 + data.stderr 透传；branch 缺失 1001；未注册 1002
 *
 * 使用 node:test + assert/strict；gitService / projectService 注入 fake，
 * 事件经 EventEmitter 捕获。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { GitApi } from '../../src/rpc/gitMethods.ts';
import type { GitService } from '../../src/git/gitService.ts';
import type {
  GitBranchInfo,
  SwitchResult,
  GitStatusInfo,
  GitFileDiffResult,
  CommitResult,
  PushResult,
  CommitDiffContext,
  GitCommitLogResult,
  GitCommitDetailResult,
  GitCommitFileDiffResult,
} from '../../src/git/gitService.ts';

/** fake GitService：返回预设结果，记录调用（含模块 11 写路径方法） */
class FakeGitService implements GitService {
  info: GitBranchInfo = { isGitRepo: false, branch: null, branches: [], dirty: false, detached: false };
  switchResult: SwitchResult = { ok: true, data: { branch: 'main', changed: true } };
  status: GitStatusInfo = {
    isGitRepo: true, branch: 'main', detached: false,
    fileCount: 0, added: 0, removed: 0, stagedEmpty: true, stagedCount: 0, unpushedCount: null, hasHead: true,
  };
  commitResult: CommitResult = { ok: true, data: { shortHash: 'abc1234', fileCount: 1 } };
  pushResult: PushResult = { ok: true, data: { branch: 'main', remote: 'origin' } };
  diffContext: CommitDiffContext = { hasChanges: true, fileCount: 1, text: 'Files (1):' };
  fileDiff: GitFileDiffResult = { ok: true, data: { diff: 'diff --git a/a b/a\n' } };
  fileDiffCalls: Array<{ cwd: string; relPath: string }> = [];
  infoCalls: string[] = [];
  switchCalls: Array<{ cwd: string; branch: string }> = [];
  statusCalls: string[] = [];
  commitCalls: Array<{ cwd: string; message: string; includeUnstaged: boolean }> = [];
  pushCalls: string[] = [];
  throwOnSwitch: Error | null = null;

  // CE-S11 提交历史
  commitLog: GitCommitLogResult = { ok: true, data: { commits: [], hasMore: false } };
  commitDetail: GitCommitDetailResult = {
    ok: true,
    data: {
      sha: 'a'.repeat(40), shortSha: 'aaaaaaa', subject: 's', body: '',
      authorName: '陈默', authorEmail: 'c@t.com', authoredAt: 1, committedAt: 1,
      committerName: '陈默', committerEmail: 'c@t.com',
      parentCount: 1, isMerge: false, isRoot: false, files: [],
    },
  };
  commitFileDiff: GitCommitFileDiffResult = { ok: true, data: { diff: 'diff --git a/x b/x\n' } };
  commitLogCalls: Array<{ cwd: string; limit: number; skip: number }> = [];
  commitDetailCalls: Array<{ cwd: string; sha: string }> = [];
  commitFileDiffCalls: Array<{ cwd: string; sha: string; relPath: string }> = [];
  throwOnCommitLog: Error | null = null;

  async getBranchInfo(cwd: string): Promise<GitBranchInfo> {
    this.infoCalls.push(cwd);
    return this.info;
  }

  async switchBranch(cwd: string, branch: string): Promise<SwitchResult> {
    this.switchCalls.push({ cwd, branch });
    if (this.throwOnSwitch !== null) {
      throw this.throwOnSwitch;
    }
    return this.switchResult;
  }

  async getStatus(cwd: string): Promise<GitStatusInfo> {
    this.statusCalls.push(cwd);
    return this.status;
  }

  async getFileDiff(cwd: string, relPath: string): Promise<GitFileDiffResult> {
    this.fileDiffCalls.push({ cwd, relPath });
    return this.fileDiff;
  }

  async commit(cwd: string, message: string, includeUnstaged: boolean): Promise<CommitResult> {
    this.commitCalls.push({ cwd, message, includeUnstaged });
    return this.commitResult;
  }

  async push(cwd: string): Promise<PushResult> {
    this.pushCalls.push(cwd);
    return this.pushResult;
  }

  async collectCommitDiff(cwd: string): Promise<CommitDiffContext> {
    return this.diffContext;
  }

  // CE-S11
  async getCommitLog(cwd: string, limit?: number, skip?: number): Promise<GitCommitLogResult> {
    this.commitLogCalls.push({ cwd, limit: limit ?? 100, skip: skip ?? 0 });
    if (this.throwOnCommitLog !== null) {
      throw this.throwOnCommitLog;
    }
    return this.commitLog;
  }

  async getCommitDetail(cwd: string, sha: string): Promise<GitCommitDetailResult> {
    this.commitDetailCalls.push({ cwd, sha });
    return this.commitDetail;
  }

  async getCommitFileDiff(cwd: string, sha: string, relPath: string): Promise<GitCommitFileDiffResult> {
    this.commitFileDiffCalls.push({ cwd, sha, relPath });
    return this.commitFileDiff;
  }
}

/** fake ProjectService：仅 queryProjectList（注册判定用）；路径经 resolve 与真实唯一键同口径 */
function makeFakeProjects(registered: string[]): { queryProjectList(): unknown } {
  return {
    queryProjectList() {
      return { ok: true, data: { projects: registered.map((p) => ({ path: path.resolve(p) })) } };
    },
  };
}

function makeApi(registered: string[] = ['C:/dev/a']) {
  const gitService = new FakeGitService();
  const events = new EventEmitter();
  const emitted: Array<{ event: string; payload: unknown }> = [];
  events.on('git.branchChanged', (payload: unknown) => emitted.push({ event: 'git.branchChanged', payload }));
  const api = new GitApi({
    gitService,
    projectService: makeFakeProjects(registered) as never,
    events,
  });
  return { api, gitService, events, emitted };
}

test('git/getBranchInfo：成功返回 code 0 且透传服务层分支信息', async () => {
  const { api, gitService } = makeApi();
  gitService.info = { isGitRepo: true, branch: 'main', branches: ['main'], dirty: true, detached: false };
  const r = await api.methods['git/getBranchInfo']({ path: 'C:/dev/a' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, gitService.info);
  assert.equal(gitService.infoCalls[0], 'C:/dev/a');
});

test('git/getBranchInfo：path 缺失/空白返回 1001 且不进服务层', async () => {
  const { api, gitService } = makeApi();
  for (const params of [{}, { path: '' }, { path: '   ' }, { path: 42 }]) {
    const r = await api.methods['git/getBranchInfo'](params);
    assert.equal(r.code, 1001);
    assert.equal(r.data, null);
  }
  assert.equal(gitService.infoCalls.length, 0);
});

test('git/getBranchInfo：未注册项目返回 1002 且不进服务层', async () => {
  const { api, gitService } = makeApi(['C:/dev/a']);
  const r = await api.methods['git/getBranchInfo']({ path: 'C:/dev/other' });
  assert.equal(r.code, 1002);
  assert.equal(r.data, null);
  assert.equal(gitService.infoCalls.length, 0);
});

test('git/getBranchInfo：服务层意外抛错返回 5000', async () => {
  const { api, gitService } = makeApi();
  gitService.infoCalls.push = () => {
    throw new Error('boom');
  };
  const r = await api.methods['git/getBranchInfo']({ path: 'C:/dev/a' });
  assert.equal(r.code, 5000);
  assert.equal(r.data, null);
});

test('git/switchBranch：成功且分支变化时 code 0 并发射 git.branchChanged', async () => {
  const { api, gitService, emitted } = makeApi();
  gitService.switchResult = { ok: true, data: { branch: 'feat/login', changed: true } };
  const r = await api.methods['git/switchBranch']({ path: 'C:/dev/a', branch: 'feat/login' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { branch: 'feat/login' });
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].payload, { path: 'C:/dev/a', branch: 'feat/login' });
});

test('git/switchBranch：幂等（changed=false）code 0 且不发射事件', async () => {
  const { api, gitService, emitted } = makeApi();
  gitService.switchResult = { ok: true, data: { branch: 'main', changed: false } };
  const r = await api.methods['git/switchBranch']({ path: 'C:/dev/a', branch: 'main' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { branch: 'main' });
  assert.equal(emitted.length, 0);
});

test('git/switchBranch：6001 透传且 data.stderr 附 git 原始错误', async () => {
  const { api, gitService, emitted } = makeApi();
  gitService.switchResult = { ok: false, code: 6001, message: 'git 切换失败', stderr: 'error: Your local changes would be overwritten' };
  const r = await api.methods['git/switchBranch']({ path: 'C:/dev/a', branch: 'other' });
  assert.equal(r.code, 6001);
  assert.deepEqual(r.data, { stderr: 'error: Your local changes would be overwritten' });
  assert.equal(emitted.length, 0);
});

test('git/switchBranch：branch 缺失返回 1001 且不进服务层', async () => {
  const { api, gitService } = makeApi();
  for (const params of [{ path: 'C:/dev/a' }, { path: 'C:/dev/a', branch: '' }, { path: 'C:/dev/a', branch: '  ' }]) {
    const r = await api.methods['git/switchBranch'](params);
    assert.equal(r.code, 1001);
  }
  assert.equal(gitService.switchCalls.length, 0);
});

test('git/switchBranch：未注册项目返回 1002 且不进服务层', async () => {
  const { api, gitService } = makeApi(['C:/dev/a']);
  const r = await api.methods['git/switchBranch']({ path: 'C:/dev/other', branch: 'main' });
  assert.equal(r.code, 1002);
  assert.equal(gitService.switchCalls.length, 0);
});

test('git/switchBranch：服务层意外抛错返回 5000', async () => {
  const { api, gitService } = makeApi();
  gitService.throwOnSwitch = new Error('boom');
  const r = await api.methods['git/switchBranch']({ path: 'C:/dev/a', branch: 'main' });
  assert.equal(r.code, 5000);
  assert.equal(r.data, null);
});

// ------------------------------------------------- 模块 11：getStatus / commit / push

test('git/getStatus：成功返回 code 0 且透传服务层状态', async () => {
  const { api, gitService } = makeApi();
  gitService.status = {
    isGitRepo: true, branch: 'dev', detached: false,
    fileCount: 3, added: 44, removed: 11, stagedEmpty: false, stagedCount: 2, unpushedCount: 5, hasHead: true,
  };
  const r = await api.methods['git/getStatus']({ path: 'C:/dev/a' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, gitService.status);
  assert.equal(gitService.statusCalls[0], 'C:/dev/a');
});

test('git/getStatus：path 缺失 1001；未注册 1002；抛错 5000', async () => {
  const { api, gitService } = makeApi();
  assert.equal((await api.methods['git/getStatus']({})).code, 1001);
  assert.equal((await api.methods['git/getStatus']({ path: ' C:/nope' })).code, 1002);
  gitService.statusCalls.push = () => {
    throw new Error('boom');
  };
  assert.equal((await api.methods['git/getStatus']({ path: 'C:/dev/a' })).code, 5000);
});

test('git/getFileDiff：成功透传服务层 diff，relPath 原样下传', async () => {
  const { api, gitService } = makeApi();
  const r = await api.methods['git/getFileDiff']({ path: 'C:/dev/a', relPath: 'src/a.ts' });
  assert.equal(r.code, 0);
  assert.equal(r.data && (r.data as { diff: string | null }).diff, 'diff --git a/a b/a\n');
  assert.deepEqual(gitService.fileDiffCalls[0], { cwd: 'C:/dev/a', relPath: 'src/a.ts' });
});

test('git/getFileDiff：path/relPath 缺失 1001；未注册 1002', async () => {
  const { api } = makeApi();
  assert.equal((await api.methods['git/getFileDiff']({})).code, 1001);
  assert.equal((await api.methods['git/getFileDiff']({ path: 'C:/dev/a' })).code, 1001);
  assert.equal((await api.methods['git/getFileDiff']({ path: ' C:/nope', relPath: 'a.ts' })).code, 1002);
});

test('git/commit：成功透传 shortHash+fileCount；includeUnstaged 缺省视为 true', async () => {
  const { api, gitService } = makeApi();
  const r = await api.methods['git/commit']({ path: 'C:/dev/a', message: 'feat: x' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { shortHash: 'abc1234', fileCount: 1 });
  assert.deepEqual(gitService.commitCalls[0], {
    cwd: 'C:/dev/a', message: 'feat: x', includeUnstaged: true,
  });
  const r2 = await api.methods['git/commit']({
    path: 'C:/dev/a', message: 'fix: y', includeUnstaged: false,
  });
  assert.equal(r2.code, 0);
  assert.equal(gitService.commitCalls[1]?.includeUnstaged, false);
});

test('git/commit：message 缺失/空白 1001 不进服务层；未注册 1002', async () => {
  const { api, gitService } = makeApi();
  for (const params of [{ path: 'C:/dev/a' }, { path: 'C:/dev/a', message: '' }, { path: 'C:/dev/a', message: '  ' }]) {
    assert.equal((await api.methods['git/commit'](params)).code, 1001);
  }
  assert.equal(gitService.commitCalls.length, 0);
  assert.equal((await api.methods['git/commit']({ path: 'C:/nope', message: 'x' })).code, 1002);
  assert.equal(gitService.commitCalls.length, 0);
});

test('git/commit：6006 透传且 data.stderr 附 git 原始错误（与 6001 同形态）', async () => {
  const { api, gitService } = makeApi();
  gitService.commitResult = {
    ok: false, code: 6006, message: 'git 提交失败',
    stderr: 'Please tell me who you are',
  };
  const r = await api.methods['git/commit']({ path: 'C:/dev/a', message: 'feat: x' });
  assert.equal(r.code, 6006);
  assert.deepEqual(r.data, { stderr: 'Please tell me who you are' });
});

test('git/push：成功透传 branch+remote；6007 附 data.stderr 且弹窗语义由 UI 承接', async () => {
  const { api, gitService } = makeApi();
  const r = await api.methods['git/push']({ path: 'C:/dev/a' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { branch: 'main', remote: 'origin' });
  gitService.pushResult = {
    ok: false, code: 6007, message: 'git 推送失败',
    stderr: '! [rejected] main -> main (fetch first)',
  };
  const r2 = await api.methods['git/push']({ path: 'C:/dev/a' });
  assert.equal(r2.code, 6007);
  assert.deepEqual(r2.data, { stderr: '! [rejected] main -> main (fetch first)' });
});

test('git/push：path 缺失 1001；未注册 1002；抛错 5000', async () => {
  const { api, gitService } = makeApi();
  assert.equal((await api.methods['git/push']({})).code, 1001);
  assert.equal((await api.methods['git/push']({ path: 'C:/nope' })).code, 1002);
  gitService.pushCalls.push = () => {
    throw new Error('boom');
  };
  assert.equal((await api.methods['git/push']({ path: 'C:/dev/a' })).code, 5000);
});

/* ==================== CE-S11 提交历史 RPC 契约 ==================== */

test('git/getCommitLog：成功透传服务层结果，limit/skip 缺省口径为 100/0', async () => {
  const { api, gitService } = makeApi();
  gitService.commitLog = {
    ok: true,
    data: {
      commits: [{
        sha: 'b'.repeat(40), shortSha: 'bbbbbbb', subject: 'feat: x',
        authorName: '陈默', authorEmail: 'chenmo@kibo.com.cn',
        authoredAt: 1791438623, parentCount: 1, isMerge: false,
      }],
      hasMore: false,
    },
  };
  const r = await api.methods['git/getCommitLog']({ path: 'C:/dev/a' });
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, gitService.commitLog.ok ? gitService.commitLog.data : null);
  assert.deepEqual(gitService.commitLogCalls[0], { cwd: 'C:/dev/a', limit: 100, skip: 0 });
});

test('git/getCommitLog：显式 limit/skip 透传；path 非法 1001；未注册 1002；异常 5000', async () => {
  const { api, gitService } = makeApi();
  await api.methods['git/getCommitLog']({ path: 'C:/dev/a', limit: 20, skip: 40 });
  assert.deepEqual(gitService.commitLogCalls[0], { cwd: 'C:/dev/a', limit: 20, skip: 40 });

  for (const params of [{}, { path: '' }, { path: '  ' }, { path: 1 }]) {
    assert.equal((await api.methods['git/getCommitLog'](params)).code, 1001, JSON.stringify(params));
  }
  assert.equal((await api.methods['git/getCommitLog']({ path: 'C:/nope' })).code, 1002);

  gitService.throwOnCommitLog = new Error('boom');
  assert.equal((await api.methods['git/getCommitLog']({ path: 'C:/dev/a' })).code, 5000);
});

test('git/getCommitLog：空仓库由服务层归一为 code 0 + 空数组，本层不重复判断', async () => {
  const { api, gitService } = makeApi();
  gitService.commitLog = { ok: true, data: { commits: [], hasMore: false } };
  const r = await api.methods['git/getCommitLog']({ path: 'C:/dev/a' });
  assert.equal(r.code, 0, '空仓库不得变成错误码');
  assert.deepEqual(r.data, { commits: [], hasMore: false });
});

test('git/getCommitDetail：成功透传；sha 缺失 1001；未注册 1002', async () => {
  const { api, gitService } = makeApi();
  const ok1 = await api.methods['git/getCommitDetail']({ path: 'C:/dev/a', sha: 'abc' });
  assert.equal(ok1.code, 0);
  assert.deepEqual(gitService.commitDetailCalls[0], { cwd: 'C:/dev/a', sha: 'abc' });

  for (const params of [{ path: 'C:/dev/a' }, { path: 'C:/dev/a', sha: '' }, { sha: 'abc' }]) {
    assert.equal((await api.methods['git/getCommitDetail'](params)).code, 1001, JSON.stringify(params));
  }
  assert.equal((await api.methods['git/getCommitDetail']({ path: 'C:/nope', sha: 'abc' })).code, 1002);
});

test('git/getCommitDetail：服务层失败码原样透传（6001 不被改写）', async () => {
  const { api, gitService } = makeApi();
  gitService.commitDetail = { ok: false, code: 6001, message: 'git show 失败' };
  const r = await api.methods['git/getCommitDetail']({ path: 'C:/dev/a', sha: 'deadbeef' });
  assert.equal(r.code, 6001);
});

test('git/getCommitFileDiff：成功透传；file 缺失/逃逸前置 1001；未注册 1002', async () => {
  const { api, gitService } = makeApi();
  const r = await api.methods['git/getCommitFileDiff']({ path: 'C:/dev/a', sha: 'abc', file: 'src/a.ts' });
  assert.equal(r.code, 0);
  assert.deepEqual(gitService.commitFileDiffCalls[0], { cwd: 'C:/dev/a', sha: 'abc', relPath: 'src/a.ts' });

  for (const params of [
    { path: 'C:/dev/a', sha: 'abc' },
    { path: 'C:/dev/a', file: 'a.ts' },
    { path: 'C:/dev/a', sha: 'abc', file: '' },
    { sha: 'abc', file: 'a.ts' },
  ]) {
    assert.equal((await api.methods['git/getCommitFileDiff'](params)).code, 1001, JSON.stringify(params));
  }
  assert.equal(
    (await api.methods['git/getCommitFileDiff']({ path: 'C:/nope', sha: 'abc', file: 'a.ts' })).code,
    1002,
  );
});

test('CE-S11：三方法均已注册进 methods map（未注册会在主进程返 404）', async () => {
  const { api } = makeApi();
  for (const m of ['git/getCommitLog', 'git/getCommitDetail', 'git/getCommitFileDiff']) {
    assert.equal(typeof api.methods[m], 'function', `${m} 未注册`);
  }
});
