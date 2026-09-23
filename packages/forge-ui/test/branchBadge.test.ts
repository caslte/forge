/**
 * 分支徽标纯函数单测（PM-S05，AC-PM-013/014/017，
 * docs/api/01_project.md §10/§11 契约）。
 *
 * 覆盖：filterBranches（空查询/大小写不敏感命中/无匹配）、
 * shouldAskConfirm（dirty 且目标≠当前才确认）、
 * displayBranch（非 git null / detached 短 SHA / 正常分支名）。
 * 忙态判定（AC-PM-016）2026-09-23 起为「当前会话自身 streaming」，
 * 收敛在 InstructionInput 的 computed，不再是项目级纯函数。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  filterBranches,
  shouldAskConfirm,
  displayBranch,
} from '../src/utils/branchBadge.ts';
import type { GitBranchInfo } from '../src/types.ts';

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
