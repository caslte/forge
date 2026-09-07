# mock-bridge 返回共享活数组会静默破坏 Vue 响应式

- **id**: kb-2026-09-10-mock-shared-live-array
- **createdAt**: 2026-09-10
- **source**: v3.48 新建项目未自动选中（e2e 排查）

## 现象

e2e（Playwright + vite dev mock-bridge）里 App 状态与 DOM 不一致：`projects.value` 已含新项目（项目树渲染正确），但依赖它的 `orderedProjects` computed 缓存永不失效（下拉列表缺新项目）。手动重赋 `projects.value` 立即恢复，页面无任何报错。

## 根因

mock-bridge 的 `project/queryProjectList` 原样返回 `DB.projects` 活数组。真实 Electron IPC 结构化克隆每次返回**新数组**。共享实例产生两个静默失效点：

1. `projects.value = res.projects` 赋同一实例 → ref setter `hasChanged` 判 false → 不触发依赖；
2. mock 侧 `DB.projects.push(...)` 直接改原始数组，绕过 Vue reactive proxy → 也不触发。

于是订阅该 ref 的 computed 缓存永不过期；而组件模板恰好因其他响应式变化（如 currentProjectPath 变更）重渲染时，又会读到 proxy 的**当前**底层数组内容——出现"树对了、computed 旧了"的分裂假象，极易误导为应用层 bug。

## 排查路径（可复用）

1. DOM 断言失败但相邻断言通过 → 先分头取证：`devtoolsRawSetupState` 直读 App 的 ref/computed 现值（绕开 setupState 代理），比对 `projects` / `orderedProjects` / `pickPicker`；
2. computed 与其依赖明显矛盾 → 在页面里手动重赋各依赖 ref，定位哪个触发链断了；
3. 结论指向"赋值未触发" → 检查 mock 返回值与上次是否同一对象实例（`===`），对齐真实 IPC 的克隆语义。

## 修复

mock-bridge 所有返回集合的方法必须返回副本（逐项浅拷贝），对齐 IPC 结构化克隆边界语义：`{ projects: DB.projects.map((p) => ({ ...p })) }`。`session/querySessionList` 已是 `filter()` 新数组所以无症状；凡新增 mock case 返回 `DB.*` 原集合都要遵守此约定。
