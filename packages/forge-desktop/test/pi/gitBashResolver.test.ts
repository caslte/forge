/**
 * gitBashResolver 单元测试（Git Bash 自动识别候选链）。
 *
 * 口径：候选链全部经依赖注入驱动（findOnPath / registryInstallPath / exists / env /
 * platform），需要真实文件的用例才落临时目录——不依赖测试机是否装了 Git、装在哪，
 * 也不真的 spawn where/reg。真实 existsSync 只在「优先级顺序」用例里参与，
 * 用于确认反推出的路径确实落在磁盘上。
 *
 * node:test + Node 22 --experimental-strip-types；临时目录 finally 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { isWslStubBash, resolveGitBash } from '../../src/pi/gitBashResolver.ts';

/** 建临时目录（内含落盘的空文件，供 existsSync 判定） */
function makeTmp(): { root: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-git-resolver-'));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

/** 在指定 Git 安装根下落盘 bash.exe 与可选 git.exe，返回绝对路径 */
function plantGitInstall(root: string, opts: { gitExeDir?: string; bashSub?: string } = {}): {
  bash: string;
  gitExe: string;
} {
  const bashRel = opts.bashSub ?? path.join('bin', 'bash.exe');
  const bash = path.join(root, bashRel);
  fs.mkdirSync(path.dirname(bash), { recursive: true });
  fs.writeFileSync(bash, '');
  const gitExe = path.join(root, opts.gitExeDir ?? 'cmd', 'git.exe');
  fs.mkdirSync(path.dirname(gitExe), { recursive: true });
  fs.writeFileSync(gitExe, '');
  return { bash, gitExe };
}

test('isWslStubBash：System32/SysWOW64 命中，Git Bash 路径不命中', () => {
  assert.equal(isWslStubBash('C:\\Windows\\System32\\bash.exe'), true);
  assert.equal(isWslStubBash('C:\\WINDOWS\\syswow64\\bash.exe'), true);
  assert.equal(isWslStubBash('C:\\works\\tools\\Git\\bin\\bash.exe'), false);
  assert.equal(isWslStubBash('/usr/bin/bash'), false);
});

test('resolveGitBash：where git.exe 反推安装根（自定义路径安装、PATH 只挂了 cmd 的机器）', () => {
  const { root, cleanup } = makeTmp();
  try {
    const gitRoot = path.join(root, 'tools', 'Git');
    const { bash, gitExe } = plantGitInstall(gitRoot);
    const resolved = resolveGitBash({
      platform: 'win32',
      env: {},
      findOnPath: (exe) => (exe === 'git.exe' ? [gitExe] : []),
      registryInstallPath: () => null,
    });
    assert.equal(resolved, bash);
  } finally {
    cleanup();
  }
});

test('resolveGitBash：安装根只有 usr\\bin\\bash.exe 时同样命中（同级候选回退）', () => {
  const { root, cleanup } = makeTmp();
  try {
    const gitRoot = path.join(root, 'PortableGit', 'versions', '1.0', 'mingw64');
    // PortableGit 形态：git.exe 在 mingw64\bin\，bash.exe 在安装根 mingw64\bin\ 或 usr\bin\
    const { gitExe } = plantGitInstall(gitRoot, { bashSub: path.join('usr', 'bin', 'bash.exe') });
    const expected = path.join(gitRoot, 'usr', 'bin', 'bash.exe');
    const resolved = resolveGitBash({
      platform: 'win32',
      env: {},
      findOnPath: (exe) => (exe === 'git.exe' ? [gitExe] : []),
      registryInstallPath: () => null,
    });
    assert.equal(resolved, expected);
  } finally {
    cleanup();
  }
});

test('resolveGitBash：where 找不到 git（完全不在 PATH）→ 注册表 InstallPath 兜底', () => {
  const { root, cleanup } = makeTmp();
  try {
    const gitRoot = path.join(root, 'installed', 'Git');
    const { bash } = plantGitInstall(gitRoot);
    const resolved = resolveGitBash({
      platform: 'win32',
      env: {},
      findOnPath: () => [],
      registryInstallPath: () => gitRoot,
    });
    assert.equal(resolved, bash);
  } finally {
    cleanup();
  }
});

test('resolveGitBash：默认安装路径（ProgramFiles\\Git）兜底', () => {
  const { root, cleanup } = makeTmp();
  try {
    const programFiles = path.join(root, 'Program Files');
    const { bash } = plantGitInstall(path.join(programFiles, 'Git'));
    const resolved = resolveGitBash({
      platform: 'win32',
      env: { ProgramFiles: programFiles },
      findOnPath: () => [],
      registryInstallPath: () => null,
    });
    assert.equal(resolved, bash);
  } finally {
    cleanup();
  }
});

test('resolveGitBash：优先级——where git.exe 反推优先于注册表', () => {
  const { root, cleanup } = makeTmp();
  try {
    const fromPath = path.join(root, 'from-path', 'Git');
    const fromRegistry = path.join(root, 'from-registry', 'Git');
    const a = plantGitInstall(fromPath);
    const b = plantGitInstall(fromRegistry);
    const resolved = resolveGitBash({
      platform: 'win32',
      env: {},
      findOnPath: (exe) => (exe === 'git.exe' ? [a.gitExe] : []),
      registryInstallPath: () => fromRegistry,
    });
    assert.equal(resolved, a.bash);
    assert.notEqual(resolved, b.bash);
  } finally {
    cleanup();
  }
});

test('resolveGitBash：PATH 兜底命中 System32 WSL 占位 → 拒绝，返回 null', () => {
  const resolved = resolveGitBash({
    platform: 'win32',
    // exists 恒真：只要「存在」就接受，唯一能拦住占位的就是 isWslStubBash 过滤
    env: {},
    exists: () => true,
    findOnPath: (exe) => (exe === 'bash.exe' ? ['C:\\Windows\\System32\\bash.exe'] : []),
    registryInstallPath: () => null,
  });
  assert.equal(resolved, null);
});

test('resolveGitBash：PATH 上有多个 bash（占位在前、真 bash 在后）→ 跳过占位取真 bash', () => {
  const realBash = 'C:\\cygwin64\\bin\\bash.exe';
  const resolved = resolveGitBash({
    platform: 'win32',
    env: {},
    exists: () => true,
    findOnPath: (exe) =>
      exe === 'bash.exe' ? ['C:\\Windows\\System32\\bash.exe', realBash] : [],
    registryInstallPath: () => null,
  });
  assert.equal(resolved, realBash);
});

test('resolveGitBash：候选全落空 → null（调用方保留原异常，引导装 Git）', () => {
  const resolved = resolveGitBash({
    platform: 'win32',
    env: {},
    findOnPath: () => [],
    registryInstallPath: () => null,
  });
  assert.equal(resolved, null);
});

test('resolveGitBash：非 Windows 走 /bin/bash 候选，不做 Windows 侧解析', () => {
  const resolved = resolveGitBash({
    platform: 'linux',
    exists: (candidate) => candidate === '/bin/bash',
    findOnPath: () => [],
  });
  assert.equal(resolved, '/bin/bash');
});
