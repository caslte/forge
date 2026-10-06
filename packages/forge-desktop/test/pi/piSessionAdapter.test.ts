/**
 * PiSessionAdapter 单测（真实文件系统）。
 *
 * 锁的核心行为：deleteSession 是**硬删** —— pi 转录 JSONL 与子 agent 输出目录必须
 * 从磁盘消失，且绝不能误删同目录下其它 forge 会话与 pi CLI 原生会话文件
 * （此前空实现导致本机积累 159 个孤儿 jsonl / 54.8MB，这组用例是该缺陷的回归锁）。
 *
 * 运行：node --experimental-strip-types --test（Node 22+，无需预编译）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { PiSessionAdapter } from '../../src/pi/piSessionAdapter.ts';
import { resolveForgeSessionFile, resolveFreeWorkspaceDir, resolveProjectSessionDir } from '../../src/pi/piSessionPaths.ts';
import { encodeCwd, resolveSubagentOutputDir } from '../../src/pi/subagentOutput.ts';

/** 创建独立临时目录（隔离 agentDir，避免触碰真实 ~/.pi/agent） */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-pisession-'));
}

/** 子 agent 输出根（与 subagentOutput 的 uid 回退规则一致） */
function subagentRoot(): string {
  const uid = typeof process.getuid === 'function' ? process.getuid() : 0;
  return path.join(os.tmpdir(), `pi-subagents-${uid}`);
}

const SID = '11111111-2222-3333-4444-555555555555';
const SID_OTHER = 'aaaaaaaa-bbbb-cccc-dddd-eeeeffff0000';
const PROJECT = 'C:\\works\\demo\\proj-a';

test('PiSessionAdapter 生成稳定合法且非 mock 的 forge session ID', async () => {
  const adapter = new PiSessionAdapter();
  const first = await adapter.createSession('C:\\tmp\\project');
  const second = await adapter.createSession('C:\\tmp\\project');

  assert.notEqual(first, second);
  assert.doesNotMatch(first, /^mock-session-/);
  assert.match(first, /^[A-Za-z0-9_-]+$/);
});

test('PiSessionAdapter 停止幂等成功', async () => {
  const adapter = new PiSessionAdapter();
  const sessionId = await adapter.createSession('C:\\tmp\\project');

  await assert.doesNotReject(adapter.stopSession(sessionId));
});

test('deleteSession 真删转录 JSONL 与子 agent 输出目录，且不误伤同目录其它文件', async () => {
  const agentDir = makeTempDir();
  try {
    const adapter = new PiSessionAdapter({ agentDir });

    // pi 转录（待删目标）
    const sessionFile = resolveForgeSessionFile(SID, PROJECT, agentDir);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8');

    // 同目录兄弟：另一个 forge 会话 + pi CLI 原生会话（均必须保留）
    const siblingForge = resolveForgeSessionFile(SID_OTHER, PROJECT, agentDir);
    fs.writeFileSync(siblingForge, '{"type":"session"}\n', 'utf8');
    const cliSession = path.join(
      resolveProjectSessionDir(PROJECT, agentDir),
      '2026-09-14T00-00-00-000Z_cli-native.jsonl',
    );
    fs.writeFileSync(cliSession, '{"type":"session"}\n', 'utf8');

    // 子 agent 执行过程输出（待删目标）
    const subagentDir = resolveSubagentOutputDir(PROJECT, SID);
    fs.mkdirSync(path.join(subagentDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(subagentDir, 'tasks', 'agent-1.output'), 'log', 'utf8');
    fs.writeFileSync(path.join(subagentDir, 'tasks', 'agent-2.output'), 'log', 'utf8');

    await adapter.deleteSession(SID, PROJECT);

    assert.equal(fs.existsSync(sessionFile), false, '转录 JSONL 应被删除');
    assert.equal(fs.existsSync(subagentDir), false, '子 agent 输出目录应被删除');
    assert.equal(fs.existsSync(siblingForge), true, '兄弟 forge 会话不得误删');
    assert.equal(fs.existsSync(cliSession), true, 'pi CLI 原生会话不得误删');
    // 项目下还有其它会话文件 → sessions/<encoded> 目录应保留
    assert.equal(fs.existsSync(path.dirname(sessionFile)), true);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(path.join(subagentRoot(), encodeCwd(PROJECT)), { recursive: true, force: true });
  }
});

test('deleteSession 会话独占项目时顺带清掉空的项目目录', async () => {
  const agentDir = makeTempDir();
  const project = 'C:\\works\\demo\\proj-solo';
  try {
    const adapter = new PiSessionAdapter({ agentDir });
    const sessionFile = resolveForgeSessionFile(SID, project, agentDir);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8');

    await adapter.deleteSession(SID, project);

    assert.equal(fs.existsSync(sessionFile), false);
    assert.equal(fs.existsSync(path.dirname(sessionFile)), false, '空项目目录应被清理');
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(path.join(subagentRoot(), encodeCwd(project)), { recursive: true, force: true });
  }
});

test('deleteSession 幂等：目标不存在时静默成功', async () => {
  const agentDir = makeTempDir();
  try {
    const adapter = new PiSessionAdapter({ agentDir });
    // 从未创建过任何文件
    await assert.doesNotReject(adapter.deleteSession(SID, PROJECT));
    await assert.doesNotReject(adapter.deleteSession(SID, PROJECT));
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test('deleteSession 自由会话（projectPath=null）按 free-workspace 目录真删，不误伤项目会话（v0.3）', async () => {
  const agentDir = makeTempDir();
  try {
    const adapter = new PiSessionAdapter({ agentDir });
    const freeCwd = resolveFreeWorkspaceDir(agentDir);

    // 自由会话转录（待删目标）：路径与引擎写入侧（resolveSessionCwd 映射）逐字节一致
    const freeFile = resolveForgeSessionFile(SID, freeCwd, agentDir);
    fs.mkdirSync(path.dirname(freeFile), { recursive: true });
    fs.writeFileSync(freeFile, '{"type":"session"}\n', 'utf8');

    // 同目录兄弟（自由会话）+ 项目会话转录（均必须保留）
    const siblingFree = resolveForgeSessionFile(SID_OTHER, freeCwd, agentDir);
    fs.writeFileSync(siblingFree, '{"type":"session"}\n', 'utf8');
    const projectFile = resolveForgeSessionFile(SID_OTHER, PROJECT, agentDir);
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, '{"type":"session"}\n', 'utf8');

    // 自由会话的子 agent 输出（encodeCwd(freeCwd) 目录，待删目标）
    const subagentDir = resolveSubagentOutputDir(freeCwd, SID);
    fs.mkdirSync(path.join(subagentDir, 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(subagentDir, 'tasks', 'agent-1.output'), 'log', 'utf8');

    await adapter.deleteSession(SID, null);

    assert.equal(fs.existsSync(freeFile), false, '自由会话转录应被删除');
    assert.equal(fs.existsSync(subagentDir), false, '自由会话子 agent 输出目录应被删除');
    assert.equal(fs.existsSync(siblingFree), true, '兄弟自由会话不得误删');
    assert.equal(fs.existsSync(projectFile), true, '项目会话转录不得误删');
    // 自由目录下还有其它会话 → free-workspace 的 sessions 目录应保留
    assert.equal(fs.existsSync(path.dirname(freeFile)), true);
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
    fs.rmSync(path.join(subagentRoot(), encodeCwd(resolveFreeWorkspaceDir(agentDir))), { recursive: true, force: true });
  }
});

test('deleteSession 非法 sessionId 跳过磁盘清理且不抛错（历史脏数据可删除）', async () => {
  const agentDir = makeTempDir();
  try {
    const adapter = new PiSessionAdapter({ agentDir });
    // 合法会话文件先就位，确保"跳过"没有越界删除任何东西
    const sessionFile = resolveForgeSessionFile(SID_OTHER, PROJECT, agentDir);
    fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
    fs.writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8');

    await assert.doesNotReject(adapter.deleteSession('../../evil', PROJECT));
    await assert.doesNotReject(adapter.deleteSession('a.b/c', PROJECT));
    assert.equal(fs.existsSync(sessionFile), true, '跳过清理不得影响其它文件');
  } finally {
    fs.rmSync(agentDir, { recursive: true, force: true });
  }
});

test(
  'deleteSession 删不掉时抛错且不吞异常（失败上抛 → 服务层保留会话记录的前提）',
  async () => {
    const agentDir = makeTempDir();
    try {
      const adapter = new PiSessionAdapter({
        agentDir,
        // OS 级模拟（只读属性/句柄占用）在本机不可靠：fs.promises.rm 无视只读删除，
        // 故注入失败端口锁传播语义 —— remove 抛错必须原样上抛、不得吞掉
        remove: async () => {
          throw new Error('EPERM: operation not permitted');
        },
      });
      const sessionFile = resolveForgeSessionFile(SID, PROJECT, agentDir);
      fs.mkdirSync(path.dirname(sessionFile), { recursive: true });
      fs.writeFileSync(sessionFile, '{"type":"session"}\n', 'utf8');

      await assert.rejects(adapter.deleteSession(SID, PROJECT), /删除会话文件失败/);
      // 注入的端口没删任何东西 → 文件原样保留（服务层据此保留 store 记录）
      assert.equal(fs.existsSync(sessionFile), true);
    } finally {
      fs.rmSync(agentDir, { recursive: true, force: true });
      fs.rmSync(path.join(subagentRoot(), encodeCwd(PROJECT)), { recursive: true, force: true });
    }
  },
);
