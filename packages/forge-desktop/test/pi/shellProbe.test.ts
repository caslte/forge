/**
 * shellProbe 单元测试。
 *
 * 背景：agentDir 切根后新根无 settings.json 时，pi 的 PATH 兜底可能命中
 * System32 WSL 占位（2026-09 事故）。探测复用 pi getShellConfig，异常分类：
 * - wsl-stub：解析到 <windir>\System32\bash.exe（仅 win32 判）；
 * - no-shell：getShellConfig 抛错（含 Custom shell path not found / 三级落空）。
 *
 * 用例全部经显式 shellPath 驱动（优先级第一级），不依赖测试机的 PATH/Git 安装，
 * 跨平台确定。node:test + Node 22 --experimental-strip-types；临时目录 finally 清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { ensurePiShellPath, isWslStubBash, probePiShell } from '../../src/pi/shellProbe.ts';

/** 建临时 agent 根（cwd 也指到这里，隔离仓库/家目录的项目级 settings） */
function makeTmpAgentDir(): { agentDir: string; cleanup: () => void } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-shell-probe-'));
  const agentDir = path.join(root, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  return { agentDir, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function writeSettings(agentDir: string, settings: Record<string, unknown>): void {
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify(settings), 'utf-8');
}

test('isWslStubBash：System32/SysWOW64 命中，Git Bash 路径不命中', () => {
  assert.equal(isWslStubBash('C:\\Windows\\System32\\bash.exe'), true);
  assert.equal(isWslStubBash('C:\\WINDOWS\\syswow64\\bash.exe'), true);
  assert.equal(isWslStubBash('C:\\works\\tools\\Git\\bin\\bash.exe'), false);
  assert.equal(isWslStubBash('/usr/bin/bash'), false);
});

test('probePiShell：shellPath 指向 System32 占位 → wsl-stub（仅 win32 判定）', () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    const stub = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'bash.exe');
    if (process.platform !== 'win32' || !fs.existsSync(stub)) return; // 非 Windows 无此判定
    writeSettings(agentDir, { shellPath: stub });
    const r = probePiShell(agentDir, agentDir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, 'wsl-stub');
      assert.equal(r.settingsPath, path.join(agentDir, 'settings.json'));
    }
  } finally {
    cleanup();
  }
});

test('probePiShell：shellPath 指向不存在的文件 → no-shell 且透传缺失路径', () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    const ghost = path.join(agentDir, 'no-such-bash.exe');
    writeSettings(agentDir, { shellPath: ghost });
    const r = probePiShell(agentDir, agentDir);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.reason, 'no-shell');
      assert.equal(r.shell, ghost);
    }
  } finally {
    cleanup();
  }
});

test('probePiShell：shellPath 指向真实文件 → ok 并回该路径', () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    const fake = path.join(agentDir, 'fake-bash.exe');
    fs.writeFileSync(fake, '', 'utf-8');
    writeSettings(agentDir, { shellPath: fake });
    const r = probePiShell(agentDir, agentDir);
    assert.equal(r.ok, true);
    if (r.ok) {
      // pi SettingsManager 对相对/绝对路径做 normalize，比较基名即可
      assert.equal(path.basename(r.shell), 'fake-bash.exe');
    }
  } finally {
    cleanup();
  }
});

/** 读回 settings.json（断言写入结果用） */
function readSettings(agentDir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf-8')) as Record<string, unknown>;
}

test('ensurePiShellPath：shell 已可用 → 直接返回，不触发候选解析（零副作用）', async () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    const fake = path.join(agentDir, 'ok-bash.exe');
    fs.writeFileSync(fake, '', 'utf-8');
    writeSettings(agentDir, { shellPath: fake });
    let resolvedCalls = 0;
    const r = await ensurePiShellPath(agentDir, agentDir, () => {
      resolvedCalls += 1;
      return null;
    });
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.autoFixed, undefined);
    assert.equal(resolvedCalls, 0, '已可用时不该去找 Git Bash（启动链零额外开销）');
  } finally {
    cleanup();
  }
});

test('ensurePiShellPath：不可用且解析不到 Git Bash → 保留原异常，不改配置', async () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    writeSettings(agentDir, { packages: ['npm:pi-memory'] });
    const r = await ensurePiShellPath(agentDir, agentDir, () => null);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no-shell');
    // 没找到候选就不该写任何东西（原配置原样）
    assert.deepEqual(readSettings(agentDir), { packages: ['npm:pi-memory'] });
  } finally {
    cleanup();
  }
});

test('ensurePiShellPath：不可用时自动写入 shellPath 并复探通过（autoFixed=true，既有配置不被破坏）', async () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    // 真实存在的假 bash（probePiShell 只做 existsSync，不执行它）
    const bash = path.join(agentDir, 'auto', 'bin', 'bash.exe');
    fs.mkdirSync(path.dirname(bash), { recursive: true });
    fs.writeFileSync(bash, '', 'utf-8');
    writeSettings(agentDir, { packages: ['npm:pi-memory', 'npm:pi-mcp-adapter'] });
    const r = await ensurePiShellPath(agentDir, agentDir, () => bash);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.autoFixed, true);
      assert.equal(path.basename(r.shell), 'bash.exe');
    }
    // 落盘核验：shellPath 写进去，packages 等既有字段原样保留（经 pi SettingsManager 合并写）
    const written = readSettings(agentDir);
    assert.equal(path.basename(String(written.shellPath)), 'bash.exe');
    assert.deepEqual(written.packages, ['npm:pi-memory', 'npm:pi-mcp-adapter']);
  } finally {
    cleanup();
  }
});

test('ensurePiShellPath：候选路径形态不规范（重复分隔符）→ 落盘前规范化', async () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    const bash = path.join(agentDir, 'auto', 'bin', 'bash.exe');
    fs.mkdirSync(path.dirname(bash), { recursive: true });
    fs.writeFileSync(bash, '', 'utf-8');
    // `C://a//b//bash.exe`：Windows 视作合法路径，但落盘成这种值 spawn 行为不稳
    const sloppy = bash.replace(/[\\/]/g, '//');
    await ensurePiShellPath(agentDir, agentDir, () => sloppy);
    const written = readSettings(agentDir);
    assert.equal(written.shellPath, bash, '写入前必须 path.normalize，不能把多重分隔符留在配置里');
  } finally {
    cleanup();
  }
});

test('ensurePiShellPath：写入的候选其实用不了（复探不过）→ 回原异常，不谎报修复成功', async () => {
  const { agentDir, cleanup } = makeTmpAgentDir();
  try {
    // 解析器回的路径不存在：persistShellPath 照写，但复探必须失败 → 返回原异常
    const ghost = path.join(agentDir, 'ghost', 'bash.exe');
    const r = await ensurePiShellPath(agentDir, agentDir, () => ghost);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.reason, 'no-shell');
  } finally {
    cleanup();
  }
});
