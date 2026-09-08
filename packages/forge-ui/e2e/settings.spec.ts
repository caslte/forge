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

/** 本文件 E2E 内部使用的页面全局变量：内存 provider 存储 + 最近一次 saveProvider 参数 */
declare global {
  interface Window {
    __mockProviders?: Array<Record<string, unknown>>;
    __mockSaveParams?: Record<string, unknown> | null;
  }
}

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
  // 捕获 saveProvider 参数（供 MP-S06 的 contextWindow 断言用；新用例另行覆盖可变存储）
  await page.evaluate(() => {
    window.__forgeMock!.seed('model/saveProvider', (params) => {
      window.__mockSaveParams = params;
      return { code: 0, message: 'ok', data: null };
    });
  });
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

/**
 * MP-S06 上下文窗口 1M：
 * 内置可变 provider 存储（模拟 models.json 写后读回）+ 打开设置面板。
 * 覆盖 queryProviderList / saveProvider，使保存后列表反射 contextWindow 变更，
 * 支持保存后重新打开表单回显勾选态。
 */
async function initProviderContext(page: import('@playwright/test').Page, providers: unknown[]): Promise<void> {
  await page.evaluate((list) => {
    const providers = JSON.parse(JSON.stringify(list)) as Array<Record<string, unknown>>;
    window.__mockProviders = providers;
    window.__mockSaveParams = null;
    window.__forgeMock!.seed('model/queryProviderList', () => ({
      code: 0,
      message: 'ok',
      data: { providers: window.__mockProviders },
    }));
    // saveProvider：捕获参数并写入内存存储（勾选写 1000000，null 移除字段；多模态写/移除 vision）
    window.__forgeMock!.seed('model/saveProvider', (params) => {
      window.__mockSaveParams = params;
      const i = window.__mockProviders!.findIndex((p) => p.id === (params.id ?? params.name));
      if (i >= 0) {
        if (params.contextWindow === null) {
          delete window.__mockProviders![i].contextWindow;
        } else {
          window.__mockProviders![i].contextWindow = params.contextWindow;
        }
        if (typeof params.vision === 'boolean') {
          window.__mockProviders![i].vision = params.vision;
        }
      }
      return { code: 0, message: 'ok', data: null };
    });
  }, providers);
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();
}

/** 点击某模型「编辑」并返回上下文 1M checkbox locator */
function contextCheckbox(page: import('@playwright/test').Page) {
  return page.locator('.context-1m input');
}

/** 多模态（支持图片输入）checkbox locator */
function visionCheckbox(page: import('@playwright/test').Page) {
  return page.locator('.context-vision input');
}

test('MP-S06 E-MP-005a：勾选上下文 1M 保存写入 contextWindow=1000000，重新编辑回显勾选', async ({ page }) => {
  await initProviderContext(page, [
    {
      id: 'Grok 4.5',
      name: 'Grok 4.5',
      type: 'openai-completions',
      baseUrl: 'https://xuseny.online/v1',
      models: ['grok-4.5'],
      lastError: null,
      // 初始无 contextWindow（未勾选态）
    },
  ]);
  await expect(page.locator('.provider-item')).toHaveCount(1);

  // 编辑 Grok 4.5：contextWindow 缺失 → 未勾选
  page.locator('.provider-item').filter({ hasText: 'Grok 4.5' }).getByRole('button', { name: '编辑' }).click();
  await expect(contextCheckbox(page)).not.toBeChecked();

  // 勾选并保存
  await contextCheckbox(page).check();
  await page.locator('.form-actions .primary').click();
  await expect(page.locator('.toast .toast-message')).toContainText('模型配置已保存');

  // 传输参数含 contextWindow=1000000；内存存储对应模型写入该值
  await page.waitForFunction(() => window.__mockSaveParams !== null);
  const savedParams = await page.evaluate(() => window.__mockSaveParams);
  expect(savedParams?.contextWindow).toBe(1000000);
  const stored = await page.evaluate(() => window.__mockProviders?.[0].contextWindow);
  expect(stored).toBe(1000000);

  // 重新打开编辑：回显勾选
  page.locator('.provider-item').filter({ hasText: 'Grok 4.5' }).getByRole('button', { name: '编辑' }).click();
  await expect(contextCheckbox(page)).toBeChecked();
});

test('MP-S06 E-MP-005b：取消勾选保存移除字段，重新编辑未勾选', async ({ page }) => {
  // 种子模型初始即 1M（已勾选态），用于验证「编辑 → 取消 → 移除字段」
  await initProviderContext(page, [
    {
      id: 'Grok 4.5',
      name: 'Grok 4.5',
      type: 'openai-completions',
      baseUrl: 'https://xuseny.online/v1',
      models: ['grok-4.5'],
      contextWindow: 1000000,
      lastError: null,
    },
  ]);
  await expect(page.locator('.provider-item')).toHaveCount(1);

  // 编辑：回显勾选
  page.locator('.provider-item').filter({ hasText: 'Grok 4.5' }).getByRole('button', { name: '编辑' }).click();
  await expect(contextCheckbox(page)).toBeChecked();

  // 取消勾选并保存
  await contextCheckbox(page).uncheck();
  await page.locator('.form-actions .primary').click();
  await expect(page.locator('.toast .toast-message')).toContainText('模型配置已保存');

  // 传输参数 contextWindow=null → 服务层移除字段；内存存储不再含该字段
  await page.waitForFunction(() => window.__mockSaveParams !== null);
  const savedParams = await page.evaluate(() => window.__mockSaveParams);
  expect(savedParams?.contextWindow).toBeNull();
  const hasField = await page.evaluate(() => Object.prototype.hasOwnProperty.call(window.__mockProviders![0], 'contextWindow'));
  expect(hasField).toBe(false);

  // 重新编辑：未勾选
  page.locator('.provider-item').filter({ hasText: 'Grok 4.5' }).getByRole('button', { name: '编辑' }).click();
  await expect(contextCheckbox(page)).not.toBeChecked();
});

test('MP-S06 E-MP-005c (AC-MP-017)：编辑存量 200000 模型默认未勾选，直接保存即移除字段', async ({ page }) => {
  // 存量非 1M contextWindow：表单应默认未勾选；保存一律按勾选覆盖 → 移除字段
  await initProviderContext(page, [
    {
      id: 'CE 200k',
      name: 'CE 200k',
      type: 'openai-completions',
      baseUrl: 'https://ce.example/v1',
      models: ['ce-200k'],
      contextWindow: 200000,
      lastError: null,
    },
  ]);
  await expect(page.locator('.provider-item')).toHaveCount(1);

  // 编辑：contextWindow=200000 ≠ 1000000 → 未勾选
  page.locator('.provider-item').filter({ hasText: 'CE 200k' }).getByRole('button', { name: '编辑' }).click();
  await expect(contextCheckbox(page)).not.toBeChecked();

  // 不做任何勾选，直接保存 → 移除非 1M 字段
  await page.locator('.form-actions .primary').click();
  await expect(page.locator('.toast .toast-message')).toContainText('模型配置已保存');
  await page.waitForFunction(() => window.__mockSaveParams !== null);
  const savedParams = await page.evaluate(() => window.__mockSaveParams);
  expect(savedParams?.contextWindow).toBeNull();
  const hasField = await page.evaluate(() => Object.prototype.hasOwnProperty.call(window.__mockProviders![0], 'contextWindow'));
  expect(hasField).toBe(false);

  // 重新编辑：未勾选
  page.locator('.provider-item').filter({ hasText: 'CE 200k' }).getByRole('button', { name: '编辑' }).click();
  await expect(contextCheckbox(page)).not.toBeChecked();
});

// ===== 多模态：支持图片输入勾选（E-MP-006v） =====

test('多模态 E-MP-006v a：勾选「支持图片输入」保存传 vision=true，列表显示多模态标签，重新编辑回显勾选', async ({ page }) => {
  await initProviderContext(page, [
    {
      id: 'MiniMax-M3',
      name: 'MiniMax-M3',
      type: 'openai-completions',
      baseUrl: 'https://api.minimaxi.com/v1',
      models: ['MiniMax-M3'],
      lastError: null,
      // 初始未声明 input（纯文本态）
    },
  ]);
  await expect(page.locator('.provider-item')).toHaveCount(1);

  // 编辑：vision 缺失 → 未勾选；无多模态标签
  page.locator('.provider-item').filter({ hasText: 'MiniMax-M3' }).getByRole('button', { name: '编辑' }).click();
  await expect(visionCheckbox(page)).not.toBeChecked();

  // 勾选并保存
  await visionCheckbox(page).check();
  await page.locator('.form-actions .primary').click();
  await expect(page.locator('.toast .toast-message')).toContainText('模型配置已保存');

  // 传输参数 vision=true；列表出现「多模态」标签
  await page.waitForFunction(() => window.__mockSaveParams !== null);
  const savedParams = await page.evaluate(() => window.__mockSaveParams);
  expect(savedParams?.vision).toBe(true);
  await expect(page.locator('.vision-tag')).toContainText('多模态');

  // 重新打开编辑：回显勾选
  page.locator('.provider-item').filter({ hasText: 'MiniMax-M3' }).getByRole('button', { name: '编辑' }).click();
  await expect(visionCheckbox(page)).toBeChecked();
});

test('多模态 E-MP-006v b：取消勾选保存传 vision=false，列表标签消失，重新编辑未勾选', async ({ page }) => {
  await initProviderContext(page, [
    {
      id: 'Vision-1',
      name: 'Vision-1',
      type: 'openai-completions',
      baseUrl: 'https://v.example/v1',
      models: ['Vision-1'],
      vision: true,
      lastError: null,
    },
  ]);
  await expect(page.locator('.provider-item')).toHaveCount(1);
  await expect(page.locator('.vision-tag')).toContainText('多模态');

  // 编辑：回显勾选
  page.locator('.provider-item').filter({ hasText: 'Vision-1' }).getByRole('button', { name: '编辑' }).click();
  await expect(visionCheckbox(page)).toBeChecked();

  // 取消勾选并保存
  await visionCheckbox(page).uncheck();
  await page.locator('.form-actions .primary').click();
  await expect(page.locator('.toast .toast-message')).toContainText('模型配置已保存');

  // 传输参数 vision=false；列表标签消失
  await page.waitForFunction(() => window.__mockSaveParams !== null);
  const savedParams = await page.evaluate(() => window.__mockSaveParams);
  expect(savedParams?.vision).toBe(false);
  await expect(page.locator('.vision-tag')).toHaveCount(0);

  // 重新编辑：未勾选
  page.locator('.provider-item').filter({ hasText: 'Vision-1' }).getByRole('button', { name: '编辑' }).click();
  await expect(visionCheckbox(page)).not.toBeChecked();
});

// ===== 关于 Tab · 版本更新（07：pi/getInfo + pi/updatePlugins，明面 forge 产品更新） =====

test('版本更新：关于 Tab 展示 forge 版本，更新成功 toast，且不渲染组件清单', async ({ page }) => {
  await page.evaluate(() => {
    window.__forgeMock!.seed('pi/getInfo', () => ({
      code: 0,
      message: 'ok',
      data: { forgeVersion: '0.1.0' },
    }));
    window.__forgeMock!.seed('pi/updatePlugins', () => ({
      code: 0,
      message: 'ok',
      data: { output: 'updated pi-mcp-adapter to 2.33.0' },
    }));
  });
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await expect(page.locator('.settings-stage')).toBeVisible();

  // 默认通用 Tab：模型配置可见，版本更新分区不可见
  await expect(page.locator('.provider-item').first()).toBeVisible();
  await expect(page.locator('.update-section')).toHaveCount(0);

  // 切到关于 Tab：版本行展示；负向断言——不渲染组件清单（明细仅日志与 updater-state）
  await page.locator('.settings-tab', { hasText: '关于' }).click();
  await expect(page.locator('.update-section .version-value')).toHaveText('0.1.0');
  await expect(page.locator('.plugin-list')).toHaveCount(0);
  await expect(page.locator('.plugin-item')).toHaveCount(0);

  // 更新：成功 toast + 按钮复位
  await page.locator('.update-section .section-action').click();
  await expect(page.locator('.toast .toast-message')).toContainText('更新完成');
  await expect(page.locator('.update-section .section-action')).toHaveText('更新组件');
  await expect(page.locator('.update-section .section-error')).toHaveCount(0);
});

test('版本更新：更新失败展示错误与输出尾部，按钮恢复可点', async ({ page }) => {
  await page.evaluate(() => {
    window.__forgeMock!.seed('pi/getInfo', () => ({
      code: 0,
      message: 'ok',
      data: { forgeVersion: '0.1.0' },
    }));
    window.__forgeMock!.seed('pi/updatePlugins', () => ({
      code: 6002,
      message: '组件更新失败',
      data: { output: 'npm error code E404\nnpm error 404 Not Found' },
    }));
  });
  await page.locator('.sidebar-link', { hasText: '设置' }).click();
  await page.locator('.settings-tab', { hasText: '关于' }).click();

  await page.locator('.update-section .section-action').click();
  await expect(page.locator('.update-section .section-error')).toContainText('组件更新失败');
  await expect(page.locator('.update-output')).toContainText('npm error code E404');
  await expect(page.locator('.update-section .section-action')).toBeEnabled();
  // 失败不弹成功 toast（无任何 toast 元素）
  await expect(page.locator('.toast .toast-message')).toHaveCount(0);
});