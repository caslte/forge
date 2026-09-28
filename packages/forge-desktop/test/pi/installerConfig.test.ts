/**
 * 安装器 UX 契约测试（PRD 07 IN-F03 / AC-IN-009）。
 *
 * 要守住的两条体验（2026-09-14 与 2026-09-19 两轮反馈合并）：
 *
 * A. 首装 = 标准安装向导：显示默认安装目录、允许用户自定义（「更改」按钮）。
 *    由 `nsis.oneClick: false` + `nsis.allowToChangeInstallationDirectory: true` 提供。
 *    反向约束：不要改回 oneClick:true —— 一键安装器与可选目录互斥，首装将无法选位置
 *    （曾用 customInit+SelectFolderDialog 绕路，被否定：双击安装包直接弹裸选目录框
 *    不是「正常安装」的样子）。
 *
 * B. 更新 = 可见进度 + 零点击 + 装完自动重开。向导模式下这条靠三处配合：
 *    1. `QUIT_AND_INSTALL_OPTIONS.isSilent === false`
 *       —— 非静默才有窗口可看进度；改 true 则全程无窗口（应用消失又突然跳出，
 *       2026-09-14 反馈明确否定）。
 *    2. electron-builder 官方模板：electron-updater 恒传 --updated，
 *       目录页被 skipPageIfUpdated 自动跳过。
 *    3. `nsis.include: build/installer.nsh` 抹平向导模式与 oneClick 的剩余差异：
 *       - customInstallMode → $isForceCurrentInstall="1"：跳过「安装模式」页
 *         （forge 恒 per-user，该页纯噪音）；
 *       - customInstall → ${isUpdated} + ${isForceRun} 时 HideWindow + StartApp +
 *         quitSuccess：复刻 oneClick 收尾，不进结束页 —— 向导模式默认只在
 *         「静默 + --force-run」才自动拉起应用，缺这段更新会停在结束页等点击「完成」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { QUIT_AND_INSTALL_OPTIONS } from '../../src/pi/appUpdater.ts';

const desktopRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * 取 electron-builder.yml 最外层 `nsis:` 键下的直属子键（行式解析，不引 yaml 依赖）。
 * 只处理「两空格缩进 + 单一 key」的形状，遇到缩进回退或新的顶层键即结束。
 */
function readNsisBlock(): Map<string, string> {
  const raw = fs.readFileSync(path.join(desktopRoot, 'electron-builder.yml'), 'utf8');
  const lines = raw.split(/\r?\n/);
  const start = lines.findIndex((l) => /^nsis:\s*$/.test(l));
  assert.notEqual(start, -1, 'electron-builder.yml 应存在顶层 nsis: 块');

  const entries = new Map<string, string>();
  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue;
    if (/^\S/.test(line)) break; // 回到顶层键 → nsis 块结束
    const m = /^ {2}([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
    assert.ok(m, `nsis 块内出现未预期的行（应为本测试解析范围外的形状）：${line}`);
    entries.set(m[1], m[2].trim());
  }
  return entries;
}

test('nsis 为向导安装器：首装显示默认目录并可自定义安装位置', () => {
  const nsis = readNsisBlock();
  assert.equal(
    nsis.get('oneClick'),
    'false',
    'nsis.oneClick 必须为 false：一键安装器与可选目录互斥，首装将无法选择安装位置',
  );
  assert.equal(
    nsis.get('allowToChangeInstallationDirectory'),
    'true',
    '必须开启 allowToChangeInstallationDirectory：首装/重装的「选择安装位置」页靠它',
  );
  assert.equal(
    nsis.get('perMachine'),
    'false',
    'forge 恒为 per-user 安装（installer.nsh 的 customInstallMode 跳过安装模式页的前提）',
  );
  assert.equal(
    nsis.get('runAfterFinish'),
    'true',
    'nsis.runAfterFinish 必须为 true：首装结束页提供「运行 forge」并默认勾选',
  );
});

test('更新零点击：installer.nsh 跳过安装模式页，并在 --updated 时复刻 oneClick 收尾', () => {
  const nsis = readNsisBlock();
  assert.equal(
    nsis.get('include'),
    'build/installer.nsh',
    'nsis.include 必须指向 build/installer.nsh：更新路径的零点击收尾全部由该脚本提供',
  );

  const raw = fs.readFileSync(path.join(desktopRoot, 'build', 'installer.nsh'), 'utf8');
  // 安装模式页守卫：强制 per-user（multiUserUi PRE 见 $isForceCurrentInstall=="1" 即 Abort）
  assert.match(raw, /!macro customInstallMode/, '必须定义 customInstallMode 钩子');
  assert.match(raw, /StrCpy \$isForceCurrentInstall "1"/, 'customInstallMode 必须强制 per-user 以跳过安装模式页');
  // 收尾守卫：仅 electron-updater 更新路径（--updated + --force-run）触发，
  // 拉起应用后 quitSuccess(Quit)，不进结束页
  assert.match(raw, /!macro customInstall\b/, '必须定义 customInstall 钩子');
  assert.match(raw, /\$\{if\} \$\{isUpdated\}/, 'customInstall 必须只在 --updated（自动更新）路径收尾');
  assert.match(raw, /\$\{andIf\} \$\{isForceRun\}/, 'customInstall 必须同时要求 --force-run（与 oneClick 拉起条件一致）');
  // 拉起应用 = 模板 doStartApp 的内联等价（StartApp 宏含 Var 声明，二次展开会撞名，
  // 故 installer.nsh 用 StdUtils.ExecShellAsUser 直调 —— 断言这条内联而非 !insertmacro StartApp）
  assert.match(raw, /\$\{StdUtils\.ExecShellAsUser\} \$0 "\$launchLink" "open" "--updated"/, 'customInstall 必须拉起应用（装完自动重开）');
  assert.match(raw, /!insertmacro quitSuccess/, 'customInstall 必须 quitSuccess 退出，不进结束页（零点击）');
  // 卸载器遍守卫：宏只在安装器遍定义，避免卸载器编译残留告警（warning-as-error）
  assert.match(raw, /!ifndef BUILD_UNINSTALLER/, '全部钩子必须在 !ifndef BUILD_UNINSTALLER 内');
});

test('目录页文案：官方默认文案 + 「自动补 Forge 子目录」提示（2026-09-19 反馈）', () => {
  const raw = fs.readFileSync(path.join(desktopRoot, 'build', 'installer.nsh'), 'utf8');
  // 机制：MUI2 官方扩展点 MUI_DIRECTORYPAGE_TEXT_TOP（Directory.nsh 的 MUI_DEFAULT 兜底、
  // DirText 透传、页生成后 !undef），本文件被前置 include 到模板最顶部故生效。
  assert.match(raw, /!define MUI_DIRECTORYPAGE_TEXT_TOP/, '必须用官方 TEXT_TOP 钩子定制目录页文案');
  // 保留默认文案语义（Setup 将安装 / 浏览指引），并追加自动补子目录提示
  assert.match(raw, /!define MUI_DIRECTORYPAGE_TEXT_TOP "[^"]*将安装 Forge 在下列文件夹/, '文案必须保留「安装到下列文件夹」指引');
  assert.match(raw, /!define MUI_DIRECTORYPAGE_TEXT_TOP "[^"]*浏览\(B\)/, '文案必须保留「浏览」指引');
  assert.match(raw, /!define MUI_DIRECTORYPAGE_TEXT_TOP "[^"]*自动安装到其下的 Forge 子目录/, '文案必须说明自动补子目录行为');
  // 反向约束：SHOW 回调路线已被真机证伪（NSIS 3.0.4.1 内建 directory 页运行时不派发 SHOW），
  // 不得回到该死路；也不得残留诊断代码（MessageBox/FileOpen）
  assert.doesNotMatch(raw, /MUI_PAGE_CUSTOMFUNCTION_SHOW/, 'SHOW 回调路线已证伪，禁止回退');
  assert.doesNotMatch(raw, /MessageBox/, '禁止残留诊断 MessageBox');
  assert.doesNotMatch(raw, /FileOpen/, '禁止残留诊断日志 FileOpen');
});

test('quitAndInstall 走非静默分支：安装期显示进度窗口（不可改为静默）', () => {
  assert.equal(
    QUIT_AND_INSTALL_OPTIONS.isSilent,
    false,
    'isSilent 必须为 false：改为 true 则安装期不显示任何窗口，用户看不到进度',
  );
  assert.equal(
    QUIT_AND_INSTALL_OPTIONS.forceRunAfter,
    true,
    'forceRunAfter 必须为 true：装完自动启动新版本（installer.nsh 的 customInstall 也依赖 --force-run）',
  );
});
