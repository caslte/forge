/**
 * 一次性排查脚本：用户反馈「AI 输出完了之后对话框底部会跳一下」。
 *
 * 三路采样，用来区分「真被画出来的位移」与「帧内中间态」：
 * - painted：rAF → setTimeout(0)，近似绘制后状态（会看到同帧内尚未修正的中间态）
 * - layout ：ResizeObserver 回调（应用自身 RO 更早注册，故此处已是"应用钉底之后"），
 *            运行在当帧布局之后、绘制之前 → 这里的值就是该帧画出来的样子
 * 关注：消息区 gapBottom（底部内边距内的正常值≈18，明显为负=底部内容被裁到视口外）、
 * 输入区 inputTop/inputH/composeH（用户说的「对话框底部」）、queue 徽标、横幅数量。
 *
 * 用法：npx playwright test e2e/__repro-stream-end-jump.spec.ts
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, seedSessions, seedHistory } from './helpers/index';

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

type Sample = {
  t: number;
  st: number;
  sh: number;
  ch: number;
  cw: number;
  think: number;
  footer: number;
  lastBottom: number | null;
  gapBottom: number;
  lastTop: number | null;
  lastH: number | null;
  thinkH: number;
  footerH: number;
  inputTop: number | null;
  inputH: number | null;
  composeH: number | null;
  queue: number;
  banner: number;
};

/** 绘制后采样：rAF → setTimeout(0) */
async function startProbePainted(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __probe: Sample[]; __stop: boolean };
    w.__probe = [];
    w.__stop = false;
    const el = document.querySelector('.conv-messages') as HTMLElement;
    const snap = (): Sample => {
      const inner = document.querySelector('.conv-messages-inner');
      const cards = inner ? Array.from(inner.children) : [];
      const last = cards.length > 0 ? (cards[cards.length - 1] as HTMLElement) : null;
      const elBox = el.getBoundingClientRect();
      const lastBox = last ? last.getBoundingClientRect() : null;
      const wrap = document.querySelector('.conv-input-wrap');
      const compose = document.querySelector('.compose-box');
      return {
        t: Math.round(performance.now()),
        st: Math.round(el.scrollTop),
        sh: Math.round(el.scrollHeight),
        ch: Math.round(el.clientHeight),
        cw: Math.round(el.clientWidth),
        think: document.querySelectorAll('.conv-thinking').length,
        footer: document.querySelectorAll('.msg-footer').length,
        lastBottom: lastBox ? Math.round(lastBox.bottom) : null,
        gapBottom: Math.round(elBox.bottom - (lastBox ? lastBox.bottom : elBox.bottom)),
        lastTop: lastBox ? Math.round(lastBox.top) : null,
        lastH: lastBox ? Math.round(lastBox.height) : null,
        thinkH: (() => {
          const th = document.querySelector('.conv-thinking') as HTMLElement | null;
          return th ? Math.round(th.getBoundingClientRect().height) : 0;
        })(),
        footerH: (() => {
          const fs = document.querySelectorAll('.msg-footer');
          const f = fs.length > 0 ? (fs[fs.length - 1] as HTMLElement) : null;
          return f ? Math.round(f.getBoundingClientRect().height) : 0;
        })(),
        inputTop: wrap ? Math.round(wrap.getBoundingClientRect().top) : null,
        inputH: wrap ? Math.round(wrap.getBoundingClientRect().height) : null,
        composeH: compose ? Math.round(compose.getBoundingClientRect().height) : null,
        queue: document.querySelectorAll('.queue-wrap').length,
        banner: document.querySelectorAll('.conv-switch-banner').length,
      };
    };
    const sample = (): void => {
      if (w.__stop) return;
      w.__probe.push(snap());
      requestAnimationFrame(() => setTimeout(sample, 0));
    };
    requestAnimationFrame(() => setTimeout(sample, 0));
  });
}

async function stopProbePainted(page: Page): Promise<Sample[]> {
  await page.evaluate(() => {
    (window as unknown as { __stop: boolean }).__stop = true;
  });
  return page.evaluate(() => (window as unknown as { __probe: Sample[] }).__probe);
}

/** 布局后采样：ResizeObserver 回调（= 该帧绘制前、应用钉底之后的状态） */
async function startProbeLayout(page: Page): Promise<void> {
  await page.evaluate(() => {
    const w = window as unknown as { __ro: Sample[]; __roStop: boolean };
    w.__ro = [];
    w.__roStop = false;
    const el = document.querySelector('.conv-messages') as HTMLElement;
    const inner = document.querySelector('.conv-messages-inner') as HTMLElement;
    const obs = new ResizeObserver(() => {
      if (w.__roStop) return;
      const cards = Array.from(inner.children);
      const last = cards.length > 0 ? (cards[cards.length - 1] as HTMLElement) : null;
      const elBox = el.getBoundingClientRect();
      const lastBox = last ? last.getBoundingClientRect() : null;
      const wrap = document.querySelector('.conv-input-wrap');
      const compose = document.querySelector('.compose-box');
      w.__ro.push({
        t: Math.round(performance.now()),
        st: Math.round(el.scrollTop),
        sh: Math.round(el.scrollHeight),
        ch: Math.round(el.clientHeight),
        cw: Math.round(el.clientWidth),
        think: document.querySelectorAll('.conv-thinking').length,
        footer: document.querySelectorAll('.msg-footer').length,
        lastBottom: lastBox ? Math.round(lastBox.bottom) : null,
        gapBottom: Math.round(elBox.bottom - (lastBox ? lastBox.bottom : elBox.bottom)),
        lastTop: lastBox ? Math.round(lastBox.top) : null,
        lastH: lastBox ? Math.round(lastBox.height) : null,
        thinkH: (() => {
          const th = document.querySelector('.conv-thinking') as HTMLElement | null;
          return th ? Math.round(th.getBoundingClientRect().height) : 0;
        })(),
        footerH: (() => {
          const fs = document.querySelectorAll('.msg-footer');
          const f = fs.length > 0 ? (fs[fs.length - 1] as HTMLElement) : null;
          return f ? Math.round(f.getBoundingClientRect().height) : 0;
        })(),
        inputTop: wrap ? Math.round(wrap.getBoundingClientRect().top) : null,
        inputH: wrap ? Math.round(wrap.getBoundingClientRect().height) : null,
        composeH: compose ? Math.round(compose.getBoundingClientRect().height) : null,
        queue: document.querySelectorAll('.queue-wrap').length,
        banner: document.querySelectorAll('.conv-switch-banner').length,
      });
    });
    obs.observe(inner);
  });
}

async function stopProbeLayout(page: Page): Promise<Sample[]> {
  await page.evaluate(() => {
    (window as unknown as { __roStop: boolean }).__roStop = true;
  });
  return page.evaluate(() => (window as unknown as { __ro: Sample[] }).__ro);
}

/** 打印逐帧变化：消息区 + 输入区 + 队列/横幅 */
function report(samples: Sample[], title: string): void {
  console.log(`\n===== ${title}：共 ${samples.length} 个采样 =====`);
  let maxMsg = 0;
  let maxInput = 0;
  let maxInputH = 0;
  for (let i = 1; i < samples.length; i += 1) {
    const p = samples[i - 1];
    const s = samples[i];
    const dSt = s.st - p.st;
    const dSh = s.sh - p.sh;
    const dCw = s.cw - p.cw;
    const dLast = s.lastBottom !== null && p.lastBottom !== null ? s.lastBottom - p.lastBottom : 0;
    const dInTop = s.inputTop !== null && p.inputTop !== null ? s.inputTop - p.inputTop : 0;
    const dInH = s.inputH !== null && p.inputH !== null ? s.inputH - p.inputH : 0;
    const dCompose = s.composeH !== null && p.composeH !== null ? s.composeH - p.composeH : 0;
    const dLastTop = s.lastTop !== null && p.lastTop !== null ? s.lastTop - p.lastTop : 0;
    if (Math.abs(dLast) > maxMsg) maxMsg = Math.abs(dLast);
    if (Math.abs(dInTop) > maxInput) maxInput = Math.abs(dInTop);
    if (Math.abs(dInH) > maxInputH) maxInputH = Math.abs(dInH);
    const interesting =
      dSt !== 0 || dSh !== 0 || dCw !== 0 || Math.abs(dLast) > 1 || Math.abs(dLastTop) > 1 ||
      Math.abs(dInTop) > 1 || Math.abs(dInH) > 1 || Math.abs(dCompose) > 1 || s.queue !== p.queue ||
      s.banner !== p.banner || s.thinkH !== p.thinkH || s.footerH !== p.footerH;
    if (interesting) {
      console.log(
        `t=${s.t} 消息区[dScrollH=${dSh} dScrollTop=${dSt} dWidth=${dCw} dLastBottom=${dLast} dLastTop=${dLastTop} ` +
          `lastH=${s.lastH} gap=${s.gapBottom} think=${s.think}(${s.thinkH}px) footer=${s.footer}(${s.footerH}px)] ` +
          `输入区[dTop=${dInTop} dH=${dInH} dCompose=${dCompose} queue=${s.queue} banner=${s.banner}]`,
      );
    }
  }
  console.log(
    `>>> 最大单帧位移：消息区底边 ${maxMsg}px / 输入区 top ${maxInput}px / 输入区高度 ${maxInputH}px`,
  );
}

async function boot(
  page: Page,
  session: Record<string, unknown>,
  history?: Array<Record<string, unknown>>,
): Promise<void> {
  await page.goto('/');
  await seedSessions(page, [session]);
  await page.reload();
  await expect(page.locator('.tree-panel')).toBeVisible();
  if (history) await seedHistory(page, session.sessionId as string, history);
  await page.locator('.tree-session').first().click();
}

/** 长会话历史（内容始终溢出容器） */
function longHistory(): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (let i = 1; i <= 10; i += 1) {
    const t = Date.now() - 200000 + i * 1000;
    out.push({ role: 'user', content: `第${i}轮提问：收尾帧排查`, ts: new Date(t).toISOString() });
    out.push({
      role: 'assistant',
      content: `第${i}轮回复。\n${'这是用于撑高消息流的回复正文。'.repeat(8)}`,
      ts: new Date(t + 200).toISOString(),
    });
  }
  return out;
}

/** 一次完整轮次：流式增量 → 权威终态 → done 收尾帧 */
async function runTurn(page: Page, sid: string, finalLines = 30): Promise<void> {
  await page.evaluate(([key]) => {
    window.__forgeMock!.emit(key, 'conversation.statusChanged', { status: 'streaming' });
  }, [sid] as const);
  for (let i = 1; i <= 4; i += 1) {
    await page.evaluate(
      ([key, n]) => {
        window.__forgeMock!.emit(key, 'conversation.delta', {
          delta: { text: `增量段落${n}。\n`, kind: 'text' },
        });
      },
      [sid, i] as const,
    );
    await page.waitForTimeout(80);
  }
  await page.evaluate(
    ([key, lines]) => {
      const body = `最终回复：\n\n\`\`\`ts\n${'const line = "终态渲染高度变化观察";\n'.repeat(lines as number)}\`\`\`\n`;
      window.__forgeMock!.emit(key, 'conversation.message', {
        message: { role: 'assistant', content: body, ts: new Date().toISOString() },
      });
    },
    [sid, finalLines] as const,
  );
  await page.waitForTimeout(150);
  await page.evaluate(
    ([key]) => {
      window.__forgeMock!.emit(key, 'conversation.statusChanged', { status: 'done' });
    },
    [sid] as const,
  );
  await page.waitForTimeout(1500);
}

test('repro L: 布局后采样（权威判定：该帧画出来的样子）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const health = attachHealthGuards(page);
  const s = mkSession({ alias: '收尾帧时序排查' });
  await boot(page, s, longHistory());
  await expect(page.locator('.msg-assistant', { hasText: '第10轮回复' })).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(400);
  await startProbeLayout(page);
  await runTurn(page, s.sessionId as string);
  report(await stopProbeLayout(page), 'L 布局后采样（RO 回调）');
  health.assertHealthy();
});

test('repro P: 绘制后采样（含输入区）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const health = attachHealthGuards(page);
  const s = mkSession({ alias: '收尾帧排查长会话' });
  await boot(page, s, longHistory());
  await expect(page.locator('.msg-assistant', { hasText: '第10轮回复' })).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(400);
  await startProbePainted(page);
  await runTurn(page, s.sessionId as string);
  report(await stopProbePainted(page), 'P 绘制后采样');
  await page.screenshot({ path: 'e2e-report/__repro-P-painted.png' });
  health.assertHealthy();
});

test('repro Q: 流式中排队一条（收尾帧队列派发）', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  const health = attachHealthGuards(page);
  const s = mkSession({ alias: '收尾帧排查排队' });
  await boot(page, s, longHistory());
  await expect(page.locator('.msg-assistant', { hasText: '第10轮回复' })).toBeVisible({ timeout: 8_000 });
  await page.waitForTimeout(400);
  await startProbeLayout(page);
  // 进入流式后排一条消息（走真实输入框）。mock 的 sendMessage 挂起等脚本，故用脚本让整轮走完
  await page.evaluate(([key]) => {
    window.__forgeMock!.emit(key, 'conversation.statusChanged', { status: 'streaming' });
  }, [s.sessionId as string] as const);
  await page.locator('.compose-input').fill('排队中的下一条');
  await page.locator('.compose-input').press('Enter');
  await page.waitForTimeout(600);
  await page.evaluate(
    ([key]) => {
      window.__forgeMock!.emit(key, 'conversation.message', {
        message: { role: 'assistant', content: '本轮回复完成。', ts: new Date().toISOString() },
      });
    },
    [s.sessionId as string] as const,
  );
  await page.waitForTimeout(150);
  await page.evaluate(
    ([key]) => {
      window.__forgeMock!.emit(key, 'conversation.statusChanged', { status: 'done' });
    },
    [s.sessionId as string] as const,
  );
  await page.waitForTimeout(1500);
  report(await stopProbeLayout(page), 'Q 布局后采样（含排队派发）');
  health.assertHealthy();
});
