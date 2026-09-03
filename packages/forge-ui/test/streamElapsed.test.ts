/**
 * 流式读秒独立性与切换恢复单测（v3.37 读秒 + 切会话读秒重置 bug 修复）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts；src/composables 内部导入已带 .ts 后缀）。
 * 背景：ConversationView 切会话在同 tick 内 isStreaming false→true，Vue watch 去重后视为
 * 无变化不触发，计时器沿用上个会话起点 → 多会话读秒全同。修复后为显式 start/stop +
 * restoreStreaming（切换恢复入口），起点按 sessionId 存模块级 turnStartAt（跨实例共享）。
 *
 * 覆盖：
 * - A 流式计秒正常走表；
 * - 同 tick 切到 B（也在流式）：B 显示自己的秒数（不继承 A 的计时器/起点）；
 * - 切回 A：按 A 原起点续算（B 期间的计时不串入 A）；
 * - 组件卸载/停表不删起点（切走再切回不归零）由 restoreStreaming 路径隐含覆盖。
 *
 * 说明：onStatus/cancel/send 依赖 bridge 订阅（onMounted 外无组件实例不接线），
 * 此处仅驱动 statusHint watch 与 restoreStreaming——正是切会话 bug 的真实路径；
 * 终态清理（done/cancel/error 删 turnStartAt）为代码审阅保证。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref, nextTick } from 'vue';

import { formatElapsed } from '../src/utils/formatElapsed.ts';
import { useSessionConversation } from '../src/composables/useSessionConversation.ts';

test('读秒格式化：秒→分→小时进位', () => {
  assert.equal(formatElapsed(42), '42s');
  assert.equal(formatElapsed(59), '59s');
  assert.equal(formatElapsed(60), '1m');
  assert.equal(formatElapsed(86), '1m26s');
  assert.equal(formatElapsed(600), '10m');
  assert.equal(formatElapsed(3599), '59m59s');
  assert.equal(formatElapsed(3600), '1h');
  assert.equal(formatElapsed(3660), '1h1m');
  assert.equal(formatElapsed(3728), '1h2m8s');
  assert.equal(formatElapsed(3628), '1h0m28s');
  assert.equal(formatElapsed(7500), '2h5m');
});

/** 假时钟：打桩 Date.now/setInterval/clearInterval，tick(ms) 推进时间并触发全部 interval */
function installFakeClock(): { tick: (ms: number) => void } {
  let now = 1_000_000;
  Date.now = () => now;
  const timers = new Map<number, () => void>();
  let seq = 1;
  globalThis.setInterval = ((fn: () => void) => {
    const id = seq++;
    timers.set(id, fn);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => {
    timers.delete(id);
  }) as typeof clearInterval;
  return {
    tick(ms: number): void {
      now += ms;
      for (const fn of [...timers.values()]) fn();
    },
  };
}

/** 驱动一个状态机：sid/status 可变 ref 模拟 App 侧当前会话与会话列表状态提示 */
function setup() {
  const clock = installFakeClock();
  const sid = ref<string | null>(null);
  const status = ref<string | undefined>(undefined);
  const conv = useSessionConversation({
    getSessionId: () => sid.value,
    getStatusHint: () => status.value,
  });
  return { clock, sid, status, conv };
}

test('读秒：切换流式会话各显各的秒数，互不串表', async () => {
  const { clock, sid, status, conv } = setup();

  // A 开始流式（statusHint 兜底路径置流式），走 30s
  sid.value = 't-A';
  status.value = 'streaming';
  await nextTick();
  assert.equal(conv.isStreaming.value, true, 'A 应进入流式');
  clock.tick(30_000);
  assert.equal(conv.streamElapsedSec.value, 30, `A 应显示 30s，实际 ${conv.streamElapsedSec.value}`);

  // 同 tick 切到 B（也在流式，起点本实例从未见过）——复现 bug 的切换路径
  sid.value = 't-B';
  conv.restoreStreaming(true);
  await nextTick();
  assert.notEqual(conv.streamElapsedSec.value, 30, 'B 不得沿用 A 的计时器（bug：读秒全同）');
  clock.tick(10_000);
  assert.equal(conv.streamElapsedSec.value, 10, `B 应从自己起点走 10s，实际 ${conv.streamElapsedSec.value}`);

  // 切回 A：按 A 原起点续算（真实已过 40s），B 的 10s 不串入
  sid.value = 't-A';
  conv.restoreStreaming(true);
  await nextTick();
  assert.equal(conv.streamElapsedSec.value, 40, `A 应按原起点显示 40s，实际 ${conv.streamElapsedSec.value}`);
});

test('读秒：起点跨实例共享——多窗口窗格记下的起点，单视图切回能续算', async () => {
  const { clock, sid, status, conv } = setup();
  const other = useSessionConversation({
    getSessionId: () => 't-shared',
    getStatusHint: () => undefined,
  });

  // "多窗口窗格"实例先开始流式（模拟其收到 statusChanged streaming / send）
  other.restoreStreaming(true);
  clock.tick(25_000);

  // 单视图切到同一会话：共享模块级 turnStartAt，应显示真实 25s 而非从 0 重计
  sid.value = 't-shared';
  status.value = 'streaming';
  await nextTick();
  assert.equal(conv.isStreaming.value, true, '单视图应经 statusHint 恢复流式态');
  assert.equal(conv.streamElapsedSec.value, 25, `应共享起点显示 25s，实际 ${conv.streamElapsedSec.value}`);
});
