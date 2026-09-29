/**
 * 错误横幅状态机接线单测（CV-ERR-UI）。
 *
 * 覆盖 conversation.error 新载荷的两种语义与重试动作：
 * 1. retry 载荷 = 自动重试进行中（轮次未终止）→ 不进错误横幅
 * 2. error 载荷 = 终态分类 → 进分类，且与 retry 互斥
 * 3. 旧链路（只有 message）不崩，归为无分类终态错误
 * 4. 「立即重试」重发最后一条用户消息；无用户消息/流式中为 noop
 * 5. 切回 error 会话时连分类一起恢复（不只是原文）
 *
 * 模式同 lastErrorRestore.test.ts：事件订阅在 onMounted（无组件实例时不接线），
 * 因此事件分支直接测导出的纯函数 interpretErrorPayload，行为分支测可达方法。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import {
  interpretErrorPayload,
  useSessionConversation,
} from '../src/composables/useSessionConversation.ts';
import { classifyError } from '../../forge-core/src/errors/errorClassifier.ts';

/**
 * 假时钟：打桩 setInterval/clearInterval（与 streamElapsed.test.ts 同模式）。
 * 本文件会真实调 send()（内部 startElapsed），真实定时器会让 node --test 挂到超时，
 * 所以用假时钟接管，并按用例断言定时器的注册/注销。
 */
function installFakeClock(): { tick: (ms: number) => void; count: () => number } {
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
      void ms;
      for (const fn of [...timers.values]) fn();
    },
    count: () => timers.size,
  };
}

function stubBridge(lastError: { message: string | null; error?: unknown } | null): {
  sent: Array<{ content: string }>;
} {
  const sent: Array<{ content: string }> = [];
  (globalThis as unknown as { window: unknown }).window = {
    forge: {
      invoke: async (method: string, params: unknown) => {
        if (method === 'conversation/sendMessage') {
          sent.push({ content: (params as { content: string }).content });
          return { code: 0, message: 'success', data: null };
        }
        if (method === 'conversation/queryHistory') {
          return { code: 0, message: 'success', data: { messages: [] } };
        }
        if (method === 'conversation/getLastError') {
          return {
            code: 0,
            message: 'success',
            data: { message: lastError?.message ?? null, error: lastError?.error ?? null },
          };
        }
        return { code: 0, message: 'success', data: null };
      },
    },
  };
  return { sent };
}

function setup(lastError: { message: string | null; error?: unknown } | null = null) {
  const clock = installFakeClock();
  const { sent } = stubBridge(lastError);
  const sid = ref<string | null>('s1');
  const status = ref<string | undefined>(undefined);
  const conv = useSessionConversation({
    getSessionId: () => sid.value,
    getStatusHint: () => status.value,
  });
  return { sent, sid, status, conv, clock };
}

test('CV-ERR-UI-101 retry 载荷 → 只有进度，没有错误分类', () => {
  const got = interpretErrorPayload({
    sessionId: 's1',
    code: 5000,
    message: '模型连接中断，正在自动重试（第 2/3 次）…',
    retry: { attempt: 2, maxAttempts: 3 },
  });
  assert.deepEqual(got.retry, { attempt: 2, maxAttempts: 3 });
  assert.equal(got.error, null, '重试中不得同时挂错误分类（否则横幅不消）');
});

test('CV-ERR-UI-102 error 载荷 → 分类进 error，且 retry 归零', () => {
  const got = interpretErrorPayload({
    sessionId: 's1',
    code: 5000,
    message: 'unknown error, 722 (1000)',
    error: classifyError('unknown error, 722 (1000)'),
  });
  assert.equal(got.retry, null);
  assert.equal(got.error?.category, 'provider');
  assert.equal(got.message, 'unknown error, 722 (1000)');
});

test('CV-ERR-UI-103 旧链路载荷（只有 message）不崩，归为无分类终态错误', () => {
  const got = interpretErrorPayload({ sessionId: 's1', code: 5000, message: 'boom' });
  assert.equal(got.retry, null);
  assert.equal(got.error, null, '未分类时交给旧单行样式，不伪造分类');
  assert.equal(got.message, 'boom');
});

test('CV-ERR-UI-104 retry 字段残缺时不产生 NaN 进度', () => {
  const got = interpretErrorPayload({ sessionId: 's1', message: 'x', retry: {} });
  assert.deepEqual(got.retry, { attempt: 0, maxAttempts: 0 });
});

test('CV-ERR-UI-105 立即重试：只重发最后一条用户消息，并清掉旧横幅', async () => {
  const { conv, sent } = setup();
  await conv.send('第一条');
  await conv.cancel(); // 无 statusChanged 事件：用 cancel 回到非流式并停掉读秒表
  await conv.send('第二条');
  await conv.cancel();
  sent.length = 0;

  await conv.retryLastUserMessage();

  assert.deepEqual(
    sent.map((s) => s.content),
    ['第二条'],
    '只重发最后一条用户消息（不是全部重发）',
  );
});

test('CV-ERR-UI-106 无用户消息 / 流式中：重试为 noop（不空发）', async () => {
  const { conv, sent } = setup();
  await conv.retryLastUserMessage();
  assert.equal(sent.length, 0, '没有用户消息时不得发出空请求');

  await conv.send('进行中的一条');
  sent.length = 0;
  await conv.retryLastUserMessage();
  assert.equal(
    sent.length,
    0,
    '流式中重试应 noop——pi 的 prompt 会被 already processing 拒绝，重复发送只会报错',
  );
  await conv.cancel(); // 收尾：停掉读秒表，让测试进程能自然退出
});

test('CV-ERR-UI-106b 取消后回到非流式，且读秒定时器已注销', async () => {
  const { conv, clock } = setup();
  await conv.send('一条');
  assert.equal(clock.count(), 1, '流式中应有且仅有读秒一个定时器');
  await conv.cancel();
  assert.equal(conv.isStreaming.value, false);
  assert.equal(clock.count(), 0, 'cancel 必须停表，否则定时器泄漏到会话销毁之后');
});

test('CV-ERR-UI-107 切回 error 会话：连同分类一起恢复横幅', async () => {
  const info = classifyError('unknown error, 722 (1000)');
  const { conv, status } = setup({ message: 'unknown error, 722 (1000)', error: info });
  status.value = 'error'; // 红点会话切回路径的入口条件
  await conv.loadHistory();
  assert.equal(conv.errorMsg.value, 'unknown error, 722 (1000)');
  assert.equal(conv.errorInfo.value?.category, 'provider', '切回时分类必须一并恢复');
  assert.equal(conv.errorInfo.value?.raw, 'unknown error, 722 (1000)');
});
