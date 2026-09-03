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
 *   项目不在列表（脏数据）回退路径末段。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  sortSessionsByActivation,
  nextFoldAllAction,
  projectTagOf,
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
