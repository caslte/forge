/**
 * E-CV-STREAM-END-001：流式结束时 assistant 卡片必须原地更新，不得重挂载。
 *
 * 背景：流式占位消息由 delta 建立，终态 conversation.message 到达时以「消息完成时刻」
 * 覆盖其 ts。列表 key 取 `id ?? toolEventId ?? ts-role`，占位若无 id 则 key 随 ts 改变，
 * Vue 把该轮回复当成新节点：卸载重建 → 入场动画重播 + v-html 子树（hljs/mermaid/画布
 * iframe）整体重建，观感即「回复完成时刷一下」。
 *
 * 判定：流式期间给卡片 DOM 打标记，走完终态后标记仍在 = 同一个 DOM 节点（未重挂）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, seedHistory } from './helpers/index';

function mkSession(alias: string): Record<string, unknown> {
  return {
    sessionId: 'sess-' + Math.random().toString(36).slice(2, 10),
    projectPath: 'D:/work/aiwork/forge',
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 给当前最后一张 assistant 卡片打节点标记 */
async function tagLastAssistant(page: Page): Promise<void> {
  await page.evaluate(() => {
    const cards = document.querySelectorAll('.msg-assistant');
    const last = cards[cards.length - 1] as HTMLElement | undefined;
    if (last) (last as Record<string, unknown>).__streamCardTag = 'tagged';
  });
}

/** 读回最后一张 assistant 卡片的节点标记（undefined = 已被重建） */
async function readLastAssistantTag(page: Page): Promise<string | undefined> {
  return page.evaluate(() => {
    const cards = document.querySelectorAll('.msg-assistant');
    const last = cards[cards.length - 1] as HTMLElement | undefined;
    return last ? (last as Record<string, unknown>).__streamCardTag as string | undefined : undefined;
  });
}

test('E-CV-STREAM-END-001 @P0 @mock-backend：终态覆盖 ts 后流式卡片仍是同一 DOM 节点', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const health = attachHealthGuards(page);
  const s = mkSession('收尾帧卡片身份');
  await page.goto('/');
  await seedSessions(page, [s]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  await seedHistory(page, s.sessionId as string, [
    { role: 'user', content: '上一轮提问', ts: new Date(Date.now() - 60_000).toISOString() },
    { role: 'assistant', content: '上一轮回复。', ts: new Date(Date.now() - 50_000).toISOString() },
  ]);
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.msg-assistant', { hasText: '上一轮回复' })).toBeVisible({ timeout: 8_000 });
  const sid = s.sessionId as string;

  // 一轮真实时序：streaming → user 气泡（排队派发到达）→ delta 建占位 → 权威 message → done
  await page.evaluate(([k]) => {
    window.__forgeMock!.emit(k, 'conversation.statusChanged', { status: 'streaming' });
  }, [sid] as const);
  await page.evaluate(
    ([k]) => {
      window.__forgeMock!.emit(k, 'conversation.message', {
        message: { role: 'user', content: '流式收尾排查', ts: new Date().toISOString() },
      });
    },
    [sid] as const,
  );
  await page.evaluate(
    ([k]) => {
      window.__forgeMock!.emit(k, 'conversation.delta', { delta: { text: '本轮回复开始输出。\n', kind: 'text' } });
    },
    [sid] as const,
  );
  await expect(page.locator('.msg-assistant').last().locator('.msg-content')).toContainText('本轮回复开始输出', {
    timeout: 8_000,
  });
  const cardsDuringStream = await page.locator('.msg-assistant').count();
  await tagLastAssistant(page);

  // 终态：权威消息到达，ts 被改为「消息完成时刻」（与占位时刻必然不同）
  await page.evaluate(
    ([k]) => {
      const later = new Date(Date.now() + 5_000).toISOString();
      window.__forgeMock!.emit(k, 'conversation.message', {
        message: { role: 'assistant', content: '本轮回复完成，权威终态内容。', ts: later },
      });
    },
    [sid] as const,
  );
  await page.evaluate(([k]) => {
    window.__forgeMock!.emit(k, 'conversation.statusChanged', { status: 'done' });
  }, [sid] as const);
  await expect(page.locator('.msg-assistant').last().locator('.msg-content')).toContainText('权威终态内容', {
    timeout: 8_000,
  });

  // 卡片数量不变（没有多推一条），且节点标记仍在 = 原地更新未重挂
  await expect(page.locator('.msg-assistant')).toHaveCount(cardsDuringStream);
  expect(await readLastAssistantTag(page)).toBe('tagged');

  health.assertHealthy();
});
