/**
 * 项目管理 RPC 方法层（projectMethods）单元测试。
 *
 * 覆盖 docs/test/01_project/coverage-matrix.md api 层用例：
 * - A-PM-001：重复注册 → 1001，store 记录数不变
 * - A-PM-002：无效路径 → 1001 + 提示，store 无写入
 * - A-PM-003：openProject → code 0，lastOpenedAt 更新
 * - A-PM-004：目录被删除后 openProject 不崩溃（无异常泄漏）
 * - A-PM-005：removeProject → code 0，store 记录删除，源文件与 pi 会话保留
 * - A-PM-006：含 .pi 项目 openProject → 1005 + prompt，setTrust(trust) 后状态更新
 * - A-PM-007：setTrust(reject) → trustState=rejected，基础能力可用
 * 以及本 WU 契约：参数校验 1001、removeProject 幂等（未注册→0）、事件
 * project.opened / project.removed 发射、project.trustRequested 预留不发射、
 * 异常隔离 5000。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；真实文件系统用 fs.mkdtempSync
 * 临时目录并在 finally 中清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ForgeStore } from '../../src/store/index.ts';
import { ProjectService } from '../../src/project/projectService.ts';
import { ProjectApi } from '../../src/rpc/projectMethods.ts';
import type { RpcResult } from '../../src/rpc/projectMethods.ts';

/** 创建独立临时目录（测试根目录） */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-rpc-test-'));
}

/** 在临时目录下创建项目目录并返回其路径 */
function makeProjectDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 在项目目录内创建 `.pi` 资源目录（信任询问触发条件） */
function makePiResource(dir: string): void {
  fs.mkdirSync(path.join(dir, '.pi'), { recursive: true });
}

/** 构造 api + 独立 store + 事件汇 */
function makeApi(tmp: string): { api: ProjectApi; store: ForgeStore; events: EventEmitter } {
  const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
  const events = new EventEmitter();
  const api = new ProjectApi(new ProjectService(store), events);
  return { api, store, events };
}

test('A-PM-001：重复注册返回 1001，store 记录数不变', () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-dup');
    assert.equal(api.methods['project/addProject']({ path: dir }).code, 0);
    const second = api.methods['project/addProject']({ path: dir });
    assert.equal(second.code, 1001);
    assert.equal(store.listProjects().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-002：无效路径返回 1001 + 提示，store 无写入', () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const missing = path.join(tmp, 'no-such-dir');
    const result = api.methods['project/addProject']({ path: missing });
    assert.equal(result.code, 1001);
    assert.ok(typeof result.message === 'string' && result.message.length > 0, '应带错误提示');
    assert.deepEqual(store.listProjects(), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('参数校验：path 缺失/非字符串/空白返回 1001', async () => {
  const tmp = makeTempDir();
  try {
    const { api } = makeApi(tmp);
    assert.equal(api.methods['project/addProject']({}).code, 1001);
    assert.equal(api.methods['project/addProject']({ path: 123 }).code, 1001);
    assert.equal(api.methods['project/addProject']({ path: '   ' }).code, 1001);
    assert.equal(api.methods['project/addProject'](null).code, 1001);
    assert.equal(api.methods['project/openProject']({}).code, 1001);
    assert.equal((await api.methods['project/removeProject']({})).code, 1001);
    assert.equal(api.methods['project/updateProjectAlias']({ path: '/x' }).code, 1001);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-003：openProject 返回 0，lastOpenedAt 更新，project.opened 事件发射', () => {
  const tmp = makeTempDir();
  try {
    const { api, store, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-open');
    api.methods['project/addProject']({ path: dir });
    const opened: unknown[] = [];
    events.on('project.opened', (payload) => opened.push(payload));
    const result = api.methods['project/openProject']({ path: dir });
    assert.equal(result.code, 0);
    assert.ok(store.getProject(dir)?.lastOpenedAt !== null, '打开后应更新最近打开时间');
    assert.equal(opened.length, 1, 'project.opened 应发射一次');
    assert.deepEqual(opened[0], { path: dir });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-004：目录被删除后 openProject 不崩溃（code 0，无异常泄漏）', () => {
  const tmp = makeTempDir();
  try {
    const { api } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-gone');
    api.methods['project/addProject']({ path: dir });
    fs.rmSync(dir, { recursive: true, force: true }); // 目录失效
    let result: RpcResult | undefined;
    assert.doesNotThrow(() => {
      result = api.methods['project/openProject']({ path: dir });
    });
    assert.ok(result !== undefined);
    // 失效目录不崩溃：服务层降级为词法路径匹配，仍返回成功（失效提示属 UI 层 E2E 范畴）
    assert.equal(result.code, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-005：removeProject 返回 0，store 记录删除，源文件保留', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-rm');
    api.methods['project/addProject']({ path: dir });
    // 模拟 pi 侧数据：源文件与 pi 会话 JSONL（无注入会话端口时 pi 会话文件不动）
    const sourceFile = path.join(dir, 'main.ts');
    fs.writeFileSync(sourceFile, 'export {}');
    const piSession = path.join(tmp, 'pi-session.jsonl');
    fs.writeFileSync(piSession, '{"role":"user","content":"hi"}\n');
    const removed: unknown[] = [];
    events.on('project.removed', (payload) => removed.push(payload));
    const result = await api.methods['project/removeProject']({ path: dir });
    assert.equal(result.code, 0);
    assert.deepEqual(result.data, { removedSessions: 0 }, '无注入端口时无级联');
    assert.equal(store.getProject(dir), null, 'store 中 project 记录应删除');
    assert.ok(fs.existsSync(sourceFile), '源文件不应被删除');
    assert.ok(fs.existsSync(piSession), 'pi 会话不应被删除');
    assert.equal(removed.length, 1, 'project.removed 应发射一次');
    assert.deepEqual(removed[0], { path: dir });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-005：removeProject 级联删名下会话并逐个发射 session.removed', async () => {
  const tmp = makeTempDir();
  try {
    const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
    const events = new EventEmitter();
    const api = new ProjectApi(
      new ProjectService(store, undefined, {
        deleteSession: async (sessionId) => {
          store.removeSession(sessionId);
        },
      }),
      events,
    );
    const dir = makeProjectDir(tmp, 'proj-cascade');
    api.methods['project/addProject']({ path: dir });
    store.saveSession({
      sessionId: 'sess-1',
      projectPath: dir,
      alias: null,
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelOverride: null,
    });
    const removedSessions: unknown[] = [];
    events.on('session.removed', (payload) => removedSessions.push(payload));
    const result = await api.methods['project/removeProject']({ path: dir });
    assert.equal(result.code, 0);
    assert.deepEqual(result.data, { removedSessions: 1 });
    assert.deepEqual(removedSessions, [{ sessionId: 'sess-1' }], '级联删除应逐个发射 session.removed');
    assert.equal(store.getSession('sess-1'), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-005 幂等：重复移除未注册项目返回 0，不发射 project.removed', async () => {
  const tmp = makeTempDir();
  try {
    const { api, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-rm-idem');
    api.methods['project/addProject']({ path: dir });
    assert.equal((await api.methods['project/removeProject']({ path: dir })).code, 0);
    const removed: unknown[] = [];
    events.on('project.removed', (payload) => removed.push(payload));
    const second = await api.methods['project/removeProject']({ path: dir });
    assert.equal(second.code, 0, '幂等客户端行为：未注册项目视为移除成功');
    assert.equal(removed.length, 0, '未实际移除不发射事件');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-006：含 .pi 项目 openProject 返回 1005 + prompt，setTrust(trust) 后状态更新', () => {
  const tmp = makeTempDir();
  try {
    const { api, store, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-pi');
    makePiResource(dir);
    api.methods['project/addProject']({ path: dir });
    const opened: unknown[] = [];
    events.on('project.opened', (payload) => opened.push(payload));
    const result = api.methods['project/openProject']({ path: dir });
    assert.equal(result.code, 1005);
    assert.equal(opened.length, 0, '信任询问时不视为打开成功，不发 project.opened');
    assert.ok(result.data !== null);
    if (result.data !== null) {
      assert.equal(result.data.path, dir);
      assert.equal(result.data.prompt.reason, 'project-extensions');
    }
    assert.equal(store.getProject(dir)?.trustState, 'asking');
    const trusted = api.methods['project/setTrust']({ path: dir, decision: 'trust' });
    assert.equal(trusted.code, 0);
    assert.equal(store.getProject(dir)?.trustState, 'trusted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-PM-007：setTrust(reject) 后 trustState=rejected，基础能力可用', () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-reject');
    makePiResource(dir);
    api.methods['project/addProject']({ path: dir });
    assert.equal(api.methods['project/openProject']({ path: dir }).code, 1005);
    const rejected = api.methods['project/setTrust']({ path: dir, decision: 'reject' });
    assert.equal(rejected.code, 0);
    assert.equal(store.getProject(dir)?.trustState, 'rejected');
    // 拒绝后再次打开：不重复询问，基础会话能力可用
    const reopened = api.methods['project/openProject']({ path: dir });
    assert.equal(reopened.code, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('事件：project.trustRequested 预留不发射（v1 走同步 1005）', () => {
  const tmp = makeTempDir();
  try {
    const { api, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-trust-event');
    makePiResource(dir);
    api.methods['project/addProject']({ path: dir });
    const trustRequested: unknown[] = [];
    events.on('project.trustRequested', (payload) => trustRequested.push(payload));
    const result = api.methods['project/openProject']({ path: dir });
    assert.equal(result.code, 1005);
    assert.equal(trustRequested.length, 0, 'v1 信任询问经同步 1005，不发射 trustRequested');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('setTrust：非法 decision 返回 1001', () => {
  const tmp = makeTempDir();
  try {
    const { api } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-bad-dec');
    api.methods['project/addProject']({ path: dir });
    const result = api.methods['project/setTrust']({ path: dir, decision: 'maybe' });
    assert.equal(result.code, 1001);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateProjectAlias：成功更新别名；空别名返回 1001', () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-alias');
    api.methods['project/addProject']({ path: dir });
    const ok = api.methods['project/updateProjectAlias']({ path: dir, alias: '新别名' });
    assert.equal(ok.code, 0);
    assert.equal(store.getProject(dir)?.alias, '新别名');
    const bad = api.methods['project/updateProjectAlias']({ path: dir, alias: '   ' });
    assert.equal(bad.code, 1001);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('queryProjectList：返回全部项目，按最近打开倒序', () => {
  const tmp = makeTempDir();
  try {
    const { api } = makeApi(tmp);
    const a = makeProjectDir(tmp, 'proj-a');
    const b = makeProjectDir(tmp, 'proj-b');
    api.methods['project/addProject']({ path: a });
    api.methods['project/addProject']({ path: b });
    api.methods['project/openProject']({ path: b });
    const result = api.methods['project/queryProjectList']({});
    assert.equal(result.code, 0);
    assert.ok(result.data !== null);
    if (result.data !== null) {
      const names = result.data.projects.map((p) => path.basename(p.path));
      assert.deepEqual(names, ['proj-b', 'proj-a']);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('异常隔离：store 落盘失败返回 5000，不泄漏异常', () => {
  const tmp = makeTempDir();
  try {
    const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
    const api = new ProjectApi(new ProjectService(store));
    const dir = makeProjectDir(tmp, 'proj-5000');
    // 把存储文件替换为目录，使 save() 的 rename 步骤抛错
    fs.rmSync(path.join(tmp, 'forge-store.json'));
    fs.mkdirSync(path.join(tmp, 'forge-store.json'));
    let result: RpcResult | undefined;
    assert.doesNotThrow(() => {
      result = api.methods['project/addProject']({ path: dir });
    });
    assert.ok(result !== undefined);
    assert.equal(result.code, 5000);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ===== 项目拖拽排序（project/reorderProjects） =====

test('project/reorderProjects：paths 非字符串数组 -> 1001', () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    assert.equal(api.methods['project/reorderProjects']({}).code, 1001);
    assert.equal(api.methods['project/reorderProjects']({ paths: 'a,b' }).code, 1001);
    assert.equal(api.methods['project/reorderProjects']({ paths: [] }).code, 1001);
    assert.equal(api.methods['project/reorderProjects']({ paths: ['a', 1] }).code, 1001);
    assert.deepEqual(store.listProjects(), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('project/reorderProjects：合法重排返回 code 0，列表顺序变更并持久化', () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const a = makeProjectDir(tmp, 'a');
    const b = makeProjectDir(tmp, 'b');
    const c = makeProjectDir(tmp, 'c');
    assert.equal(api.methods['project/addProject']({ path: a }).code, 0);
    assert.equal(api.methods['project/addProject']({ path: b }).code, 0);
    assert.equal(api.methods['project/addProject']({ path: c }).code, 0);
    const result = api.methods['project/reorderProjects']({ paths: [c, a, b] });
    assert.equal(result.code, 0);
    const list = api.methods['project/queryProjectList']({});
    assert.equal(list.code, 0);
    const data = list.data as { projects: Array<{ path: string }> };
    assert.deepEqual(data.projects.map((p) => p.path), [c, a, b]);
    assert.equal(store.listProjects().length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
