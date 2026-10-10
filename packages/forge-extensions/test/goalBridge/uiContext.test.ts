/**
 * goal 宿主 UI 适配层的单测（goal 接入，2026-10-10）。
 *
 * 守护的核心回归（这些是接入前的真实故障）：
 * 1. `confirm` 必须能把用户的「确定/取消」真实回传给 pi-goal。
 *    接入前 pi 回落 `noOpUIContext`（runner.js:90）恒返回 false ⇒ 替换未完成目标被静默拒绝。
 * 2. 宽限到期必须收敛而不是永久悬挂（否则 pi-goal 的 await 永挂，会话卡死）。
 * 3. `notify` / `setStatus` 必须真正投递（接入前全被空实现吞掉 ⇒ 用户零感知）。
 *
 * 用法：node --experimental-strip-types --test
 */

import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  GOAL_STATUS_CHANNEL,
  GOAL_UI_NOTIFY_CHANNEL,
  GOAL_UI_REQUEST_CHANNEL,
  GOAL_UI_TIMEOUT_CHANNEL,
  goalUiReplyChannel,
} from '../../src/goalBridge/channels.ts';
import { createForgeUiContext } from '../../src/goalBridge/uiContext.ts';

/** 最小内存总线（与 SubagentEventBus 同构）。 */
function createBus() {
  const handlers = new Map<string, Set<(data: unknown) => void>>();
  return {
    emitted: [] as Array<{ channel: string; data: unknown }>,
    emit(channel: string, data: unknown): void {
      this.emitted.push({ channel, data });
      for (const h of [...(handlers.get(channel) ?? [])]) h(data);
    },
    on(channel: string, handler: (data: unknown) => void): () => void {
      let set = handlers.get(channel);
      if (set === undefined) {
        set = new Set();
        handlers.set(channel, set);
      }
      set.add(handler);
      return () => set.delete(handler);
    },
  };
}

type AnyBus = ReturnType<typeof createBus>;
/** 测试用：uiContext 上被 as unknown 断言过的方法，故按 any 取用。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Ui = any;

test('confirm：用户的「确定」被真实回传（接入前恒 false）', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  const pending = (ui as Ui).confirm('Replace goal?', '当前目标：A\n新目标：B');

  // 请求必须真的投递到总线（否则 UI 永远等不到）
  const request = bus.emitted.find((e) => e.channel === GOAL_UI_REQUEST_CHANNEL);
  assert.ok(request, 'confirm 必须投递到 goal-ui:request 通道');
  const payload = request.data as { requestId: string; kind: string; message: string };
  assert.equal(payload.kind, 'confirm');
  assert.equal(payload.message, '当前目标：A\n新目标：B');

  // 用户点「确定」
  bus.emit(goalUiReplyChannel(payload.requestId), {
    requestId: payload.requestId,
    value: true,
    cancelled: false,
  });

  assert.equal(await pending, true, 'confirm 必须回传用户的选择');
});

test('confirm：用户点「取消」回传 false（而非静默丢弃）', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  const pending = (ui as Ui).confirm('Replace goal?', 'x');
  const payload = bus.emitted.find((e) => e.channel === GOAL_UI_REQUEST_CHANNEL)!.data as { requestId: string };

  bus.emit(goalUiReplyChannel(payload.requestId), {
    requestId: payload.requestId,
    value: false,
    cancelled: true,
  });

  assert.equal(await pending, false);
});

test('input：用户文本被真实回传', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  const pending = (ui as Ui).input('Goal objective', '描述你的目标');
  const request = bus.emitted.find((e) => e.channel === GOAL_UI_REQUEST_CHANNEL)!;
  const payload = request.data as { requestId: string; placeholder?: string };
  assert.equal(payload.placeholder, '描述你的目标', 'placeholder 必须透传给 UI');

  bus.emit(goalUiReplyChannel(payload.requestId), {
    requestId: payload.requestId,
    value: '把登录页修好',
    cancelled: false,
  });

  assert.equal(await pending, '把登录页修好');
});

test('editor：按多行文本处理（pi-goal 用它取目标全文）', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  const pending = (ui as Ui).editor('Edit goal objective', '');
  const payload = bus.emitted.find((e) => e.channel === GOAL_UI_REQUEST_CHANNEL)!.data as {
    requestId: string;
    kind: string;
  };
  assert.equal(payload.kind, 'editor');

  bus.emit(goalUiReplyChannel(payload.requestId), {
    requestId: payload.requestId,
    value: '多行\n目标',
    cancelled: false,
  });

  assert.equal(await pending, '多行\n目标');
});

test('select：选中项原文回传', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  const pending = (ui as Ui).select('Pick', ['A', 'B']);
  const payload = bus.emitted.find((e) => e.channel === GOAL_UI_REQUEST_CHANNEL)!.data as {
    requestId: string;
    options?: string[];
  };
  assert.deepEqual(payload.options, ['A', 'B']);

  bus.emit(goalUiReplyChannel(payload.requestId), {
    requestId: payload.requestId,
    value: 'B',
    cancelled: false,
  });

  assert.equal(await pending, 'B');
});

test('notify：状态播报真的投递（接入前被空实现吞掉）', () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  (ui as Ui).notify('Goal started: 修好登录页', 'info');
  (ui as Ui).notify('Automatic work pauses after 25 responses', 'warning');

  const notices = bus.emitted.filter((e) => e.channel === GOAL_UI_NOTIFY_CHANNEL);
  assert.equal(notices.length, 2);
  assert.deepEqual(notices[0].data, { message: 'Goal started: 修好登录页', level: 'info' });
  assert.equal((notices[1].data as { level: string }).level, 'warning');
});

test('notify：通知通道抛错也不影响流程（尽力而为）', () => {
  const bus = createBus();
  const broken = {
    emit(channel: string, data: unknown) {
      if (channel === GOAL_UI_NOTIFY_CHANNEL) throw new Error('bus down');
      bus.emit(channel, data);
    },
    on: bus.on,
  } as unknown as AnyBus;
  const { ui } = createForgeUiContext({ bus: broken });

  assert.doesNotThrow(() => (ui as Ui).notify('x', 'info'));
});

test('setStatus：pi-goal 的状态行被转发（徽标主数据源）', () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  (ui as Ui).setStatus('goal', 'active 3m · automatic 12/25');

  const status = bus.emitted.find((e) => e.channel === GOAL_STATUS_CHANNEL);
  assert.ok(status, 'goal 状态行必须投递');
  assert.deepEqual(status!.data, { key: 'goal', text: 'active 3m · automatic 12/25' });
});

test('setStatus：非 goal 的 key 被过滤（不污染其它扩展的状态行）', () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  (ui as Ui).setStatus('some-other-ext', 'whatever');

  assert.equal(bus.emitted.filter((e) => e.channel === GOAL_STATUS_CHANNEL).length, 0);
});

test('setStatus：清除徽标时 text 为 undefined 也能透传', () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  (ui as Ui).setStatus('goal', undefined);

  const status = bus.emitted.find((e) => e.channel === GOAL_STATUS_CHANNEL);
  assert.deepEqual(status!.data, { key: 'goal', text: undefined });
});

test('宽限到期：confirm 收敛为 false 且发超时告警（不静默拒绝）', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus, graceMs: 10 });

  const pending = (ui as Ui).confirm('Replace goal?', 'x');
  const result = await pending;

  assert.equal(result, false, '超时必须收敛为 false，不能永久悬挂');
  assert.ok(
    bus.emitted.some((e) => e.channel === GOAL_UI_TIMEOUT_CHANNEL),
    '必须发超时告警，避免退化成无迹可寻的静默拒绝',
  );
});

test('宽限到期后迟到的回填被忽略（Promise 只 settle 一次）', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus, graceMs: 10 });

  const pending = (ui as Ui).confirm('Replace goal?', 'x');
  const payload = bus.emitted.find((e) => e.channel === GOAL_UI_REQUEST_CHANNEL)!.data as { requestId: string };

  assert.equal(await pending, false);

  // 用户在超时后才点确认——不应改变已收敛的结果，也不应抛错
  bus.emit(goalUiReplyChannel(payload.requestId), {
    requestId: payload.requestId,
    value: true,
    cancelled: false,
  });

  assert.equal(await pending, false);
});

test('interactive=false：立即按缺省值收敛，不投递到总线', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus, interactive: false });

  assert.equal(await (ui as Ui).confirm('t', 'm'), false);
  assert.equal(await (ui as Ui).input('t'), undefined);
  assert.equal(bus.emitted.filter((e) => e.channel === GOAL_UI_REQUEST_CHANNEL).length, 0);
});

test('会话销毁：等待中的请求被收敛，不悬挂 pi-goal 的 await', async () => {
  const bus = createBus();
  const { ui, dispose } = createForgeUiContext({ bus });

  const pending = (ui as Ui).confirm('Replace goal?', 'x');
  dispose();

  assert.equal(await pending, false, 'dispose 必须让等待中的 confirm 收敛');
});

test('总线投递抛错：立即收敛而非泄漏', async () => {
  const bus = createBus();
  const broken = {
    emit() { throw new Error('session disposed'); },
    on: bus.on,
  } as unknown as AnyBus;
  const { ui } = createForgeUiContext({ bus: broken });

  assert.equal(await (ui as Ui).confirm('t', 'm'), false);
});

test('多个并发请求互不串扰（各自按 requestId 配对）', async () => {
  const bus = createBus();
  const { ui } = createForgeUiContext({ bus });

  const first = (ui as Ui).confirm('A', 'a');
  const second = (ui as Ui).input('B');
  const requests = bus.emitted
    .filter((e) => e.channel === GOAL_UI_REQUEST_CHANNEL)
    .map((e) => (e.data as { requestId: string }).requestId);
  assert.equal(requests.length, 2);
  assert.notEqual(requests[0], requests[1]);

  // 逆序回填，验证不按注册顺序而是按 requestId 配对
  bus.emit(goalUiReplyChannel(requests[1]), { requestId: requests[1], value: 'B-text', cancelled: false });
  bus.emit(goalUiReplyChannel(requests[0]), { requestId: requests[0], value: true, cancelled: false });

  assert.equal(await first, true);
  assert.equal(await second, 'B-text');
});
