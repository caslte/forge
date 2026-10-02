/**
 * 编辑器扫描（shell/editorScan.ts）单测。
 *
 * 目标行为：**不写死三家**——内置一个编辑器目录（VS Code 家族 / Cursor / Windsurf /
 * Trae / Zed / Sublime / Notepad++ / JetBrains 全家……），逐个走三层解析：
 *   ① PATH 全部命中行（`where` 首行常是无扩展名的 sh 脚本，必须遍历；.cmd 垫片向上找
 *      GUI 主程序——Node ≥18.20 spawn .cmd 抛 EINVAL，是旧实现「点了没反应」的根因）
 *   ② 注册表 App Paths（编辑器没进 PATH 时兜底，用户安装到自定义目录时是唯一线索）
 *   ③ 常见安装根目录扫描（%LOCALAPPDATA%\Programs / %ProgramFiles%，按目录名匹配）
 *
 * 解析产物必须**真实存在的 .exe**——绝不把 .cmd / 无扩展名脚本交给 spawn。
 * 依赖全部注入（ScanData），测试不碰真实 PATH / 注册表 / 文件系统。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { EDITOR_APPS, collectInstalledEditors, type ScanData } from '../../src/shell/editorScan.ts';

/** 组装 ScanData：默认什么都没装、非 Windows */
function makeData(over: Partial<ScanData> = {}): ScanData {
  return {
    pathHits: over.pathHits ?? new Map(),
    registeredApps: over.registeredApps ?? [],
    installDirs: over.installDirs ?? [],
    exists: over.exists ?? (() => false),
    isWindows: over.isWindows ?? false,
  };
}

test('目录契约：id 唯一、都有 label 与至少一个 exe 名（渲染层分项菜单依赖稳定 id）', () => {
  const ids = new Set(EDITOR_APPS.map((a) => a.id));
  assert.equal(ids.size, EDITOR_APPS.length, 'id 不得重复');
  for (const app of EDITOR_APPS) {
    assert.ok(app.label.length > 0, `${app.id} 缺 label`);
    assert.ok(app.exeNames.length > 0, `${app.id} 缺 exeNames`);
  }
  // 常用编辑器必须在目录里（覆盖 VSCode 家族 / AI 编辑器 / 传统编辑器 / JetBrains）
  for (const id of [
    'vscode', 'vscode-insiders', 'vscodium', 'cursor', 'windsurf', 'trae', 'zed',
    'sublime-text', 'notepad-plus-plus', 'editplus', 'intellij-idea', 'pycharm',
    'android-studio',
  ]) {
    assert.ok(ids.has(id), `目录缺 ${id}`);
  }
});

test('非 Windows：PATH 命中即放行（脚本带 shebang 可直接 spawn）', () => {
  const editors = collectInstalledEditors(
    makeData({ pathHits: new Map([['code', ['/usr/bin/code']]]) }),
  );
  assert.deepEqual(editors, [{ id: 'vscode', label: 'VS Code', exe: '/usr/bin/code' }]);
});

test('Windows PATH：遍历全部命中行——无扩展名脚本跳过，.exe 直接用（zed 形态）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      pathHits: new Map([['zed', ['D:\\tools\\Zed\\bin\\zed', 'D:\\tools\\Zed\\bin\\Zed.exe']]]),
      exists: (p) => p === 'D:\\tools\\Zed\\bin\\Zed.exe',
    }),
  );
  assert.deepEqual(editors, [{ id: 'zed', label: 'Zed', exe: 'D:\\tools\\Zed\\bin\\Zed.exe' }]);
});

test('Windows PATH：只有 .cmd 垫片时向上找 GUI 主程序（自定义安装目录形态）', () => {
  // 真机形态：where code → [bin\code(脚本), bin\code.cmd]，主程序在上一级 Code.exe
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      pathHits: new Map([
        ['code', ['D:\\work\\tools\\Microsoft VS Code\\bin\\code', 'D:\\work\\tools\\Microsoft VS Code\\bin\\code.cmd']],
      ]),
      exists: (p) => p === 'D:\\work\\tools\\Microsoft VS Code\\Code.exe',
    }),
  );
  assert.deepEqual(editors, [
    { id: 'vscode', label: 'VS Code', exe: 'D:\\work\\tools\\Microsoft VS Code\\Code.exe' },
  ]);
});

test('Windows PATH：垫片解析不出主程序 → 不放行（绝不 spawn .cmd / 脚本）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      pathHits: new Map([['code', ['D:\\x\\bin\\code', 'D:\\x\\bin\\code.cmd']]]),
      exists: () => false,
    }),
  );
  assert.deepEqual(editors, []);
});

test('App Paths 层：PATH 没有 → 注册表命中（取默认值里的 exe 路径，需真实存在）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      registeredApps: [{ name: 'code.exe', exe: 'D:\\work\\tools\\Microsoft VS Code\\Code.exe' }],
      exists: (p) => p === 'D:\\work\\tools\\Microsoft VS Code\\Code.exe',
    }),
  );
  assert.deepEqual(editors, [
    { id: 'vscode', label: 'VS Code', exe: 'D:\\work\\tools\\Microsoft VS Code\\Code.exe' },
  ]);
});

test('App Paths 层：注册表路径不存在 → 跳过（不迷信注册表）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      registeredApps: [{ name: 'code.exe', exe: 'D:\\gone\\Code.exe' }],
    }),
  );
  assert.deepEqual(editors, []);
});

test('安装目录层：目录名匹配 → 根部或 bin\\ 下的 GUI 主程序（EditPlus / JetBrains 形态）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      installDirs: [
        { name: 'EditPlus', path: 'C:\\Program Files\\EditPlus' },
        { name: 'IntelliJ IDEA 2024.1', path: 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.1' },
      ],
      exists: (p) =>
        p === 'C:\\Program Files\\EditPlus\\editplus.exe' ||
        p === 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.1\\bin\\idea64.exe',
    }),
  );
  assert.deepEqual(
    editors.map((e) => e.id),
    ['editplus', 'intellij-idea'],
  );
  assert.equal(editors[1].exe, 'C:\\Program Files\\JetBrains\\IntelliJ IDEA 2024.1\\bin\\idea64.exe');
});

test('安装目录层：目录名不匹配的目录一律不查（防御：不把任意 exe 当编辑器）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      installDirs: [{ name: ' Totally Unrelated ', path: 'C:\\Program Files\\Weird' }],
      exists: () => true, // 就算盘上全是 exe，目录名不匹配也不能命中
    }),
  );
  assert.deepEqual(editors, []);
});

test('层优先级：PATH > App Paths > 安装目录（同一编辑器只出一个菜单项）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      pathHits: new Map([['zed', ['D:\\tools\\Zed\\bin\\Zed.exe']]]),
      registeredApps: [{ name: 'zed.exe', exe: 'C:\\From\\Registry\\zed.exe' }],
      installDirs: [{ name: 'Zed', path: 'C:\\From\\Scan\\Zed' }],
      exists: () => true,
    }),
  );
  assert.deepEqual(editors, [{ id: 'zed', label: 'Zed', exe: 'D:\\tools\\Zed\\bin\\Zed.exe' }]);
});

test('多个编辑器按目录顺序输出（菜单顺序稳定）', () => {
  const editors = collectInstalledEditors(
    makeData({
      isWindows: true,
      pathHits: new Map([
        ['trae', ['D:\\tools\\Trae\\bin\\trae', 'D:\\tools\\Trae\\bin\\trae.cmd']],
        ['zed', ['D:\\tools\\Zed\\bin\\Zed.exe']],
      ]),
      exists: (p) => p === 'D:\\tools\\Trae\\Trae.exe' || p === 'D:\\tools\\Zed\\bin\\Zed.exe',
    }),
  );
  assert.deepEqual(
    editors.map((e) => e.id),
    ['trae', 'zed'], // 目录里 trae 在 zed 前，与 PATH 命中顺序无关
  );
});

test('一个都没装 → 空数组（渲染层据此显示置灰的提示项）', () => {
  assert.deepEqual(collectInstalledEditors(makeData()), []);
});
