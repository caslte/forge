/**
 * 「用浏览器打开」目标校验（shell/openTarget.ts）单测。
 *
 * 这条通道是 CV-TRUST-02（渲染层不得把任意字符串交给系统「打开」）在**放行文件**一侧的
 * 收窄版本，所以用例重点不在「html 能开」，而在**该拒的都拒掉**：
 * 可执行文件 / 协议关联 / 目录 / 软链 / 不存在 / 非字符串入参，一律 null。
 * 软链一档是刻意用 lstat 而非 stat 的原因（指向 .exe 的 x.html 软链必须被拒）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BROWSER_OPENABLE_EXT,
  hasBrowserOpenableExt,
  resolveBrowserOpenTarget,
} from '../../src/shell/openTarget.ts';

/** 建临时沙箱，返回 { dir, cleanup }；文件清单在用例内写 */
function makeSandbox(): { dir: string; write: (name: string, content?: string) => string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-openbrowser-test-'));
  return {
    dir,
    write(name, content = 'x') {
      const p = path.join(dir, name);
      fs.writeFileSync(p, content);
      return p;
    },
    cleanup() {
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('白名单只收 .html/.htm，且大小写不敏感', () => {
  assert.deepEqual([...BROWSER_OPENABLE_EXT], ['.html', '.htm']);
  assert.equal(hasBrowserOpenableExt('/a/b/page.html'), true);
  assert.equal(hasBrowserOpenableExt('/a/b/PAGE.HTM'), true);
  assert.equal(hasBrowserOpenableExt('/a/b/page.HtMl'), true);
  // 无扩展名 / 多点 / 相邻后缀都不是白名单成员
  assert.equal(hasBrowserOpenableExt('/a/b/page'), false);
  assert.equal(hasBrowserOpenableExt('/a/b/page.htmlx'), false);
  assert.equal(hasBrowserOpenableExt('/a/b/page.xhtml'), false);
  assert.equal(hasBrowserOpenableExt('/a/b/.html'), false, '点文件本身不是 html 文档');
  assert.equal(hasBrowserOpenableExt('/a/b/a.html.txt'), false);
});

test('存在的普通 html 文件：放行并返回词法归一后的路径', () => {
  const box = makeSandbox();
  try {
    const p = box.write('page.html', '<h1>hi</h1>');
    assert.equal(resolveBrowserOpenTarget(p), p);
    // ./ 与 ../ 中间段折叠：渲染层拼接的路径可能带这些段，ShellExecuteEx 不归一会弹「找不到文件」
    assert.equal(resolveBrowserOpenTarget(path.join(box.dir, '.', 'page.html')), p);
    assert.equal(resolveBrowserOpenTarget(path.join(box.dir, 'sub', '..', 'page.html')), p);
  } finally {
    box.cleanup();
  }
});

test('非字符串 / 空串 / 空白串：null', () => {
  assert.equal(resolveBrowserOpenTarget(undefined), null);
  assert.equal(resolveBrowserOpenTarget(null), null);
  assert.equal(resolveBrowserOpenTarget(42), null);
  assert.equal(resolveBrowserOpenTarget({ path: 'a.html' }), null);
  assert.equal(resolveBrowserOpenTarget(''), null);
  assert.equal(resolveBrowserOpenTarget('   '), null);
});

test('非白名单扩展名：即使文件真实存在也拒（.exe / .bat / .lnk / .js / .url / .md）', () => {
  const box = makeSandbox();
  try {
    for (const name of ['evil.exe', 'run.bat', 'x.lnk', 'hook.js', 'x.url', 'readme.md']) {
      const p = box.write(name);
      assert.equal(resolveBrowserOpenTarget(p), null, `${name} 必须被拒`);
    }
  } finally {
    box.cleanup();
  }
});

test('目录：拒（.html 后缀的目录也不能开）', () => {
  const box = makeSandbox();
  try {
    fs.mkdirSync(path.join(box.dir, 'site.html'));
    assert.equal(resolveBrowserOpenTarget(path.join(box.dir, 'site.html')), null);
    assert.equal(resolveBrowserOpenTarget(box.dir), null);
  } finally {
    box.cleanup();
  }
});

test('软链：一律拒（lstat 不跟随 —— x.html → evil.exe 不得绕过扩展名白名单）', (t) => {
  const box = makeSandbox();
  // Windows 上非管理员建软链需特权，跳过而不让用例红；生产判定逻辑不依赖软链能否创建
  let linkMade = false;
  try {
    const target = box.write('evil.exe', 'MZ');
    const link = path.join(box.dir, 'page.html');
    try {
      fs.symlinkSync(target, link, 'file');
      linkMade = true;
    } catch {
      t.skip('本机无创建软链权限（Windows 需开发者模式/管理员）');
    }
    if (linkMade) assert.equal(resolveBrowserOpenTarget(link), null);
  } finally {
    box.cleanup();
  }
});

test('不存在的路径 / 路径含非法字符：null（不抛错，失败原因不透给渲染层）', () => {
  const box = makeSandbox();
  try {
    assert.equal(resolveBrowserOpenTarget(path.join(box.dir, 'nope.html')), null);
    assert.equal(resolveBrowserOpenTarget(path.join(box.dir, 'a\u0000b.html')), null);
  } finally {
    box.cleanup();
  }
});
