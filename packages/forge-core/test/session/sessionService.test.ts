/**
 * 会话管理服务（sessionService）单元测试。
 *
 * 覆盖 docs/test/02_session/coverage-matrix.md 本 WU 用例：
 * - U-SM-001：删除运行中会话先 stop 再删除；不经停止直接删除被拦截
 * - U-SM-002：10 会话并行，各会话状态独立、无共享状态串扰
 * - U-SM-003：重命名仅改 forge 元数据，pi 消息文件不变（adapter 不被触碰）
 * - U-SM-007：排序持久化——转 running touch lastActiveAt 落盘，重开 store 顺序保持
 * 以及本 WU 契约：createSession 1001/1002、deleteSession 幂等、attach/detach
 * 1004/1002、getSessionStatus runningCount、跨项目会话池查询。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；真实文件系统用 fs.mkdtempSync
 * 临时目录并在 finally 中清理；pi 会话操作经 MockPiAdapter 注入（服务不 import pi）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeStore } from '../../src/store/index.ts';
import { SessionService } from '../../src/session/sessionService.ts';
import type { PiSessionAdapter, SessionStatus } from '../../src/session/sessionService.ts';

/** 可注入的 pi 会话适配器 mock：记录调用、可配置 stop 抛错 */
class MockPiAdapter implements PiSessionAdapter {
  createCalls: string[] = [];
  stopCalls: string[] = [];
  deleteCalls: string[] = [];
  /** deleteSession 收到的项目路径（服务层必须从 store 记录透传，真删磁盘需要） */
  deleteProjectPaths: string[] = [];
  /** 置为非 null 时 stopSession 抛出该错误（模拟 pi 停止失败） */
  stopError: Error | null = null;
  /** 置为非 null 时 deleteSession 抛出该错误（模拟磁盘文件删除失败） */
  deleteError: Error | null = null;
  private counter = 0;

  async createSession(projectPath: string): Promise<string> {
    this.createCalls.push(projectPath);
    this.counter += 1;
    return `sess-${this.counter}`;
  }

  async stopSession(sessionId: string): Promise<void> {
    this.stopCalls.push(sessionId);
    if (this.stopError !== null) {
      throw this.stopError;
    }
  }

  async deleteSession(sessionId: string, projectPath: string): Promise<void> {
    this.deleteCalls.push(sessionId);
    this.deleteProjectPaths.push(projectPath);
    if (this.deleteError !== null) {
      throw this.deleteError;
    }
  }
}

/** 创建独立临时目录（测试根目录） */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-session-test-'));
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

/** 构造服务 + 独立 store + mock adapter（共享同一临时存储文件） */
function makeService(tmp: string): { service: SessionService; store: ForgeStore; adapter: MockPiAdapter } {
  const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
  const adapter = new MockPiAdapter();
  return { service: new SessionService(store, adapter), store, adapter };
}

/** 在已注册项目（key）下创建会话，返回 sessionId（断言成功） */
async function createSessionUnder(service: SessionService, key: string): Promise<string> {
  const result = await service.createSession(key);
  assert.ok(result.ok);
  if (!result.ok) {
    return '';
  }
  return result.data.session.sessionId;
}

test('createSession：项目存在时创建成功，adapter 调用 + store 落库（AC-SM-001/002）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const result = await service.createSession(key);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.data.session.projectPath, key);
      assert.equal(result.data.session.alias, null);
      assert.equal(result.data.session.modelOverride, null);
      assert.ok(result.data.session.sessionId.startsWith('sess-'));
      assert.ok(result.data.session.createdAt.length > 0);
      assert.ok(result.data.session.lastActiveAt.length > 0);
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
    const { service, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'unknown-proj'); // 目录存在但未注册
    const result = await service.createSession(dir);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
    assert.equal(adapter.createCalls.length, 0);
    assert.equal(adapter.deleteCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('createSession：空项目路径返回 1001', async () => {
  const tmp = makeTempDir();
  try {
    const { service, adapter } = makeService(tmp);
    const result = await service.createSession('   ');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
    }
    assert.equal(adapter.createCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('querySessionList：跨项目全量 + 按项目过滤 + 状态附列表项（SM-S05/AC-SM-015）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dirA = makeProjectDir(tmp, 'proj-a');
    const dirB = makeProjectDir(tmp, 'proj-b');
    const keyA = registerProject(store, dirA);
    const keyB = registerProject(store, dirB);
    const idA1 = await createSessionUnder(service, keyA);
    const idA2 = await createSessionUnder(service, keyA);
    const idB1 = await createSessionUnder(service, keyB);

    const all = service.querySessionList();
    assert.ok(all.ok);
    if (all.ok) {
      assert.equal(all.data.sessions.length, 3);
    }

    const onlyA = service.querySessionList(keyA);
    assert.ok(onlyA.ok);
    if (onlyA.ok) {
      assert.equal(onlyA.data.sessions.length, 2);
      assert.ok(onlyA.data.sessions.every((s) => s.projectPath === keyA));
    }

    // 空字符串视为不过滤（API：为空时返回所有项目的会话）
    const emptyFilter = service.querySessionList('');
    assert.ok(emptyFilter.ok);
    if (emptyFilter.ok) {
      assert.equal(emptyFilter.data.sessions.length, 3);
    }

    // 状态附在列表项上
    service.setSessionStatus(idB1, 'running');
    const list = service.querySessionList();
    assert.ok(list.ok);
    if (list.ok) {
      const b = list.data.sessions.find((s) => s.sessionId === idB1);
      assert.equal(b?.status, 'running');
      const a = list.data.sessions.find((s) => s.sessionId === idA1);
      assert.equal(a?.status, 'idle');
    }
    void idA2;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：空闲会话直接删除，不调用 stop（U-SM-001 状态校验）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    const result = await service.deleteSession(id);
    assert.ok(result.ok);
    assert.deepEqual(adapter.stopCalls, []);
    assert.deepEqual(adapter.deleteCalls, [id]);
    assert.equal(store.getSession(id), undefined);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：运行中会话先 stop 再删除（U-SM-001/AC-SM-006）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    service.setSessionStatus(id, 'running');
    const result = await service.deleteSession(id);
    assert.ok(result.ok);
    assert.deepEqual(adapter.stopCalls, [id]);
    assert.deepEqual(adapter.deleteCalls, [id]);
    assert.equal(store.getSession(id), undefined);
    // 删除后运行时状态与窗口绑定一并清理
    const status = service.getSessionStatus(id);
    assert.ok(!status.ok);
    if (!status.ok) {
      assert.equal(status.code, 1002);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：会话不存在幂等成功（重复删除无副作用，SM-S03）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, adapter } = makeService(tmp);
    const result = await service.deleteSession('sess-ghost');
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.data, null);
    }
    assert.equal(adapter.stopCalls.length, 0);
    assert.equal(adapter.deleteCalls.length, 0);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：重复删除同一会话幂等成功', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    const first = await service.deleteSession(id);
    assert.ok(first.ok);
    const second = await service.deleteSession(id);
    assert.ok(second.ok);
    if (second.ok) {
      assert.equal(second.data, null);
    }
    assert.deepEqual(adapter.deleteCalls, [id]); // 第二次不重复删除
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：所属项目路径透传给 adapter（真删磁盘需要）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    const result = await service.deleteSession(id);
    assert.ok(result.ok);
    // 适配器凭 projectPath 推导 pi 转录文件与子 agent 输出目录，缺了就删不掉
    assert.deepEqual(adapter.deleteProjectPaths, [key]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：磁盘删除抛错时错误上抛、会话记录保留（先清盘、后删记录）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    adapter.deleteError = new Error('delete failed: EPERM');
    await assert.rejects(() => service.deleteSession(id));
    // 会话保留：store 记录与运行时状态原样，用户可重试；不会出现
    // 「列表里没了、磁盘文件还在」的隐形残留（本缺陷曾积累 159 个孤儿 jsonl）
    assert.notEqual(store.getSession(id), undefined);
    assert.deepEqual(adapter.deleteProjectPaths, [key]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('deleteSession：stop 抛错时错误上抛、会话保留（异常失败）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    service.setSessionStatus(id, 'running');
    adapter.stopError = new Error('stop failed');
    await assert.rejects(() => service.deleteSession(id));
    // 会话保留：store 记录未删、未继续 delete、状态仍为 running
    assert.notEqual(store.getSession(id), undefined);
    assert.deepEqual(adapter.deleteCalls, []);
    const status = service.getSessionStatus(id);
    assert.ok(status.ok);
    if (status.ok) {
      assert.equal(status.data.status, 'running');
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateSessionAlias：合法别名更新成功且不触碰 adapter（U-SM-003/AC-SM-007）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store, adapter } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    const before = adapter.createCalls.length;
    const result = service.updateSessionAlias(id, '修复登录 bug');
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.data.session.alias, '修复登录 bug');
    }
    // 仅 forge 元数据变更：adapter 无任何新调用
    assert.equal(adapter.createCalls.length, before);
    assert.equal(adapter.stopCalls.length, 0);
    assert.equal(adapter.deleteCalls.length, 0);
    // 重命名幂等：再次改名成功
    const second = service.updateSessionAlias(id, '改别名');
    assert.ok(second.ok);
    if (second.ok) {
      assert.equal(second.data.session.alias, '改别名');
    }
    assert.equal(store.getSession(id)?.alias, '改别名');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateSessionAlias：空别名返回 1001', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    const result = service.updateSessionAlias(id, '   ');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
    }
    assert.equal(store.getSession(id)?.alias, null); // 未变更
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateSessionAlias：会话不存在返回 1002', async () => {
  const tmp = makeTempDir();
  try {
    const { service } = makeService(tmp);
    const result = service.updateSessionAlias('sess-ghost', '别名');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getSessionStatus：10 会话状态独立、runningCount 正确（AC-SM-008）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await createSessionUnder(service, key));
    }
    // 初始全 idle，runningCount=0
    const initial = service.getSessionStatus(ids[0]!);
    assert.ok(initial.ok);
    if (initial.ok) {
      assert.equal(initial.data.status, 'idle');
      assert.equal(initial.data.runningCount, 0);
    }
    // 前 3 个 running，其余保持 idle
    for (let i = 0; i < 3; i += 1) {
      service.setSessionStatus(ids[i]!, 'running');
    }
    for (let i = 0; i < 10; i += 1) {
      const r = service.getSessionStatus(ids[i]!);
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.data.status, i < 3 ? 'running' : 'idle');
        assert.equal(r.data.runningCount, 3);
      }
    }
    // 状态流转互不影响：第 4 个 done，其余不变
    service.setSessionStatus(ids[3]!, 'done');
    const done = service.getSessionStatus(ids[3]!);
    assert.ok(done.ok);
    if (done.ok) {
      assert.equal(done.data.status, 'done');
      assert.equal(done.data.runningCount, 3);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('getSessionStatus：会话不存在返回 1002', async () => {
  const tmp = makeTempDir();
  try {
    const { service } = makeService(tmp);
    const result = service.getSessionStatus('sess-ghost');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('attach/detach：开窗一次成功、重复开窗 1004、已删会话 1002、关闭幂等（AC-SM-016）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);

    const first = service.attachSessionWindow(id);
    assert.ok(first.ok);
    if (first.ok) {
      assert.equal(first.data.session.sessionId, id);
      assert.equal(first.data.status, 'idle');
    }

    const second = service.attachSessionWindow(id);
    assert.ok(!second.ok);
    if (!second.ok) {
      assert.equal(second.code, 1004);
    }

    const detach = service.detachSessionWindow(id);
    assert.ok(detach.ok);
    // 关窗不删会话：会话仍在列表中
    assert.notEqual(store.getSession(id), undefined);

    // 关闭后可重新开窗
    const reattach = service.attachSessionWindow(id);
    assert.ok(reattach.ok);

    // detach 幂等：重复关闭成功
    const detachAgain = service.detachSessionWindow(id);
    assert.ok(detachAgain.ok);
    const detachThird = service.detachSessionWindow(id);
    assert.ok(detachThird.ok);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('attach：已删除会话返回 1002', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);
    await service.deleteSession(id);
    const result = service.attachSessionWindow(id);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('多会话并行：10 会话交错 setStatus + attach/detach 无串扰（TD-SM-01/U-SM-002）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const ids: string[] = [];
    for (let i = 0; i < 10; i += 1) {
      ids.push(await createSessionUnder(service, key));
    }
    // 交错驱动：每会话独立状态 + 偶数号开窗
    const statuses: SessionStatus[] = ['idle', 'running', 'done', 'error'];
    const expected: SessionStatus[] = [];
    for (let i = 0; i < 10; i += 1) {
      const status = statuses[i % statuses.length]!;
      expected.push(status);
      service.setSessionStatus(ids[i]!, status);
      if (i % 2 === 0) {
        assert.ok(service.attachSessionWindow(ids[i]!).ok);
      }
    }
    const runningExpected = expected.filter((s) => s === 'running').length;
    for (let i = 0; i < 10; i += 1) {
      // 各会话状态独立
      const r = service.getSessionStatus(ids[i]!);
      assert.ok(r.ok);
      if (r.ok) {
        assert.equal(r.data.status, expected[i]);
        assert.equal(r.data.runningCount, runningExpected);
      }
      // 偶数号已开窗 → 重复开窗 1004；奇数号可开窗
      const at = service.attachSessionWindow(ids[i]!);
      if (i % 2 === 0) {
        assert.ok(!at.ok);
        if (!at.ok) {
          assert.equal(at.code, 1004);
        }
      } else {
        assert.ok(at.ok);
      }
      // 关闭全部窗口
      assert.ok(service.detachSessionWindow(ids[i]!).ok);
    }
    // 全部关闭后所有会话可重新开窗（窗口绑定互不残留）
    for (let i = 0; i < 10; i += 1) {
      assert.ok(service.attachSessionWindow(ids[i]!).ok);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
test('markSessionRead + 完成：doneReadAt 落盘，新一轮 done 清已读、done→done 重复写不清', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const id = await createSessionUnder(service, key);

    // 初始无已读标记（新会话 doneReadAt = null）
    let list = service.querySessionList();
    assert.ok(list.ok);
    if (list.ok) {
      assert.equal(list.data.sessions.find((s) => s.sessionId === id)?.doneReadAt ?? null, null);
    }

    // 完成一轮 → 标记已读 → 列表携带 doneReadAt
    service.setSessionStatus(id, 'running');
    service.setSessionStatus(id, 'done');
    const marked = service.markSessionRead(id);
    assert.ok(marked.ok);
    list = service.querySessionList();
    assert.ok(list.ok);
    let readAt: string | null | undefined;
    if (list.ok) {
      readAt = list.data.sessions.find((s) => s.sessionId === id)?.doneReadAt;
    }
    assert.ok(typeof readAt === 'string' && readAt !== '');

    // 新一轮完成（running→done 转进入口）：已读标记清回 null（绿点重新提示）
    service.setSessionStatus(id, 'running');
    service.setSessionStatus(id, 'done');
    list = service.querySessionList();
    assert.ok(list.ok);
    if (list.ok) {
      assert.equal(list.data.sessions.find((s) => s.sessionId === id)?.doneReadAt ?? null, null);
    }

    // 同轮重复 done（done→done）：不清已读（避免重复完成事件重新点亮绿点）
    assert.ok(service.markSessionRead(id).ok);
    service.setSessionStatus(id, 'done');
    list = service.querySessionList();
    assert.ok(list.ok);
    if (list.ok) {
      assert.ok(list.data.sessions.find((s) => s.sessionId === id)?.doneReadAt);
    }

    // 参数校验 1001 / 会话不存在 1002
    assert.equal(service.markSessionRead('').ok, false);
    assert.equal(service.markSessionRead('sess-nope').ok, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('排序持久化：进入 running touch lastActiveAt，重启后「最近活动在前」仍在（会话树置顶落盘）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const key = registerProject(store, dir);
    const [s1, s2, s3] = [
      await createSessionUnder(service, key),
      await createSessionUnder(service, key),
      await createSessionUnder(service, key),
    ];
    // 固定三个互异且远早于"现在"的活动时间 → 基线序确定（降序 = s3, s2, s1），
    // 避免真实时钟同毫秒并列导致断言抖动
    const pin = (id: string, iso: string): void => {
      const rec = store.getSession(id);
      assert.ok(rec);
      if (rec) store.saveSession({ ...rec, lastActiveAt: iso });
    };
    pin(s1!, '2001-01-01T00:00:00.000Z');
    pin(s2!, '2001-01-02T00:00:00.000Z');
    pin(s3!, '2001-01-03T00:00:00.000Z');

    const order = (svc: { querySessionList: SessionService['querySessionList'] }): string[] => {
      const r = svc.querySessionList();
      assert.ok(r.ok);
      return r.ok ? r.data.sessions.map((s) => s.sessionId) : [];
    };
    assert.deepEqual(order(service), [s3, s2, s1]);

    // 一轮开始 → 该会话顶到最前（与 UI 内存态 activatedOrder 同序，但落盘）
    service.setSessionStatus(s1!, 'running');
    assert.deepEqual(order(service), [s1, s3, s2]);

    // 完成不回落：位置保留
    service.setSessionStatus(s1!, 'done');
    assert.deepEqual(order(service), [s1, s3, s2]);

    // 换一个会话开跑 → 活动序更新，且同样落盘
    service.setSessionStatus(s2!, 'running');
    assert.deepEqual(order(service), [s2, s1, s3]);

    // 关键断言：重开 store（模拟重启 / 新窗口读盘）后顺序保持，不退回"创建时间倒序"
    const reopened = new ForgeStore(path.join(tmp, 'forge-store.json'));
    assert.deepEqual(reopened.listSessions().map((s) => s.sessionId), [s2, s1, s3]);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
