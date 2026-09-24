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

import { isWslStubBash, probePiShell } from '../../src/pi/shellProbe.ts';

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
