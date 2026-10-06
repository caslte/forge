/**
 * 会话管理 RPC 方法层（sessionMethods）单元测试。
 *
 * 覆盖 docs/test/02_session/coverage-matrix.md api 层用例：
 * - A-SM-001：createSession → code 0，store 落库，adapter 调用正确
 * - A-SM-003：deleteSession → code 0，store 删除 + session.removed 发射
 * - A-SM-004：updateSessionAlias → code 0，仅 forge 元数据变更
 * - A-SM-005：getSessionStatus → status + runningCount 正确
 * - A-SM-006：attach/detach → code 0，重复开窗 1004，窗口绑定唯一
 * - A-SM-007：querySessionList → 跨项目全量会话可见
 * 以及本 WU 契约：参数校验 1001、createSession 未知项目 1002、异常隔离 5000、
 * 事件 session.statusChanged / session.removed 发射、信封恒为 { code, message, data }。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；真实文件系统用 fs.mkdtempSync
 * 临时目录并在 finally 中清理；pi 会话操作经 MockPiAdapter 注入。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { ForgeStore } from '../../src/store/index.ts';
import { SessionService } from '../../src/session/sessionService.ts';
import { SessionApi } from '../../src/rpc/sessionMethods.ts';
import type { PiSessionAdapter, SessionStatus } from '../../src/session/sessionService.ts';
import type { RpcResult } from '../../src/rpc/projectMethods.ts';

/** 可注入的 pi 会话适配器 mock：记录调用、可配置 create 抛错 */
class MockPiAdapter implements PiSessionAdapter {
  createCalls: Array<string | null> = [];
  stopCalls: string[] = [];
  deleteCalls: string[] = [];
  /** 置为非 null 时 createSession 抛出该错误（模拟 pi 创建失败 → 5000） */
  createError: Error | null = null;
  private counter = 0;

  async createSession(projectPath: string | null): Promise<string> {
    this.createCalls.push(projectPath);
    if (this.createError !== null) {
      throw this.createError;
    }
    this.counter += 1;
    return `sess-${this.counter}`;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopCalls.push(sessionId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.deleteCalls.push(sessionId);
  }
}

/** 创建独立临时目录（测试根目录） */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-session-rpc-test-'));
}

/** 在临时目录下创建项目目录并返回其路径 */
function makeProjectDir(base: string, name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 注册项目到 store，返回规范化后的唯一键 */
function registerProject(store: ForgeStore, dir: string): string {
  const result = store.addProject({
    path: dir,
    alias: path.basename(dir),
    createdAt: new Date().toISOString(),
    lastOpenedAt: null,
    trustState: 'untrusted',
  });
  assert.ok(result.ok);
  return result.project.path;
}

/** 构造 api + 独立 store + 事件汇 + 服务 + mock adapter */
function makeApi(
  tmp: string,
): { api: SessionApi; store: ForgeStore; events: EventEmitter; service: SessionService; adapter: MockPiAdapter } {
  const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
  const adapter = new MockPiAdapter();
  const service = new SessionService(store, adapter);
  const events = new EventEmitter();
  const api = new SessionApi(service, events);
  return { api, store, events, service, adapter };
}

/** 经 RPC 在已注册项目（key）下创建会话，返回 sessionId（断言成功） */
async function createSessionUnder(api: SessionApi, key: string): Promise<string> {
  const result = await api.methods['session/createSession']({ projectPath: key });
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const data = result.data as { session: { sessionId: string } };
    return data.session.sessionId;
  }
  return '';
}

/** 经 RPC 创建自由会话（不绑定项目），返回 sessionId（断言成功） */
async function createFreeSession(api: SessionApi): Promise<string> {
  const result = await api.methods['session/createSession']({ projectPath: null });
  assert.equal(result.code, 0);
  assert.ok(result.data !== null);
  if (result.data !== null) {
    const data = result.data as { session: { sessionId: string } };
    return data.session.sessionId;
  }
  return '';
}

test('A-SM-001：createSession 返回 0，store 落库，adapter 调用正确', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, adapter } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const result = await api.methods['session/createSession']({ projectPath: key });
    assert.equal(result.code, 0);
    assert.ok(result.data !== null);
    if (result.data !== null) {
      const data = result.data as { session: { sessionId: string; projectPath: string; alias: null } };
      assert.ok(data.session.sessionId.startsWith('sess-'));
      assert.equal(data.session.projectPath, key);
      assert.equal(data.session.alias, null);
    }
    assert.deepEqual(adapter.createCalls, [key]);
    assert.equal(store.listSessions().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSession：项目未注册返回 1002，adapter 不被调用', async () => {
  const tmp = makeTempDir();
  try {
    const { api, adapter } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'unknown-proj'); // 目录存在但未注册
    const result = await api.methods['session/createSession']({ projectPath: dir });
    assert.equal(result.code, 1002);
    assert.equal(adapter.createCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('参数校验：projectPath 非字符串返回 1001；缺省/null/空白 = 自由会话；sessionId/alias 缺失返回 1001', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    // projectPath 数字类型：1001（null 与缺省合法，不在此列）
    assert.equal((await api.methods['session/createSession']({ projectPath: 123 })).code, 1001);
    // 缺省 params / params 为 null / projectPath: null / 空白字符串：都创建自由会话
    for (const params of [{}, null, { projectPath: null }, { projectPath: '   ' }]) {
      const r = await api.methods['session/createSession'](params);
      assert.equal(r.code, 0);
    }
    const sessions = store.listSessions();
    assert.equal(sessions.length, 4);
    assert.ok(sessions.every((s) => s.projectPath === null));
    // 其余方法的必填参数校验不变
    assert.equal((await api.methods['session/deleteSession']({})).code, 1001);
    assert.equal((await api.methods['session/getSessionStatus']({})).code, 1001);
    assert.equal((await api.methods['session/attachSessionWindow']({})).code, 1001);
    assert.equal((await api.methods['session/detachSessionWindow']({})).code, 1001);
    assert.equal((await api.methods['session/updateSessionAlias']({ sessionId: '/x' })).code, 1001);
    assert.equal((await api.methods['session/updateSessionProject']({})).code, 1001);
    assert.equal(
      (await api.methods['session/updateSessionProject']({ sessionId: 'x', projectPath: 123 })).code,
      1001,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateSessionProject：移入项目/移出到自由成功且发射 session.updated；目标未注册 1002', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const freeId = await createFreeSession(api);

    // 自由 → 项目：session.updated 携带更新后的记录
    const updatedEvents: Array<{ session: { sessionId: string; projectPath: string | null } }> = [];
    events.on('session.updated', (payload: { session: { sessionId: string; projectPath: string | null } }) => {
      updatedEvents.push(payload);
    });
    const toProject = await api.methods['session/updateSessionProject']({
      sessionId: freeId,
      projectPath: key,
    });
    assert.equal(toProject.code, 0);
    assert.equal(store.getSession(freeId)?.projectPath, key);
    assert.equal(updatedEvents.length, 1);
    assert.equal(updatedEvents[0]!.session.projectPath, key);

    // 项目 → 自由（projectPath 显式 null 与缺省等价）
    const toFree = await api.methods['session/updateSessionProject']({
      sessionId: freeId,
      projectPath: null,
    });
    assert.equal(toFree.code, 0);
    assert.equal(store.getSession(freeId)?.projectPath, null);
    assert.equal(updatedEvents.length, 2);

    // 目标项目未注册：1002，归属不变、无事件
    const unknownDir = makeProjectDir(tmp, 'unknown-proj');
    const bad = await api.methods['session/updateSessionProject']({
      sessionId: freeId,
      projectPath: unknownDir,
    });
    assert.equal(bad.code, 1002);
    assert.equal(updatedEvents.length, 2);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-SM-007：querySessionList 返回跨项目全量 + 按项目过滤 + 状态附列表项', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const dirA = makeProjectDir(tmp, 'proj-a');
    const dirB = makeProjectDir(tmp, 'proj-b');
    const keyA = registerProject(store, dirA);
    const keyB = registerProject(store, dirB);
    const idA1 = await createSessionUnder(api, keyA);
    const idA2 = await createSessionUnder(api, keyA);
    const idB1 = await createSessionUnder(api, keyB);

    const all = await api.methods['session/querySessionList']({});
    assert.equal(all.code, 0);
    assert.ok(all.data !== null);
    if (all.data !== null) {
      const sessions = (all.data as { sessions: Array<{ sessionId: string; projectPath: string; status: SessionStatus }> })
        .sessions;
      assert.equal(sessions.length, 3);
    }

    const onlyA = await api.methods['session/querySessionList']({ projectPath: keyA });
    assert.equal(onlyA.code, 0);
    assert.ok(onlyA.data !== null);
    if (onlyA.data !== null) {
      const sessions = (onlyA.data as { sessions: Array<{ projectPath: string }> }).sessions;
      assert.equal(sessions.length, 2);
      assert.ok(sessions.every((s) => s.projectPath === keyA));
    }

    // 空字符串视为不过滤（API：为空时返回所有项目的会话）
    const emptyFilter = await api.methods['session/querySessionList']({ projectPath: '   ' });
    assert.equal(emptyFilter.code, 0);
    assert.ok(emptyFilter.data !== null);
    if (emptyFilter.data !== null) {
      const sessions = (emptyFilter.data as { sessions: unknown[] }).sessions;
      assert.equal(sessions.length, 3);
    }

    // 状态附在列表项上（经 service.setSessionStatus 驱动）
    api.setSessionStatus(idB1, 'running');
    const list = await api.methods['session/querySessionList']({});
    assert.ok(list.data !== null);
    if (list.data !== null) {
      const sessions = (list.data as { sessions: Array<{ sessionId: string; status: SessionStatus }> }).sessions;
      assert.equal(sessions.find((s) => s.sessionId === idB1)?.status, 'running');
      assert.equal(sessions.find((s) => s.sessionId === idA1)?.status, 'idle');
    }
    void idA2;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-SM-003：deleteSession 返回 0，store 删除，session.removed 发射', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, events, adapter } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-del');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(api, key);
    const removed: unknown[] = [];
    events.on('session.removed', (payload) => removed.push(payload));
    const result = await api.methods['session/deleteSession']({ sessionId: id });
    assert.equal(result.code, 0);
    assert.equal(store.getSession(id), undefined);
    assert.deepEqual(adapter.deleteCalls, [id]);
    assert.equal(removed.length, 1, 'session.removed 应发射一次');
    assert.deepEqual(removed[0], { sessionId: id });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：会话不存在幂等返回 0，adapter 不被调用', async () => {
  const tmp = makeTempDir();
  try {
    const { api, adapter } = makeApi(tmp);
    const result = await api.methods['session/deleteSession']({ sessionId: 'sess-ghost' });
    assert.equal(result.code, 0, '幂等：已删除/不存在视为成功');
    assert.equal(adapter.deleteCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-SM-004：updateSessionAlias 返回 0，仅 forge 元数据变更，adapter 不被触碰', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, adapter } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-alias');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(api, key);
    const before = adapter.createCalls.length;
    const result = await api.methods['session/updateSessionAlias']({ sessionId: id, alias: '修复登录 bug' });
    assert.equal(result.code, 0);
    assert.ok(result.data !== null);
    if (result.data !== null) {
      const session = (result.data as { session: { sessionId: string; alias: string } }).session;
      assert.equal(session.sessionId, id);
      assert.equal(session.alias, '修复登录 bug');
    }
    assert.equal(store.getSession(id)?.alias, '修复登录 bug');
    assert.equal(adapter.createCalls.length, before);
    assert.equal(adapter.stopCalls.length, 0);
    assert.equal(adapter.deleteCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-SM-005：getSessionStatus 反映 service.setSessionStatus 状态 + runningCount', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, service } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-status');
    const key = registerProject(store, dir);
    const id1 = await createSessionUnder(api, key);
    const id2 = await createSessionUnder(api, key);

    const initial = await api.methods['session/getSessionStatus']({ sessionId: id1 });
    assert.equal(initial.code, 0);
    assert.ok(initial.data !== null);
    if (initial.data !== null) {
      const data = initial.data as { status: SessionStatus; runningCount: number };
      assert.equal(data.status, 'idle');
      assert.equal(data.runningCount, 0);
    }

    // 经 service.setSessionStatus 驱动状态后 RPC 查询反映
    service.setSessionStatus(id1, 'running');
    service.setSessionStatus(id2, 'running');
    const running = await api.methods['session/getSessionStatus']({ sessionId: id1 });
    assert.equal(running.code, 0);
    assert.ok(running.data !== null);
    if (running.data !== null) {
      const data = running.data as { status: SessionStatus; runningCount: number };
      assert.equal(data.status, 'running');
      assert.equal(data.runningCount, 2, '两会话均 running，runningCount=2');
    }

    const ghost = await api.methods['session/getSessionStatus']({ sessionId: 'sess-ghost' });
    assert.equal(ghost.code, 1002);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-SM-006：attachSessionWindow 返回 { history: [], status }，重复开窗 1004', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-attach');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(api, key);

    const ok = await api.methods['session/attachSessionWindow']({ sessionId: id });
    assert.equal(ok.code, 0);
    assert.ok(ok.data !== null);
    if (ok.data !== null) {
      const data = ok.data as { history: unknown[]; status: SessionStatus };
      assert.deepEqual(data.history, [], 'v1 history 恒为空数组（模块 03 接入流式内容）');
      assert.equal(data.status, 'idle');
    }

    const dup = await api.methods['session/attachSessionWindow']({ sessionId: id });
    assert.equal(dup.code, 1004, '同一会话重复开窗被拒绝（TD-SM-04）');

    const ghost = await api.methods['session/attachSessionWindow']({ sessionId: 'sess-ghost' });
    assert.equal(ghost.code, 1002);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('A-SM-006：detachSessionWindow 返回 0，幂等（重复摘除/未开窗均可）', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-detach');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(api, key);

    const ok = await api.methods['session/attachSessionWindow']({ sessionId: id });
    assert.equal(ok.code, 0);
    const detach = await api.methods['session/detachSessionWindow']({ sessionId: id });
    assert.equal(detach.code, 0);
    assert.equal(detach.data, null);

    // 幂等：再次摘除 / 未开窗直接摘除均返回成功
    const again = await api.methods['session/detachSessionWindow']({ sessionId: id });
    assert.equal(again.code, 0);

    const ghost = await api.methods['session/detachSessionWindow']({ sessionId: 'sess-ghost' });
    assert.equal(ghost.code, 1002);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('事件：setSessionStatus 发射 session.statusChanged（sessionId/status/runningCount）', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-evt');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(api, key);
    const changed: unknown[] = [];
    events.on('session.statusChanged', (payload) => changed.push(payload));
    api.setSessionStatus(id, 'running');
    assert.equal(changed.length, 1, 'session.statusChanged 应发射一次');
    assert.deepEqual(changed[0], { sessionId: id, status: 'running', runningCount: 1 });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('异常隔离：adapter 创建失败返回 5000，不泄漏异常，store 无写入', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, adapter } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-5000');
    const key = registerProject(store, dir);
    adapter.createError = new Error('pi create failed');
    const result = await api.methods['session/createSession']({ projectPath: key });
    assert.equal(result.code, 5000);
    assert.equal(result.data, null);
    assert.equal(store.listSessions().length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('信封：所有方法返回 { code, message, data }', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-env');
    const key = registerProject(store, dir);
    const results: RpcResult[] = [];
    results.push(await api.methods['session/createSession']({ projectPath: key }));
    results.push(await api.methods['session/querySessionList']({}));
    results.push(await api.methods['session/updateSessionAlias']({ sessionId: 'x', alias: 'a' }));
    results.push(await api.methods['session/getSessionStatus']({ sessionId: 'x' }));
    results.push(await api.methods['session/attachSessionWindow']({ sessionId: 'x' }));
    results.push(await api.methods['session/detachSessionWindow']({ sessionId: 'x' }));
    results.push(await api.methods['session/deleteSession']({ sessionId: 'x' }));
    for (const r of results) {
      assert.deepEqual(Object.keys(r).sort(), ['code', 'data', 'message'], '信封恒为 { code, message, data }');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('A-SM-009：markSessionRead → code 0 + doneReadAt 落库 + session.updated 发射；1001/1002', async () => {
  const tmp = makeTempDir();
  try {
    const { api, store, events } = makeApi(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(api, key);

    const updatedPayloads: unknown[] = [];
    events.on('session.updated', (p: unknown) => updatedPayloads.push(p));

    const result = await api.methods['session/markSessionRead']({ sessionId: id });
    assert.equal(result.code, 0);
    const record = store.getSession(id);
    assert.ok(record?.doneReadAt);
    assert.equal(updatedPayloads.length, 1);

    // 参数校验 / 会话不存在
    assert.equal((await api.methods['session/markSessionRead']({ sessionId: '' })).code, 1001);
    assert.equal((await api.methods['session/markSessionRead']({ sessionId: 'sess-nope' })).code, 1002);
    assert.equal((await api.methods['session/markSessionRead']({})).code, 1001);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
