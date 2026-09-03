/**
 * 一次性复现脚本（非门禁用例）：用户反馈"子agent的工具条有时候被压窄"。
 * 在多个视口宽度下注入运行中子 agent，打开结果视图，截图 + 量测关键元素宽度。
 */
import { test, expect, type Page } from '@playwright/test';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: 'sess-repro',
    projectPath: 'D:/work/aiwork/forge',
    alias: '复现会话',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

async function boot(page: Page): Promise<void> {
  await page.goto('/');
  await page.evaluate((list) => window.__forgeMock!.setSessions(list), [mkSession()]);
  await page.reload();
  await awaitTree(page);
}

async function awaitTree(page: Page): Promise<void> {
  await expect(page.locator('.tree-session')).toBeVisible({ timeout: 15_000 });
}

async function openSubagentView(page: Page, desc: string): Promise<void> {
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await page.evaluate(([sessionId, description]) => {
    window.__forgeMock!.emit(sessionId as string, 'subagent.updated', {
      subagent: {
        agentId: 'agent-1',
        agentType: 'general-purpose',
        description: description as string,
        status: 'running',
        startedAt: new Date(Date.now() - 298_000).toISOString(),
        finishedAt: null,
        result: null,
        error: null,
      },
    });
  }, ['sess-repro', desc]);
  await expect(page.locator('.subagent-tabbar')).toBeVisible();
  await page.locator('.subagent-tab', { hasText: '获取' }).or(page.locator('.subagent-tab').nth(1)).first().click();
  await expect(page.locator('.subagent-result-view')).toBeVisible();
  await page.waitForTimeout(2_500);
}

async function measure(page: Page): Promise<void> {
  const data = await page.evaluate(() => {
    const w = (el: Element | null | undefined): number | null =>
      el ? Math.round(el.getBoundingClientRect().width) : null;
    const header = document.querySelector('.srv-header');
    return {
      viewport: window.innerWidth,
      view: w(document.querySelector('.subagent-result-view')),
      body: w(document.querySelector('.srv-body')),
      header: w(header),
      name: w(document.querySelector('.srv-name')),
      badge: w(document.querySelector('.srv-type-badge')),
      status: w(document.querySelector('.srv-status-text')),
      elapsed: w(document.querySelector('.srv-elapsed')),
      stop: w(document.querySelector('.srv-stop-btn')),
      firstTool: w(document.querySelector('.srv-stream-tool')),
      firstToolGroup: w(document.querySelector('.srv-tool-group')),
      nameScrollOver: (() => {
        const el = document.querySelector('.srv-name');
        return el ? el.scrollWidth - el.clientWidth : null;
      })(),
      headerOver: header ? header.scrollWidth - header.clientWidth : null,
    };
  });
  console.log('MEASURE ' + JSON.stringify(data, null, 1));
}

test('repro: 子agent工具条宽度 @repro', async ({ page }) => {
  let booted = false;
  for (const width of [1280, 700, 500]) {
    await page.setViewportSize({ width, height: 760 });
    if (!booted) {
      await boot(page);
      booted = true;
    }
    await openSubagentView(page, '获取裁断图中的元素');
    await page.screenshot({ path: `test-results/repro-${width}-short.png` });
    await measure(page);

    // 长描述名场景
    await page.evaluate(() => {
      window.__forgeMock!.emit('sess-repro', 'subagent.updated', {
        subagent: {
          agentId: 'agent-1',
          agentType: 'general-purpose',
          description: '扫描仓库内所有重复的工具调用逻辑并抽取公共函数保持行为不变',
          status: 'running',
          startedAt: new Date(Date.now() - 298_000).toISOString(),
          finishedAt: null,
          result: null,
          error: null,
        },
      });
    });
    await page.waitForTimeout(300);
    await page.screenshot({ path: `test-results/repro-${width}-long.png` });
    await measure(page);
  }
});
