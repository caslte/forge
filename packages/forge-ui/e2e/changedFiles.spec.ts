/**
 * 改动文件汇总卡片 E2E（E-CV-FILES-001~008，mock-backend）。
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

test('E-CV-FILES-005 @P1 @mock-backend：文件行右键菜单「打开所在目录」调用 shell.openPath（dirname）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-5', '右键打开目录')]);
  await seedHistory(page, 'sess-cf-5', [
    { id: 'm1', role: 'user', content: '改个文件', ts: '2026-09-08T05:00:00.000Z' },
    {
      id: 't1', role: 'tool', content: 'Edited', ts: '2026-09-08T05:00:05.000Z',
      toolEventId: 'te-1', toolName: 'edit', status: 'completed',
      input: {
        path: `${PROJECT}/packages/forge-ui/src/a.ts`,
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    },
    { id: 'm2', role: 'assistant', content: '完成', ts: '2026-09-08T05:00:10.000Z' },
  ]);
  // 监听 shell.openPath 调用（验证右键菜单真的把路径交给 IPC）
  await page.evaluate(() => {
    const w = window as unknown as { __openPathCalls: string[] };
    w.__openPathCalls = [];
    const orig = window.forge.shell.openPath.bind(window.forge.shell);
    window.forge.shell.openPath = (p: string) => {
      w.__openPathCalls.push(p);
      return orig(p);
    };
  });
  await page.reload();
  await waitForMock(page);
  // 必须在 reload 之后设置（reload 会清掉 window 注入）
  await page.evaluate(() => {
    const w = window as unknown as { __openPathCalls: string[] };
    w.__openPathCalls = [];
    const orig = window.forge.shell.openPath.bind(window.forge.shell);
    window.forge.shell.openPath = (p: string) => {
      w.__openPathCalls.push(p);
      return orig(p);
    };
  });
  await openSeededSession(page, '右键打开目录');

  const card = page.locator('.changed-files');
  await card.locator('.cf-head').click();
  const row = card.locator('.cf-row', { hasText: 'a.ts' });
  await expect(row).toBeVisible();

  // 右键触发菜单：Teleport 到 body，不在 card 子树下
  await row.click({ button: 'right' });
  const menu = page.locator('.cf-context-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.cf-context-menu-item')).toHaveText('打开所在目录');

  // 点菜单项 → shell.openPath 收到包含目录（剥文件名）
  await menu.locator('.cf-context-menu-item').click();
  const calls = await page.evaluate(() => (window as unknown as { __openPathCalls: string[] }).__openPathCalls);
  expect(calls).toEqual([`${PROJECT}/packages/forge-ui/src`]);

  // 点外部收起菜单
  await row.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.locator('body').click({ position: { x: 5, y: 5 } });
  await expect(menu).toHaveCount(0);

  // Escape 也能收起
  await row.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  health.assertHealthy();
});

test('E-CV-FILES-006 @P1 @mock-backend：diff 内容支持鼠标框选，行号不进选区', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-6', 'diff 框选')]);
  await seedHistory(page, 'sess-cf-6', [
    { id: 'm1', role: 'user', content: '改代码', ts: '2026-09-08T06:00:00.000Z' },
    {
      id: 't1', role: 'tool', content: 'Edited', ts: '2026-09-08T06:00:05.000Z',
      toolEventId: 'te-1', toolName: 'edit', status: 'completed',
      input: {
        path: `${PROJECT}/src/sel.ts`,
        edits: [{ oldText: 'alpha\nbeta', newText: 'gamma\nbeta' }],
      },
    },
    { id: 'm2', role: 'assistant', content: '完成', ts: '2026-09-08T06:00:10.000Z' },
  ]);
  await page.reload();
  await openSeededSession(page, 'diff 框选');

  const card = page.locator('.changed-files');
  await card.locator('.cf-head').click();
  await expect.poll(shellHeight.bind(null, card.locator('.cf-body-shell'))).toBeGreaterThan(20);
  const row = card.locator('.cf-row', { hasText: 'sel.ts' });
  await row.click();
  const wrap = card.locator('.cf-diff-wrap');
  await expect(wrap).toBeVisible();

  // 选择性是 CSS 行为，单测证不了：diff 单元格放开（text），行号列保持禁选（none）
  const cellSelect = await wrap.locator('.diff-cell').first().evaluate((el) => getComputedStyle(el).userSelect);
  const numSelect = await wrap.locator('.diff-num').first().evaluate((el) => getComputedStyle(el).userSelect);
  expect(cellSelect).toBe('text');
  expect(numSelect).toBe('none');

  // 真鼠标拖选——单行内从行首拖到行尾：选区正好是该行文本（复制一行代码的典型操作）
  const c1 = await wrap.locator('.diff-row').nth(0).locator('.diff-cell').first().boundingBox();
  expect(c1).toBeTruthy();
  await page.mouse.move(c1!.x + 10, c1!.y + c1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(c1!.x + c1!.width - 10, c1!.y + c1!.height / 2, { steps: 6 });
  await page.mouse.up();
  let sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel.replace(/\r\n/g, '\n')).toBe('alpha');

  // 跨行纵向框选左列：两行代码都进选区；行号列（'1'/'2'）不得作为独立行混入选区。
  // 先清掉上一轮选区：mousedown 落在既有选区内会触发「拖动已选文本」而非重新框选。
  // 起止点对齐到文本首尾（cell 左 padding 10px），避免切进字符中间
  await page.evaluate(() => window.getSelection()?.removeAllRanges());
  const c2 = await wrap.locator('.diff-row').nth(1).locator('.diff-cell').first().boundingBox();
  expect(c2).toBeTruthy();
  await page.mouse.move(c1!.x + 11, c1!.y + c1!.height / 2);
  await page.mouse.down();
  await page.mouse.move(c2!.x + c2!.width - 10, c2!.y + c2!.height / 2, { steps: 8 });
  await page.mouse.up();
  sel = await page.evaluate(() => window.getSelection()?.toString() ?? '');
  expect(sel).toContain('alpha');
  expect(sel).toContain('beta');
  expect(sel).not.toMatch(/(^|\n)\d+(\n|$)/);

  health.assertHealthy();
});

test('E-CV-FILES-007 @P1 @mock-backend：工具入参带 ./ 前缀时「打开所在目录」折叠中间 . 段', async ({ page }) => {
  // 实际 bug：入参 ./x 与项目根拼接后残留 /./ 段，ShellExecuteEx 不归一中间段
  // 会弹「Windows 找不到文件」——openPath 收到的必须是折叠后的包含目录
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-7', '前缀折叠')]);
  await seedHistory(page, 'sess-cf-7', [
    { id: 'm1', role: 'user', content: '改个文件', ts: '2026-09-08T07:00:00.000Z' },
    {
      id: 't1', role: 'tool', content: 'Edited', ts: '2026-09-08T07:00:05.000Z',
      toolEventId: 'te-1', toolName: 'edit', status: 'completed',
      input: {
        path: './packages/forge-ui/src/a.ts',
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    },
    { id: 'm2', role: 'assistant', content: '完成', ts: '2026-09-08T07:00:10.000Z' },
  ]);
  await page.reload();
  await waitForMock(page);
  await page.evaluate(() => {
    const w = window as unknown as { __openPathCalls: string[] };
    w.__openPathCalls = [];
    const orig = window.forge.shell.openPath.bind(window.forge.shell);
    window.forge.shell.openPath = (p: string) => {
      w.__openPathCalls.push(p);
      return orig(p);
    };
  });
  await openSeededSession(page, '前缀折叠');

  const card = page.locator('.changed-files');
  await card.locator('.cf-head').click();
  const row = card.locator('.cf-row', { hasText: 'a.ts' });
  await expect(row).toBeVisible();

  await row.click({ button: 'right' });
  const menu = page.locator('.cf-context-menu');
  await expect(menu).toBeVisible();

  await menu.locator('.cf-context-menu-item').click();
  const calls = await page.evaluate(() => (window as unknown as { __openPathCalls: string[] }).__openPathCalls);
  expect(calls).toEqual([`${PROJECT}/packages/forge-ui/src`]);

  health.assertHealthy();
});

test('E-CV-FILES-008 @P1 @mock-backend：HTML 文件行右键多出「用浏览器打开」，非 HTML 行菜单不串项', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-cf-8', '右键用浏览器打开')]);
  await seedHistory(page, 'sess-cf-8', [
    { id: 'm1', role: 'user', content: '写个原型页', ts: '2026-09-08T08:00:00.000Z' },
    {
      id: 't1', role: 'tool', content: 'Written', ts: '2026-09-08T08:00:05.000Z',
      toolEventId: 'te-1', toolName: 'write', status: 'completed',
      input: { path: `${PROJECT}/prototypes/queue-panel-redesign.html`, content: '<h1>a</h1>\n<p>b</p>' },
    },
    {
      id: 't2', role: 'tool', content: 'Written', ts: '2026-09-08T08:00:06.000Z',
      toolEventId: 'te-2', toolName: 'write', status: 'completed',
      input: { path: `${PROJECT}/packages/forge-ui/src/a.ts`, content: 'export const a = 1;' },
    },
    { id: 'm2', role: 'assistant', content: '完成', ts: '2026-09-08T08:00:10.000Z' },
  ]);
  await page.reload();
  await waitForMock(page);
  // 必须在 reload 之后挂（reload 会清掉 window 注入）：记录真实提交给 bridge 的绝对路径
  await page.evaluate(() => {
    const w = window as unknown as { __openInBrowserCalls: string[]; __openPathCalls: string[] };
    w.__openInBrowserCalls = [];
    w.__openPathCalls = [];
    const origBrowser = window.forge.shell.openInBrowser.bind(window.forge.shell);
    window.forge.shell.openInBrowser = (p: string) => {
      w.__openInBrowserCalls.push(p);
      return origBrowser(p);
    };
    const origPath = window.forge.shell.openPath.bind(window.forge.shell);
    window.forge.shell.openPath = (p: string) => {
      w.__openPathCalls.push(p);
      return origPath(p);
    };
  });
  await openSeededSession(page, '右键用浏览器打开');

  const card = page.locator('.changed-files');
  await card.locator('.cf-head').click();
  const htmlRow = card.locator('.cf-row', { hasText: 'queue-panel-redesign.html' });
  const tsRow = card.locator('.cf-row', { hasText: 'a.ts' });
  await expect(htmlRow).toBeVisible();
  await expect(tsRow).toBeVisible();
  const menu = page.locator('.cf-context-menu');

  // HTML 行：两项，「用浏览器打开」在前
  await htmlRow.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.cf-context-menu-item')).toHaveText(['用浏览器打开', '打开所在目录']);

  // 点第一项 → shell.openInBrowser 收到**文件本体**的绝对路径（不是目录）
  await menu.locator('.cf-context-menu-item').first().click();
  await expect(menu).toHaveCount(0);
  const browserCalls = await page.evaluate(() => (window as unknown as { __openInBrowserCalls: string[] }).__openInBrowserCalls);
  expect(browserCalls).toEqual([`${PROJECT}/prototypes/queue-panel-redesign.html`]);
  const dirCalls = await page.evaluate(() => (window as unknown as { __openPathCalls: string[] }).__openPathCalls);
  expect(dirCalls).toEqual([]);

  // HTML 行的「打开所在目录」仍是目录，两条动作互不串味
  await htmlRow.click({ button: 'right' });
  await menu.locator('.cf-context-menu-item', { hasText: '打开所在目录' }).click();
  const dirCalls2 = await page.evaluate(() => (window as unknown as { __openPathCalls: string[] }).__openPathCalls);
  expect(dirCalls2).toEqual([`${PROJECT}/prototypes`]);

  // 非 HTML 行：仍只有「打开所在目录」一项
  await tsRow.click({ button: 'right' });
  await expect(menu).toBeVisible();
  await expect(menu.locator('.cf-context-menu-item')).toHaveText('打开所在目录');

  health.assertHealthy();
});
