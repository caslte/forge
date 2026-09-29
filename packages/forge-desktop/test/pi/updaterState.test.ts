/**
 * updaterState 单测（docs/db/07_installer/schema.md）：
 * - 文件缺失 → 全默认值（seed）
 * - 正常往返（原子写后读回一致）
 * - 损坏 JSON / 字段类型损坏 → 全默认值重建
 * - updateComponents 纯函数（增量合并、null 移除、不改入参）
 * - 原子写不留 tmp 残留、重复写覆盖
 * 全部用临时目录，不碰真实 userData。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  defaultUpdaterStatePath,
  readUpdaterState,
  updateComponents,
  writeUpdaterState,
  type UpdaterState,
} from '../../src/pi/updaterState.ts';

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'forge-updater-state-'));
}

function defaults(extra: Partial<UpdaterState> = {}): UpdaterState {
  return {
    schemaVersion: 1,
    lastRunForgeVersion: null,
    preinstallDone: false,
    preinstallDoneAt: null,
    preinstallListVersion: 0,
    lastUpdateCheckAt: null,
    components: {},
    ...extra,
  };
}

test('readUpdaterState：文件缺失 → 全默认值（schema.md seed）', () => {
  const statePath = path.join(tmpDir(), 'updater-state.json');
  assert.deepEqual(readUpdaterState(statePath), defaults());
});

test('readUpdaterState：正常往返（写入后读回一致）', () => {
  const statePath = path.join(tmpDir(), 'updater-state.json');
  const state = defaults({
    lastRunForgeVersion: '0.1.0',
    preinstallDone: true,
    preinstallDoneAt: '2026-09-08T00:00:00.000Z',
    lastUpdateCheckAt: '2026-09-08T01:00:00.000Z',
    components: { 'pi-mcp-adapter': '2.32.1', '@user/custom': '1.0.0' },
  });
  writeUpdaterState(statePath, state);
  assert.deepEqual(readUpdaterState(statePath), state);
});

test('readUpdaterState：损坏 JSON → 全默认值重建', () => {
  const statePath = path.join(tmpDir(), 'updater-state.json');
  fs.writeFileSync(statePath, '{ schemaVersion: 1, broken', 'utf8');
  assert.deepEqual(readUpdaterState(statePath), defaults());
});

test('readUpdaterState：字段类型损坏（schemaVersion 非数字 / components 非对象）→ 全默认值重建', () => {
  const statePath = path.join(tmpDir(), 'updater-state.json');
  fs.writeFileSync(
    statePath,
    JSON.stringify({ schemaVersion: 'x', preinstallDone: 'yes', components: [] }),
    'utf8',
  );
  assert.deepEqual(readUpdaterState(statePath), defaults());
});

test('readUpdaterState：老状态文件缺 preinstallListVersion → 不算损坏，其余字段保留、该值归 0', () => {
  const statePath = path.join(tmpDir(), 'updater-state.json');
  // v2 之前的真实形态：无 preinstallListVersion 字段
  fs.writeFileSync(
    statePath,
    JSON.stringify({
      schemaVersion: 1,
      lastRunForgeVersion: '0.1.11',
      preinstallDone: true,
      preinstallDoneAt: '2026-09-08T00:00:00.000Z',
      lastUpdateCheckAt: null,
      components: { 'pi-mcp-adapter': '2.32.1' },
    }),
    'utf8',
  );
  const state = readUpdaterState(statePath);
  assert.equal(state.preinstallListVersion, 0);
  assert.equal(state.preinstallDone, true); // 不被整份重置——缺可选字段只归 0
  assert.equal(state.lastRunForgeVersion, '0.1.11');
  assert.deepEqual(state.components, { 'pi-mcp-adapter': '2.32.1' });
});

test('updateComponents：增量合并为纯函数（版本写入、null 移除、不改入参）', () => {
  const base = defaults({ components: { a: '1.0.0', b: '2.0.0' } });
  const next = updateComponents(base, { b: '2.1.0', c: '0.1.0', a: null });
  assert.deepEqual(next.components, { b: '2.1.0', c: '0.1.0' });
  // 纯函数：入参 components 未被修改
  assert.deepEqual(base.components, { a: '1.0.0', b: '2.0.0' });
  // 其余字段透传
  assert.equal(next.schemaVersion, base.schemaVersion);
  assert.equal(next.preinstallDone, base.preinstallDone);
  assert.equal(next.lastRunForgeVersion, base.lastRunForgeVersion);
});

test('updateComponents：空 changes 返回等值快照（新对象）', () => {
  const base = defaults({ components: { a: '1.0.0' } });
  const next = updateComponents(base, {});
  assert.deepEqual(next.components, { a: '1.0.0' });
  assert.notEqual(next.components, base.components);
});

test('writeUpdaterState：原子写不留 tmp 残留，重复写覆盖旧值', () => {
  const dir = tmpDir();
  const statePath = path.join(dir, 'updater-state.json');
  writeUpdaterState(statePath, defaults());
  writeUpdaterState(statePath, defaults({ preinstallDone: true }));
  assert.equal(readUpdaterState(statePath).preinstallDone, true);
  const leftovers = fs.readdirSync(dir).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('defaultUpdaterStatePath：接收调用方传入的 userData 目录并拼文件名', () => {
  const p = defaultUpdaterStatePath(path.join('some', 'userData'));
  assert.equal(path.basename(p), 'updater-state.json');
  assert.equal(path.dirname(p), path.join('some', 'userData'));
});
