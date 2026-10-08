/**
 * GitService 提交历史单元测试（CE-S11，PRD 12 §3.7 / api/11 §6~§8）。
 *
 * 真实 git CLI 在 os.tmpdir 临时仓库上执行（沿用 gitService.test.ts 的 makeRepo 范式），
 * 测完 rmSync 清理。**不 mock git** —— 本组用例的价值恰恰在于 git 的真实边界行为
 * （unborn HEAD exit 128、merge 的 git show 返 0 行、rename 的 `-z` 口径、quotepath 转义），
 * 换成 mock 就等于把要测的东西测没了。
 *
 * 对应 docs/test/12_code_explorer/api.md 的 A-CE-02~A-CE-11。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { GitService, type GitCommitDetailData, type GitCommitFileDiffData, type GitCommitLogData } from '../../src/git/gitService.ts';

const exec = promisify(execFile);

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-hist-'));
}

async function commitAs(cwd: string, name: string, email: string, message: string): Promise<void> {
  await exec('git', ['-C', cwd, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-m', message]);
}

async function addAll(cwd: string, name: string, email: string): Promise<void> {
  await exec('git', ['-C', cwd, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'add', '.']);
}

/** 空仓库（有 .git 但无任何提交 = unborn HEAD） */
async function makeEmptyRepo(): Promise<string> {
  const dir = tmpDir();
  await exec('git', ['-C', dir, 'init', '-b', 'main']);
  return dir;
}

/** 跑一次用例并清理临时仓库 */
async function withRepo<T>(make: () => Promise<string>, fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await make();
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 取提交列表（失败时把信封内容带进断言消息，避免只看到 undefined） */
async function log(svc: GitService, dir: string, limit?: number, skip?: number): Promise<GitCommitLogData> {
  const r = await svc.getCommitLog(dir, limit, skip);
  assert.ok(r.ok, `getCommitLog 应成功，实际信封：${JSON.stringify(r)}`);
  return r.data;
}

async function detail(svc: GitService, dir: string, sha: string): Promise<GitCommitDetailData> {
  const r = await svc.getCommitDetail(dir, sha);
  assert.ok(r.ok, `getCommitDetail 应成功，实际信封：${JSON.stringify(r)}`);
  return r.data;
}

async function fileDiff(svc: GitService, dir: string, sha: string, rel: string): Promise<GitCommitFileDiffData> {
  const r = await svc.getCommitFileDiff(dir, sha, rel);
  assert.ok(r.ok, `getCommitFileDiff 应成功，实际信封：${JSON.stringify(r)}`);
  return r.data;
}

/**
 * 覆盖全部边界的 fixture 仓库（共 6 次提交）：
 *   c1 root    首个提交（含中文路径）
 *   c2 rename  纯重命名（相似度 100%）
 *   c3 binary  二进制文件
 *   c4 feature 分支上的提交
 *   c5 main    主线上的提交
 *   c6 merge   merge commit（走第一父口径的关键用例）
 */
async function makeFixtureRepo(): Promise<string> {
  const dir = tmpDir();
  await exec('git', ['-C', dir, 'init', '-b', 'main']);

  fs.writeFileSync(path.join(dir, '中文文件.md'), '第一行\n第二行\n第三行\n');
  fs.mkdirSync(path.join(dir, '文档目录'), { recursive: true });
  fs.writeFileSync(path.join(dir, '文档目录', '说明.md'), '说明\n');
  await addAll(dir, '陈默', 'chenmo@kibo.com.cn');
  await commitAs(dir, '陈默', 'chenmo@kibo.com.cn', 'feat: 首个提交');

  await exec('git', ['-C', dir, 'mv', '文档目录/说明.md', '文档目录/重命名后.md']);
  await commitAs(dir, '陈默', 'chenmo@kibo.com.cn', 'refactor: 纯重命名');

  fs.writeFileSync(path.join(dir, 'bin.dat'), Buffer.from(Array.from({ length: 64 }, (_, i) => (i * 37) % 256)));
  await addAll(dir, '王工', 'ligang@kibo.com.cn');
  await commitAs(dir, '王工', 'ligang@kibo.com.cn', 'chore: 二进制文件');

  await exec('git', ['-C', dir, 'checkout', '-q', '-b', 'feature']);
  fs.writeFileSync(path.join(dir, 'feature.txt'), 'feature line\n');
  await addAll(dir, '王工', 'ligang@kibo.com.cn');
  await commitAs(dir, '王工', 'ligang@kibo.com.cn', 'feat: 分支上的改动');

  await exec('git', ['-C', dir, 'checkout', '-q', 'main']);
  fs.writeFileSync(path.join(dir, 'main.txt'), 'main line\n');
  await addAll(dir, '李工', 'lihua@kibo.com.cn');
  await commitAs(dir, '李工', 'lihua@kibo.com.cn', 'feat: 主线上的改动');

  await exec('git', ['-C', dir, 'merge', '--no-ff', '-q', '-m', 'Merge branch feature', 'feature']);

  return dir;
}

/* ==================== git/getCommitLog ==================== */

test('getCommitLog：返回 6 条提交且作者为 author', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    assert.equal(d.commits.length, 6, 'root + rename + binary + 分支 + 主线 + merge');

    const head = d.commits[0];
    assert.match(head.sha, /^[0-9a-f]{40}$/);
    assert.equal(head.shortSha.length, 7);
    assert.ok(head.subject.length > 0);
    // epoch 秒（整数），不是格式化字符串 —— 时区归展示层
    assert.equal(Number.isInteger(head.authoredAt), true, 'authoredAt 必须是 epoch 秒整数');
    assert.ok(head.authoredAt > 1_600_000_000 && head.authoredAt < 4_000_000_000);
    assert.equal(typeof head.parentCount, 'number');
  });
});

test('getCommitLog：不同作者的 authorName 正确落位', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const authors = new Set(d.commits.map((c) => c.authorName));
    assert.ok(authors.has('陈默'), `缺 陈默：${[...authors]}`);
    assert.ok(authors.has('王工'), `缺 王工：${[...authors]}`);
    assert.ok(authors.has('李工'), `缺 李工：${[...authors]}`);
  });
});

test('getCommitLog：中文 commit message 不乱码', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const subjects = d.commits.map((c) => c.subject);
    assert.ok(subjects.includes('feat: 首个提交'), `中文 subject 缺失：${JSON.stringify(subjects)}`);
  });
});

test('getCommitLog：merge 的 parentCount>=2 且 isMerge=true', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const merge = d.commits.find((c) => c.isMerge);
    assert.ok(merge, '应识别出 merge commit');
    assert.ok(merge.parentCount >= 2);
    // 非 merge 提交：首条历史（root）无父 = 0，其余均为 1
    for (const c of d.commits.filter((x) => !x.isMerge)) {
      assert.ok(c.parentCount === 0 || c.parentCount === 1, `${c.shortSha} 的 parentCount=${c.parentCount}`);
    }
    const root = d.commits[d.commits.length - 1];
    assert.equal(root.parentCount, 0, '最早的一条提交应是 root（无父）');
    assert.equal(root.isMerge, false);
  });
});

test('getCommitLog：空仓库（unborn HEAD）返回空数组而非报错', async () => {
  await withRepo(makeEmptyRepo, async (dir) => {
    // git log 在 unborn HEAD 上是 exit 128 + "does not have any commits yet"，
    // 服务层必须归一为成功（AC-CE-040）—— 这正是本用例的全部意义
    const svc = new GitService();
    const d = await log(svc, dir);
    assert.deepEqual(d.commits, []);
    assert.equal(d.hasMore, false);
  });
});

test('getCommitLog：非 git 目录返回空数组而非抛错', async () => {
  await withRepo(tmpDir, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    assert.deepEqual(d.commits, []);
  });
});

test('getCommitLog：limit/skip 分页不重不漏，越界给空且不报错', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const p1 = await log(svc, dir, 2, 0);
    const p2 = await log(svc, dir, 2, 2);
    assert.equal(p1.commits.length, 2);
    assert.equal(p2.commits.length, 2);
    assert.equal(p1.hasMore, true);
    const overlap = p1.commits.filter((a) => p2.commits.some((b) => b.sha === a.sha));
    assert.equal(overlap.length, 0, '两页 sha 不得重叠');

    const past = await log(svc, dir, 10, 999);
    assert.deepEqual(past.commits, [], '越界应给空数组而非报错');
    assert.equal(past.hasMore, false);
  });
});

test('getCommitLog：limit 非法被拒（不得静默夹取）', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    for (const bad of [0, -1, 501, 1.5]) {
      const r = await svc.getCommitLog(dir, bad, 0);
      assert.equal(r.ok, false, `limit=${bad} 应被拒`);
      if (!r.ok) assert.equal(r.code, 1001);
    }
    const neg = await svc.getCommitLog(dir, 10, -1);
    assert.equal(neg.ok, false, 'skip<0 应被拒');
  });
});

/* ==================== git/getCommitDetail ==================== */

test('getCommitDetail：响应不含 diff 字段（两级取数契约）', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const det = await detail(svc, dir, d.commits[0].sha);
    assert.equal(
      Object.prototype.hasOwnProperty.call(det as unknown as Record<string, unknown>, 'diff'),
      false,
      '详情响应不得含 diff —— patch 必须走 getCommitFileDiff 按文件懒取（AC-CE-037）',
    );
    assert.ok(det.files.length > 0);
  });
});

test('getCommitDetail：作者时间与提交时间分别返回', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const det = await detail(svc, dir, d.commits[0].sha);
    assert.equal(Number.isInteger(det.authoredAt), true);
    assert.equal(Number.isInteger(det.committedAt), true);
    assert.ok(det.authorName.length > 0);
    assert.ok(det.authorEmail.includes('@'));
    assert.ok(det.committerEmail.includes('@'));
  });
});

test('getCommitDetail：root commit 正常返回（无 <sha>^1）', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const root = d.commits[d.commits.length - 1];
    assert.equal(root.parentCount, 0);
    const det = await detail(svc, dir, root.sha); // 若走 diff ^1 会在此抛 6001
    assert.equal(det.isRoot, true);
    assert.ok(det.files.length > 0, 'root 应含全量新增文件');
  });
});

test('getCommitDetail：merge commit 用第一父口径返回非空统计', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const merge = d.commits.find((c) => c.isMerge)!;
    const det = await detail(svc, dir, merge.sha);
    assert.equal(det.isMerge, true);
    assert.ok(det.files.length > 0, 'merge 的 files 不得为空');
    assert.ok(
      det.files.some((f) => f.additions > 0 || f.deletions > 0),
      'merge 至少应有一个文件有行级增删统计',
    );
  });
});

test('getCommitDetail：中文路径不转义成八进制（quotepath）', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const root = d.commits[d.commits.length - 1];
    const det = await detail(svc, dir, root.sha);
    const paths = det.files.map((f) => f.path);
    assert.ok(paths.includes('中文文件.md'), `中文路径缺失：${JSON.stringify(paths)}`);
    for (const p of paths) {
      assert.ok(!p.includes('\\344'), `路径被 quotepath 转义了：${p}`);
    }
  });
});

test('getCommitDetail：纯重命名还原 oldPath 而非 "a => b" 歧义串', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const rename = d.commits.find((c) => c.subject.includes('纯重命名'))!;
    const det = await detail(svc, dir, rename.sha);
    const f = det.files[0];
    assert.equal(f.status, 'R');
    assert.equal(f.oldPath, '文档目录/说明.md');
    assert.equal(f.path, '文档目录/重命名后.md');
    assert.ok(!String(f.oldPath).includes('=>'), 'oldPath 不得是 git 不带 -z 时的歧义写法');
  });
});

test('getCommitDetail：二进制文件增删为 -1 而非 0', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const binCommit = d.commits.find((c) => c.subject.includes('二进制'))!;
    const det = await detail(svc, dir, binCommit.sha);
    const f = det.files.find((x) => x.path === 'bin.dat');
    assert.ok(f, `应识别出 bin.dat，实际：${det.files.map((x) => x.path)}`);
    assert.equal(f.binary, true);
    assert.equal(f.additions, -1, '二进制必须为 -1（0 的语义是「真的没改行」）');
    assert.equal(f.deletions, -1);
  });
});

/* ==================== git/getCommitFileDiff ==================== */

test('getCommitFileDiff：merge commit 必须返回非空 patch', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    // 关键回归：git show <merge> 默认输出 0 行 patch，必须走 git diff <sha>^1 <sha>
    const svc = new GitService();
    const d = await log(svc, dir);
    const merge = d.commits.find((c) => c.isMerge)!;
    const res = await fileDiff(svc, dir, merge.sha, 'feature.txt');
    assert.ok(res.diff, '应返回 diff');
    assert.ok(res.diff.length > 0, 'merge 的单文件 diff 不得为空（git show 口径会返 0 行）');
    assert.ok(res.diff.includes('feature line'));
  });
});

test('getCommitFileDiff：root commit 不 fatal 且返回全新增 patch', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const root = d.commits[d.commits.length - 1];
    const res = await fileDiff(svc, dir, root.sha, '中文文件.md');
    assert.ok(res.diff, 'root 的 diff 不得为 null（会因缺 <sha>^1 而 fatal）');
    assert.ok(res.diff.includes('第一行'));
  });
});

test('getCommitFileDiff：二进制文件返回 null（与空串区分）', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const binCommit = d.commits.find((c) => c.subject.includes('二进制'))!;
    const res = await fileDiff(svc, dir, binCommit.sha, 'bin.dat');
    assert.equal(res.diff, null, '二进制应返回 null，UI 据此给二进制空态');
  });
});

test('getCommitFileDiff：纯重命名返回空串而非 null', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const rename = d.commits.find((c) => c.subject.includes('纯重命名'))!;
    const res = await fileDiff(svc, dir, rename.sha, '文档目录/重命名后.md');
    assert.equal(res.diff, '', '纯重命名无行级变化 → 空串（null 专指二进制）');
  });
});

test('getCommitFileDiff：路径逃逸与空路径被拒', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const d = await log(svc, dir);
    const sha = d.commits[0].sha;
    for (const bad of ['../outside', '/etc/passwd', 'a/../../b', '', '.']) {
      const r = await svc.getCommitFileDiff(dir, sha, bad);
      assert.equal(r.ok, false, `逃逸路径必须被拒：${JSON.stringify(bad)}`);
      if (!r.ok) assert.equal(r.code, 1001);
    }
  });
});

test('getCommitFileDiff：不存在的 sha 返 6001 而非崩溃', async () => {
  await withRepo(makeFixtureRepo, async (dir) => {
    const svc = new GitService();
    const r = await svc.getCommitFileDiff(dir, '0'.repeat(40), '中文文件.md');
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, 6001);
  });
});