/**
 * 画布卡片 E2E（契约 docs/plan/canvas-card.md，mock-backend）。
 *
 * 单测只能证明「围栏变成占位、判据不误伤」，证明不了 iframe 真的渲染出卡片、
 * 蒙版真的在闭合瞬间换成图、Teleport 真的逃出气泡。这些只有浏览器级能验。
 *
 * 覆盖：历史回显与正文夹排位置、沙箱全关且跨源不可读、流式骨架→卡片零跳变、
 * 非 HTML 降级、```html 不被劫持、工具栏与放大浮层。
 */
import { test, expect } from '@playwright/test';
import { attachHealthGuards, seedHistory, seedSendScript, seedSessions, waitForMock } from './helpers/index';

const PROJECT = 'D:/work/aiwork/forge';

const CARD_HTML = '<div class="k">登录接口防爆破机制 · 报告模型 vs 代码实际链路</div>';

function mkSession(sid: string, alias: string): Record<string, unknown> {
  return {
    sessionId: sid,
    projectPath: PROJECT,
    alias,
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

async function openSession(page: import('@playwright/test').Page, alias: string): Promise<void> {
  await page.locator('.tree-session', { hasText: alias }).first().click();
}

async function seedAndOpen(
  page: import('@playwright/test').Page,
  sid: string,
  alias: string,
  assistantContent: string,
): Promise<void> {
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession(sid, alias)]);
  await seedHistory(page, sid, [
    { id: 'm1', role: 'user', content: '梳理一下这套机制', ts: '2026-09-24T01:00:00.000Z' },
    { id: 'm2', role: 'assistant', content: assistantContent, ts: '2026-09-24T01:00:05.000Z' },
  ]);
  await page.reload();
  await waitForMock(page);
  await openSession(page, alias);
}

test('E-CA-001 @P0 @mock-backend：历史回显——卡片渲染成沙箱 iframe，且留在两段正文之间', async ({ page }) => {
  const health = attachHealthGuards(page);
  await seedAndOpen(
    page,
    'sess-canvas-1',
    '画布回显',
    `核实完成。这张图对比了两种链路：\n\n\`\`\`canvas\n${CARD_HTML}\n\`\`\`\n\n要不要继续看网关配置？`,
  );

  const block = page.locator('.md-canvas-block');
  await expect(block).toHaveCount(1);
  const frame = page.locator('.md-canvas-block .canvas-frame');
  await expect(frame).toBeVisible();

  // 沙箱全关：sandbox 属性必须是空串（给了任何 allow-* 都是回归）
  const iframe = block.locator('iframe');
  await expect(iframe).toHaveCount(1);
  expect(await iframe.getAttribute('sandbox')).toBe('');

  // srcdoc 里既有卡片源码，也有预注入的语义色变量
  const srcdoc = (await iframe.getAttribute('srcdoc')) ?? '';
  expect(srcdoc).toContain('登录接口防爆破机制');
  expect(srcdoc).toContain('--c-bg:');
  expect(srcdoc).toContain('--c-ok-bg:');

  // 夹排位置：卡片必须在两段正文之间，而不是像 mermaid 那样被堆到气泡底部
  const order = await page.locator('.msg-assistant .msg-bubble').first().evaluate((el) =>
    [...el.children].map((c) => (c.classList.contains('md-canvas-block') ? 'card' : 'text')),
  );
  expect(order).toEqual(['text', 'card', 'text']);

  health.assertHealthy();
});

test('E-CA-002 @P0 @mock-backend：跨源隔离——宿主读不到沙箱文档，脚本无从逃逸', async ({ page }) => {
  await seedAndOpen(page, 'sess-canvas-2', '画布隔离', `\`\`\`canvas\n${CARD_HTML}\n\`\`\``);
  const readable = await page.evaluate(() => {
    const f = document.querySelector('.md-canvas-block iframe');
    if (!f) return 'no-iframe';
    // sandbox="" 的 srcdoc 是独立 origin：contentDocument 恒为 null
    return f.contentDocument === null ? 'isolated' : 'READABLE';
  });
  expect(readable).toBe('isolated');
});

test('E-CA-003 @P0 @mock-backend：流式中途是骨架蒙版不是源码，闭合瞬间换卡片且零跳变', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-canvas-3', '画布流式')]);
  // 会话树是启动时读的：seed 完必须重载，否则列表里没有这条会话
  await page.reload();
  await waitForMock(page);
  await openSession(page, '画布流式');

  // 故意只写到一半（围栏未闭合）——必须是**真流式**：历史里的未闭合围栏按设计直接
  // 出半成品（见 MessageCard「骨架会永远转圈」注释），blocked 只在流式期间成立。
  // 本用例改前用 seedHistory 喂半截内容，blocked 恒为 false，从来没测到骨架（一直红）。
  await seedSendScript(page, 'sess-canvas-3', [
    {
      type: 'delta',
      delayMs: 20,
      payload: { text: '梳理中：\n\n```canvas\n<div class="k">登录接口防爆破机制', kind: 'text' },
    },
  ]);
  await page.locator('.compose-input').fill('画一张链路图');
  await page.locator('.compose-input').press('Enter');

  const block = page.locator('.md-canvas-block');
  const skel = block.locator('.canvas-skel');
  await expect(skel).toBeVisible();
  // 蒙版期间：不给 iframe，也不把半截源码显示给用户
  await expect(block.locator('iframe')).toHaveCount(0);
  await expect(block.locator('canvas')).toHaveCount(0);
  await expect(page.locator('.msg-assistant').last()).not.toContainText('class="k"');
  await expect(skel).toContainText('正在绘制图示');

  const heightBefore = await skel.evaluate((el) => el.getBoundingClientRect().height);

  // 闭合围栏：换成真卡片
  await page.evaluate(() => {
    window.__forgeMock!.emit('sess-canvas-3', 'conversation.delta', {
      delta: { text: '</div>\n```', kind: 'text' },
    });
  });
  await expect(block.locator('iframe')).toHaveCount(1, { timeout: 5_000 });
  await expect(skel).toHaveCount(0);

  const heightAfter = await block.locator('.canvas-frame').evaluate((el) => el.getBoundingClientRect().height);
  expect(Math.abs(heightAfter - heightBefore), '骨架与终态同高，闭合不得顶动下方正文').toBeLessThanOrEqual(1);

  health.assertHealthy();
});

test('E-CA-004 @P1 @mock-backend：围栏里不是 HTML → 降级代码块，不塞 iframe，可放大', async ({ page }) => {
  await seedAndOpen(
    page,
    'sess-canvas-4',
    '画布降级',
    '```canvas\nconst total = list.reduce((a, b) => a + b, 0);\nif (total > 30) throw new Error("x");\n```',
  );
  const block = page.locator('.md-canvas-block');
  await expect(block.locator('.canvas-fallback')).toBeVisible();
  await expect(block.locator('.canvas-source')).toContainText('reduce');
  await expect(block.locator('iframe')).toHaveCount(0);
  await expect(block).not.toContainText('内容不是 HTML 图示');

  // 降级态右上角工具栏：放大浮层 + 内联拉高，均与 HTML 态同款
  const tools = block.locator('.canvas-fallback .canvas-tools');
  await expect(tools).toHaveCount(1);
  await expect(tools.locator('.canvas-tool')).toHaveCount(2);

  // 第二个按钮：不弹窗，直接在气泡里拉高看全文
  const source = block.locator('.canvas-source');
  await expect(source).toHaveCSS('max-height', '260px');
  await tools.locator('.canvas-tool').nth(1).click({ force: true });
  await expect(source).toHaveCSS('max-height', '560px');
  await tools.locator('.canvas-tool').nth(1).click({ force: true });
  await expect(source).toHaveCSS('max-height', '260px');

  // 第一个按钮：放大浮层显示源码
  await tools.locator('.canvas-tool').first().click({ force: true });
  const lightbox = page.locator('body > .canvas-lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('.canvas-lightbox-source')).toContainText('reduce');
  await expect(lightbox.locator('iframe')).toHaveCount(0);
  await lightbox.locator('.canvas-lightbox-close').click();
  await expect(lightbox).toHaveCount(0);

  // ESC 也能关闭
  await tools.locator('.canvas-tool').first().click({ force: true });
  await expect(lightbox).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
});

/**
 * 截图回归（2026-09-29）：模型把纯文字说明（源码里一个标签都没有）塞进 canvas
 * 围栏。改前判 looksLikeHtmlCanvas=false → 落 canvas-fallback 代码框（黑底方块），
 * 正是用户截图里那两块。改后判 prose → 按正文流渲染，与普通段落无异。
 */
const PLAIN_NO_LICENSE = `没有 LICENSE 时，GitHub 自动套用「保留所有权利」
· 别人能读你的代码、能 fork —— 纯「阅读」不违法
· 但复制一段代码用在自己项目里、拿去商用、改了再发布 —— 法律上不允许
即使他们想做善意的贡献也只能提 PR，因为没有授权基础

实际会发生什么
· 有人想在自己的项目里 import 你的 @forge/core — 被法律挡住，只能 fork 后当私用代码用
· 企业法务看到「无许可证」直接跳过 → 少掉一大半潜在使用者
· GitHub 页面右侧会挂一个灰色的 "Unlicensed" 警告标签，看着就不专业`;

test('E-CA-008 @P0 @mock-backend：无标签纯文字按正文流渲染，不落代码框（截图回归）', async ({ page }) => {
  await seedAndOpen(
    page,
    'sess-canvas-8',
    '画布纯文字',
    `先说结论。\n\n\`\`\`canvas\n${PLAIN_NO_LICENSE}\n\`\`\`\n\n需要我把 LICENSE 模板也写出来吗？`,
  );

  const block = page.locator('.md-canvas-block');
  // 降级成正文流：出 canvas-prose，且绝不出代码框 / iframe / 骨架
  await expect(block.locator('.canvas-prose')).toBeVisible();
  await expect(block.locator('.canvas-fallback')).toHaveCount(0);
  await expect(block.locator('iframe')).toHaveCount(0);
  await expect(block.locator('.canvas-skel')).toHaveCount(0);

  // 伪列表符 `·` 必须还原成真 <ul>，否则降级出来是一段糊在一起的散文。
  // 原文有两组 `·` 列表（结论段 + 「实际会发生什么」段），故出两个 <ul>。
  await expect(block.locator('.canvas-prose ul')).toHaveCount(2);
  await expect(block.locator('.canvas-prose li').first()).toContainText('别人能读你的代码');

  // 内容不丢：正文里仍在（截图那段的中文原文）
  await expect(block).toContainText('GitHub 自动套用「保留所有权利」');
  // 不出代码块容器
  await expect(block.locator('pre')).toHaveCount(0);

  // 夹排位置不变：卡片槽位仍在两段正文之间
  const order = await page.locator('.msg-assistant .msg-bubble').first().evaluate((el) =>
    [...el.children].map((c) => (c.classList.contains('md-canvas-block') ? 'card' : 'text')),
  );
  expect(order).toEqual(['text', 'card', 'text']);
});

test('E-CA-009 @P0 @mock-backend：流式中纯文字不挂骨架（假进度），闭栏后也不翻面', async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-canvas-9', '画布流式判据')]);
  // 会话树是启动时读的：seed 完必须重载，否则列表里没有这条会话
  await page.reload();
  await waitForMock(page);
  await openSession(page, '画布流式判据');

  // 半截纯文字（围栏未闭合）：判据已定 prose，不该挂 320px 假进度
  await seedSendScript(page, 'sess-canvas-9', [
    { type: 'delta', delayMs: 20, payload: { text: '```canvas\n' + PLAIN_NO_LICENSE, kind: 'text' } },
  ]);
  await page.locator('.compose-input').fill('许可证怎么选');
  await page.locator('.compose-input').press('Enter');

  const block = page.locator('.md-canvas-block');
  await expect(block.locator('.canvas-prose')).toBeVisible();
  await expect(block.locator('.canvas-skel')).toHaveCount(0);

  // 闭栏后仍是正文流（不翻面成代码框/卡片）
  await page.evaluate(() => {
    window.__forgeMock!.emit('sess-canvas-9', 'conversation.delta', {
      delta: { text: '\n```', kind: 'text' },
    });
  });
  await expect(block.locator('.canvas-fallback')).toHaveCount(0);
  await expect(block.locator('iframe')).toHaveCount(0);
  await expect(block.locator('.canvas-prose')).toBeVisible();
});

test('E-CA-005 @P1 @mock-backend：```html 围栏不被劫持（模型展示 HTML 代码示例是常态）', async ({ page }) => {
  await seedAndOpen(page, 'sess-canvas-5', 'html围栏', '```html\n<div class="btn">按钮</div>\n```');
  await expect(page.locator('.md-canvas-block')).toHaveCount(0);
  await expect(page.locator('.md-code-block')).toHaveCount(1);
});

test('E-CA-006 @P1 @mock-backend：工具栏 hover 出现，放大浮层经 Teleport 落在 body 下', async ({ page }) => {
  const health = attachHealthGuards(page);
  await seedAndOpen(page, 'sess-canvas-6', '画布工具栏', `\`\`\`canvas\n${CARD_HTML}\n\`\`\``);

  const tools = page.locator('.md-canvas-block .canvas-tools');
  await expect(tools).toHaveCount(1);
  await expect(tools).toHaveCSS('opacity', '0');
  // 用显式 mouse.move 而不是 locator.hover()：卡片正中落在 iframe 上，
  // hover() 的滚动+命中判定在跨源 iframe 上不稳定；mouse.move 与真实指针一致
  const frameBox = (await page.locator('.md-canvas-block .canvas-frame').boundingBox())!;
  await page.mouse.move(frameBox.x + frameBox.width / 2, frameBox.y + frameBox.height / 2);
  await expect(tools).toHaveCSS('opacity', '1', { timeout: 3_000 });
  await expect(tools.locator('.canvas-tool')).toHaveCount(4);

  // 拉高档位
  const frame = page.locator('.md-canvas-block .canvas-frame');
  const h1 = await frame.evaluate((el) => el.getBoundingClientRect().height);
  await tools.locator('.canvas-tool').nth(1).click();
  await expect.poll(async () => frame.evaluate((el) => el.getBoundingClientRect().height)).toBeGreaterThan(h1);

  // 放大：气泡 rise 动画带 transform，会把 fixed 劫持成气泡内 —— 所以必须能在 body 直接子级找到
  await tools.locator('.canvas-tool').nth(0).click();
  await expect(page.locator('body > .canvas-lightbox')).toBeVisible();
  await expect(page.locator('.canvas-lightbox iframe')).toHaveCount(1);
  expect(await page.locator('.canvas-lightbox iframe').getAttribute('sandbox')).toBe('');
  await page.locator('.canvas-lightbox-close').click();
  await expect(page.locator('.canvas-lightbox')).toHaveCount(0);

  health.assertHealthy();
});

test('E-CA-007 @P1 @mock-backend：内容超高时卡片内部滚动，不撑破气泡也不改卡片高度', async ({ page }) => {
  // 本例不挂 health guard：Playwright 进跨源沙箱帧量滚动时会往该帧注入工具脚本，
  // 沙箱按口径拒执行并在控制台留 "Blocked script execution in 'about:srcdoc'"。
  // 这条报错是测试脚手架造成的，且恰好是 E-CA-002 想证明的事，不该算产品缺陷。
  // 30 行足够超出 320px 默认档
  const tall = Array.from({ length: 30 }, (_, i) => `<div style="padding:12px 0">第 ${i + 1} 步</div>`).join('\n');
  await seedAndOpen(page, 'sess-canvas-7', '画布滚动', `\`\`\`canvas\n${tall}\n\`\`\``);

  const frame = page.locator('.md-canvas-block .canvas-frame');
  const inner = page.frameLocator('.md-canvas-block .canvas-frame iframe');
  const metrics = async () =>
    inner.locator('body').evaluate((b) => {
      const doc = b.ownerDocument.documentElement;
      return { scrollH: Math.max(b.scrollHeight, doc.scrollHeight), clientH: doc.clientHeight, top: doc.scrollTop };
    });

  const before = await metrics();
  expect(before.scrollH).toBeGreaterThan(before.clientH); // 确实溢出，才有滚动可验

  const h1 = await frame.evaluate((el) => el.getBoundingClientRect().height);
  // 必须显式移动鼠标：.hover() 的滚动+命中测试在跨源 iframe 上不可靠（见 E-CA-006 注释）
  const box = (await frame.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, 240);
  await expect.poll(async () => (await metrics()).top).toBeGreaterThan(0);
  const after = await metrics();
  expect(after.clientH).toBe(before.clientH); // 滚的是卡片内部，视口没被撑大
  expect(await frame.evaluate((el) => el.getBoundingClientRect().height)).toBe(h1);
});

/**
 * 截图回归（2026-09-30 真机）：画布卡片流式期间一直闪，闪的时候能看见源码。
 *
 * 成因：终态判据被直接跑在半截源码上——`<div style=` 因属性里的 `=` 命中
 * looksLikeCodeCanvas（骨架提前塌成代码块，用户看见满屏源码），长内联样式因半截
 * 属性值算进「最长文本片段」命中 PROSE_LONG_RUN（骨架塌成正文），标签一闭合又变回
 * 骨架。150ms 一次的节流重渲染下就是「骨架 ↔ 代码/正文」来回翻面。
 *
 * 这条按帧采样整段流式过程：卡片只能待在骨架，收尾才换 iframe。
 */
const STREAM_CHUNKS = [
  '先说结论：这是一个多仓库并列的平台根目录。\n\n```canvas\n<div style=',
  'display:flex;flex-direction:column;gap:14px;padding:16px;border:1px solid var(--c-border)',
  '">\n  <div style="font-weight:600;font-size:14px;color:var(--c-fg)">edu 平台根目录（多仓库并列）</div>\n',
  '  <div style="border:1px solid var(--c-border);border-radius:8px;padding:10px 14px;background:var(--c-surface)">edu-admin 后台管理</div>\n',
  '</div>\n```',
];

test('E-CA-010 @P0 @mock-backend：流式期间一律骨架——半截标签/长内联样式不翻面（2026-09-30 截图回归）', async ({ page }) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await waitForMock(page);
  await seedSessions(page, [mkSession('sess-canvas-10', '画布流式不闪')]);
  await page.reload();
  await waitForMock(page);
  await openSession(page, '画布流式不闪');

  // 逐帧采样卡片当前落在哪个分支：任何一帧出现 prose/code/empty 都是回归
  await page.evaluate(() => {
    const w = window as unknown as { __canvasTrace: string[]; __canvasRaf: number };
    w.__canvasTrace = [];
    const sample = (): void => {
      const block = document.querySelector('.md-canvas-block');
      if (block) {
        const state = block.querySelector('.canvas-skel')
          ? 'skeleton'
          : block.querySelector('.canvas-prose')
            ? 'PROSE'
            : block.querySelector('.canvas-fallback')
              ? 'CODE'
              : block.querySelector('.canvas-empty')
                ? 'EMPTY'
                : block.querySelector('iframe')
                  ? 'iframe'
                  : 'none';
        const trace = w.__canvasTrace;
        if (trace[trace.length - 1] !== state) trace.push(state);
      }
      w.__canvasRaf = requestAnimationFrame(sample);
    };
    sample();
  });

  const emitDelta = async (text: string): Promise<void> => {
    await page.evaluate(
      ([key, chunk]) => {
        window.__forgeMock!.emit(key, 'conversation.delta', { delta: { text: chunk, kind: 'text' } });
      },
      ['sess-canvas-10', text] as const,
    );
  };

  await page.evaluate(() => {
    window.__forgeMock!.emit('sess-canvas-10', 'conversation.statusChanged', { status: 'streaming' });
  });
  await page.locator('.compose-input').fill('画一张 edu 目录结构图');
  await page.locator('.compose-input').press('Enter');

  const block = page.locator('.md-canvas-block');
  for (const [i, chunk] of STREAM_CHUNKS.entries()) {
    await emitDelta(chunk);
    // 每个分片留出 > 150ms 节流窗口，保证每个「半截状态」都被真正渲染过一帧
    await page.waitForTimeout(260);
    await expect(block.locator('.canvas-skel'), `第 ${i + 1} 片流式分片期间应当是骨架`).toBeVisible();
    await expect(block.locator('.canvas-fallback')).toHaveCount(0);
    await expect(block.locator('.canvas-prose')).toHaveCount(0);
  }

  // 闭合围栏：换成真卡片（终态判 html，与流式口径一致，闭合不翻面）
  await expect(block.locator('iframe')).toHaveCount(1, { timeout: 5_000 });
  await page.evaluate(() => {
    window.__forgeMock!.emit('sess-canvas-10', 'conversation.statusChanged', { status: 'done' });
  });

  const trace = await page.evaluate(() => {
    const w = window as unknown as { __canvasTrace: string[]; __canvasRaf: number };
    cancelAnimationFrame(w.__canvasRaf);
    return w.__canvasTrace;
  });
  expect(trace.filter((s) => s === 'PROSE' || s === 'CODE' || s === 'EMPTY'), `流式中途翻面：${trace.join(' → ')}`).toEqual([]);
  expect(trace).toContain('skeleton');
  expect(trace[trace.length - 1]).toBe('iframe');
  health.assertHealthy();
});
