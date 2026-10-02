/**
 * 模块 12 · OpenFileWatcher 单元测试（代码浏览器「磁盘变更自动刷新」的核心逻辑）。
 *
 * 被测对象是**纯管理逻辑**：目录级 watch 的去重与增减、事件按已打开文件过滤、
 * 防抖、容错。fs.watch 本身用注入的 fake 替代——要测的是「我们怎么用它」，
 * 不是「fs.watch 能不能工作」。
 *
 * 设计约束（对应 PRD 模块 12 的自动刷新）：
 * - 监听粒度是**父目录**而非文件本身：编辑器保存常用「临时文件 + 原子替换」，
 *   文件级 watcher 会在替换时失效，目录级能扛住。
 * - 同一目录多个打开文件只建一个 watcher（大仓库打开半层目录时不打满句柄）。
 * - 事件只在「当前已打开集合」内的 relPath 上回调；关掉就静默。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { OpenFileWatcher, type DirEventSink } from '../../src/file/watcher.ts';

/** fake fs.watch：记录 (dir → sink)，测试手动触发事件 */
function makeFakeWatch() {
  const sinks = new Map<string, DirEventSink>();
  const unwatched: string[] = [];
  const watchDir = (dir: string, sink: DirEventSink): (() => void) => {
    sinks.set(dir, sink);
    return () => {
      sinks.delete(dir);
      unwatched.push(dir);
    };
  };
  const emit = (dir: string, filename: string | null) => sinks.get(dir)?.(filename);
  return { sinks, unwatched, watchDir, emit };
}

/** 收集回调的小工具 */
function collector() {
  const got: string[] = [];
  return { got, onFileChanged: (p: string, r: string) => got.push(`${p}|${r}`) };
}

const entry = (projectPath: string, relPath: string, abs: string) => ({ projectPath, relPath, abs });

const DEBOUNCE_MS = 20;
const WAIT = 60;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('同一目录的两个打开文件只建一个目录 watcher；事件按文件名分发到对应 relPath', async () => {
  const fw = makeFakeWatch();
  const c = collector();
  const w = new OpenFileWatcher({ ...fw, ...c, debounceMs: DEBOUNCE_MS });
  const root = 'D:\\proj';
  w.sync([
    entry(root, 'src/a.ts', 'D:\\proj\\src\\a.ts'),
    entry(root, 'src/b.ts', 'D:\\proj\\src\\b.ts'),
  ]);
  assert.equal(fw.sinks.size, 1, '同目录必须去重');
  assert.ok(fw.sinks.has('D:\\proj\\src'));

  fw.emit('D:\\proj\\src', 'b.ts');
  await sleep(WAIT);
  assert.deepEqual(c.got, [`${root}|src/b.ts`], '只回调被改的那个文件，且给回 POSIX relPath');
  w.dispose();
});

test('不同目录各建各的 watcher；未打开文件的事件被过滤', async () => {
  const fw = makeFakeWatch();
  const c = collector();
  const w = new OpenFileWatcher({ ...fw, ...c, debounceMs: DEBOUNCE_MS });
  w.sync([
    entry('D:\\proj', 'src/a.ts', 'D:\\proj\\src\\a.ts'),
    entry('D:\\proj', 'README.md', 'D:\\proj\\README.md'),
  ]);
  assert.equal(fw.sinks.size, 2);

  fw.emit('D:\\proj\\src', 'not-open.ts'); // 同目录但没打开
  fw.emit('D:\\proj\\src', null); // 目录级事件（无文件名）
  fw.emit('D:\\proj', 'some-dir'); // 目录名，不是打开的文件
  await sleep(WAIT);
  assert.deepEqual(c.got, [], '非打开文件的事件必须全部被过滤');
  w.dispose();
});

test('防抖：同一文件短时间多次变化只回调一次', async () => {
  const fw = makeFakeWatch();
  const c = collector();
  const w = new OpenFileWatcher({ ...fw, ...c, debounceMs: DEBOUNCE_MS });
  w.sync([entry('D:\\proj', 'a.ts', 'D:\\proj\\a.ts')]);
  fw.emit('D:\\proj', 'a.ts');
  fw.emit('D:\\proj', 'a.ts');
  fw.emit('D:\\proj', 'a.ts');
  await sleep(WAIT);
  assert.equal(c.got.length, 1, '编辑器一次保存常触发多轮事件，只该刷一次');
  w.dispose();
});

test('sync 移除后：其变化不再回调，对应目录 watcher 被关闭', async () => {
  const fw = makeFakeWatch();
  const c = collector();
  const w = new OpenFileWatcher({ ...fw, ...c, debounceMs: DEBOUNCE_MS });
  w.sync([
    entry('D:\\proj', 'src/a.ts', 'D:\\proj\\src\\a.ts'),
    entry('D:\\proj', 'src/deep/b.ts', 'D:\\proj\\src\\deep\\b.ts'),
  ]);
  w.sync([entry('D:\\proj', 'src/a.ts', 'D:\\proj\\src\\a.ts')]); // b 关掉了

  fw.emit('D:\\proj\\src\\deep', 'b.ts');
  await sleep(WAIT);
  assert.deepEqual(c.got, [], '已关闭文件不再触发刷新');
  assert.ok(fw.unwatched.includes('D:\\proj\\src\\deep'), '空了的目录 watcher 要关闭');
  w.dispose();
});

test('watch 的目录不存在（打开后又被删）→ 不抛错，其余目录照常工作', async () => {
  const watchDir = (dir: string, _sink: DirEventSink): (() => void) => {
    if (dir === 'D:\\gone') throw new Error('ENOENT');
    return () => {};
  };
  const c = collector();
  const w = new OpenFileWatcher({ watchDir, ...c, debounceMs: DEBOUNCE_MS });
  assert.doesNotThrow(() => {
    w.sync([
      entry('D:\\gone', 'x.ts', 'D:\\gone\\x.ts'),
      entry('D:\\proj', 'a.ts', 'D:\\proj\\a.ts'),
    ]);
  });
  w.sync([entry('D:\\proj', 'a.ts', 'D:\\proj\\a.ts')]);
  w.dispose();
});

test('dispose 关闭全部 watcher，此后事件不再回调', async () => {
  const fw = makeFakeWatch();
  const c = collector();
  const w = new OpenFileWatcher({ ...fw, ...c, debounceMs: DEBOUNCE_MS });
  w.sync([entry('D:\\proj', 'a.ts', 'D:\\proj\\a.ts')]);
  w.dispose();
  assert.equal(fw.sinks.size, 0);
  fw.emit('D:\\proj', 'a.ts');
  await sleep(WAIT);
  assert.deepEqual(c.got, []);
});

test('同一 relPath 变更在防抖窗口跨过前不重复；窗口过后再次变化能再次回调', async () => {
  const fw = makeFakeWatch();
  const c = collector();
  const w = new OpenFileWatcher({ ...fw, ...c, debounceMs: DEBOUNCE_MS });
  w.sync([entry('D:\\proj', 'a.ts', 'D:\\proj\\a.ts')]);
  fw.emit('D:\\proj', 'a.ts');
  await sleep(WAIT);
  fw.emit('D:\\proj', 'a.ts');
  await sleep(WAIT);
  assert.equal(c.got.length, 2, '两次独立修改要刷新两次（防抖只在窗口内合并）');
  w.dispose();
});
