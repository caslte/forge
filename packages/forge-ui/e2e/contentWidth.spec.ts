/**
 * 个性化「内容宽度」偏好 E2E（standard 收拢居中 / wide 铺满，默认 standard）。
 *
 * 覆盖三件事：
 * 1. 默认（未写偏好）= 标准，正文/输入框/状态行同为 920px 且同轴居中；
 * 2. 切「宽」后正文列 = 铺满窗口，切回标准立即恢复收拢；
 * 3. 窗口窄于标准列宽时退化为满宽（min() 兜底），不会被压成窄条。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, expandAllProjects } from './helpers/index';

/** 新会话发一条消息 → 真实会话态（有消息流，非首屏 hero 草稿态） */
async function openConversation(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await page.locator('.compose-input').fill('把这个列表页改成虚拟滚动');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.conv-messages-inner .msg').first()).toBeVisible();
  await page.waitForTimeout(400);
}

/** 打开设置面板 → 个性化 Tab，点选内容宽度 */
async function setContentWidth(page: Page, label: '标准' | '宽'): Promise<void> {
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '个性化' }).click();
  await page.locator('.width-option', { hasText: label }).click();
  await expect(page.locator('.width-option.active')).toHaveText(label);
  await page.locator('.settings-back').click();
  // 等宽度过渡（--transition-decelerate 420ms）结束再量
  await page.waitForTimeout(700);
}

/** 量正文列 / 输入框 / 状态行的宽度与位置 */
async function widths(page: Page) {
  return page.evaluate(() => {
    const inner = document.querySelector('.conv-messages-inner') as HTMLElement;
    const box = document.querySelector('.compose-box') as HTMLElement;
    const status = document.querySelector('.compose-status') as HTMLElement | null;
    const view = document.querySelector('.conv-view') as HTMLElement;
    const ir = inner.getBoundingClientRect();
    return {
      inner: Math.round(ir.width),
      box: Math.round(box.getBoundingClientRect().width),
      status: status ? Math.round(status.getBoundingClientRect().width) : null,
      innerLeft: Math.round(ir.left),
      boxLeft: Math.round(box.getBoundingClientRect().left),
      viewLeft: Math.round(view.getBoundingClientRect().left),
      viewRight: Math.round(view.getBoundingClientRect().right),
      vw: window.innerWidth,
    };
  });
}

test('内容宽度：默认标准 = 收拢居中；切宽 = 铺满且仍与输入框对齐 @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await openConversation(page);

  // 默认（未设置偏好）= 标准
  expect(await page.evaluate(() => localStorage.getItem('forge:content-width'))).toBeNull();
  const def = await widths(page);
  expect(def.inner, '默认正文列 = 920px（--content-col-std）').toBe(920);
  expect(def.box, '默认输入框与正文列同宽').toBe(920);
  expect(Math.abs(def.innerLeft - def.boxLeft), '正文列左缘与输入框左缘对齐').toBeLessThanOrEqual(1);
  if (def.status !== null) {
    expect(Math.abs(def.status - 920), '状态行跟随列宽').toBeLessThanOrEqual(1);
  }
  // 居中：在会话视口（排除侧边栏）内左右留白相等（时间线窄条已对称补偿）
  const leftGap = def.innerLeft - def.viewLeft;
  const rightGap = def.viewRight - (def.innerLeft + def.inner);
  expect(Math.abs(leftGap - rightGap), `左留白 ${leftGap} / 右留白 ${rightGap}`).toBeLessThanOrEqual(2);

  await setContentWidth(page, '宽');
  expect(await page.evaluate(() => localStorage.getItem('forge:content-width'))).toBe('wide');
  const wide = await widths(page);
  // 「铺满」的判据必须相对**会话视口**（.conv-view 宽度 = 窗口 − 侧边栏），
  // 不能拿窗口宽度 vw 硬减一个估算值：会话视口比 vw 窄一个侧边栏（约 292px），
  // 再减去左缘时间线 rail（46px）——旧写法 vw-400 恰好卡在误差里，
  // 实测 1168 ~ 1170 与阈值 1200 差 30px，纯属估算失误而非布局回归。
  // 改为「占会话视口 ≥ 92%」，语义就是铺满，且不随侧栏/rail 宽度变化而假红。
  const viewW = wide.viewRight - wide.viewLeft;
  // 实测几何（vw=1600 / 侧栏 292 / 会话视口 1290 / 正文列 1168）：
  //   会话视口 = 侧栏之外的全部；正文列再让出左缘时间线 rail（46px）与两侧内边距，
  //   占会话视口 ≈ 90.5%。这是「铺满」的真实上限——再高就得压掉 rail 或内边距。
  // 判据取 ≥90% 并显式校验「不比标准模式的 920 宽」这层语义，
  // 双条件才能既拦住「宽模式没生效」又不受 rail/内边距微调影响。
  expect(wide.inner / viewW, `宽模式正文列 ${wide.inner}px / 会话视口 ${viewW}px 应 ≥90%`)
    .toBeGreaterThanOrEqual(0.9);
  expect(wide.inner, '宽模式必须明显宽于标准模式的 920px').toBeGreaterThan(1100);

  // 切回标准：立即恢复收拢
  await setContentWidth(page, '标准');
  expect(await page.evaluate(() => localStorage.getItem('forge:content-width'))).toBe('standard');
  expect((await widths(page)).inner, '切回标准后恢复 920px 收拢').toBe(920);

  health.assertHealthy();
});

test('内容宽度：新会话首屏（hero）输入框恒为 640px，标准模式不撑宽 @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await page.locator('.app-toolbar-btn', { hasText: '新会话' }).click();
  await expect(page.locator('.conv-input-wrap.hero-mode')).toBeVisible();

  const heroBoxW = async () => {
    await page.waitForTimeout(700);
    return page.evaluate(() => Math.round((document.querySelector('.compose-box') as HTMLElement).getBoundingClientRect().width));
  };

  expect(await heroBoxW(), '默认标准：首屏输入框收窄 640px').toBe(640);

  // 字标图片必须真的解码成功（naturalWidth > 0）：资源被删 / 引用后缀写错都会退化成破图，
  // 只断言「元素可见」抓不到这类问题
  const wordmark = await page.evaluate(() => {
    const img = document.querySelector('.conv-hero-wordmark.wm-dark') as HTMLImageElement | null;
    return { src: img?.getAttribute('src') ?? null, naturalWidth: img?.naturalWidth ?? 0 };
  });
  expect(wordmark.src, '首屏字标应指向 svg 资源').toMatch(/\.svg$/);
  expect(wordmark.naturalWidth, '首屏字标图片应加载成功（naturalWidth > 0）').toBeGreaterThan(0);

  await setContentWidth(page, '宽');
  expect(await heroBoxW(), '切宽后首屏输入框仍为 640px（hero 不随偏好变宽）').toBe(640);

  await setContentWidth(page, '标准');
  expect(await heroBoxW(), '切回标准后首屏输入框仍为 640px').toBe(640);

  health.assertHealthy();
});

test('内容宽度：Agent 行跟随正文列宽（标准模式收拢在列内） @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto('/');
  await seedSessions(page, [
    {
      sessionId: 'sess-cw-agent',
      projectPath: 'D:/work/aiwork/forge',
      alias: '会话CW',
      status: 'idle',
      lastActiveAt: new Date().toISOString(),
    },
  ]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  // v6.26 默认折叠：展开项目组
  await expandAllProjects(page);
  await page.locator('.tree-session', { hasText: '会话CW' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  // 先发一条消息离开首屏 hero（空会话输入框恒 640px，与列宽无关）
  await page.locator('.compose-input').fill('检查列宽对齐');
  await page.locator('.compose-input').press('Enter');
  await expect(page.locator('.conv-messages-inner .msg').first()).toBeVisible();

  // v6.37：Agent 行在消息流内，宽度由 .conv-messages-inner 列宽决定 ——
  // 标准模式下必须收拢在 920px 列内，宽模式下跟随铺满。
  const spawnAgentRow = async (): Promise<void> => {
    await page.evaluate((sid) => {
      window.__forgeMock!.setSubagents(sid, []);
      window.__forgeMock!.emit(sid, 'subagent.updated', {
        sessionId: sid,
        subagent: {
          agentId: 'a1',
          agentType: 'general-purpose',
          description: '检查列宽对齐',
          status: 'running',
          startedAt: new Date().toISOString(),
          finishedAt: null,
          result: null,
          error: null,
          usage: { inputTokens: 0, outputTokens: 0 },
        },
      });
    }, 'sess-cw-agent');
    await expect(page.locator('.agent-row')).toHaveCount(1, { timeout: 5_000 });
    await page.waitForTimeout(700); // 等列宽过渡结束再量
  };
  await spawnAgentRow();

  const rowMetrics = async () =>
    page.evaluate(() => {
      const inner = (document.querySelector('.conv-messages-inner') as HTMLElement).getBoundingClientRect();
      const row = (document.querySelector('.agent-row') as HTMLElement).getBoundingClientRect();
      const head = (document.querySelector('.agent-row .agent-head') as HTMLElement).getBoundingClientRect();
      return {
        inner: Math.round(inner.width),
        innerLeft: Math.round(inner.left),
        headLeft: Math.round(head.left),
        headRight: Math.round(head.right),
        rowWidth: Math.round(row.width),
      };
    });

  const std = await rowMetrics();
  expect(std.inner, '默认标准模式正文列 = 920').toBe(920);
  expect(std.headRight, 'Agent 行不溢出正文列').toBeLessThanOrEqual(std.innerLeft + std.inner + 1);
  expect(std.rowWidth, 'Agent 行宽度不超出正文列').toBeLessThanOrEqual(std.inner + 1);

  await setContentWidth(page, '宽');
  await page.locator('.tree-session', { hasText: '会话CW' }).click();
  await expect(page.locator('.compose-box')).toBeVisible();
  await spawnAgentRow();
  const wide = await rowMetrics();
  expect(wide.inner, '宽模式正文列铺满').toBeGreaterThan(1000);
  expect(wide.rowWidth, 'Agent 行随正文列变宽').toBeGreaterThan(std.rowWidth);

  health.assertHealthy();
});


test('内容宽度：标准模式在窄窗格退化为满宽 @regression', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.setViewportSize({ width: 820, height: 800 });
  await page.addInitScript(() => localStorage.setItem('forge:content-width', 'standard'));
  await openConversation(page);

  const narrow = await widths(page);
  expect(narrow.inner, '窗口窄于标准列宽时退化为满宽').toBeLessThan(920);
  expect(narrow.inner, '不应被压成一条窄条').toBeGreaterThan(300);

  health.assertHealthy();
});
