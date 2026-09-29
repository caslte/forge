/**
 * 一次性排查脚本：用户反馈子 agent 视图里工具条「看不见」（渲染成极淡污迹）。
 * 打开结果视图后量测 .stg-head 及子元素的计算样式与几何，并截图。
 */
import { test, expect, type Page } from '@playwright/test';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: 'sess-bar',
    projectPath: 'D:/work/aiwork/forge',
    alias: '工具条排查',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

test('repro: stg-head 可见性', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto('/');
  await page.evaluate((list) => window.__forgeMock!.setSessions(list), [mkSession()]);
  await page.reload();
  await expect(page.locator('.tree-session')).toBeVisible({ timeout: 15_000 });
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();

  await page.evaluate(() => {
    window.__forgeMock!.emit('sess-bar', 'subagent.updated', {
      subagent: {
        agentId: 'agent-1',
        agentType: 'general-purpose',
        description: '排查工具条',
        status: 'running',
        startedAt: new Date(Date.now() - 60_000).toISOString(),
        finishedAt: null,
        result: null,
        error: null,
      },
    });
  });
  await expect(page.locator('.subagent-tabbar')).toBeVisible();
  await page.locator('.subagent-tab').nth(1).click();
  await expect(page.locator('.subagent-result-view')).toBeVisible();
  await page.waitForTimeout(2_000);

  const data = await page.evaluate(() => {
    const pick = (el: Element | null) => {
      if (!el) return null;
      const cs = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return {
        text: (el.textContent ?? '').slice(0, 30),
        rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
        color: cs.color,
        fill: cs.webkitTextFillColor ?? (cs as CSSStyleDeclaration & { webkitTextFillColor?: string }).webkitTextFillColor,
        bg: cs.backgroundColor,
        bgImage: cs.backgroundImage.slice(0, 60),
        bgClip: cs.backgroundClip,
        fontSize: cs.fontSize,
        opacity: cs.opacity,
        filter: cs.filter,
        transform: cs.transform,
        visibility: cs.visibility,
      };
    };
    return {
      group: pick(document.querySelector('.srv-tool-group')),
      head: pick(document.querySelector('.stg-head')),
      icon: pick(document.querySelector('.stg-icon')),
      label: pick(document.querySelector('.stg-label')),
      count: pick(document.querySelector('.stg-count')),
      chip: pick(document.querySelector('.stg-chip')),
      collapse: pick(document.querySelector('.stg-collapse')),
      textNode: pick(document.querySelector('.srv-stream-text')),
    };
  });
  console.log('PICK ' + JSON.stringify(data, null, 1));
  await page.locator('.srv-body').screenshot({ path: 'test-results/stg-head-repro.png' });
  expect(1).toBe(1);
});
