/**
 * 改动文件汇总卡片 E2E（E-CV-FILES-001~004，mock-backend）。
 *
 * 覆盖：历史回显（折叠默认/头部展开/行点击行内 diff/行级与总统计/相对路径）、
 * pi 真实入参形状的工具卡 diff 恢复渲染（多 hunk 逐块 + 旧形状兼容）、
 * 流式中卡片随工具完成渐进出现、失败/read 工具不计入。
 * 数据链路见 docs/api/04_tool.md §2 与 docs/api/03_conversation.md §3。
 */
import { test, expect } from '@playwright/test';
import { attachHealthGuards, seedSessions, seedHistory, waitForMock } from './helpers/index';

const PROJECT = 'D:/work/aiwork/forge';

function mkSession(sid: string, alias: string): Record<string, unknown> {
  return {
    sessionId: sid,
    projectPath: PROJECT,
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

async function openSeededSession(page: import('@playwright/test').Page, alias: string): Promise<void> {
  await page.locator('.tree-session', { hasText: alias }).first().click();
}

/** 折叠断言辅助：0fr 折叠是 overflow 裁剪（行自身 bounding box 非空，toBeHidden 不适用），
 *  以壳层实际渲染高度为准（含 200ms 过渡轮询） */
function shellHeight(locator: import('@playwright/test').Locator): Promise<number> {
  return locator.evaluate((el) => el.getBoundingClientRect().height);
}

test('E-CV-FILES-001 @P0 @mock-backend：历史回显——卡片默认折叠，展开后行级统计与行内 diff 可用', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-1', '汇总卡片回显')]);
  await seedHistory(page, 'sess-cf-1', [
    { id: 'm1', role: 'user', content: '改代码', ts: '2026-09-08T01:00:00.000Z' },
    {
      id: 't1', role: 'tool', content: 'Edited', ts: '2026-09-08T01:00:05.000Z',
      toolEventId: 'te-1', toolName: 'edit', status: 'completed',
      input: {
        path: `${PROJECT}/packages/forge-ui/src/a.ts`,
        edits: [{ oldText: 'x', newText: 'y' }, { oldText: '1', newText: '2\n3' }],
      },
    },
    {
      id: 't2', role: 'tool', content: 'Written', ts: '2026-09-08T01:00:06.000Z',
      toolEventId: 'te-2', toolName: 'write', status: 'completed',
      input: { path: `${PROJECT}/docs/b.md`, content: 'l1\nl2\nl3' },
    },
    { id: 'm2', role: 'assistant', content: '完成', ts: '2026-09-08T01:00:10.000Z' },
  ]);
  await page.reload();
  await openSeededSession(page, '汇总卡片回显');

  // 卡片出现在轮末，默认折叠：头部可见、壳层高度为 0
  const card = page.locator('.changed-files');
  const shell = card.locator('.cf-body-shell');
  await expect(card).toBeVisible();
  await expect(card.locator('.cf-count')).toHaveText('2 个文件已更改');
  await expect(card.locator('.cf-add').first()).toHaveText('+6');
  await expect(card.locator('.cf-del').first()).toHaveText('-2');
  await expect(card.locator('.cf-row')).toHaveCount(2);
  await expect.poll(shellHeight.bind(null, shell)).toBeLessThan(1);

  // 头部展开：壳层展开，行级 文件名 / 相对路径（剥项目根前缀）/ 行级统计
  await card.locator('.cf-head').click();
  await expect.poll(shellHeight.bind(null, shell)).toBeGreaterThan(20);
  const rowA = card.locator('.cf-row', { hasText: 'a.ts' });
  const rowB = card.locator('.cf-row', { hasText: 'b.md' });
  await expect(rowA).toBeVisible();
  await expect(rowA.locator('.cf-path')).toHaveText('packages/forge-ui/src/a.ts');
  await expect(rowA.locator('.cf-add')).toHaveText('+3');
  await expect(rowA.locator('.cf-del')).toHaveText('-2');
  await expect(rowB.locator('.cf-add')).toHaveText('+3');
  await expect(rowB.locator('.cf-del')).toHaveText('-0');

  // 行点击：行内展开 diff（edit 多 hunk → hunk 1/2 标签；行号列存在），行间互斥
  await rowA.click();
  const wrapA = card.locator('.cf-diff-wrap');
  await expect(wrapA).toBeVisible();
  await expect(wrapA.locator('.hunk-tag')).toHaveText(['hunk 1/2', 'hunk 2/2']);
  await expect(wrapA.locator('.diff-view')).toHaveCount(2);
  await expect(wrapA.locator('.diff-num', { hasText: '1' }).first()).toBeVisible();
  await rowB.click();
  await expect(card.locator('.cf-diff-wrap')).toHaveCount(1);
  // write 行展开：3 行纯新增
  const wrapB = card.locator('.cf-diff-wrap');
  await expect(wrapB.locator('.cell-added')).toHaveCount(3);

  // 再点同一行收起；头部再折叠（壳层高度回 0）
  await rowB.click();
  await expect(card.locator('.cf-diff-wrap')).toHaveCount(0);
  await card.locator('.cf-head').click();
  await expect.poll(shellHeight.bind(null, shell)).toBeLessThan(1);

  health.assertHealthy();
});

test('E-CV-FILES-002 @P0 @mock-backend：真实 pi 入参的工具卡 diff 恢复渲染（多 hunk）+ 旧形状兼容', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-2', '工具卡diff修复')]);
  await seedHistory(page, 'sess-cf-2', [
    { id: 'm1', role: 'user', content: '改两个文件', ts: '2026-09-08T02:00:00.000Z' },
    {
      id: 't1', role: 'tool', content: 'Edited', ts: '2026-09-08T02:00:05.000Z',
      toolEventId: 'te-1', toolName: 'edit', status: 'completed',
      input: {
        path: `${PROJECT}/src/big.ts`,
        edits: [{ oldText: 'a', newText: 'b' }, { oldText: 'c', newText: 'd' }],
      },
    },
    { id: 'm2', role: 'assistant', content: '继续', ts: '2026-09-08T02:00:06.000Z' },
    {
      id: 't2', role: 'tool', content: 'Edited', ts: '2026-09-08T02:00:07.000Z',
      toolEventId: 'te-2', toolName: 'edit', status: 'completed',
      input: { file_path: `${PROJECT}/legacy.ts`, old_string: 'a', new_string: 'b' },
    },
    { id: 'm3', role: 'assistant', content: '完成', ts: '2026-09-08T02:00:10.000Z' },
  ]);
  await page.reload();
  await openSeededSession(page, '工具卡diff修复');

  // 汇总卡片同时计入真实形状与旧形状
  const card = page.locator('.changed-files');
  await expect(card.locator('.cf-count')).toHaveText('2 个文件已更改');
  await expect(card.locator('.cf-row', { hasText: 'big.ts' })).toHaveCount(1);
  await expect(card.locator('.cf-row', { hasText: 'legacy.ts' })).toHaveCount(1);

  // 工具卡 diff（修复点：真实 pi 形状此前不渲染）：首个工具卡展开 → 每 hunk 一个 DiffView
  const firstCard = page.locator('.tool-calls').first();
  await firstCard.locator('.tool-calls-head').click();
  const diffs = firstCard.locator('.diff-view');
  await expect(diffs).toHaveCount(2);
  await expect(diffs.first().locator('.diff-file')).toHaveText('D:/work/aiwork/forge/src/big.ts');
  await expect(diffs.nth(1).locator('.diff-file')).toHaveCount(0);

  // 旧形状工具卡：单 DiffView 带文件名
  const secondCard = page.locator('.tool-calls').nth(1);
  await secondCard.locator('.tool-calls-head').click();
  await expect(secondCard.locator('.diff-view')).toHaveCount(1);
  await expect(secondCard.locator('.diff-file')).toHaveText('D:/work/aiwork/forge/legacy.ts');

  health.assertHealthy();
});

test('E-CV-FILES-003 @P1 @mock-backend：流式中卡片随工具完成渐进出现', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-3', '流式渐进卡片')]);
  await seedHistory(page, 'sess-cf-3', []);
  await page.reload();
  await openSeededSession(page, '流式渐进卡片');

  await page.evaluate(() => {
    return (window as unknown as { __forgeMock: { onSend: (sid: string, items: unknown[]) => void } }).__forgeMock.onSend(
      'sess-cf-3',
      [
        {
          type: 'tool',
          delayMs: 200,
          payload: {
            toolEventId: 'se-1', tool: {
              name: 'edit', input: { path: 'D:/work/aiwork/forge/s1.ts', edits: [{ oldText: 'x', newText: 'y' }] },
            },
          },
        },
        {
          type: 'tool',
          delayMs: 1500,
          payload: {
            toolEventId: 'se-2', tool: {
              name: 'write', input: { path: 'D:/work/aiwork/forge/s2.md', content: 'a\nb' },
            },
          },
        },
        { type: 'message', delayMs: 300, payload: { role: 'assistant', content: '完成', ts: '2026-09-08T03:00:10.000Z' } },
      ],
    );
  });

  const input = page.locator('.compose-input');
  await input.fill('帮我改代码');
  await input.press('Enter');

  const card = page.locator('.changed-files');
  // 第一个文件工具完成 → 卡片出现（1 个文件）
  await expect(card.locator('.cf-count')).toHaveText('1 个文件已更改', { timeout: 5_000 });
  // 第二个工具完成 → 增长为 2 个文件（write +2 -0）
  await expect(card.locator('.cf-count')).toHaveText('2 个文件已更改', { timeout: 5_000 });
  await expect(card.locator('.cf-add').first()).toHaveText('+3');
  await expect(card.locator('.cf-del').first()).toHaveText('-1');
  // 收尾 assistant 消息与卡片共存
  await expect(page.locator('.msg-assistant', { hasText: '完成' })).toBeVisible();
  await expect(card).toBeVisible();

  health.assertHealthy();
});

test('E-CV-FILES-004 @P1 @mock-backend：失败 / read 工具不计入汇总卡片', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-4', '排除口径')]);
  await seedHistory(page, 'sess-cf-4', [
    { id: 'm1', role: 'user', content: '看看就好', ts: '2026-09-08T04:00:00.000Z' },
    {
      id: 't1', role: 'tool', content: 'src/a.ts', ts: '2026-09-08T04:00:01.000Z',
      toolEventId: 'te-1', toolName: 'read', status: 'completed',
      input: { path: `${PROJECT}/src/a.ts` },
    },
    {
      id: 't2', role: 'tool', content: 'boom', ts: '2026-09-08T04:00:02.000Z',
      toolEventId: 'te-2', toolName: 'edit', status: 'error',
      input: { path: `${PROJECT}/src/a.ts`, edits: [{ oldText: 'x', newText: 'y' }] },
    },
    { id: 'm2', role: 'assistant', content: '讲一下思路', ts: '2026-09-08T04:00:05.000Z' },
  ]);
  await page.reload();
  await openSeededSession(page, '排除口径');

  await expect(page.locator('.msg-assistant', { hasText: '讲一下思路' })).toBeVisible();
  await expect(page.locator('.changed-files')).toHaveCount(0);

  health.assertHealthy();
});
