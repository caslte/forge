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

// ===== 模块 12 CE-S07：逐文件增删行数（变更视图的数据源） =====

/** 在 files[] 里按路径找条目（找不到直接炸，避免断言落到 undefined 上假绿） */
function fileOf(info: { files: { path: string }[] }, path: string) {
  const f = info.files.find((x) => x.path === path);
  assert.ok(f, `files[] 里应有 ${path}，实际：${JSON.stringify(info.files.map((x) => x.path))}`);
  return f as { path: string; status: string; staged: boolean; added: number; removed: number };
}

test('getStatus：已跟踪文件被修改 → 该文件带逐文件增删行数', async () => {
  const dir = await makeRepo();
  try {
    // a.txt 原 1 行「hello」，改成 3 行 → +3 -1
    fs.writeFileSync(path.join(dir, 'a.txt'), 'l1\nl2\nl3\n');
    const info = await new GitService().getStatus(dir);
    const f = fileOf(info, 'a.txt');
    assert.equal(f.status, 'M');
    assert.equal(f.added, 3, 'a.txt 应报 +3');
    assert.equal(f.removed, 1, 'a.txt 应报 -1');
    // 全仓库汇总必须等于该文件（单文件仓库时二者应当一致）
    assert.equal(info.added, f.added);
    assert.equal(info.removed, f.removed);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：未跟踪的新文件 → 整文件算新增（行数即 added）', async () => {
  const dir = await makeRepo();
  try {
    // 未跟踪文件不在 `diff HEAD --numstat` 输出里，git 根本不报它的行数。
    // 变更视图要显示 +N，只能由服务层自己数行——否则界面上是 +0，与事实矛盾。
    fs.writeFileSync(path.join(dir, 'brand-new.ts'), 'a\nb\nc\nd\n');
    const info = await new GitService().getStatus(dir);
    const f = fileOf(info, 'brand-new.ts');
    assert.equal(f.status, '?');
    assert.equal(f.added, 4, '未跟踪文件应报 +4（整文件都是新增行）');
    assert.equal(f.removed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：已跟踪文件被删除 → 报删除行数', async () => {
  const dir = await makeRepo();
  try {
    await commitFile(dir, 'gone.txt', 'x1\nx2\nx3\n');
    fs.rmSync(path.join(dir, 'gone.txt'));
    const info = await new GitService().getStatus(dir);
    const f = fileOf(info, 'gone.txt');
    assert.equal(f.status, 'D');
    assert.equal(f.removed, 3, 'gone.txt 应报 -3');
    assert.equal(f.added, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：多文件时非未跟踪项之和等于全仓库汇总（未跟踪不在汇总口径内）', async () => {
  const dir = await makeRepo();
  try {
    await commitFile(dir, 'two.txt', 'a\nb\nc\n');
    // a.txt 是**追加**（+1 -0，git 把公共前缀吃掉），two.txt 是**截断**（+0 -2）
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nX\n');
    fs.writeFileSync(path.join(dir, 'two.txt'), 'a\n');
    fs.writeFileSync(path.join(dir, 'fresh.ts'), 'n1\nn2\n');
    const info = await new GitService().getStatus(dir);
    console.log('    files:', JSON.stringify(info.files), 'aggregate:', info.added, info.removed);

    // 汇总口径 = `diff HEAD --numstat`，git **有意不把未跟踪文件放进去**
    // （PRD 11 GC-F01：「numstat 汇总新增行（二进制/无 HEAD 未跟踪文件不计）」）。
    // 所以只拿**非未跟踪**项去比：
    const tracked = info.files.filter((f) => f.status !== '?');
    assert.equal(
      tracked.reduce((n, f) => n + f.added, 0),
      info.added,
      '非未跟踪文件的 added 之和应等于 GitStatusInfo.added',
    );
    assert.equal(tracked.reduce((n, f) => n + f.removed, 0), info.removed);

    // 逐文件值本身要对
    assert.deepEqual(
      info.files.map((f) => [f.path, f.added, f.removed]),
      [
        ['a.txt', 1, 0],    // 追加
        ['two.txt', 0, 2],  // 截断
        ['fresh.ts', 2, 0], // 未跟踪：整文件算新增
      ],
    );
    // 而「这次一共改了多少行」是 files 全量汇总（含未跟踪），不是 aggregate
    assert.equal(info.files.reduce((n, f) => n + f.added, 0), 3);
    assert.equal(info.files.reduce((n, f) => n + f.removed, 0), 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getStatus：未跟踪的二进制文件 → 增删均为 0（不瞎猜行数）', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const info = await new GitService().getStatus(dir);
    const f = fileOf(info, 'pic.png');
    assert.equal(f.status, '?');
    assert.equal(f.added, 0, '二进制文件不报行数（与 numstat 对二进制的口径一致）');
    assert.equal(f.removed, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------- getFileDiff（模块 12 并排 diff 数据源）

test('getFileDiff：已跟踪文件被修改 → 返回相对 HEAD 的 unified diff 文本', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'hello\nworld\n'); // 追加一行
    const r = await new GitService().getFileDiff(dir, 'a.txt');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.data.diff !== null, '跟踪文件的修改必须给 diff 文本');
    const d = r.data.diff;
    assert.ok(d.includes('--- a/a.txt'), `应有旧文件头，实际：${JSON.stringify(d.slice(0, 120))}`);
    assert.ok(d.includes('+++ b/a.txt'), '应有新文件头');
    assert.ok(d.includes('@@'), '应有 hunk 头（行号数据源）');
    assert.ok(d.includes('+world'), '新增行应在 diff 里');
    // 纯追加时旧行是上下文（真实 git：@@ -1 +1,2 @@ / ` hello` / `+world`），
    // 不产生 -hello——钉住这个口径，别想当然写「-旧行」
    assert.ok(d.includes('\n hello\n+world'), '上下文行应原样保留');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getFileDiff：文件无变更 → diff 为空字符串（不是 null，两种状态要可区分）', async () => {
  const dir = await makeRepo();
  try {
    const r = await new GitService().getFileDiff(dir, 'a.txt');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.diff, '', '无差异 = 空串；null 留给「不可对比」（未跟踪等）');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getFileDiff：未跟踪文件 → diff=null（git 不给它的 diff，UI 用已加载正文合成全新增）', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'new.ts'), 'fresh\n');
    const r = await new GitService().getFileDiff(dir, 'new.ts');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.diff, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getFileDiff：二进制变更 → 原样返回 git 的 Binary files 提示行（解析层再识别）', async () => {
  const dir = await makeRepo();
  try {
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from([0x00, 0x01]));
    await git(dir, 'add', '.');
    await exec('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-m', 'bin']);
    fs.writeFileSync(path.join(dir, 'a.bin'), Buffer.from([0x00, 0x02]));
    const r = await new GitService().getFileDiff(dir, 'a.bin');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.data.diff !== null);
    assert.match(r.data.diff, /Binary files/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getFileDiff：无 HEAD 空仓库 → 已暂存文件走 --cached 基线（与 getStatus 同口径）', async () => {
  const dir = tmpDir();
  try {
    await git(dir, 'init', '-b', 'main');
    fs.writeFileSync(path.join(dir, 's.txt'), 'staged\n');
    await git(dir, 'add', '.');
    const r = await new GitService().getFileDiff(dir, 's.txt');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.ok(r.data.diff !== null, '空仓库的已暂存新增也要能对比');
    assert.ok(r.data.diff.includes('+++ b/s.txt'));
    assert.ok(r.data.diff.includes('+staged'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getFileDiff：relPath 逃逸（../ 与绝对路径）→ 1001，不落 git 命令', async () => {
  const dir = await makeRepo();
  try {
    const svc = new GitService();
    const up = await svc.getFileDiff(dir, '../outside.txt');
    assert.equal(up.ok, false);
    if (up.ok) return;
    assert.equal(up.code, 1001);
    const abs = await svc.getFileDiff(dir, path.join(dir, 'a.txt'));
    assert.equal(abs.ok, false);
    if (abs.ok) return;
    assert.equal(abs.code, 1001);
    const empty = await svc.getFileDiff(dir, '');
    assert.equal(empty.ok, false);
    if (empty.ok) return;
    assert.equal(empty.code, 1001);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getFileDiff：非 git 目录 → ok 且 diff=null（与 getStatus 的非仓库空值口径一致）', async () => {
  const dir = tmpDir();
  try {
    const r = await new GitService().getFileDiff(dir, 'a.txt');
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.equal(r.data.diff, null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
