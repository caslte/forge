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