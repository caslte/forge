/**
 * 内嵌终端 pty 服务（模块 10，term/* RPC）单元测试（docs/prd/10_embedded_terminal.md）。
 *
 * 覆盖口径：
 * - TM-F03 安全：cwd containment（AC-10-06 伪造/未注册/不存在目录一律 1002）；
 *   spawn 固定注入的 shell 路径 + 归一后的真实 cwd，渲染层无路径注入面
 * - F04 数据流：onData → term:data、onExit → term:exit 按 ptyId 路由；
 *   写已退出/未知 pty 静默丢弃返回 0；resize 透传
 * - TM-S04 生命周期：kill 幂等、killAll 全量回收
 *
 * node-pty 经 spawnPty 注入 fake，不触碰原生模块。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { normalizeProjectPath, type RpcResult } from '@forge/core';
import {
  collectInstalledShells,
  createTermService,
  resolveShellByPref,
  resolveSystemShell,
  shellSpawnArgs,
  windowsShellCandidates,
  type PtyLike,
  type PtySpawnOptions,
  type TermDataPayload,
  type TermExitPayload,
  type TerminalShellId,
} from '../../src/term/ptyService.ts';

class FakePty implements PtyLike {
  readonly pid = 4321;
  writes: string[] = [];
  sizes: Array<[number, number]> = [];
  kills = 0;
  private dataCb: ((d: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.sizes.push([cols, rows]);
  }
  kill(): void {
    this.kills += 1;
    // 与真实 pty 一致：kill 触发 onExit（exitCode 0）
    this.exitCb?.({ exitCode: 0 });
  }
  onData(listener: (d: string) => void): void {
    this.dataCb = listener;
  }
  onExit(listener: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = listener;
  }
  /** 测试驱动：模拟 shell 输出一段 */
  emitData(d: string): void {
    this.dataCb?.(d);
  }
}

interface Harness {
  events: Array<{ event: 'term:data'; payload: TermDataPayload } | { event: 'term:exit'; payload: TermExitPayload }>;
  spawned: FakePty[];
  spawnCalls: Array<{ file: string; args: string[]; options: PtySpawnOptions }>;
  logs: string[];
  methods: Record<string, (params: unknown) => Promise<RpcResult>>;
  killAll: () => void;
  projectDir: string; // realpath 归一后的可注册项目根
}

function makeHarness(
  opts: {
    registerProject?: boolean;
    resolveShellByPref?: (pref: TerminalShellId) => string | null;
  } = {},
): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-term-test-'));
  const projectDir = normalizeProjectPath(dir);
  const registered = opts.registerProject !== false;
  const spawned: FakePty[] = [];
  const spawnCalls: Array<{ file: string; args: string[]; options: PtySpawnOptions }> = [];
  const events: Harness['events'] = [];
  const logs: string[] = [];
  const svc = createTermService({
    isKnownProjectPath: (p) => registered && p === projectDir,
    emit: (event, payload) => {
      events.push({ event, payload } as Harness['events'][number]);
    },
    spawnPty: (file, args, options) => {
      spawnCalls.push({ file, args, options });
      const pty = new FakePty();
      spawned.push(pty);
      return pty;
    },
    resolveShell: () => 'C:\\fake\\shell.exe',
    resolveShellByPref: opts.resolveShellByPref,
    logger: (line) => logs.push(line),
  });
  return { events, spawned, spawnCalls, logs, methods: svc.methods, killAll: svc.killAll, projectDir };
}

test('term/create：成功 spawn 固定 shell + 归一 cwd，返回 ptyId/shell/pid', async () => {
  const h = makeHarness();
  const res = await h.methods['term/create']!({ cwd: h.projectDir, cols: 120, rows: 30 });
  assert.equal(res.code, 0);
  const data = res.data as { ptyId: string; shell: string; pid: number };
  assert.ok(data.ptyId.length > 0);
  assert.equal(data.shell, 'C:\\fake\\shell.exe');
  assert.equal(data.pid, 4321);
  assert.equal(h.spawnCalls.length, 1);
  const call = h.spawnCalls[0]!;
  assert.equal(call.file, 'C:\\fake\\shell.exe');
  assert.deepEqual(call.args, []);
  assert.equal(call.options.cwd, h.projectDir);
  assert.equal(call.options.cols, 120);
  assert.equal(call.options.rows, 30);
  assert.equal(call.options.name, 'xterm-256color');
  assert.equal(call.options.env.TERM, 'xterm-256color');
  assert.ok(h.logs.some((l) => l.includes('pty spawned')));
});

test('term/create：cols/rows 缺省 80×24；非法 cols 返回 1001', async () => {
  const h = makeHarness();
  const ok = await h.methods['term/create']!({ cwd: h.projectDir });
  assert.equal(ok.code, 0);
  assert.equal(h.spawnCalls[0]!.options.cols, 80);
  assert.equal(h.spawnCalls[0]!.options.rows, 24);
  const bad = await h.methods['term/create']!({ cwd: h.projectDir, cols: 0 });
  assert.equal(bad.code, 1001);
  const missing = await h.methods['term/create']!({});
  assert.equal(missing.code, 1001);
});

test('term/create（AC-10-06）：未注册项目/不存在目录/任意伪造路径一律 1002 且不 spawn', async () => {
  const h = makeHarness();
  const other = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-term-other-'));
  assert.equal((await h.methods['term/create']!({ cwd: other })).code, 1002);
  assert.equal(
    (await h.methods['term/create']!({ cwd: 'C:/nope/does-not-exist-xyz' })).code,
    1002,
  );
  assert.equal(
    (await h.methods['term/create']!({ cwd: `${h.projectDir}/../..` })).code,
    1002,
  );
  assert.equal(h.spawnCalls.length, 0);
});

test('term/create：cwd 归一（混合分隔符/尾分隔符）后仍命中已注册项目', async () => {
  const h = makeHarness();
  const mixed = `${h.projectDir.replace(/\//g, '\\')}\\`;
  const res = await h.methods['term/create']!({ cwd: mixed });
  assert.equal(res.code, 0, `归一失败: ${res.message}`);
  assert.equal(h.spawnCalls[0]!.options.cwd, h.projectDir);
});

test('F04 数据流：onData → term:data（带 ptyId）；退出后不再转发；write 静默丢弃', async () => {
  const h = makeHarness();
  const created = await h.methods['term/create']!({ cwd: h.projectDir });
  const ptyId = (created.data as { ptyId: string }).ptyId;
  h.spawned[0]!.emitData('hello\r\n');
  assert.deepEqual(h.events, [{ event: 'term:data', payload: { ptyId, data: 'hello\r\n' } }]);

  const w = await h.methods['term/write']!({ ptyId, data: 'ls\r' });
  assert.equal(w.code, 0);
  assert.deepEqual(h.spawned[0]!.writes, ['ls\r']);

  // 外部退出（用户 exit）：term:exit 事件 + 后续数据不再转发、write 静默
  // （FakePty 无独立触发 exit 的公开口，kill 走同一 onExit 通道）
  h.spawned[0]!.emitData('bye');
  h.events.length = 0;
  h.spawned[0]!.kill();
  assert.deepEqual(h.events, [{ event: 'term:exit', payload: { ptyId, exitCode: 0 } }]);
  h.spawned[0]!.emitData('late');
  assert.equal(h.events.length, 1);
  const dead = await h.methods['term/write']!({ ptyId, data: 'x' });
  assert.equal(dead.code, 0);
  assert.deepEqual(h.spawned[0]!.writes, ['ls\r']); // 未追加
});

test('term/write：未知 ptyId 静默返回 0；类型非法 1001', async () => {
  const h = makeHarness();
  assert.equal((await h.methods['term/write']!({ ptyId: 'ghost', data: 'x' })).code, 0);
  assert.equal((await h.methods['term/write']!({ ptyId: '', data: 'x' })).code, 1001);
  const created = await h.methods['term/create']!({ cwd: h.projectDir });
  const ptyId = (created.data as { ptyId: string }).ptyId;
  assert.equal((await h.methods['term/write']!({ ptyId, data: 123 as unknown as string })).code, 1001);
});

test('term/resize：存活 pty 透传尺寸；死 pty 静默 0；非正整数 1001', async () => {
  const h = makeHarness();
  const created = await h.methods['term/create']!({ cwd: h.projectDir });
  const ptyId = (created.data as { ptyId: string }).ptyId;
  assert.equal((await h.methods['term/resize']!({ ptyId, cols: 100, rows: 40 })).code, 0);
  assert.deepEqual(h.spawned[0]!.sizes, [[100, 40]]);
  assert.equal((await h.methods['term/resize']!({ ptyId, cols: -1, rows: 40 })).code, 1001);
  assert.equal((await h.methods['term/resize']!({ ptyId: 'ghost', cols: 1, rows: 1 })).code, 0);
  h.spawned[0]!.kill();
  assert.equal((await h.methods['term/resize']!({ ptyId, cols: 90, rows: 30 })).code, 0);
  assert.equal(h.spawned[0]!.sizes.length, 1); // 死后不再透传
});

test('term/kill：幂等；killAll 全量回收并留日志（TM-S04）', async () => {
  const h = makeHarness();
  const a = await h.methods['term/create']!({ cwd: h.projectDir });
  const b = await h.methods['term/create']!({ cwd: h.projectDir });
  const idA = (a.data as { ptyId: string }).ptyId;
  const idB = (b.data as { ptyId: string }).ptyId;
  assert.equal((await h.methods['term/kill']!({ ptyId: idA })).code, 0);
  assert.equal((await h.methods['term/kill']!({ ptyId: idA })).code, 0); // 已退出再杀
  assert.equal((await h.methods['term/kill']!({ ptyId: 'ghost' })).code, 0);
  assert.equal(h.spawned[0]!.kills, 1); // kill 不重复下发
  h.killAll();
  assert.equal(h.spawned[1]!.kills, 1);
  assert.ok(h.logs.filter((l) => l.includes('pty killed')).length >= 2);
  // killAll 后 write 静默
  assert.equal((await h.methods['term/write']!({ ptyId: idB, data: 'x' })).code, 0);
  assert.deepEqual(h.spawned[1]!.writes, []);
});

test('resolveSystemShell（win32）：pwsh → powershell → COMSPEC 优先级链', () => {
  // exists 探测注入 fake（只看候选文件名），真实 PATH/文件系统不参与断言
  const isPwsh = (p: string) => p.toLowerCase().endsWith('pwsh.exe');
  const isPowerShell = (p: string) => p.toLowerCase().endsWith('powershell.exe');
  // 第一档：pwsh 任一候选存在即命中
  assert.ok(isPwsh(resolveSystemShell('win32', isPwsh)));
  // 第二档：pwsh 全缺、powershell 存在
  assert.ok(isPowerShell(resolveSystemShell('win32', isPowerShell)));
  // 兜底：全链未命中 → COMSPEC；COMSPEC 也缺 → 'cmd.exe' 通用名（旧口径不变）
  const savedComspec = process.env.COMSPEC;
  try {
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    assert.equal(resolveSystemShell('win32', () => false), 'C:\\Windows\\System32\\cmd.exe');
    delete process.env.COMSPEC;
    assert.equal(resolveSystemShell('win32', () => false), 'cmd.exe');
  } finally {
    if (savedComspec !== undefined) process.env.COMSPEC = savedComspec;
    else delete process.env.COMSPEC;
  }
});

test('resolveSystemShell：Unix 取 SHELL 回退 /bin/bash（优先级链不适用）', () => {
  const savedShell = process.env.SHELL;
  try {
    process.env.SHELL = '/bin/zsh';
    assert.equal(resolveSystemShell('darwin'), '/bin/zsh');
    delete process.env.SHELL;
    assert.equal(resolveSystemShell('linux'), '/bin/bash');
  } finally {
    if (savedShell !== undefined) process.env.SHELL = savedShell;
  }
});

test('windowsShellCandidates：PATH 逐目录在前、标准安装位补漏，pwsh 档先于 powershell 档', () => {
  const list = windowsShellCandidates({
    PATH: 'C:\\one;C:\\two',
    ProgramFiles: 'C:\\Program Files',
    SystemRoot: 'C:\\WINDOWS',
  });
  assert.deepEqual(list.slice(0, 2), ['C:\\one\\pwsh.exe', 'C:\\two\\pwsh.exe']);
  assert.ok(list.includes('C:\\Program Files\\PowerShell\\7\\pwsh.exe'));
  assert.ok(list.includes('C:\\two\\powershell.exe'));
  assert.ok(list.includes('C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'));
  const firstPowerShell = list.findIndex((p) => p.endsWith('powershell.exe'));
  const lastPwsh = list.map((p) => p.endsWith('pwsh.exe')).lastIndexOf(true);
  assert.ok(lastPwsh < firstPowerShell, 'pwsh 档候选必须整体排在 powershell 档之前');
});

test('shellSpawnArgs：PowerShell 系 -NoLogo，cmd/Unix/未知 shell 无参', () => {
  assert.deepEqual(shellSpawnArgs('C:\\Program Files\\PowerShell\\7\\pwsh.exe'), ['-NoLogo']);
  assert.deepEqual(
    shellSpawnArgs('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe'),
    ['-NoLogo'],
  );
  assert.deepEqual(shellSpawnArgs('C:\\Windows\\System32\\cmd.exe'), []);
  assert.deepEqual(shellSpawnArgs('/bin/bash'), []);
  assert.deepEqual(shellSpawnArgs('C:\\fake\\shell.exe'), []);
});

test('term/create：spawn args 随 shell 决定（pwsh → -NoLogo）', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-term-pwsh-'));
  const projectDir = normalizeProjectPath(dir);
  const spawnCalls: Harness['spawnCalls'] = [];
  const svc = createTermService({
    isKnownProjectPath: (p) => p === projectDir,
    emit: () => {},
    spawnPty: (file, args, options) => {
      spawnCalls.push({ file, args, options });
      return new FakePty();
    },
    resolveShell: () => 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    logger: () => {},
  });
  const res = await svc.methods['term/create']!({ cwd: projectDir });
  assert.equal(res.code, 0, res.message);
  assert.equal(spawnCalls.length, 1);
  assert.ok(spawnCalls[0]!.file.endsWith('pwsh.exe'));
  assert.deepEqual(spawnCalls[0]!.args, ['-NoLogo']);
});

test('resolveShellByPref：钉住档取首个存在者，未装返回 null；cmd 走 COMSPEC；auto/Unix 回链', () => {
  const isPwsh = (p: string) => p.toLowerCase().endsWith('pwsh.exe');
  const isPowerShell = (p: string) => p.toLowerCase().endsWith('powershell.exe');
  assert.ok(isPwsh(resolveShellByPref('pwsh', 'win32', isPwsh)));
  assert.ok(isPowerShell(resolveShellByPref('powershell', 'win32', isPowerShell)));
  // 只认 pwsh 候选 → powershell 档全缺 → null（调用方回退链）
  assert.equal(resolveShellByPref('powershell', 'win32', isPwsh), null);
  const savedComspec = process.env.COMSPEC;
  try {
    process.env.COMSPEC = 'C:\\Windows\\System32\\cmd.exe';
    assert.equal(resolveShellByPref('cmd', 'win32', () => false), 'C:\\Windows\\System32\\cmd.exe');
  } finally {
    if (savedComspec !== undefined) process.env.COMSPEC = savedComspec;
    else delete process.env.COMSPEC;
  }
  // auto = 优先级链本体；非 win32 钉任何档都回链
  assert.ok(isPwsh(resolveShellByPref('auto', 'win32', isPwsh)));
  assert.equal(resolveShellByPref('pwsh', 'linux', isPwsh), resolveSystemShell('linux'));
});

test('collectInstalledShells：档序 pwsh→powershell→cmd、exists 过滤、Unix 为空', () => {
  const isPwsh = (p: string) => p.toLowerCase().endsWith('pwsh.exe');
  const shells = collectInstalledShells('win32', isPwsh);
  assert.deepEqual(shells.map((s) => s.id), ['pwsh', 'cmd']);
  assert.equal(shells[0]!.label, 'PowerShell 7');
  assert.ok(isPwsh(shells[0]!.exe));
  // 全部不存在也保留 cmd 兜底档
  assert.deepEqual(collectInstalledShells('win32', () => false).map((s) => s.id), ['cmd']);
  assert.deepEqual(collectInstalledShells('linux', isPwsh), []);
});

test('term/create：shellId 非法枚举 1001 且不 spawn', async () => {
  const h = makeHarness();
  const res = await h.methods['term/create']!({ cwd: h.projectDir, shellId: 'powershell7' });
  assert.equal(res.code, 1001);
  assert.equal(h.spawnCalls.length, 0);
});

test('term/create：shellId=pwsh → 主进程按 id 解析，渲染层不传路径', async () => {
  const h = makeHarness({
    resolveShellByPref: (pref) => (pref === 'pwsh' ? 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' : null),
  });
  const res = await h.methods['term/create']!({ cwd: h.projectDir, shellId: 'pwsh' });
  assert.equal(res.code, 0, res.message);
  assert.ok(h.spawnCalls[0]!.file.endsWith('pwsh.exe'));
  assert.deepEqual(h.spawnCalls[0]!.args, ['-NoLogo']);
});

test('term/create：shellId 钉住档未装 → 回退注入的默认链，不阻塞开 tab', async () => {
  const h = makeHarness({ resolveShellByPref: () => null });
  const res = await h.methods['term/create']!({ cwd: h.projectDir, shellId: 'pwsh' });
  assert.equal(res.code, 0, res.message);
  assert.equal(h.spawnCalls[0]!.file, 'C:\\fake\\shell.exe');
  assert.deepEqual(h.spawnCalls[0]!.args, []);
  assert.ok(h.logs.some((l) => l.includes("shell pref 'pwsh' not installed")));
});
