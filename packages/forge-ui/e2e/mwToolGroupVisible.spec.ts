/**
 * 回归：多窗口窄窗格下工具条不得被 flex 压缩消失。
 *
 * 根因（2026-09-04 用户反馈）：.wc-messages 是 flex column 滚动容器，展示项为
 * 直接子元素且默认 flex-shrink:1；内容超高时文本项压到 min-content 地板停住，
 * overflow:hidden 的 .tool-group/.tool-calls 地板为 0，吸收全部收缩量 → 高度归零，
 * 表现为“多窗口不显示工具调用条，文本正常”。
 * 修复：.wc-messages > * { flex-shrink: 0 }，超高走滚动。
 * 本用例用矮窗格 + 工具组历史锁行为：工具组头部必须可见（offsetHeight > 0）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, seedHistory } from './helpers/index';

const SID = 'sess-mw-toolgroup';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: SID,
    projectPath: 'D:/work/aiwork/forge',
    alias: '多窗口工具条',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

const history: Array<Record<string, unknown>> = [
  { id: 'm1', role: 'user', content: '帮我看看仓库结构', ts: '2026-09-04T01:00:00.000Z' },
  { id: 't1', role: 'tool', content: 'src/a.ts', ts: '2026-09-04T01:00:05.000Z', toolEventId: 'te-1', toolName: 'read', status: 'completed' },
  { id: 't2', role: 'tool', content: '匹配 3 处', ts: '2026-09-04T01:00:06.000Z', toolEventId: 'te-2', toolName: 'grep', status: 'completed' },
  { id: 'm2', role: 'assistant', content: '仓库结构如下……', ts: '2026-09-04T01:00:10.000Z' },
];

async function dragIn(page: Page): Promise<void> {
  const sessionEl = page.locator('.tree-session', { hasText: '多窗口工具条' }).first();
  const canvas = page.locator('.mw-canvas');
  const box = (await canvas.boundingBox())!;
  const dataTransfer = await page.evaluateHandle(() => new DataTransfer());
  await sessionEl.dispatchEvent('dragstart', { dataTransfer });
  await canvas.dispatchEvent('dragover', {
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    dataTransfer,
  });
  await canvas.dispatchEvent('drop', {
    clientX: box.x + box.width / 2,
    clientY: box.y + box.height / 2,
    dataTransfer,
  });
  await expect(page.locator('.mw-win')).toBeVisible();
}

test('多窗口窄窗格工具组保持可见（flex 不收缩） @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await seedHistory(page, SID, history);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();

  // 矮视口 → 画布/窗格必然矮于内容，锁住“内容超高”这一触发条件
  await page.setViewportSize({ width: 1280, height: 640 });
  await page.locator('.app-toolbar-btn', { hasText: '多窗口' }).click();
  await expect(page.locator('.mw-canvas')).toBeVisible();
  await dragIn(page);

  const group = page.locator('.mw-win .tool-group').first();
  await expect(group).toBeVisible();
  const h = await group.evaluate((el) => el.offsetHeight);
  expect(h, `工具组高度 ${h}px，被 flex 压缩不可见`).toBeGreaterThan(0);

  health.assertHealthy();
});
