/**
 * forge-ui Playwright E2E 配置。
 *
 * 目标：浏览器级验收（docs/test/{02_session,03_conversation,04_tool}/e2e.md 的
 * mock-backend 用例）。UI 在 Electron 内通过 preload 桥走真实 IPC；纯浏览器场景
 * 由 mock-bridge.ts 在 FORGE_DEV_SERVER_ORIGIN 匹配时注入可编程 mock，经
 * window.__forgeMock 驱动流式/工具/删除等事件序列。
 *
 * - webServer：vite dev（端口固定 51731，与 scripts/dev.js 一致），
 *   FORGE_DEV_SERVER_ORIGIN 指向该端口以启用 mock-bridge
 * - 目录：packages/forge-ui/e2e/{smoke,interaction,regression,helpers}
 * - 失败证据：trace + screenshot（on failure 自动）
 */
import { defineConfig, devices } from '@playwright/test';

const DEV_PORT = 51731;
const DEV_URL = `http://localhost:${DEV_PORT}`;

export default defineConfig({
  testDir: './e2e',
  testMatch: ['**/*.spec.ts'],
  /**
   * 不参与正式跑的用例。
   *
   * 1) 一次性排查/截图脚本：历次问题的临时取证工具（文件头自己写着「一次性」
   *    「跑完即删」），依赖当次环境的几何与截图产物，全量跑时必然红
   *    （`__tmp-r` 甚至只是把一张 png 当页面打开量像素）。
   * 2) `pluginMarket.spec.ts`：插件市场功能**暂不开放**（v6.40 已从设置页摘除
   *    入口），断言「设置页有插件 Tab」的用例必然失败。功能代码与这份用例都留着，
   *    重新开放时把它从这里移回即可。
   *
   * 放进 ignored 后「全量绿」才有意义——否则每个维护者都得记住哪几个红是"正常的"。
   */
  testIgnore: [
    '**/__repro-*.spec.ts',
    '**/__tmp-*.spec.ts',
    '**/tmp-filmstrip.spec.ts',
    '**/pluginMarket.spec.ts',
  ],
  fullyParallel: false,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 8_000 },
  retries: 0,
  reporter: [
    ['list'],
    ['html', { outputFolder: 'e2e-report', open: 'never' }],
  ],
  use: {
    baseURL: DEV_URL,
    // 模块 08 i18n：偏好默认 system 按 navigator.language 判定；Playwright 默认 en-US
    // 会把整页渲染成英文，打爆全部中文文本选择器。钉死 zh-CN 保持既有用例语义
    // （语言切换本身由 SettingsPanel 语言行用例覆盖）。
    locale: 'zh-CN',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
    video: 'on-first-retry',
  },
  webServer: {
    command: 'npx vite --port 51731 --strictPort',
    url: DEV_URL,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
    env: {
      FORGE_VITE_PORT: String(DEV_PORT),
      FORGE_DEV_SERVER_ORIGIN: DEV_URL,
    },
  },
  projects: [
    {
      name: 'msedge',
      use: { ...devices['Desktop Edge'], channel: 'msedge' },
    },
  ],
});