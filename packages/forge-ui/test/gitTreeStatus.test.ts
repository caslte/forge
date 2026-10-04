/**
 * 模块 12 CE-S07：目录行的 Git 状态聚合（父级节点染色标记的数据源）。
 *
 * 背景（用户 2026-10-03 报）：子文件改了，父目录只有一枚灰色 M 徽标、名字不变色，
 * 在一列目录里扫不出「哪条分支有改动」。修复分两半：
 * 1. 聚合口径对齐原型（code-tree-git-demo.html dirBadge）：恰好一个变更文件时
 *    **透传它自己的状态**——旧实现一律返回 M，目录里新增了文件也标 M（橙），
 *    「A=绿」的状态语义在父级就断了；
 * 2. 目录名与角标同色（渲染在 CodeTreePanel，用同一张 STATUS_UI 表）。
 *
 * 聚合只扫 git status 的 files[]（变更集通常几十条，线性一遍即可），
 * 不为父目录递归扫盘。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { aggregateGitDirStatus } from '../src/utils/gitTreeStatus.ts';
import type { GitStatusFile } from '../src/types.ts';

function f(path: string, status: GitStatusFile['status']): GitStatusFile {
  return { path, status, staged: false, added: 1, removed: 0 };
}

test('aggregateGitDirStatus：目录下恰好一个变更文件 → 透传该文件的状态', () => {
  // 旧实现这里返回 M——「新增了文件」读成「修改过」，父级颜色就全成一个色了
  assert.equal(aggregateGitDirStatus([f('scripts/release.mjs', 'A')], 'scripts'), 'A');
  assert.equal(aggregateGitDirStatus([f('scripts/release.mjs', '?')], 'scripts'), '?');
  assert.equal(aggregateGitDirStatus([f('scripts/release.mjs', 'D')], 'scripts'), 'D');
  assert.equal(aggregateGitDirStatus([f('scripts/release.mjs', 'M')], 'scripts'), 'M');
});

test('aggregateGitDirStatus：目录下多个变更文件 → 聚合为 M（哪怕全是 A）', () => {
  const files = [f('scripts/a.mjs', 'A'), f('scripts/b.mjs', 'A')];
  assert.equal(aggregateGitDirStatus(files, 'scripts'), 'M');
});

test('aggregateGitDirStatus：子树里有冲突 → U 压过一切', () => {
  assert.equal(aggregateGitDirStatus([f('scripts/a.mjs', 'U')], 'scripts'), 'U');
  assert.equal(
    aggregateGitDirStatus([f('scripts/a.mjs', 'M'), f('scripts/sub/b.mjs', 'U')], 'scripts'),
    'U',
  );
});

test('aggregateGitDirStatus：任意深度的子路径都算子树；目录自身/兄弟路径不算', () => {
  const files = [
    f('packages/forge-ui/src/App.vue', 'M'),
    f('packages/forge-core/index.ts', 'A'),
    f('packages/README.md', '?'),
  ];
  assert.equal(aggregateGitDirStatus(files, 'packages/forge-ui/src'), 'M');
  assert.equal(aggregateGitDirStatus(files, 'packages/forge-ui'), 'M');
  assert.equal(aggregateGitDirStatus(files, 'packages/forge-core'), 'A');
  assert.equal(aggregateGitDirStatus(files, 'packages'), 'M', '三个变更文件 → 聚合 M，不透传单个状态');
  // 前缀字符串相同的兄弟目录不能误伤（packages-x 不是 packages 的子树）
  assert.equal(aggregateGitDirStatus([f('packages-x/a.ts', 'M')], 'packages'), null);
  // 与目录同名的**文件**不在 `dir/` 前缀下，不算
  assert.equal(aggregateGitDirStatus([f('packages', 'M')], 'packages'), null);
  assert.equal(aggregateGitDirStatus(files, 'docs'), null);
});

test('aggregateGitDirStatus：空变更集 / 无关目录 → null（不渲染角标）', () => {
  assert.equal(aggregateGitDirStatus([], 'scripts'), null);
  assert.equal(aggregateGitDirStatus([f('other/a.ts', 'M')], 'scripts'), null);
});
