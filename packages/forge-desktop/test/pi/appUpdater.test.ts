/**
 * appUpdater 单测（IN-S03 后端，docs/api/07_pi.md §3-5 / PRD 07 IN-F03）：
 * - 状态机 idle → checking → found → downloading → downloaded → installing，失败回 idle
 * - 四个 RPC 信封与错误码 6003（检查失败）/6004（下载或校验失败）/6005（安装启动失败）
 * - 任意跃迁 emit updater.stateChanged（含下载进度步进），payload 与 getState.data 同构
 * 全部注入 fake autoUpdaterLike + fake emit，不碰真实网络 / electron-updater。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createAppUpdaterPort,
  createUpdaterMethods,
  type AppUpdaterPort,
  type AppUpdaterSnapshot,
  type AutoUpdaterLike,
} from '../../src/pi/appUpdater.ts';
import { FORGE_EVENTS } from '../../src/ipc-contract.ts';

type Listener = (info: unknown) => void;

/** fake autoUpdater：手工触发 electron-updater 同名事件；调用计数可断言（不碰网络） */
class FakeAutoUpdater implements AutoUpdaterLike {
  checkForUpdatesCalls = 0;
  downloadUpdateCalls = 0;
  quitAndInstallCalls = 0;
  /** 非空时 checkForUpdates 抛错（模拟网络失败） */
  checkError: Error | null = null;
  /** 非空时 downloadUpdate 抛错（模拟下载/校验失败） */
  downloadError: Error | null = null;
  /** 非空时 quitAndInstall 抛错（模拟安装启动失败） */
  quitError: Error | null = null;
  /** checkForUpdates 时同步发出的事件：非空 = update-available(version)，空 = update-not-available */
  availableVersion: string | null = null;

  private listeners = new Map<string, Listener[]>();

  on(event: string, listener: Listener): unknown {
    const list = this.listeners.get(event) ?? [];
    list.push(listener);
    this.listeners.set(event, list);
    return this;
  }

  /** 测试手动派发 electron-updater 事件 */
  fire(event: string, info: unknown): void {
    for (const fn of this.listeners.get(event) ?? []) fn(info);
  }

  async checkForUpdates(): Promise<unknown> {
    this.checkForUpdatesCalls++;
    if (this.checkError) throw this.checkError;
    // 与 electron-updater 真实时序一致：事件在 promise resolve 前发出
    if (this.availableVersion !== null) {
      this.fire('update-available', { version: this.availableVersion });
    } else {
      this.fire('update-not-available', { version: '0.1.0' });
    }
    return { version: this.availableVersion };
  }

  async downloadUpdate(): Promise<unknown> {
    this.downloadUpdateCalls++;
    if (this.downloadError) throw this.downloadError;
    return ['C:/dist/forge-setup.exe'];
  }

  quitAndInstall(): void {
    this.quitAndInstallCalls++;
    if (this.quitError) throw this.quitError;
  }
}

interface Harness {
  fake: FakeAutoUpdater;
  /** 全部 emit 记录（只应出现 updater.stateChanged） */
  events: Array<{ event: string; payload: AppUpdaterSnapshot }>;
  port: AppUpdaterPort;
  methods: ReturnType<typeof createUpdaterMethods>;
}

function createHarness(
  opts: {
    currentVersion?: string;
    /** false = 不注入 fake autoUpdaterLike（模拟 dev 未装配 → 6003 静默降级） */
    au?: boolean;
    /** QA-G4：检查成功完成回调（fake 注入，验证被调用时机） */
    onCheckComplete?: () => void;
  } = {},
): Harness {
  const fake = new FakeAutoUpdater();
  const events: Array<{ event: string; payload: AppUpdaterSnapshot }> = [];
  const port = createAppUpdaterPort({
    getCurrentVersion: () => opts.currentVersion ?? '0.1.0',
    autoUpdaterLike: opts.au === false ? null : fake,
    emit: (event, payload) => events.push({ event, payload: payload as AppUpdaterSnapshot }),
    onCheckComplete: opts.onCheckComplete,
  });
  return { fake, events, port, methods: createUpdaterMethods(port) };
}

const idleSnapshot = (currentVersion: string): AppUpdaterSnapshot => ({
  status: 'idle',
  currentVersion,
  latestVersion: null,
  downloadProgress: null,
  error: null,
});

/** 把端口推进到 found（fake 上报 0.2.0） */
async function reachFound(h: Harness): Promise<void> {
  h.fake.availableVersion = '0.2.0';
  const res = await h.methods['updater/checkForUpdates']();
  assert.equal(res.code, 0);
}

test('getState：初始 idle 快照，currentVersion 来自注入', async () => {
  const h = createHarness();
  const res = await h.methods['updater/getState']();
  assert.equal(res.code, 0);
  assert.deepEqual(res.data, idleSnapshot('0.1.0'));
});

test('checkForUpdates：发现新版 → found + latestVersion + 事件 payload 携带同构快照', async () => {
  const h = createHarness();
  h.fake.availableVersion = '0.2.0';
  const res = await h.methods['updater/checkForUpdates']();
  assert.equal(res.code, 0);
  assert.deepEqual(res.data, {
    status: 'found',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    downloadProgress: null,
    error: null,
  });
  // 事件：checking → found 两次跃迁；payload 与返回快照同构
  assert.deepEqual(
    h.events.map((e) => e.payload.status),
    ['checking', 'found'],
  );
  assert.deepEqual(h.events[1]!.payload, res.data);
});

test('checkForUpdates：无新版 → idle（latestVersion=null，无 error）', async () => {
  const h = createHarness(); // availableVersion=null → update-not-available
  const res = await h.methods['updater/checkForUpdates']();
  assert.equal(res.code, 0);
  assert.deepEqual(res.data, idleSnapshot('0.1.0'));
  assert.deepEqual(
    h.events.map((e) => e.payload.status),
    ['checking', 'idle'],
  );
});

test('checkForUpdates：检查失败（fake 抛错）→ 6003 + 状态回 idle 静默', async () => {
  const h = createHarness();
  h.fake.checkError = new Error('ENOTFOUND api.github.com');
  const res = await h.methods['updater/checkForUpdates']();
  assert.equal(res.code, 6003);
  assert.match(res.message, /ENOTFOUND/);
  const snap = res.data as AppUpdaterSnapshot;
  assert.equal(snap.status, 'idle');
  assert.equal(snap.error, 'ENOTFOUND api.github.com');
  assert.equal(snap.latestVersion, null);
});

test('checkForUpdates：已装配但未显式指定 feed（打包内置 app-update.yml）→ 走检查流程', async () => {
  // feed 来源由 main.ts/electron-updater 决定（setFeedURL 或内置 app-update.yml），
  // 端口不因「无显式 feed」而禁用：fake au 注入即应被调用（默认无新版 → idle）
  const h = createHarness();
  const res = await h.methods['updater/checkForUpdates']();
  assert.equal(res.code, 0);
  assert.equal(h.fake.checkForUpdatesCalls, 1, '已装配更新器必须发起检查');
  assert.deepEqual(res.data, idleSnapshot('0.1.0'));
});

test('checkForUpdates：未装配更新器（dev 无 feed）→ 6003 且不触碰网络（fake 调用数为 0）', async () => {
  const h = createHarness({ au: false });
  const res = await h.methods['updater/checkForUpdates']();
  assert.equal(res.code, 6003);
  assert.equal(h.fake.checkForUpdatesCalls, 0, '未装配不得发起网络检查');
  assert.equal((res.data as AppUpdaterSnapshot).status, 'idle');
});

test('checkForUpdates：缺省装配（无 autoUpdaterLike）→ 6003 不抛异常', async () => {
  const events: Array<{ event: string; payload: unknown }> = [];
  const port = createAppUpdaterPort({
    getCurrentVersion: () => '0.0.0-dev',
    emit: (event, payload) => events.push({ event, payload }),
  });
  const methods = createUpdaterMethods(port);
  const state = await methods['updater/getState']();
  assert.deepEqual(state.data, idleSnapshot('0.0.0-dev'));
  const res = await methods['updater/checkForUpdates']();
  assert.equal(res.code, 6003);
});

test('onCheckComplete：检查成功（code 0）回调一次；无新版亦回调；6003 与忙时幂等不回调', async () => {
  let completed = 0;
  const hook = (): void => {
    completed++;
  };

  // 成功发现新版 → 回调恰好 1 次
  const h1 = createHarness({ onCheckComplete: hook });
  h1.fake.availableVersion = '0.2.0';
  assert.equal((await h1.methods['updater/checkForUpdates']()).code, 0);
  assert.equal(completed, 1);

  // 忙时幂等（found 中重复检查）：仍 code 0，但未实际执行检查 → 不回调
  assert.equal((await h1.methods['updater/checkForUpdates']()).code, 0);
  assert.equal(h1.fake.checkForUpdatesCalls, 1);
  assert.equal(completed, 1);

  // 无新版（update-not-available → idle）也是一次成功检查 → 回调
  const h2 = createHarness({ onCheckComplete: hook });
  assert.equal((await h2.methods['updater/checkForUpdates']()).code, 0);
  assert.equal(completed, 2);

  // 网络失败 6003 → 不回调
  const h3 = createHarness({ onCheckComplete: hook });
  h3.fake.checkError = new Error('ENOTFOUND api.github.com');
  assert.equal((await h3.methods['updater/checkForUpdates']()).code, 6003);
  assert.equal(completed, 2);

  // 未装配 6003（不触碰网络）→ 不回调
  const h4 = createHarness({ au: false, onCheckComplete: hook });
  assert.equal((await h4.methods['updater/checkForUpdates']()).code, 6003);
  assert.equal(h4.fake.checkForUpdatesCalls, 0);
  assert.equal(completed, 2);
});

test('downloadUpdate 全流程：found → downloading(0%) → 进度步进 → downloaded，逐跃迁 emit', async () => {
  const h = createHarness();
  await reachFound(h);
  const start = await h.methods['updater/downloadUpdate']();
  assert.equal(start.code, 0);
  assert.equal((start.data as AppUpdaterSnapshot).status, 'downloading');
  assert.equal((start.data as AppUpdaterSnapshot).downloadProgress, 0);
  assert.equal(h.fake.downloadUpdateCalls, 1);

  // 下载进度经事件推送：快照变化 + 每次步进 emit updater.stateChanged
  h.fake.fire('download-progress', { percent: 40 });
  h.fake.fire('download-progress', { percent: 80.5 });
  assert.equal(h.port.getState().downloadProgress, 80.5);
  assert.deepEqual(
    h.events.slice(-2).map((e) => e.payload.downloadProgress),
    [40, 80.5],
  );

  h.fake.fire('update-downloaded', { version: '0.2.0' });
  assert.deepEqual(h.port.getState(), {
    status: 'downloaded',
    currentVersion: '0.1.0',
    latestVersion: '0.2.0',
    downloadProgress: 100,
    error: null,
  });
  // 事件序列：checking → found → downloading → 40 → 80.5 → downloaded
  assert.deepEqual(
    h.events.map((e) => e.payload.status),
    ['checking', 'found', 'downloading', 'downloading', 'downloading', 'downloaded'],
  );
});

test('downloadUpdate：下载失败（promise 拒绝）→ 6004 + 状态回 idle', async () => {
  const h = createHarness();
  await reachFound(h);
  h.fake.downloadError = new Error('checksum mismatch');
  const res = await h.methods['updater/downloadUpdate']();
  assert.equal(res.code, 6004);
  assert.match(res.message, /checksum mismatch/);
  const snap = res.data as AppUpdaterSnapshot;
  assert.equal(snap.status, 'idle');
  assert.equal(snap.error, 'checksum mismatch');
  assert.equal(snap.downloadProgress, null);
});

test('downloadUpdate：下载失败（error 事件先行收敛）→ 6004 + 状态回 idle', async () => {
  const h = createHarness();
  await reachFound(h);
  const pending = h.methods['updater/downloadUpdate']();
  h.fake.fire('error', new Error('download aborted'));
  const res = await pending;
  assert.equal(res.code, 6004);
  assert.equal((res.data as AppUpdaterSnapshot).status, 'idle');
  assert.equal((res.data as AppUpdaterSnapshot).error, 'download aborted');
});

test('downloadUpdate：非 found（idle）调用 → 6004 且状态不跃迁', async () => {
  const h = createHarness();
  const res = await h.methods['updater/downloadUpdate']();
  assert.equal(res.code, 6004);
  assert.deepEqual(h.port.getState(), idleSnapshot('0.1.0'));
  assert.equal(h.fake.downloadUpdateCalls, 0);
});

test('downloadUpdate：downloading 中重复调用 → code 0 当前快照（幂等，不重复触发下载）', async () => {
  const h = createHarness();
  await reachFound(h);
  const first = await h.methods['updater/downloadUpdate']();
  assert.equal(first.code, 0);
  const second = await h.methods['updater/downloadUpdate']();
  assert.equal(second.code, 0);
  assert.equal((second.data as AppUpdaterSnapshot).status, 'downloading');
  assert.equal(h.fake.downloadUpdateCalls, 1, '幂等重复调用不得重复触发下载');
});

test('quitAndInstall：非 downloaded（idle）调用 → 6005 且状态不跃迁', async () => {
  const h = createHarness();
  const res = await h.methods['updater/quitAndInstall']();
  assert.equal(res.code, 6005);
  assert.deepEqual(h.port.getState(), idleSnapshot('0.1.0'));
  assert.equal(h.fake.quitAndInstallCalls, 0);
});

test('quitAndInstall：downloaded → installing 并调用底层安装；失败 → 6005 回 idle', async () => {
  // 成功路径：正常返回 installing 快照（真实端应用随后退出重启）
  const h = createHarness();
  await reachFound(h);
  await h.methods['updater/downloadUpdate']();
  h.fake.fire('update-downloaded', { version: '0.2.0' });
  const res = await h.methods['updater/quitAndInstall']();
  assert.equal(res.code, 0);
  assert.equal(h.fake.quitAndInstallCalls, 1);
  assert.equal((res.data as AppUpdaterSnapshot).status, 'installing');

  // 失败路径：6005 + 回 idle + error 静默展示
  const h2 = createHarness();
  await reachFound(h2);
  await h2.methods['updater/downloadUpdate']();
  h2.fake.fire('update-downloaded', { version: '0.2.0' });
  h2.fake.quitError = new Error('spawn failed');
  const res2 = await h2.methods['updater/quitAndInstall']();
  assert.equal(res2.code, 6005);
  const snap = res2.data as AppUpdaterSnapshot;
  assert.equal(snap.status, 'idle');
  assert.equal(snap.error, 'spawn failed');
});

test('updater.stateChanged：事件通道固定，payload 与 getState.data 同构', async () => {
  // QA-G5 回归锚点：updater.stateChanged 必须已登记 FORGE_EVENTS 转发白名单
  //（主进程 registerIpc 只转发白名单内事件；误删该条真实端渲染进程收不到状态推送）
  assert.ok(
    FORGE_EVENTS.includes('updater.stateChanged'),
    'FORGE_EVENTS 白名单必须包含 updater.stateChanged（主进程转发依赖）',
  );
  const h = createHarness();
  await reachFound(h);
  assert.ok(h.events.length > 0, '跃迁必须发射事件');
  for (const e of h.events) {
    assert.equal(e.event, 'updater.stateChanged');
    assert.deepEqual(
      Object.keys(e.payload).sort(),
      ['currentVersion', 'downloadProgress', 'error', 'latestVersion', 'status'],
    );
  }
  assert.deepEqual(h.events[h.events.length - 1]!.payload, h.port.getState());
});
