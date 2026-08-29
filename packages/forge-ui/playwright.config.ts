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