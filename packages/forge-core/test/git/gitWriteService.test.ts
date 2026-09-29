/**
 * GitService 写路径单元测试（模块 11：git 提交/推送，docs/prd/11_git_commit_push.md）。
 *
 * 覆盖 getStatus / commit / push / collectCommitDiff 服务层契约：
 * - getStatus：文件数/numstat 汇总/stagedEmpty/stagedCount/unpushedCount/hasHead/detached/非仓库空值
 * - commit：空 message 1001、暂存空 6006（AC-11-07 双保险的服务端一道）、
 *   includeUnstaged=true 先 add -A、shortHash+fileCount、多行/横杠开头 message 原样入库
 * - push：无 upstream 自动 -u origin、成功回 {branch,remote}、落后远端 6007+stderr、
 *   detached HEAD 拒绝
 * - collectCommitDiff：tracked+untracked 清单、二进制只列名、每文件 diff 截断、
 *   无 HEAD 走 --cached 基线、无变更 hasChanges=false
 *
 * 真实 git CLI + os.tmpdir 临时仓库；提交身份用仓库局部 config（不依赖全局配置）。
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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-write-'));
}

async function git(cwd: string, ...args: string[]): Promise<void> {
  await exec('git', ['-C', cwd, ...args]);
}

/** 带一次提交（main、局部身份配置）的临时仓库 */
async function makeRepo(): Promise<string> {
  const dir = tmpDir();
  await git(dir, 'init', '-b', 'main');
  await git(dir, 'config', 'user.name', 't');
  await git(dir, 'config', 'user.email', 't@t');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\n');
  await git(dir, 'add', '.');
  await git(dir, 'commit', '-m', 'init');
  return dir;
}

async function headSubject(dir: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, 'log', '-1', '--pretty=%s']);
  return stdout.trim();
}

async function headBody(dir: string): Promise<string> {
  const { stdout } = await exec('git', ['-C', dir, 'log', '-1', '--pretty=%b']);
  return stdout.trim();
}

// ---------------------------------------------------------------- getStatus

test('getStatus：干净仓库 fileCount=0、stagedEmpty=true、hasHead=true、branch=main', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService();
    const st = await svc.getStatus(dir);
    assert.deepEqual(st, {
      isGitRepo: true,
      branch: 'main',
      detached: false,
      fileCount: 0,
      added: 0,
      removed: 0,
      stagedEmpty: true,
      stagedCount: 0,
      unpushedCount: null,
      hasHead: true,
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：未暂存改动计数且 stagedEmpty=true；暂存后 stagedEmpty=false 且 numstat 汇总', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nchanged\n');
    fs.writeFileSync(path.join(dir, 'new.txt'), 'x\ny\n');
    const svc = new GitService();
    let st = await svc.getStatus(dir);
    assert.equal(st.fileCount, 2); // 1 modified + 1 untracked
    assert.equal(st.stagedEmpty, true);
    assert.equal(st.stagedCount, 0); // 未 add → 暂存区 0 个文件
    assert.equal(st.added, 1); // untracked 不进 numstat；a.txt +1 -1
    assert.equal(st.removed, 1);
    await git(dir, 'add', '.');
    st = await svc.getStatus(dir);
    assert.equal(st.stagedEmpty, false);
    assert.equal(st.stagedCount, 2); // add 后待提交（不勾包含未暂存）= 2
    assert.equal(st.added, 3); // a.txt +1 + new.txt +2
    assert.equal(st.removed, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：空仓库（无 HEAD）hasHead=false 且分支名可见', async () => {
  const dir = tmpDir();
  try {
    await git(dir, 'init', '-b', 'main');
    const svc = new GitService();
    const st = await svc.getStatus(dir);
    assert.equal(st.isGitRepo, true);
    assert.equal(st.hasHead, false);
    assert.equal(st.branch, 'main');
    assert.equal(st.detached, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：detached HEAD 时 branch=短 SHA、detached=true', async () => {
  const dir = await makeRepo();
  try {
    await git(dir, 'checkout', '--detach', 'HEAD');
    const svc = new GitService();
    const st = await svc.getStatus(dir);
    assert.equal(st.detached, true);
    assert.match(st.branch ?? '', /^[0-9a-f]{4,12}$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：非 git 目录返回 isGitRepo=false 空值', async () => {
  const dir = tmpDir();
  try {
    const svc = new GitService();
    const st = await svc.getStatus(dir);
    assert.equal(st.isGitRepo, false);
    assert.equal(st.fileCount, 0);
    assert.equal(st.stagedEmpty, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：unpushedCount 三级判据（upstream→origin/分支→从未推送的本地提交）', async () => {
  const { dir, remote } = await makePushableRepo();
  try {
    const svc = new GitService();
    // origin 已配置但从未 fetch（无任何远端跟踪引用）→ 全部提交都算未推送：init 动了 1 个文件
    assert.equal((await svc.getStatus(dir)).unpushedCount, 1);
    await git(dir, 'push', '-u', 'origin', 'main');
    assert.equal((await svc.getStatus(dir)).unpushedCount, 0);
    // 本地新提交涉及 2 个文件 → 待推送 2（工作区脏与否不影响该数）
    fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nline2\nline3\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'two files');
    assert.equal((await svc.getStatus(dir)).unpushedCount, 2);
    const r = await svc.push(dir);
    assert.ok(r.ok);
    assert.equal((await svc.getStatus(dir)).unpushedCount, 0);
    // 用户真机场景：新分支 feature 从未推送（无 upstream、无 origin/feature）→ 数本地独有提交
    await git(dir, 'checkout', '-b', 'feature');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'feature only');
    assert.equal((await svc.getStatus(dir)).unpushedCount, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- commit

test('commit：空白 message 返回 1001，不产生任何提交', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService();
    for (const msg of ['', '   ']) {
      const r = await svc.commit(dir, msg, true);
      assert.ok(!r.ok);
      assert.equal(r.code, 1001);
    }
    const { stdout } = await exec('git', ['-C', dir, 'rev-list', '--count', 'HEAD']);
    assert.equal(stdout.trim(), '1');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commit：暂存区为空返回 6006（includeUnstaged=false 有未暂存改动 / 干净仓库）', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'dirty\n');
    const svc = new GitService();
    let r = await svc.commit(dir, 'feat: x', false);
    assert.ok(!r.ok);
    assert.equal(r.code, 6006);
    assert.match(r.message ?? '', /暂存区为空/);
    r = await svc.commit(dir, 'feat: x', true);
    assert.ok(r.ok); // 勾上后 add -A 兜住
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commit：includeUnstaged=true 先 add -A 全量入库，返回 shortHash+fileCount', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'modified\n');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'new file\n');
    const svc = new GitService();
    const r = await svc.commit(dir, 'feat: two files', true);
    assert.ok(r.ok);
    assert.match(r.data.shortHash, /^[0-9a-f]{4,12}$/);
    assert.equal(r.data.fileCount, 2);
    assert.equal(await headSubject(dir), 'feat: two files');
    const { stdout } = await exec('git', ['-C', dir, 'status', '--porcelain']);
    assert.equal(stdout.trim(), '');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commit：多行与横杠开头的 message 原样入库（数组化传参不经 shell）', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x\n');
    const svc = new GitService();
    const msg = 'refactor: dangerous\n\n-m fake-flag; echo pwned > /tmp/forge-commit-inject\n正文第二行';
    const r = await svc.commit(dir, msg, true);
    assert.ok(r.ok);
    assert.equal(await headSubject(dir), 'refactor: dangerous');
    const body = await headBody(dir);
    assert.ok(body.includes('-m fake-flag; echo pwned > /tmp/forge-commit-inject'));
    assert.ok(body.includes('正文第二行'));
    assert.ok(!fs.existsSync('/tmp/forge-commit-inject'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commit：includeUnstaged=false 只提交已暂存内容，未暂存改动留在工作区', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\n');
    await git(dir, 'add', 'a.txt');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'staged\nunstaged too\n');
    const svc = new GitService();
    const r = await svc.commit(dir, 'fix: staged only', false);
    assert.ok(r.ok);
    assert.equal(r.data.fileCount, 1);
    const st = await svc.getStatus(dir);
    assert.equal(st.fileCount, 1); // 剩余未暂存改动仍在
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('commit：git 拒绝（hook 失败）返回 6006 + stderr，add 的暂存不回退', async () => {
  const dir = await makeRepo();
  try {
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    fs.writeFileSync(hook, '#!/bin/sh\necho "hook says no" >&2\nexit 1\n');
    fs.chmodSync(hook, 0o755);
    fs.writeFileSync(path.join(dir, 'a.txt'), 'change\n');
    const svc = new GitService();
    const r = await svc.commit(dir, 'feat: blocked', true);
    assert.ok(!r.ok);
    assert.equal(r.code, 6006);
    assert.ok((r.stderr ?? '').includes('hook says no'));
    const st = await svc.getStatus(dir);
    assert.equal(st.stagedEmpty, false); // 已 add 未回退（PRD：如实提示）
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- push

/** 建 bare 远端 + 当前分支已推送的仓库 */
async function makePushableRepo(): Promise<{ dir: string; remote: string }> {
  const remote = tmpDir();
  const dir = await makeRepo();
  await git(remote, 'init', '--bare', '-b', 'main');
  await git(dir, 'remote', 'add', 'origin', remote);
  return { dir, remote };
}

test('push：无 upstream 自动 -u origin <branch>，成功后远端可见', async () => {
  const { dir, remote } = await makePushableRepo();
  try {
    const svc = new GitService();
    const r = await svc.push(dir);
    assert.ok(r.ok);
    assert.deepEqual(r.data, { branch: 'main', remote: 'origin' });
    const { stdout } = await exec('git', ['-C', remote, 'log', '--oneline', 'main']);
    assert.ok(stdout.includes('init'));
    // 第二次走已有 upstream 路径
    const r2 = await svc.push(dir);
    assert.ok(r2.ok);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('push：落后远端返回 6007 + non-fast-forward stderr（AC-11-09）', async () => {
  const { dir, remote } = await makePushableRepo();
  try {
    const svc = new GitService();
    await svc.push(dir); // 建 upstream
    // 另一克隆推进远端
    const other = tmpDir();
    try {
      await exec('git', ['clone', remote, other]);
      await git(other, 'config', 'user.name', 'o');
      await git(other, 'config', 'user.email', 'o@o');
      fs.writeFileSync(path.join(other, 'o.txt'), 'o\n');
      await git(other, 'add', '.');
      await git(other, 'commit', '-m', 'ahead');
      await git(other, 'push', 'origin', 'main');
      // 本地再提交一笔 → push 必被拒
      fs.writeFileSync(path.join(dir, 'local.txt'), 'l\n');
      await svc.commit(dir, 'feat: local', true);
      const r = await svc.push(dir);
      assert.ok(!r.ok);
      assert.equal(r.code, 6007);
      assert.match(r.stderr ?? '', /rejected/);
    } finally {
      fs.rmSync(other, { recursive: true, force: true });
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(remote, { recursive: true, force: true });
  }
});

test('push：detached HEAD 拒绝（6007），无远端时报错透传 stderr', async () => {
  const dir = await makeRepo();
  try {
    await git(dir, 'checkout', '--detach', 'HEAD');
    const svc = new GitService();
    const r = await svc.push(dir);
    assert.ok(!r.ok);
    assert.equal(r.code, 6007);
    assert.match(r.message ?? '', /分离 HEAD/);
    // 有分支但无 upstream 且无 origin 远端：stderr 透传
    await git(dir, 'checkout', 'main');
    const r2 = await svc.push(dir);
    assert.ok(!r2.ok);
    assert.equal(r2.code, 6007);
    assert.ok(typeof r2.stderr === 'string' && r2.stderr.length > 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- collectCommitDiff

test('collectCommitDiff：tracked 改动 + untracked + 二进制清单与 diff 段', async () => {
  const dir = await makeRepo();
  try {
    // 先落一个二进制基线提交，再修改它 → numstat 报 '-'（二进制只列名）
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2]));
    await git(dir, 'add', '.');
    await git(dir, 'commit', '-m', 'bin baseline');
    fs.writeFileSync(path.join(dir, 'blob.bin'), Buffer.from([0, 1, 2, 3, 0, 255]));
    fs.writeFileSync(path.join(dir, 'a.txt'), 'line1\nmodified\n');
    fs.writeFileSync(path.join(dir, 'untracked.txt'), 'new\n');
    const svc = new GitService();
    const d = await svc.collectCommitDiff(dir);
    assert.equal(d.hasChanges, true);
    assert.equal(d.fileCount, 3);
    assert.ok(d.text.includes('Files (3):'));
    assert.ok(d.text.includes('a.txt'));
    assert.ok(d.text.includes('new(untracked)  untracked.txt'));
    assert.ok(d.text.includes('bin  blob.bin'));
    assert.ok(d.text.includes('diff --git'));
    assert.ok(d.text.includes('+modified'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectCommitDiff：无变更返回 hasChanges=false；每文件 diff 截断到前 40 行', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService();
    const empty = await svc.collectCommitDiff(dir);
    assert.deepEqual(empty, { hasChanges: false, fileCount: 0, text: '' });
    fs.writeFileSync(
      path.join(dir, 'a.txt'),
      Array.from({ length: 200 }, (_, i) => `l${i}`).join('\n') + '\n',
    );
    const d = await svc.collectCommitDiff(dir);
    assert.equal(d.hasChanges, true);
    assert.ok(d.text.includes('(file diff truncated)'));
    // 40 行截断：不应出现第 60 行内容
    assert.ok(!d.text.includes('+l60'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('collectCommitDiff：空仓库（无 HEAD）走 --cached 基线，staged 内容出现在 diff 段', async () => {
  const dir = tmpDir();
  try {
    await git(dir, 'init', '-b', 'main');
    await git(dir, 'config', 'user.name', 't');
    await git(dir, 'config', 'user.email', 't@t');
    fs.writeFileSync(path.join(dir, 'seed.txt'), 'from cached\n');
    await git(dir, 'add', '.');
    const svc = new GitService();
    const d = await svc.collectCommitDiff(dir);
    assert.equal(d.hasChanges, true);
    assert.ok(d.text.includes('seed.txt'));
    assert.ok(d.text.includes('+from cached'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
