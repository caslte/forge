# E2E 自动化测试模板

> 使用 Playwright 进行端到端自动化测试

---

## 一、环境配置

### 1.1 安装依赖

```bash
npm install -D @playwright/test
npx playwright install chromium
```

### 1.2 配置文件

```javascript
// playwright.config.js
module.exports = {
  testDir: './tests/e2e',
  timeout: 30000,
  retries: 0,
  use: {
    baseURL: 'http://localhost:8080',
    headless: true,
    screenshot: 'only-on-failure',
    video: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
    },
  ],
};
```

---

## 二、测试文件组织

```
tests/
├── e2e/
│   ├── pages/                 # Page Object
│   │   ├── DashboardPage.js
│   │   ├── ResourcePage.js
│   │   └── RecordPage.js
│   ├── specs/                 # 测试用例
│   │   ├── dashboard.spec.js
│   │   ├── resource.spec.js
│   │   └── record.spec.js
│   └── utils/
│       └── dataBuilder.js
```

---

## 三、Page Object 模式

### 3.1 示例：仪表盘

```javascript
// tests/e2e/pages/DashboardPage.js
class DashboardPage {
  constructor(page) {
    this.page = page;
  }

  locators = {
    summaryCard: () => this.page.locator('[data-testid="summary-card"]'),
    resourceTable: () => this.page.locator('[data-testid="resource-table"]'),
    quickAddButton: () => this.page.locator('[data-testid="quick-add-btn"]'),
  };

  async goto() {
    await this.page.goto('/');
  }

  async clickQuickAdd() {
    await this.locators.quickAddButton().click();
  }
}

module.exports = { DashboardPage };
```

---

## 四、测试用例格式

### 4.1 示例：仪表盘测试

```javascript
// tests/e2e/specs/dashboard.spec.js
const { test, expect } = require('@playwright/test');
const { DashboardPage } = require('../pages/DashboardPage');

test.describe('仪表盘', () => {
  let dashboardPage;

  test.beforeEach(async ({ page }) => {
    dashboardPage = new DashboardPage(page);
    await dashboardPage.goto();
  });

  test('TC-501: 应显示核心统计信息', async () => {
    // Given: 已存在测试资源

    // When: 打开仪表盘
    await dashboardPage.goto();

    // Then: 验证核心区域显示
    await expect(dashboardPage.locators.summaryCard()).toBeVisible();
    await expect(dashboardPage.locators.resourceTable()).toBeVisible();
  });

  test('TC-401: 点击快捷添加按钮应打开弹窗', async ({ page }) => {
    // Given: 在仪表盘

    // When: 点击快捷添加按钮
    await dashboardPage.clickQuickAdd();

    // Then: 验证弹窗显示
    await expect(page.locator('[data-testid="quick-add-popup"]')).toBeVisible();
  });
});
```

### 4.2 示例：资源管理测试

```javascript
// tests/e2e/specs/resource.spec.js
const { test, expect } = require('@playwright/test');
const { ResourcePage } = require('../pages/ResourcePage');

test.describe('资源管理', () => {
  let resourcePage;

  test.beforeEach(async ({ page }) => {
    resourcePage = new ResourcePage(page);
    await resourcePage.goto();
  });

  test('TC-201: 应能创建资源', async () => {
    // Given: 在资源列表页面

    // When: 新增资源
    await resourcePage.clickAddButton();
    await resourcePage.fillName('示例资源');
    await resourcePage.selectType('standard');
    await resourcePage.clickSave();

    // Then: 验证保存成功
    const record = resourcePage.getRowByName('示例资源');
    await expect(record).toBeVisible();
  });

  test('TC-205: 应支持按状态筛选', async () => {
    // Given: 有多条不同状态的资源

    // When: 选择状态筛选条件
    await resourcePage.selectStatus('active');

    // Then: 验证列表刷新
    const rowCount = await resourcePage.locators.tableRows().count();
    expect(rowCount).toBeGreaterThan(0);
  });
});
```

---

## 五、数据准备

### 5.1 API 方式准备数据

```javascript
// tests/e2e/utils/dataBuilder.js
class DataBuilder {
  constructor(request) {
    this.request = request;
  }

  async createResource(name = '测试资源', type = 'standard') {
    const response = await this.request.post('/api/resources', {
      data: {
        name,
        type,
      },
    });
    return response.json();
  }

  async createRecord(resourceId, title, recordDate) {
    const response = await this.request.post(`/api/resources/${resourceId}/records`, {
      data: {
        title,
        recordDate,
      },
    });
    return response.json();
  }

  async createTask(resourceId, title, plannedDate) {
    const response = await this.request.post(`/api/resources/${resourceId}/tasks`, {
      data: {
        title,
        plannedDate,
      },
    });
    return response.json();
  }

  async cleanup() {
    // 清理测试数据
  }
}

module.exports = { DataBuilder };
```

### 5.2 在测试中使用

```javascript
test.beforeEach(async ({ request }) => {
  const dataBuilder = new DataBuilder(request);

  const resource = await dataBuilder.createResource('测试资源', 'standard');
  await dataBuilder.createRecord(resource.id, '测试记录', '2026-02-17');

  test.context().resourceId = resource.id;
  test.context().resourceName = '测试资源';
});
```

### 5.3 前置条件具体示例

> 以下展示测试表格中每个"前置条件"对应的具体实现代码。

#### 资源测试 - TC-101（显示资源详情）

```javascript
// 前置条件：已存在资源（测试资源，standard）
test.beforeEach(async ({ request }) => {
  const dataBuilder = new DataBuilder(request);
  const resource = await dataBuilder.createResource('测试资源', 'standard');

  test.context().resourceId = resource.id;
  test.context().resourceName = '测试资源';
});

test('TC-101: 应显示资源详情', async ({ page }) => {
  await page.goto(`/resources/${test.context().resourceId}`);
  await expect(page.locator('[data-testid="resource-name"]'))
    .toHaveText(test.context().resourceName);
});
```

#### 任务测试 - TC-105（标记完成）

```javascript
// 前置条件：存在待处理任务
test.beforeEach(async ({ request }) => {
  const dataBuilder = new DataBuilder(request);
  const resource = await dataBuilder.createResource('测试资源', 'standard');
  const task = await dataBuilder.createTask(resource.id, '待处理任务', getToday());

  test.context().resourceId = resource.id;
  test.context().taskId = task.id;
});

function getToday() {
  return new Date().toISOString().split('T')[0];
}

test('TC-105: 应能标记任务完成', async ({ page }) => {
  await page.goto(`/resources/${test.context().resourceId}/tasks`);

  await page.locator(`[data-testid="complete-${test.context().taskId}"]`).click();
  await page.locator('[data-testid="confirm-btn"]').click();

  await expect(page.locator(`[data-testid="task-status-${test.context().taskId}"]`))
    .toHaveText('已完成');
});
```

---

## 六、结构化测试场景表

> 每个功能模块应包含以下结构化测试场景表格，Agent 生成测试代码时直接按表格填写。

### 模块：仪表盘 (DashboardPage)

#### 功能点：核心统计展示

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-501 | 有资源和任务数据 | 1. 打开首页 2. 等待加载 | 统计卡片和资源列表显示 | expect(summary).toBeVisible()<br>expect(table).toBeVisible() |
| TC-502 | 有待处理任务 | 1. 打开首页 | 待处理任务数量正确 | expect(counter).toContainText('1') |

#### 功能点：快捷添加

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-401 | 无 | 1. 点击快捷添加按钮 | 弹窗显示，包含资源/任务/记录选项 | expect(popup).toBeVisible()<br>expect(options).toHaveCount(3) |

---

### 模块：资源管理 (ResourcePage)

#### 功能点：创建资源

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-201 | 已登录 | 1. 进入资源列表 2. 点击新增 3. 输入名称 4. 保存 | 资源保存成功，列表显示新数据 | expect(row).toBeVisible()<br>expect(name).toHaveText('测试资源') |
| TC-202 | 已登录 | 1. 点击新增 2. 不输入名称直接保存 | 提示"名称不能为空" | expect(error).toBeVisible() |
| TC-203 | 已登录 | 1. 点击新增 2. 输入超长名称 | 提示"名称超出长度限制" | expect(error).toBeVisible() |

#### 功能点：查看资源

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-204 | 有资源数据 | 1. 进入资源列表 | 表格显示资源数据 | expect(rows.count()).toBeGreaterThan(0) |
| TC-205 | 有不同状态资源 | 1. 选择状态筛选条件 | 列表只显示匹配状态的数据 | expect(statusCells).toContainText('启用') |

#### 功能点：删除资源

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-206 | 有资源"测试资源" | 1. 点击删除 2. 确认 | 资源从列表中消失 | expect(row).not.toBeVisible() |

---

### 模块：任务处理 (TaskPage)

#### 功能点：创建任务

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-101 | 有资源数据 | 1. 进入任务页面 2. 点击新增任务 | 任务创建成功，状态为"待处理" | expect(task).toBeVisible() |

#### 功能点：标记完成

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-105 | 有待处理任务 | 1. 点击完成 2. 确认 | 状态变为"已完成"，显示完成时间 | expect(status).toHaveText('已完成') |
| TC-106 | 已完成1/10任务 | 查看进度 | 显示进度"10%" | expect(progress).toContainText('10%') |

---

### 模块：记录管理 (RecordPage)

#### 功能点：录入记录

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-301 | 有资源数据 | 1. 进入记录页面 2. 点击新增 3. 输入标题和内容 4. 保存 | 保存成功，列表显示新记录 | expect(record).toBeVisible() |
| TC-302 | 有资源数据 | 1. 点击新增 2. 标题为空 | 提示"标题不能为空" | expect(error).toBeVisible() |

#### 功能点：查看记录

| 用例 ID | 前置条件 | 操作步骤 | 预期结果 | 断言方式 |
|---------|---------|---------|---------|---------|
| TC-303 | 有3条以上记录 | 1. 进入记录页面 | 记录列表正确显示 | expect(rows).toHaveCount(3) |

---

## 七、运行测试

```bash
npx playwright test
npx playwright test tests/e2e/specs/resource.spec.js
npx playwright test --headed
npx playwright show-report
```

---

## 八、注意事项

1. **使用 data-testid 属性标记元素，便于定位**
2. **每个测试用例独立，不依赖其他用例的执行顺序**
3. **测试数据在 beforeEach 中准备，afterEach 中清理**
4. **断言要具体，验证关键字段**
5. **失败时自动截图，便于排查问题**
6. **Page Object 封装页面交互，测试用例只写断言**
