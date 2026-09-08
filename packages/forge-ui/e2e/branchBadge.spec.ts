/**
 * 分支徽标与切换浮窗 E2E（docs/test/01_project/coverage-matrix.md E-PM-005~008，
 * AC-PM-013/014/015/016/017/018）。
 *
 * 自动化等级：mock-backend（mock-bridge git 状态机）。
 * 矩阵 E-PM-005/006/008 标 real-backend（临时 git 仓库），本 spec 以 mock 的
 * git/getBranchInfo + git/switchBranch 状态机表达同样业务断言：
 * - isGitRepo:false ↔ 非 git 目录项目（mock DB.git 未注册路径）
 * - dirty:true ↔ 未提交更改（mock 默认种子即 dirty，走确认框路径）
 * - 6001 + stderr ↔ checkout 冲突（mock 约定：目标分支名 '__conflict__' 返回
 *   6001 + git 原始 stderr 样例，浮窗不关、分支不变）
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  seedSessions,
  seedSendScript,
  waitForMock,
} from './helpers/index';

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

/** 覆盖 git/getBranchInfo（干净工作区 / 含冲突分支等自定义状态） */
async function seedBranchInfo(
  page: Page,
  data: Record<string, unknown>,
): Promise<void> {
  await waitForMock(page);
  await page.evaluate((d) => {
    window.__forgeMock!.seed('git/getBranchInfo', () => ({
      code: 0,
      message: 'ok',
      data: d,
    }));
  }, data);
}

// ===== E-PM-005（AC-PM-013）：git 项目显示分支徽标；非 git 项目徽标隐藏 =====
test('PM-E2E-005 @P0 @mock-backend E-PM-005：git 项目徽标显示当前分支，非 git 项目不渲染', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '会话A' })]);

  // 草稿态进入输入区（proj 菜单仅 draft 模式有「打开项目…」入口）
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  // 输入区项目 pill 旁出现徽标，显示当前分支（forge 在 mock DB.git 中 → isGitRepo:true）
  const badge = page.locator('.git-badge');
  await expect(badge.locator('.git-pill')).toBeVisible();
  await expect(badge.locator('.git-pill-name')).toHaveText('dev-v0.1.0');

  // 切到非 git 项目（mock selectDirectory 固定返回 D:/work/aiwork，不在 DB.git）
  await page.locator('.proj-pill').click();
  await page.locator('.proj-item', { hasText: '打开项目…' }).click();
  await expect(page.locator('.proj-pill')).toContainText('aiwork');
  // 徽标整体不渲染（无报错）
  await expect(page.locator('.git-badge')).toHaveCount(0);

  health.assertHealthy();
});

/** 注入有状态的 git 状态机（干净工作区：getBranchInfo/switchBranch 联动，等价真实仓库分支变更） */
async function seedCleanGit(page: Page): Promise<void> {
  await waitForMock(page);
  await page.evaluate(() => {
    let branch = 'dev-v0.1.0';
    const branches = ['dev-v0.1.0', 'main', 'feat/login', 'release/1.0'];
    window.__forgeMock!.seed('git/getBranchInfo', () => ({
      code: 0,
      message: 'ok',
      data: { isGitRepo: true, branch, branches: [...branches], dirty: false, detached: false },
    }));
    window.__forgeMock!.seed('git/switchBranch', (p) => {
      branch = String(p['branch'] ?? '');
      return { code: 0, message: 'ok', data: { branch } };
    });
  });
}

// ===== E-PM-006（AC-PM-014/015）：浮窗+过滤+当前高亮；切换成功徽标更新 =====
// 注：mock 默认 dirty:true，此处 seed 干净工作区（等价矩阵「干净时切换成功」/ AC-PM-015）。
test('PM-E2E-006 @P0 @mock-backend E-PM-006：点徽标弹浮窗，过滤生效，点选分支后徽标更新', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '会话A' })]);
  await seedCleanGit(page);
  await page.locator('.tree-session', { hasText: '会话A' }).click();

  // 点击徽标 → 浮窗出现：过滤输入框 + 分支列表 + 当前分支高亮
  await page.locator('.git-pill').click();
  const panel = page.locator('.git-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.git-filter')).toBeVisible();
  await expect(panel.locator('.git-item')).toHaveCount(4);
  await expect(panel.locator('.git-item.active')).toHaveText(/dev-v0.1.0/);
  await expect(panel.locator('.git-item.active .git-current')).toHaveText('当前');

  // 过滤：输入关键字后只剩匹配项
  await panel.locator('.git-filter').fill('feat');
  await expect(panel.locator('.git-item')).toHaveCount(1);
  await expect(panel.locator('.git-item')).toHaveText(/feat\/login/);

  // 点选目标分支 → 浮窗关闭，徽标更新为新分支（mock switchBranch 成功 + git.branchChanged）
  await panel.locator('.git-item', { hasText: 'feat/login' }).click();
  await expect(page.locator('.git-panel')).toHaveCount(0);
  await expect(page.locator('.git-pill-name')).toHaveText('feat/login');

  health.assertHealthy();
});

// ===== E-PM-007（AC-PM-016）：流式中徽标禁用不可点；结束后恢复 =====
test('PM-E2E-007 @P0 @mock-backend E-PM-007：会话流式中徽标禁用态点击不弹浮窗，结束后恢复', async ({ page }) => {
  const health = attachHealthGuards(page);
  const a = mkSession({ alias: '会话A' });
  await boot(page, [a]);

  // 流式脚本：delta 5s 长流（保持 streaming 窗口）→ message 终态
  await seedSendScript(page, a.sessionId as string, [
    { type: 'delta', delayMs: 5000, payload: { text: '思考中', kind: 'text' } },
    { type: 'message', delayMs: 100, payload: { role: 'assistant', content: '回答完成', ts: new Date().toISOString() } },
  ]);

  await page.locator('.tree-session', { hasText: '会话A' }).click();
  await expect(page.locator('.git-pill')).toBeVisible();

  // 发送消息进入流式
  await page.locator('.compose-input').fill('触发流式');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.compose-box')).toHaveClass(/streaming/);

  // 徽标禁用态：is-busy 类 + aria-disabled；点击不弹浮窗（togglePanel 忙时直接 return）
  const pill = page.locator('.git-pill');
  await expect(pill).toHaveClass(/is-busy/);
  await expect(pill).toHaveAttribute('aria-disabled', 'true');
  await expect(pill).toHaveAttribute('data-tooltip', '会话执行中');
  // aria-disabled 会让 Playwright 拒绝点击并重试到流式结束，force 才能真正打到
  // togglePanel 的忙时守卫（AC-PM-016：忙时点击无效、不发请求）
  await pill.click({ force: true });
  await expect(page.locator('.git-panel')).toHaveCount(0);

  // 结束流式：compose 流式态由 conversation.statusChanged done 驱动（session.updated
  // 已在脚本耗尽时自动广播，仅解除徽标忙态）
  await page.evaluate(
    ([sid]) => window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' }),
    [a.sessionId] as const,
  );
  await expect(page.locator('.compose-box')).not.toHaveClass(/streaming/);

  // 恢复可点：禁用态消失，点击弹浮窗
  await expect(pill).not.toHaveClass(/is-busy/);
  await expect(pill).toHaveAttribute('aria-disabled', 'false');
  await pill.click();
  await expect(page.locator('.git-panel')).toBeVisible();

  health.assertHealthy();
});

// ===== E-PM-008a（AC-PM-017）：dirty 先确认；取消不切换；确认才切换 =====
test('PM-E2E-008a @P0 @mock-backend E-PM-008：dirty 工作区弹确认框，取消不切换、确认后成功', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '会话A' })]);
  // 不 seed：mock 默认 forge = dirty:true（等价矩阵「未提交更改」）
  await page.locator('.tree-session', { hasText: '会话A' }).click();
  await expect(page.locator('.git-pill-name')).toHaveText('dev-v0.1.0');

  // 点选目标分支 → 出现确认框（dirty 且目标 ≠ 当前）
  await page.locator('.git-pill').click();
  const panel = page.locator('.git-panel');
  await panel.locator('.git-item', { hasText: 'main' }).click();
  await expect(panel.locator('.menu-hint')).toHaveText('确认切换分支');
  await expect(panel.locator('.git-confirm-desc')).toContainText('未提交更改');

  // 取消：浮窗关闭，分支不变
  await panel.locator('.git-btn', { hasText: '取消' }).click();
  await expect(page.locator('.git-panel')).toHaveCount(0);
  await expect(page.locator('.git-pill-name')).toHaveText('dev-v0.1.0');

  // 重开 → 再点选 → 确认「仍要切换」→ 成功切换
  await page.locator('.git-pill').click();
  await page.locator('.git-panel .git-item', { hasText: 'main' }).click();
  await expect(page.locator('.git-panel .git-confirm-desc')).toBeVisible();
  await page.locator('.git-btn-danger', { hasText: '仍要切换' }).click();
  await expect(page.locator('.git-panel')).toHaveCount(0);
  await expect(page.locator('.git-pill-name')).toHaveText('main');

  health.assertHealthy();
});

// ===== E-PM-008b（AC-PM-018）：切换冲突 → 浮窗内展示 git 错误原文，分支不变 =====
test('PM-E2E-008b @P0 @mock-backend E-PM-008：切换冲突 6001，浮窗展示 stderr 原文且分支不变', async ({ page }) => {
  const health = attachHealthGuards(page);
  await boot(page, [mkSession({ alias: '会话A' })]);
  // 干净工作区 + 冲突分支（mock 约定：目标分支名 '__conflict__' → 6001 + git stderr）
  await seedBranchInfo(page, {
    isGitRepo: true,
    branch: 'dev-v0.1.0',
    branches: ['dev-v0.1.0', 'main', '__conflict__'],
    dirty: false,
    detached: false,
  });
  await page.locator('.tree-session', { hasText: '会话A' }).click();

  await page.locator('.git-pill').click();
  await page.locator('.git-panel .git-item', { hasText: '__conflict__' }).click();

  // 浮窗不关：展示 git 原始 stderr；分支不变
  const panel = page.locator('.git-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.git-stderr')).toContainText('would be overwritten by checkout');
  await expect(panel.locator('.git-stderr')).toContainText('Please commit your changes or stash them');
  await expect(page.locator('.git-pill-name')).toHaveText('dev-v0.1.0');

  health.assertHealthy();
});
