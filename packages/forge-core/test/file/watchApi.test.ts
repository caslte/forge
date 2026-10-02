/**
 * FileApi「file/watchSync」方法层测试：参数校验、越界/失效条目剔除、事件发射。
 * 目录监听用 fake 工厂（手动触发），只测本层 glue——watcher 内部逻辑在 watcher.test.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FileApi, FILE_WATCH_DEBOUNCE_MS } from '../../src/rpc/fileMethods.ts';
import type { DirEventSink } from '../../src/file/watcher.ts';

function makeProject(): { root: string; write: (rel: string, content: string) => void; cleanup: () => void } {
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'forge-watchapi-')));
  return {
    root,
    write: (rel, content) => {
      const p = path.join(root, rel);
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('watchSync：默认防抖 300ms（编辑器一次保存合并为一轮刷新）', () => {
  assert.equal(FILE_WATCH_DEBOUNCE_MS, 300);
});

test('watchSync：打开的文件变化 → 经事件汇发 code.fileChanged', async () => {
  const proj = makeProject();
  try {
    proj.write('a.ts', 'v1');
    const emitted: Array<{ event: string; payload: unknown }> = [];
    const sinks = new Map<string, DirEventSink>();
    const api = new FileApi({
      isProjectRegistered: () => true,
      events: { emit: (event: string, payload: unknown) => emitted.push({ event, payload }) },
      watchDirFactory: (dir, sink) => {
        sinks.set(dir, sink);
        return () => sinks.delete(dir);
      },
      watchDebounceMs: 10,
    });
    const r = api.methods['file/watchSync']({ path: proj.root, relPaths: ['a.ts'] });
    assert.equal(r.code, 0);
    sinks.get(proj.root)!('a.ts');
    await new Promise((res) => setTimeout(res, 60));
    assert.deepEqual(emitted, [
      { event: 'code.fileChanged', payload: { projectPath: proj.root, relPath: 'a.ts' } },
    ]);
  } finally {
    proj.cleanup();
  }
});

test('watchSync：越界与不存在的 relPath 被静默剔除，不建 watcher', async () => {
  const proj = makeProject();
  try {
    proj.write('a.ts', 'v1');
    const sinks = new Map<string, DirEventSink>();
    const api = new FileApi({
      isProjectRegistered: () => true,
      watchDirFactory: (dir, sink) => {
        sinks.set(dir, sink);
        return () => sinks.delete(dir);
      },
      watchDebounceMs: 10,
    });
    const r = api.methods['file/watchSync']({
      path: proj.root,
      relPaths: ['a.ts', '../escape.ts', 'missing.ts', 'C:/abs.ts'],
    });
    assert.equal(r.code, 0);
    assert.deepEqual([...sinks.keys()], [proj.root], '只有真实存在的打开文件进了监听');
  } finally {
    proj.cleanup();
  }
});

test('watchSync：参数错误（relPaths 非数组 / path 缺失）→ 6101', () => {
  const proj = makeProject();
  try {
    const api = new FileApi({ isProjectRegistered: () => true });
    assert.equal(api.methods['file/watchSync']({ path: proj.root, relPaths: 'a.ts' }).code, 6101);
    assert.equal(api.methods['file/watchSync']({ relPaths: [] }).code, 6101);
    assert.equal(api.methods['file/watchSync']({ path: proj.root, relPaths: [42] }).code, 6101);
  } finally {
    proj.cleanup();
  }
});
