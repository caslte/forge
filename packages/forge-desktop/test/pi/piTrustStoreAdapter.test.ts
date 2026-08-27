/**
 * PiTrustStoreAdapter（P2-A）单元测试。
 *
 * 验证真实 pi 信任端口适配：
 * - hasTrustRequiringResources：存在 .pi 项目资源时 true，空目录 false
 * - getDecision / setDecision：读写 agentDir 下 trust.json（持久化，重建适配器仍可读）
 * - 未决目录 getDecision 返回 null（触发 forge 询问）
 *
 * 使用 node:test + 临时 agentDir（不触碰真实用户 .pi/agent/trust.json）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiTrustStoreAdapter } from '../../src/pi/piTrustStoreAdapter.ts';

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trust-adapter-'));
}

test('P2-A adapter：空目录无项目资源，getDecision 未决为 null', () => {
  const tmp = makeTempDir();
  try {
    const agentDir = path.join(tmp, 'pi-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const projectDir = path.join(tmp, 'proj-empty');
    fs.mkdirSync(projectDir, { recursive: true });
    const adapter = new PiTrustStoreAdapter(agentDir);
    assert.equal(adapter.hasTrustRequiringResources(projectDir), false);
    assert.equal(adapter.getDecision(projectDir), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A adapter：含 .pi agent 技能资源目录需要信任，setDecision 后持久化可读', () => {
  const tmp = makeTempDir();
  try {
    const agentDir = path.join(tmp, 'pi-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const projectDir = path.join(tmp, 'proj-pi');
    fs.mkdirSync(projectDir, { recursive: true });
    // pi 判定：.pi/skills 属于需要信任门禁的项目资源（configDir 下的 skills）
    fs.mkdirSync(path.join(projectDir, '.pi', 'skills'), { recursive: true });
    const adapter = new PiTrustStoreAdapter(agentDir);
    assert.equal(adapter.hasTrustRequiringResources(projectDir), true);
    assert.equal(adapter.getDecision(projectDir), null);
    // 信任决策写入
    adapter.setDecision(projectDir, true);
    assert.equal(adapter.getDecision(projectDir), true);
    // 重建适配器（模拟重启）仍可读 —— 权威持久化在 trust.json
    const reloaded = new PiTrustStoreAdapter(agentDir);
    assert.equal(reloaded.getDecision(projectDir), true);
    // 拒绝决策
    reloaded.setDecision(projectDir, false);
    assert.equal(new PiTrustStoreAdapter(agentDir).getDecision(projectDir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A adapter：子目录读取最近祖先信任决策（路径继承）', () => {
  const tmp = makeTempDir();
  try {
    const agentDir = path.join(tmp, 'pi-agent');
    fs.mkdirSync(agentDir, { recursive: true });
    const parent = path.join(tmp, 'parent');
    fs.mkdirSync(parent, { recursive: true });
    const child = path.join(parent, 'child');
    fs.mkdirSync(child, { recursive: true });
    const adapter = new PiTrustStoreAdapter(agentDir);
    adapter.setDecision(parent, true);
    // pi 的 get 支持最近祖先匹配（本项目信任继承父目录）
    assert.equal(adapter.getDecision(child), true);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});