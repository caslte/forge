# 新增 forge-core 事件必须同步 ipc-contract FORGE_EVENTS 转发白名单

- 日期：2026-09-09 ｜ 来源：v3.49 消息队列浮窗真实端始终不出现（conversation.queueUpdated 漏登白名单）
- 适用：所有「forge-core 发事件 → Electron 主进程转发 → 渲染进程 subscribe」链路（及任何同类静态白名单注册）

## 反直觉根因

main 进程 `registerIpc` 只把 `FORGE_EVENTS` 白名单内的事件经 `webContents.send(IPC_EVENT, ...)` 转发给渲染进程。新增事件通道若只写了 forge-core `events.emit('<channel>')` 与渲染端 `subscribe('<channel>')`，而漏登 `ipc-contract.ts` 的 `ForgeEvent` 联合类型 + `FORGE_EVENTS` 数组，事件在主进程总线上发出但**静默丢失**（无报错、无日志），渲染进程回调永不触发。

## 盲区：mock-bridge 完全绕过此链路

mock-bridge（浏览器 dev + 全部 e2e）在同一 JS 上下文内 emit/consume，不经主进程 IPC 转发。因此白名单缺失对 mock 路径**零影响**——单测/e2e 全绿但真实 Electron 端必挂。CV-S09 `conversation.queueUpdated` 连续三轮修复（v3.47 分流竞态、v3.48 mock 响应式）都真实端仍复现，即此因。

## 排查路径与防线

1. 症状「某事件 mock 生效、真实端收不到」→ 第一嫌疑就是转发白名单，先 diff `FORGE_EVENTS` 与 forge-core `events.emit` 通道清单。
2. 防线：契约回归测试 `packages/forge-desktop/test/ipcEventContract.test.ts`——静态扫描 forge-core 全部 `events.emit('<channel>')` 字面量，断言每个通道均已在 `FORGE_EVENTS` 登记；新增事件漏登直接红。
