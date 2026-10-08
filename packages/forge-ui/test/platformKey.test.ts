/**
 * 主修饰键判定与展示单测（模块 13，utils/platformKey.ts）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts，先例 followGate.test.ts）。
 * 覆盖的回归点：
 * - Mac 上 ⌘ 生效、Ctrl 不生效（本期修的就是「Mac 按 ⌘+` 没反应」）；
 * - 非 Mac 上 Ctrl 生效、⌘ 不生效（避免 Windows 下误吞 ⌘ 组合）；
 * - 多余修饰键不得误命中：Alt、以及 Mac 下混按 Ctrl、非 Mac 下混按 ⌘；
 * - Shift 是**要求项**而非排除项：新建会话要求按下 Shift，其余三键要求未按；
 * - key 与 code 的或关系（反引号布局兜底）、大小写不敏感（Shift 会让 key 变 'N'）；
 * - 展示记法：Mac 的 ⌘ 组合连写、其余加号，且 P/C 令牌在 Mac 下分别是 ⌘ 与 ⌃。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  capLabels,
  capsSeparator,
  formatCaps,
  hitsPrimary,
  type KeySignal,
} from '../src/utils/platformKey.ts';

/** 构造一条按键信号：默认只按下主修饰键，其余修饰键全未按 */
function sig(over: Partial<KeySignal> & { key: string }): KeySignal {
  return { code: undefined, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false, ...over };
}

const BACKTICK = { key: '`', code: 'Backquote' };
const COMMA = { key: ',' };
const BARE_B = { key: 'b' };
const SHIFT_N = { key: 'n', shift: true };

test('Mac：⌘+` 命中，Ctrl+` 不命中（本期修复的既有缺陷）', () => {
  assert.equal(hitsPrimary(sig({ key: '`', code: 'Backquote', metaKey: true }), BACKTICK, true), true);
  assert.equal(hitsPrimary(sig({ key: '`', code: 'Backquote', ctrlKey: true }), BACKTICK, true), false);
});

test('非 Mac：Ctrl+` 命中，⌘+` 不命中', () => {
  assert.equal(hitsPrimary(sig({ key: '`', code: 'Backquote', ctrlKey: true }), BACKTICK, false), true);
  assert.equal(hitsPrimary(sig({ key: '`', code: 'Backquote', metaKey: true }), BACKTICK, false), false);
});

test('主修饰键混按不算：Mac 的 ⌘+Ctrl、非 Mac 的 Ctrl+⌘ 均不命中', () => {
  assert.equal(
    hitsPrimary(sig({ key: ',', metaKey: true, ctrlKey: true }), COMMA, true),
    false,
    'Mac 下 ⌘+Ctrl+, 应留给系统/别的组合',
  );
  assert.equal(hitsPrimary(sig({ key: ',', ctrlKey: true, metaKey: true }), COMMA, false), false);
});

test('Alt 一律排除：Ctrl+Alt+B 不触发侧栏键', () => {
  assert.equal(hitsPrimary(sig({ key: 'b', ctrlKey: true, altKey: true }), BARE_B, false), false);
  assert.equal(hitsPrimary(sig({ key: 'b', metaKey: true, altKey: true }), BARE_B, true), false);
});

test('纯键（无修饰）不命中全局键：输入框里单按 b / , / n 必须原样打字', () => {
  assert.equal(hitsPrimary(sig({ key: 'b' }), BARE_B, false), false);
  assert.equal(hitsPrimary(sig({ key: ',' }), COMMA, false), false);
  assert.equal(hitsPrimary(sig({ key: 'n' }), SHIFT_N, false), false);
});

test('Shift 是要求项：Ctrl+Shift+N 命中，Ctrl+N 不命中', () => {
  assert.equal(hitsPrimary(sig({ key: 'N', ctrlKey: true, shiftKey: true }), SHIFT_N, false), true);
  assert.equal(hitsPrimary(sig({ key: 'n', ctrlKey: true }), SHIFT_N, false), false);
  assert.equal(hitsPrimary(sig({ key: 'N', metaKey: true, shiftKey: true }), SHIFT_N, true), true);
});

test('key 大小写不敏感：Shift 使 key 变 "B" 时侧栏键仍不命中（未按 Shift 要求）', () => {
  // Ctrl+B 在多数布局上 key='b'；带 Shift 时 key='B' 但 shiftKey=true，被 shift 要求项挡下
  assert.equal(hitsPrimary(sig({ key: 'B', ctrlKey: true, shiftKey: true }), BARE_B, false), false);
  assert.equal(hitsPrimary(sig({ key: 'B', ctrlKey: true }), BARE_B, false), true);
});

test('key 与 code 是或关系：key 因布局取不到反引号时，code 通道兜底命中', () => {
  assert.equal(
    hitsPrimary(sig({ key: 'Dead', code: 'Backquote', ctrlKey: true }), BACKTICK, false),
    true,
  );
  assert.equal(
    hitsPrimary(sig({ key: 'Dead', code: 'KeyQ', ctrlKey: true }), BACKTICK, false),
    false,
    'code 不匹配且 key 不匹配则不命中',
  );
});

test('展示记法：Mac 的 ⌘ 组合连写，其余加号', () => {
  assert.equal(formatCaps(['P', 'S', 'N'], true), '\u2318\u21e7N');
  assert.equal(formatCaps(['P', 'S', 'N'], false), 'Ctrl+Shift+N');
  assert.equal(formatCaps(['P', '`'], true), '\u2318`');
  assert.equal(formatCaps(['P', '`'], false), 'Ctrl+`');
  assert.equal(formatCaps(['S', 'Enter'], true), '\u21e7+Enter', '非 ⌘ 开头仍用加号，避免 ⇧Enter 不可读');
});

test('P 与 C 令牌在 Mac 下分别是 ⌘ 与 ⌃（DevTools 键真实走 Ctrl，不能显示成 ⌘）', () => {
  assert.deepEqual(capLabels(['P', 'C', 'S', 'I'], true), ['\u2318', '\u2303', '\u21e7', 'I']);
  assert.equal(formatCaps(['C', 'S', 'I'], true), '\u2303+\u21e7+I');
  assert.deepEqual(capLabels(['P', 'C', 'F12'], false), ['Ctrl', 'Ctrl', 'F12']);
});

test('capsSeparator：⌘ 开头连写、其他加号', () => {
  assert.equal(capsSeparator(['\u2318', '\u21e7', 'N'], true), '');
  assert.equal(capsSeparator(['\u2303', 'I'], true), '+');
  assert.equal(capsSeparator(['Ctrl', 'B'], false), '+');
});
