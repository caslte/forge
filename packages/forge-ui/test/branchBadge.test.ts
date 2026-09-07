/**
 * 分支徽标纯函数单测（PM-S05，AC-PM-013/014/016/017，
 * docs/api/01_project.md §10/§11 契约）。
 *
 * 覆盖：filterBranches（空查询/大小写不敏感命中/无匹配）、
 * shouldAskConfirm（dirty 且目标≠当前才确认）、
 * isProjectBusy（空数组/命中 streaming/非 streaming 不算/detached 不算 busy——
 * detached 是分支状态与会话无关）、displayBranch（非 git null / detached 短 SHA / 正常分支名）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterBranches,
  shouldAskConfirm,
  isProjectBusy,
  displayBranch,
} from '../src/utils/branchBadge.ts';
import type { GitBranchInfo } from '../src/types.ts';
import type { SessionItem } from '../src/types.ts';

function sess(projectPath: string, status: SessionItem['status']): SessionItem {
  return { sessionId: 's-' + Math.random().toString(36).slice(2), projectPath, alias: null, status, lastActiveAt: '' };
}

function info(partial: Partial<GitBranchInfo>): GitBranchInfo {
  return { isGitRepo: true, branch: 'main', branches: ['main'], dirty: false, detached: false, ...partial };
}

// ===== filterBranches =====

test('filterBranches: 空查询返回全量', () => {
  const branches = ['main', 'feat/login', 'fix/dark-mode'];
  assert.deepEqual(filterBranches(branches, ''), branches);
});

test('filterBranches: 命中（大小写不敏感）', () => {
  const branches = ['main', 'feat/login', 'fix/dark-mode'];
  assert.deepEqual(filterBranches(branches, 'FEAT'), ['feat/login']);
  assert.deepEqual(filterBranches(branches, 'dark'), ['fix/dark-mode']);
  assert.deepEqual(filterBranches(branches, 'a'), ['main', 'feat/login', 'fix/dark-mode']);
});

test('filterBranches: 无匹配返回空数组', () => {
  assert.deepEqual(filterBranches(['main'], 'zzz'), []);
});

// ===== shouldAskConfirm =====

test('shouldAskConfirm: dirty 且目标≠当前 → true', () => {
  assert.equal(shouldAskConfirm(true, 'feat/x', 'main'), true);
});

test('shouldAskConfirm: dirty 但目标=当前 → false', () => {
  assert.equal(shouldAskConfirm(true, 'main', 'main'), false);
});

test('shouldAskConfirm: 不 dirty → false', () => {
  assert.equal(shouldAskConfirm(false, 'feat/x', 'main'), false);
});

// ===== isProjectBusy =====

test('isProjectBusy: 空会话数组 → false', () => {
  assert.equal(isProjectBusy([], 'D:/a'), false);
});

test('isProjectBusy: 该项目存在 streaming 会话 → true', () => {
  const sessions = [sess('D:/a', 'idle'), sess('D:/a', 'streaming'), sess('D:/b', 'streaming')];
  assert.equal(isProjectBusy(sessions, 'D:/a'), true);
});

test('isProjectBusy: 只有其他项目 streaming / 本项目非 streaming → false', () => {
  const sessions = [sess('D:/b', 'streaming'), sess('D:/a', 'done'), sess('D:/a', 'idle')];
  assert.equal(isProjectBusy(sessions, 'D:/a'), false);
});

test('isProjectBusy: detached 分支状态不影响 busy 判定（busy 只看会话 status）', () => {
  const sessions = [sess('D:/a', 'done')];
  assert.equal(isProjectBusy(sessions, 'D:/a'), false);
});

// ===== displayBranch =====

test('displayBranch: 非 git 项目 → null', () => {
  assert.equal(displayBranch(info({ isGitRepo: false, branch: '', branches: [] })), null);
});

test('displayBranch: detached → 短 SHA（契约：branch 字段即短 SHA）', () => {
  assert.equal(displayBranch(info({ detached: true, branch: 'a1b2c3d' })), 'a1b2c3d');
});

test('displayBranch: 正常仓库 → 当前分支名', () => {
  assert.equal(displayBranch(info({ branch: 'feat/login' })), 'feat/login');
});
