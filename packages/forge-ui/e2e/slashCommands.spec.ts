/**
 * 斜杠命令浮窗 E2E（docs/test/03_conversation/e2e.md E-CV-014~018，模块 03 CV-S08）。
 * 自动化等级：mock-backend（window.__forgeMock 种子 + emit 受控事件）。
 *
 * 覆盖：
 * - E-CV-014（AC-CV-026/027/028）：触发/美化/过滤/空态 + streaming 期间 textarea 禁用、浮窗不出现；
 * - E-CV-015（AC-CV-029）：↑↓ 循环导航 + Enter/Tab/鼠标单击选择，插入原始命令串（美化名不进入输入框），
 *   浮窗打开期间 Enter 被消费（不发送消息）；
 * - E-CV-016（AC-CV-030）：四关闭路径（Esc / 失焦 / 删空行首 / 行内空格）+ 关闭后 Enter 恢复发送；
 * - E-CV-017（AC-CV-032）：草稿态列出 skills+模板（无扩展命令），激活后 emit slashCommandsUpdated
 *   使缓存失效重拉，扩展命令出现且 getSlashCommands 携 sessionId 再次调用；
 * - E-CV-018（AC-CV-033）：枚举失败（空清单）降级不阻塞：显示「无可用命令」、输入保留、普通消息正常发送。
 */
import { test, expect, type Page } from '@playwright/test';
import {
  attachHealthGuards,
  waitForMock,
  seedSessions,
  listMockSessions,
} from './helpers/index';

const SESSION_ID = 'sess-slash';

declare global {
  interface Window {
    /** getSlashCommands 调用参数记录（断言第二次携带 sessionId） */
    __scCalls?: Array<{ sessionId: string | undefined }>;
  }
}

/** 三类命令清单：skill / extension（review-pr）+ prompt（write-tests，无描述） */
const CMD_SKILL = { name: 'skill:git-push', description: '推送当前分支', source: 'skill' };
const CMD_EXT = { name: 'review-pr', description: '审查拉取请求', source: 'extension' };
const CMD_PROMPT = { name: 'write-tests', description: null, source: 'prompt' };

function mkSession(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    projectPath: 'D:/work/aiwork/forge',
    alias: '斜杠会话',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
    ...over,
  };
}

/** 三门命令清单的扩展 seed（整单覆盖 mock 默认三态清单） */
async function seedThreeCommands(page: Page): Promise<void> {
  await page.evaluate((cmds) => {
    window.__forgeMock!.seed('conversation/getSlashCommands', () => ({
      code: 0,
      message: 'ok',
      data: { commands: cmds as { name: string; description: string | null; source: string }[] },
    }));
  }, [CMD_SKILL, CMD_EXT, CMD_PROMPT]);
}

/** 进入应用并打开「斜杠会话」 */
async function boot(page: Page, withSeed: boolean = true): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  await page.locator('.tree-session').first().click();
  await expect(page.locator('.compose-box')).toBeVisible();
  if (withSeed) await seedThreeCommands(page);
}

/** 在输入框行首触发斜杠浮窗（打开前点击聚焦） */
async function openSlash(page: Page, fragment = '/'): Promise<void> {
  await page.locator('.compose-input').click();
  await page.locator('.compose-input').fill(fragment);
}

// ===== E-CV-014（AC-CV-026/027/028）：触发/美化/过滤/空态 + streaming 禁用 =====
test('TSC-E2E-001 @P0 @mock-backend E-CV-014：触发弹窗、三类条目美化+标签+副文本、过滤、空态、streaming 可用（CV-S09）', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  // 1. 触发：行首 / → 浮窗向上弹出
  await openSlash(page, '/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await expect(page.locator('.slash-item')).toHaveCount(3);

  // 2. 美化 + 来源标签 + 副文本
  const skill = page.locator('.slash-item').nth(0);
  await expect(skill).toContainText('Git Push'); // 去掉 skill: 前缀 + Title Case
  await expect(skill).toContainText('技能');
  await expect(skill).toContainText('推送当前分支');

  const ext = page.locator('.slash-item').nth(1);
  await expect(ext).toContainText('Review Pr');
  await expect(ext).toContainText('命令');

  const prompt = page.locator('.slash-item').nth(2);
  await expect(prompt).toContainText('Write Tests');
  await expect(prompt).toContainText('模板');
  // 无描述项（description: null）不渲染副文本行
  await expect(prompt.locator('.slash-desc')).toHaveCount(0);

  // 3. 过滤：skill 前缀 → 仅剩 skill:git-push
  await page.locator('.compose-input').pressSequentially('skill');
  await expect(page.locator('.slash-item')).toHaveCount(1);
  await expect(page.locator('.slash-item')).toContainText('Git Push');

  // 4. 空态（不回撤、不隐藏）：zzz 无匹配 → 显示「无匹配命令」
  await page.locator('.compose-input').pressSequentially('zzz');
  await expect(page.locator('.slash-empty')).toHaveText('无匹配命令');

  // 5. streaming 不禁用（CV-S09 忙时可输入/排队）：textarea 可写，斜杠浮窗正常触发
  await page.locator('.compose-input').fill('');
  await expect(page.locator('.slash-menu')).toHaveCount(0);
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'streaming' });
  }, SESSION_ID);
  await expect(page.locator('.compose-input')).toBeEnabled();
  await page.locator('.compose-input').pressSequentially('/');
  await expect(page.locator('.slash-menu')).toBeVisible();

  guard.assertHealthy();
});

// ===== E-CV-015（AC-CV-029）：导航/选择/插入原始串 =====
test('TSC-E2E-002 @P0 @mock-backend E-CV-015：↑↓循环导航 + Enter/Tab/单击选择，插入原始命令串，期间 Enter 不发送', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  // 打开浮窗，默认高亮首条
  await openSlash(page, '/');
  await expect(page.locator('.slash-item').nth(0)).toHaveClass(/highlighted/);

  // ↑↓ 循环：↓↓↓ → 末条 wrap 回首条（高亮回到首条）
  await page.locator('.compose-input').press('ArrowDown');
  await page.locator('.compose-input').press('ArrowDown');
  await page.locator('.compose-input').press('ArrowDown');
  await expect(page.locator('.slash-item').nth(0)).toHaveClass(/highlighted/);

  // Enter 选择：插入原始命令串 + 尾随空格，美化名不进入输入框；浮窗关闭；不发送
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.compose-input')).toHaveValue('/skill:git-push ');
  await expect(page.locator('.compose-input')).not.toHaveValue(/Git Push/);
  await expect(page.locator('.slash-menu')).toHaveCount(0);
  await expect(page.locator('.msg-user')).toHaveCount(0);

  // 重新打开 → Tab 选择（默认高亮首条）
  await page.locator('.compose-input').fill('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await page.locator('.compose-input').press('Tab');
  await expect(page.locator('.compose-input')).toHaveValue('/skill:git-push ');
  await expect(page.locator('.slash-menu')).toHaveCount(0);

  // 重新打开 → 鼠标单击第三条（write-tests）
  await page.locator('.compose-input').fill('/');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await page.locator('.slash-item').nth(2).click();
  await expect(page.locator('.compose-input')).toHaveValue('/write-tests ');
  await expect(page.locator('.slash-menu')).toHaveCount(0);
  await expect(page.locator('.compose-input')).not.toHaveValue(/Write Tests/);

  // 负向：全程未触发发送（无 user 气泡）
  await expect(page.locator('.msg-user')).toHaveCount(0);

  guard.assertHealthy();
});

// ===== E-CV-016（AC-CV-030）：四关闭路径 + Enter 恢复发送 =====
test('TSC-E2E-003 @P1 @mock-backend E-CV-016：Esc/失焦/删空行首/行内空格四路径关闭，关闭后 Enter 恢复发送', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);

  // 路径1：Esc
  await openSlash(page, '/g');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await page.locator('.compose-input').press('Escape');
  await expect(page.locator('.slash-menu')).toHaveCount(0);

  // 路径2：点击输入框外部（失焦）
  await openSlash(page, '/g');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await page.locator('.tree-panel').click();
  await expect(page.locator('.slash-menu')).toHaveCount(0);

  // 路径3：删空行首 /（两次 Backspace 去掉 '/g' → ''）
  await openSlash(page, '/g');
  await expect(page.locator('.slash-menu')).toBeVisible();
  await page.locator('.compose-input').press('Backspace');
  await page.locator('.compose-input').press('Backspace');
  await expect(page.locator('.slash-menu')).toHaveCount(0);

  // 路径4：行内空格（/git push）
  await openSlash(page, '/git ');
  await expect(page.locator('.slash-menu')).toHaveCount(0);

  // 路径5：关闭后输入普通文本 Enter → 恢复发送语义（消息正常发出，非无响应）
  await page.locator('.compose-input').fill('关闭后的普通消息');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.msg-user', { hasText: '关闭后的普通消息' })).toBeVisible();
  await expect(page.locator('.slash-menu')).toHaveCount(0);

  guard.assertHealthy();
});

// ===== E-CV-017（AC-CV-032）：草稿态 skills 可见 + 激活后扩展命令补全 =====
test('TSC-E2E-004 @P0 @mock-backend E-CV-017：草稿态 skills/模板无命令，激活后 emit slashCommandsUpdated 扩展命令补全', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await expect(page.locator('.tree-panel')).toBeVisible();
  // 记录 getSlashCommands 调用参数（返回 null 走 mock 双模式默认：无 sessionId → skills+模板；有 → 三类全量）
  await page.evaluate(() => {
    window.__scCalls = [];
    window.__forgeMock!.seed('conversation/getSlashCommands', (p) => {
      const sid = p.sessionId as string | undefined;
      window.__scCalls!.push({
        sessionId: typeof sid === 'string' && sid !== '' ? sid : undefined,
      });
      return null;
    });
  });

  // 草稿态：新会话
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();

  // 草稿态行首 / → 仅 skills + 模板（无「命令」来源，无扩展命令）
  await openSlash(page, '/');
  await expect(page.locator('.slash-item').first()).toBeVisible();
  await expect(page.locator('.slash-menu')).toContainText('技能');
  await expect(page.locator('.slash-menu')).toContainText('模板');
  await expect(page.locator('.slash-menu')).not.toContainText('命令');
  await expect(page.locator('.slash-item', { hasText: 'Review Pr' })).toHaveCount(0);

  // 发送首条消息（激活会话）→ 真正创建会话
  await page.locator('.compose-input').fill('激活会话');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.msg-user', { hasText: '激活会话' })).toBeVisible();

  // 取新建会话 id，并回补 done：无脚本时 mock 不会自动置终态，需模拟真实后端轮次结束的
  // 两侧事件 —— 树侧 DB 状态 done + session.updated 广播（App loadSessions 刷新，对应真实
  // setSessionStatus）；视图侧 conversation.statusChanged done（ConversationView 复位 isStreaming）。
  // 有脚本的会话（session.spec 等）树侧由 mock runScript 自动完成，仅需补视图侧。
  const sessions = await listMockSessions(page);
  const created = sessions.find((s) => s.sessionId !== SESSION_ID);
  expect(created).toBeTruthy();
  await page.evaluate((sid) => {
    const list = window
      .__forgeMock!.getSessions()
      .map((s) => (s.sessionId === sid ? { ...s, status: 'done' } : s));
    window.__forgeMock!.setSessions(list);
    // 'session.updated' 不在 MockControl.emit 事件联合内（e2e 不做类型检查，cast 后按
    // mock-backend 约定广播）；运行时 emit 直接透传给订阅者
    (window.__forgeMock as unknown as {
      emit: (s: string, e: string, p: Record<string, unknown>) => void;
    }).emit(sid, 'session.updated', {});
    window.__forgeMock!.emit(sid, 'conversation.statusChanged', { status: 'done' });
  }, created!.sessionId);
  await expect(page.locator('.compose-input')).toBeEnabled();

  // 注入 slashCommandsUpdated → 缓存失效（重拉带 sessionId）
  await page.evaluate((sid) => {
    window.__forgeMock!.emit(sid, 'conversation.slashCommandsUpdated', { sessionId: sid });
  }, created!.sessionId);

  // 重新输入 / → 扩展命令出现（来源「命令」+ review-pr 存在）
  await openSlash(page, '/');
  await expect(page.locator('.slash-menu')).toContainText('命令');
  await expect(page.locator('.slash-item', { hasText: 'Review Pr' })).toHaveCount(1);

  // 数据：第二次 getSlashCommands 携带 sessionId 被再次调用
  await page.waitForFunction(() => (window.__scCalls?.length ?? 0) >= 2);
  const calls = await page.evaluate(() => window.__scCalls!);
  const lastCall = calls[calls.length - 1]!;
  expect(lastCall.sessionId).toBe(created!.sessionId);

  guard.assertHealthy();
});

// ===== E-CV-018（AC-CV-033）：枚举失败降级 =====
test('TSC-E2E-005 @P1 @mock-backend E-CV-018：枚举失败（空清单）降级不阻塞，显示无可用命令且输入正常发送', async ({ page }) => {
  const guard = attachHealthGuards(page);
  await boot(page);
  // 空清单（枚举失败由后端收敛为空清单）
  await page.evaluate(() => {
    window.__forgeMock!.seed('conversation/getSlashCommands', () => ({
      code: 0,
      message: 'ok',
      data: { commands: [] },
    }));
  });

  // 行首 / → 浮窗显示「无可用命令」，已输入文本保留不被清空
  await openSlash(page, '/');
  await expect(page.locator('.slash-empty')).toHaveText('无可用命令');
  await expect(page.locator('.compose-input')).toHaveValue('/');

  // 清空后发送普通消息 → msg-user 正常出现，无全局错误弹窗，不阻塞
  await page.locator('.compose-input').fill('普通消息发送');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.msg-user', { hasText: '普通消息发送' })).toBeVisible();
  await expect(page.locator('.slash-menu')).toHaveCount(0);

  guard.assertHealthy();
});