/**
 * forge-store 持久化层单元测试。
 *
 * 覆盖 docs/test/01_project/coverage-matrix.md 中本 WU 的用例：
 * - U-PM-001：重复路径（含符号链接变体）→ 1001，store 仅一条记录
 * - U-PM-002：无效路径 → 校验错误（1002），store 无写入
 * 以及本 WU 契约要求的：首次播种、settings 往返、原子写、schemaVersion 语义、
 * 项目 CRUD、会话元数据保留、会话 CRUD。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离运行；真实文件系统测试使用
 * fs.mkdtempSync(os.tmpdir()) 临时目录并在 finally 中清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeStore, ForgeStoreError, normalizeProjectPath } from '../../src/store/forgeStore.ts';
import type { ProjectRecord, SessionRecord } from '../../src/types/forge-store.ts';

/** 创建独立临时目录（测试根目录） */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-store-test-'));
}

/** 在临时目录下创建项目目录并返回其路径 */
function makeProjectDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 构造项目记录（path 可为原始路径，addProject 内部会规范化） */
function makeProjectRecord(dir: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    path: dir,
    alias: path.basename(dir),
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: null,
    trustState: 'untrusted',
    ...overrides,
  };
}

/** 构造会话记录（sessionId 为唯一键） */
function makeSessionRecord(
  sessionId: string,
  projectPath: string,
  overrides: Partial<SessionRecord> = {},
): SessionRecord {
  return {
    sessionId,
    projectPath,
    alias: null,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelOverride: null,
    ...overrides,
  };
}

test('首次运行：播种默认值并创建文件（defaultModel=null, thinkingLevel=off, schemaVersion=1）', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    assert.equal(store.getSetting('defaultModel'), null);
    // 全局默认思考级别默认关闭：thinking 内容默认不产生/不展示
    assert.equal(store.getSetting('thinkingLevel'), 'off');
    assert.equal(store.getSetting('schemaVersion'), 1);
    assert.deepEqual(store.listProjects(), []);
    assert.ok(fs.existsSync(storePath), '首次运行应创建存储文件');
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.schemaVersion, 1);
    assert.deepEqual(onDisk.projects, []);
    assert.deepEqual(onDisk.sessions, []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('AC-MP-012：首次播种 settings 含 thinkingLevel=off（全局默认思考级别默认关闭）', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    // 落盘后的 settings seed 必须含 thinkingLevel=off（与 defaultModel / schemaVersion 并列）
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const keys = onDisk.settings.map((s: { key: string }) => s.key);
    assert.ok(keys.includes('thinkingLevel'), 'settings 应含 thinkingLevel 键');
    const rec = onDisk.settings.find((s: { key: string }) => s.key === 'thinkingLevel');
    assert.equal(rec?.value, 'off');
    assert.equal(store.getSetting('thinkingLevel'), 'off');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：持久化并返回规范化路径', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-a');
    const store = new ForgeStore(storePath);
    const result = store.addProject(makeProjectRecord(projDir));
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.project.path, normalizeProjectPath(projDir));
      assert.equal(result.project.alias, 'proj-a');
    }
    assert.equal(store.listProjects().length, 1);
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.projects.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：重复路径返回 1001，store 仅一条记录（U-PM-001）', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-b');
    const store = new ForgeStore(storePath);
    const first = store.addProject(makeProjectRecord(projDir));
    assert.ok(first.ok);
    const second = store.addProject(makeProjectRecord(projDir));
    assert.ok(!second.ok);
    if (!second.ok) {
      assert.equal(second.code, 1001);
    }
    assert.equal(store.listProjects().length, 1);
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.projects.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：符号链接变体路径规范化后判重（1001，U-PM-001）', (t) => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-c');
    const linkPath = path.join(tmp, 'proj-c-link');
    try {
      // Windows 用 junction（无需管理员权限），其余平台用目录符号链接
      fs.symlinkSync(projDir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('当前环境不允许创建符号链接/联接');
      return;
    }
    const store = new ForgeStore(storePath);
    const first = store.addProject(makeProjectRecord(projDir));
    assert.ok(first.ok);
    const viaLink = store.addProject(makeProjectRecord(linkPath));
    assert.ok(!viaLink.ok);
    if (!viaLink.ok) {
      assert.equal(viaLink.code, 1001);
    }
    assert.equal(store.listProjects().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：不存在的路径返回 1002，store 无写入（U-PM-002）', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    const missing = path.join(tmp, 'does-not-exist');
    const result = store.addProject(makeProjectRecord(missing));
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
    assert.equal(store.listProjects().length, 0);
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.projects.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：文件路径（非目录）返回 1002，store 无写入', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const filePath = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(filePath, 'not a dir');
    const store = new ForgeStore(storePath);
    const result = store.addProject(makeProjectRecord(filePath));
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
    assert.equal(store.listProjects().length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeProject：删除记录并落盘，重复移除幂等', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-d');
    const store = new ForgeStore(storePath);
    store.addProject(makeProjectRecord(projDir));
    assert.equal(store.listProjects().length, 1);
    const removed = store.removeProject(normalizeProjectPath(projDir));
    assert.deepEqual(removed, { ok: true, removed: true });
    assert.equal(store.listProjects().length, 0);
    const again = store.removeProject(normalizeProjectPath(projDir));
    assert.deepEqual(again, { ok: true, removed: false });
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.projects.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('移除项目：会话元数据保留（schema.md 存储级约束）', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-g');
    const store = new ForgeStore(storePath);
    const added = store.addProject(makeProjectRecord(projDir));
    assert.ok(added.ok);
    if (!added.ok) {
      return;
    }
    // 模拟模块 02 写入会话元数据（直接向文件追加 session 记录）
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    onDisk.sessions.push({
      sessionId: 'sess-001',
      projectPath: added.project.path,
      alias: null,
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelOverride: null,
    });
    fs.writeFileSync(storePath, JSON.stringify(onDisk));
    // 重新加载后移除项目：project 删除，session 保留
    const reloaded = new ForgeStore(storePath);
    reloaded.removeProject(added.project.path);
    const after = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(after.projects.length, 0);
    assert.equal(after.sessions.length, 1);
    assert.equal(after.sessions[0].sessionId, 'sess-001');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getProject：按 path 精确返回，未找到返回 null', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-f');
    const store = new ForgeStore(storePath);
    store.addProject(makeProjectRecord(projDir));
    const found = store.getProject(normalizeProjectPath(projDir));
    assert.ok(found);
    assert.equal(found?.alias, 'proj-f');
    assert.equal(store.getProject('C:/nonexistent'), null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateProject：更新并持久化，不存在返回 1003', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-h');
    const store = new ForgeStore(storePath);
    const added = store.addProject(makeProjectRecord(projDir));
    assert.ok(added.ok);
    if (added.ok) {
      const updated = store.updateProject({
        ...added.project,
        alias: 'renamed',
        lastOpenedAt: '2026-02-01T00:00:00.000Z',
      });
      assert.ok(updated.ok);
      if (updated.ok) {
        assert.equal(updated.project.alias, 'renamed');
      }
      assert.equal(store.getProject(added.project.path)?.alias, 'renamed');
    }
    const missing = store.updateProject(makeProjectRecord(path.join(tmp, 'nope')));
    assert.ok(!missing.ok);
    if (!missing.ok) {
      assert.equal(missing.code, 1003);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listProjects：按 lastOpenedAt 降序，null 排最后', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    store.addProject(makeProjectRecord(makeProjectDir(tmp, 'a'), { alias: 'a' }));
    store.addProject(
      makeProjectRecord(makeProjectDir(tmp, 'b'), { alias: 'b', lastOpenedAt: '2026-03-01T00:00:00.000Z' }),
    );
    store.addProject(
      makeProjectRecord(makeProjectDir(tmp, 'c'), { alias: 'c', lastOpenedAt: '2026-02-01T00:00:00.000Z' }),
    );
    const list = store.listProjects();
    assert.deepEqual(
      list.map((p) => p.alias),
      ['b', 'c', 'a'],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('settings：set/get 往返并持久化（重新加载后仍在）', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    assert.equal(store.getSetting('defaultModel'), null);
    store.setSetting('defaultModel', 'gpt-4o');
    assert.equal(store.getSetting('defaultModel'), 'gpt-4o');
    const reloaded = new ForgeStore(storePath);
    assert.equal(reloaded.getSetting('defaultModel'), 'gpt-4o');
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    const rec = onDisk.settings.find((s: { key: string }) => s.key === 'defaultModel');
    assert.equal(rec?.value, 'gpt-4o');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('原子写：成功后无 .tmp 残留，文件为合法 JSON', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const projDir = makeProjectDir(tmp, 'proj-e');
    const store = new ForgeStore(storePath);
    store.addProject(makeProjectRecord(projDir));
    store.setSetting('defaultModel', 'claude');
    assert.ok(!fs.existsSync(`${storePath}.tmp`), '成功后不应残留 .tmp 文件');
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.projects.length, 1);
    const rec = onDisk.settings.find((s: { key: string }) => s.key === 'defaultModel');
    assert.equal(rec?.value, 'claude');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('schemaVersion：未知新版本（>1）抛 SCHEMA_VERSION_TOO_NEW', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    fs.writeFileSync(
      storePath,
      JSON.stringify({ schemaVersion: 2, projects: [], sessions: [], settings: [] }),
    );
    assert.throws(
      () => new ForgeStore(storePath),
      (err: unknown) => err instanceof ForgeStoreError && err.code === 'SCHEMA_VERSION_TOO_NEW',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('schemaVersion：非法版本（<1）抛 SCHEMA_VERSION_INVALID', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    fs.writeFileSync(
      storePath,
      JSON.stringify({ schemaVersion: 0, projects: [], sessions: [], settings: [] }),
    );
    assert.throws(
      () => new ForgeStore(storePath),
      (err: unknown) => err instanceof ForgeStoreError && err.code === 'SCHEMA_VERSION_INVALID',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('schemaVersion：文件缺少版本字段时重新播种', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    fs.writeFileSync(storePath, JSON.stringify({ projects: [{ path: 'legacy' }] }));
    const store = new ForgeStore(storePath);
    assert.equal(store.getSetting('schemaVersion'), 1);
    assert.equal(store.getSetting('defaultModel'), null);
    assert.deepEqual(store.listProjects(), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('损坏 JSON：抛 STORE_CORRUPT', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    fs.writeFileSync(storePath, '{ not valid json');
    assert.throws(
      () => new ForgeStore(storePath),
      (err: unknown) => err instanceof ForgeStoreError && err.code === 'STORE_CORRUPT',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('normalizeProjectPath：返回规范化绝对路径，无效路径抛 PATH_INVALID', () => {
  const tmp = makeTempDir();
  try {
    const projDir = makeProjectDir(tmp, 'proj-n');
    assert.equal(normalizeProjectPath(projDir), fs.realpathSync(projDir));
    assert.throws(
      () => normalizeProjectPath(path.join(tmp, 'missing')),
      (err: unknown) => err instanceof ForgeStoreError && err.code === 'PATH_INVALID',
    );
    const filePath = path.join(tmp, 'file.txt');
    fs.writeFileSync(filePath, 'x');
    assert.throws(
      () => normalizeProjectPath(filePath),
      (err: unknown) => err instanceof ForgeStoreError && err.code === 'PATH_INVALID',
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveSession + listSessions：持久化并返回记录副本', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    store.saveSession(makeSessionRecord('sess-1', 'C:/proj'));
    assert.equal(store.listSessions().length, 1);
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.sessions.length, 1);
    assert.equal(onDisk.sessions[0].sessionId, 'sess-1');
    const reloaded = new ForgeStore(storePath);
    assert.equal(reloaded.getSession('sess-1')?.sessionId, 'sess-1');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listSessions：按 projectPath 过滤，省略返回全部', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    store.saveSession(makeSessionRecord('sess-a', 'C:/proj-a'));
    store.saveSession(makeSessionRecord('sess-b', 'C:/proj-a'));
    store.saveSession(makeSessionRecord('sess-c', 'C:/proj-b'));
    assert.equal(store.listSessions().length, 3);
    assert.deepEqual(
      store.listSessions('C:/proj-a').map((s) => s.sessionId),
      ['sess-a', 'sess-b'],
    );
    assert.deepEqual(store.listSessions('C:/proj-b').map((s) => s.sessionId), ['sess-c']);
    assert.deepEqual(store.listSessions('C:/nonexistent'), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getSession：按 sessionId 精确返回，未找到返回 undefined', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    store.saveSession(makeSessionRecord('sess-1', 'C:/proj', { alias: 'hello' }));
    const found = store.getSession('sess-1');
    assert.ok(found);
    assert.equal(found?.alias, 'hello');
    assert.equal(store.getSession('missing'), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('saveSession：按 sessionId upsert，覆盖已有记录', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    store.saveSession(makeSessionRecord('sess-1', 'C:/proj', { alias: 'first' }));
    store.saveSession(
      makeSessionRecord('sess-1', 'C:/proj', { alias: 'second', lastActiveAt: '2026-02-01T00:00:00.000Z' }),
    );
    assert.equal(store.listSessions().length, 1);
    assert.equal(store.getSession('sess-1')?.alias, 'second');
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.sessions.length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeSession：删除记录并落盘，不存在返回 false', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    store.saveSession(makeSessionRecord('sess-1', 'C:/proj'));
    assert.equal(store.removeSession('sess-1'), true);
    assert.equal(store.listSessions().length, 0);
    assert.equal(store.removeSession('sess-1'), false);
    const onDisk = JSON.parse(fs.readFileSync(storePath, 'utf8'));
    assert.equal(onDisk.sessions.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listSessions：按 lastActiveAt 降序（最近活动在前）', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    store.saveSession(makeSessionRecord('sess-old', 'C:/proj', { lastActiveAt: '2026-01-01T00:00:00.000Z' }));
    store.saveSession(makeSessionRecord('sess-new', 'C:/proj', { lastActiveAt: '2026-03-01T00:00:00.000Z' }));
    store.saveSession(makeSessionRecord('sess-mid', 'C:/proj', { lastActiveAt: '2026-02-01T00:00:00.000Z' }));
    assert.deepEqual(
      store.listSessions().map((s) => s.sessionId),
      ['sess-new', 'sess-mid', 'sess-old'],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
// ===== 项目拖拽排序（priority 钉扎） =====

test('reorderProjects：全量重排写 priority，列表按 priority 升序且持久化', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    const a = store.addProject(makeProjectRecord(makeProjectDir(tmp, 'a')));
    const b = store.addProject(makeProjectRecord(makeProjectDir(tmp, 'b')));
    const c = store.addProject(makeProjectRecord(makeProjectDir(tmp, 'c')));
    assert.ok(a.ok && b.ok && c.ok);
    if (!a.ok || !b.ok || !c.ok) return;
    // 初始未钉扎：全部 lastOpenedAt=null，顺序稳定（注册序）
    // 拖拽重排为 c, a, b
    const res = store.reorderProjects([c.project.path, a.project.path, b.project.path]);
    assert.ok(res.ok);
    if (!res.ok) return;
    assert.deepEqual(
      res.projects.map((p) => p.path),
      [c.project.path, a.project.path, b.project.path],
    );
    assert.deepEqual(
      store.listProjects().map((p) => p.path),
      [c.project.path, a.project.path, b.project.path],
    );
    // 持久化：新实例读回顺序不变
    const reloaded = new ForgeStore(storePath);
    assert.deepEqual(
      reloaded.listProjects().map((p) => p.path),
      [c.project.path, a.project.path, b.project.path],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reorderProjects：含未注册 path 返回 1003 且不写盘', () => {
  const tmp = makeTempDir();
  try {
    const storePath = path.join(tmp, 'forge-store.json');
    const store = new ForgeStore(storePath);
    const a = store.addProject(makeProjectRecord(makeProjectDir(tmp, 'a')));
    assert.ok(a.ok);
    if (!a.ok) return;
    const missing = path.join(tmp, 'no-such');
    const res = store.reorderProjects([missing, a.project.path]);
    assert.ok(!res.ok);
    if (!res.ok) assert.equal(res.code, 1003);
    // 无副作用：顺序与 priority 均未变
    const reloaded = new ForgeStore(storePath);
    assert.deepEqual(reloaded.listProjects().map((p) => p.path), [a.project.path]);
    assert.equal(reloaded.getProject(a.project.path)?.priority ?? null, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('listProjects：priority 钉扎升序优先，未钉扎按最近打开倒序排后', () => {
  const tmp = makeTempDir();
  try {
    const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
    const ra = store.addProject(makeProjectRecord(makeProjectDir(tmp, 'a')));
    const rb = store.addProject(makeProjectRecord(makeProjectDir(tmp, 'b')));
    const rc = store.addProject(makeProjectRecord(makeProjectDir(tmp, 'c')));
    assert.ok(ra.ok && rb.ok && rc.ok);
    if (!ra.ok || !rb.ok || !rc.ok) return;
    // a 钉扎 priority=1（最近打开更晚但不影响钉扎顺序）；b 钉扎 priority=0；
    // c 未钉扎但最近打开：应排所有钉扎之后
    const upA = store.updateProject({ ...ra.project, priority: 1, lastOpenedAt: '2026-06-01T00:00:00.000Z' });
    const upB = store.updateProject({ ...rb.project, priority: 0, lastOpenedAt: '2026-03-01T00:00:00.000Z' });
    const upC = store.updateProject({ ...rc.project, lastOpenedAt: '2026-09-01T00:00:00.000Z' });
    assert.ok(upA.ok && upB.ok && upC.ok);
    assert.deepEqual(
      store.listProjects().map((p) => p.path),
      [rb.project.path, ra.project.path, rc.project.path],
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
