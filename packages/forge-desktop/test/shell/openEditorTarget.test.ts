/**
 * 「用外部编辑器打开」目标校验与编辑器解析（shell/openEditorTarget.ts）单测。
 *
 * 这条通道会**启动一个外部程序**，比 openInBrowser 更危险，所以用例重点全在「该拒的拒掉」：
 * 非字符串 / 空串 / 目录 / 软链 / 不存在 / **基名以 `-` 开头**（CLI 参数注入），一律 null。
 * 正向只验「任意文本文件都放行」——不设扩展名白名单是这条通道与 openInBrowser 的本质差别。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveEditorOpenTarget,
} from '../../src/shell/openEditorTarget.ts';

function makeSandbox(): {
  dir: string;
  write: (name: string, content?: string) => string;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-openeditor-test-'));
  return {
    dir,
    write(name, content = 'x') {
      const p = path.join(dir, name);
      // 允许用例直接写 'sub/a.ts'（沙箱自己建中间目录）
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
      return p;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('任意文本文件都放行（不设扩展名白名单，与 openInBrowser 的本质差别）', () => {
  const s = makeSandbox();
  try {
    for (const name of ['a.ts', 'b.vue', 'c.md', 'd', 'e.min.js', 'f.py']) {
      assert.equal(resolveEditorOpenTarget(s.write(name)), path.join(s.dir, name));
    }
  } finally {
    s.cleanup();
  }
});

test('非字符串 / 空串 / 空白一律 null', () => {
  for (const bad of [undefined, null, 42, {}, [], true, '', '   ']) {
    assert.equal(resolveEditorOpenTarget(bad), null);
  }
});

test('目录不是文件 → null', () => {
  const s = makeSandbox();
  try {
    fs.mkdirSync(path.join(s.dir, 'sub'));
    assert.equal(resolveEditorOpenTarget(path.join(s.dir, 'sub')), null);
  } finally {
    s.cleanup();
  }
});

test('不存在 / 非法字符 → null', () => {
  const s = makeSandbox();
  try {
    assert.equal(resolveEditorOpenTarget(path.join(s.dir, 'nope.ts')), null);
    assert.equal(resolveEditorOpenTarget(`${s.dir}/\0bad.ts`), null);
  } finally {
    s.cleanup();
  }
});

test('词法归一：./ 与 .. 中间段被折叠（与 openPath / openInBrowser 同款前置）', () => {
  const s = makeSandbox();
  try {
    fs.mkdirSync(path.join(s.dir, 'src'));
    const real = s.write('src/./deep.ts');
    assert.equal(resolveEditorOpenTarget(path.join(s.dir, 'src', '.', 'deep.ts')), real);
    assert.equal(
      resolveEditorOpenTarget(path.join(s.dir, 'src', 'sub', '..', 'deep.ts')),
      real,
    );
  } finally {
    s.cleanup();
  }
});

test('软链 → null（lstat 不跟随，解析编辑器不该成为软链逃逸跳板）', (t) => {
  const s = makeSandbox();
  try {
    const target = s.write('real.ts');
    const link = path.join(s.dir, 'link.ts');
    try {
      fs.symlinkSync(target, link, 'file');
    } catch {
      // Windows 未开启开发者模式时无创建软链权限
      t.skip('本机无法创建软链（需管理员或开发者模式）');
      return;
    }
    assert.equal(resolveEditorOpenTarget(link), null);
  } finally {
    s.cleanup();
  }
});

test('基名以 - 开头 → null（CLI 参数注入：--user-data-dir / -psn_0_…）', () => {
  const s = makeSandbox();
  try {
    for (const name of ['-psn_0_12345.ts', '--user-data-dir.ts', '---.ts']) {
      assert.equal(resolveEditorOpenTarget(s.write(name)), null, name);
    }
    // 同目录下名字里含 - 但不以 - 开头的必须照常放行，别把规则写太宽
    assert.equal(resolveEditorOpenTarget(s.write('a-b-c.ts')), path.join(s.dir, 'a-b-c.ts'));
    assert.equal(resolveEditorOpenTarget(s.write('-dir/a.ts')), path.join(s.dir, '-dir', 'a.ts'));
  } finally {
    s.cleanup();
  }
});

/* 编辑器解析（原 resolveEditorCommand 的用例）已随扫描逻辑迁往 editorScan.test.ts：
 * 单一「PATH 顺序取第一个」升级为逐编辑器解析真实 .exe，行为契约整体变化。 */
