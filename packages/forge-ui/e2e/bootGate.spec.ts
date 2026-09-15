/**
 * @ 启动门闩 E2E（v3.76 欢迎页启动链，docs/changelog.md v3.76）。
 *
 * 背景：主进程先建窗口（渲染欢迎页）再动态组装 forge-core（含 pi SDK）。
 * 门闩放行依赖推（boot.ready 事件）拉（forge:boot-state 查询）双通道，并配两条
 * 逃生通道——真机曾因旧 preload 缺 bootState 方法（渲染端拉取 TypeError）永久卡在
 * 欢迎页，教训：**门闩绝不能是死门**。
 *
 * 覆盖：
 * - BOOT-GATE-001：正常路径——mock（bootState 恒 ready）下欢迎页放行进入正式界面
 * - BOOT-GATE-002：逃生 1——bootState 调用抛错（模拟旧 preload 无该方法）→ catch 放行
 * - BOOT-GATE-003：逃生 2——bootState 恒 ready:false 且事件永不推送 → 10s 超时强制放行
 *
 * 覆写时机（防假绿的关键）：mock 在入口同步流 `window.forge = bridge` 注入，早于任何
 * setTimeout(0) 轮询——onMounted 的 getBootState 会先于轮询覆写执行（首轮实测假绿）。
 * 故 init script 用 Object.defineProperty 拦截 window.forge 的 **赋值瞬间** 替换为
 * 包裹对象，必然早于 mount/onMounted。
 *
 * 自动化等级：mock-backend（mock-bridge 恒 ready:true；002/003 用 init script 覆写）。
 */
import { test, expect, type Page } from '@playwright/test';
import { attachHealthGuards, waitForMock, seedSessions } from './helpers/index';

const SESSION_ID = 'e2e-boot-gate-session';

function mkSession(): Record<string, unknown> {
  return {
    sessionId: SESSION_ID,
    projectPath: 'D:/work/aiwork/forge',
    alias: '门闩会话',
    status: 'idle',
    lastActiveAt: new Date().toISOString(),
  };
}

/** 正式界面已挂载的判据：会话树可见（欢迎页期间整棵树不存在） */
async function expectMainUi(page: Page, timeout = 15_000): Promise<void> {
  await expect(page.locator('.tree-session').first()).toBeVisible({
    timeout,
  });
}

/**
 * 拦截 window.forge 赋值，把 bootState 替换为给定实现。
 * 必须在 init script 里用 defineProperty 的 set 钩子：mock 注入（入口同步流）发生的
 * 瞬间即完成替换，早于 mount → onMounted → getBootState，杜绝轮询竞态假绿。
 */
function interceptBootState(
  page: import('@playwright/test').Page,
  impl: string,
): void {
  void page.addInitScript(`(() => {
    let real;
    Object.defineProperty(window, 'forge', {
      configurable: true,
      set(v) {
        real = v;
        const wrapped = Object.create(v);
        wrapped.bootState = ${impl};
        Object.defineProperty(window, 'forge', {
          value: wrapped,
          configurable: true,
          writable: true,
        });
      },
      get() {
        return real;
      },
    });
  })()`);
}

test('BOOT-GATE-001 @P0 @mock-backend 正常路径：欢迎页放行进入正式界面', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);
  await expectMainUi(page);
  health.assertHealthy();
});

test('BOOT-GATE-002 @P0 @mock-backend 逃生 1：bootState 抛错（模拟旧 preload）仍能进入', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  interceptBootState(
    page,
    `() => { throw new Error('simulated legacy preload: no bootState'); }`,
  );
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);

  // 覆写必须真实生效（防 init script 未注入导致假绿）
  const overridden = await page.evaluate(() => {
    try {
      (window as unknown as { forge: { bootState: () => void } }).forge.bootState();
      return false;
    } catch {
      return true;
    }
  });
  expect(overridden).toBe(true);

  await expectMainUi(page); // catch 放行
  health.assertHealthy();
});

test('BOOT-GATE-003 @P0 @mock-backend 逃生 2：bootState 恒 false 且无推送 → 超时强制放行', async ({
  page,
}) => {
  const health = attachHealthGuards(page);
  interceptBootState(
    page,
    `() => Promise.resolve({ ready: false, startedAt: 0, durationMs: null })`,
  );
  await page.goto('/');
  await seedSessions(page, [mkSession()]);
  await page.reload();
  await waitForMock(page);

  // 反向断言（防假绿）：覆写生效时 5s 后门闩必须还挡着（正式 UI 未挂载）
  await page.waitForTimeout(5_000);
  const stillGated = await page.evaluate(
    () => document.querySelector('.tree-session') === null,
  );
  expect(stillGated).toBe(true);

  // 10s 超时逃生（BOOT_GATE_TIMEOUT_MS）→ 必见正式界面。
  // 窗口放宽到 30s：vite 冷编译可能把 mount/onMounted（计时器起点）推迟数秒
  await expectMainUi(page, 30_000);
  health.assertHealthy();
});
