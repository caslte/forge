/**
 * consoleHidePreload 单测（Windows 控制台弹窗治理，孙进程层）：
 * - ensureConsoleHidePreload：win32 落盘 + 内容一致幂等 + mkdir 兜底
 * - buildPiCliArgv：--require 前置注入 / null 透传
 * - 预加载包装逻辑：vm 沙箱内以 stub child_process 求值脚本源，逐一验证
 *   spawn/spawnSync 各参数形态下的 windowsHide 注入（不依赖真实进程派生——
 *   某些受管环境会拦截子进程派生报 EBUSY，执行式冒烟在该环境不可测）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import {
  CONSOLE_HIDE_PRELOAD_NAME,
  buildConsoleHidePreloadSource,
  buildPiCliArgv,
  ensureConsoleHidePreload,
} from '../../src/pi/consoleHidePreload.ts';

/** 建临时 agent 目录（其父目录即预加载落盘点，模拟 <userData>/agent 结构） */
function makeAgentDir(): string {
  const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-console-hide-'));
  const agentDir = path.join(userData, 'agent');
  fs.mkdirSync(agentDir, { recursive: true });
  return agentDir;
}

interface RecordedCall {
  args: unknown[];
}

/** 建可记录调用的 stub child_process，在 vm 沙箱里求值预加载源并返回包装后的 cp */
function evalPreload(platform: string): {
  cp: { spawn: (this: unknown, ...a: unknown[]) => unknown; spawnSync: (this: unknown, ...a: unknown[]) => unknown };
  calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const record = (...args: unknown[]): RecordedCall => {
    const call = { args };
    calls.push(call);
    return call;
  };
  const cp = {
    spawn: function (this: unknown, ...a: unknown[]) {
      return record(this, ...a);
    },
    spawnSync: function (this: unknown, ...a: unknown[]) {
      return record(this, ...a);
    },
  };
  const sandbox = {
    require: (specifier: string) => {
      assert.equal(specifier, 'node:child_process');
      return cp;
    },
    process: { platform },
  };
  vm.runInNewContext(buildConsoleHidePreloadSource(), sandbox);
  return { cp, calls };
}

function lastCall(calls: RecordedCall[]): unknown {
  assert.ok(calls.length > 0, '包装函数应已调用底层 spawn');
  // vm 沙箱内创建的对象原型与测试进程不同 realm，JSON 归一化后再比较
  return JSON.parse(JSON.stringify(calls[calls.length - 1]!.args.slice(1)));
}

test('预加载（win32）：spawn(file) 无参形态注入 {windowsHide:true}', () => {
  const { cp, calls } = evalPreload('win32');
  cp.spawn('cmd');
  assert.deepEqual(lastCall(calls), ['cmd', { windowsHide: true }]);
});

test('预加载（win32）：spawn(file, options) 合并注入、显式 windowsHide 不覆盖', () => {
  const { cp, calls } = evalPreload('win32');
  cp.spawn('cmd', { cwd: 'C:\\x' });
  assert.deepEqual(lastCall(calls), ['cmd', { cwd: 'C:\\x', windowsHide: true }]);
  cp.spawn('cmd', { windowsHide: false });
  assert.deepEqual(lastCall(calls), ['cmd', { windowsHide: false }]); // 显式值尊重
});

test('预加载（win32）：spawn(file, args) 与 spawn(file, args, options) 注入第三参', () => {
  const { cp, calls } = evalPreload('win32');
  cp.spawn('cmd', ['/c', 'echo', 'ok']);
  assert.deepEqual(lastCall(calls), ['cmd', ['/c', 'echo', 'ok'], { windowsHide: true }]);
  cp.spawn('cmd', ['/c'], { timeout: 5 });
  assert.deepEqual(lastCall(calls), ['cmd', ['/c'], { timeout: 5, windowsHide: true }]);
  cp.spawn('cmd', ['/c'], { timeout: 5, windowsHide: true });
  assert.deepEqual(lastCall(calls), ['cmd', ['/c'], { timeout: 5, windowsHide: true }]);
});

test('预加载（win32）：spawnSync 与 spawn 同构注入', () => {
  const { cp, calls } = evalPreload('win32');
  cp.spawnSync('npm', ['install', 'x'], { encoding: 'utf-8' });
  assert.deepEqual(lastCall(calls), ['npm', ['install', 'x'], { encoding: 'utf-8', windowsHide: true }]);
});

test('预加载（非 win32）：不包装、原样透传', () => {
  const { cp, calls } = evalPreload('linux');
  cp.spawn('cmd', ['/c']);
  assert.deepEqual(lastCall(calls), ['cmd', ['/c']]); // 原参数原样
});

test('ensureConsoleHidePreload：非 win32 返回 null（不落盘不注入）', () => {
  if (process.platform === 'win32') return; // 本平台无法模拟其他系统，跳过
  const agentDir = makeAgentDir();
  assert.equal(ensureConsoleHidePreload(agentDir), null);
});

if (process.platform === 'win32') {
  test('ensureConsoleHidePreload：写入 userData 根（agentDir 父目录），内容与生成源一致', () => {
    const agentDir = makeAgentDir();
    const file = ensureConsoleHidePreload(agentDir);
    assert.ok(file !== null);
    assert.equal(path.dirname(file), path.dirname(agentDir));
    assert.equal(path.basename(file), CONSOLE_HIDE_PRELOAD_NAME);
    assert.equal(fs.readFileSync(file!, 'utf8'), buildConsoleHidePreloadSource());
  });

  test('ensureConsoleHidePreload：幂等——重复调用同路径，内容不符时重写', () => {
    const agentDir = makeAgentDir();
    const first = ensureConsoleHidePreload(agentDir);
    assert.equal(ensureConsoleHidePreload(agentDir), first);
    assert.ok(first !== null);
    fs.writeFileSync(first!, 'tampered', 'utf8');
    assert.equal(ensureConsoleHidePreload(agentDir), first); // 同路径
    assert.equal(fs.readFileSync(first!, 'utf8'), buildConsoleHidePreloadSource()); // 已重写
  });

  test('ensureConsoleHidePreload：agentDir 不存在时也能落盘（mkdir 兜底）', () => {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-console-hide-'));
    const agentDir = path.join(userData, 'agent'); // 故意不建目录
    const file = ensureConsoleHidePreload(agentDir);
    assert.ok(file !== null);
    assert.ok(fs.existsSync(file!));
  });
}

test('buildPiCliArgv：preload 存在时前置 --require，null 时原样透传', () => {
  assert.deepEqual(buildPiCliArgv('cli.js', ['install', 'npm:x'], null), ['cli.js', 'install', 'npm:x']);
  assert.deepEqual(buildPiCliArgv('cli.js', ['update', '--extensions'], 'C:\\p\\preload.cjs'), [
    '--require',
    'C:\\p\\preload.cjs',
    'cli.js',
    'update',
    '--extensions',
  ]);
});
