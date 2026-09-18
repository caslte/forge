# pi 扩展冷加载会占满 Electron 主进程，首条消息卡顿要预热而不是重试发送

**反直觉点**：forge 的 pi 会话工厂在**每会话首条消息**时才创建 `AgentSession`，其中 `DefaultResourceLoader.reload()` 会经 **jiti 现场编译** `settings.packages` 全部 npm 扩展。扩展数量多时（10 个包实测 3~9s）这段 CPU+同步 fs 工作把 **Electron 主进程事件循环打满**——但渲染进程是独立进程，所以症状不是"页面白屏"而是"**整个 app 都卡**：IPC 全部延迟、会话树刷新慢、窗口控制/输入卡顿"，极易误判为渲染进程问题。

**关键事实**：
- pi 扩展模块缓存在 `pi-coding-agent/dist/core/extensions/loader.js` 是**模块级 Map，按 cwd 记忆**（`useExtensionCacheCwd`，cwd 变化即清空）→ 同 cwd 二次 `reload()` 仅 75~550ms，跨 cwd/跨进程全冷。
- jiti 的 fsCache 默认开着也救不了：大头是模块解析的 stat 风暴 + 转译，不是单文件转换。
- `monitorEventLoopDelay` 冷 reload 期间 p50 延迟 ≈16ms（正常 <1ms）＝事件循环饱和的直接证据。

**排查路径**（可复用）：
1. 症状"发消息才卡、会话树/事件延迟"→ 先怀疑主进程，不是渲染进程。
2. `--cpu-prof` 跑独立脚本 + 解析 cpuprofile 的 self-time 聚合：本例 stat/statSync/jiti 占据绝对大头。
3. 计时拆阶段：工厂总耗时 5444ms → `resourceLoader.reload()` 3331ms（`createAgentSession` 仅 48ms）。
4. 渲染进程侧的流式冻结另查：逐 delta 全量 markdown 重渲染（marked+hljs+sanitize）是 O(n²)，33KB 回复单次 44ms × 40 delta/s ≈ 176% 渲染线程——用节流（150ms 尾随）降到 ~29%。

**修复模式**：把冷编译挪出关键路径——`project.opened` 时后台调 `warmPiResourceLoader(cwd)`（只跑 `reload()` 填充 pi 进程内扩展缓存，不建会话文件），首条消息的工厂创建命中热缓存（实测 5444ms → 175ms）。同 cwd 幂等防重复预热。**⚠️ 该触发点有一处二次回归，见文末「二次回归」一节——必须延后触发，不能同步预热。**

**已知边界**：pi 缓存按 cwd 记忆 → 多项目轮流首发仍各冷一次；根治需把 pi 会话运行时挪出主进程（utilityProcess）。

**回归锁法**：无（预热是后台性能路径，无行为契约可断言；计时脚本属一次性工具）。

---

## 二次回归：预热挂在 `project.opened` 上，会让「会话树延迟出现」

**症状**：首次（每次冷启动）app 启动后**项目已显示，但会话树空白，隔几秒才出内容**。

**反直觉点**：`project.opened` 的监听里写的是 `void warmPiResourceLoader(...)`，看着是 fire-and-forget，但它**并不能避开阻塞**——async IIFE 的**同步前缀（`SettingsManager.create` → `new DefaultResourceLoader` → `reload()` 的首段 jiti 解析）是在 `project/openProject` 的 RPC handler 内联执行的**。`void` 只是不 await 返回的 promise，同步段照样占住事件循环。

**因果链**（逐行已核实）：
1. 渲染进程 onMounted → `project/queryProjectList`（纯 store 内存读，毫秒级）→ 项目**立即渲染**（= "项目显示了"）。
2. 紧接着 `await openProject(projects[0].path)`。
3. `projectMethods.ts` 在 handler 内**同步** `events.emit('project.opened')` 后才 `return`。
4. `main.ts` 监听器调 `warmPiResourceLoader` → 第 5 步的同步段在 handler 内跑完。
5. **被卡住的不只是后续请求，openProject 自己的 IPC 响应都发不回去** → 渲染进程卡在 `await call(...)` → `selectProject` 后面的 `loadSessions()` 根本没机会发出 → 会话树空白到编译结束。

**放大器（结构原因）**：前端把 `loadSessions()` 串在 `openProject()` 之后，而 `session/querySessionList` 传 `{}` 返回**全部**会话、与打开项目零依赖——两个本可并行的请求被写成严格串行，于是必须等整条链走完。

**首启叠加**：`createStartupUpdate` 在 `preinstallDone=false` 时逐项 `pi install` 推荐组件（子进程 + 网络 + 磁盘），与冷编译抢 I/O，首次启动更明显。

**准确表述**：pi 扩展模块缓存是 loader.js 里的**进程内 Map**（按 cwd 记忆），跨进程全冷 → **每次新起 Electron 进程都要重编译一遍**，不是"只慢第一次"。

**修复（v3.66，双管齐下）**：
1. `main.ts`：`project.opened` → `setTimeout(() => void warmPiResourceLoader(path), PI_WARMUP_DEFER_MS)`（1500ms），让启动关键路径（项目/会话列表 IPC，毫秒级）先跑完。代价：预热完成时刻推迟同样时长，对首条发送无实质影响。
2. `App.vue` onMounted：`void loadSessions()` 与 `loadProjects()` **并行**发出，会话请求排到 openProject/预热之前落地。安全性已核实：会话树以 projects 为外层循环按 projectPath 分组（`ProjectTree.vue` `sessionsOf`），sessions 先到无副作用；且无 `currentProjectPath` watcher，不会重复触发。

**排查复用**：凡是"启动后某块 UI 空白数秒"且**同一进程内后续操作正常**的症状，先查是不是有重活被挂在了启动关键路径的同步段上——`void` / fire-and-forget 只保证不 await，**不保证不阻塞**。

**回归锁法**：`e2e/session.spec.ts` 的 `SESSION-E2E-008`（E-SM-008）已锁住**前端并行加载**这一半 —— init script 抢在 mock 句柄赋值瞬间注入 6s 延迟的 `project/openProject`，断言 `.tree-project` 先到且 `.tree-session` 在 **2000ms** 内到位；已实测 RED→GREEN（仅回退 `App.vue` 的那行并行调用即失败，恢复后 543ms 通过）。
`main.ts` 侧的延后预热仍无自动化覆盖（Electron 入口，import electron，不可单测），那半依旧靠真机启动观察 —— 缺口如实记录。
