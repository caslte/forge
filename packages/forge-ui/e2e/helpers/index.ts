/**
 * E2E 通用助手：console/pageerror 健康守卫 + mock 种子工具。
 *
 * 每条用例按 docs/test 通用健康断言要求：无未声明 console error /
 * pageerror / requestfailed；结束无残留 streaming cursor。
 */
import { expect, type Page } from '@playwright/test';

/** 启动健康守卫：收集 console error / pageerror。断言时调用 assertHealthy()。 */
export function attachHealthGuards(page: Page): { assertHealthy: () => void } {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('pageerror', (err) => {
    pageErrors.push(String(err));
  });
  return {
    assertHealthy() {
      // 未声明错误：允许 Vue 开发提示之外的静默；实际 E2E 没有未捕获错误
      expect(pageErrors, `pageerror: ${pageErrors.join(' | ')}`).toEqual([]);
      const severe = consoleErrors.filter(
        (e) => !/Download the Vue Devtools/i.test(e),
      );
      expect(severe, `console error: ${severe.join(' | ')}`).toEqual([]);
    },
  };
}

/** 断言消息流末尾无残留 streaming 光标 / loading 态 */
export async function assertNoResidualStreaming(page: Page): Promise<void> {
  await expect(page.locator('.msg-cursor')).toHaveCount(0, { timeout: 3_000 });
  await expect(page.locator('.conv-loading')).toHaveCount(0);
}

/** 等待 window.__forgeMock 可用（mock-bridge 注入） */
export async function waitForMock(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__forgeMock !== undefined);
}

/** 通过 window.__forgeMock 设置会话种子（querySessionList 生效） */
export async function seedSessions(page: Page, sessions: Array<Record<string, unknown>>): Promise<void> {
  await waitForMock(page);
  await page.evaluate((list) => {
    window.__forgeMock!.setSessions(list);
  }, sessions);
}

/** 通过 window.__forgeMock 设置项目种子（空数组=零项目落地场景；reload 保留） */
export async function seedProjects(page: Page, projects: Array<Record<string, unknown>>): Promise<void> {
  await waitForMock(page);
  await page.evaluate((list) => {
    window.__forgeMock!.setProjects(list);
  }, projects);
}

/** 设置会话历史种子 */
export async function seedHistory(
  page: Page,
  sessionId: string,
  messages: Array<Record<string, unknown>>,
): Promise<void> {
  await waitForMock(page);
  await page.evaluate(
    ([sid, msgs]) => {
      window.__forgeMock!.setHistory(sid, msgs);
    },
    [sessionId, messages] as const,
  );
}

/** 读取 mock 当前会话列表（动态新建会话 id 需从 mock 侧获取） */
export async function listMockSessions(
  page: Page,
): Promise<Array<{ sessionId: string; alias: string | null }>> {
  await waitForMock(page);
  return page.evaluate(() => window.__forgeMock!.getSessions());
}

/** 配置会话发送脚本（sendMessage 后被按序发射） */
export async function seedSendScript(
  page: Page,
  sessionId: string,
  script: Array<{
    type: 'delta' | 'message' | 'tool';
    delayMs?: number;
    payload: Record<string, unknown>;
  }>,
): Promise<void> {
  await waitForMock(page);
  await page.evaluate(
    ([sid, items]) => {
      window.__forgeMock!.onSend(sid, items as never);
    },
    [sessionId, script] as const,
  );
}

/* ===== 项目树折叠（v6.26：项目文件夹默认全收起，用例需展开后才能点会话行） ===== */

/**
 * 展开单个项目（按项目路径 / 别名 / 路径末段定位 .tree-project 行，点折叠箭头）。
 * 默认折叠后各用例要把会话行展开出来，统一走这里，避免每处手点选择器。
 */
export async function expandProject(page: Page, nameOrPath: string): Promise<void> {
  const project = page.locator('.tree-project').filter({
    has: page.locator(`.tree-node-title[title="${nameOrPath}"]`),
  });
  const row = (await project.count()) > 0
    ? project.first()
    : page.locator('.tree-project', { hasText: nameOrPath }).first();
  // 状态感知：已是展开态（折叠项目）就不点，避免把已展开的项目误点回收起
  const arrow = row.locator('.tree-arrow');
  if ((await arrow.getAttribute('aria-label')) === '展开项目') {
    await arrow.click();
  }
}

/**
 * 展开项目树里全部项目（不含自由分组；任务视角无项目行，安全空操作）。
 * 状态感知：只点仍处于「展开项目」态的箭头（locale 由 playwright.config 钉死 zh-CN），
 * 避免把用例前段经「新会话」等路径已自动展开的项目误点回收起；
 * 有界重试兜底项目列表中途被 re-query 替换导致的漏点，终态统一校验。
 */
export async function expandAllProjects(page: Page): Promise<void> {
  // 记住展开前的树滚动位置：逐个点箭头时 Playwright 会把每个箭头自动滚进视口，
  // 展开后树停在底部；依赖「树从顶部开始」的用例（如 tooltip 滚动回归）会被带偏
  const scrollTopBefore = await page
    .evaluate(() => (document.querySelector('.project-tree') as HTMLElement | null)?.scrollTop ?? null)
    .catch(() => null);
  const pending = page.locator('.tree-project .tree-arrow[aria-label="展开项目"]');
  for (let round = 0; round < 10; round += 1) {
    if ((await pending.count()) === 0) break;
    // 每轮都点「第一个未展开」：点击后它的 label 翻转，下一枚举自动后移；
    // 列表中途重渲染时 nth(0) 也始终落在真实未展开的箭头上
    const n = await pending.count();
    for (let i = 0; i < n; i += 1) {
      if ((await pending.count()) === 0) break;
      await pending.first().click();
    }
    await page.waitForTimeout(50);
  }
  // 终态校验：不应再有任何「展开项目」态箭头
  await expect(pending).toHaveCount(0);
  // 还原滚动位置（树容器不存在/此前未滚过则为空操作）
  if (scrollTopBefore !== null) {
    await page.evaluate((top) => {
      const scroller = document.querySelector('.project-tree') as HTMLElement | null;
      if (scroller) scroller.scrollTop = top;
    }, scrollTopBefore);
  }
}