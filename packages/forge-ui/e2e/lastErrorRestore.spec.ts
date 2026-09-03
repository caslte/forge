/**
 * 红点会话切回后错误横幅恢复（瞬态 errorMsg 丢失修复）。
 *
 * 背景：模型额度耗尽等轮次错误发生时用户不在该会话——conversation.error 事件
 * 被 sessionId 过滤，切过去时 resetForSession 已清空 errorMsg，主对话区看不到
 * 任何错误信息，而会话树红点（session.status='error'）持久。修复后切换到
 * error 会话时经 conversation/getLastError 拉取后端记录恢复横幅。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, waitForMock } from './helpers/index';

function mkSession(over: Record<string, unknown>): Record<string, unknown> {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    projectPath: 'D:/work/aiwork/forge',
    alias: null,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
    ...over,
  };
}

async function boot(page: Page, sessions: Array<Record<string, unknown>>): Promise<void> {
  await page.goto('/');
  await seedSessions(page, sessions);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
}

const QUOTA_ERROR = '模型额度耗尽（429）：请检查账户额度';

test('E-CV-ERR-001 @P0 @mock-backend：切到红点会话恢复错误横幅，切走后消失', async ({ page }) => {
  const health = attachHealthGuards(page);
  const normal = mkSession({ alias: '正常会话' });
  const errored = mkSession({ alias: '额度耗尽会话', status: 'error' });
  await boot(page, [normal, errored]);

  // 红点：error 会话状态点可见（tone-error）
  const erroredRow = page.locator('.tree-session', { hasText: '额度耗尽会话' });
  await expect(erroredRow.locator('.tree-session-status-dot.tone-error')).toBeVisible();

  // 种子 getLastError：返回后端记录的额度错误
  await page.evaluate(
    (message) => {
      window.__forgeMock!.seed('conversation/getLastError', () => ({
        code: 0,
        message: 'success',
        data: { message },
      }));
    },
    QUOTA_ERROR,
  );

  // 先停在正常会话：无横幅
  await page.locator('.tree-session', { hasText: '正常会话' }).click();
  await expect(page.locator('.conv-error')).toHaveCount(0);

  // 切到红点会话：错误横幅恢复显示后端记录的信息
  await erroredRow.click();
  await expect(page.locator('.conv-error')).toBeVisible();
  await expect(page.locator('.conv-error')).toContainText(QUOTA_ERROR);

  // 切回正常会话：横幅消失
  await page.locator('.tree-session', { hasText: '正常会话' }).click();
  await expect(page.locator('.conv-error')).toHaveCount(0);

  health.assertHealthy();
  void waitForMock;
});
