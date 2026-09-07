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

**修复模式**：把冷编译挪出关键路径——`project.opened` 时后台调 `warmPiResourceLoader(cwd)`（只跑 `reload()` 填充 pi 进程内扩展缓存，不建会话文件），首条消息的工厂创建命中热缓存（实测 5444ms → 175ms）。同 cwd 幂等防重复预热。

**已知边界**：pi 缓存按 cwd 记忆 → 多项目轮流首发仍各冷一次；根治需把 pi 会话运行时挪出主进程（utilityProcess）。

**回归锁法**：无（预热是后台性能路径，无行为契约可断言；计时脚本属一次性工具）。
