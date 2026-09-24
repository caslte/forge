/**
 * startupUpdate 编排单测（docs/prd/07_installer_update.md IN-F02/IN-F04）：
 * - 首启补缺只增不删（既有项保留、缺失项逐项 install）、成功置 preinstallDone
 * - 幂等（第二次 run 不再调用 install）
 * - 任一 install 失败标志保持 false，联动检查仍继续
 * - 版本变化触发联动并回写 lastRunForgeVersion/components/lastUpdateCheckAt
 * - 版本相同不触发；首次运行（lastRunForgeVersion=null）只回写不触发联动
 * - 联动失败保留旧标志；runCli/extensionUpdater 抛异常不向外抛
 * 全部注入 fake runCli/extensionUpdater（临时目录），不碰真实 CLI/npm/网络。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  createStartupUpdate,
  recordManualComponentUpdate,
  touchLastUpdateCheckAt,
} from '../../src/pi/startupUpdate.ts';
import { RECOMMENDED_PLUGINS, missingRecommended } from '../../src/pi/recommendedPlugins.ts';
import { readUpdaterState, writeUpdaterState, type UpdaterState } from '../../src/pi/updaterState.ts';

const NOW_ISO = '2026-09-08T08:00:00.000Z';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** 建临时 agent 目录：settings.json + 可选 npm 实体版本 */
function makeAgentDir(packages: string[], entities: Record<string, string> = {}): string {
  const dir = tmpDir('forge-startup-agent-');
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ packages }), 'utf8');
  for (const [name, version] of Object.entries(entities)) {
    const pkgDir = path.join(dir, 'npm', 'node_modules', ...name.split('/'));
    fs.mkdirSync(pkgDir, { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'package.json'), JSON.stringify({ name, version }), 'utf8');
  }
  return dir;
}

function baseState(extra: Partial<UpdaterState> = {}): UpdaterState {
  return {
    schemaVersion: 1,
    lastRunForgeVersion: null,
    preinstallDone: false,
    preinstallDoneAt: null,
    lastUpdateCheckAt: null,
    components: {},
    ...extra,
  };
}

interface Fake {
  statePath: string;
  cliCalls: string[][];
  updaterCalls: number;
  logs: string[];
  run: () => Promise<void>;
}

function setup(opts: {
  agentDir: string;
  /** 复用既有 statePath（幂等/联动场景），否则新建临时目录并可选写入初始 state */
  statePath?: string;
  state?: UpdaterState;
  currentVersion?: string;
  /** 按 包名 判定该次 install 失败 */
  cliFail?: (pkg: string) => boolean;
  /** runCli 抛异常（进程级故障） */
  cliThrow?: boolean;
  /** extensionUpdater 返回失败 */
  updaterFail?: boolean;
  /** extensionUpdater 抛异常 */
  updaterThrow?: boolean;
}): Fake {
  const statePath = opts.statePath ?? path.join(tmpDir('forge-startup-state-'), 'updater-state.json');
  if (!opts.statePath && opts.state) writeUpdaterState(statePath, opts.state);
  // 单一对象：闭包内递增/push 必须与返回给测试的引用同源（展开拷贝会让计数器快照失真）
  const fake: Fake = { statePath, cliCalls: [], updaterCalls: 0, logs: [], run: async () => {} };
  const handle = createStartupUpdate({
    statePath,
    agentDir: opts.agentDir,
    currentVersion: opts.currentVersion ?? '0.2.0',
    runCli: async (args) => {
      fake.cliCalls.push(args);
      if (opts.cliThrow) throw new Error('cli boom');
      const pkg = args[1] ?? '';
      if (opts.cliFail?.(pkg)) return { ok: false, output: `E404 ${pkg}` };
      return { ok: true, output: `installed ${pkg}` };
    },
    extensionUpdater: async () => {
      fake.updaterCalls += 1;
      if (opts.updaterThrow) throw new Error('updater boom');
      if (opts.updaterFail) return { ok: false, output: 'network down' };
      return { ok: true, output: 'updated' };
    },
    now: () => new Date(NOW_ISO),
    logger: (line) => fake.logs.push(line),
  });
  fake.run = () => handle.run();
  return fake;
}

test('recommendedPlugins：清单 7 项；missingRecommended 保持推荐顺序且跳过已装项', () => {
  assert.equal(RECOMMENDED_PLUGINS.length, 7);
  assert.ok(RECOMMENDED_PLUGINS.includes('@tintinweb/pi-subagents'));
  assert.ok(RECOMMENDED_PLUGINS.includes('pi-memory'));
  // Path 2：rpiv-ask-user-question 必须**不在**清单里 —— forge 已自建同名工具
  // （@forge/extensions 的 ask_user_question），继续预装会让用户环境里出现两个同名
  // 工具（虽然运行时由 extensionsOverride 屏蔽，也不该再给新用户装）。
  assert.equal(
    RECOMMENDED_PLUGINS.includes('@juicesharp/rpiv-ask-user-question'),
    false,
    '已从推荐清单移除，防止与新自建 ask_user_question 扩展重名',
  );
  // 已从 forge 推荐清单移除（由宿主 pi CLI / 用户自装）：
  assert.equal(RECOMMENDED_PLUGINS.includes('@vndv/pi-codegraph'), false);
  assert.equal(RECOMMENDED_PLUGINS.includes('pi-image-view'), false);
  assert.equal(RECOMMENDED_PLUGINS.includes('pi-tool-display'), false);
  assert.equal(RECOMMENDED_PLUGINS.includes('@dietrichgebert/ponytail'), false);
  const missing = missingRecommended(['pi-mcp-adapter', 'pi-web-access']);
  assert.deepEqual(missing, [
    '@tintinweb/pi-subagents',
    '@narumitw/pi-goal',
    'pi-compact-display',
    '@juicesharp/rpiv-todo',
    'pi-memory',
  ]);
});

test('首启预装：缺失项逐项 install、既有项保留、settings 不被直接改动；成功置标志 + 快照 + 回写版本', async () => {
  const agentDir = makeAgentDir(
    ['npm:pi-mcp-adapter', 'npm:@user/custom'],
    { 'pi-mcp-adapter': '2.32.1', '@user/custom': '1.0.0' },
  );
  const settingsBefore = fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8');
  const h = setup({ agentDir, currentVersion: '0.2.0' });
  await h.run();

  // 缺失项 = 推荐清单顺序中除已装 pi-mcp-adapter 外的其余项；@user/custom 不在推荐清单、不受影响
  const expected = RECOMMENDED_PLUGINS.filter((n) => n !== 'pi-mcp-adapter');
  assert.deepEqual(h.cliCalls, expected.map((pkg) => ['install', pkg, '--no-approve']));
  // 只增不删：编排不直接改 settings.json（补装由内置 CLI 负责）
  assert.equal(fs.readFileSync(path.join(agentDir, 'settings.json'), 'utf8'), settingsBefore);

  const state = readUpdaterState(h.statePath);
  assert.equal(state.preinstallDone, true);
  assert.equal(state.preinstallDoneAt, NOW_ISO);
  // components 快照：既有实体版本保留
  assert.deepEqual(state.components, { 'pi-mcp-adapter': '2.32.1', '@user/custom': '1.0.0' });
  // 首次运行：只回写版本，不触发联动
  assert.equal(state.lastRunForgeVersion, '0.2.0');
  assert.equal(h.updaterCalls, 0);
  // 结构化日志：预装明细（来源=预装）
  assert.ok(
    h.logs.some((l) => l.startsWith('[预装] pi-web-access ') && l.endsWith('(来源=预装)')),
    `logs=${JSON.stringify(h.logs)}`,
  );
});

test('预装幂等：成功后第二次 run 不再调用 install', async () => {
  const agentDir = makeAgentDir([]);
  const first = setup({ agentDir });
  await first.run();
  assert.equal(first.cliCalls.length, RECOMMENDED_PLUGINS.length);
  assert.equal(readUpdaterState(first.statePath).preinstallDone, true);

  const second = setup({ agentDir, statePath: first.statePath });
  await second.run();
  assert.equal(second.cliCalls.length, 0);
  assert.equal(readUpdaterState(first.statePath).preinstallDone, true);
});

test('预装失败：标志保持 false（其余项仍尝试），后续联动检查继续执行', async () => {
  const agentDir = makeAgentDir([]);
  const h = setup({
    agentDir,
    state: baseState({ lastRunForgeVersion: '0.1.0' }), // 非首次 → 预装后联动检查继续
    currentVersion: '0.2.0',
    cliFail: (pkg) => pkg === 'pi-web-access',
  });
  await h.run();

  // 失败不中断：全部缺失项都被尝试
  assert.equal(h.cliCalls.length, RECOMMENDED_PLUGINS.length);
  const state = readUpdaterState(h.statePath);
  assert.equal(state.preinstallDone, false);
  assert.equal(state.preinstallDoneAt, null);
  // 联动检查继续：版本变化触发 extensionUpdater 并回写版本
  assert.equal(h.updaterCalls, 1);
  assert.equal(state.lastRunForgeVersion, '0.2.0');
  assert.ok(h.logs.some((l) => l.includes('[静默] 预装失败：pi-web-access')), JSON.stringify(h.logs));
});

test('版本变化联动：触发 extensionUpdater、回写 lastRunForgeVersion/components/lastUpdateCheckAt、记录变更明细', async () => {
  const agentDir = makeAgentDir(['npm:pi-mcp-adapter', 'npm:@user/custom'], {
    'pi-mcp-adapter': '2.32.1',
    '@user/custom': '1.0.0',
  });
  const h = setup({
    agentDir,
    state: baseState({
      preinstallDone: true,
      lastRunForgeVersion: '0.1.0',
      components: { 'pi-mcp-adapter': '2.0.0', '@gone/old': '9.9.9' },
    }),
    currentVersion: '0.2.0',
  });
  await h.run();

  assert.equal(h.updaterCalls, 1);
  assert.equal(h.cliCalls.length, 0); // preinstallDone=true：不预装
  const state = readUpdaterState(h.statePath);
  assert.equal(state.lastRunForgeVersion, '0.2.0');
  assert.equal(state.lastUpdateCheckAt, NOW_ISO);
  // 快照整体刷新（旧 @gone/old 移除、新版本写入）
  assert.deepEqual(state.components, { 'pi-mcp-adapter': '2.32.1', '@user/custom': '1.0.0' });
  assert.ok(
    h.logs.includes('[组件更新] pi-mcp-adapter 2.0.0 → 2.32.1 (来源=联动)'),
    `logs=${JSON.stringify(h.logs)}`,
  );
  assert.ok(h.logs.some((l) => l.includes('@user/custom') && l.includes('未安装')), JSON.stringify(h.logs));
});

test('版本未变化：不触发联动、不改写状态', async () => {
  const agentDir = makeAgentDir([]);
  const h = setup({
    agentDir,
    state: baseState({
      preinstallDone: true,
      lastRunForgeVersion: '0.2.0',
      preinstallDoneAt: '2026-01-01T00:00:00.000Z',
    }),
    currentVersion: '0.2.0',
  });
  await h.run();
  assert.equal(h.updaterCalls, 0);
  assert.equal(h.cliCalls.length, 0);
  const state = readUpdaterState(h.statePath);
  assert.equal(state.preinstallDoneAt, '2026-01-01T00:00:00.000Z');
  assert.equal(state.lastUpdateCheckAt, null);
});

test('首次运行（lastRunForgeVersion=null）：不触发联动，只回写版本标志', async () => {
  const agentDir = makeAgentDir(['npm:pi-mcp-adapter'], { 'pi-mcp-adapter': '2.32.1' });
  const h = setup({
    agentDir,
    state: baseState({ preinstallDone: true }), // 预装已完成，跳过预装阶段
    currentVersion: '0.2.0',
  });
  await h.run();
  assert.equal(h.updaterCalls, 0);
  const state = readUpdaterState(h.statePath);
  assert.equal(state.lastRunForgeVersion, '0.2.0');
  assert.equal(state.lastUpdateCheckAt, null); // 未联动，不更新检查时间
});

test('联动失败：保留旧 lastRunForgeVersion/components，静默记录', async () => {
  const agentDir = makeAgentDir(['npm:pi-mcp-adapter'], { 'pi-mcp-adapter': '2.32.1' });
  const h = setup({
    agentDir,
    state: baseState({
      preinstallDone: true,
      lastRunForgeVersion: '0.1.0',
      components: { 'pi-mcp-adapter': '2.0.0' },
    }),
    currentVersion: '0.2.0',
    updaterFail: true,
  });
  await h.run();
  assert.equal(h.updaterCalls, 1);
  const state = readUpdaterState(h.statePath);
  assert.equal(state.lastRunForgeVersion, '0.1.0');
  assert.deepEqual(state.components, { 'pi-mcp-adapter': '2.0.0' });
  assert.equal(state.lastUpdateCheckAt, null);
  assert.ok(h.logs.some((l) => l.startsWith('[静默] 联动更新失败')), JSON.stringify(h.logs));
});

test('异常安全：runCli/extensionUpdater 抛异常时 run() 不向外抛、状态保留', async () => {
  const agentDir = makeAgentDir(['npm:pi-mcp-adapter'], { 'pi-mcp-adapter': '2.32.1' });
  const h = setup({
    agentDir,
    state: baseState({ lastRunForgeVersion: '0.1.0' }),
    currentVersion: '0.2.0',
    cliThrow: true,
    updaterThrow: true,
  });
  await assert.doesNotReject(h.run());
  const state = readUpdaterState(h.statePath);
  assert.equal(state.preinstallDone, false); // 预装未完成（下次重试）
  assert.equal(state.preinstallDoneAt, null);
  assert.equal(state.lastRunForgeVersion, '0.1.0'); // 联动异常保留旧标志
  assert.ok(h.logs.some((l) => l.startsWith('[静默]')), JSON.stringify(h.logs));
});

// —— QA-G1：手动更新（pi/updatePlugins）成功后的快照刷新 +「来源=手动」结构化日志 ——

test('recordManualComponentUpdate：读旧快照比对 → 刷新 components + 旧→新日志（来源=手动）', () => {
  const agentDir = makeAgentDir(['npm:pi-mcp-adapter', 'npm:@user/custom'], {
    'pi-mcp-adapter': '2.32.1',
    '@user/custom': '1.0.0',
  });
  const statePath = path.join(tmpDir('forge-startup-state-'), 'updater-state.json');
  writeUpdaterState(
    statePath,
    baseState({ preinstallDone: true, components: { 'pi-mcp-adapter': '2.0.0' } }),
  );
  const logs: string[] = [];
  recordManualComponentUpdate({ statePath, agentDir, logger: (l) => logs.push(l) });

  // components 快照刷新为最新实体版本（既有项更新 + 新装项写入，其余字段透传）
  const state = readUpdaterState(statePath);
  assert.deepEqual(state.components, { 'pi-mcp-adapter': '2.32.1', '@user/custom': '1.0.0' });
  assert.equal(state.preinstallDone, true);
  assert.equal(state.lastRunForgeVersion, null);
  // 结构化日志：格式与联动路径对齐（[组件更新] 包名 旧 → 新），来源=手动
  assert.ok(
    logs.includes('[组件更新] pi-mcp-adapter 2.0.0 → 2.32.1 (来源=手动)'),
    `logs=${JSON.stringify(logs)}`,
  );
  assert.ok(
    logs.some((l) => l.startsWith('[组件更新] @user/custom 未安装 → 1.0.0 (来源=手动)')),
    `logs=${JSON.stringify(logs)}`,
  );
  // 版本未变化的包不重复记录
  assert.ok(!logs.some((l) => l.includes('2.32.1 → 2.32.1')), JSON.stringify(logs));
});

test('recordManualComponentUpdate：statePath=null 跳过持久化、仅输出日志（既有单测兼容）', () => {
  const agentDir = makeAgentDir(['npm:pi-mcp-adapter'], { 'pi-mcp-adapter': '2.32.1' });
  const logs: string[] = [];
  assert.doesNotThrow(() =>
    recordManualComponentUpdate({ statePath: null, agentDir, logger: (l) => logs.push(l) }),
  );
  assert.ok(
    logs.some((l) => l.includes('pi-mcp-adapter') && l.endsWith('(来源=手动)')),
    `logs=${JSON.stringify(logs)}`,
  );
});

test('recordManualComponentUpdate：快照写入失败不外抛（手动更新成功语义不受影响）', () => {
  const agentDir = makeAgentDir(['npm:pi-mcp-adapter'], { 'pi-mcp-adapter': '2.32.1' });
  // 同名目录占位 statePath：readUpdaterState 降级为默认值，writeUpdaterState rename 失败
  const dir = tmpDir('forge-startup-state-');
  fs.mkdirSync(path.join(dir, 'updater-state.json'));
  const logs: string[] = [];
  assert.doesNotThrow(() =>
    recordManualComponentUpdate({
      statePath: path.join(dir, 'updater-state.json'),
      agentDir,
      logger: (l) => logs.push(l),
    }),
  );
  assert.ok(logs.some((l) => l.includes('(来源=手动)')), JSON.stringify(logs));
});

// —— QA-G4：应用更新检查成功后回写 lastUpdateCheckAt ——

test('touchLastUpdateCheckAt：成功回写 lastUpdateCheckAt、其余字段透传；statePath=null 跳过', () => {
  const statePath = path.join(tmpDir('forge-startup-state-'), 'updater-state.json');
  writeUpdaterState(
    statePath,
    baseState({ lastRunForgeVersion: '0.1.0', components: { 'pi-mcp-adapter': '2.0.0' } }),
  );
  touchLastUpdateCheckAt(statePath, () => new Date(NOW_ISO));
  const state = readUpdaterState(statePath);
  assert.equal(state.lastUpdateCheckAt, NOW_ISO);
  assert.equal(state.lastRunForgeVersion, '0.1.0');
  assert.deepEqual(state.components, { 'pi-mcp-adapter': '2.0.0' });

  // null：不抛错、无路径可写（缺省跳过持久化）
  assert.doesNotThrow(() => touchLastUpdateCheckAt(null, () => new Date(NOW_ISO)));
});
