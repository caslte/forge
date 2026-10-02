/**
 * 模块 12 · FileApi（RPC 方法层）单元测试。
 *
 * 与 FileService 测试的分工：服务层测「安全规则本身对不对」，本层测「错误码有没有
 * 正确穿透到信封里」——渲染进程就是按 code 分支的（6101 弹参数错、6102 提示项目没了、
 * 6103 当安全事件、6104 把标签页标记失效），映射错了 UI 会静默出错。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createFileApi, type FileApiDeps } from '../../src/rpc/fileMethods.ts';
import { FileService, FILE_ERROR } from '../../src/file/fileService.ts';

function makeProject(): { root: string; cleanup: () => void } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-filem-')));
  return { root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function api(registered: (p: string) => boolean = () => true): FileApiDeps {
  return { isProjectRegistered: registered };
}

/** 快捷：取 data，非成功时断言并抛 */
function data(result: { code: number; data: unknown }): never | Record<string, unknown> {
  assert.equal(result.code, 0, `期望成功信封，实得 code=${result.code}`);
  assert.notEqual(result.data, null);
  return result.data as Record<string, unknown>;
}

test('file/listDir：成功信封 + 目录优先排序', () => {
  const { root, cleanup } = makeProject();
  try {
    fs.mkdirSync(path.join(root, 'src'));
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    const a = createFileApi(api());
    const r = a.methods['file/listDir']!({ path: root }) as { code: number; data: unknown };
    const d = data(r) as { relPath: string; nodes: { kind: string; name: string }[] };
    assert.equal(d.relPath, '');
    assert.deepEqual(d.nodes.map((n) => `${n.kind}:${n.name}`), ['dir:src', 'file:a.ts']);
  } finally {
    cleanup();
  }
});

test('file/listDir：relPath 缺省视为项目根（空串是合法值，不当参数错）', () => {
  const { root, cleanup } = makeProject();
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    const a = createFileApi(api());
    for (const params of [{ path: root }, { path: root, relPath: '' }, { path: root, relPath: undefined }]) {
      const r = a.methods['file/listDir']!(params) as { code: number };
      assert.equal(r.code, 0, `params=${JSON.stringify(params)} 应成功`);
    }
  } finally {
    cleanup();
  }
});

test('file/*：path 缺失/空白/非字符串 → 6101', () => {
  const a = createFileApi(api());
  for (const bad of [undefined, {}, { path: '' }, { path: '   ' }, { path: 123 }]) {
    const r = a.methods['file/listDir']!(bad) as { code: number };
    assert.equal(r.code, FILE_ERROR.INVALID_PARAMS, `params=${JSON.stringify(bad)} 应 6101`);
  }
});

test('file/readFile：relPath 缺失或空白 → 6101（不给「读项目根」留口子）', () => {
  const { root, cleanup } = makeProject();
  try {
    const a = createFileApi(api());
    for (const bad of [{ path: root }, { path: root, relPath: '' }, { path: root, relPath: '  ' }]) {
      const r = a.methods['file/readFile']!(bad) as { code: number };
      assert.equal(r.code, FILE_ERROR.INVALID_PARAMS, `params=${JSON.stringify(bad)} 应 6101`);
    }
  } finally {
    cleanup();
  }
});

test('file/readFile：成功信封含 relPath/name/content/lineCount', () => {
  const { root, cleanup } = makeProject();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'a.ts'), 'x\ny\n');
    const a = createFileApi(api());
    const r = a.methods['file/readFile']!({ path: root, relPath: 'src/a.ts' }) as { code: number; data: unknown };
    const d = data(r) as { relPath: string; name: string; content: string; lineCount: number; binary: boolean };
    assert.equal(d.relPath, 'src/a.ts');
    assert.equal(d.name, 'a.ts');
    assert.equal(d.content, 'x\ny\n');
    assert.equal(d.lineCount, 2);
    assert.equal(d.binary, false);
  } finally {
    cleanup();
  }
});

test('越界错误码 6103 穿透到信封（UI 依赖它区分安全事件与普通 404）', () => {
  const { root, cleanup } = makeProject();
  try {
    const a = createFileApi(api());
    for (const method of ['file/listDir', 'file/readFile'] as const) {
      const r = a.methods[method]!({ path: root, relPath: '../../../etc/passwd' }) as { code: number; data: unknown };
      assert.equal(r.code, FILE_ERROR.PATH_ESCAPE, `${method} 应返回 6103`);
      assert.equal(r.data, null, '失败信封 data 恒为 null，不得泄漏任何内容');
    }
  } finally {
    cleanup();
  }
});

test('项目未注册 → 6102（三个方法一致）', () => {
  const { root, cleanup } = makeProject();
  try {
    fs.writeFileSync(path.join(root, 'a.ts'), 'a');
    const a = createFileApi(api(() => false));
    const cases: [string, Record<string, unknown>][] = [
      ['file/listDir', { path: root }],
      ['file/readFile', { path: root, relPath: 'a.ts' }],
      ['file/searchFiles', { path: root, query: 'a' }],
    ];
    for (const [method, params] of cases) {
      const r = a.methods[method]!(params) as { code: number };
      assert.equal(r.code, FILE_ERROR.PROJECT_NOT_FOUND, `${method} 应返回 6102`);
    }
  } finally {
    cleanup();
  }
});

test('file/searchFiles：query 缺失 → 6101（不扫盘）', () => {
  const { root, cleanup } = makeProject();
  try {
    const a = createFileApi(api());
    for (const bad of [{ path: root }, { path: root, query: '' }, { path: root, query: '  ' }]) {
      const r = a.methods['file/searchFiles']!(bad) as { code: number };
      assert.equal(r.code, FILE_ERROR.INVALID_PARAMS);
    }
  } finally {
    cleanup();
  }
});

test('file/searchFiles：成功信封含 files 与 limitReached', () => {
  const { root, cleanup } = makeProject();
  try {
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'App.vue'), '');
    const a = createFileApi(api());
    const r = a.methods['file/searchFiles']!({ path: root, query: 'app' }) as { code: number; data: unknown };
    const d = data(r) as { files: string[]; limitReached: boolean };
    assert.deepEqual(d.files, ['src/App.vue']);
    assert.equal(d.limitReached, false);
  } finally {
    cleanup();
  }
});

test('服务层意外抛错被隔离为 5000，且不泄漏异常细节', () => {
  const boom = () => {
    throw new Error('secret internal path /Users/someone/.ssh/id_rsa');
  };
  const a = createFileApi({ isProjectRegistered: () => true, fileService: { listDir: boom, readFile: boom, searchFiles: boom } as unknown as FileService });
  const r = a.methods['file/listDir']!({ path: '/any' }) as { code: number; message: string };
  assert.equal(r.code, 5000);
  assert.equal(r.message, 'internal error');
  assert.ok(!r.message.includes('id_rsa'));
});

test('注入替身：RpcResult 映射层不吞 FileResult 的 ok 分支', () => {
  const a = createFileApi({
    isProjectRegistered: () => true,
    fileService: { listDir: () => ({ ok: true, data: { relPath: 'x', nodes: [], hidden: 7 } }) } as unknown as FileService,
  });
  const r = a.methods['file/listDir']!({ path: '/any' }) as { code: number; data: unknown };
  assert.equal(r.code, 0);
  assert.deepEqual(r.data, { relPath: 'x', nodes: [], hidden: 7 });
});
