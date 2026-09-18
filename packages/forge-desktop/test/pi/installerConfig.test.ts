/**
 * 安装器 UX 契约测试（PRD 07 IN-F03 / AC-IN-009）。
 *
 * 要守住的体验：**更新时用户全程可见进度、且不需要任何点击**，装完自动重开应用。
 * 这条体验由两处不可见的配置共同决定，任一处回退都会静默破坏它（E2E / mock 都测不到）：
 *
 * 1. `electron-builder.yml` 的 `nsis.oneClick: true`
 *    - true → 一键安装器：无向导页；更新时走 installSection.nsh 的 ONE_CLICK 分支显示
 *      SpiderBanner 进度窗口，装完由 RUN_AFTER_FINISH 拉起应用。
 *    - false → 辅助安装向导：有安装模式页/进度页/结束页，结束页要用户点「完成」才启动应用
 *      —— 正是 2026-09-14 反馈否定的「还要在安装程序里手动点击」。
 * 2. `QUIT_AND_INSTALL_OPTIONS.isSilent === false`
 *    - false → 非静默：安装器显示进度窗口（可见进度）。
 *    - true → 加 `/S` 走静默安装：全程无窗口，用户只看到应用消失又突然跳出来
 *      —— 同样是 2026-09-14 反馈否定的体验。
 *
 * `allowToChangeInstallationDirectory` 与 oneClick 互斥（electron-builder 会直接抛
 * InvalidConfigurationError），本测试同时守住它不被重新加回来。
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

test('nsis 为一键安装器：更新无向导页点击，装完自动重开应用', () => {
  const nsis = readNsisBlock();
  assert.equal(
    nsis.get('oneClick'),
    'true',
    'nsis.oneClick 必须为 true：非一键（辅助安装向导）更新时会停在结束页等用户点「完成」',
  );
  assert.equal(
    nsis.get('runAfterFinish'),
    'true',
    'nsis.runAfterFinish 必须为 true：装完自动重新打开应用',
  );
  assert.equal(
    nsis.has('allowToChangeInstallationDirectory'),
    false,
    'allowToChangeInstallationDirectory 与 oneClick=true 互斥，配置同时存在会让 electron-builder 直接报错',
  );
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
    'forceRunAfter 必须为 true：装完自动启动新版本',
  );
});
