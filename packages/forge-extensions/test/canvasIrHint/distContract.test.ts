/**
 * dist 与 src 一致性锁。
 *
 * ## 为什么要单独一个测试
 *
 * `@forge/extensions` 的 package.json `exports` 指向 `./dist/index.js`——**forge-desktop
 * 运行时 import 的是 dist，不是 src**。于是「改了 src、忘了重新构建」会让 dev 一直跑在
 * 旧产物上，而且**完全静默**：没有报错、没有警告，只是行为悄悄停留在上一版。
 *
 * 2026-10-13 实测踩到：`canvasIrHint/promptIr.ts` 早已从「手抄契约」改成「由 schema 派生」
 * （v2），但 dist 仍是 v1 手抄版，仍写着 `forge-ir/1`。后果是**开关一开就 100% 失败**——
 * 提示词告诉模型产 v1，校验器要求 v2。而既有单测全都 import `src`，一个都没发现。
 *
 * 本测试刻意走**包名**（`@forge/extensions`）而不是相对路径 `../../src/...`，
 * 因为只有走包名才会经 node_modules 软链 → package.json exports → **dist**，
 * 也就是生产真正加载的那份代码。这是唯一能锁住「dist 漂移」的入口。
 *
 * 前置条件：需先构建（`npm run build -w @forge/extensions`）。CI 与 `npm test` 都先构建，
 * 故这里不做跳过——dist 缺失就该是红的，静默跳过等于把锁拆掉。
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { IR_DIAGRAM_TYPES, IR_SCHEMA_VERSION } from '@forge/core/markdown';

// 动态 import 以便在 dist 缺失时给出**可操作**的报错，而不是一句 ERR_MODULE_NOT_FOUND。
let dist: {
  IR_SPEC: readonly string[];
  IR_STANZA: string;
  IR_FENCE_LANGUAGE: string;
};
try {
  dist = (await import('@forge/extensions')) as unknown as typeof dist;
} catch (err) {
  throw new Error(
    '无法从 dist 加载 @forge/extensions —— 多半是还没构建。\n' +
      '请先跑：npm run build -w @forge/extensions\n' +
      '原始错误：' +
      (err instanceof Error ? err.message : String(err)),
  );
}

test('dist 的契约版本与 @forge/core 的 schema 版本一致（锁住 dist 漂移）', () => {
  const spec = dist.IR_SPEC.join('\n');
  assert.ok(
    spec.includes(IR_SCHEMA_VERSION),
    `dist 里注入的契约版本不是 ${IR_SCHEMA_VERSION}——dist 与 src 漂移了。\n` +
      '重新构建：npm run build -w @forge/extensions\n' +
      '（这正是 2026-10-13 那次事故：dist 停留在 forge-ir/1，开关一开就 100% 失败）',
  );
});

test('dist 的契约覆盖全部四类图（不多承诺、不少承诺）', () => {
  const spec = dist.IR_SPEC.join('\n');
  const headers = [...spec.matchAll(/^- "([a-z]+)" — /gm)].map((m) => m[1]!);
  assert.deepEqual(
    [...headers].sort(),
    [...IR_DIAGRAM_TYPES].sort(),
    'dist 契约里的类型清单必须与 schema 完全一致',
  );
});

test('dist 的常驻段非空且提到围栏名', () => {
  assert.ok(dist.IR_STANZA.length > 0, 'IR_STANZA 不能为空，否则常驻段形同虚设');
  assert.ok(
    dist.IR_STANZA.includes(dist.IR_FENCE_LANGUAGE),
    '常驻段必须提到围栏名，否则模型不知道用什么围栏',
  );
});
