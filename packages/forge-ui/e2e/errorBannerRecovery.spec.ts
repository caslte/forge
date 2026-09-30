/**
 * 错误横幅在「恢复」后必须消失（CV-ERR-UI 回归）。
 *
 * 背景（真机 529 场景）：message_end(stopReason=error) 先把状态打成 error 并挂出
 * 错误横幅，pi 随后 auto_retry_start 又把状态改回 streaming（重试中/已跑通）——
 * 此前 UI 只在 done/idle/canceled 清横幅，于是旧错误在重试跑完的整个过程中一直挂在
 * 对话底部，用户观感是「错过一次就永远挂着，恢复了也不消失」。
 *
 * 这里直接用 mock 事件序列复现：错误事件 → statusChanged(streaming)，
 * 断言横幅消失；并覆盖 retry 载荷与错误分类互斥（进度条不被旧错误盖住）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions } from './helpers/index';

const SESSION_ID = 'sess-errbanner-1';
const RAW_ERROR = '529: {"type":"overloaded_error","message":"当前服务集群负载较高"}';

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [
    {
      sessionId: SESSION_ID,
      projectPath: 'D:/work/aiwork/forge',
      alias: '错误恢复会话',
      status: 'idle',
      lastActiveAt: new Date().toISOString(),
    },
  ]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session', { hasText: '错误恢复会话' }).click();
}

function emit(page: Page, event: string, payload: Record<string, unknown>): Promise<void> {
  return page.evaluate(
    ([sid, ev, p]) => {
      window.__forgeMock!.emit(sid as string, ev as string, p as Record<string, unknown>);
    },
    [SESSION_ID, event, payload] as const,
  ).then(() => undefined);
}

test('E-CV-ERR-002 @P0 @mock-backend：新轮次起点清错误横幅（恢复后不残留）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page);

  // 1) 终态错误：横幅出现
  await emit(page, 'conversation.error', {
    code: 5000,
    message: RAW_ERROR,
    error: {
      category: 'busy',
      source: 'model-provider',
      raw: RAW_ERROR,
      retryable: true,
      degraded: false,
    },
  });
  await expect(page.locator('.conv-error')).toBeVisible();
  await expect(page.locator('.conv-error')).toContainText(RAW_ERROR);

  // 2) 恢复：main 在自动重试开始时把状态改回 streaming → 横幅必须让位
  await emit(page, 'conversation.statusChanged', { status: 'streaming' });
  await expect(page.locator('.conv-error')).toHaveCount(0);

  // 3) 重试进行中：只剩进度条，不是错误横幅
  await emit(page, 'conversation.error', {
    code: 5000,
    message: '模型连接中断，正在自动重试…',
    retry: { attempt: 2, maxAttempts: 3 },
  });
  await expect(page.locator('.conv-error--info')).toBeVisible();
  await expect(page.locator('.conv-error--info')).not.toContainText(RAW_ERROR);

  // 4) 轮次跑完：连重试进度一起清
  await emit(page, 'conversation.statusChanged', { status: 'done' });
  await expect(page.locator('.conv-error')).toHaveCount(0);

  health.assertHealthy();
});
