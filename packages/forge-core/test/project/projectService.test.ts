/**
 * 项目管理服务（projectService）单元测试。
 *
 * 覆盖 docs/test/01_project/coverage-matrix.md 本 WU 用例：
 * - U-PM-001：重复路径（含符号链接变体）→ 1001，store 仅一条记录
 * - U-PM-002：不存在/空/非目录路径 → 1001（API 契约：非法路径），store 无写入
 * - U-PM-003：信任状态机 —— trust→trusted（资源加载路径）/ reject→rejected（不加载）/
 *             trustOnce→回到 untrusted（下次重新询问）/ 已确定状态幂等不重复询问 /
 *             非法跳转（untrusted 直接 trusted）被拒绝
 * 以及本 WU 契约：removeProject 1002、openProject 1002/1005、updateProjectAlias 1001/1002、
 * queryProjectList 按最近打开倒序、源文件不被删除。
 *
 * 使用 node:test + Node 24 原生 TS 类型剥离；真实文件系统用 fs.mkdtempSync
 * 临时目录并在 finally 中清理。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ForgeStore } from '../../src/store/index.ts';
import { ProjectService } from '../../src/project/projectService.ts';

/** 创建独立临时目录（测试根目录） */
function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-project-test-'));
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

/** 构造服务 + 独立 store（共享同一临时存储文件） */
function makeService(tmp: string): { service: ProjectService; store: ForgeStore } {
  const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
  return { service: new ProjectService(store), store };
}

test('addProject：有效目录注册成功，列表新增且信任初始为 untrusted（AC-PM-001）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-a');
    const result = service.addProject(dir);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.data.project.path, dir);
      assert.equal(result.data.project.alias, 'proj-a');
      assert.equal(result.data.project.trustState, 'untrusted');
    }
    assert.equal(store.listProjects().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：重复路径返回 1001，store 仅一条记录（U-PM-001）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-dup');
    assert.ok(service.addProject(dir).ok);
    const second = service.addProject(dir);
    assert.ok(!second.ok);
    if (!second.ok) {
      assert.equal(second.code, 1001);
    }
    assert.equal(store.listProjects().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：符号链接变体路径规范化后判重 1001（U-PM-001）', (t) => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-link');
    const linkPath = path.join(tmp, 'proj-link-junction');
    try {
      // Windows 用 junction（无需管理员权限），其余平台用目录符号链接
      fs.symlinkSync(dir, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    } catch {
      t.skip('当前环境不允许创建符号链接/联接');
      return;
    }
    assert.ok(service.addProject(dir).ok);
    const viaLink = service.addProject(linkPath);
    assert.ok(!viaLink.ok);
    if (!viaLink.ok) {
      assert.equal(viaLink.code, 1001);
    }
    assert.equal(store.listProjects().length, 1);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：不存在的路径返回 1001，store 无写入（U-PM-002）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const missing = path.join(tmp, 'no-such-dir');
    const result = service.addProject(missing);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
    }
    assert.deepEqual(store.listProjects(), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：空路径返回 1001，store 无写入（U-PM-002）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const result = service.addProject('   ');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
    }
    assert.deepEqual(store.listProjects(), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('addProject：文件路径（非目录）返回 1001，store 无写入（U-PM-002）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const file = path.join(tmp, 'a-file.txt');
    fs.writeFileSync(file, 'x');
    const result = service.addProject(file);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
    }
    assert.deepEqual(store.listProjects(), []);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('openProject：trust → asking → trusted，资源加载路径，再次打开不询问（U-PM-003）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-trust');
    makePiResource(dir);
    assert.ok(service.addProject(dir).ok);
    // 首次打开：含 .pi 资源 → 同步 1005 + prompt，状态进入 asking
    const opened = service.openProject(dir);
    assert.ok(!opened.ok);
    if (!opened.ok) {
      assert.equal(opened.code, 1005);
      assert.equal(opened.data.prompt.reason, 'project-extensions');
      assert.equal(opened.data.path, dir);
    }
    assert.equal(store.getProject(dir)?.trustState, 'asking');
    // 决策 trust → trusted
    assert.ok(service.setTrust(dir, 'trust').ok);
    assert.equal(store.getProject(dir)?.trustState, 'trusted');
    // 已确定状态：再次打开不再询问
    assert.ok(service.openProject(dir).ok);
    assert.equal(store.getProject(dir)?.trustState, 'trusted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('openProject：reject → rejected，再次打开不询问（U-PM-003）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-reject');
    makePiResource(dir);
    assert.ok(service.addProject(dir).ok);
    const opened = service.openProject(dir);
    assert.ok(!opened.ok);
    if (!opened.ok) {
      assert.equal(opened.code, 1005);
    }
    assert.ok(service.setTrust(dir, 'reject').ok);
    assert.equal(store.getProject(dir)?.trustState, 'rejected');
    assert.ok(service.openProject(dir).ok);
    assert.equal(store.getProject(dir)?.trustState, 'rejected');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('setTrust：trustOnce 不持久状态，再次打开重新询问（U-PM-003）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-once');
    makePiResource(dir);
    assert.ok(service.addProject(dir).ok);
    const opened = service.openProject(dir);
    assert.ok(!opened.ok);
    if (!opened.ok) {
      assert.equal(opened.code, 1005);
    }
    assert.equal(store.getProject(dir)?.trustState, 'asking');
    assert.ok(service.setTrust(dir, 'trustOnce').ok);
    assert.equal(store.getProject(dir)?.trustState, 'untrusted');
    // 再次打开 → 重新询问
    const reopened = service.openProject(dir);
    assert.ok(!reopened.ok);
    if (!reopened.ok) {
      assert.equal(reopened.code, 1005);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('setTrust：非法状态流转被拒绝（untrusted 不可直接 trusted，U-PM-003）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-illegal');
    makePiResource(dir);
    assert.ok(service.addProject(dir).ok);
    // 未经询问直接决策：跳过询问直接加载为非法（PRD PM-S04）→ 1001，状态不变
    const result = service.setTrust(dir, 'trust');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
    }
    assert.equal(store.getProject(dir)?.trustState, 'untrusted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('setTrust：已确定状态幂等，重复决策不改变状态（U-PM-003）', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-idem');
    makePiResource(dir);
    assert.ok(service.addProject(dir).ok);
    assert.ok(!service.openProject(dir).ok); // 1005
    assert.ok(service.setTrust(dir, 'trust').ok);
    // 已 trusted 后再 reject / trustOnce → 幂等成功，状态保持 trusted
    assert.ok(service.setTrust(dir, 'reject').ok);
    assert.equal(store.getProject(dir)?.trustState, 'trusted');
    assert.ok(service.setTrust(dir, 'trustOnce').ok);
    assert.equal(store.getProject(dir)?.trustState, 'trusted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('openProject：无 .pi 资源项目直接打开成功并更新 lastOpenedAt', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-plain');
    assert.ok(service.addProject(dir).ok);
    const result = service.openProject(dir);
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.data.path, dir);
    }
    assert.ok(store.getProject(dir)?.lastOpenedAt !== null, '打开后应更新最近打开时间');
    assert.equal(store.getProject(dir)?.trustState, 'untrusted');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('openProject：未注册项目返回 1002（API 契约）', () => {
  const tmp = makeTempDir();
  try {
    const { service } = makeService(tmp);
    const missing = path.join(tmp, 'never-registered');
    const result = service.openProject(missing);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeProject：移除已注册项目成功，仅删元数据，源文件保留（AC-PM-006）', async () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-rm');
    assert.ok(service.addProject(dir).ok);
    const result = await service.removeProject(dir);
    assert.ok(result.ok);
    assert.equal(store.getProject(dir), null, 'store 中 project 记录应删除');
    assert.ok(fs.existsSync(dir), '源文件不应被删除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeProject：级联删除名下会话（停运行+删 pi 会话经端口，forge 会话记录一并清除）', async () => {
  const tmp = makeTempDir();
  try {
    const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
    const deleted: string[] = [];
    const service = new ProjectService(store, undefined, {
      deleteSession: async (sessionId) => {
        deleted.push(sessionId);
        store.removeSession(sessionId);
      },
    });
    const dir = makeProjectDir(tmp, 'proj-cascade');
    assert.ok(service.addProject(dir).ok);
    store.saveSession({
      sessionId: 's-1',
      projectPath: dir,
      alias: null,
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelOverride: null,
    });
    store.saveSession({
      sessionId: 's-2',
      projectPath: 'C:/other-proj',
      alias: null,
      lastActiveAt: '2026-01-01T00:00:00.000Z',
      createdAt: '2026-01-01T00:00:00.000Z',
      modelOverride: null,
    });
    const result = await service.removeProject(dir);
    assert.ok(result.ok);
    if (result.ok) {
      assert.deepEqual(result.data.removedSessions.sort(), ['s-1'], '只级联该项目名下会话');
    }
    assert.deepEqual(deleted, ['s-1'], '端口应收到该项目会话的删除调用');
    assert.equal(store.getSession('s-1'), undefined, 'forge 会话记录应删除');
    assert.notEqual(store.getSession('s-2'), undefined, '其他项目会话不应受影响');
    assert.equal(store.getProject(dir), null, 'project 记录删除');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('removeProject：未注册项目返回 1002（幂等客户端行为由 rpc 层实现）', async () => {
  const tmp = makeTempDir();
  try {
    const { service } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-rm-missing');
    const result = await service.removeProject(dir);
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateProjectAlias：非空别名更新成功', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-alias');
    assert.ok(service.addProject(dir).ok);
    const result = service.updateProjectAlias(dir, '新别名');
    assert.ok(result.ok);
    if (result.ok) {
      assert.equal(result.data.project.alias, '新别名');
    }
    assert.equal(store.getProject(dir)?.alias, '新别名');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateProjectAlias：空别名返回 1001，状态不变', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-alias-empty');
    assert.ok(service.addProject(dir).ok);
    const result = service.updateProjectAlias(dir, '   ');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1001);
    }
    assert.equal(store.getProject(dir)?.alias, 'proj-alias-empty');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('updateProjectAlias：未注册项目返回 1002', () => {
  const tmp = makeTempDir();
  try {
    const { service } = makeService(tmp);
    const dir = path.join(tmp, 'no-alias-proj');
    const result = service.updateProjectAlias(dir, 'x');
    assert.ok(!result.ok);
    if (!result.ok) {
      assert.equal(result.code, 1002);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('queryProjectList：按 lastOpenedAt 倒序（最近打开在前，未打开排最后）', () => {
  const tmp = makeTempDir();
  try {
    const { service } = makeService(tmp);
    const a = makeProjectDir(tmp, 'proj-a');
    const b = makeProjectDir(tmp, 'proj-b');
    const c = makeProjectDir(tmp, 'proj-c');
    assert.ok(service.addProject(a).ok);
    assert.ok(service.addProject(b).ok);
    assert.ok(service.addProject(c).ok);
    assert.ok(service.openProject(b).ok);
    assert.ok(service.openProject(a).ok);
    const result = service.queryProjectList();
    assert.ok(result.ok);
    if (result.ok) {
      const names = result.data.projects.map((p) => path.basename(p.path));
      assert.deepEqual(names, ['proj-a', 'proj-b', 'proj-c']);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ===== 项目拖拽排序（reorderProjects） =====

test('reorderProjects：非数组/空数组/含非字符串 -> 1001，不写盘', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const a = service.addProject(makeProjectDir(tmp, 'a'));
    assert.ok(a.ok);
    assert.equal(service.reorderProjects(null).code, 1001);
    assert.equal(service.reorderProjects([]).code, 1001);
    assert.equal(service.reorderProjects(['x', 1]).code, 1001);
    assert.equal(service.reorderProjects(['']).code, 1001);
    assert.deepEqual(store.listProjects().map((p) => p.path), [a.data?.project.path].filter(Boolean));
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('reorderProjects：全量重排透传 store，queryProjectList 顺序变更且持久化', () => {
  const tmp = makeTempDir();
  try {
    const { service, store } = makeService(tmp);
    const a = service.addProject(makeProjectDir(tmp, 'a'));
    const b = service.addProject(makeProjectDir(tmp, 'b'));
    const c = service.addProject(makeProjectDir(tmp, 'c'));
    assert.ok(a.ok && b.ok && c.ok);
    if (!a.ok || !b.ok || !c.ok) return;
    const paths = [c.data.project.path, a.data.project.path, b.data.project.path];
    const res = service.reorderProjects(paths);
    assert.ok(res.ok);
    const list = service.queryProjectList();
    assert.ok(list.ok);
    if (list.ok) {
      assert.deepEqual(list.data.projects.map((p) => p.path), paths);
    }
    // 持久化：新实例 + 新 service 读回顺序不变
    const reloaded = makeService(tmp);
    const relist = reloaded.service.queryProjectList();
    assert.ok(relist.ok);
    if (relist.ok) {
      assert.deepEqual(relist.data.projects.map((p) => p.path), paths);
    }
    assert.equal(store.listProjects().length, 3);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ===== CV-TRUST-01：执行链信任判定（isTrustedForExecution）=====
// forge-desktop 装配 pi 工厂时以此方法为唯一信任口径：
// pi 持久决策 ∨ trustOnce 内存放行。三种决策路径在此逐一验证。

/** 带内存信任决策 fake 端口的服务（模拟 PiTrustStoreAdapter：决策持久化到临时目录文件） */
function makeTrustedService(tmp: string): {
  service: ProjectService;
  store: ForgeStore;
  getDecision: (cwd: string) => boolean | null;
} {
  const store = new ForgeStore(path.join(tmp, 'forge-store.json'));
  const decisionsPath = path.join(tmp, 'decisions.json');
  const readMap = (): Map<string, boolean> => {
    try {
      return new Map(
        Object.entries(JSON.parse(fs.readFileSync(decisionsPath, 'utf8')) as Record<string, boolean>),
      );
    } catch {
      return new Map();
    }
  };
  const trust = {
    hasTrustRequiringResources: (cwd: string): boolean => fs.existsSync(path.join(cwd, '.pi')),
    getDecision: (cwd: string): boolean | null => readMap().get(cwd) ?? null,
    setDecision: (cwd: string, decision: boolean): void => {
      const map = readMap();
      map.set(cwd, decision);
      fs.writeFileSync(decisionsPath, JSON.stringify(Object.fromEntries(map)), 'utf8');
    },
  };
  return {
    service: new ProjectService(store, trust),
    store,
    getDecision: (cwd: string) => readMap().get(cwd) ?? null,
  };
}

test('isTrustedForExecution：trustOnce 会话内放行且不写 pi store，重启（重建服务）后不放行', () => {
  const tmp = makeTempDir();
  try {
    const { service, getDecision } = makeTrustedService(tmp);
    const dir = makeProjectDir(tmp, 'proj-once');
    makePiResource(dir);
    assert.ok(service.addProject(dir).ok);
    // 打开含资源未决项目 → 1005 询问（asking）
    const opened = service.openProject(dir);
    assert.ok(!opened.ok && opened.code === 1005);
    // 未决：不放行
    assert.equal(service.isTrustedForExecution(dir), false);
    // trustOnce：本次放行（内存），pi store 仍为 null
    assert.ok(service.setTrust(dir, 'trustOnce').ok);
    assert.equal(service.isTrustedForExecution(dir), true);
    assert.equal(getDecision(dir), null);
    // 重建服务（模拟重启）：内存集合清空，不放行
    const { service: rebuilt } = makeTrustedService(tmp);
    assert.equal(rebuilt.isTrustedForExecution(dir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isTrustedForExecution：trust 持久写入 pi store，重建服务仍放行；reject 不放行', () => {
  const tmp = makeTempDir();
  try {
    const { service, getDecision } = makeTrustedService(tmp);
    const dirTrust = makeProjectDir(tmp, 'proj-exec-trust');
    const dirReject = makeProjectDir(tmp, 'proj-exec-reject');
    makePiResource(dirTrust);
    makePiResource(dirReject);
    assert.ok(service.addProject(dirTrust).ok);
    assert.ok(service.addProject(dirReject).ok);

    // trust：放行 + pi store true（持久）
    assert.ok(!service.openProject(dirTrust).ok);
    assert.ok(service.setTrust(dirTrust, 'trust').ok);
    assert.equal(service.isTrustedForExecution(dirTrust), true);
    assert.equal(getDecision(dirTrust), true);

    // reject：不放行 + pi store false
    assert.ok(!service.openProject(dirReject).ok);
    assert.ok(service.setTrust(dirReject, 'reject').ok);
    assert.equal(service.isTrustedForExecution(dirReject), false);
    assert.equal(getDecision(dirReject), false);

    // 重建服务：trust 的持久决策仍放行
    const { service: rebuilt } = makeTrustedService(tmp);
    assert.equal(rebuilt.isTrustedForExecution(dirTrust), true);
    assert.equal(rebuilt.isTrustedForExecution(dirReject), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('isTrustedForExecution：未注入信任端口的旧场景一律不放行（保守默认）', () => {
  const tmp = makeTempDir();
  try {
    const { service } = makeService(tmp);
    const dir = makeProjectDir(tmp, 'proj-noport');
    makePiResource(dir);
    assert.ok(service.addProject(dir).ok);
    assert.equal(service.isTrustedForExecution(dir), false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
