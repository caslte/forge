/**
 * 版本更新说明（pi/releaseNotes.ts）单测。
 *
 * 覆盖三层「只弹一次」门控与持久化闭环：
 * - markdown 门控：安装包未携带说明（路径 null / 文件缺失 / 纯空白）→ markdown=null、不弹
 * - 升级启动门控：isUpgradeRun=false（平运行 / 全新安装 lastRunForgeVersion=null）→ 不弹
 * - 已展示门控：lastShownNotesVersion === 当前版本 → 不弹；markNotesShown 回写后翻转
 * - 方法表：getReleaseNotes 信封 + markNotesShown 持久化（updater-state.json 真实读写，tmp 目录）
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  createReleaseNotesMethods,
  markNotesShown,
  readReleaseNotesMarkdown,
  resolveReleaseNotes,
  type ReleaseNotesDeps,
  type ReleaseNotesPayload,
} from '../src/pi/releaseNotes.ts';
import { defaultUpdaterStatePath, readUpdaterState, writeUpdaterState } from '../src/pi/updaterState.ts';
import type { RpcResult } from '@forge/core';

const NOTES = '<!-- auto -->\n\n### 新功能\n- something';
const VERSION = '0.2.3';

/** 缺省依赖：不注入文件路径与状态路径（markdown=null、不持久化） */
function deps(overrides: Partial<ReleaseNotesDeps> = {}): ReleaseNotesDeps {
  return { currentVersion: VERSION, isUpgradeRun: true, notesFilePath: null, statePath: null, ...overrides };
}

test('readReleaseNotesMarkdown：路径 null / 文件缺失 / 纯空白 → null，正常文件 → 原文', () => {
  assert.equal(readReleaseNotesMarkdown(deps()), null, '路径 null（无法定位）→ null');
  assert.equal(readReleaseNotesMarkdown(deps({ notesFilePath: 'Z:/no/such/file.md' })), null, '文件缺失 → null');
  const dir = mkdtempSync(path.join(tmpdir(), 'rn-read-'));
  try {
    const blank = path.join(dir, 'blank.md');
    writeFileSync(blank, '   \n  ', 'utf8');
    assert.equal(readReleaseNotesMarkdown(deps({ notesFilePath: blank })), null, '纯空白 → null');
    const ok = path.join(dir, 'ok.md');
    writeFileSync(ok, NOTES, 'utf8');
    assert.equal(readReleaseNotesMarkdown(deps({ notesFilePath: ok })), NOTES, '正常文件 → 原文');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('resolveReleaseNotes：三层门控 —— 无文件 / 非升级启动 / 已展示，任一命中都不弹', () => {
  // 注意 notesFilePath 必须非 null（null 在 markdown 门控就被拦下，测不到后两层）
  const base = { notesFilePath: 'pkg:/release-notes.md', readTextFile: () => NOTES };
  // ① markdown 门控（notesFilePath=null → 无说明）
  assert.equal(resolveReleaseNotes(deps(), null).shouldShow, false, '无说明文件不弹');
  // ② 升级启动门控（平运行 / 全新安装 lastRunForgeVersion=null 都归 isUpgradeRun=false）
  assert.equal(resolveReleaseNotes(deps({ ...base, isUpgradeRun: false }), null).shouldShow, false, '非升级启动不弹');
  // ③ 已展示门控
  assert.equal(resolveReleaseNotes(deps(base), VERSION).shouldShow, false, '本版本已展示过不弹');
  // 全部通过
  const ok = resolveReleaseNotes(deps(base), '0.2.2');
  assert.equal(ok.shouldShow, true, '升级首启 + 未展示 → 应弹');
  assert.equal(ok.version, VERSION);
  assert.equal(ok.markdown, NOTES);
});

test('方法表闭环：shouldShow=true → markNotesShown 回写 → 再查不再弹（真实 tmp 状态文件）', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rn-state-'));
  try {
    const statePath = defaultUpdaterStatePath(dir);
    // 预置盘面：上次运行版本 ≠ 当前（升级启动）
    const seed = readUpdaterState(statePath);
    seed.lastRunForgeVersion = '0.2.2';
    writeUpdaterState(statePath, seed);
    const notesPath = path.join(dir, 'release-notes.md');
    writeFileSync(notesPath, NOTES, 'utf8');
    const methods = createReleaseNotesMethods(deps({ notesFilePath: notesPath, statePath }));

    const first = (await methods['updater/getReleaseNotes'](undefined)) as RpcResult<ReleaseNotesPayload>;
    assert.equal(first.code, 0);
    assert.equal(first.data?.shouldShow, true, '升级首启 + 未展示 → 应弹');
    assert.equal(first.data?.markdown, NOTES);

    const marked = await methods['updater/markNotesShown'](undefined);
    assert.equal(marked.code, 0);
    const afterMark = readUpdaterState(statePath);
    assert.equal(afterMark.lastShownNotesVersion, VERSION, '已展示版本应回写');
    assert.equal(afterMark.lastRunForgeVersion, '0.2.2', 'markNotesShown 只动自己的字段，其余原样保留');

    const second = (await methods['updater/getReleaseNotes'](undefined)) as RpcResult<ReleaseNotesPayload>;
    assert.equal(second.data?.shouldShow, false, '再查不再弹（只弹一次）');

    // 幂等：重复回写无变化、不抛
    await methods['updater/markNotesShown'](undefined);
    assert.equal(readUpdaterState(statePath).lastShownNotesVersion, VERSION);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('statePath=null（缺省注入场景）：markdown 照常返回、shouldShow 恒 true、回写跳过不抛', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'rn-nostate-'));
  try {
    const notesPath = path.join(dir, 'release-notes.md');
    writeFileSync(notesPath, NOTES, 'utf8');
    const methods = createReleaseNotesMethods(deps({ notesFilePath: notesPath, statePath: null }));
    const res = (await methods['updater/getReleaseNotes'](undefined)) as RpcResult<ReleaseNotesPayload>;
    assert.equal(res.data?.shouldShow, true, '无状态可持久化 → 每次查询都视为未展示（由调用方决定注入）');
    await methods['updater/markNotesShown'](undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
