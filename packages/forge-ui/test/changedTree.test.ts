/**
 * 模块 12：变更视图「级联模式」的目录树构建（纯函数）单测。
 *
 * 平铺清单几十个文件时目录归属全靠右侧尾巴读，用户 2026-10-03 要求按目录
 * 分层展示（VSCode 源代码管理树视图同款）。这里钉三件事：
 * 1. 分组与排序：目录在前、文件在后，各自按名称字典序；嵌套目录逐层建节点；
 * 2. 目录聚合状态：单文件透传自身状态、多文件聚合 M、冲突 U 压一切——
 *    与文件树的 aggregateGitDirStatus 同一条口径，两处各写各的就会两个色；
 * 3. count：目录行右侧的「子树内变更文件数」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildChangedTree } from '../src/utils/changedTree.ts';
import type { GitStatusFile } from '../src/types.ts';

function f(path: string, status: GitStatusFile['status']): GitStatusFile {
  return { path, status, staged: false, added: 1, removed: 0 };
}

test('buildChangedTree：按目录分组，目录在前文件在后，各自按名称排序', () => {
  const tree = buildChangedTree([
    f('packages/forge-ui/src/App.vue', 'M'),
    f('README.md', '?'),
    f('docs/api/01.md', 'M'),
    f('docs/prd/12.md', 'A'),
  ]);
  // 顶层：docs、packages 两个目录 + README.md 一个文件（目录优先，再按名称）
  assert.deepEqual(
    tree.map((n) => `${n.kind}:${n.name}`),
    ['dir:docs', 'dir:packages', 'file:README.md'],
  );
  // docs 内部：api、prd 两个子目录（字典序）
  const docs = tree[0]!;
  if (docs.kind !== 'dir') return assert.fail('docs 应是目录节点');
  assert.deepEqual(docs.children.map((n) => n.name), ['api', 'prd']);
});

test('buildChangedTree：深层嵌套逐层建节点，目录 relPath 是完整路径', () => {
  const tree = buildChangedTree([f('packages/forge-core/src/file/a.ts', 'A')]);
  const packages = tree[0]!;
  assert.equal(packages.kind, 'dir');
  assert.equal(packages.relPath, 'packages');
  if (packages.kind !== 'dir') return;
  const forgeCore = packages.children[0]!;
  assert.deepEqual([forgeCore.kind, forgeCore.name, forgeCore.relPath], ['dir', 'forge-core', 'packages/forge-core']);
});

test('buildChangedTree：目录聚合状态——单文件透传、多文件聚合 M、U 压一切', () => {
  const tree = buildChangedTree([
    f('a/one.ts', 'A'),
    f('b/x.ts', 'M'),
    f('b/y.ts', 'A'),
    f('c/z.ts', 'U'),
  ]);
  const byName = new Map(tree.map((n) => [n.name, n]));
  assert.equal(byName.get('a') && byName.get('a')!.kind === 'dir' ? byName.get('a')!.status : null, 'A');
  assert.equal(byName.get('b') && byName.get('b')!.kind === 'dir' ? byName.get('b')!.status : null, 'M');
  assert.equal(byName.get('c') && byName.get('c')!.kind === 'dir' ? byName.get('c')!.status : null, 'U');
});

test('buildChangedTree：深层子树的聚合向上冒泡（多文件 → M）', () => {
  const tree = buildChangedTree([
    f('p/x/one.ts', 'A'),
    f('p/y/two.ts', 'M'),
  ]);
  const p = tree[0]!;
  if (p.kind !== 'dir') return assert.fail();
  assert.equal(p.status, 'M', 'p 下有两个变更文件 → M');
  assert.equal(p.count, 2);
  // 但 x 子目录只有一个文件 → 透传 A
  const x = p.children.find((n) => n.name === 'x')!;
  assert.equal(x.kind === 'dir' ? x.status : null, 'A');
});

test('buildChangedTree：count 是子树内变更文件数', () => {
  const tree = buildChangedTree([
    f('p/x/one.ts', 'A'),
    f('p/x/two.ts', 'M'),
    f('p/three.ts', '?'),
  ]);
  const p = tree[0]!;
  assert.equal(p.kind === 'dir' ? p.count : null, 3);
});

test('buildChangedTree：空变更集 → 空树', () => {
  assert.deepEqual(buildChangedTree([]), []);
});
