/**
 * forge-core 冒烟测试。
 *
 * 使用 Node 内置 test runner（node:test）+ Node 24 原生 TS 类型剥离运行，
 * 不引入额外测试框架。验证骨架可编译、可导入、类型与 schema 对齐。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FORGE_CORE_VERSION, type ProjectRecord, type SessionRecord } from '../src/index.ts';

test('forge-core 冒烟：导出版本号', () => {
  assert.equal(typeof FORGE_CORE_VERSION, 'string');
  assert.equal(FORGE_CORE_VERSION, '0.1.0');
});

test('forge-core 冒烟：ProjectRecord 与 schema 字段对齐', () => {
  const project: ProjectRecord = {
    path: 'C:/demo/proj',
    alias: 'proj',
    createdAt: '2026-01-01T00:00:00.000Z',
    lastOpenedAt: null,
    trustState: 'untrusted',
  };
  assert.equal(project.trustState, 'untrusted');
  assert.equal(project.lastOpenedAt, null);
});

test('forge-core 冒烟：SessionRecord 与 schema 字段对齐', () => {
  const session: SessionRecord = {
    sessionId: 'sess-001',
    projectPath: 'C:/demo/proj',
    alias: null,
    lastActiveAt: '2026-01-01T00:00:00.000Z',
    createdAt: '2026-01-01T00:00:00.000Z',
    modelOverride: null,
  };
  assert.equal(session.sessionId, 'sess-001');
  assert.equal(session.modelOverride, null);
});