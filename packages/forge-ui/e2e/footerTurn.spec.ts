/**
 * footer 轮次分组回归（E-CV-FOOTER-001）。
 *
 * 背景：pi 每次 LLM 调用各发一条 assistant 消息，一次回复被工具调用拆成多张卡片时，
 * 每张卡片都渲染 footer（复制+时间），出现"一次回复多个复制按钮"。
 * 规则：同一轮（user 消息为边界）的多条 assistant 分片中，仅最后一张显示 footer。
 *
 * 使用 mock 种子会话「代码审查」：user → tool → assistant → tool → assistant，
 * 历史回显即复现原 bug 场景。
 */
import { test, expect } from '@playwright/test';
import { attachHealthGuards, waitForMock } from './helpers/index';

test('E-CV-FOOTER-001 @P0 @mock-backend：一次回复被工具拆成多张 assistant 卡片时仅末卡显示 footer', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);

  await page.locator('.tree-session', { hasText: '代码审查' }).click();
  await expect(page.locator('.msg-assistant')).toHaveCount(2, { timeout: 8_000 });

  // 两条 assistant 分片卡片：第一条无 footer，第二条（轮末）有 footer
  const assistants = page.locator('.msg-assistant');
  await expect(assistants.nth(0).locator('.msg-footer')).toHaveCount(0);
  await expect(assistants.nth(1).locator('.msg-footer')).toHaveCount(1);

  // 整场会话 footer 总数 = 1（user）+ 1（assistant 末卡）= 2
  await expect(page.locator('.msg-footer')).toHaveCount(2);

  // 末卡复制按钮存在且可交互（复制内容为整轮文本由单元逻辑保证，这里验证入口唯一）
  await expect(assistants.nth(1).locator('.msg-copy')).toBeVisible();

  health.assertHealthy();
});
