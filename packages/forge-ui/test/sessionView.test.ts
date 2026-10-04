/**
 * U-SM-005 sessionView 纯函数单测（AC-SM-023/024，docs/test/02_session/coverage-matrix.md）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts，先例 reviewMode.test.ts）。
 * 覆盖（docs/prd/02_session_management.md SM-S06）：
 * - sortSessionsByActivation：任务视角/项目视角共用排序——激活序在前（运行中置顶且保留），
 *   从未激活的保持后端原序（Array.sort 稳定），空激活序不重排；
 * - nextFoldAllAction：收起全部/展开全部两态判定——任一展开→collapse，全部已折叠→expand，
 *   空项目列表→expand（无可收起，点开展开是无操作的安全态）；
 * - projectTagOf：任务视角行尾项目 tag——项目别名优先，无别名取路径末段，
 *   项目不在列表（脏数据）回退路径末段；
 * - relativeTimeParts：行尾相对活跃时间的分档判定（刚刚/分钟/小时/天/日期），
 *   只给 i18n 键与参数，越界/非法输入返回 null；
 * - formatAbsoluteTime：行尾时间的 title 绝对值。
 * E2E 侧的渲染与 hover 换位见 e2e/sessionTime.spec.ts。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sortSessionsByActivation,
  nextFoldAllAction,
  projectTagOf,
  relativeTimeParts,
  formatAbsoluteTime,
} from '../src/utils/sessionView.ts';
import type { SessionItem, ProjectItem } from '../src/types.ts';

function sess(
  id: string,
  status: SessionItem['status'],
  projectPath = '/w/a',
  lastActiveAt = '2026-01-01T00:00:00Z',
): SessionItem {
  return { sessionId: id, projectPath, alias: null, status, lastActiveAt };
}

test('sortSessionsByActivation: 激活序在前，未激活保持后端原序（稳定）', () => {
  const sessions = [sess('s1'), sess('s2'), sess('s3'), sess('s4')];
  // s3/s1 曾激活（如运行过），s2/s4 从未激活
  const sorted = sortSessionsByActivation(sessions, ['s3', 's1']);
  assert.deepEqual(
    sorted.map((s) => s.sessionId),
    ['s3', 's1', 's2', 's4'],
    '激活序 s3,s1 在前；s2/s4 未激活保持原相对顺序',
  );
});

test('sortSessionsByActivation: 空激活序不重排（后端原序）', () => {
  const sessions = [sess('s1'), sess('s2')];
  const sorted = sortSessionsByActivation(sessions, []);
  assert.deepEqual(
    sorted.map((s) => s.sessionId),
    ['s1', 's2'],
  );
});

test('sortSessionsByActivation: 不改入参数组（纯函数）', () => {
  const sessions = [sess('s1'), sess('s2')];
  sortSessionsByActivation(sessions, ['s2']);
  assert.deepEqual(
    sessions.map((s) => s.sessionId),
    ['s1', 's2'],
    '入参顺序不变',
  );
});

test('nextFoldAllAction: 存在任一展开项目 → collapse（收起全部）', () => {
  assert.equal(nextFoldAllAction(['/a', '/b'], new Set(['/b'])), 'collapse');
  assert.equal(nextFoldAllAction(['/a', '/b'], new Set()), 'collapse');
});

test('nextFoldAllAction: 全部已折叠 → expand（展开全部）', () => {
  assert.equal(nextFoldAllAction(['/a', '/b'], new Set(['/a', '/b'])), 'expand');
});

test('nextFoldAllAction: 空项目列表 → expand（安全无操作态）', () => {
  assert.equal(nextFoldAllAction([], new Set()), 'expand');
});

function proj(path: string, alias: string | null): ProjectItem {
  return { path, alias, lastOpenedAt: '2026-01-01T00:00:00Z', trust: 'trusted' };
}

test('projectTagOf: 项目别名优先', () => {
  const projects = [proj('/w/ai_work/forge', '我的锻造')];
  assert.equal(projectTagOf('/w/ai_work/forge', projects), '我的锻造');
});

test('projectTagOf: 无别名取路径末段；反斜杠路径同样取末段', () => {
  assert.equal(projectTagOf('/w/ai_work/forge', []), 'forge');
  assert.equal(projectTagOf('C:\\works\\ai_work\\forge', []), 'forge');
});

test('projectTagOf: 会话所属项目不在列表（脏数据）回退路径末段', () => {
  const projects = [proj('/other', 'x')];
  assert.equal(projectTagOf('/ghost/proj', projects), 'proj');
});

/* ===== 行尾相对活跃时间 ===== */
const NOW = new Date(2026, 9, 4, 12, 0, 0).getTime(); // 2026-10-04 12:00 本地时间
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const ahead = (ms: number): string => new Date(NOW + ms).toISOString();

test('relativeTimeParts: <1 分钟与未来时间都归「刚刚」，不出现负数小时', () => {
  assert.equal(relativeTimeParts(ago(0), NOW)?.key, 'project.timeJustNow');
  assert.equal(relativeTimeParts(ago(59_000), NOW)?.key, 'project.timeJustNow');
  assert.equal(relativeTimeParts(ahead(999_000), NOW)?.key, 'project.timeJustNow', '未来时间戳不产生负值');
});

test('relativeTimeParts: 分钟/小时/天三档边界取下整，边界值进位到上一档', () => {
  assert.deepEqual(relativeTimeParts(ago(60_000), NOW), { key: 'project.timeMinutes', count: 1 });
  assert.deepEqual(relativeTimeParts(ago(59 * 60_000), NOW), { key: 'project.timeMinutes', count: 59 });
  assert.deepEqual(relativeTimeParts(ago(60 * 60_000), NOW), { key: 'project.timeHours', count: 1 });
  assert.deepEqual(relativeTimeParts(ago(11 * 3_600_000), NOW), { key: 'project.timeHours', count: 11 });
  assert.deepEqual(relativeTimeParts(ago(24 * 3_600_000), NOW), { key: 'project.timeDays', count: 1 });
  assert.deepEqual(relativeTimeParts(ago(29 * 86_400_000), NOW), { key: 'project.timeDays', count: 29 });
});

test('relativeTimeParts: 超过 30 天退化为日期；同年只给月日，跨年补年', () => {
  assert.deepEqual(relativeTimeParts(ago(45 * 86_400_000), NOW), {
    key: 'project.timeMonthDay',
    month: 8,
    day: 20,
  });
  assert.deepEqual(relativeTimeParts('2025-12-25T08:30:00', NOW), {
    key: 'project.timeFull',
    year: 2025,
    month: 12,
    day: 25,
  });
});

test('relativeTimeParts: 空/非法时间戳返回 null（调用方整块不渲染）', () => {
  assert.equal(relativeTimeParts(null, NOW), null);
  assert.equal(relativeTimeParts(undefined, NOW), null);
  assert.equal(relativeTimeParts('', NOW), null);
  assert.equal(relativeTimeParts('not-a-date', NOW), null);
});

test('formatAbsoluteTime: 本地时区零填充，非法输入返回空串', () => {
  assert.equal(formatAbsoluteTime(new Date(2026, 9, 4, 9, 5).toISOString()), '2026/10/04 09:05');
  assert.equal(formatAbsoluteTime('bad'), '');
  assert.equal(formatAbsoluteTime(null), '');
});
