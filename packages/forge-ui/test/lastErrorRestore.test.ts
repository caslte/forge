/**
 * 红点会话切回后错误横幅恢复单测（瞬态 errorMsg 丢失修复）。
 *
 * 运行方式：node --test（Node type stripping 直跑 .ts）。
 * 背景：错误发生时不在该会话（或切走再切回）时，conversation.error 事件被
 * sessionId 过滤 / resetForSession 清空，主对话区错误横幅丢失，而会话树红点
 * （session.status='error'）持久——两者数据源不对称。修复后 loadHistory 在
 * 会话状态为 error 时经 conversation/getLastError 拉取后端记录的 lastError
 * 恢复横幅显示。
 *
 * 说明：bridge.call 运行时读 window.forge.invoke，此处打桩注入；onMounted/
 * subscribe 在无组件实例下不接线（与 streamElapsed.test.ts 同模式），仅直接
 * 驱动 loadHistory——正是切会话恢复的真实路径。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ref } from 'vue';

import { useSessionConversation } from '../src/composables/useSessionConversation.ts';

/** 打桩 window.forge.invoke：按方法名分发，记录调用顺序 */
function stubBridge(options: { lastError: string | null }): { calls: string[] } {
  const calls: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    forge: {
      invoke: async (method: string) => {
        calls.push(method);
        if (method === 'conversation/queryHistory') {
          return { code: 0, message: 'success', data: { messages: [] } };
        }
        if (method === 'conversation/getLastError') {
          return { code: 0, message: 'success', data: { message: options.lastError } };
        }
        return { code: 0, message: 'success', data: null };
      },
    },
  };
  return { calls };
}

/** 驱动一个状态机：可变 sid/status ref 模拟当前会话与会话列表状态提示 */
function setup(lastError: string | null): {
  calls: string[];
  sid: ReturnType<typeof ref<string | null>>;
  status: ReturnType<typeof ref<string | undefined>>;
  conv: ReturnType<typeof useSessionConversation>;
} {
  const { calls } = stubBridge({ lastError });
  const sid = ref<string | null>(null);
  const status = ref<string | undefined>(undefined);
  const conv = useSessionConversation({
    getSessionId: () => sid.value,
    getStatusHint: () => status.value,
  });
  return { calls, sid, status, conv };
}

test('切到 error 会话：loadHistory 拉取 lastError 并恢复错误横幅', async () => {
  const { calls, sid, status, conv } = setup('模型额度耗尽（429）：请检查账户额度');
  sid.value = 't-err';
  status.value = 'error';

  await conv.loadHistory();

  assert.equal(
    conv.errorMsg.value,
    '模型额度耗尽（429）：请检查账户额度',
    `切到红点会话应显示后端记录的错误，实际 ${conv.errorMsg.value}`,
  );
  assert.ok(calls.includes('conversation/getLastError'), '应发起 getLastError 拉取');
});

test('非 error 会话：loadHistory 不发起 getLastError（无谓请求）', async () => {
  const { calls, sid, status, conv } = setup('模型额度耗尽');
  sid.value = 't-idle';
  status.value = 'idle';

  await conv.loadHistory();

  assert.equal(conv.errorMsg.value, null, '非 error 会话不显示错误横幅');
  assert.ok(!calls.includes('conversation/getLastError'), '不得发起 getLastError');
});

test('error 会话但后端无记录（如重启后）：横幅保持不显示', async () => {
  const { sid, status, conv } = setup(null);
  sid.value = 't-err-no-record';
  status.value = 'error';

  await conv.loadHistory();

  assert.equal(conv.errorMsg.value, null, '无 lastError 记录时不得显示横幅');
});

test('切走再切回 error 会话：resetForSession 清空后 loadHistory 重新恢复', async () => {
  const { sid, status, conv } = setup('provider 未配置');
  sid.value = 't-err';
  status.value = 'error';
  await conv.loadHistory();
  assert.equal(conv.errorMsg.value, 'provider 未配置');

  // 切走再切回（ConversationView 会话切换路径）
  conv.resetForSession();
  assert.equal(conv.errorMsg.value, null, '切换时横幅先清空');
  await conv.loadHistory();
  assert.equal(conv.errorMsg.value, 'provider 未配置', '切回红点会话后横幅应恢复');
});

test('getLastError 调用失败静默降级：不阻塞历史加载、不显示横幅', async () => {
  const calls: string[] = [];
  (globalThis as unknown as { window: unknown }).window = {
    forge: {
      invoke: async (method: string) => {
        calls.push(method);
        if (method === 'conversation/queryHistory') {
          return { code: 0, message: 'success', data: { messages: [] } };
        }
        return { code: 5000, message: 'internal error', data: null };
      },
    },
  };
  const sid = ref<string | null>('t-err');
  const status = ref<string | undefined>('error');
  const conv = useSessionConversation({
    getSessionId: () => sid.value,
    getStatusHint: () => status.value,
  });

  await conv.loadHistory();

  assert.equal(conv.loadingHistory.value, false, '历史加载不得被 lastError 拉取失败阻塞');
  assert.equal(conv.errorMsg.value, null, '拉取失败不得显示横幅');
});
