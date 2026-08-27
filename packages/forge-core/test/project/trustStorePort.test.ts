/**
 * P2-A 项目信任机制：接入权威信任端口（pi ProjectTrustStore）的单元测试。
 *
 * forge-core 不 import pi —— 信任权威经构造注入 TrustStorePort；
 * 真实 pi 实现由 forge-desktop 提供（createForgeCore 注入）。这里用 fake
 * 验证契约：
 * - 注入端口后 openProject 以端口权威决策为准（pi trusted/rejected 覆盖 forge 缓存）
 * - setTrust trust/reject 写回权威端口；trustOnce 不持久
 * - 无项目资源时 forge 缓存回到 untrusted 展示状态
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeStore } from '../../src/store/index.ts';
import { ProjectService, type TrustStorePort } from '../../src/project/projectService.ts';

/** 可编程 fake 信任端口（记录写入，决策可注入） */
class FakeTrustStore implements TrustStorePort {
  readonly decisions = new Map<string, boolean>();
  resources = new Set<string>();
  hasTrustRequiringResources(cwd: string): boolean {
    return this.resources.has(cwd);
  }
  getDecision(cwd: string): boolean | null {
    const d = this.decisions.get(cwd);
    return d === undefined ? null : d;
  }
  setDecision(cwd: string, decision: boolean): void {
    this.decisions.set(cwd, decision);
  }
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-trust-test-'));
}

function makeProjectDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function makeService(tmp: string, trust: FakeTrustStore): { service: ProjectService; store: ForgeStore; trust: FakeTrustStore } {
  const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
  return { service: new ProjectService(store, trust), store, trust };
}

test('P2-A：注入权威端口且 pi 已信任时，首次打开直接成功（权威优先于缓存）', () => {
  const tmp = makeTempDir();
  try {
    const trust = new FakeTrustStore();
    const { service, store } = makeService(tmp, trust);
    const dir = makeProjectDir(tmp, 'proj-trusted');
    trust.resources.add(dir);
    trust.decisions.set(dir, true); // pi 权威：已信任
    assert.ok(service.addProject(dir).ok);
    // 打开：不询问，缓存同步为 trusted
    const opened = service.openProject(dir);
    assert.ok(opened.ok);
    assert.equal(store.getProject(dir)?.trustState, 'trusted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A：注入权威端口且 pi 已拒绝时，首次打开直接成功且状态 rejected（不重复询问）', () => {
  const tmp = makeTempDir();
  try {
    const trust = new FakeTrustStore();
    const { service, store } = makeService(tmp, trust);
    const dir = makeProjectDir(tmp, 'proj-rejected');
    trust.resources.add(dir);
    trust.decisions.set(dir, false); // pi 权威：已拒绝
    assert.ok(service.addProject(dir).ok);
    const opened = service.openProject(dir);
    assert.ok(opened.ok);
    assert.equal(store.getProject(dir)?.trustState, 'rejected');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A：注入端口且 pi 未决时，含资源首次打开询问并进入 asking', () => {
  const tmp = makeTempDir();
  try {
    const trust = new FakeTrustStore();
    const { service, store } = makeService(tmp, trust);
    const dir = makeProjectDir(tmp, 'proj-ask');
    trust.resources.add(dir); // 有项目资源但决策未定（null）
    assert.ok(service.addProject(dir).ok);
    const opened = service.openProject(dir);
    assert.ok(!opened.ok);
    if (!opened.ok) {
      assert.equal(opened.code, 1005);
    }
    assert.equal(store.getProject(dir)?.trustState, 'asking');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A：setTrust trust 写回权威端口（持久），openProject 保持 trusted（AC-PM-S04）', () => {
  const tmp = makeTempDir();
  try {
    const trust = new FakeTrustStore();
    const { service, store } = makeService(tmp, trust);
    const dir = makeProjectDir(tmp, 'proj-trust-write');
    trust.resources.add(dir);
    assert.ok(service.addProject(dir).ok);
    assert.ok(!service.openProject(dir).ok); // 1005
    assert.ok(service.setTrust(dir, 'trust').ok);
    assert.equal(trust.getDecision(dir), true); // 权威已写
    assert.equal(store.getProject(dir)?.trustState, 'trusted');
    assert.ok(service.openProject(dir).ok); // 不再询问
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A：setTrust reject 写回权威端口为 false', () => {
  const tmp = makeTempDir();
  try {
    const trust = new FakeTrustStore();
    const { service, store } = makeService(tmp, trust);
    const dir = makeProjectDir(tmp, 'proj-reject-write');
    trust.resources.add(dir);
    assert.ok(service.addProject(dir).ok);
    assert.ok(!service.openProject(dir).ok);
    assert.ok(service.setTrust(dir, 'reject').ok);
    assert.equal(trust.getDecision(dir), false);
    assert.equal(store.getProject(dir)?.trustState, 'rejected');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A：trustOnce 不写权威端口，下次重新询问', () => {
  const tmp = makeTempDir();
  try {
    const trust = new FakeTrustStore();
    const { service, store } = makeService(tmp, trust);
    const dir = makeProjectDir(tmp, 'proj-once-write');
    trust.resources.add(dir);
    assert.ok(service.addProject(dir).ok);
    assert.ok(!service.openProject(dir).ok);
    assert.ok(service.setTrust(dir, 'trustOnce').ok);
    assert.equal(trust.getDecision(dir), null); // 未持久
    assert.equal(store.getProject(dir)?.trustState, 'untrusted');
    assert.ok(!service.openProject(dir).ok); // 重新询问
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('P2-A：无项目资源时权威决策不干扰（缓存 untrusted，不询问）', () => {
  const tmp = makeTempDir();
  try {
    const trust = new FakeTrustStore();
    const { service, store } = makeService(tmp, trust);
    const dir = makeProjectDir(tmp, 'proj-plain');
    // pi 权威里虽已信任，但目录没有项目资源 → 直接打开，缓存展示为 untrusted
    trust.decisions.set(dir, true);
    assert.ok(service.addProject(dir).ok);
    const opened = service.openProject(dir);
    assert.ok(opened.ok);
    assert.equal(store.getProject(dir)?.trustState, 'untrusted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});