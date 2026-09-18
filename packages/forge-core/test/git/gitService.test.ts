/**
 * GitService 单元测试（wu-01-project-git-core）。
 *
 * 覆盖 docs/api/01_project.md §10/§11 服务层契约：
 * - getBranchInfo 五态：正常 / detached / 空仓库（unborn）/ 非 git 目录 / gitBin 不存在
 * - dirty：status --porcelain 非空
 * - switchBranch：成功 / 幂等（当前分支==目标，changed=false）/ 冲突 6001+stderr 且分支不变 /
 *   远程同名建跟踪分支
 *
 * 使用 node:test + assert/strict；真实 git CLI 在 os.tmpdir 临时仓库上执行，
 * 测试结束 rmSync 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitService } from '../../src/git/gitService.ts';

const exec = promisify(execFile);

/** 创建一次性临时目录 */
function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-'));
}

/** 在指定目录执行 git 命令（测试辅助） */
async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args]);
}

/** 造一个带一次提交的临时仓库（默认分支 main） */
async function makeRepo(): Promise<string> {
  const dir = tmpDir();
  await git(dir, 'init', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\n');
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'init']);
  return dir;
}

/** 提交一个新文件（在当前分支上） */
async function commitFile(cwd: string, name: string, content: string): Promise<void> {
  fs.writeFileSync(path.join(cwd, name), content);
  await exec('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'add', '.']);
  await exec('git', ['-C', cwd, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', name]);
}

test('getBranchInfo：正常仓库返回分支列表与干净状态', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService();
    const info = await svc.getBranchInfo(dir);
    assert.equal(info.isGitRepo, true);
    assert.equal(info.branch, 'main');
    assert.ok(info.branches.includes('main'));
    assert.equal(info.dirty, false);
    assert.equal(info.detached, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getBranchInfo：有未提交更改时 dirty=true', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'changed\n');
    const svc = new GitService();
    const info = await svc.getBranchInfo(dir);
    assert.equal(info.dirty, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getBranchInfo：detached HEAD 时 branch=短 SHA 且 detached=true', async () => {
  const dir = await makeRepo();
  try {
    await commitFile(dir, 'b.txt', 'b\n');
    await git(dir, 'checkout', '--detach', 'HEAD');
    const svc = new GitService();
    const info = await svc.getBranchInfo(dir);
    assert.equal(info.detached, true);
    assert.equal(info.isGitRepo, true);
    // 短 SHA：非空、hex、长度 <= 12
    assert.match(info.branch ?? '', /^[0-9a-f]{4,12}$/);
    assert.ok(info.branches.includes('main'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getBranchInfo：空仓库（unborn）返回分支名且 branches 为空', async () => {
  const dir = tmpDir();
  try {
    await git(dir, 'init', '-b', 'main');
    const svc = new GitService();
    const info = await svc.getBranchInfo(dir);
    assert.equal(info.isGitRepo, true);
    assert.equal(info.branch, 'main');
    assert.deepEqual(info.branches, []);
    assert.equal(info.detached, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getBranchInfo：非 git 目录返回 isGitRepo=false 空值', async () => {
  const dir = tmpDir();
  try {
    const svc = new GitService();
    const info = await svc.getBranchInfo(dir);
    assert.deepEqual(info, { isGitRepo: false, branch: null, branches: [], dirty: false, detached: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getBranchInfo：gitBin 不存在时返回 isGitRepo=false', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService('git-definitely-not-exist-xyz');
    const info = await svc.getBranchInfo(dir);
    assert.deepEqual(info, { isGitRepo: false, branch: null, branches: [], dirty: false, detached: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switchBranch：切换成功返回新分支且状态生效', async () => {
  const dir = await makeRepo();
  try {
    await git(dir, 'branch', 'feat/login');
    const svc = new GitService();
    const r = await svc.switchBranch(dir, 'feat/login');
    assert.ok(r.ok);
    assert.equal(r.data.branch, 'feat/login');
    assert.equal(r.data.changed, true);
    const info = await svc.getBranchInfo(dir);
    assert.equal(info.branch, 'feat/login');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switchBranch：当前分支==目标时幂等（changed=false，git 无操作）', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService();
    const r = await svc.switchBranch(dir, 'main');
    assert.ok(r.ok);
    assert.equal(r.data.branch, 'main');
    assert.equal(r.data.changed, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switchBranch：git 拒绝（冲突）返回 6001 + stderr 且分支不变', async () => {
  const dir = await makeRepo();
  try {
    // other 分支修改 a.txt 并提交；回到 main 后再未提交修改 a.txt → 切换被拒
    await git(dir, 'switch', '-c', 'other');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'other\n');
    await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-am', 'other']);
    await git(dir, 'switch', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'local-change\n');
    const svc = new GitService();
    const r = await svc.switchBranch(dir, 'other');
    assert.ok(!r.ok);
    assert.equal(r.code, 6001);
    assert.ok(typeof r.stderr === 'string' && r.stderr.length > 0);
    const info = await svc.getBranchInfo(dir);
    assert.equal(info.branch, 'main');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('switchBranch：远程存在同名分支且本地不存在时自动建跟踪分支', async () => {
  const remote = tmpDir();
  const dir = await makeRepo();
  try {
    await git(remote, 'init', '--bare');
    await git(dir, 'remote', 'add', 'origin', remote);
    await git(dir, 'push', 'origin', 'main');
    await git(dir, 'switch', '-c', 'feat/x');
    await commitFile(dir, 'c.txt', 'c\n');
    await git(dir, 'push', 'origin', 'feat/x');
    await git(dir, 'switch', 'main');
    await git(dir, 'branch', '-D', 'feat/x');

    const svc = new GitService();
    const r = await svc.switchBranch(dir, 'feat/x');
    assert.ok(r.ok);
    assert.equal(r.data.branch, 'feat/x');
    const info = await svc.getBranchInfo(dir);
    assert.equal(info.branch, 'feat/x');
    assert.ok(info.branches.includes('feat/x'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('switchBranch：gitBin 不存在返回 6001', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService('git-definitely-not-exist-xyz');
    const r = await svc.switchBranch(dir, 'main');
    assert.ok(!r.ok);
    assert.equal(r.code, 6001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
