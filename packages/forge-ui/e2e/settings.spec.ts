/**
 * 设置页模型配置 E2E（回归：编辑 provider 时 API Key 回填可读明文）。
 *
 * 背景：MiniMax 等 provider 的 apiKey 在 models.json 中是 `$ENV_VAR` 引用形式，
 * 服务层 queryProviderList 已将其解析为明文返回（keychain.readKey）。
 * 本用例验证 UI 端：编辑回填明文 key（非 $ 引用，无「已加密存储」标签），
 * 保存成功后显示「模型配置已保存」toast。
 */
import { test, expect } from '@playwright/test';
import { waitForMock } from './helpers/index';

const providerSeed = {
  providers: [
    {
      id: 'MiniMax-M3',
      name: 'MiniMax-M3',
      type: 'openai-completions',
      baseUrl: 'https://api.minimaxi.com/v1',
      models: ['MiniMax-M3'],
      lastError: null,
      // 服务层解析后的明文 key（模拟 queryProviderList 经 keychain.readKey 返回）
      apiKey: 'sk-minimax-plain-real-key',
    },
    {
      id: 'Grok 4.5',
      name: 'Grok 4.5',
      type: 'openai-completions',
      baseUrl: 'https://xuseny.online/v1',
      models: ['grok-4.5'],
      lastError: null,
      apiKey: 'sk-grok-plain-key',
    },
  ],
};

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await waitForMock(page);
  // 覆盖 queryProviderList：返回带明文 apiKey 的 provider 列表
  await page.evaluate((seed) => {
    window.__forgeMock!.seed('model/queryProviderList', () => {
      return { code: 0, message: 'ok', data: seed };
    });
  }, providerSeed);
});

test('设置页：编辑 provider 时 API Key 回填明文，保存成功有 toast', async ({ page }) => {
  // 进入设置面板（侧边栏「设置」）
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();

  // 模型列表渲染出两个 provider
  await expect(page.locator('.provider-item')).toHaveCount(2);

  // 点击 MiniMax-M3 的「编辑」
  const minimaxItem = page.locator('.provider-item').filter({ hasText: 'MiniMax-M3' });
  await minimaxItem.getByRole('button', { name: '编辑' }).click();

  // API Key 输入框回填明文（而非 $FORGE_... 引用 / 「已加密存储」特殊态）
  const keyInput = page.locator('.api-key-input');
  await expect(keyInput).toHaveValue('sk-minimax-plain-real-key');
  // 不出现安全存储标签与旧占位符文案
  await expect(page.locator('.key-stored-tag')).toHaveCount(0);

  // 保存修改：成功 toast「模型配置已保存」
  await page.locator('.form-actions .primary').click();
  await expect(page.locator('.toast .toast-message')).toContainText('模型配置已保存');
});

test('设置页：明文 provider 与引用 provider 编辑表现一致（无特殊标签）', async ({ page }) => {
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();

  // Grok 4.5（明文）编辑：回填明文，无特殊标签
  const grokItem = page.locator('.provider-item').filter({ hasText: 'Grok 4.5' });
  await grokItem.getByRole('button', { name: '编辑' }).click();
  await expect(page.locator('.api-key-input')).toHaveValue('sk-grok-plain-key');
  await expect(page.locator('.key-stored-tag')).toHaveCount(0);
});