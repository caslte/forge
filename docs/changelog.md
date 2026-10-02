# 变更日志

## v6.13 (增强：代码树右键「复制路径」+ 代码区右上角改终端开关)

> 来源：2026-10-02 用户反馈（截图）——①右键菜单加一个复制路径；②代码区右上角的「关闭当前文件」与签条 × 功能重复，换成终端图标，随手唤醒终端。

- **复制路径（代码树行右键菜单）**：文件行与目录行通用项（文件=文件本体、目录=目录本体，都是绝对路径），置于「打开所在目录」之前；走 `navigator.clipboard`（与选区复制浮窗同通道），写失败静默。i18n `tool.copyPath`（复制路径 / Copy path）。
- **代码区右上角 `cv-close` → `cv-term`**：原按钮「关闭当前文件」与签条 × 完全重复（Esc 也能关），改为与顶栏同款 `>_` 终端图标——`setTerminalOpen(!terminalOpen)` toggle，代码态不必回对话区就能拉起终端（Ctrl+` 的鼠标入口）。按钮从 `v-if="activeFile"` 改为常驻（终端开关不依赖打开文件）。i18n 复用既有 `terminal.toggle`，删除不再被引用的 `code.close`。
- **代码态终端落位 = 全宽底部抽屉**（用户实测「点了按钮看不到终端」的修复）：cover 布局的代码纸是 `absolute inset:0; z-20` 整张盖上去的，流内终端被压在纸**下面**；split 下终端又只缩在左列底部，两种布局落点不一致。修法：`.content` 代码态挂 `code-mode` 类（`codeOpenPath !== null`），`.content.code-mode .term` 提为 `absolute bottom:0; z-30` 的**全宽抽屉**（z 高于纸的 20），宽度横贯 .content、grip 拖拽调高照旧；对话态（无 code-mode）保持原流内行为不动。
- **测试**：E-CE-20 扩为断言「复制路径」（目录行/文件行菜单元素 + 剪贴板内容，`grantPermissions` 与 E-CE-24 同款）；新增 E-CE-26（点 `.cv-term` → `.term.open` 出现、再点收起）。
- **验证**：e2e codeExplorer + changedFiles 32 过 2 跳过（存量）；forge-ui 单测 385/385、typecheck 0 错。渲染层纯改动，vite 热更新直达运行中的应用。
- **不做的**：① 不复制相对路径/双反斜杠变体（Windows 资源管理器与终端都吃正斜杠绝对路径，需要再说）；② 不动顶栏终端开关与 Ctrl+`（三者共用同一 `terminalOpen` 偏好，状态互通）。

## v6.12 (增强：代码浏览器签条跟随磁盘变化自动刷新)

> 来源：2026-10-02 用户追问「现在编辑器的内容会不会更新？」——内置代码浏览器此前是「打开那一刻的快照」，agent 在会话里改文件、用户开着签条看，内容永远停在打开时的版本。

- **原行为**：`useCodeExplorer.openFile` 打开时经 `file/readFile` 读一次存入状态，再点同签只切激活态不重读（注释明示是刻意取舍）；无 fs.watch、无轮询、无失焦重读。只有关签重开才能看到新内容。
- **修法（core + ui 两端）**：
  - `forge-core/src/file/watcher.ts`（新增）：`OpenFileWatcher` 纯管理逻辑——监听**父目录**而非文件本身（编辑器保存常用「临时文件 + 原子替换」，文件级 watch 会在替换瞬间失效，真机实测目录级能扛住）；同目录多文件共享一个 watcher；事件按「当前打开集合」过滤；按 relPath 防抖 300ms（编辑器一次保存常触发多轮 fs 事件）；`watchDir` 注入（真实实现 `fsDirWatcher` = fs.watch 薄包装，`persistent:false` + error 静默）。
  - `fileMethods.ts`：新增 `file/watchSync`（渲染层在打开/关闭文件后发**该项目**的全量 relPaths，主进程做目录级 diff），逐条过 `resolveInside` 与 readFile 同一道越界校验（6103/6104 条目静默剔除）；变化经共享 eventBus 发 `code.fileChanged` {projectPath, relPath}，主进程按 FORGE_EVENTS 登记转发渲染层。
  - `useCodeExplorer.ts`：模块内订阅 `code.fileChanged` → `refreshOpenFile` 静默重读（只读查看器无 dirty 态，直接覆盖 data，无需确认弹窗；失败不清空已载入 data，6104 打「已删除」标）；`loading` 中的签跳过避免竞态；打开/关闭文件后 `syncWatchers` 对齐监听集合；项目缓存失效时顺带撤监听。旧 preload / 浏览器 mock 无此通道时全部静默降级。
- **测试**：`test/file/watcher.test.ts`（7 例，RED→GREEN：目录去重、relPath 分发、未打开过滤、防抖、移除停回调并关 watcher、目录不存在容错、dispose）；`test/file/watchApi.test.ts`（4 例：事件发射、越界/失效剔除、参数校验 6101、默认防抖 300ms）。真机 fs.watch 端到端：覆写 / 原子替换 / 关闭后静默三场景全过。
- **验证**：core 526/526、ui 385/385、desktop 382 过（7 失败为 v6.7/v6.8 已记账存量）；双包 typecheck 0 错。
- **不做的**：① 不做目录树/搜索结果的自动刷新（树是懒加载缓存，下次展开自然新数据；要做须另评估扫盘开销）；② 不弹「文件已更改」确认框（只读无 dirty，静默覆盖 + 保持滚动位置即可；将来做内置编辑才需要冲突检测）；③ 不做全仓库递归 watch（只监听打开文件的父目录，句柄数与打开数解耦）。

## v6.11 (调整：隐藏代码树「最近打开」分组)

> 来源：2026-10-02 用户反馈（截图：代码浏览器左栏）——「最近打开这个功能先隐藏，我感觉用处不是很大」。

- **做法（隐藏而非删除）**：`CodeTreePanel.vue` 新增 `SHOW_RECENT_GROUP = false` 开关，分组模板挂在该开关后面；`recentFiles` 计算属性、`onPickRecent`、样式与 i18n 文案全部保留，恢复时把开关翻回 `true` 即可。打开历史（`history`）数据层照常记录，不受隐藏影响。
- **e2e 同步**：`codeExplorer.spec.ts` 中依赖该分组 DOM 的用例同步调整——E-CE-13 去掉「上限 5 个」分组断言（tab 中键关闭/横滚/滚进视野部分保留）；E-CE-15 选中行底色断言改用树内激活文件行（同一套 `.ctp-row.is-active` 样式）；E-CE-18/19（历史与标签页解耦、历史顺序语义）整体标 `test.fixme` 并注明恢复条件。

## v6.10 (修复+增强：编辑器目录三层扫描——右键按已装编辑器分项打开，修掉 Windows 上点了没反应)

> 来源：2026-10-02 用户反馈两轮（截图：代码树右键菜单「用外部编辑器打开」）——①「好像没有用」；②「不仅仅扫描这三种，能不能扫描出来是编辑器」。

- **根因（两个叠加，缺一不会复现全部症状）**：
  1. **「点了没反应」**：旧实现在 PATH 上 `where code` 只取**首行**（Windows 上那是无扩展名的 sh 脚本，`code.cmd` 在第二行），把 spawn 不了的东西交出去；且 Node ≥18.20 的 spawn **禁止直接启动 .cmd/.bat**（CVE-2024-27980，同步抛 EINVAL），异常被 `try/catch` 吞掉后返回 false——菜单在、文案对、点了静默失败。
  2. **「进程起来了但窗口永远不出现」**（首轮修复后用户实测：有时能打开、多数不行、但有东西在启动）：spawn 选项里的 **`windowsHide: true`** 会让 Windows 在 STARTUPINFO 写入 `SW_HIDE`，Electron 系编辑器（Code.exe / Cursor / Trae）的首窗口用 `SW_SHOWDEFAULT` 启动时**继承它**——进程活着、窗口永不出现，还会留下无窗口的僵尸实例持续占用单实例管道，让后续 spawn 全部转发进黑洞。偶尔能打开 = 恰好有一个健康实例在跑，新进程把文件转交后退出。真机 A/B 矩阵：`{detached,ignore,hide}` → 0 窗口；`{detached,ignore}` / `{detached}` / `{ignore}` / `{}` → 全部出窗。**修法：编辑器 spawn 只用 `detached + stdio:'ignore'`，绝不加 `windowsHide`**（该参数只对 where/which/reg 这类控制台工具使用）。候选还写死只有 code/cursor 两家。
- **修法（主进程，不写死厂商）**：
  - 新增 `shell/editorScan.ts`：内置 **20+ 款编辑器目录**（VS Code / Insiders / VSCodium / Cursor / Windsurf / Trae / Zed / Sublime / Notepad++ / EditPlus / Emacs / Visual Studio / JetBrains 全家 / Android Studio），逐款三层解析，装了什么菜单出什么：
    1. **PATH**：`where`/`which` 的**全部**命中行（`whichCommand.ts` 改回数组）；`.exe` 直接用、`.cmd` 垫片沿目录**向上最多 3 层**找 GUI 主程序（VSCode：`<root>\bin\code.cmd` → `<root>\Code.exe`；Cursor 垫片嵌在 `resources\app\bin` 要爬 3 层）——覆盖装在 `D:\tools\...` 这类自定义目录的情况；
    2. **注册表 App Paths**（HKLM+HKCU，`shell/editorProbe.ts`）：先枚举子键，**只对基名命中目录白名单的**再查默认值（不能每个子键都发一次 reg query）；路径必须真实存在——真机验证时 VS 卸载残留的 `devenv.exe` 注册条目正是被这道 lstat 拦掉的；
    3. **安装根目录扫描**：`%LOCALAPPDATA%\Programs` / `%ProgramFiles%` 向下两层 readdir，按目录名前缀匹配（EditPlus、JetBrains 独立安装这类没进 PATH 也没进注册表的靠这层）。
  - Windows 上放行条件是**解析出真实存在的 .exe**，绝不 spawn .cmd/脚本；三层并行采集（`editorProbe.gatherScanData`，Promise.all），真机实测 345ms；每次右键现扫，装了/卸了不用重启。reg 输出按控制台代码页（GBK）解码，兼容中文安装路径。
- **修法（渲染层）**：`CodeTreePanel.vue` 右键菜单按扫描结果分项——「用 VS Code 打开 / 用 Trae 打开 / …」（`tool.openInEditorWith`），一个都没装时保留一条**置灰提示**「未检测到已安装的编辑器」（不再是无声失败）；挂载时扫一次 + 每次右键后台刷新。mock-bridge 回 VS Code + Cursor 供浏览器 dev/e2e 演示。
- **测试**：新增 `test/shell/editorScan.test.ts`（12 例：目录契约、PATH 全行遍历、垫片解析/拒绝、App Paths 命中/残留拒收、安装目录匹配/防御、层优先级、目录序稳定、全空→空数组，依赖全注入不碰真机）；E-CE-20 断言更新为分项文案 + 校验 `editorId` 通道。
- **真机验证**：本机 `D:\work\tools` 自定义目录下的 VS Code / Cursor / Trae / Zed 全部扫出并解析到真实 .exe（PATH 层），卸载残留的 Visual Studio 注册条目被正确拒收；`npm run typecheck` 双包 0 错；e2e codeExplorer 25/25。
- **不做的**：① 不做「选择编辑器」系统对话框（宁可置灰提示也不猜）；② 不做任意 exe 的「启发式识别」（exe 上没有「我是编辑器」的标记，按文件描述猜会误报，目录白名单 + 三层扫描已覆盖主流）；③ 不给自定义命令留后门（渲染层传命令 = 把 spawn 的钥匙交出去，与 CV-TRUST-02 冲突，真有需要再加主进程侧的显式设置项）；④ Trae 与 Trae CN 共用 `trae` 命令名，只出先命中的那个菜单项。

## v6.9 (修复：待办面板不再跨轮次累积旧已完成任务——新轮次起点隐藏上一轮 completed)

> 来源：2026-10-02 用户反馈（截图：任务清单标题「已完成 15 / 共 20 个」，#16~#20 是新批次，#1~#15 是上一轮做完的旧任务）——「任务列表老的结束了，但是新任务加进去了，为什么没有把老的那批任务删掉」。

- **根因（不是模型没删，也不是插件 bug，是 forge 缺了 pi TUI 的一条显示层规则）**：todo 工具来自 rpiv-todo 插件，其状态设计为「只增不自动删」（数据层保留全量是它能扛住 /reload 与 compaction 的基础），每次调用都返回包含所有已完成任务的全量快照。pi 终端不堆积，是因为它的 overlay 在**渲染层**做了收口：`agent_start` 时调 `hideCompletedTasksFromPreviousTurn()`，把上一轮完成的行从面板中过滤掉（数据还在，只是不显示；README："Completed rows stay visible for the rest of the turn, then drop at the start of the next one"）。forge TodoPanel 只做了「工具完成 → `applyTodoCompletion` 全量替换快照」，没有这条规则，插件数据层的只增不删被原样暴露给用户。面板的自动隐藏条件又是「全部 completed」，新任务一到，旧 completed 就被顶得长期可见。
- **修法（仅 forge-ui 三个文件，纯显示层，不碰插件与主进程）**：
  - `src/utils/todoPanel.ts`：`TodoSnapshot` 新增两个可选集合——`hiddenCompletedIds`（上一轮及更早完成，不再显示）与 `pendingHideCompletedIds`（本轮新完成、本轮内保持可见、下轮起点转入隐藏集），空则缺省省略（旧形状快照不受影响）。`applyTodoCompletion` 透传并修剪两个集合（任务复活 completed→pending 移出隐藏集重新显示）、把新出现的 completed 记入待隐藏集、`nextId` 回退（clear 动作）时重置（对应 overlay 的 `resetCompletedDisplayState`）；新增纯函数 `applyTodoTurnStart`（对应 `hideCompletedTasksFromPreviousTurn`）：把快照中全部 completed 并入隐藏集；`selectVisibleTasks` 在墓碑之外再过滤隐藏集中的 completed。
  - `src/composables/useSessionConversation.ts`：`onStatus` 收到 `streaming`（新轮次起点）时对当前会话快照调用 `applyTodoTurnStart`。
  - **关键细节：不能只在轮次起点滤一次**——工具每次返回的全量快照会把旧 completed 反复带回快照，隐藏集必须随快照持久并在每次 `applyTodoCompletion` 后重新生效，这也是终态兜底 `applyTerminalCleanup` 补成的 completed 能在下一轮被正确隐藏的原因（轮次起点并入的是「全部 completed」，不依赖集合成员资格）。
  - `TodoPanel.vue` 零改动：`selectVisibleTasks(snapshot)` 签名不变，标题计数与「全部完成自动收起」自动只统计可见任务。
- **新增回归用例** `packages/forge-ui/test/todoHideCompleted.test.ts`（9 例，node:test 纯函数）：用户报告场景（15 条旧 completed + 新批次 → 面板只显示新 5 条）、核心缺陷回归（同轮后续全量快照带回旧 completed 不得再显示）、本轮新完成停留到本轮结束的时序、复活重新显示、clear 重置、引用稳定性、畸形任务项防御。基线 `todoPanel.test.ts` 的 initial-replace 用例显式更新（事件中的 completed 现在记入待隐藏集，属本次行为扩展，非弱化）。
- **验证**：RED 先行（`applyTodoTurnStart` 不存在时新用例按预期失败）；GREEN 后 forge-ui 全量单测 **385/385** 通过，`vue-tsc --noEmit` 0 错。
- **不做的**：① 不真删数据——快照本就随进程消失，隐藏是纯显示层语义，与 pi TUI 一致；② 不依赖模型自觉调 `delete`/`clear` 清旧任务（工具虽有该动作，TUI 端也没赌这个）；③ 不改自动收起/折叠的交互与时长。

## v6.8 (修复：选区复制浮窗的「已复制」在鼠标停留时变成隐形的灰药丸)

> 来源：2026-09-30 用户反馈（截图：深色主题、对话区拖选后点复制）「复制点了之后看不清」。截图像素实测：药丸底 `rgb(180,181,183)`，字与勾 `rgb(198,198,203)`——两者亮度差 18/255，肉眼就是“一片灰”。

- **先量后判，根因不在配色而在 CSS 特异性**：把截图里的药丸色/字色反查回令牌，两个值都精确命中「`--foreground` @ 0.9 opacity」与「`--brand` @ 0.9 opacity」。全局 `button:hover { border-color/color: var(--brand) }` 的特异性是 **(0,1,1)**，压过 `.selection-pop-btn` 自己那条 (0,1,0)——鼠标一停在按钮上（点完复制手还搁在那儿），字色就被改写成 `--brand`。深色主题下 `--brand`≈近白、`--foreground`≈浅灰，**对比度 1.22:1**（本该 8.32:1）；浅色主题是另一种倒挂（`--brand` 压 `--foreground` 底）**1.11:1**。反馈态本身没问题，是被 hover 规则吃掉了。
- **为什么此前没被发现**：`.md-code-copy`（代码块复制）已经踩过同一个坑并修好了——它把 `color: var(--success)` 写在 `.md-code-copy.is-copied` (0,2,0) 上，刚好压过 `button:hover`；选区浮窗没写 `:hover` 字色，就没人挡。同一个全局规则，两处结局不同。
- **修法**（`packages/forge-ui/src/global.css`）：`.selection-pop-btn:hover` 里显式重申 `color: var(--background)`，让反色配对在 hover 态也成立；hover 反馈同时从 `opacity: 0.9` 换成 `background: color-mix(in oklab, var(--foreground) 90%, black)`（opacity 会连字一起压暗，且不像“可点”）。深浅两主题 hover 对比度分别回到 ~8.1:1 / ~13.6:1。
- **新增回归用例** `packages/forge-ui/e2e/selectionCopy.spec.ts`（3 例，mock-backend）：`E-SC-001` 深色 / `E-SC-002` 浅色，均拖选正文→浮窗在**常态 / hover / 「已复制」三态**断言字底对比度 ≥ 4.5:1（WCAG AA 正文），并校验剪贴板内容 = 选区原文、1.4s 后自动收起且清空选区；`E-SC-003` 非消息区（会话树）选字不弹窗。
  - **对比度不靠正则解析颜色字符串**：在页面里用 1×1 canvas 把 `getComputedStyle` 的 `color`/`background-color` 画出来读像素（canvas 的颜色解析覆盖 `oklch()` / `color-mix()`），半透明底合成到 `--background` 令牌上；解析失败（`fillStyle` 停在哨兵值）直接报错，而不是拿一个错的颜色算出一个漂亮的对比度。
  - **踩过的坑（已写进用例注释）**：首版断言“时绿时红”且回退改动后**仍然全绿**。原因是 `button` 有 `transition: color var(--transition-fast)`（120ms，且 color 在 oklab 里插值），刚 hover 完就去读 `getComputedStyle` 拿到的是**中间帧**——运气好读到过渡前的深色就过了。改成 `await pop.getAnimations({subtree:true}).map(a => a.finished)` 等过渡跑完再读，才得到稳定的真值。
  - **做过红色检查**：把 `.selection-pop-btn:hover` 改回 `opacity: 0.9` 复跑，深浅两条**均必红**（1.217 / 1.111，与截图实测 1.21 逐位一致）；改回修法后 `selectionCopy` + `codeCopy` 共 8 例（`--repeat-each=2`）全绿。
- **真机像素复核**：修法落地后在 mock 应用里按相位冻结截图（深/浅各一张），确认「已复制」为浅灰底深字 / 深底白字，勾与字都清楚。
- **契约同步**：`docs/prd/03_conversation.md` 的 CV-S13 交互与反馈新增一条——**反色配对必须在 hover 态也成立**，并写明 `(0,1,1) > (0,1,0)` 这个坑与凡是自带底色的按钮都要写 `.x, .x:hover { color }` 的口径。
- **验证**：`npm run typecheck` 四包 0 错；`npm run test`：core 473/473、ui 341/341、extensions 69/69，desktop 355/363（6 红即 v6.7 已记账的存量 `piConversationAdapter` 2 + `shellProbe` 4，与本次无关）。
- **不做的**：① 不改全局 `button:hover` 的 `--brand` 字色（它对绝大多数裸按钮正是想要的效果，改了会连带动整个应用）；② 不逐个审 30+ 个缺 `:hover` 字色的自定义按钮（`.send-btn` / `.ce-retry` / `.dlg-ai` …，多数本来就想要 brand 悬停色，真出事的只有“自带底色”那一类，浮窗是当前唯一一例）；③ 不改 CV-S13 的形态、时机与 1.4s 反馈时长。

## v6.7 (修复：自动重试期间不再弹「回复出错」系统通知——出错先挂起，宽限期后再判定)

> 来源：2026-09-30 用户反馈（附对话区截图：正文栏正显示「正在自动重试（第 1/3 次）…」）——「刚才应该是重试的时候，给我右下角弹出了一个窗口，说是 AI 回复失败的窗口，错误提示是对的，但是像这种情况，应该比如 3 次重试之后还不行再弹那个提示框，而不是第一次不行，自己还在重试的时候就弹出来」。

- **根因（不是文案问题，是事件顺序问题）**：pi 在 `message_end(stopReason=error)` 的瞬间就把轮次状态打成 `error`，**之后**才判断这个错误可不可重试——可重试就紧接着发 `auto_retry_start`（`createForgeCore` 的 `onAutoRetryStart` 随即 `setStatus('streaming')` 把状态改回进行中，对话区因此正确显示成「正在自动重试（第 1/3 次）」）。而右下角系统通知（`main.ts` 里 `conversation.statusChanged` 的监听）见到 `status==='error'` 就直接弹「回复出错」。也就是说**通知比「要不要重试」的判定更早到达**：重试中的中间失败，被当成了轮次终态。用户看到的正是「还在重试 + 先弹失败通知」的自相矛盾。
- **为什么不直接在 core 层把中间 error 压掉**：`error` 状态同时驱动会话树红点、错误横幅、`lastError` 持久化等多处语义，延迟整条链路会波及 CV-ERR-01 已定稿的错误分类/展示口径（也会拖慢真终态的反馈）。改在**通知这一层**：status 是否终态是 core 的事实，通知只需在「可能是终态」时多等一小会儿再确认。
- **修法（`packages/forge-desktop/src/notifyGate.ts`，新增）**：把原先埋在 `main.ts` 事件回调里的弹/不弹规则（前台聚焦、3s 冷却、done 紧随中断/出错、**出错宽限期**）抽成纯逻辑模块，输出决策 `notify | defer | skip(reason)`。`error` 到达时不再直接弹，而是 `defer`——挂起 1s，期间任何后续状态事件都会作废这次挂起（`auto_retry_start` 会把状态改回 `streaming`）；1s 后复问，**状态仍是 `error` 才弹**（重试耗尽 / 不可重试 = 真终态），已被 `streaming` 接管则静默跳过。窗口在这一秒里切到前台同样不弹（复问时重新判定）。
- **顺带修掉一个真 bug**：冷却/抑制判定原写作 `now - (lastToastedAt.get(id) ?? 0) < 3000`，把「从未弹过」当成时间戳 0，于是任何小于 3s 的时钟域下首个通知会被误判成「冷却内」而静默丢失。改为「以是否真的弹过为准」（`undefined` 判空），这也是把时间注入化之后单测立刻照出来的。
- **验证**：`tsc --noEmit` 0 错；新增 `test/notifyGate.test.ts` 11 例全绿（重试期间不弹 / 重试耗尽才弹 / 不可重试仍弹 / 宽限期内切前台不弹 / error 后到 done 作废挂起 / settle 幂等 / 前台不弹 / 3s 冷却 / done 紧随中断不覆盖 / 非终态不弹 / 多会话互不干扰）。`@forge/desktop` 全量 363 例 355 过 6 红，6 红逐个 stash 对拍确认**与本改动无关**（`piConversationAdapter` 2 例 + `shellProbe` 4 例，改动前后完全一致）。**未做实机验证**：需要一次真实的 provider 失败+自动重试才能看到通知时序，本次没有触发真实 5xx/429。
- **已知代价与边界**：① 真终态的失败通知晚 1s 出现（横幅早就在界面上了，不可感知）；② 宽限期是**时序兜底**而非精确信号——若 `auto_retry_start` 因极端卡顿晚于 1s 到达，仍会先弹一次；pi 侧这两个事件同属一次 agent run 的相邻事件（毫秒级），1s 余量足够。③ 不做「重试开始时也发一条右下角通知」——重试进度已经有对话区提示条 + 思考计时，再加一条只会更吵。
- **不做的**：① 不改 core 的 `error` 状态语义与 CV-ERR-01 错误分类；② 不改通知卡片的视觉/文案（`notifyToast.ts` 原样）；③ 不动对话区已有的「正在自动重试（第 N/M 次）」提示条（那条本来就对）。

## v6.6 (视觉：流式「进行中」从边框呼吸改投影呼吸——与抬升不再打架)

> 来源：2026-09-30 用户反馈（截图：深色主题、助手回复中、1m25s）「现在 AI 回复中的时候会有呼吸边框，我觉得和你现在的这个改动有点不匹配，而看不出你的悬浮效果」。先出 `prototypes/streaming-elevation-coexist-demo.html`（现状 + A 投影呼吸 / B 上缘流光 / C 收窄边框呼吸 / D 蚂蚁线 / E 琥珀呼吸 五档对比），用户选定 **A**。

- **诊断（先量再改，结论和直觉不同）**：实测流式期间**抬升并没有掉**——投影仍是完整 4 段 `--elev-2`，输入框也仍持焦点。问题出在**信号位冲突**：`.compose-box.streaming` 把 `border-color` 换成 `--foreground` 并按 35%↔85% 呼吸，深色主题下那条 1px 线实测在 `rgb(89,91,94)` ↔ `rgb(163,166,169)` 之间摆动（**亮度摆幅 1.9 倍**，盒内底色只有 `rgb(32,34,38)`），比盒内的柔和投影显眼得多——人眼先读到「一个忽明忽暗的亮框」，读不到「浮着的一层」。盒子的轮廓同时只能讲一件事：要么「受光的发丝边 + 柔和投影」（浮起来），要么「一条会呼吸的实线」（一个框）；旧实现让后者盖住了前者。
- **另一个事实：边框呼吸是冗余信号**。流式中框内有 `⠋` 转轮 + 「助手回复中，Enter 排队发送…」、框外有「助手正在思考 1m25s」计时、右下角有红色停止按钮——边框呼吸是第四个，却占用了最贵的那个位置（轮廓）。
- **令牌（`design-tokens.css`）**：新增 `--elev-2-active`（level 2 的呼吸峰值档，深浅各一套）。它与 `--elev-2` 的差别**只在环境阴影更远更深**（浅色 16px/34px → 22px/48px、α 6~7% → 10~11%；深色 16px/34px → 22px/46px、α 30/34% → 42/46%），**接触阴影保持不动**——读起来是「盒子被抬得更高」而不是「影子变黑了」，底面始终贴着页面。用令牌而不是把值写进 keyframes：以后调呼吸幅度只动一处，且深浅主题分开可调。
- **组件（`InstructionInput.vue`）**：`.compose-box.streaming` 不再碰 `border-color`（那行 `border-color: var(--foreground)` 删除，边框回到基础的发丝边），改为 `animation: stream-breathe 2.4s ease-in-out infinite`，`@keyframes stream-breathe` 改成在 `--elev-2` ↔ `--elev-2-active` 之间摆 `box-shadow`。
  - **关键细节：呼吸的起始档就是 `--elev-2`，不是从 `--elev-1` 起**。用户刚在聚焦态（`--elev-2`）按的 Enter，若动画从 `--elev-1` 起，盒子会先**塌下去再浮起来**；现在是在已抬起的档位上继续加深。靠 CSS 层叠顺序保证：`.compose-box.streaming` 与 `.compose-box:focus-within` 特异性相同（0,2,0）且排在后面，动画的 `box-shadow` 覆盖聚焦态那条。
  - 呼吸时长 2s → **2.4s** 并有意偏慢：这是「在工作」的氛围提示，不是加载进度，不该催人。
  - 删掉 `.compose-box.streaming:focus-within { animation: … }`（它存在的唯一理由是让聚焦时用另一套边框色呼吸，现在两个状态同一套动画，这条例外没有意义了）。
  - 新增 `.compose-box.streaming.dragover { animation: none; box-shadow: var(--elev-2); }`：转发中把文件拖进输入框时两个状态会同时命中，动画会持续覆盖拖拽态的 `box-shadow`，明确落回静态抬升档。
- **验证**：`vue-tsc` 0 错。真实应用（vite dev + mock 后端）按相位冻结实测：**边框在静息 / 聚焦 / 流式三态完全恒定**（浅色都是 `oklch(0.92 0.004 286.32)`、深色都是 `rgba(255,255,255,0.114)`）；流式 0% 相位阴影 = `--elev-2`（16px/34px），50% 相位 = 峰值（22px/48px）。
  - 新增 `e2e/composeElevation.spec.ts`（4 例，浅/深主题各 2 条）：`ELEV-E2E-001` 断言边框色三态恒定；`ELEV-E2E-002` 断言抬升档位（静息环境段 <14px、聚焦 ≥14px、流式挂着 `stream-breathe` 且环境段 ≥33px）。
  - **这两条用例做过红色检查**：按文件粒度 `git stash` 回退 `InstructionInput.vue` + `design-tokens.css` 后复跑 **4/4 全红**（`聚焦不应改边框色` 与 `静息态必须有抬升投影` 两条断言分别命中旧行为），确认它们真能拦住这次的回归。
  - **踩过的坑（已写进用例注释）**：首版断言对 `boxShadow` 字符串做子串匹配（`toContain('16px')`），流式期间 animation 正在跑、`getComputedStyle` 返回的是**插值中间帧**（实测读到 `0px 6.25903px 16.5181px`），必然随机失败。改成解析每层第三个长度值取最大模糊半径，再按档位区间判定——与动画相位无关。
- **文档/原型同步**：`prototypes/index.html`（令牌 + `.compose-box.streaming` 改投影呼吸）、新增 `prototypes/streaming-elevation-coexist-demo.html`（五档对比 + 已选定方案的三相位对照）。`prototypes/streaming-border-options.html`（更早那版边框方案对比）**保留原样不动**：它是历史决策记录，改它等于篡改当时的候选集。
- **不做的**：① 不改「进行中」的其它三个信号（框内转轮文案、框外思考计时、停止按钮）——它们各占各的位置，本次只回收被边框占掉的那个；② 不引入上缘流光 / 蚂蚁线 / 新色相（B/D/E 三档未采纳，见 demo）；③ 不给呼吸加峰值上限之外的额外动画（`prefers-reduced-motion` 下由既有全局口径关掉，与项目其它动效一致）。

## v6.5 (视觉：会话状态点家族——运行中盲文点阵扫过／已完成对勾／出错方块叹号 + 图标落进行内留白修文字跳动)

> 来源：2026-09-30 用户反馈——「换一下进行中的状态点的显示，很多是转圈，有的是截图右侧那种动画」，并附 VS Code 资源管理器加载指示器截图作参照；另一条独立诉求「现在有点的时候文字会被后移，字应该对齐，状态图标等在前面」；随后追加两条——「图标应该往左移动」（对齐对了但图标吃了标题宽度）、「浅色主题是不是该用黑光扫」。原型：`prototypes/session-status-spinner.html`（占位策略 + 五款动画）、`prototypes/status-sweep-theme.html`（扫过色的四款浅/深方案，**待用户确认后再落地**）。

- **跳动根因（不是「间距不对」）**：状态点用 `v-if="shouldShowDot(session)"` **条件挂载**。状态点一出现就把标题整体右推 14px（8px 圆点 + 6px gap），消失时又推回去；且状态流转（运行→完成→空闲）本身就会让行内内容横向抖一下，扫视一列时每行起点都不同。
- **对齐改法（两轮才对）**：① 先做「恒占位」——去掉 `v-if`，无状态时只加 `is-blank` 档做 `visibility: hidden`，`title` 改为 `shouldShowDot(session) ? statusTitle(session) : ''`（否则每行空闲会话都弹「空闲」tooltip）。标题左边界确实齐了，但**图标作为 inline 槽位把整列标题右推了 18px**，用户截图红框标的就是这条被占掉的留白。② 最终改为**图标彻底退出 flex 流**、绝对定位进行内 24px 留白：`.tree-session > .tree-session-status-dot { position: absolute; left: 8px; top: 50%; transform: translateY(-50%); }`（选择器带 `>` + 类是为了压过 `.tree-session > *` 那条 `position: relative; z-index: 1`）。标题回到**改动前的原始 24px 起始位置**，且因为不占任何宽度，对齐不再依赖「占位不塌陷」这个前提。
- **动画选型（`ProjectTree.vue`）**：`.tone-streaming` 由「8px 黄点 + 1.6s 光晕脉冲（`tree-status-pulse`）」换成 **2×4 盲文点阵斜向波**——即用户截图里 VS Code 资源管理器那种 8 个小点依次点亮。选中它的理由：光晕脉冲在 1.6s 周期里弱到**分不清是在动还是只是亮着**；点阵不依赖颜色就能读出「进行中」，密度上又比 SVG 圆弧安静，密集列表里远看只是一列小方块在闪。
- **节奏（首版被判太快后调）**：周期 **1.6s**、相邻点波峰步进 **0.15s**（右列再延后半拍 75ms → 波形自左上向右下扫过，全程 0.525s）。首版是 1.05s/0.09s，实测 8 个点的波峰糊成一片闪烁、看不出方向，只觉得「在跳」；放缓后能看清单个点走完对角线。关键帧同步放缓（18% 达峰、45% 回落到底亮度）。
- **槽位几何**：圆点 8px → **12×12 框**（`display: grid` + `place-content: center`），给点阵留余量。点阵尺寸 2.3px、间隙 0.85px——`4×2.3 + 3×0.85 = 11.75px`，**必须刚好收进 12px**，首版按 2.4/1.26px 排出来是 13.38px、溢出槽位 1.4px（6× 截图才看出来）。出错红点 / 完成绿点下沉为 `::after`（`grid-area: 1/1/span 4/span 2` 居中），tone 色不变、仍是静态常显。
- **两个顺手的收敛**：① 点阵 `<i>` 默认 `display: none`、只在 `.tone-streaming` 下显形，否则 error/done 行的 8 个黄点会从红色实心点后面透出来；② `is-blank i { display: none }`——空闲行连动画一起停，20 行 idle 不会白白跑 160 条 keyframes。③ `prefers-reduced-motion: reduce` 下退回静态黄点（`animation: none` + 显示 `::after`），语义不丢。
- **验证**：`vue-tsc` 0 错，单测全绿。Playwright 临时 spec 实测（同一屏 streaming/error/done/idle/已读 done 五种行）：标题 `left` <b>全部 = 36</b>（= 改动前的原始位置，图标不吃标题宽度），图标列固定 x=20；字形实测 `.dot-check` 12×12、<code>color: oklch(0.55 0.16 145)</code>（深色下自动切 <code>oklch(0.72 0.14 145)</code>）、<code>.dot-bang</code> 11×11 且 <code>ink #fff / bg oklch(0.577 0.245 27.325)</code>（深色下 bg 自动切 <code>oklch(0.7 0.18 27.325)</code>）；点阵 8 个 <code>&lt;i&gt;</code>、<code>animation: 1.6s@0s…0.525s</code>、<code>display: grid</code>，而 idle 行为 <code>none</code>（不跑空动画）；5× 放大截图两主题各一帧 + 三个图标各一张，字形无畸变。`session.spec.ts` + `lastErrorRestore.spec.ts` 11 过 1 红，唯一红的 `SESSION-E2E-001` 按文件粒度 `git stash` 回退本文改动后复跑**同样红**= 改动前既有。
- **扫过色分主题（v6.5 追加，用户选定 C 档）**：点阵原先两主题同色（静息 = `--warning` 16%、扫过 = 满 `--warning`）。**根因**：`thinking-shimmer` 那套扫光能成立是因为「**亮带扫过深色文字**」，靠比底色更亮被看见，所以它在白底上照样成立；点阵是「亮点在**浅色点阵**上移动」，浅色主题下静息点几乎没画出来、扫过点也只是同色相深一档，**方向感消失**。结论：扫过元素必须相对**本地底色**有最大反差 → 浅底改用暗点扫、深底仍用亮点扫。
  - **令牌（`design-tokens.css`）**：新增 `--status-run-rest`（静息点）/ `--status-run-peak`（扫过点），**深浅两套值分开写**（同 `--shade` / `--elev-*` 先例）：浅色 `rest oklch(0.93 0.045 85)` / `peak oklch(0.46 0.11 62)`（**深琥珀棕，不用纯墨**——保住「暖色 = 运行中」这层语义），深色 `rest oklch(0.42 0.07 85)` / `peak oklch(0.85 0.14 92)`。
  - **组件（`ProjectTree.vue`）**：`i` 的底色从 `background: var(--warning)` + **opacity 呼吸**改为 `background-color: var(--status-run-rest)`，峰值关键帧切到 `var(--status-run-peak)`——`background-color` 在两枚令牌解析出的实色之间插值，浅色主题里就是**一个暗点在淡点阵上走**（同色相的「深一档」在白底上拉不开）。`transform: scale` 保留。`prefers-reduced-motion` 下的静态点也改取 `--status-run-peak`（两主题下都醒目）。
  - **四个备选**（`prototypes/status-sweep-theme.html`，只换这两个色、节奏几何全不动）：A 现方案 / B 反相扫·深墨（用户提议）/ **C 反相扫·深琥珀棕（采用）** / D 反相扫 + 静息点去色。
- **白底看不清「哪个在跑」——静息点提亮 + 三档尾巴（v6.5 第四轮，用户选 C）**：用户截图指出白底上「轮到全白的时候就看不到哪个在跑」。**根因不是扫得不够明显，是静息点几乎不存在**：浅色静息色 <code>oklch(0.93 0.045 85)</code> = <code>rgb(246,230,199)</code>，**对白底只有 1.23:1**（深色主题的 <code>rgb(95,74,26)</code> 对深底 <code>rgb(25,25,29)</code> 也只有 2.07:1）——8 个点里能看见的只有正在扫过的那 2~3 个，**2×4 的网格结构整个丢了**。
  - **令牌（<code>design-tokens.css</code>）**：<code>--status-run-rest</code> 浅 <code>0.93 0.045 85</code> → <code>0.80 0.05 85</code>（1.87:1）、深 <code>0.42 0.07 85</code> → <code>0.50 0.08 85</code>（2.89:1）；**新增 <code>--status-run-mid</code>**（尾巴档）浅 <code>0.64 0.10 70</code>（3.42:1）、深 <code>0.65 0.12 88</code>（5.39:1）。
  - **组件（<code>ProjectTree.vue</code>）</b>：<code>@keyframes tree-status-wave</code> 从两档改<b>三档</b>——<code>0%/46%/100%</code> → rest、<code>14%</code> → peak（急升）、<code>32%</code> → mid（缓落），<code>transform: scale</code> 同步走 <code>0.72 → 1 → 0.88</code>。<b>多出来的中间档就是尾巴</b>：点冲到最深后不是瞬间消失，而是经 mid 滑回静息，于是「一个暗点拖着一条淡尾从左上走到右下」——<b>方向感来自尾巴，不来自闪烁</b>。尾巴跨度 0.32×1.6s = 0.51s ≈ 3 个点距（0.15s 步进），所以场上同时只有「一个头 + 一条尾」。点阵几何、1.6s 周期、0.15s 步进、12px 槽位全部不动。
  - <b>刻意的取舍</b>：C 档静息只有 1.87:1，<b>比只提亮的 B 档（2.22:1）还低</b>——静息点只负责「网格存在」不负责「在动」，真正承载动的是 3.42 → 7.37 那一段。峰值/静息的<b>落差</b>才是方向感来源。
  - **四帧钉帧的坑（首版钉帧没生效）</b>：把负 <code>animation-delay</code> 写在容器上（<code>.frozen i</code>）会被 <code>.mtx i:nth-child(n)</code> 的更高特异性（0,2,1 > 0,1,1）盖掉，<b>四帧结果完全一样</b>，差点误判成「A 已经清楚了」。修法：逐 <code>nth-child</code> 写 <code>calc(自身错峰 + var(--d))</code>，且必须配 <code>animation-play-state: paused</code>。<b>凡「在静态图上看动画」都要先确认帧真的错开了。</b>
  - **验证口径</b>：<code>getComputedStyle</code> 实测两主题令牌均取到新值；<code>getAnimations()[0].effect.getKeyframes()</code> 返回 <b>5 帧</b>且色/缩放与设计一致（浅：<code>0→rest@0.72 / 0.14→peak@1 / 0.32→mid@0.88 / 0.46→rest@0.72</code>）；5× 钉帧截图两主题各 4 相位逐帧确认「8 点全部可见 + 一个头 + 一条尾」。
  - **其他三个备选</b>（<code>prototypes/status-run-contrast.html</code>）：A 现状 / B 只提亮静息点（最小改动，仍两档跳变）/ **C 提亮 + 三档尾巴（采用）** / D 静息点去色成中性灰（形状说话，不依赖色相，红绿色觉异常也跟得上）。
- **已完成 / 出错 改字形（v6.5 第三轮，用户圈定）**：原先两者都是 8px 实心点，与运行中的点阵**不同形**，看不出同源。`prototypes/status-done-error.html` 出了 5+5 款后用户选定 **done = 绿色对勾 ✓ / error = 红色方块感叹号 !**，统一信号从「形状」换成「<b>位置恒定 + 只有运行中在动</b>」。
  - **为什么字形反而更合理**：运行中是<b>持续态</b>，已完成/出错是<b>离散事件</b>——持续态值得一个会动的形态；离散事件用 1× 就认得出的字形更划算（点阵每点只有 2.3px，1× 看过去就是一团糊）。
  - **图形必须是现成图标，不能手搓**：我前两版用「两条 <code>div</code> 转 ±45°」画勾，第一版两臂 <code>left/top</code> 摆反出来是「人」字（开口朝下），第二版形状对了但<b>接缝对不齐</b>——拼两条独立线段没有交点约束，缩到 1× 就是个歪的。**最终直接用仓库现成的 Feather 路径** <code>viewBox="0 0 24 24"</code> + <code>&lt;polyline points="20 6 9 17 4 12"/&gt;</code>（<code>SettingsPanel</code> 的 <code>.swatch-check</code> / <code>GitCommitDialog</code> / <code>MessageCard</code> / <code>HtmlCanvasBlock</code> / <code>selectionPopover.ts</code> 五处同款），<code>stroke-width="3"</code>（24 网格缩到 12px 时 2 偏细）。矢量路径转角是同一点，天然闭合，不用算。
  - **实现（<code>ProjectTree.vue</code>）**：槽位从 <code>display: grid</code> 改回 <code>flex</code> 居中（点阵缩进 <code>.dot-matrix</code> 子元素），<code>::after</code>（原画 8px 实心点）<b>只留给 <code>prefers-reduced-motion</code> 降级</b>。新增 <code>.dot-check</code>（12px，<code>color: var(--success)</code> + <code>currentColor</code>，主题自动跟随）与 <code>.dot-bang</code>（11px 圆角方块 + CSS 底板 / SVG 描边的 <code>!</code>）。<b>不新增任何令牌</b>。
  - **白赚**：字形方案没有一次性动画 → <b>不需要给状态图标加 <code>:key</code> 强制重挂载</b>（原方案里唯一有实现成本的那处消失）。
  - **判定逻辑一行未动</b>：done 仍只在未读（<code>doneReadAt == null</code>）时显示、error 常显、idle 不显示但占位、<code>title</code> 原样。
- **流程纠偏（用户明确提出）**：本轮先写了原型、紧接着就把 `ProjectTree.vue` 改掉了，等于没给选择余地。以后**画 demo 与改代码必须分开**：要么只出原型停下等确认，要么直接实现，不能并行。已写入长期记忆。
- **不做的**：① 不动 `SubagentTabBar.vue` / `SubagentResultView.vue` / `ConversationHistoryPopover.vue` 的状态点（它们本来就是恒占位/已有独立动画，本轮不顺带统一，避免扩大回归面）；② 不用 `prefers-reduced-motion` 之外的机制做动效降级；③ 不动状态语义与判定逻辑（`shouldShowDot` 的 done 未读规则原样保留）；④ 不用 `div` 转角手搓图标——仓库已有成体系的 Feather 内联 SVG 口径，一律复用。

## v6.4 (视觉：输入框抬升层级——去掉焦点边框变色，改「浮起来」)

> 来源：2026-09-30 用户反馈——自截图与 DeepSeek 输入框对比「我们（图1）比较平，图2 会有悬浮感」，并附一条明确指令「输入框的鼠标焦点边框变色也去掉」。先出 `prototypes/compose-box-elevation-demo.html`（A 现状 / B 轻 / C 中 / D 强四档 + E 底色分层）与 `prototypes/compose-box-elevation-design.html`（设计规格稿：抬升层级模型 / 现状拆解 / 前后对比 / 细节放大 / 令牌与改动点），用户圈定 **C 档**。

- **根因（拆信号，不是「缺个阴影」）**：`.compose-box` 是 `background: var(--background)` + `border: 1px solid var(--input)`。浅色主题下 `--background` 是纯白，**框底与页面底同色**，盒子只剩一圈 1px 灰线——读起来是「画在页面上的矩形」而不是「浮着的一层」。真正缺的是一套**抬升层级**：弹窗/浮层/队列面板都有 `--shadow-*`，唯独**常驻**的输入框是零抬升。四个信号里现有实现只有「发丝边」一个，且 `transition` 里写了 `box-shadow` 却从来没有值（写了不生效的空转）。
- **令牌（`packages/forge-ui/src/design-tokens.css`）**：投影段新增 `--shade`（投影色相：浅色 `22 24 29` 冷灰——纯黑投影在白底上发脏；深色 `0 0 0`）、`--elev-1`（常驻控件静息态，两层柔光 + `inset 0 1px 0` 上缘高光）、`--elev-2`（焦点面板，四段：接触 + 过渡 + 环境 + 上缘高光）。**深浅两套值必须分开写**：浅色靠底色差制造深度、深色底本身已有层次只能靠投影变黑；受光白线浅色 70%、深色压到 6%（70% 在深底上是一根发光条）。浮层继续沿用 `--shadow-*`，不合并。
- **组件（`InstructionInput.vue`）**：`.compose-box` 改 `background: var(--card)` + `box-shadow: var(--elev-1)`（深色下 `--card` 0.243 比 `--background` 0.215 **亮**一档，方向一致，跨主题都是「盒比页面亮」）。
  - **焦点边框变色按要求去掉**：`.compose-box:focus-within` 的 `border-color: var(--brand)` 删除，改 `box-shadow: var(--elev-2)`；文件末尾那段 `<style>` 全局覆盖（`[data-theme='dark']` 压到 40% brand 的补丁）整个删除——它专为压暗这条边框而写，边框不改色后失去意义。旧实现的问题不止「突兀」：`--brand` 浅色是深灰、深色是近白，**同一语义跨主题亮度方向相反**，边框一变就像闪了一下；而且它和 `.dragover`（边框品牌色 + 底色提示）**撞语义**——拖拽和聚焦用同一个信号。
  - `.streaming:focus-within` 同样去掉 `border-color: var(--brand)`，只保留 `stream-breathe` 呼吸动画（底边颜色由呼吸表达），原先与之配对的 `@keyframes stream-breathe-focus`（品牌色呼吸）随之删除，不再需要第二套关键帧。
  - `.dragover` 的底色基色从 `var(--background)` 改 `var(--card)`——否则拖拽态会把盒子的抬升底色抹掉，变成比页面还暗的一块，和静息态接不上。
- **同材质延伸件（`TodoPanel.vue` / `AskUserQuestionPanel.vue`）**：两个面板底边塞在输入框背后（-10px 负 margin）做「一体延伸」，若仍留 `--background` 就会**面板贴着、框浮着**，接缝处一道色差断层；同步改 `background: var(--card)` + `box-shadow: var(--elev-1)`（面板的抬升投影落在自己的上缘、被输入框盖住，延伸感不变）。
- **验证**：`vue-tsc` 0 错；`forge-ui` 单测 337/337 全绿。vite dev + mock 后端实测（脚本采 `getComputedStyle` + 像素采样）：浅色静息 `--elev-1` / 聚焦 `--elev-2` / 边框两态**恒为** `oklch(0.92 0.004 286.32)`（不再变色）；深色静息 `inset 0 1px 0 rgba(255,255,255,0.06)` + `rgba(0,0,0,0.28)` 系、聚焦升到四段；盒内/页底像素浅色 `#ffffff` vs `#f7f7f7`（会话区本就带渐变，底色差天然存在，悬浮感成立）、深色 `rgb(32,34,38)` vs `rgb(26,28,32)`；投影落点 `#f9f9f9`（框下 4px）/ `rgb(23,24,27)`（深色）。Todo 面板 + 输入框接缝截图确认同材质无断层。
  - **E2E（`todoPanel`/`queue`/`session`/`thinkingLevel`/`askUserQuestion`/`contentWidth` 六条 spec，43 例）**：41 过 2 红，两条红线**均已按文件粒度 `git stash` 回退本文改动后复跑确认为改动前既有**——① `todoPanel` `TSC-E2E-009b`（hero-mode 下面板头部与 textarea 重叠，回退后同样红）；② `session` `SESSION-E2E-001`（草稿态首条消息未创建会话，回退后同样红）。`queue QC-002` 在批量跑时曾闪过一次红，单独跑 + 全 spec 复跑均过（`6 passed`），判定为批量时序抖动、非本次回归。
  - **仓库并发编辑提示**：定位 `SESSION-E2E-001` 过程中发现 `packages/forge-ui/src/components/ProjectTree.vue` 在本轮工作期间（09:56）被**本次改动之外**的编辑改过（会话状态点改常驻 + `is-blank` 档 + 内部 `<i>` 元素，114 行），不属于本次改动；上面那条基线结论是在**保留该外部改动**的前提下取得的（= HEAD + 他人的 ProjectTree 改动），结论不受影响。
  - `todoPanel.spec.ts` 的「同材质」断言按新契约改写：旧断言是「聚焦时输入框边框加深、面板不动（两色必须不同）」，现改为「边框色两态**一致**（焦点不换边框色）+ 聚焦时输入框投影比面板更重」——沿用旧断言会与用户本次的明确要求直接冲突。
  - `.compose-input:focus` 补写 `border-color: transparent`：`global.css` 有一条 `textarea:focus { border: 1px solid var(--brand); box-shadow: 0 0 0 3px … }`，内圈原本靠 scoped 特异性隐式压住；把契约写成显式属性后，将来动全局规则不会穿透到输入框内圈。
- **文档/原型同步**：`prototypes/index.html`（令牌 + `.compose-box` 静息/聚焦 + `.dragover`）、`prototypes/ask-user-question-prototype.html`（同款，深色底用 `color-mix` 提亮而**不是**该原型的 `--card`——那里 `--card` 0.22 比 `--background` 0.26 暗，直接套会变成「凹坑」）、新增 `prototypes/compose-box-elevation-demo.html`（四档对比）与 `prototypes/compose-box-elevation-design.html`（设计规格稿）。
- **不做的**：① 不改几何——圆角 16px、`padding: 12px 14px 58px`、底部操作条绝对定位、上边沿拖拽带、斜杠/@ 浮窗位置全部不动（与「平不平」无关，一起动只扩大回归面）；② **不改会话区底色**（设计稿里的方案 E：浅色会话区 `#f6f6f7`）。实测会话区本就带 `App.vue` 的壳层渐变（左侧采样 `#f7f7f7`），底色差已经存在，无需再压一档；深色主题更是不能压（`--card` 已比 `--background` 亮，再压会抵掉方向）；③ 不把 `--elev-*` 合并进 `--shadow-*`（语义不同：前者是「常驻控件受光抬升」，后者是「浮层离地」）；④ 不引入 `--elev-band` 令牌（方案 E 未采纳，留一个没人用的令牌不如不留）。

## v6.3.1 (修复：侧栏「项目/任务」分段胶囊被拉长变形)

> 来源：2026-09-30 用户反馈截图——侧栏顶部「项目」胶囊右侧多出一截、成了被拉长的椭圆（对照图才是应有的贴合形态）。

- **根因（Playwright 实测复现，非推测）**：选中态胶囊几何是 JS 按 active 按钮 `offsetLeft/offsetWidth` 实测写进 `--pill-l/--pill-r` 的（CSS 的 `right: calc(50% + 1px)` 兜底只在两键等宽时正确），两处踩空：
  1. **侧栏折叠/展开时按被压扁的盒子实测**（用户截图这一处）：`.sidebar` 的折叠是 `transition: width`，展开那一 tick `.view-seg` 被 flex 压到 min-content（分段开关 94→70px、按钮 44→32px），`sidebarCollapsed` 的 watch 恰在此刻测出 `--pill-r = 70-2-32 = 36px`；过渡结束后盒子回到 94/44，胶囊宽度却成了 `94-2-36 = 56px`（应为 44px）——**永久多出 12px**，与用户截图里「项目」右侧那截完全对上（`git stash` 回退本文改动复跑：实测 `Received: 12`）。
  2. **首贴静默落空**（同源坑，中文恰好看不出来）：`.view-seg` 挂在 `v-if="formalUiReady"` 里，`onMounted` 的 `nextTick` 早于它挂载（`viewSegEl` 还是 null，函数第一步就 return）。中文两键等宽，CSS 兜底几何恰好正确；英文 `Projects`(62px)/`Tasks`(47px) 不等宽，首帧胶囊比按钮窄 **7.48px**，要等用户切一次视角才归位。
- **实现（`packages/forge-ui/src/App.vue`）**：几何改由 `ResizeObserver(viewSegEl)` 驱动——observe 时先补首贴、之后盒子每变一次就按**实际几何**重贴，两个洞同时收敛（第 1 个不再读到过渡中的中间态，第 2 个不再依赖 onMounted 时机）。RO 回调走 `moveViewPill(false)` 新增的 no-anim 分支（`.view-seg.no-anim::before { transition: none }`，与 `.is-task` 同特异性故必须排在它之后）：容器自身在改尺寸时胶囊逐帧贴着按钮走、不播水滴，也不会「自己乱滑」。`watch([treeView, activeLocale])` 保留显式重贴（切视角时两键宽度互换、开关整体盒子不变，RO 看不见），`sidebarCollapsed` 从依赖里去掉（盒子变化已由 RO 覆盖）；`onMounted` 里那句测不到元素的 `nextTick(moveViewPill)` 删除，`onUnmounted` 里 disconnect。
- **验证**：`session.spec.ts` 新增两条回归用例（先 RED 后 GREEN，回退 RO 后均必失败）——`SESSION-E2E-009`（E-SM-009：首贴 + 切视角 + 折叠展开，回退后 `Received: 12`）、`SESSION-E2E-010`（E-SM-010：en-US 英文首帧，回退后 `Received: 7.4844`）；断言口径 = 胶囊 `::before` 的 left/width 与 active 按钮 `offsetLeft/offsetWidth` 误差 ≤1px，用 `expect.poll` 等水滴/宽度过渡落位（避免在过渡途中的巧合几何上误判——首版用例就栽在这里，加上「等侧栏降到 0 / 开关回到原宽」两步才真正 RED）。forge-ui 单测 337/337、`vue-tsc` 0 错；全量 e2e 155 例：138 过 / 17 红，红线全部为改动前既有（`git stash` 回退本文改动后复跑抽样同样红：canvasCard 2、subagent 4、branchBadge 3、mw-restore 2、session E2E-001、conversationHistoryLocate 1、updater 1，以及 3 个临时 repro/probe spec），本改动零回归。
- **不做的**：不给 `.view-seg` 加 `flex: none` 挡收缩——那会改掉侧栏折叠动画里分段开关被收缩/裁剪的观感，本次只修几何、不动动画；不把水滴过渡从 `left/right` 改成 `width` 动画。
- **文档同步**：`prd/02_session_management.md`（SM-S06 交互与反馈：补「胶囊几何按 active 按钮实测、开关自身尺寸一变就必须重贴」口径）、`test/02_session/e2e.md`（新增 E-SM-009/E-SM-010 + 覆盖汇总两行）、`test/02_session/coverage-matrix.md`（两行）。

## v6.3 (修复：画布卡片流式期间一直闪、闪的时候看见源码——判决分「流式/终态」两档)

> 来源：2026-09-30 用户反馈「在画图的时候会一直闪，闪的时候会看到下面的代码，之前没有过」+ 截图（卡片停在骨架「正在绘制图示…」）。回归点是 `ee26b46`：它把流式骨架的口径从「围栏没闭合就一律骨架」改成「判出 prose/code 就提前出终态」（`showSkeleton = blocked && (undecided || html)`），但 `judgeCanvasSource` 那套判据是按**完整源码**设计的，半截源码上会抖。

- **成因（两个，都是「半截标签被当成正文内容」）**：判据里 `stripTagsToText` / `longestTextRun` 只吃完整的 `<...>`，没写完的 `<div style=...` 会整段留在文本里：① 属性里的 `=` 命中 `looksLikeCodeCanvas` 的赋值号 → 判 `code` → 骨架提前塌成**代码块**（用户看见满屏源码）；② 长内联样式的属性值被算成「最长文本片段」→ 命中 `PROSE_LONG_RUN` → 判 `prose` → 骨架塌成正文，标签一闭合片段消失又变回 `html`。150ms 一次（`STREAM_RENDER_INTERVAL_MS`）的重渲染下就是「骨架 ↔ 代码/正文」来回翻面。真机实测：622 字符的 edu 目录结构图在 22 个节流点里翻了 6 次面（`code@24 → skeleton@120 → prose@360 → skeleton@384 → prose@504 → skeleton@528 → iframe`）。
- **判据（`packages/forge-core/src/markdown/canvasSandbox.ts`）**：入口仍是一个 `judgeCanvasSource(source, options)`（唯一口径），但口径分两档，由 `options.streaming` 选，默认 false = 终态口径与历史逐字一致（老调用点零改动）。
  - 先剪掉**末尾未闭合的标签片段**（`TRAILING_PARTIAL_TAG_RE = /<[a-zA-Z!/][^>]*$/`）再算内容——这是两个成因的共同根；`if (a < b)` 这类比较运算符（`<` 后是空格/数字）不误伤，带标签内容上的比较运算符另有单测钉住。
  - 流式档只放行**单调**判据：无完整标签时才允许提前出终态（真源码/字符画 → `code`，够长的纯文字 → `prose`，其余 → `undecided`）；有完整标签时只认「长句铁证」（`≥ PROSE_LONG_RUN`，文本只增不减，撤了不会回翻），薄壳那条**占比**判据天生非单调（标签进来占比掉、文字进来占比升）留到闭合后判一次。
  - 空态归终态：流式中途空源码给 `undecided`（挂骨架），不再在开栏那一帧闪一次「画布没有内容」。
  - 终态档把 `looksLikeProseCanvas` 的前哨抽成 `proseShellText`（`<canvas` 否决 / `looksLikeHtmlCanvas` / svg-img 否决 / 最小可见文本），两档共用同一份——任何一边单独加否决条件都会变成「中途判 A、闭合判 B」的翻面。
- **调用点（`packages/forge-ui/src/components/HtmlCanvasBlock.vue`）**：`verdict` 改读 `judgeCanvasSource(source, { streaming: props.blocked === true })`；`showSkeleton` / 模板分支一律不动（`blocked` 仍由 MessageCard 的 `segments` 在「末围栏未闭合 + 流式中」时置位）。
- **验证**：forge-core 单测 461→469（新增 8 例流式口径：半截标签不落代码块 / 长内联样式全程待在骨架族 / 纯文字仍提前出正文且不回翻 / 无标签源码仍 `code` / 开栏空态只给 `undecided` / 半截 `<canvas` / 比较运算符不误伤 / 薄壳包长句提前出正文且不回翻，其中「长内联样式全程待在骨架族」按 1 字符粒度走完全部前缀）。E2E `canvasCard.spec.ts` 10/10：新增 `E-CA-010`（逐帧 rAF 采样，断言整段流式只出现 `skeleton`、收尾才 `iframe`，任何一帧出现 `PROSE/CODE/EMPTY` 即失败）。四包 typecheck 0 错；`forge-core` 469/469、`forge-ui` 337/337、`forge-extensions` 69/69 全绿。
- **顺带修掉一个一直红的 P0**：`E-CA-003`（「流式中途是骨架蒙版」）改前用 `seedHistory` 喂半截围栏，而 `blocked` 只在**真流式**期间成立（历史/取消的未闭合围栏按设计直接出半成品，否则骨架永远转圈，见 MessageCard 注释），所以它自 `ead000a` 起就没测到过骨架、长期红（`git stash` 回退本次改动后复跑确认：同样红）。现改为真流式驱动（`seedSendScript` + 补一条 delta 闭栏），零跳变断言保留。
- **不做的**：不改骨架/终态的高度与视觉（`CANVAS_DEFAULT_HEIGHT` 不动，闭合零跳变是本来的口径）；不把 `<canvas>` 元素改回 iframe（沙箱禁脚本，它必然是死的，`code` 降级是唯一不丢信息的落点）；不给流式档加「薄壳占比」判据——那是非单调的根源，宁可让带标签的文字壳在闭合那一刻出正文（一次翻面），也不要流式期间一直闪。

## v6.5 (修复：代码纸一个字符都选不中——只读不等于不能复制)

> 来源：2026-10 用户需求「编辑器希望能进行选择复制，参考我们对话框的那个选择复制功能」。对话区早就有 CV-S13 选区复制浮窗，但代码纸完全选不中。

- **根因不是没做，而是全站默认不可选**：`global.css` 的 `body` 是 `user-select: none`（拖标题栏/拖边框不要误选文字），全仓只有 `MessageCard` 用 `user-select: text` 开了**对话区那一个口**；代码查看器从来没开过，于是 `.cv-pre` 一个字符都选不中。修：`.cv-pre` 显式 `user-select: text`。
- **行号不进剪贴板**：`.cv-ln` 保持 `user-select: none`，浏览器会把不可选内容从选区里剔掉——实测选区 3 行得到 `"# forge\nEle"`，既无行号也无制表符拼接。副作用（写进 PRD）：**不能从行号栏起手拖选**，那正是「行号不可选」换来的干净复制。
- **浮窗触发区域改成清单**（`selectionPopover.ts` 的 `SELECTABLE_REGIONS = ['.msg', '.cv-pre']`）：原先锚点判定写死 `.msg`。刻意不是“页面里任何文本”——终端由 xterm 自管复制、画布 iframe 事件不回传，而签条/面包屑/按钮选中后弹「复制文本」只会让人意外。`E-CE-25` 钉住签条不弹。
- **一个看起来像 bug 但不是的**：剪贴板里是 `"# forge\r\nEle"` 而选区是 `"\n"`。Windows 剪贴板是 CRLF 文本格式，`navigator.clipboard.writeText` 会归一（对话区复制同款，VSCode 粘贴时按文件 EOL 再归一）。E2E 比对前先归一行尾，注释写明「别去修它」。
- **验证**：新增 `E-CE-24`（跨 3 行拖选 → 浮窗出现 → 文案为「复制文本」→ 选区带换行且首行就是代码不是行号 → 点它写入剪贴板且归一后相等 → 1.4s 后自动收起并清空选区）、`E-CE-25`（签条不弹）。`codeExplorer.spec.ts` 25/25；对话区 `selectionCopy.spec.ts` + `codeCopy.spec.ts` 5/5（其中 `E-SC-003`「非消息区不弹浮窗」是这次改动的既有守卫，绿）。typecheck 0 错；forge-ui 385/385。

## v6.4 (新增：代码树行右键菜单 + 「用外部编辑器打开」+ 签可重排；右键菜单四处合一)

> 来源：2026-10 用户需求「目录树的文件/文件夹要加个右键菜单，打开项目所在目录；HTML 打开浏览器，跟项目树/改动文件卡复用」+ 三个确认项（tab 能不能移动 / 能不能编辑 / 目录行开哪个）。决定：tab 拖拽与快捷键两套都做；**代码纸保持只读**，写代码入口改为「用外部编辑器打开」；目录行开**它自己**（同项目树口径）；不做「右键先选中」。

- **右键菜单抽成共享组件**（`packages/forge-ui/src/components/ContextMenu.vue`）：项目树（`project-action-menu*`）、改动文件卡（`cf-context-menu*`）原有两套实现除 `min-width`（180/160）与 `.danger` 三条外**逐行相同**，连 Teleport 壳、视口钳制公式、document 监听都各写一份。第三处（代码树）再拄一遍就是三份会各自漂移的真相。组件行为与原两处逐条对齐，并修掉两处原有隐患：视口钳制改成「先按 items 数量估算落位 → 下一帧用真实 `getBoundingClientRect()` 再钳」，原实现写死 `h=184/72/38` 魔法数字，中文长文案会被顶出视口；`items` 化后 danger/confirm 文案切换从模板三元搬进 computed。`changedFiles.spec.ts` / `tooltip.spec.ts` 的 class 定位改成 `.ctx-menu*`（**行为断言一字未改**，仅换 class）。
  - **两个新坑**：①`select` 必须**先于** `close` 发出——消费方 handler 靠 `menuOpenPath`/`contextMenuPath` 拿目标，先 close 等于在 handler 跑前把目标删了，表现为「点了菜单项但 shell 没被调用」（当时连坐 5 个用例红，含 `tooltip.spec.ts` 两条——它们用菜单点「重命名」做种子，种子静默失败后续全灭）。②「滚动即关闭」是 ProjectTree 特有语义，**不能**直接搬给改动文件卡：它在可滚消息流里，而右键前浏览器/自动化会先把目标行滚进视野、那个 scroll 事件是**下一帧**才派发的（晚于 `contextmenu`），菜单会在打开后 ~16ms 被自己刚触发的 scroll 关掉。改法是给 150ms 宽限期。
- **代码树右键菜单**：树 / 过滤结果 / 最近打开三类行全挂 `@contextmenu.prevent`。文件行 = 用外部编辑器打开 + 打开所在目录（父目录），`.html/.htm` 额外多项「用浏览器打开」；目录行 = 「打开此目录」（开**它自己**）。绝对路径拼接（`absoluteFilePath` / `dirOf`）从 `ChangedFilesCard` 私有函数提到 `utils/pathSegments.ts`；扩展名判定提到 `utils/browserOpen.ts`，与主进程 `BROWSER_OPENABLE_EXT` 同口径。i18n 新增 `tool.openThisFolder` / `tool.openInEditor`。
- **「用外部编辑器打开」= 新增第三条 shell 通道**（`forge:shell:openInEditor`）。代码纸**保持只读**（无输入框、无保存、全应用无 dirty 状态），写代码的入口就是这一个菜单项。口子是三条里最紧的（延续 CV-TRUST-02 的思路）：目标必须**已存在的普通文件**（`lstat` 不跟随软链）→ **基名不得以 `-` 开头**（编辑器 CLI 会把 `--user-data-dir=…` 之类当开关而不是文件名，不拼 `--` 也不赌各家 CLI 对 `--` 的支持差异，直接拒）→ 可执行文件**只从白名单里选**（`code` → `cursor`）且先在 PATH 上解析出**绝对路径** → `spawn` 数组参数 + `detached` + `unref`，**永不 `shell: true`**。渲染层只能传一个文件路径，不能指定命令、不能传参数串。没装到 PATH 时返回 false（与另两条通道同约定：失败一律 false、不外抛、不弹选择框）。单测 `test/shell/openEditorTarget.test.ts` 9 例（含「名字里含 - 但不以 - 开头必须放行」防止规则写太宽）。
- **签可重排（拖拽 + 快捷键/菜单，共用 `useCodeExplorer.moveFile`）**：拖拽仅接主键（与中键关闭互不干涉）、4px 阈值区分点击与拖动、目标下标按指针落在哪个签的左半/右半**逐帧重算**（用累计位移会在跨过半个签宽时抖）、拖到签条左右 48px 内按深入深度**自动横向滚动**（签条本来就溢出，不自动滚就拖不到后面的签）、**拖动不切激活签**且 `pointerup` 后紧跟的 `click` 必须吞掉。快捷键 `Ctrl+Shift+PageUp/PageDown`（与 VSCode 一致；不用裸 PageUp/PageDown 以免与将来的翻页冲突）。签右键菜单给左移/右移/关闭，到边界**置 disabled 而非隐藏**。
- **验证**：`test/shell/openEditorTarget.test.ts` 8 过 1 跳（软链同款需本机权限）；`openTarget.test.ts` 仍 7 例。E2E 新增 `E-CE-20`（目录行开自己/文件行开父目录/HTML 菜单项集合/外部编辑器拿文件本体路径）、`E-CE-21`（拖拽重排 + 拖动不切激活签 + 拖后仍能关闭）、`E-CE-22`（拖到边缘自动横向滚动）、`E-CE-23`（快捷键移动 + 签菜单左移/右移/关闭 + 边界 disabled），`codeExplorer.spec.ts` 23/23；`changedFiles.spec.ts` + `tooltip.spec.ts` 10/10。四包 typecheck 0 错；forge-core 515/515、forge-ui 376/376。forge-desktop 372/382（7 红与本改动零交集：`theme` 1（`--background` 漂移）、`createPiAgentSessionFactory` 1、`shellProbe` 4——`git stash` 逐文件回退后复跑结果完全相同）。全量 Playwright 181 passed / 16 failed，失败集 = 既有基线 15 + `canvasCard E-CA-006`（带改动单文件连跑 3 次 10/10，负载下 flaky）。

## v6.2 (新增：改动文件卡右键「用浏览器打开」——HTML 原型改完一键看效果)

> 来源：2026-09-29 用户反馈「写完 `prototypes/*.html` 还要自己去文件夹双击」+ 截图（文件行右键只有「打开所在目录」）。诉求是右键里直接开浏览器看效果。

- **前端（`packages/forge-ui`）**：`ChangedFilesCard.vue` 文件行右键菜单**仅在目标是 .html/.htm 时**多出「用浏览器打开」（地球图标，排在「打开所在目录」之前），点它走文件**本体**的绝对路径而不是目录（与「打开所在目录」两条动作互不串味）；菜单视口夹紧高度估算随之分档（单 38 / 双 72px，否则贴底时菜单下半截出屏）。扩展名判定 `/\.html?$/i` 与主进程白名单同口径——但**只管菜单项显不显示**，「能不能开」由主进程裁决。i18n `tool.openInBrowser` 中英双语；`bridge.ts` / `mock-bridge.ts` 增 `shell.openInBrowser`。
- **主进程（`packages/forge-desktop`）**：新增通道 `forge:shell:openInBrowser`（preload + main handler）。**刻意不复用 `IPC_SHELL_OPEN_PATH`**——那条是 CV-TRUST-02 定下的「只放行目录」通道（Windows 上「打开」指向 .exe/.bat/.lnk 即执行，渲染层任意字符串直传 = RCE 链）。放行文件必须另开一条并把口子收窄，判定抽成纯模块 `src/shell/openTarget.ts`（可单测、不 import electron）：
  - 白名单**只有 .html/.htm**（大小写不敏感）——`.js`/`.url` 这类协议关联与全部可执行扩展在 fs 访问之前就被拒；
  - 校验**普通文件**：目录、`.html` 后缀的目录一律拒；
  - **`lstat` 而非 `stat`**：不跟随软链，指向 .exe 的 `x.html` 软链因此 `isFile()` 为 false 被拒（硬链不构成绕过：系统按**我们给的路径的扩展名**派发 handler，硬链只会被浏览器当二进制渲染，不会执行）；
  - 词法归一 `.`/`..` 中间段后再校验（渲染层拼接的路径同款问题，ShellExecuteEx 不归一会弹「找不到文件」）；
  - 不存在 / 无权限 / 非法字符 → `false`，失败原因不透给渲染层。
- **验证**：`test/shell/openTarget.test.ts` 7 例（白名单矩阵 / 归一 / 非字符串 / 6 类非白名单扩展名真实存在仍拒 / 目录 / 软链（本机 Windows 无软链权限自动 skip，判定逻辑不依赖它）/ 不存在与非法字符），6 过 1 跳；E2E `E-CV-FILES-008`（html 行两项且顺序正确、点第一项 `openInBrowser` 收到文件本体路径且 `openPath` 零调用、html 行「打开所在目录」仍给目录、非 html 行仍只有一项）——`changedFiles.spec.ts` 8/8 全绿。四包 typecheck 0 错；forge-core 461/461、forge-ui 318/318、forge-extensions 69/69 全绿；forge-desktop 344/352（6 红 + 1 跳均为本次之前已存在：`ensurePiShellPath` 环境相关 4 + PiConversationAdapter 2，与本改动零交集）。浏览器 mock 页实测菜单：地球图标项 + 原有目录项同款排版，hover 底色一致。
- **不做的**：不做「在应用内预览」（画布卡片已有 iframe 沙箱，另开一套是另一件事）；菜单不加「复制路径 / 复制文件名」等无关项；主进程不校验路径是否在项目根内——技能目录（`AppData\Roaming\Electron\agent`）这类项目根外的合法编辑目标不能被这条规则误杀。

## v6.1 (视觉：暗色主题可读性——抬底 + 压字双向收敛)

> 来源：2026-09-29 用户反馈「暗色太黑、长时间看累，对话区看着脏」，并附 GPT 的 Soft Dark / Charcoal 建议求证。诊断后经 `prototypes/dialog-readability-demo.html` 出 A 现状 / B 只抬底（GPT 思路）/ C 只去脏 / D 全改 四档对比，实测指标由脚本从真实渲染结果 `getComputedStyle` 算出（Chromium 对 `oklch()` 原样返回函数串，需自行转 sRGB），用户定稿 **D**，并追加两条约束：**行高不动（保持 2）**、**文件类型徽章保留 Linguist 饱和色**。

- **诊断（先拆因果，再动色）**：反馈里其实是**两条独立因果**，GPT 的建议一条都没碰到。
  - 疲劳 ← 底色 Y=0.0047 贴黑 **且** 正文对比 12.15:1 过冲（AAA 只要 7:1；深色高对比是光晕与视疲劳来源）。GPT 方案把底色抬对了，文字却同时提到 0.928，对比升到 **14.19:1**，比现状更高——方向反了。
  - 脏 ← `App.vue .shell-sheen` 以 `z-index:210` 盖在**文字之上**，把阅读区底色从 `#0d0f13` 抬到 `#1f2228`，**亮度差 3.35 倍**，横向色斑直接洗在正文行上。
  - C 档（只去脏、底色不动）证明两者可分离：背景立刻干净，但对比仍是 12.15:1，疲劳一点没改善。
- **令牌（`packages/forge-ui/src/design-tokens.css`）**：暗色阶梯保 hue 265 不动、组件层继续 `color-mix` 同源派生（不引第二套灰阶）——`--background` 0.166→**0.215**（Y ×2.06）、`--card` 0.189→**0.243**、`--muted/--secondary/--accent` 0.207→**0.268**、`--foreground` 0.85→**0.82**（**压**字）、`--muted-foreground` 0.62→**0.66**（**提**小字，13px 工具行/时间戳才是真正吃力的字）、`--border` 半透明白 alpha 0.085→**0.115**。正文对比 12.15→**10.07:1**，次级 5.25→5.63:1。`--shadow-sm/md/lg` 各补一档（底色 Y 翻倍后同 alpha 投影观感减淡）。
- **光场（`App.vue` + `global.css`）**：峰值 0.096→**0.035**（衰减形状不变，整体等比 0.365），不均匀度 3.35×→**1.69×**。两处**必须同步**（`global.css` 是 body 兜底，不同步会在透出 body 的场景看到第二个剖面）。
- **用户气泡（`MessageCard.vue`）**：暗色下 `--bubble-bg` `#3a3a3d`→**`#2b2e34`**、hover `#4a4a4d`→`#3a3e45`、字 `#ffffff`→**`#d7dae0`**。旧值是纯中性灰（色相 0），亮度是底的 4.4 倍、配 19:1 纯白字，在带蓝调的炭灰里是一块刺眼大灰板；换同色相冷调后亮度比 2.8 倍、字 13.6:1。`--bubble-bg` 是 shell 上的局部变量，`.bubble-fade` 渐隐叠层全部从它派生，无需额外改动。亮色主题不动。
- **启动帧（`forge-ui/index.html`）**：boot splash 兜底 `--welcome-bg` `rgb(13 15 19)`→**`rgb(24 25 29)`**、`--welcome-muted` 0.62→0.66。这两个值是「模块链加载前」那一帧的底色，与 `theme.ts` 同属不可漂移的锁定项。
- **窗口底色（`forge-desktop/src/theme.ts`）**：`THEME_BACKGROUND.dark` `#0d0f13`→**`#18191d`**。与 `design-tokens.css` 的 `--background` 逐位锁定（`test/theme.test.ts` 解析 CSS 换算 sRGB 做断言），改令牌不改这里会立刻红。
- **不做的（用户定稿）**：① **行高保持 `line-height: 2` 不动**（原型初稿曾提议 1.75，未采纳）；② **文件类型徽章保留 GitHub Linguist 饱和色**（`ToolCallCard.vue` 去饱和方案已撤回——颜色承载语言信息，一眼看出改的是 TS 还是 Vue，不是装饰噪点）；③ 不引 GPT 建议的 Accent `#7C8CFF` 靛蓝（与 `design-tokens.css`「中性深灰，非紫色」冲突，且已有琥珀/青瓷绿/金三个色相在跑）；④ 不做「侧栏比主区亮」（与 `App.vue` 一体化壳层「不靠色块台阶」冲突）。
- **验证**：typecheck 四包 0 错；forge-core 461/461、forge-ui 318/318 全绿；forge-desktop 338/345（6 红经 `git stash` 对比确认全部为改动前已存在的 `ensurePiShellPath` 环境相关 4 + PiConversationAdapter 2，零回归）。vite dev 页实测令牌全部落位（`--background` 解析为 `oklch(0.215 0.008 265)`、`--border` 为 `rgba(255,255,255,0.115)`、暗色 `.shell-sheen` 规则峰值 0.035 已进样式表）。
- **口径提醒**：`oklch()` 首值是**感知亮度 L**（改色用），`12.15:1` 是 **WCAG 对比度**（验收用，中间量是 sRGB 相对亮度 Y），两者不是同一口径，勿混说。压字 0.85→0.82 只让正文 Y 降 10.3%（配平动作），抬底 0.166→0.215 才是 Y ×2.06 的主调。

## v3.88.0 (新增：CV-S13 选区复制浮窗——消息内拖选文字松开鼠标即弹「复制文本」)

> 来源：2026-09-29 用户需求「参考图例，选中文本释放鼠标弹浮窗，只要复制文本」。参考图里的三动作（复制文本/添加到任务/在侧边任务中提问）被用户砍到只剩复制。形态先经 `prototypes/selection-copy-demo.html` 出 A（深色卡片浮层）/ B（tooltip 反色）两变体，用户拍板 **B**。

- **前端（`packages/forge-ui`）**：新增 `src/selectionPopover.ts` 全局单例（`main.ts` 引入即生效，与 `tooltip.ts` 同款模式：document 级 `mouseup` + fixed/transform 视口定位，免疫滚动容器偏移）。行为口径：① 仅选区锚点落在 `.msg`（消息卡片根）内才弹——侧栏/设置/终端（xterm 自带选区复制）/画布 iframe（事件不回传）天然不触发；② 浮窗出现在选区上方 8px，贴顶翻下方，水平夹紧视口（GAP/EDGE 与 tooltip 同款）；③ 点按钮 → `navigator.clipboard.writeText`（失败回退 `execCommand`，与设置页复制日志同款兜底）→ 「已复制」打勾 1.4s → 收起并清空选区；④ 任意滚动（capture）/ 浮窗外 mousedown / Escape（连选区一起清）即隐。样式进 `global.css`（`.selection-pop`）：反色底抄全局 tooltip（`--foreground` 底 / `--background` 字）+ `--shadow-md` + `--radius-lg`，图标复用 footer 复制按钮 SVG；z-index 9998 压在 tooltip 之下。i18n 新增 `chat.copySelection`（复制文本/Copy text），「已复制」复用 `chat.copied`；浮窗常驻期间切语言由 `watch(i18n.activeLocale)` 即时跟随。
- **不做的**：「添加到任务」「在侧边任务中提问」（用户裁定）；键盘划选（shift+方向键）不触发（需求口径=鼠标释放）；不动 footer 既有整条复制按钮。
- **验证**：forge-ui 单测 318/318、vue-tsc 0 错；vite dev 页（51731）浏览器实测全链路——消息区选中文本弹出（反色逐值 `oklch(0.85…)` 底/`oklch(0.166…)` 字核对）、点复制翻「已复制」→ 1.4s 收起清选区、非消息区选区不弹、Escape 收起。⚠️ 隐藏页环境 `Selection.toString()` 恒空（不重绘副作用），测试驱动用临时 `getSelection` 补丁验证模块逻辑，产品代码未加任何兜底。
- **文档**：PRD `docs/prd/03_conversation.md` 新增 CV-S13 节 + AC-CV-052/053/054 + 自检报告一行。

## v3.87.0 (新增：CV-S09 队列编辑——每条待发消息可删除 / ⚡立即发送（打断当前轮并直发）)

> 来源：2026-09-29 用户需求「排队消息不能只是干等，要能删、能插队」。交互先经 `docs/demos/queue-demo.html` 定稿；初版 ⚡ 采用 pi 原生 `steer`（等当前轮结束在边界插入），用户复核后明确要**真打断**（「AI 分析好长时间我不还是要等很久」），终版改为摘出条目 → abort 当前轮 → 立即直发。pi 原生无按条操作 API，按条编辑用 `clearQueue + 重建` 实现（`clearQueue/followUp` 内部均为同步 push，clear 与回灌之间无事件循环空窗，agent 循环观察不到中间空队列态）。

- **adapter（`packages/forge-desktop/src/pi/piConversationAdapter.ts`）**：`MinimalPiSession` 增可选 `steer()/followUp()`（真实 AgentSession 均有；fake 缺失时经 `prompt+streamingBehavior` 降级）；新增 `removeQueuedMessage(index)`（clearQueue + 原序回灌；index 越界原样恢复后抛错）与 `sendQueuedMessageNow(index)`（**打断语义**，用户定稿「= 按停止 + 发一条新消息，队列其他保持不动，跑完接着跑队列」：先 clear 再 abort（队列已空 pi 不会自动续跑）→ **剩余队列先回灌** → sendMessage 直发摘出条目起全新轮次，pi 循环在轮次边界按 FIFO 自动续跑剩余——回灌必须在起轮**之前**（sendMessage await 整轮，之后再入队就是无人消费的死队列，首版真机 bug 2 根因）；会话已空闲则跳过 abort；越界不打断当前轮）；**打断抑制窗** `abortingTurns`（对停止按钮同样生效）：① abort 期间 pi 发的 "This operation was aborted" 错误事件是正常收尾，不上报（真机 bug 1 根因——错误横幅 +「立即重试」）；② 被 abort 轮的最终 assistant 消息（`message_end(stopReason=aborted)`）不转发 UI 但记账照做——它到达时打断新轮次的 user 气泡已本地入列，转发会落在气泡之后，观感即「上一轮的文本接到新消息上」（真机 bug 3 根因：⚡发 5 后「收到 2。……」整段落在 5 下面）；③ 被 abort 轮次不发 mainTurnEnd（done 门控会把状态压成 done，而新轮次在 adapter 内直发、不走 service.setStatus(streaming)，状态会被压 done 直到新轮次结束）；私有 `mutateFollowUpQueue` 统一「clear → mutate（软失败原样恢复再抛错）→ 回灌（单条失败不中断其余）」。
- **forge-core**：`PiConversationAdapter` port 增两个可选方法；`ConversationService.removeQueuedMessage`（校验 1001/1002，适配器不支持/越界 5000）；`sendQueuedMessageNow` 带状态驱动（非 streaming 先置 streaming，结束后兜底置 done——adapter 内直发不经 service.sendMessage，状态必须此层负责）；`ConversationApi` 注册 `conversation/queueRemove|queueSendNow`，返回 `{ followUp }` 新队列。
- **前端（`packages/forge-ui`）**：队列浮窗条目悬停浮现两动作（⚡立即发送 / ✕删除，样式对齐定稿 demo：`--primary`/`--destructive` token）；**⚡ 的 user 气泡必须本地补**（真机 bug：直发路径后端不转发 user 气泡——`pendingDelivery` 只服务队列派发确认、直发起点即清空，导致「回复凭空提到没发过的 6 和 5」）：`useSessionConversation.sendQueuedNow(index)` 本地 push 气泡（文本取自队列镜像）+ 调 RPC，`InstructionInput` ⚡ 改 emit `queue-send-now` 由 ConversationView 接线；流式读秒/阶段由 statusChanged(streaming) 事件自动重启，无需额外处理；mock-bridge sendNow 去掉 user 气泡 emit（与真实后端对齐，避免 mock 下双气泡），HISTORY 照写（切会话回显）；`bridge.ts` ForgeMethod 增两方法；i18n `input.queue.*` 中英双语（⚡ tooltip 明示「打断当前回答，马上开始这条」）。
- **不做的**：用户复核后砍掉「在此前插入」（初版做过，语义与立即发送混淆）；停止语义不变——全停 + 队列回填输入框。
- **验证**：adapter 新增 7 用例（删中间/越界恢复/打断直发+剩余先回灌/越界不 abort/空闲跳过 abort/打断抑制窗×2——错误事件与被打断轮收尾消息均不外发、窗外照常）全过；demo 浏览器实测完整时序 `当前轮(被打断) → 立即直发条 → 队列逐条续跑 → 空闲`（用户定稿语义）；forge-core 服务层新增 4 用例全过；forge-core 450/450、forge-ui 318/318、三包 typecheck 0 错；desktop 全量 337/344——6 红全部为改动前已存在（`shellProbe` 环境相关 5 + 错误文案遗留 1，stash 对比确认）。
- **真机待确认**：①打断后瞬态状态——abort 使在途轮以 `stopReason=aborted` 收尾（partial 保留），新轮次全程保持 streaming（旧轮 done 已抑制），观察状态灯/停止按钮是否无缝；②被打断轮的流式占位文本保留在原位（不再被收尾消息重排），确认观感。
- **真机待确认**：打断后瞬态状态——abort 使在途轮以 `stopReason=aborted` 收尾（与停止按钮同款，partial 保留），随后新轮次立起 streaming；`streaming→canceled/done→streaming` 之间可能有毫秒级状态灯闪烁，待真机观察是否可感。

## v3.86.0 (新增：模块 10 内嵌终端——pty 服务 + term/* IPC + xterm 连体 tab 面板)

> 来源：PRD `docs/prd/10_embedded_terminal.md`（已确认），视觉按 `prototypes/terminal-git-prototype.html` 定稿 demo 对齐（2026-09-23 用户验收「按照这个demo对齐」）。模块 11（Git 提交推送）已先行交付，本次补终端。

- **后端（`packages/forge-desktop`）**：
  - 新增 `src/term/ptyService.ts`：node-pty（`@lydell/node-pty`，N-API 预编译，免 rebuild）封装为四个 RPC——`term/create`（cwd 必须 realpath 归一后命中已注册项目根，否则 1002；spawn 固定系统 shell `COMSPEC`/`SHELL`，不接受渲染层传任意可执行路径）、`term/write`/`term/resize`/`term/kill`（死/未知 ptyId 静默返回 0，PRD F04）。node-pty **懒加载**（首次 spawn 才 dynamic import，不拖累启动链）；`spawnPty/resolveShell/logger` 全部可注入，纯 TS 可测。
  - `ipc-contract.ts`：`ForgeMethod` 增 4 方法、`ForgeEvent`/`FORGE_EVENTS` 增 `term:data`/`term:exit`（漏登记 = 主进程静默不转发，`ipcEventContract.test.ts` 的同款防线）；`createForgeCore.ts` 把 termService 方法表并入 methodTable、事件走 core eventBus，并导出 `killAllPtys`。
  - `main.ts`：`before-quit`、窗口 `closed`、`did-navigate`（HMR/reload 孤儿对账）三处全量回收 pty（AC-10-07）。
- **前端（`packages/forge-ui`）**：
  - 新增 `components/TerminalPanel.vue`：xterm（`@xterm/xterm` + fit 插件）连体 tab 面板，主题/字体从 design tokens 取（深浅切换即时应用）；每 tab 存活独立 Terminal，后台 tab 不断流；tab ✕ 或**鼠标中键**关闭；面板高默认 240px、拖拽 clamp 120–520px、`forge:terminal-height`/`forge:terminal-open` 持久化；tab 软上限 20（超出一次性 toast）；pty 退出 tab 内保留 `[进程已退出 code=N]`；≥300ms 的 create 往返显示「连接中…」防御态；**有选区时 Ctrl/Cmd+C = 复制**（无选区仍是 SIGINT 中断），右键亦复制选区。
  - 面板右端两个动作键（用户 2026-09-29 追加）：**配色档切换**（暗/亮，未手选前跟随应用主题，手选后不再跟随，落 `forge:terminal-tint`；活动 tab 与面板底同步换色）+ **收起面板**（等价顶栏终端按钮的「关」）。行高 `lineHeight` 1.8→**1.4**（12px 字下单元格高 29px→22px，demo 静态文本的 1.8 放进真实终端明显偏松）。
  - **拖高上限改为随窗口高度走**（用户 2026-09-29：固定 520 拉不够高）：区间 120px ~ (窗口高度 − 280px)、绝对上限 1200px，`clampTerminalHeight`/`termHeightMax` 为唯一口径（拖拽、恢复、窗口 resize 三条路径共用）；窗口变矮只做内存内 clamp、**不写 localStorage**，窗口拉回去时用户记着的那个数还在。PRD F01 业务规则同步修订。
  - **配色取值缺陷修正（同一轮）**：原先把 design tokens 的 `--muted`/`--foreground` 原样喂给 xterm，而令牌是 `oklch()`/`color-mix()` 串——xterm 颜色解析只认 `#hex`/`rgb()`，判非法后**静默回退默认色**（浅色档 `--foreground: #333333` 恰是 hex 才让亮色主题看着正常，暗色主题实际一直在用 xterm 默认字色）。改为面板内置两档 hex 常量（`#15171d/#ccced0` 与 `#f4f4f5/#333333`，即两档令牌的 sRGB 换算值），同一份常量同时供 xterm 与 CSS 变量 `--term-surface`/`--term-ink` 使用，两侧不可能再错位。
  - App.vue：工具栏纯图标入口 + `Ctrl+\`` 全局开关；面板 `v-show` 常驻（切设置页不断流、pty 不回收）。i18n 新增 `terminal` 域中英双语。
  - mock-bridge：假 pty 行缓冲 mini-shell（echo/ls/pwd/exit/^C/退格），300ms 延迟应答复刻真实时序，浏览器 dev 可全流程演示。
  - **四处时序修正**（真机/浏览器实测发现）：① `tabs` 是 shallowRef，直接改 `tab.creating` 不触发重渲染——「连接中」永挂，改经 `patchTab()` 重排数组强制求值；② 主进程 spawn 后立即推数据、而 ptyId 要等 create 应答回传，首块输出（shell prompt）可能先于归属到位——新增未能认领事件的按 ptyId 暂存队列，应答确认后回放；③ **尺寸握手**：面板高度带 0↔240 过渡，途中 fit 出的是中间态行列，拿它 spawn 再连发 resize，ConPTY 每次重排都把 banner 顶出可视区（真机表现＝「上面空一块、往上滚才有字」）——改为开关/尺寸变化统一等落定（260ms）后量一次、**仅在行列真变化时才发 resize**、拖高松手立刻重测（fit 与 resize 必须成对，只 sync 不 fit 会让 xterm 停在旧行列）；④ ③ 的防抖把「开面板要自动建 tab」的意图冲掉了——过渡期间 ResizeObserver 连着回调、各自重排那个 260ms 定时器，默认不建 tab 的几次会顶掉带建 tab 的那一次，于是**点顶栏按钮只开了个空面板**；意图改由独立位 `wantAutoCreate` 记账（开面板/冷启动恢复时置位），谁最后落定都算数。
- **附带修正（`packages/forge-ui/src/App.vue`）**：`onSelectSession` 此前只改 `currentSessionId`、不对齐 `currentProjectPath`，导致**从会话树点入后新建终端 tab 的 cwd 停在旧项目**（从项目树点入才正确）；现按会话的 `projectPath` 同步，tab 标题一并跟手。
- **验证**：`term/ptyService.test.ts` 9/9（含 AC-10-06 伪造 cwd 三例、AC-10-07 killAll、shell 解析矩阵）；forge-ui 单测 318/318、vue-tsc 0 错；desktop typecheck 0 错；桌面全量 330/337——6 个红全部为**先前已存在**的 `test/pi/shellProbe`（环境相关）与 `test/pi/piConversationAdapter`（2d5de25 错误文案改动遗留），与本模块无关。浏览器（mock）实测：面板 240px/连体 tab 压边框 1px/拖拽 340→520→120 clamp+持久化/Ctrl+` 开关/ls-exit 回环/退出行/中英空态/深浅主题前景色联动；④ 修复后冷刷新复测——收起且零 tab 时点顶栏按钮 → 面板展开并自动出现当前项目 tab（名称与 cwd 均对），期间只有一条 `term/create`、无多余 resize；动作键复测（`getComputedStyle` 逐值）：tint=auto+暗主题 → 面板底 `rgb(21,23,29)`，第一击 → `rgb(244,244,245)` 且 `forge:terminal-tint=light`，第二击 → 回到 `rgb(21,23,29)`/`dark`，收起键点击后面板 `open` 类移除且 `forge:terminal-open=0`；行高改后单元格实测 22px（改前 29px）；拖高区间实测（视口 1625 高 → 上限 1200）：上抛 4000px → `--h`/localStorage 同为 1200px，下压 4000px → 120px。
- **文档**：新增 `docs/api/10_terminal.md`（§0 安全口径 + 四方法参数/错误表 + 事件 + 渲染层约定）。
- **真机待办**：主进程部分需重启 Electron dev app 生效——vim/top 全屏应用（AC-10-05）、任务管理器确认无残留进程（AC-10-07）、真实 COMSPEC/SHELL。

## v3.85.6 (修复：系统通知小窗 LOGO 过期且模糊)

> 来源：2026-09-29 用户反馈（截图）——回复完成通知左上角的 LOGO 是旧版带锤铁砧图且分辨率很低，与当前品牌 LOGO 不符。

- **根因**：`main.ts` 的 `resolveToastLogoSrc()` 只读 `forge-ui/dist/logo-main.png`（vite build 时从 `public/` 拷入）。该文件是 gitignore 的构建产物，本机 dist 停留在换 LOGO 之前的构建，通知就一直弹旧图；且旧图本身只有 64px 级，16px 显示下发糊。
- **改动（`packages/forge-desktop/src/main.ts`）**：`resolveToastLogoSrc()` 改为按序尝试两个候选——先 `forge-ui/src/assets/logo-main.png`（品牌 LOGO 唯一事实来源，1024px 高清，dev 下 dist 过期也不再错），读不到（生产包不含 src）回退 `dist` 产物；全部失败仍返回 null 走字母方块兜底。
- **构建产物刷新**：重新执行 forge-ui `vite build`，`dist/logo-main.png` 已与 `public/` 最新 LOGO 逐位一致（md5 校验）；生产包经 extraResources 打入的也是新图。

## v3.85.5 (调整：思考级别 max 去金环、停脉冲，浅色主题高亮块改白底)

> 来源：2026-09-29 用户反馈（看截图逐条）——①切到 max 时高亮块金环脉冲闪烁先停掉；②max 高亮块外层的金色描边去掉；③浅色主题下高亮块的中灰底难看。

- **改动（`packages/forge-ui/src/components/InstructionInput.vue`）**：
  - 删除 `.level-wrap.is-max .level-pill` 的金色描边环（`0 0 0 1px color-mix(--gold-deep 42%)`）与 `.level-pill.max-sweep` 的金环脉冲动画（`level-pill-pulse` keyframes 一并删除）——金环没了，脉冲（脉冲的对象就是金环）随之整个下线；max 反馈只剩文字金色扫光 + 格子轻弹。
  - 浅色主题新增覆盖 `:root[data-theme='light'] .level-pill { background: var(--background) }`：原 `--surface-active` 中灰（L≈90%）贴在白色浮窗上是一块灰斑，改白底后与 App.vue 项目/任务切换器同款 iOS 分段控件观感（白胶囊 + 浅灰轨道 + `--shadow-sm`）；深色主题维持微亮灰块不变。
  - 浅色主题金字渐变随之改暗色扫（同批用户反馈「白光扫看不清」）：`--gold-fade` 浅色值 `oklch(0.92 …)` 浅灰尾在白底上不可见 → 改深铜 `oklch(0.40 0.07 85)`；新增 `--gold-hi` 扫光高亮带令牌（深色混白提亮 / 浅色混黑变暗），`.lv-max` 常驻五段渐变的中间带从写死 `color-mix(--gold 55%, white)` 换用该令牌。深色主题所有取值不变。
  - max 金色文字（常驻渐变 + 扫光停驻渐变）保留，浅底金字（`--gold: oklch(0.68 0.14 85)`）在白胶囊上可读。
- **e2e（`e2e/thinkingLevel.spec.ts` TLEVEL-E2E-004）**：断言 ③ `level-pill-pulse` 改为高亮块 `animation-name === 'none'`（脉冲下线的回归防线）；文字 `level-max-flow` / 格子 `level-cell-pop` 断言不变。该 spec 5/5 通过。
- **视觉核对**：mock-backend + Playwright 实截深/浅两主题浮窗——深色：max 金字、高亮块无金环；浅色：白胶囊凸起、无灰块、金字可读（临时 spec 与截图已清理）。

## v3.85.4 (改进：max 反馈动画改为「就地金色扫光」，下线悬浮 M A X 文字)

> 来源：2026-09-28 用户反馈——思考级别改成分段滑条浮窗后，「切 max 的金色动画」浮在浮窗上方、飘进输入框正文区压住文字，很不好看。方案对比原型在 `prototypes/thinking-level-max-shimmer-demo.html`（0 现状 / A 就地扫光 / B 浮窗内文字 / C 收起后播 / D 光柱 五方案可切换对比），**A 方案定稿**。

- **根因**：`M A X` 文字是锚在级别胶囊正上方的**外挂层**（`.max-shimmer { bottom: 100% }`）。原选择器点选即收起，胶囊上方就是输入正文区的空白；改成浮窗且选完保持展开后，为不被浮窗盖住而加的 `.is-open { bottom: calc(100% + 12px + var(--level-pop-h)) }` 把它顶到浮窗上方——于是它飘进正文区压住占位符/输入内容，还和触发源断开。控件形态一变，这个外挂层就得重测一次（还要挂 `ResizeObserver` 测浮窗高）。
- **改动（`packages/forge-ui/src/components/InstructionInput.vue`）**：
  - 删除：`.max-shimmer` 元素与样式、`max-text-flow` / `max-in` / `max-out` 三个 keyframes、`--level-pop-h` 及其展开时的实测写入、`levelPopEl` / `levelWrapEl` 两个 ref、`shimmerOn` + `triggerShimmer()`。反馈不再产生任何浮层，也不依赖浮窗高度测量。
  - 新增 `flashMaxCell()`：选到 max 时给 max 档位挂 `.sweep`、给高亮块挂 `.pulse`，950ms 后摘除（重入先摘再挂，确保动画重启）。
  - 新增样式：档位文字包一层 `.level-t`，**扫光渐变挂在文字紧包围盒上而不是整个按钮**——按钮比「max」三个字母宽 2 倍多，渐变铺在按钮上会变成一条比字形宽得多的宽带，看着不像「这几个字被点亮」（原型与实现的第一版差异即出在这里）。`.level-item.on.sweep` 走格子 `scale` 轻弹 0.32s（`level-cell-pop`），`.level-t` 走 LOGO 同款金色渐变 `background-clip: text` 流过 0.9s（`level-max-flow`），`.level-pill.pulse` 走高亮块金环脉冲 ×2（`level-pill-pulse`）。扫光结束后 active 的 max 文字停在金色渐变上（`.level-wrap.is-max .level-item.on .level-t`），与旧 M A X 动画同色系，不突然变回素色。
  - 业务规则不变：`selectLevel` 仍是唯一的动画触发点（加载/重载落出 max 不触发）、乐观更新 + 静默降级、浮窗保持展开。
- **e2e（`e2e/thinkingLevel.spec.ts` TLEVEL-E2E-004）**：断言从 `.max-shimmer` 换成 `.level-item.sweep`，时长窗口 `[2200,3400]ms` → `[850,1300]ms`；新增三条回归——① `.max-shimmer` 恒为 0 且扫光元素**完全落在 `.level-pop` 内**（越出即失败，正是这次的 bug）；② 三个动画名分别为 `level-max-flow`（文字）/ `level-cell-pop`（格子）/ `level-pill-pulse`（高亮块）；③ **扫光渐变的实际宽度必须小于按钮宽度**（即渐变挂在 `.level-t` 文字盒上，而非铺满按钮——这条正是「实现与原型不一致」的回归防线）。帧率 ≥30fps 断言保留。
- **视觉核对**：Playwright 抓真机与原型页面同一时刻（150/400/750/1400ms）帧逐一比对，扫光落点、金色带宽度、格子弹动、高亮块脉冲一致（临时 spec 与对比帧已清理）。
- **文档同步**：`prd/05_model_provider.md`（§3.5 反馈措辞 + AC-MP-014 + 交互描述改为分段滑条浮窗）、`test/05_model/coverage-matrix.md`（U-MP-008 / E-MP-008）「约 2-3s 金色流光」→「约 1s 金色扫光（档位内就地播放，不侵入输入正文区）」。

## v3.85.3 (改进：思考级别切换器改为「分段滑条浮窗 + 水滴高亮」)

> 来源：2026-09-28 用户反馈——文字下拉换挡太慢、要打开才能看全部档位，期望参考 Codex 的分段滑条。原型在 `prototypes/thinking-level-slider-demo.html`（A~E 五方案横向对比，D 方案定稿）。

- **改动（均在 `packages/forge-ui`）**：
  - `InstructionInput.vue`：`.level-menu`（文字下拉列表）→ `.level-pop` 浮窗 + `.level-seg` 横向分段滑条。触发器保持现状纯文字（`.meta-link` + chevron，无胶囊边框），只在末尾加展开指示三角（随浮窗开合旋转）。选完档位浮窗**保持展开**（方便连续换挡），Esc / 点外部收起。
  - 高亮块 `.level-pill` 复刻 `App.vue` 项目/任务切换的水滴果冻机制：不整体平移，而是左右两条边分别动画（`--pill-l` / `--pill-r` 为 JS 实测 active 按钮 `offsetLeft/offsetWidth` 写入的几何），先行边 `240ms cubic-bezier(0.34,1.45,0.64,1)` 带回弹、另一条边 `260ms … 70ms` 追上去，途中被拉成水滴，落位时两头先后回弹；向右滑加 `.fwd` 让右边先行，向左回基态。
  - 几何不猜：展开时下一帧实测贴位（`.no-anim` 免叠一次动画），改挡位带水滴，`ResizeObserver` 监听分段条尺寸（等宽字体异步加载 / 窗口缩放会改档位宽窄）重贴无动画。切模型导致挡位集重建同样走无动画重贴。
  - 键盘：`←/→`（含 `↑/↓`）换挡、`Home/End` 首末档、`Esc` 收起并把焦点归还触发器；`role="radiogroup"` / `role="radio"` / `aria-checked` / `aria-label`（新增 i18n 键 `input.level.aria`）。档位按钮自身不画焦点环（当前位置已由高亮块表达）。
  - `max` 金色联动：`.level-wrap.is-max` 令高亮块加金环、当前档位文字转金（`--logo-gradient-accent`）。`M A X` 流光动画在浮窗展开时上移到浮窗上方（`--level-pop-h` 为实测浮窗高，不靠魔法数字），保持「切 max 有庆祝动画」。
  - 业务规则不变：`availableLevels` 仅 `off` 时隐藏入口、推理模型只剩 `max` 仍显示、会话级乐观更新 + 草稿态回显全局默认、切 max 播放流光（E-MP-008 行为未回退）。
- **验证**：`e2e/thinkingLevel.spec.ts` 选择器随 DOM 迁移（`.level-menu .menu-item` → `.level-seg .level-item`），新增 TLEVEL-E2E-005 覆盖：高亮块几何与 active 档位误差 ≤1px、向右滑行中实测拉伸比 >1.15（真水滴）、`←/→`/`Home`/`End` 换挡、`Esc` 收起并归还焦点、`is-max` 金色态。回归：该 spec **5/5**、forge-ui 单测 **294/294**、`vue-tsc` 0 错；真机（mock bridge，1280×820）暗/亮双主题目检：暗色高亮块改用 `--surface-active`（与 `.view-seg::before` 同令牌）后与项目/任务切换器观感一致。
- **踩坑**：① 浮窗不再随选档关闭 → `M A X` 动画文字被浮窗盖住（若直接跳过动画则 `E-MP-008` 行为回退），改为按实测浮窗高上移；② 等宽字体异步 swap 后档位宽窄变化，`--pill-*` 变陈旧（实测偏 1.3px），加 `ResizeObserver` 重贴；③ `.level-seg` 不能挂 Vue `:class` 绑定（`patchClass` 会整串覆写 `className`，冲掉 JS 侧加的 `.fwd/.no-anim`），故这两个类一律命令式切换。

## v3.85.2 (修复：启动 FORGE 字样「闪一下」+ 接管新会话时「跳一下」)

> 来源：2026-09-27 用户反馈两条——①「app 加载页的 FORGE 字样会闪一下」；②「加载完成跳到新会话时，forge 字样会调整一下高度，这个调整过程用户能明显感知，就是跳了一下」。

- **根因（四处，全部在启动三段接管 splash → BootWelcome → 正式 UI 的接缝上）**：
  1. **入场动画重放**：`BootWelcome.vue` 的 `.boot-logo` 带 `boot-fade-in 0.4s`（opacity 0→1 + 下移 6px），而 splash 上的字标是**静态在场**的——Vue 挂载替换 `#app` 的瞬间，屏上已有的 FORGE 消失并从零淡入 = 「闪一下」。违反 index.html 写死的不变量「视觉必须与 BootWelcome 完全一致，接管无缝」。
  2. **两份不同的字标 URL**：splash 引用 `public/logo-wordmark-on-*.png`（且为绝对路径 `/logo-…`），BootWelcome/LandingHero/ConversationView `import` 的是 `src/assets/` 下**另一份同名文件**——交接时新 URL 重新拉取解码，`height:auto` 下解码前盒子塌 0。附带：prod 是 `base:'./'` + `loadFile`（file://），绝对路径在打包版 splash 直接裂图只剩 alt。
  3. **boot 期假 LandingHero 闪现**：门闩放行时 `projects` 恒为空数组（`loadProjects` 是放行后才发的异步 IPC），**有项目的用户每次启动都会先挂载零项目落地页**（字标几何 A），project 落地后换成会话空态 hero（几何 B）——同一枚字标 ~300ms 内被摆到两个位置，即「调整了一下高度，跳了一下」。
  4. **字标尺寸三处不一致**：splash/BootWelcome `300px` vs LandingHero/conv-hero `min(40cqw,320px)`（常规窗口恒 320），交接时尺寸还会变一次。
- **修复（均在 `packages/forge-ui`）**：
  - `index.html`：字标改相对路径 `./logo-wordmark-on-*.png`（修 prod 裂图）+ 显式 `width=320 height=42`（PNG 357×47 等比，杜绝解码塌高）；`splashReady` 回执前必须等两张字标 `img.decode()`（300ms 兜底超时，与主进程 2500ms show 超时两层互不替代）——主进程 show 出的第一帧必带 FORGE。回执时落 `window.__forgeSplashNotified` 观测位。
  - `BootWelcome.vue`：删 `boot-fade-in` 动画与 keyframes；字标改 `BASE_URL + 'logo-wordmark-on-*.png'`（dev '/'、prod './' 与 splash 解析到同一资源）；宽度统一 320。
  - `App.vue`：新增 `projectsLoaded`（`loadProjects` **finally** 置位，报错/零项目同样放行，不成死门）；正式 UI 挂载条件收紧为 `formalUiReady = bootReady ∧ projectsLoaded`（首拉含 openProject 落地，ConversationView 首帧即终态，boot 期不再闪现落地页）；放行后 BootWelcome 改 fixed veil **淡出 200ms** 再卸载（400ms 超时兜底卸载，reduced-motion 直落），把切页硬切变成连续过渡。
  - `ConversationView.vue` / `LandingHero.vue`：字标切同一 public URL + 显式宽高；hero lift 的 ResizeObserver 增观测 `inputWrapRef`（models 异步回填等推动输入框长高时字标随重测，不再漂移）。
  - `src/assets/logo-wordmark-on-*.png` 副本**保留**（6 个原型页直接引用该路径，删则破坏原型同步）。
- **验证（红→绿，非推断）**：RED 基线先在旧代码实测复现——HANDOFF-001 抓到 boot 期 `.landing-hero` 闪现、HANDOFF-002 抓到 `boot-fade-in` 在场、SPLASH-005 抓到无 decode 门。新增 `e2e/bootHandoff.spec.ts` 4 条（假落地页不复活 / BootWelcome 无动画且字标 320 = hero 档 / 接管后 veil 必卸载且屏上只剩一份字标）+ `bootSplash.spec.ts` 扩 BOOT-SPLASH-005（回执在解码后 + 相对路径 + 显式占位）。回归：boot 相关 5 个 spec **16/16**、forge-ui 单测 **294/294**、`vue-tsc` 0 错；`vite build` 产物复核 `dist/index.html` 字标为相对路径 + 显式宽高、bundle 内三处 `BASE_URL` 字标引用在场。全量 e2e **122 passed / 13 failed**：boot 相关 16 条全绿；13 条失败逐条归属核对，全部落在本期未触碰的面——branchBadge ×2 / mw-restore ×2 / queue（QC-001 队列项渲染、QC-003 停止回填）/ session 树排序 / todoPanel 009b 遮挡 / conversationHistoryLocate / subagent 结果用量 ×2，即 v3.84.x 条目记录的**存量挂清单**（HEAD 干净基线对照验证过）叠加当前在途改动（InstructionInput 队列态、压缩横幅删除、msg-brand 字标接管、D 档底色）；`__repro-dark-d`、`__repro-subagent-bar` 为在途采样的 repro 草稿。剥离复跑（仅这 7 个 spec 单独跑）失败集合逐条一致，非负载抖动。真机 dev/打包各启动一次由用户目检。

## v3.85.1 (修复：压缩完成后底部横幅残留)

> 来源：2026-09-27 用户反馈两条——①自动压缩后「上下文已压缩（减少 81%）」横幅在输出期间一直残留在消息流底部；②「压缩了多少不需要显示，因为上面还有一个上下文已压缩的横幅（内联分隔条）」。

- **结论**：底部常驻完成横幅与两处反馈重复——压缩点位置已有内联「上下文已压缩」分隔条（v3.84.0 CV-S07 口径），减少百分比与 token 变化已在瞬时 toast 里（PRD 交互口径本就是 4~5s 瞬时提示）。故**删除完成态常驻横幅**，仅保留压缩中的「正在压缩上下文…」进度条。
- **改动（均在 `packages/forge-ui`）**：
  - `composables/useCompactBanner.ts`：状态收敛为「压缩中」布尔 Map（`sessionId → true`），删 `markDone`/`getBanner`/`CompactBannerState`，新增 `isCompacting`；`compactReductionPct` 保留（toast 文案仍在用）。
  - `components/ConversationView.vue`：横幅只在压缩中渲染（`compactingNow`），完成即卸载；样式选择器同步收敛。
  - `components/InstructionInput.vue`：手动压缩成功路径与 `conversation.compacted` 事件改为 `clearCompactBanner` 收尾（原 `markDone`）。
  - `i18n/domains/chat.ts`：删无引用的 `chat.contextCompactedReduction`（zh+en）。
  - `e2e/contextCompact.spec.ts`：手动/自动压缩两例改断言「完成后 `.compact-banner` 计数为 0」，头部注释同步口径。
- **验证**：`@forge/ui` typecheck 0 错、单测 294 过 / 0 挂。e2e 需 Playwright 浏览器补跑（同 v3.84.0 待办）。

## v3.85.0 (修复：流式收尾帧底部跳一下)

> 来源：2026-09-26 用户反馈「AI 输出完了之后对话框底部会跳一下」。e2e 探针实测定位根因后按方案 A（高度过渡）修复。

- **根因（实测，非推理）**：不是钉底失败——`onConvResize` 的补钉底在 ResizeObserver 回调里逐帧同步（`dScrollH == dScrollTop` 恒成立）。真凶是**收尾帧底部区块构成的一次性变化**：`.conv-thinking` 思考指示行随 `v-if` 卸载（实测 39px + flex gap 16px）、`.msg-footer` 消息底栏同帧挂载（实测 17px + margin-top 8px），净 **−30px 一帧完成**，滚动虽同帧跟随，视觉上就是整段对话内容「跳一下」。输入区全程不动；`scrollbar-gutter`、终态补落位稳定期两个方案经改前改后各 6 次实测均无对应缺陷（已回退，见知识库）。
- **改动（方案 A：~160ms 高度过渡）**：
  - `packages/forge-ui/src/components/ConversationView.vue`：`.conv-thinking` 包 `Transition :css="false" @leave`，**rAF 逐帧显式赋值**收拢 height/padding/opacity，按有无相邻兄弟用负外边距等量抵消将消失的 flex gap，末帧零尺寸后才 `done()` 卸载。
  - `packages/forge-ui/src/components/MessageCard.vue`：`.msg-footer` 包 `Transition :css="false" @enter`，从 0 高/0 透明/0 外边距展开到自然尺寸，结束后清内联样式交还 CSS（基础 opacity 0.6）。两处 `SETTLE_MS=160` 保持同帧启动、同步完成。
  - `prefers-reduced-motion` 与无 `matchMedia` 环境（单测）直接完成不动画。
- **关键坑（探针两次实测才发现）**：`.conv-thinking` 有上下 padding 各 10px，**box-sizing:border-box 下渲染高度不能低于 padding 之和**（内容盒钳到 0 为下限）——只动 `height` 必卡死在 20px，残余 19px 在卸载帧一次性跳出；CSS transition 版与 rAF 版冻在同一 20px，证明是布局钳制而非动画引擎问题。修法：padding 与 height 同比例收拢。
- **验证**：探针 `e2e/__repro-stream-end-jump.spec.ts --grep "repro L"` 实跑 2 次：`think` 39px→0 连续收拢、footer 0→17px 同步展开、卸载帧位移 ≈0、单帧最大 ≈11px（easeOutCubic 起步，修复前单帧 −30px）；`@forge/ui` typecheck 0 错、单测 **294 过 / 0 挂**。
- **文档**：PRD 03 CV-S02 业务规则补「收尾帧过渡」+ 新增 **AC-CV-054**；测试文档同步 **E-CV-030**（`docs/test/03_conversation/{coverage-matrix,e2e}.md`）；知识库 `docs/knowledge/stream-end-bottom-jump.md` 追加修复记录与两个布局坑；本条目。
- **待办**：真实 pi 会话复测（合成场景未覆盖 SuggestionChips / 压缩横幅 / 工具卡收起等同帧挂载的叠加来源）；截图证据补录。

## v3.84.0 (修复：下一步建议抢占一轮 + 压缩后历史丢失)

> 来源：2026-09-26 用户反馈两条——①「AI 输出完了之后会拼命的选择第一个继续下探，而不是让我看」；
> ②「压缩完了之后之前的历史消息没了」（附压缩后的会话截图）。两条都是 forge 侧口径问题，pi 不动。

- **修复 1 · 下一步建议不再抢占一轮（suggest_next_steps）**：
  - 根因：`suggestNextSteps()` 只返回 `content/details`，缺 pi 的**轮次收束信号**。pi 在**每个工具批次后默认补跑一次 LLM 调用**，模型手里只剩自己刚列出的建议、又没有新用户输入，于是顺势开工第 1 条——观感就是「不等人，闷头往下钻」，还多花一轮 token。
  - 改动（`packages/forge-extensions/src/suggestNextSteps/extension.ts`）：成功路径返回 `terminate: true`（pi 见此跳过补跑，本轮结束改由用户点选驱动）；**拒参路径不带**，保留模型改参重试的空间。guidelines 4→5 条（新增末条「NEVER start any of these steps yourself」），tool description 补「This call ENDS your turn」。
  - 易错点：`terminate` 只在**同批次全部 finalize 结果都 terminating** 时生效，所以「作为最后一个动作**单独**调用、不与其他工具并批」必须保留（一并写入第 4 条 guideline），否则信号被同批非终止结果吃掉。
  - 验证：`@forge/extensions` **65 过 / 0 挂**（新增 3 例：合法→terminate / 非法→不带 / execute 透传口径一致，guidelines 计数锁 5）。
- **修复 2 · 压缩不再抹掉界面历史（CV-S07 口径修正）**：
  - 根因：`loadPiSessionHistory` 用 `manager.buildContextEntries()`——那是**已应用压缩的模型上下文视图**，压缩点之前的条目被换成摘要；再加上主循环 `entry.type !== 'message'` 又把 `compaction` 条目本身跳过，结果**旧消息和摘要同时消失**（"历史没了"是用户侧的实感）。磁盘 JSONL 里条目一条没删（压缩只是 append 一条 compaction），丢的是读法。
  - 口径（写进 PRD）：**压缩只替换喂给模型的上下文，用户看到的 transcript 必须完整**，压缩点用一条分隔条标记。
  - 改动：
    - `packages/forge-desktop/src/pi/loadPiSessionHistory.ts`：改走 `getBranch()`（叶子→根全量分支）；`compaction` 条目落成 `{ role:'system', content:摘要, ts, compacted:true }` 插入原位。探针实测两 API 差异：`getBranch = m1|m2|compaction|m3|m4`，`buildContextEntries = compaction|m2|m3|m4`（m1 被抹）。
    - `packages/forge-ui`：`types.ts` 加 `compacted?`；`useSessionConversation` 展示项新增 `compaction-divider`（位于压缩前后之间）；`MessageListItem` 渲染 line+文案分界条与**可展开摘要**（两行钳制，点击展开）；i18n 新增 `chat.compactionSummaryExpand/Collapse`（zh+en）。
  - 验证：`@forge/desktop` **314 过 / 0 挂**（新增 3 例：压缩前消息仍在 / 标记恰好 1 条且带摘要与位置 / 未压缩会话无标记）；`@forge/ui` **294 过 / 0 挂**；desktop+extensions+ui 三包 typecheck **0 错**。
  - 文档：`docs/prd/03_conversation.md` CV-S07 新增「历史口径」业务规则 + 改写自动压缩的反馈条 + 新增 **AC-CV-052/053**；`docs/api/03_conversation.md` queryHistory 补「压缩分隔标记」字段说明、重写 `conversation.compacted` 的 UI 契约；测试文档同步 **U-CV-026 / E-CV-029**（`docs/test/03_conversation/{coverage-matrix,e2e}.md`）；本条目。
  - **待办**：新增 e2e `E-CV-029`（`e2e/contextCompact.spec.ts`）本机未安装 Playwright 浏览器（无 `~/.cache/ms-playwright`）**未实跑**；改动涉及主进程读取路径，`Electron 真机验收`压缩后的历史完整性与分隔条观感后再收口。

## v3.83.0 (功能：Git Bash 自动识别与 shellPath 自愈)

> 来源：2026-09-26 用户反馈——shell 横幅直接报「Shell 不可用」并要求用户自己去 `settings.json` 填 `shellPath`，问「自动识别 Git Bash 可以做到吗，然后填到配置中，而不是要用户自己做配置这件事」。承接 v3.78.x shell 健康探测（从"告诉用户哪里坏了"到"主进程自己修好"）。

- **主进程（forge-desktop）**：
  - 新增 `src/pi/gitBashResolver.ts`：零 pi 依赖的 Git Bash 候选链（纯 fs + child_process，单测可直接跑）。按 ① `where git.exe` **反推安装根**（对每个 git.exe 逐级上溯试 `<dir>\bin\bash.exe`、`<dir>\usr\bin\bash.exe`，三级覆盖 `cmd\git.exe` 与 `mingw64\bin\git.exe` 两种形态，不依赖目录名约定）→ ② 注册表 `HKLM|HKCU\SOFTWARE\GitForWindows` 的 `InstallPath` → ③ 常见位置（`ProgramFiles` / `x86` / `LOCALAPPDATA\Programs` / scoop）→ ④ `where bash.exe` 的顺序解析；每级都过 `usable()` = 文件真实存在 **且** 非 WSL 占位（`isWslStubBash` 判定扩到 SysWOW64），PATH 上「占位在前、真 bash 在后」时逐个过滤取真 bash。全部候选来源可注入（`platform/env/exists/findOnPath/registryInstallPath`）。
  - `src/pi/shellProbe.ts` 新增 `ensurePiShellPath()`：探测失败 → 解析 Git Bash → 经 pi `SettingsManager.setShellPath()` + `await flush()` 写进 `<agentDir>/settings.json`（合并写，`packages`/`models` 等既有字段不丢）→ **复探确认**后才回 `ok=true + autoFixed=true`；解析不到或写失败一律返回原异常（不谎报修复成功）。`probePiShell` 保持纯探测不变。
  - `main.ts` 启动链：`splash 上屏之后、createForgeCore 之前` await 一次自愈——修好的 shellPath 在首个 pi 会话创建前就落盘，用户全程无感（横幅根本不出现）；失败不拦启动。成本可控：`probePiShell` 先读 settings.json，正常机器直接返回，只有真不可用才 spawn。`IPC_SHELL_PROBE` 改走 `ensurePiShellPath`（运行期兜底：装完 Git 点「重新检测」即可自愈）。
  - `ipc-contract.ts`：`ShellProbeResult` 的 ok 分支加 `autoFixed?: boolean`（＝本次是自动写配置后复探恢复的，配置刚落盘、已存在会话仍持旧解析结果）。
- **前端（forge-ui）**：`useShellHealth` 增加 `autoFixed` / `busy` / `reprobe()`（重测绕过首挂载幂等闸门，探测中禁按钮）；对话区横幅三态——**自动修复成功**（`autoFixed`，muted 色提示「已自动识别 Git Bash（路径）并写入配置，重启应用后新会话生效」）、**仍不可用**（原错误色 + 「重新检测」+「打开配置文件所在目录」双入口）、正常（无横幅）；i18n 新增 `chat.shellReprobe/Reprobing/AutoFixed` 并改写 `chat.shellFixHint`（中英全键，`sb-actions`/`sb-ok`/`.sb-fix:disabled` 样式同源）。
- **文档**：新增 `docs/knowledge/git-bash-autofix.md`（+ index.json 登记）记录候选链、时机纪律与五个易错点；本条目。
- **真机验证（本机 Windows + Git 装 `<Git 安装目录>`，PATH 只有 `<root>\cmd`）**：确认旧链路三级全落空的根因（PATH 里没有 `bin\bash.exe`），新链路由 `where git.exe` 反推出 `<Git 安装目录>\bin\bash.exe` 并成功合并写进 `<userData>/agent/settings.json`（`packages` 7 项原样保留），复探 `ok=true`。
  - 过程中踩到并加固：**落盘前 `path.normalize`**。候选若带重复分隔符（如 `D:////work////Git////bin////bash.exe`），Windows 视作合法路径（`existsSync` 通过、连复探也通过），但 spawn 行为不稳——属于「看起来修好了、实际还是坏的」一类最难查的配置；补单测锁住。
- **验证**：新增 `test/pi/gitBashResolver.test.ts` 10 例（候选链全部依赖注入驱动，不依赖测试机装没装 Git）+ `shellProbe.test.ts` 追加 5 例（已可用零副作用 / 解析不到不动配置 / 修复成功且 packages 不丢 / 候选路径形态不规范须规范化 / 候选不可用不谎报）；`@forge/desktop` 311 过·0 挂·1 skip，`@forge/ui` 294 过·0 挂，两包 typecheck 0 错。

## v3.82.0 (功能：模块 11 Git 提交与推送)

> PRD：docs/prd/11_git_commit_push.md（2026-09-23「开工」，视觉/交互严格对齐 prototypes/terminal-git-prototype.html 定稿 demo）。

- **后端 4 RPC（forge-core/forge-desktop）**：
  - `git/getStatus|commit|push` 落 `forge-core/src/git/gitService.ts`（execFile git CLI，写操作 30s 超时）：getStatus 聚合 porcelain v1 + numstat（含未跟踪、二进制安全、unborn 走 `--cached` 基线）；commit 支持 `includeUnstaged`（勾=`add -A`），服务端双保险拒绝空暂存（AC-11-07）；push 自动 `-u origin <branch>`（无 upstream 时）。错误码 **6006 提交 / 6007 推送**，失败信封带 git 原始 `data.stderr`。
  - `git/generateCommitMessage` 落 `forge-desktop/src/git/commitMessageService.ts`（**单次 OpenAI 兼容 chat/completions，非 agent**，TD-GC 口径）：provider 解析链 = 会话模型→全局默认→models.json（keychain 解密，apiKey 不落日志）；diff 上下文 = 全量文件清单 + 每文件前 40 行 + 30k 字符预算（TD-GC-03）；语言随渲染层 `lang`；错误码 **6008**。
  - 校验：forge-core 400/400（git 真实仓库临时目录 24 例）、forge-desktop typecheck+单测过；`ipc-contract.ts`/`bridge.ts` 双白名单 +4。
- **前端（forge-ui）**：`GitCommitDialog.vue`（App 根常驻，`useGitCommitDialog` 模块级单例开合，同 useToast 套路）——ExitConfirmDialog 视觉骨架 + demo `.dlg-*` 控件（分支条 secondary 底、绿实心勾选框、无边框 AI 胶囊按钮、黑色主按钮暗色主题走 primary）；双入口=状态行「⊙ 提交或推送」meta-link + BranchBadge 浮窗分隔线下「提交或推送…」（后者经 BranchBadge `git-repo` 事件与非 git 项目对齐不渲染）；busy 禁用沿用 AC-PM-016；`stagedEmpty && !includeUnstaged` 或无变更 → 提交/提交并推送禁用 + 单行提示（推送独立可用）；提交中三按钮+关闭全禁用；失败（6006/6007/6008）弹窗内展示原始 stderr **不关窗**（BranchBadge 6001 模式）；提交并推送成功只出一条合并 toast；AI 生成 disabled+spinner、结果覆盖输入框。i18n 新域 `domains/git.ts`（zh+en 全键）；`mock-bridge.ts` 内存实现 4 方法（stagedEmpty 演示态 + `__fail__` 提交钩子失败模拟）。
  - 验证：forge-ui typecheck 0 错、289/289（④ 删 4 条 isProjectBusy 单测后）、浏览器 mock 双入口/中英双查/成功·失败·禁用·推送·Esc 全链路通过。**待办**：Electron 真机验收（主进程有改动需重启 dev app）。
  - 真机反馈修复（2026-09-23 截图，edu-community 实链路）：① 去掉「没有待提交的变更」提示（键删除，仅保留暂存区为空勾选提示）；② footer 三按钮与勾选 label 锁单行（nowrap+shrink-0，en 放不下时整组换行右对齐），460px 实测单行不再挤成竖排；③ AI 生成按钮图标由放射状「加载感」星形换成 sparkles 四角星；④ **busy 粒度修正（用户拍板）**：分支徽标/提交入口禁用只看**当前会话自身** streaming，同项目其他会话执行中不再锁本会话（不同会话可以提交不同的代码）——`gitBusy` prop 链（App projectBusy/Canvas isProjectBusy）整体拆除，InstructionInput 由既有 `sessionStatus` 派生；`isProjectBusy` 纯函数与其 4 条单测删除；AC-PM-016/AC-11-13/GC-S06 文档口径同步；⑤ 提交/推送执行中可见反馈（用户：「卡住不知道什么情况」）：进行中的那个 footer 按钮换成 spinner+「提交中…/推送中…」（commit-push 走两阶段文案 提交中…→推送中…，`phase` ref 驱动），其余按钮照常禁用；i18n +`git.doingCommit/doingPush`（zh+en）；`mock-bridge` git/commit·git/push 加 1.2s/1.8s 人工延迟，浏览器 dev 可观察进行中态；⑥ **AI 生成空内容加固（forge-desktop，需重启 dev app）**：真机 MiniMax-M3 点「AI 生成」报「模型返回空内容」——`max_tokens` 300→1024（思考型模型 reasoning 吃预算）、HTTP 200 + `base_resp.status_code≠0`（MiniMax 网关形态）识别为 provider 业务错误透传码与消息、正文空但有 `reasoning_content` 单独文案「只输出了思考内容没有正文」、空内容分支打形状诊断日志（model/finish_reason/content 类型/reasoning 字符数，不记内容）；`docs/api/11_git_commit_push.md` §4 同步；单测 +2（base_resp/reasoning 形态）+成功用例锁 max_tokens=1024，forge-desktop 284 过/0 挂/1 skip；⑦ 弹窗副标题加**待提交/待推送计数**（用户指定，随「包含未暂存」勾选变化）：`git/getStatus` 响应 +`stagedCount`（porcelain X 列判据同 stagedEmpty，不勾时的待提交数）+`unpushedCount`（`diff --name-only upstream...HEAD` 行数，无 upstream/detached/无 HEAD 为 null 即 UI 不显示）；`GitStatusInfo` 双端类型同步；弹窗 `.dlg-counts` 纯前端派生（勾=fileCount，不勾=stagedCount，零重查）；i18n +`git.statCommit/statPush`；forge-core 真仓库测试 +1（unpushed 全周期：null→0→2→push→0）+stagedCount 断言 2 条，401/401；mock/浏览器实测勾选切换「待提交 8 ↔ 0」联动通过；`docs/api/11` §1 字段表同步。**口径修正（2026-09-24 真机反馈：本地新分支提交 4 文件未推送却不显示待推送）**：原实现「无 upstream → null」把最该提示的场景漏掉了；改为三级判据——有 upstream 比 upstream、无则比 `origin/<分支>`、分支从未推送则数 `HEAD --not --remotes`（本地独有提交涉及文件，去重）；踩坑：零远端跟踪引用时 `--not --remotes` 会吞掉隐式 HEAD 输出为空，须显式给 HEAD；仅无远端/detached/无 HEAD 才 null。真仓库（forge dev-v0.2.0，upstream 在）实测 10 与裸 git 对拍一致；core 测试改写为三级判据全周期（1→0→2→0→新分支 1），401/401。
- **文档**：新增 `docs/api/11_git_commit_push.md`；`docs/api/index.md`（6006/6007/6008 + 模块行）、`docs/overview.md`、PRD 11 状态同步。

## v3.81.0 (文档：模块 10 内嵌终端 / 模块 11 Git 提交与推送 PRD 定稿)

> 口径来源：2026-09-23 对齐讨论 + `prototypes/terminal-git-prototype.html` demo 三轮验收（终端面板形态、弹窗入口收敛、AI 生成按钮样式、连体 tab）。两模块均**待开工**，无代码变更。

- 新增 `docs/prd/10_embedded_terminal.md`：底部面板（非覆盖层）+ 多 tab；新 tab cwd 自动取当前会话项目根、已开 tab 不随项目切换（D2 混合口径）；完整交互终端 xterm.js+node-pty（TD-TM-01 推荐 @lydell/node-pty 预编译回退，**spike 为开发第一步**）；用户终端与 agent bash 两套独立；数据流走事件下行+invoke 上行复用现有 IPC 治理。
- 新增 `docs/prd/11_git_commit_push.md`：全量提交语义（用户拍板砍掉"仅本会话"，不建变更账本）；弹窗=ExitConfirmDialog 视觉模式，双入口（状态行「提交或推送」+分支浮窗），无文件清单无 diff 统计（D5）；「包含未暂存变更」勾选（勾=add -A+commit，不勾仅暂存区且空时禁用+服务端拒绝）；AI 生成=主进程单次 OpenAI 兼容 chat/completions（复用 models.json provider 与 keychain 解密，diff 截断 30k，语言跟随 app locale）；push 失败弹窗内 stderr 回显（BranchBadge 6001 模式）；busy 禁用沿用 AC-PM-016 语义；新增 git/getStatus·commit·push·generateCommitMessage 四 RPC。
- `docs/prd/index.md`、`docs/overview.md` 模块表同步 10/11 两行。

## v3.80.0 (功能：UI 国际化（模块 08）+ Skill 管理（模块 09）)

> PRD：docs/prd/08_ui_i18n.md、docs/prd/09_skill_management.md（2026-09-22 用户「开工」批准后按 08→09 顺序交付）。

- **模块 08 · UI 国际化（已完成）**：自研轻量 composable（零新依赖，不引 vue-i18n），仅覆盖 App UI 静态文案（AI 回复内容不翻译）。
  - 基础设施：`forge-ui/src/i18n/`（`index.ts` 提供 `useI18n().t(key, vars)` + `{name}` 插值 + zh 缺键回退；`zh-CN.ts` 为键集事实来源 `MessageKey`；字典按域拆 `domains/*.ts`，键名前缀即域名禁止跨域重名）。
  - 全量迁移：28 组件 + utils 硬编码中文 → `t()` 调用；`en.ts` 合并字典允许缺键（回退 zh，逐批补齐纪律）。
  - 三态偏好：zh-CN / en / system（跟随 `navigator.language`），localStorage `forge.locale` 持久化；设置页「通用」Tab 语言切换器即时生效。主进程零改动。
  - 验证：forge-ui `vue-tsc` 0 错、单测 293/293（含 `i18n.test.ts` 键集/插值/回退断言）、浏览器三态切换验收通过。
- **模块 09 · Skill 管理（代码交付，真机验收待确认）**：设置页「关于」Tab 版本更新分区下方新增「Skills」分区——查看（全局/项目两组 + 真实根路径徽标 + 异常与冲突折叠区）、导入本地文件夹、模板新建、删除。
  - 后端 `forge-desktop/src/pi/skillService.ts`（纯 TS，Electron 经端口注入）：`skill/listSkills|importSkill|createSkill|deleteSkill` 四方法并入 forge-core methodTable；枚举复用 pi `DefaultResourceLoader`（口径 == agent 实际加载，TD-SK-01），pi 静默跳过的非法目录补**影子扫描**以 warning 如实上报（AC-09-02）；同名冲突走 **4090 确认协议**（`data.conflictPath` → UI 弹确认 → `overwrite:true` 重调，旧目录先入回收站，TD-SK-03）；删除/覆盖统一 `shell.trashItem` 优先、失败回退永久删除并回报 `trashed:false`（TD-SK-04）；写目标固定 `<agentDir>/skills` 与 `<project>/.agents/skills`（TD-SK-05）；containment：直接子目录 + realpath 复核父目录 + 符号链接指向复验，越界 1001（AC-09-11）；导入临时目录 + rename 原子落位、失败清理不留半个 skill。零重载/零通知（TD-SK-06），新会话与下次查询自然生效。
  - IPC 契约：`ipc-contract.ts` ForgeMethod +4；类型经 **type-only re-export** 暴露（不把 pi SDK 拉进 preload 打包）。preload 无运行期方法白名单，零改动；目录选择/打开目录复用既有 `dialog.selectDirectory` / `shell.openPath`。
  - 前端 `SkillsSection.vue`：4090 为正常分支不适用 `call()` 抛错语义 → bridge 新增 `invokeRaw<T>()` 原样返回信封；确认/删除/新建弹窗 Teleport 到 body（规避设置页祖先 transform 裁剪 fixed 遮罩）；文案全走 i18n（`domains/skills.ts` zh+en）。`mock-bridge.ts` 内存实现四方法（含 4090/overwrite/trashed 协议）供浏览器 dev 预览。
  - 验证：forge-desktop 单测全套 **272 过/0 挂/1 skip**（新增 `test/pi/skillService.test.ts` 15 例，覆盖 AC-09-01/02/05/06/07/08/09/11/12）、tsc 0 错；forge-ui typecheck 0 错、293/293；浏览器 mock 链路交互验收通过（列表分组/新建/同名冲突覆盖/删除 toast/导入/导入冲突取消/项目级落 `.agents/skills`/非法名保留输入报错）。**待办**：Electron 实应用真实链路 + Windows 回收站实测（AC-09-10）后翻 09 状态为已完成。
  - e2e 回归修复（i18n 交付的连带账）：Playwright 默认 `navigator.language=en-US` + 语言偏好 `system` → 整页英文渲染，打爆全部中文文本选择器（settings 8 条、subagent/tooltip/todoPanel 等约 30 条）。修法：`playwright.config.ts` `use.locale='zh-CN'`（测试环境钉死中文，语言切换本身仍由设置页用例覆盖）。另修复 2 条**存量挂**（非本期引入）：`smoke` 断言的 `.workspace-brand` 文字品牌位已在 757f328 换成 logo 图（改断言 `.tb-logo` 可见）；`updater` E-IN-001/002 期望 `0.2.0` 而版本行 551e6d7 起按设计渲染 `v0.2.0`（期望补 `v` 前缀）。修复后 settings+updater+smoke 全绿。全量套件 **106/117**：剩余 11 条挂经 HEAD 干净基线 worktree 对照跑验证为**逐条一致的存量挂**（repro 草稿用例、bootSplash-004 splash svg、landingHero `.landing-wordmark`、branchBadge ×2、mw-restore 几何 ×2、queue QC-003 停止回填、session E-SM-001 树排序、todoPanel 009b hero 遮挡、conversationHistoryLocate），归属近几笔已提交的 UI 重构（logo/TitleBar/hero），与本期 08/09 无关，留待对应改动方修期望值。
  - 文档：新增 `docs/api/09_skill.md`；`docs/api/index.md`（4090 码 + 08/09 模块行）、`docs/prd/index.md`、`docs/overview.md` 状态同步。

## v3.79.0 (需求：首装可选安装目录（NSIS 向导）、默认暗色主题、模型编辑弹窗化)

- **需求 1 · 首装选安装位置（三轮迭代）**：
  - 第一版（被否定）：保留 `oneClick:true`，`build/installer.nsh` 的 customInit 在「非静默 + 无 --updated + 注册表无历史目录」时 `nsDialogs::SelectFolderDialog` 弹目录框。用户反馈：「正常都是安装什么，默认在什么目录下安装，可以自定义安装，而不是打开直接就是个选择窗」——裸弹选目录框不是标准安装体验。
  - 最终版：改用官方**向导模式** `oneClick:false` + `allowToChangeInstallationDirectory:true`（首装/重装显示「选择安装位置」页，默认目录预填、可「更改」）。更新零点击靠三处配合补齐：目录页由模板 `skipPageIfUpdated` 跳过（electron-updater 恒传 --updated）；「安装模式」页由 `customInstallMode`（`$isForceCurrentInstall="1"` → PRE Abort，forge 恒 per-user 该页纯噪音）跳过；结束页由 `customInstall` 在 `--updated + --force-run` 时复刻 oneClick 收尾（HideWindow + 拉起应用 + quitSuccess，不进结束页）。
  - 编译期实测修正两处：① `!insertmacro StartApp` 与模板静默收尾分支的 `Var startAppArgs` 撞名（variable already declared）→ 内联 `${StdUtils.ExecShellAsUser} $0 "$launchLink" "open" "--updated"`；② 模板 `!ifmacrodef customInstallmode` 与 `customInstallMode` 大小写不一致——makensis 3.0.4.1 实测宏名大小写不敏感，钩子有效。installer.nsh 保持 UTF-8 BOM（NSIS 3 无 BOM 按 ANSI 读，中文注释乱码）。
  - **第三轮反馈（2026-09-19）· 目录页文案补「自动补 forge 子目录」说明**：真机确证官方 `instFilesPre` 在点击「安装」瞬间把不以 forge 结尾的路径自动补 `\forge`（选 `D:\软件\` → 实装 `D:\软件\forge`），但目录页输入框预览看不到，用户误以为装进所选路径本身。用户选定方案：只加静态提示文案、不改行为。做法用 MUI2 官方扩展点 `!define MUI_DIRECTORYPAGE_TEXT_TOP`（installer.nsh 内、BUILD_UNINSTALLER 守卫下），文案 = SimpChinese 默认文案 + 一行提示；代价是该 DirText 原文不走 LangString，全语言统一显示中文（面向中文用户，有意接受）。**踩坑证伪**：先前尝试 `MUI_PAGE_CUSTOMFUNCTION_SHOW` 挂 SHOW 钩子运行时读 static 追加——编译期确认目录页消费了该 define（Pages.nsh 首次消费即 !undef + warning-as-error 证明 Call 已生成），但真机弹窗/日志双探针均无触发：**NSIS 3.0.4.1 内建 directory 页运行时不派发 SHOW 回调**，此路死，勿再尝试。验证：真机 dump 目录页 static 已含提示行；`installerConfig.test.ts` 增至 4 条（新增文案断言 + 反向守卫：禁 SHOW 回退、禁诊断代码残留）。
  - **验证**：`npm run dist` 出包成功（building target=nsis oneClick=false perMachine=false）；零点击更新真机模拟——`forge-0.1.9-x64-setup.exe --updated --force-run`（electron-updater 的确切参数组合）exit 0、全程无页面停留、装完 forge.exe 自动拉起（`%LOCALAPPDATA%\Programs\forge`）。契约测试 `test/pi/installerConfig.test.ts` 重写为 4 条：向导配置断言（oneClick=false / allowToChangeInstallationDirectory=true / perMachine=false / runAfterFinish=true）、installer.nsh 更新守卫断言（isUpdated+isForceRun 收尾、BUILD_UNINSTALLER 包裹）、目录页文案断言（TEXT_TOP + 提示行 + 禁 SHOW/诊断残留）、isSilent=false 不可回退（2026-09-14 反馈）。
- **需求 2 · 首次安装默认暗色主题**：三层同步改默认值——`useTheme.ts` 初始 `ref('dark')`、`index.html` 同步引导脚本（无存储/异常时 `data-theme='dark'`，splash 期即暗色不闪白）、`theme.ts` `DEFAULT_THEME='dark'`（主进程建窗底色）。真机日志 `[boot] 建窗底色 theme=dark bg=#242427`。`theme.test.ts` 缺省断言与 `bootSplash.spec.ts` BOOT-SPLASH-001 默认档（亮→暗）同步翻转。
- **需求 3 · 模型添加/编辑弹窗化**：`SettingsPanel.vue` 表单从列表区移入 `<Teleport to="body">` 的居中模态（遮罩 + blur、点遮罩/关闭按钮退出、Esc），模型列表不再被挤压；`.level-menu` 改朝上展开防被弹窗底边裁切；保留全部既有 e2e 选择器。踩坑：fixed 遮罩最初被带 transform 的祖先裁剪只盖住内容区 → Teleport 到 body 解决。真机验证：overlay 盒子 = 视口（1280×820），侧边栏/顶栏/四角 `elementFromPoint` 均命中遮罩，`.provider-list` 位置不变；`settings + bootSplash` e2e 12/12。
- **需求 4 · 环境**：`npm install --registry=https://registry.npmmirror.com` 全量装齐并启动 dev（vite 51731 + Electron）。打包侧两个环境坑：winCodeSign 解压需符号链接权限（非管理员失败）→ 手工把已解压目录改名为正式缓存名 `winCodeSign-2.6.0`；NSIS warning-as-error（6010 未引用函数）→ installer.nsh 全量 `!ifndef BUILD_UNINSTALLER` 包裹。
- **文档同步**：PRD 07（TD-IN-07 修订为「向导 + installer.nsh 零点击收尾」、IN-F01/IN-F03 业务规则、AC-IN-001、反馈/决策追溯表）、coverage-matrix（AC-IN-001、反馈表两条）、packaging.md（安装包形态）。
- **验证汇总**：forge-desktop 单测 **256/256**、tsc 0 错；forge-ui e2e（settings/bootSplash）12/12；安装包真机三路径（首装向导页在场 + 目录页提示文案可见 + --updated 零点击）验证通过。

## v3.79.1 (样式：子 Agent 运行中指示对齐主会话 — 银色流光 + 读秒，去除三点)

- **用户反馈**：子 Agent 结果视图运行中底部「··· 正在思考…」与主会话流式思考指示器（银色流光 + 读秒）观感不一致；期望同一种「Codex 式」流光表达。
- **根因（`SubagentResultView.vue`）**：v3.15 引入无边框指示时，为了「简单先于抽象」只用了三圆点 + 静态文字（`.srv-indicator > .thinking-dot ×3 + <span>`），没有复用主会话 `ConversationView.vue` 里 `conv-thinking` 的银色流光结构。运行时两者并排（多窗口/分块）观感分裂。
- **修复**：
  - 模板同步主会话结构：`<div class="srv-indicator"><span class="thinking-text thinking-shimmer">{{ text }}</span><span class="thinking-sec">{{ formatElapsed(sec) }}</span></div>`，删除三点 + 静态文案。
  - 样式对齐：`padding: 10px 14px; font-size: 14px;` 与 `.conv-thinking` 一致；`.thinking-shimmer` 复用主会话同套银色渐变 + 2.4s 流光；`.thinking-sec` 复用主会话同套 `font-size: 11px; font-variant-numeric: tabular-nums; opacity: 0.55;`。
  - 读秒改用既有 `utils/formatElapsed.ts`（`<60s → 42s`、`<60m → 5m30s`、≥1h 进位），与主会话完全同源。
- **验证**：`packages/forge-ui` 单测 **286/286** 全过、`vue-tsc` 0 错。E-SA-010 断言文字不变（「底部无边框'正在输出…'指示」仍通过），子 Agent e2e 11/11。

## v3.78.9 (修复：AI 回复中同一句话在工具卡片之间重复出现——切会话再切回才恢复)

- **用户反馈**：AI 回复时同一段文本（如"明白了，回退上次的改动…"）在工具卡片之间反复出现（同一轮内 2~3 次），切换会话再切回后显示恢复正常。此前已改过一次（前端 `onMessage` 以"覆盖最后一条 assistant"避免 delta 累积 + 完整消息成双），未盖住本场景。
- **取证（真机会话 JSONL 直接解析，非推断）**：edu-community 会话（`forge-91e2fc68…jsonl`）磁盘上目标正文**只有一条**（一条 assistant 的 text 为 `<think>…</think>明白了…`，其余多条 assistant 清洗后为空）——磁盘历史正确 ⇒ 重复只发生在实时链路，切回后 `loadHistory` 重载即恢复。
- **根因（`piConversationAdapter.handleEvent` 的流式差分状态是轮次级，语义上应为消息级）**：MiniMax-M3 一轮内每步工具调用都是**独立一条** assistant 消息、正文混流 `<think>` 包裹。事件链为：带正文的消息 `message_end` 后**正文残留在 `partialContent`**；后续**纯思考**消息（清洗后 content 为空）的 `message_end` 把 `forwardedClean` 无条件置空但**不动 `partialContent`**；再下一条纯思考消息流式时 `stripThinkingContent(partialContent 残留 + 思考 delta) = 旧正文 ≠ prev('')` → 整段旧正文被当成新增量重发 → 前端此时 last 是工具消息 → push 出重复文本卡。"正文→纯思考→纯思考"序列恰好复现"文本 → edit×2 → 文本 → read → 文本 → read"的截屏模式。
- **修复（`piConversationAdapter.ts` message_end 分支，一行核心改动）**：`partialContent` 与 `forwardedClean` 一样，在每条 assistant 消息 `message_end` 时**无条件**以本条清洗结果整体覆盖（原代码只在 content 非空时覆盖）。流式差分基线从轮次级收敛为消息级，上一条正文不再漏进下一条消息的增量求差。错误路径（`message_end(stopReason=error)` 保留现场）不变。
- **回归测试（`test/pi/piConversationAdapter.test.ts` 新增 2 例，先 RED 后 GREEN）**：
  - 「一轮多条 assistant 消息时上一条正文不重发」：正文消息 + 两条纯思考消息的完整事件序列，断言增量恰为一次正文——回退修复确认 #50 fail（bug 复现），恢复后 pass；
  - 「正文消息后跟正文消息」：第二条只转发自己的增量（消息级收敛不误伤正常多段正文）。
- **验证**：forge-desktop 单测 **254/254** 全过（含新增 2 例）、tsc 0 错。前端 `useSessionConversation` 无需改动（重发源头消除后，"last 非 assistant 则 push"恢复其正常语义：轮次内第二段正文本来就该开新卡片）。

## v3.78.8 (修复：欢迎页被白板阻塞 —— 显示后必须等到「splash 那一帧真的呈到屏幕上」才做重活)

- **用户反馈**：「你这次改完出现了新的问题，欢迎页被阻塞了，一开始没有字，只有白板」——即 v3.78.7 修出的新症状，比它要修的问题更重。
- **根因（v3.78.7 的顺序错误）**：v3.78.7 把「让合成落地」的手段放在 **`show()` 之前**（等 300ms 再 `show()`），而那段宽限给的是**一个还没显示的窗口**。`show()` 只让窗口「可见」，屏幕上真正出现内容由 **`show()` 之后的下一次合成**决定；v3.78.7 在 `show()` 后立刻开始同步重活（pi SDK 求值 + jiti 预热，与 Chromium 合成同一个线程），那次合成就地卡住 ⇒ 窗口停在自己缓冲区里那一帧上。
  - 缓冲区里那一帧是什么？是 **Chromium 的「尚未解析出 HTML 的空文档」= 纯白**（与主题取值无关，v3.78.7 已证过这一点）。暗色主题下唯一的白只能来自这里，而用户报的正是白板 ⇒ **隐藏窗口期间合成的帧并没有进入窗口自己的缓冲区**：「隐藏期已经画好了」不等于「show 出来就有」。
  - 这也解释了为什么这次比 v3.78.6 更糟：v3.78.6 的白只有 `ready-to-show` 前的 ~1s（那段窗口主进程还空闲，合成做得完），而 v3.78.7 的白 = **整个重活时长**（一次合成都没做完）。
- **修复（顺序 + 信号 + 判据三处）**：
  1. **`bootFrame.ts`（新增，纯函数、零 Electron 依赖）**：把 `NativeImage.toBitmap()` 的位图统计成「内容占比 / 标志块占比 / 底色」—— 白屏这类问题「我这边不白」无法自证，本模块把「窗口上有没有内容」变成可量化事实，且可直接单测。
  2. **信号升级为 presentation 事件**：`webContents.beginFrameSubscription` 的回调即浏览器进程侧「这一帧已从合成器呈出」。信号强度阶梯现为 `did-navigate < ready-to-show < 渲染进程 rAF 回执 < presentation 事件`——只有最后一个是「屏幕上有了」。
  3. **顺序改对**：`waitForSplashPainted` 现在是「等 rAF 回执 → **隐藏期取一帧合成帧（证明表面已是 splash，而不是空文档）** → `show()` → **等显示后的一帧合成帧** → 300ms 落屏余量 → 才放开主进程做重活」。只认**有内容**的帧（纯底色帧不算数，继续等下一帧）。
  4. **新增一行可 grep 诊断**：`[boot] 显示前/显示后合成帧 at …ms WxH 内容占比=…% 标志块=…% 底色=#…`，纯底色帧会带 `⚠ 纯底色帧（白板）` 标注——下次再白，日志直接给出「哪一帧白的」。
  5. **新增 opt-in 现场转储 `FORGE_BOOT_FRAME_DUMP=<目录>`**：把启动首帧写成 PNG，用于事后核对画面本身（像素统计只能给「有没有内容」，给不出「内容对不对」）。默认不生效，普通启动零开销。
- **验证（真机三次启动 + 读图，非推断）**：
  - 复用用户正在跑的 vite（51731），`FORGE_BOOT_FRAME_DUMP` 打开，逐次核对：
    - `[boot] 建窗底色 theme=dark bg=#242427`
    - `[boot] 显示前合成帧 at 389ms 2240x1437 内容占比=0.35% 标志块=0.19% 底色=#242427`
    - `[boot] 显示后合成帧 at 54ms 2240x1437 内容占比=0.33% 底色=#242427` ← show 后 54ms 就有一帧带内容的合成帧被呈出，**此时重活尚未开始**
    - `[boot] 窗口已显示（splash 就绪 1486ms）` → `[boot] forge-core 就绪`
  - **转储 PNG 逐张读过**：2240×1437 全幅、暗底 `#242427`、蓝色 F 标志块 + `Forge` + spinner + 「正在准备运行环境…」字样齐全 —— 显示前/显示后两帧都是完整 splash，不是白板。
  - **BGRA 通道序被实测确认**：`标志块=0.19%`（若按 RGBA 解读，该比例会恒为 0）。
  - 新增 `test/bootFrame.test.ts` **6 条**：纯底色判「无内容」（= 白板判据）、splash 几何量级判「有内容」、透明像素算底色、异常输入（null/空/尺寸 0/长度不足）不抛错、`step` 非法回退、左上角取底色语义。→ forge-desktop 单测 **246 → 252，252/252 通过**。
  - e2e 新增 **BOOT-SPLASH-004 @P0**（冻结模块链后 `Forge` 字标 / 阶段文案 / 标志块必须可见、非零尺寸、完整落在视口内——把「只有白板没有字」从 DOM 侧锁住）；`bootSplash` + `bootGate` + `landingHero` **10/10 通过**。`tsc` 0 错。
- **遗留**：真机视觉的最终确认仍需看屏幕（本机屏幕采样不可用，见 MEMORY.md 记录）；像素证据只能证明「帧上有 splash 内容」，不能替代人眼。若仍白，按 `FORGE_BOOT_FRAME_DUMP` 导出现场即可定位是「没等到帧」还是「帧本身不对」。
- **未改**：用户手改在途的 `App.vue` / `BootWelcome.vue` / `TitleBar.vue` / `DiffView.vue` / `ExitConfirmDialog.vue` / `global.css` 一律未触碰；本轮只改 `main.ts` / 新增 `bootFrame.ts` / 新增单测 / 新增 e2e 用例。

## v3.78.7 (修复：暗色主题下启动仍白一瞬 —— 窗口延迟到 splash 真正上屏后才显示)

- **用户反馈**：「黑色外观的时候还有启动的时候有一秒是白色 没解决」——v3.78.6 修掉「建窗底色」后，启动链上仍有一段白。
- **排查（真机实测逐项证伪）**：
  - 先复现：把主题镜像 `forge-theme.json` 改成 `light`、localStorage 仍是 `dark`，启动后日志 `[boot] 建窗底色 theme=light bg=#FFFFFF` —— 证实「镜像缺失/不一致时建窗底色必为白」，但这只是其中一种情况。
  - 再读渲染进程计时（CDP 取 `performance.getEntriesByType('paint')`）：`first-contentful-paint` **5024～6872ms**；而主进程 `[boot] 窗口已显示` 在 **277～1507ms**。两者差约 5s，且与 `forge-core 就绪` 的耗时重合 —— 窗口已可见、页面却还没画出任何东西。
- **根因（三层，逐层剥掉）**：
  1. `backgroundColor` 只能盖住「窗口创建 → 渲染进程首次合成」这一小段；之后 Chromium 改用**尚未解析出 HTML 的空文档**绘制，而空文档的默认底色是**纯白**——**这与主题取值是否正确无关**。所以 v3.78.6 的「底色跟随主题」只能修镜像不一致那一种，修不掉这一层。
  2. Electron 的 `ready-to-show` **不等于「已提交到窗口表面」**：实测 1206ms 触发，而首帧提交要到 6872ms。原因是主进程紧接着的同步重活（pi SDK 同步求值 ~1.2s + jiti 预热 ~2.4s）与 Chromium 的合成**是同一个线程**，把「已渲染」到「已提交」拖出 5.6s。拿它（或 `did-navigate`，仅 ~77ms）当「已上屏」信号，都会放出一个内容空白的可见窗口。
  3. 单纯在 show 前加延时也不行（试过 300ms 宽限，仍差 5.3s）——阻塞随后就到。
- **修复（四处，缺一不可）**：
  1. `createWindow` 改 `show: false`（`main.ts`）：窗口建立后**先不显示**，`show` 由启动链决定时机。
  2. **新增 splash 上屏回执通道** `IPC_BOOT_SPLASH_READY`（`ipc-contract.ts` + `preload.ts` 暴露 `window.forge.splashReady()` + `main.ts` 注册 `ipcMain.on`）：由**渲染进程自己**在 `index.html` 内联脚本里走**双 rAF** 后回执——第一次 rAF 表示本帧样式/布局就绪，第二次表示已被提交，只有走满两帧才代表「真的画到窗口表面」。这是唯一不受主进程阻塞扭曲的信号。
  3. `waitForSplashPainted` 改为等该回执（`ready-to-show` 仅作退路），再留 300ms **不阻塞**宽限后 `win.show()`；超时（2500ms）照常 show，绝不让窗口永不出现。
  4. `webPreferences.backgroundThrottling: false`：隐藏窗口默认会节流定时器与 rAF，而回执正是在 rAF 里发出，不关掉会让回执迟迟不来。
- **验证（真机逐版对照，非推断）**：

  | 版本 | 窗口显示时刻 | 结果 |
  | --- | --- | --- |
  | v3.78.6（仅底色跟随主题） | ~800ms（默认 show） | 空文档白帧可见 |
  | 初版：`show:false` + `did-navigate` + 200ms | 277ms | 提交 ≠ 绘制，仍白 |
  | 二版：只等 `ready-to-show` | 1206ms | 实测仍早于首帧提交 |
  | 三版：额外 300ms 宽限 | 1507ms | 与首帧仍差 5.3s |
  | **终版：渲染进程双 rAF 回执** | **回执 474ms → show 774ms** | **渲染进程自证已绘制两帧并提交** |

  终版 `forge-core 就绪 5956ms` —— 窗口在重活开始前就已带着 splash 显示出来。回执时刻由渲染进程自己数帧得出，不受主进程阻塞对 `performance` 计时的影响，这也是终版**不再**拿 `first-contentful-paint` 当判据的原因。
- **排查中确立的两条可复用事实**（已写入 `MEMORY.md`）：
  1. **`npm run dev`（`scripts/dev.js`）的 userData 是 `%APPDATA%/Electron`，而直接 `electron.exe <目录>` 的是 `%APPDATA%/@forge/desktop`**——两者 localStorage 与镜像都不共享。启动链真机实验必须用 `--user-data-dir` 明确指定，否则测的不是用户场景。
  2. **屏幕像素采样在本机不可靠**：`Add-Type` 被安全策略拦截、PowerShell 进程未声明 DPI aware（本机 DPR 1.75，`Screen.Bounds` 报 1463×915 而 `CopyFromScreen` 走物理像素），且 WorkBuddy 自身窗口会遮住采样点。改用「主进程日志 + CDP 读渲染进程计时」这条纯数据路径。
- **回归**：forge-desktop 单测 **246/246**、`tsc` 0 错、forge-ui `vue-tsc` 0 错；e2e `bootSplash` + `bootGate` + `landingHero` **9/9**（新增回执脚本在纯浏览器环境走 `mock-bridge` 空实现，不产生 console error）。
- **未改**：`BootWelcome.vue` 顶部那行过期注释（该文件是用户手改在途）。

## v3.78.6 (修复：暗色主题下冷启动第一帧仍是白 —— 主进程建窗底色跟随主题 + 去掉 .content 左分隔线)

- **用户反馈**：「第二点需要，不然一开始还是白色」——即 v3.78.5 列出的遗留项（`createWindow` 的 `backgroundColor` 固定亮色）纳入本次；另「`.content` 得左 border 去掉」。
- **根因（与 v3.78.4 / v3.78.5 同源，第三次发作）**：`BrowserWindow.backgroundColor` 只能在**建窗时刻**给，而那一刻渲染进程一行代码都还没执行（v3.76「窗口先行」之后，这段底色就是用户看到的第一帧）。主题的唯一事实来源却是渲染进程的 `localStorage['forge:theme']` —— 主进程在 `app.whenReady()` 里读不到，于是暗色主题下第一帧恒为亮色。
- **修复（主进程侧主题链路，新增 4 处）**：
  1. **`packages/forge-desktop/src/theme.ts`（新增）**：userData 下的镜像文件 `forge-theme.json`（`{ "mode": "light"|"dark" }`），`readThemeSync` / `writeTheme`（**tmp + rename 原子写**，同 forge-store / piModelsFileAdapter）/ `isThemeMode` 取值守卫 / `THEME_BACKGROUND` 底色表。模块刻意**不 import electron**（纯 fs/path），可在 `node --test` 下直测。命名空间独立于 `forge-store.json`：主题是壳层窗口属性，不该被 store 的 schema 与迁移牵连（同 `updater-debug.json` 口径）。
  2. **新 IPC `forge:theme:set`**（`ipc-contract.ts` + `preload.ts` 的 `window.forge.theme.set`）：单向 fire-and-forget。主进程收到后落盘（供下次冷启动建窗取用）**并就地 `setBackgroundColor` 刷新当前窗口**，使「窗口底色 == 当前主题」在运行期也恒成立（改完不重启不留旧底色）。载荷经 `isThemeMode` 校验，非 light/dark 一律忽略。
  3. **`main.ts`**：`whenReady` 里 `readThemeSync(app.getPath('userData'))` → `createWindow(isDev, theme)` → `backgroundColor: backgroundFor(theme)`；新增一行可 grep 的启动诊断 `[boot] 建窗底色 theme=… bg=…`，`bg` 取 `win.getBackgroundColor()` **回读**值（避免「传了但没生效」无人察觉）。
  4. **`useTheme.ts` 的 `apply()`** 追加回写主进程。**localStorage 仍是唯一事实来源**，主进程那份只是缓存 —— 所以 `load()` 也会回写一次，镜像被清/损坏时下一次启动即自愈。浏览器 dev/e2e 走 mock-bridge 空实现，通路全部静默容错。
- **底色取值与设计令牌同源**：`--background` 由 `oklch` 换算为 sRGB —— light `oklch(1 0 0)` = `#ffffff`、dark `oklch(0.26 0.006 286.2)` = `#242427`。**顺带改掉原 `#f6f8fa`**：v3.78.5 起 splash / BootWelcome 走 `var(--background)`，浅色档已是纯白，主进程若仍用 `#f6f8fa`，「窗口底色 → splash」交接口会有一道色阶；三处同源后这一帧序列完全无色变。
- **`.content` 去掉 `border-left: 1px solid var(--border)`**（`App.vue`）：侧栏与内容区之间不再有分隔线。
- **验证（真机，非推断）**：
  - **真机 Electron 两次启动实测**（`--user-data-dir` 指向临时目录，prod 链路加载 `dist/index.html`）：首启无镜像 → `[boot] 建窗底色 theme=light bg=#FFFFFF`；随后**经 CDP 在真实渲染进程调用 `window.forge.theme.set('dark')`** → 镜像文件落盘 `{ "mode": "dark" }` → 再启动 → `[boot] 建窗底色 theme=dark bg=#242427`。即「渲染进程 → IPC → 落盘 → 下次建窗底色」整条链路在真机上闭环。
  - **新增 `test/theme.test.ts`（5 条，forge-desktop 单测 241 → 246）**：读写往返 / 缺文件 / 半截 JSON / 取值非法 / mode 类型错一律回 light；写入不留 `.tmp`；`isThemeMode` 守卫；IPC 通道名唯一。
  - **反漂移断言**：直接从 `forge-ui/src/design-tokens.css` 解析 light/dark 两档 `--background` 的 `oklch` 值、自行换算 sRGB 与 `THEME_BACKGROUND` 逐通道比对 —— 改令牌不改 hex（或反之）立刻红。**反证实测**：故意把 dark 改成 `#24242a` → 用例红并打印 `theme.ts=#24242a vs design-tokens.css→sRGB=#242427`，随后已还原。
  - 回归：forge-desktop **246/246**、forge-ui 单测 **264/264**、forge-desktop `tsc` 0 错、forge-ui `vue-tsc` 0 错；`vite build` 后复核产物（镜像调用已在 `dist/assets/index-*.js` 中，`.content` 规则已无 `border-left`，全仓 CSS `border-left` 计数 0）。
  - **e2e 全量：103 passed / 13 failed，13 条全部与本改动无关（已用 A/B 对照排除）**。13 条 = 既有基线 4 条（branchBadge PM-E2E-006 / PM-E2E-008b、session SESSION-E2E-001、smoke）+ 树上已在的 9 条：`__repro-subagent-bar`（读 `__forgeMock.setSessions` 为 undefined）、`conversationHistoryLocate` E-CV-009、`mw-restore` ×2（贴边矩形 `{0,0,475,570}` vs 期望 `{4,4,471,562}`）、`queue` QC-001/QC-003、`todoPanel` TSC-E2E-009b（头部与输入框重叠）、`updater` E-IN-001/002（期望 `0.2.0` 实得 `v0.2.0` —— 版本号前缀的显示变更）。**排除手法**：把 `.content` 的 `border-left` 临时加回去、只跑这 6 个 spec，**9 条照旧全红** ⇒ 与本改动无关（重新加回前后均红，随后已还原为无边框）。这些多与工作区在途改动（`TitleBar.vue` / `global.css` / `App.vue` / 设置页版本号格式）相关，留给对应改动收口。
- **关闭** v3.78.5 的遗留项（主进程底色不再固定亮色）。**未改**：`BootWelcome.vue` 顶部注释仍写「样式与 App 底色 #f6f8fa 对齐」（该注释已过期，但文件是用户手改在途，未触碰）。

## v3.78.5 (修复：深色主题下欢迎页仍是亮色 —— index.html 同步引导 data-theme + 欢迎页调色板走令牌)

- **用户反馈**：「主题是黑色的时候欢迎页也要是暗色」。
- **根因**：与 v3.78.4 同一个根——splash 抢在模块链之前上屏，而**全站唯一设置 `data-theme` 的 `useTheme.ts` 要等 `main.ts` 的模块链才执行**（grep 复核：全仓 `setAttribute('data-theme')` 仅此一处）。于是 splash 的整个展示窗口期 `data-theme` 为空 → 暗色主题下欢迎页跑亮色档，`useTheme.ts` 一执行立刻变暗（先亮一下再变暗）。`BootWelcome.vue` 上一轮已改为消费令牌（`--background` / `--foreground` / `--border` / `--muted-foreground`），只有 splash 还硬编码亮色。
- **修复（两处）**：
  1. `index.html` `<head>` 增加**同步**引导脚本（特意不写 `type="module"`：module 是 deferred，赶不到 splash 之前；且它排在 head 的 `<link rel="stylesheet">` 之前，不会被待加载样式表阻塞），读 `localStorage['forge:theme']` 落到 `<html data-theme>`；取值与默认值与 `useTheme.ts` 严格一致，无存储则**不设属性** = light（不跟随系统）。注意这是 `<head>` 内联脚本，非 CSP 受限场景（全仓无 CSP 配置）。
  2. splash 配色改为镜像 `BootWelcome.vue` 消费的那四个令牌，写「**令牌 + 字面兜底**」：`--welcome-bg: var(--background, oklch(1 0 0))`，暗色档在 `:root[data-theme='dark']` 给对应字面兜底。兜底值与令牌值逐位相同 → **CSS 到位前后无任何色变**，且与 BootWelcome 由构造一致、不会漂移。
- **顺带消除的亮色不一致**：`BootWelcome.vue` 走 `--background` 后浅色档是纯白，而 splash 仍是 `#f6f8fa` → 接管瞬间有一道色阶。现两处同为 `var(--background)`，浅色档 splash 由 `#f6f8fa` 变纯白（这是设计令牌的定义，非另行选色）。
- **验证（红→绿，非推断）**：`e2e/bootSplash.spec.ts` 扩到 3 条。
  - BOOT-SPLASH-002：模块链冻结时断言 `data-theme === 'dark'`（证明是同步脚本生效、不是模块链补的）且暗底亮字；**反证实测**：把同一份 index.html 的引导脚本剥掉后由 route 顶替（localStorage 仍为 dark）→ `data-theme=null`、底色 luma 0.9999（纯白），与用户报的现象一致。
  - BOOT-SPLASH-003：冻结门闩把 `BootWelcome` 留在屏上，断言同为暗色（splash → BootWelcome 不闪亮）。
  - BOOT-SPLASH-001：补亮色档断言（luma>0.85 + 深字）+ 原 v3.78.4 几何断言。
  - **测试自身抓出的空转**（首轮红）：原先读容器元素的 `color` 断言前景色——容器没声明 `color`，读到的是继承值（恒 `rgb(0,0,0)`），亮色档因此假绿。改为读标题元素（`.splash-name` / `.boot-name`）。另：颜色一律经 canvas 归一化为 sRGB（`getComputedStyle` 对 `oklch()` 的序列化形式不稳定），且必须查 alpha 不透明（变量解析失败是透明，只看亮度会把「无色」误判成「暗色」）。
  - 回归：bootSplash **3/3**、bootGate **3/3**、landingHero **3/3**、tooltip **2/2**、单测 **264/264**、vue-tsc 0 错；`vite build` 后 grep 复核 `dist/index.html` 保留引导脚本与两组令牌变量。
- **遗留（未改，需确认）**：主进程 `createWindow` 的 `backgroundColor: '#f6f8fa'` 是固定的亮色——它在「窗口存在 → 文档提交」这不到 1s 的窗口里显示，暗色主题下仍是一瞬亮闪。要彻底消除得让主进程也拿到主题（`useTheme` 落盘到 `userData/forge-store.json`，按 `readLastProjectPathSync` / `readUpdateDebugEnabled` 的既有模式同步读取），涉及新 IPC 与存储字段，未纳入本次改动。

## v3.78.4 (修复：欢迎页右侧滚动条 + 四周 8px 白边 —— splash 自带最小 reset)

- **用户反馈**：「欢迎页右侧有滚动条」（截图：灰色 splash 外圈 8px 白边 + 右侧滚动条）。
- **根因**：这是 v3.78.1「splash 内联进 `index.html`」的代价——**它上屏的那一刻全站样式还不存在**。用户跑的是 `npm run dev`（实测：51731 端口 vite 被 `electron.exe` 的 NetworkService 子进程连接，主进程走 `loadURL(FORGE_DEV_SERVER_URL)`），Dev 下 `global.css` 由 `main.ts` 的 import 在**模块执行期**注入，而 splash 的整个展示窗口期（冷编译数秒）跑的是浏览器默认样式：`body` 默认 `margin: 8px` → `height: 100vh` 的 splash 把文档撑高 16px → 垂直滚动条 + 四周白边。（Prod 链路无此窗口：`dist/index.html` 的 CSS 是 head 里的 render-blocking `<link>`。故此为 Dev 现象，但修复对两条链路都成立。）
- **修复**：`index.html` 的 splash `<style>` 块前置最小 reset（`html, body { margin:0; padding:0; height:100%; overflow:hidden }` + `#app { height:100% }`），与 `global.css` 的 reset 同值——全局样式接管后零行为差异，splash 不再依赖它。
- **验证（红→绿，非推断）**：新增 `e2e/bootSplash.spec.ts` BOOT-SPLASH-001，用 `page.route` 把 `/src/main.ts` 换成等价空模块（200 正常响应、不产生 console error）**冻结在「splash 已上屏、全站 CSS 未注入」状态**——即 Dev 冷编译窗口期的真实状态。修复前实测失败于 `body margin-top=8px`；修复后通过（body margin / 文档溢出 / splash 矩形在一次 evaluate 内原子取）。回归：bootGate **3/3**、landingHero **3/3**、forge-ui 单测 **264/264**、vue-tsc 0 错；`vite build` 后产物 `dist/index.html` grep 复核内联 reset 完整保留（未被构建流程吞掉）。

## v3.78.3 (样式：用户气泡整组改 command chip —— 纯黑底 + 白字技能名 + 白底深字「技能」胶囊)

- **用户反馈**（两轮）：
  1. 「改成黑底，技能就有点丑，要不也改成白字吧」——`MessageCard.vue` 用户气泡恒为 `#3a3a3d` 暗底（light/dark 双主题均不切换），技能名/标签走青瓷绿 `--brand-accent` 配暗底对比度不足。
  2. 「整个都改，不是只改技能两个字，技能的名字 + 技能2个字 + 技能的背景标签都要改」——不只是补丁 技能 两字，整组（气泡 + 技能名 + 技能胶囊 + 胶囊背景）需要一致重构。
- **改动**（`MessageCard.vue`，三项一起动，整组定调为 command chip）：
  1. `.msg-user .msg-bubble` `background: #3a3a3d` → `#0f0f10`：气泡更深更纯，去掉偏暖的灰调。
  2. `.msg-cmd-name.is-skill` `color: var(--brand-accent)` → `#ffffff`：技能名「Git Push All」加粗白字，不再走青瓷绿。
  3. `.msg-cmd-tag.tag-skill` `color: #ffffff` + `background: color-mix(... 22%, transparent)` → `color: #0f0f10` + `background: #ffffff`：「技能」胶囊改为白底深字实色 pill，与气泡「深色反白」形成 chip 质感。
- **影响范围**：仅用户消息气泡内「命令名 + 来源标签」美化段（`/skill:xxx` 发送后渲染态，pi 展开持久化形态同理）；技能名去青瓷绿仅限气泡内，与斜杠浮窗 `.slash-tag.tag-skill`（中性 `--brand`，浅底场景本来就清晰）解耦。
- **后续微调**（用户反馈「比参考图还黑」）：气泡背景 `#0f0f10` → `#3a3a3d`（与参考气泡同色），技能名/胶囊的 chip 改版不变。
- **验证**：forge-ui **264/264**、vue-tsc 0 错；tsc 后 dist 符号 grep 复核（`.msg-cmd-tag.tag-skill` / `.msg-cmd-name.is-skill` / `.msg-user .msg-bubble`）。

## v3.78.2 (修复：白屏真正根因 —— 主进程同步占死导致 splash 文档 4s 未提交)

- **用户反馈（真机 v3.78.1 后）**：「没解决，我看到还是白屏」。逐帧实测真机（CDP `Page.startScreencast` 录制 + 主进程时间戳对齐）拿到铁证：**窗口 0.6s 就存在，index.html 的文档直到 4.7s 才提交，中间 4s 画面只有 BrowserWindow 底色**；splash 一旦提交就正常显现并一路盖到 Vue mount。
- **根因**：Electron 的 **Node 事件循环与 Chromium UI 线程是同一个线程**。`loadURL` 之后紧接着的 core 组装（pi SDK 同步求值 ~1.2s）+ 预热（jiti 同步编译 ~2.4s）把渲染进程的创建与导航提交一起卡住——splash 虽然内联在 index.html 里，但**文档提交前它根本不存在**，v3.78.1「只要写进 HTML 就能盖住」的假设在这段失效。
- **修复**：新增 `waitForSplashPainted(win, SPLASH_PAINT_MAX_WAIT_MS=2500)`，`registerShellIpc` 之后、core 组装之前先等 splash 提交并留出绘制窗口，之后主进程才放开手做同步重活（冻结全程被已上屏的 splash 盖住，动画在合成线程不受影响），实测门闸耗时 **837ms**。
- **信号选型（重要教训）**：必须用**浏览器进程侧**的 `did-navigate`（导航提交），不能用任何渲染进程侧信号——此时渲染进程正忙于执行 Vite dev 的整条模块链：`dom-ready` 被 DOMContentLoaded（`<script type="module">` 是 deferred）拖到 **10.5s**，`executeJavaScript` 单次 evaluate 被拖到 **5.9s**，两者都会让门闸退化成超时等待。
- **验证**：真机复测文档提交从 **4355ms → 941ms**、splash 上屏从 **4706ms → 1861ms**，首屏录制帧连续可见 splash（非纯底色）；forge-desktop **241/241**、forge-ui **264/264**、vue-tsc 0 错；tsc 后 dist 符号 grep 复核（`waitForSplashPainted` / `SPLASH_PAINT_GRACE_MS` / `did-navigate`）。

## v3.78.1 (修复：欢迎页白屏空窗 —— index.html 内联静态 splash，毫秒级可见)

- **用户反馈（真机 v3.78 后）**：「欢迎页没有文字白屏很久，然后突然一下闪出一个字，就进去了」。归因：`index.html` 的 `#app` 是空的——HTML 加载完（毫秒级）到 Vue mount 之间（dev 冷编译模块链 2~4s+）窗口里只有 BrowserWindow 底色（截图即纯灰白）；而主进程 boot.ready（core ~2.4s + 预热 ~5s ≈ 7.4s）比 Vue mount **更早**就绪，欢迎页一挂载拉 `bootState` 即 ready:true 立即放行 → 欢迎页仅闪现一瞬。两个问题同根：欢迎页（BootWelcome.vue）是 Vue 组件，**自己也要等模块链加载完才能显示**——反馈 UI 依赖被反馈的加载本身，鸡生蛋。
- **修复**：`index.html` 的 `#app` 内内联静态 splash（logo SVG + Forge 字标 + spinner + 固定文案「正在准备运行环境…」，纯 HTML/CSS 零 JS，HTML 一加载即渲染）；视觉参数逐一照抄 `BootWelcome.vue`（底色 #f6f8fa / gap 14px / 22px 700 字标 / 22px 0.9s spinner / 13px 文案）。Vue `createApp(App).mount('#app')` 用渲染结果整体替换 `#app` innerHTML（App.vue 为 SFC 自带 render，容器内容不会被当模板），splash 自然消失、BootWelcome 无缝接管。改后时间线：t≈0.1s splash 可见 → Vue mount 接管轮换文案 → boot.ready 放行进正式界面，白屏空窗归零。
- **验证**：bootGate e2e **3/3**（attachHealthGuards 无 pageerror，真实浏览器加载新 index.html 无错）。

## v3.78 (性能：预热挪进欢迎页窗口期 —— 消除「首次点会话后切换卡 4s」的冻结暴露)

- **用户反馈（真机 v3.76 后）**：「第一次点击会话就出现了 `[warmup] 开始预热 pi 扩展加载（触发：首个会话历史已下发）`，然后切换其他会话的时候就会卡」。归因：v3.75 把预热触发点挂在「首个 queryHistory 返回后」，注释假设「渲染忙渲染、主进程承接冻结，两成本重叠」——但该假设建立在窗口化**之前**（渲染 4.3s ≈ 预热 5s）；v3.75 窗口化落地后首帧只渲染 24 项仅 **0.5s**，重叠只盖住 0.5 秒，剩余 **~4.5s 冻结完全暴露**，用户看完第一眼切换会话的 `queryHistory` IPC 在主进程排队到预热结束才被处理。卡的不是渲染（缓存/窗口化都在生效），是 IPC 排队。
- **修复（方案 A，用户拍板）**：预热挪进欢迎页窗口期——core 组装完成后立即用 **store 里最近打开的项目路径**（`readLastProjectPathSync`，轻量 JSON.parse，失败/无项目返回 null）预热，`boot.ready` 等 `Promise.race([预热, PI_WARMUP_MAX_WAIT_MS=9s])` 后发送。冻结全程被欢迎页盖住（欢迎页动画纯 CSS 不受主进程冻结影响），渲染端进入正式界面时扩展加载已暖，点会话/切会话不再撞冻结。9s 上限保证正常路径先于渲染端 10s 逃生放行（`App.vue BOOT_GATE_TIMEOUT_MS`）；`warmPiResourceLoader` 内部 catch 全部异常（正常 resolve），race 不会悬挂。
- **fallback 保留**（幂等，`startWarmupOnce` 一次性闸门：无 cwd 时不置位）：`project.opened` 更新 warmCwd + 15s 兜底 + queryHistory 包装，覆盖「store 无项目的首次启动」场景。
- **BootWelcome.vue 适配**：预热使欢迎页常态时长从 ~2.7s 变 4~7s——轮换文案四档、节奏 900ms→1600ms（「正在准备运行环境 → 正在加载 AI 引擎 → 正在准备会话引擎 → 马上就好，可能还需几秒」）。
- **验证**：forge-desktop **241/241**、forge-ui **264/264**、vue-tsc 0 错；tsc 编译后 dist 符号逐个 grep 复核同步（`readLastProjectPathSync`/`PI_WARMUP_MAX_WAIT_MS`/`bootState`）；bootGate + 问卷 e2e 回归通过。

## v3.77 (UI：零项目落地页改版 —— 旧「选择项目」卡片替换为与会话空态同款的「水印 + 居中输入框」hero)

- 用户反馈（真机 v3.76 后）：「怎么还会有右侧对话框的这个页面，不是已经都改成水印+输入框居中的那种形式了嘛」——截图为零项目启动落地页（`App.vue` 旧 `no-session` 卡片：水印 + "选择项目或创建新项目开始" + "打开项目"按钮）。定位结论：**不是回归**——v3.6x 的 hero 改版只覆盖「项目已打开」的会话空态（ConversationView conv-hero）与多窗口空窗欢迎页，「零项目」走的是 App 顶层另一条 `v-else` 分支，从未纳入改版范围。触发条件唯一：项目列表为空（`loadProjects` 启动时自动打开第一个项目，有项目就看不到这页）。
- **改版方案（用户选定：完整 hero 形式）**：
  - 新增 `components/LandingHero.vue`：forge 字标（参数照抄 `.conv-wordmark`：mono 600 / -0.05em / opacity .14 / `min(26cqw,180px)` + 下缘蒙版渐隐）+ 居中 InstructionInput（`session-status="idle"`、无 sessionId 的标准草稿态，宽度同 hero-mode `min(640px,100%)`）。挂载即聚焦。
  - **零项目项目区**：`App.projectPicker` computed 在 `projects.length===0` 时返回 `{ mode:'draft', currentPath:null, currentName:'打开项目', items:[] }`（`currentPath:null` 本就是类型既有的「未选归属」草稿语义）——输入框项目区只有「打开项目…」入口；该分支只在落地态被 LandingHero 消费，会话分支不渲染，不影响其他使用点。
  - **草稿直通（send→先选目录）**：落地态发送 = 打开目录选择器；文本在 LandingHero 内三重保全——发送时 `sentCarry` 暂存 + `restoreQueuedText` 视觉回填（取消选目录不丢字）+ 卸载（onBeforeUnmount）时 `getText()||sentCarry` 经 `carry-text` 上抛。App 侧 `landingDraft` 暂存，`watch(currentProjectPath, {flush:'post'})` 在分支切换完成后经 **`ConversationView.restoreDraft`**（新增 defineExpose，仅草稿态接受）回填项目视图草稿输入框，随后立即清空——只对「落地→第一个项目」这一次挂载生效，设置页往返不复活旧文本。时序要点：carry 在 patch 中的卸载钩子里落账，post-flush watcher 晚于组件更新执行，故 `await nextTick()` 后 convRef 必已就位。
  - `InstructionInput` 仅加一个只读 `getText` 暴露（3 行，零行为变化）；旧 `no-session*` 模板与样式整体删除。
  - mock-bridge 新增 `setProjects`（localStorage 持久化，空数组=零项目场景，reload 保留）+ e2e 助手 `seedProjects`。
- **验证**：forge-ui 单测 **264/264**、vue-tsc 0 错；新增 `e2e/landingHero.spec.ts` **3/3**（E-PM-LANDING-001 渲染/打开项目入口/旧卡片不复活；002 落地发送→选目录→开项目→文本直通草稿输入框；003 取消选目录文本保留）；相邻回归 heroWatermark/branchBadge/session/settings/inputHistory **26 过 3 失败**——3 条失败（PM-E2E-006 `.git-item` 3 vs 4、PM-E2E-008b `__conflict__` 分支缺失、SESSION-E2E-001 会话顺序）与 v3.72 记录的既有漂移逐字吻合，且全部处于「有项目」代码路径（本改动只在零项目分支生效），判定为既有问题非本次引入（真因排查仍挂账）。
- 待办：PRD 01 尚无落地页形态的正式 AC，后续如走 dev-flow 再补（AC 建议挂 PM-S02 前置空态）。

## v3.76 (性能+感知：欢迎页启动链 —— pi SDK 动态加载，窗口与欢迎页先行，core 就绪后自动进入正式界面)

- 用户提议（真机 v3.75 后）：「首次打开先跳一个欢迎页面，等不卡了再跳入正式页面」——采纳，且必须配套 **pi SDK 动态加载**（欢迎页渲染在窗口里，窗口若仍等 SDK 加载完才创建，欢迎页无从显示）。
- **主进程启动链重排**（`main.ts`）：
  - 实测占启动卡顿大头的 `createForgeCore` 静态 import（连带 pi SDK，~2.4s）与 `warmPiResourceLoader`（`./pi/createPiAgentSessionFactory.ts` 同样拖 SDK）全部改为**动态 import**，顶层仅留 `type MethodTable` 纯类型 import（零运行时代价）。其余 `pi/*`（appUpdater/startupUpdate/piRuntime/updaterState/keychainAdapter）经核实为轻模块，保留静态。
  - `app.whenReady` 流程改为：**createWindow + loadURL 先行**（窗口立即可见，渲染进程显示欢迎页）→ `registerShellIpc`（窗口控制/对话框/附件/文件等与 core 无关的 IPC + 新增 `forge:boot-state` 查询，立即注册）→ 动态 import 组装 core → `registerCoreIpc`（invoke 路由 + 事件转发）→ 改写 `bootState` 并向渲染进程推 `boot.ready` 事件。原 `registerIpc` 拆为这两个函数。
  - BrowserWindow 增加 `backgroundColor: '#f6f8fa'`（与欢迎页底色一致），消除 loadURL 渲染前的白屏闪烁。
  - 预热的 `startWarmupOnce` 改动态 import 触达 `warmPiResourceLoader`——到达时 SDK 已被 core 组装载入模块缓存，二次 import 零成本。
- **boot 门闩协议**（`ipc-contract.ts` + `preload.ts` + 渲染端）：
  - 新增 `IPC_BOOT_STATE`（`forge:boot-state`）与 `BootState { ready, startedAt, durationMs }`；`ForgeEvent` 联合新增 `'boot.ready'`——**不进 `FORGE_EVENTS` 数组**（那是 eventBus 转发注册表，core 未就绪时 eventBus 不存在），由 main 手动 send 一次。
  - **推拉双通道**防错过：渲染进程 mount 时先拉 `bootState()`（热重载/事件早于订阅场景），未就绪再订阅 `boot.ready` 事件；放行动作 `startPostBootInit()` 幂等。
- **渲染端门闩**（`App.vue` + 新增 `components/BootWelcome.vue`）：
  - `bootReady=false` 时整个正式 UI 不挂载（template 顶层 `v-if`），只渲染欢迎页（logo + spinner + 轮换文案，纯 CSS，零重依赖）；**同时挡住了启动期全部 `forge:invoke` 请求**（loadSessions/loadProjects/loadModels 包进 `startPostBootInit`）——此时 invoke handler 尚未注册，请求会报 "No handler registered"。子组件的 onMounted 请求也因不挂载而被天然挡住。
  - 事件订阅（session.removed 等）先于门闩挂载：订阅本身不发请求，早挂无副作用。
  - `mock-bridge.ts` 实现 `bootState()` 恒 `ready:true`——mock/e2e 场景欢迎页一帧即过，现有 e2e 全部不受影响。
- **验证**：forge-desktop **241/241**、tsc 0 错；forge-ui **264/264**、vue-tsc 0 错；e2e 与既有基线一致。
- **真机事故与修复（v3.76.1）**：真机首测卡死欢迎页——根因是 `preload.ts` 的 `bootState()` 方法编辑丢失未落盘（import 在方法不在），旧 dist/preload.js 无该方法 → 渲染端 `getBootState()` 抛 TypeError → 推/拉双通道全断 → 门闩永不放行。两笔修复：
  - **补回 `bootState()` 方法**并重编（dist 三处符号 `bootState`/`boot.ready`/`forge:boot-state` 全部核对同步）；
  - **渲染端逃生通道**（门闩绝不能是死门）：`getBootState()` 异常 catch 直接放行（旧主进程本就 core 就绪后才开窗口，放行正确）+ **10s 超时强制放行**（`BOOT_GATE_TIMEOUT_MS`，`startPostBootInit` 幂等 + 放行时清计时器）。
  - **新增回归锁 `e2e/bootGate.spec.ts`** 3 条：001 正常路径放行；002 逃生 1（init script 用 `Object.defineProperty` set 钩子拦截 `window.forge` **赋值瞬间**覆写 bootState 为抛错——`setTimeout(0)` 轮询会因 mock 注入在入口同步流而**假绿**，首版已踩）；003 逃生 2（恒 ready:false 无推送 → 5s 时反向断言门闩仍挡着 + 10s 超时放行，断言窗口 30s 防 vite 冷编译把计时器起点推后）。3/3 通过。
- **预期效果**：双击图标 → **<1s 见欢迎页**（原为白屏死等 ~2.7s）→ core 就绪（约 2.4s 处）自动切正式界面。总时长不变，但等待有反馈、窗口提前出现。

## v3.75 (性能：历史消息尾部优先窗口化 + 预热时机与渲染重叠 —— 首帧 4.3s → ~0.5s，启动冻结窗口消除)

- 用户反馈（真机 v3.73 后）：「感觉还是卡，首次加载大概有个 3 秒钟卡」——对应 v3.73 遗留的两段：**点会话冷渲染 ~4.3s**（LRU 只救二次点击，首帧 221 项仍全量同步挂载）与**启动后 1.5s 起的预热冻结窗口**（6s 内 IPC 全停）。
- **历史消息尾部优先窗口化**（`useSessionConversation.ts` + `ConversationView.vue`）：
  - 点击会话后用户第一眼在**底部**：首帧只挂载尾部 **24** 个展示项（`HISTORY_INITIAL_ITEMS`），向上滚动接近顶部（<240px）每批补 **16** 个（`HISTORY_STEP_ITEMS`），直至全量。首帧 4.3s → **~0.5s**。
  - 聚合结构（工具组 / 轮次 footer / 改动文件汇总）都在 `displayItems` 内基于**完整** msgs 计算完成，窗口只在展示层 `slice`，不会拆散任何组；流式新消息天然落在窗口尾。
  - **滚动锚定**：新批次插在内容区上方，浏览器默认保持 scrollTop 数值不变会视觉跳动——记扩窗前 `scrollHeight`，patch 后把差值补回。
  - **时间轴定位配套**：`locateMessage` 的 `.msg-user` DOM 序只覆盖窗口内消息，目标被截断时会 ordinal 错位——`expandHistoryWindowTo(index)` 先扩窗到「该消息起往后全挂载」再等 patch 定位。
  - 被窗口滑出再滚回的消息重挂载时，v3.73 的渲染 LRU **命中（≈0ms）**——窗口化与缓存互补：缓存治「重复渲染」，窗口化治「首帧全量」。
- **预热时机改造**（`main.ts`）：废弃「project.opened + 1.5s」固定延时（用户此时正在点会话/看历史，正好撞上 6s 冻结），改为**首个 `conversation/queryHistory` 响应完成后立即触发**——此刻渲染进程正忙渲染历史、主进程空闲，预热的同步阻塞与渲染**重叠而非叠加**；用户不点会话（草稿直发）由 **15s 兜底**（`PI_WARMUP_FALLBACK_MS`）保证首条发送路径总是暖的。包装方式与 createForgeCore 既有 `wrappedSendMessage` 同款（invoke 动态查表，包装生效）。
- **验证**：forge-ui **264/264**、vue-tsc 0 错；forge-desktop **241/241**、tsc 0 错；e2e `askUserQuestion/session/queue/todoPanel` 与既有基线一致（无新增失败）。
- **遗留**：窗口全量展开后 DOM 仍全量（未做真虚拟滚动）；pi SDK 主进程顶层静态 import ~2.4s 可改 dynamic import；预热本身 4.4~6s 的成本仍在，只是挪到了无感时刻。

## v3.74 (修复：删除会话改为真删磁盘残留 —— 此前 159 个转录文件永久留存 54.8MB)

- 用户反馈：「删除会话的时候我希望把会话真实删除，因为我觉得留着占空间之外没啥用」。
- **实测取证（本机）**：`~/.pi/agent/sessions/` 下 `forge-*.jsonl` 共 **159 个 / 54.8MB**，
  而 `forge-store.json` 只有 54 条会话记录 → **约 105 个会话删除后转录文件成为永久孤儿**；
  另 `%TEMP%/pi-subagents-0/` 亦积累 27MB。pi CLI 原生会话（`<ts>_<uuid>.jsonl`，65MB）不归 forge 管，未计入。
- **根因**：`forge-desktop/src/pi/piSessionAdapter.ts` 是占位桩 —— `deleteSession()` 直接
  `return Promise.resolve()`。删除链路（SessionService：stop → adapter.delete → store.removeSession）
  前两步都做了，**唯独磁盘文件从建项目起就没删过**；`piConversationAdapter.removeSession` 注释
  还写着「磁盘文件删除由 PiSessionAdapter 负责」，属于有约定无实现。API 契约
  （docs/api/02_session.md §3）本就写明「硬删 pi session（不可逆）」，此为实现缺口而非新需求。
- **修复**：
  - **新建 `piSessionPaths.ts`（路径单一定义源）**：`{agentDir}/sessions/{encodeURIComponent(cwd)}/forge-<id>.jsonl`
    的拼装此前在 `createPiAgentSessionFactory` 与 `createForgeCore.resolveSessionFile` 各写一份，
    删除要求「建/读/删」逐字节一致，收敛后三处共用；`tryResolveForgeSessionFile` 对非法 ID
    （历史脏数据）返回 null 跳过清理而非抛错（保证脏会话仍可删），同时充当路径越界防线（字符集校验后才拼路径）。
  - **`PiSessionAdapter.deleteSession(sessionId, projectPath)` 落地**：删转录 JSONL +
    整删该会话子 agent 输出目录（`resolveSubagentOutputDir`），父目录空则顺带清理；
    `fs.promises.rm` 带 `maxRetries/retryDelay` 兜 Windows 句柄延迟释放（force 忽略 ENOENT → 重复删除幂等）。
  - **接口加 `projectPath` 参数**（forge-core `PiSessionAdapter`）：仅凭 sessionId 推不出磁盘路径，
    由服务层从 store 记录取出透传；调用顺序保证**先清盘、后删记录** —— 适配器抛错（文件被占用等）
    时错误上抛 → RPC 5000 → 会话保留可重试。语义上「删除成功」从此严格等价于「磁盘已清」，
    杜绝「列表里没了、文件还在」的隐形残留。
  - **安全护栏**：只删 `forge-` 前缀文件（同目录共存的 pi CLI 会话绝不触碰）；
    删除运行中会话前先 stop 的既有校验不变；UI 双击二次确认不变。
- **验证**：forge-core **376/376**、forge-desktop **241/241** 单测通过（新增 7 条：真删 JSONL +
  子 agent 目录、兄弟 forge 会话/pi CLI 会话不误伤、空目录清理、幂等、非法 ID 跳过、
  失败上抛传播、projectPath 透传），`tsc --noEmit` 0 错。踩坑记录：本机 `fs.promises.rm`
  **会无视只读属性删除文件**，OS 级失败模拟不可靠 → 适配器加可注入 `remove` 端口做失败注入。
- 文档：`docs/api/02_session.md` §3 补「删除范围与失败语义」说明。
- **遗留（未做，待定）**：既有 ~105 个孤儿转录文件的清理未实现 —— 涉及用户家目录数据，
  需先确认哪些 store（Roaming/@forge/desktop、Roaming/Electron、Roaming/forge 三份并存）
  仍引用这些文件，建议做「按全部 store 记录求差集 + 二次确认」的一次性清理入口。

## v3.73 (性能：markdown 渲染 LRU 缓存 + highlight.js 按需注册 —— 点会话 5.1s → 二次 11ms)

- 用户反馈（真机）：TDZ 修复后会话树立即出现，但**首次进入 App 仍卡、点大会话要等一会才显示**。
- **先量化归因（临时脚本实测，跑完即删）**，两个独立根因：
  - **点会话卡 ≈ 5.1s（渲染进程主线程）**：`MessageCard.vue` 的 `watch(…, { immediate: true })` 使每个卡片 setup 同步跑一次 `renderMarkdown`（marked + **全量** highlight.js + sanitize-html，实测 23.3ms/条）；`ConversationView` 的 `v-for="item in displayItems"` 全量渲染、无虚拟滚动，221 条（5.86MB JSONL / 正文 2.7MB）一次性占满主线程。`resetForSession()` 清空 messages 且组件缓存随销毁丢失 → **每次点大会话都重付 5.1s**。IPC 链路无辜：主进程 `loadPiSessionHistory` 读 5.86MB 只要 51ms。
  - **首次进 App 卡 ≈ 2.4s + 6s 冻结窗口（主进程）**：`main.ts` 顶层静态 import pi SDK 整链 2.4s；`project.opened` 后延后 1.5s 触发的扩展预热（jiti）同步占满事件循环 —— 实测预热 4959ms 期间 10ms/1ms 定时器**一次都不触发**（理想 496/4959 次），即**事件循环 100% 停摆**，窗口内所有 IPC（点会话/切项目/发消息）排队。二次实测预热仍 4.4s：jiti 磁盘缓存（`%TEMP%/jiti`，342 文件）虽在，但大头是模块加载+执行+stat 而非编译，**每次启动都要付**。
- **本次修复（方案 1+4，用户拍板先做）**：
  - **渲染结果 LRU 缓存**（`forge-core/src/markdown/renderMarkdown.ts`）：`renderMarkdown(source, cacheable=true)` 增加内容寻址缓存（键 = 长度 + FNV-1a 32 位哈希 + 首/尾 48 字符采样，容量 400，Map 迭代序即 LRU 序）。不用完整原文做键，避免缓存间接持有几百份 12KB 级文本。**cacheable=false（流式中间态）只读不写**——否则一次长回复数百个中间态会把稳定态历史挤出缓存（`MessageCard.vue` 流式传 false，终态渲染正常入缓存）。即使键碰撞也不构成安全边界（XSS 由 sanitize 白名单保证）。新增 `renderCacheSize()` / `clearRenderCache()` 测试辅助。
  - **highlight.js 按需注册**：新增 `forge-core/src/markdown/hljsCore.ts`，从 `highlight.js/lib/core` 引入并只注册白名单 19 种语言；`renderMarkdown.ts` 与 `sideBySideDiff.ts`（diff 单行高亮）共享同一实例。语言别名（sh/shell→bash、yml→yaml、html→xml）在 `LANG_ALIASES` 归一，白名单外自动降级转义展示（与全量版行为一致，白名单本就刻意收窄）。
  - **实测收益**：import 278→**117ms**（-58%）；冷渲染 221 条 5146→**4255ms**（-17%）；**二次渲染（缓存全命中）5146→11ms（约 468 倍）** —— 切走再切回同一会话、同内容重复渲染（含 `AskUserQuestionPanel` preview 模板内直接调用）均命中。
- **遗留（已量化、未做，待排期）**：① 冷渲染首帧仍 ~4.3s，需虚拟滚动/懒渲染（只解析视口内）或 Web Worker 才能消除；② 主进程启动期 pi SDK 静态 import 2.4s 可改 dynamic import；③ 扩展预热的 6s 事件循环冻结，可考虑 utilityProcess 隔离（**前提是确认编译缓存跨进程复用，否则主进程首条消息仍要重付一次**）或推迟预热时机与渲染期重叠。
- **验证**：forge-core **376/376** 单测（新增缓存 3 例：命中一致 / 流式不写入 / LRU 上限+淘汰后冷渲染正确）、tsc 0 错；forge-ui **264/264**、vue-tsc 0 错；e2e `askUserQuestion.spec.ts` 回归通过（AskUserQuestionPanel preview 走同一条渲染链路）。

## v3.72 (修复：问卷面板 setup 崩溃打空整块对话区 + 补齐 CV-S12 浏览器级回归锁)

- 用户反馈（两条，真机试用 v3.71）：①「右侧对话框不显示了」；②「后台也报错」。
- **修复（真 bug：`showAnswered` 撞 TDZ，面板 setup 抛错连累整个对话区）**：
  - **现象**：左侧项目/会话树正常，**右侧对话区整块空白**（消息流、输入框、Todo 面板全无）。
  - **根因链**：v3.71 的「答完即收」watch 写在 `const showAnswered` 声明**之前**。Vue 的 `doWatch` 建 effect 时会**同步求值一次** getter 以收集依赖（**不需要** `immediate: true`），这次求值撞上 `const` 的 TDZ →
    `ReferenceError: Cannot access 'showAnswered' before initialization` → 组件 setup 抛错 → 渲染中断 → **整个 `ConversationView` 的更新失败**。
  - **为什么真机只看到无关报错**：终端里那两条 `ERROR:net\base\network_change_notifier_win.cc ... WSALookupServiceBegin failed with: 10108` 是 Chromium 在 Windows 上探测网络变化失败的无害告警（Electron 常见噪声），`[appupdater] 更新源未配置` / `[startup-update] [静默] 预设失败: pi-compact-display 内置引擎 CLI 不存在` 是 dev 环境的正常降级（内置引擎 CLI 只在打包产物里，dev 走不到 `pi install`，该路径设计上就是「静默保留旧标志」）。**三者都与本次空白无关**，真正的错误只在 Electron 渲染进程的 console 里。
  - **修复**：把「已答折叠态」的四个 computed（`answeredSummary`/`answeredTotal`/`answeredCountFinal`/`answeredHeading`）与三个开关（`showInteractive`/`showAnswered`/`visible`）及 `headingText` **整体上移到自动收起 watch 之前**，并在原处留下「顺序敏感、不要下移」的注释。
- **补齐 CV-S12 的浏览器级回归锁（本次真正堵住缺口的动作）**：E-CV-026/027 在 v3.69~v3.71 期间**只写在 `docs/test/03_conversation/e2e.md`，没有对应 spec 文件**（`forge-ui/e2e/` 下 grep 不到任何 ask 用例），于是 v3.69/v3.71 变更日志里那句「组件层无回归锁，E-CV-026/027 是唯一验证路径」实际上等于**没有验证路径** —— 这个 TDZ 崩溃就是这样漏到真机的。
  - 新增 `packages/forge-ui/e2e/askUserQuestion.spec.ts`（6 条，覆盖原设计的 E-CV-026/027 并新增 E-CV-028）：`ASK-E2E-001` 渲染/标题行操作条/末步才可提交/preview 固定 240px 与 1.4:1 分栏；`ASK-E2E-002`「自己答」单选互斥 + 多选并列 + 预览列表黑点在框内；`ASK-E2E-003` 0 答禁用提交 + 回填原始 label（多选自定义并入 `selected` 末位）+ 答完即收且迟到 `tool.completed` 不复活；`ASK-E2E-004` 读秒 >0 且递减 + 归零回填已答部分；`ASK-E2E-005` 非本会话问卷不认领；`ASK-E2E-006`（**新增 E-CV-028**）首屏对话区三件套渲染 + 输入框可用 + 无 pageerror。
  - 踩到的测试自身坑（已写进用例注释）：两次独立 `boundingBox()` 之间消息区会自适应滚动 → 绝对坐标漂移；改为**一次 `evaluate` 内原子取几何**，并只比「面板自身高度 / 预览相对面板的偏移」，不比绝对 y。
- **验证**：`forge-ui` **264/264** 单测、`vue-tsc` 0 错、新增 e2e `askUserQuestion.spec.ts` **6/6 通过**。**反向验证**：把 `showAnswered` 挪回 watch 之后（还原 v3.71 缺陷态）→ 6 条**全部变红**（`ask-panel` 与 `compose-box` 都找不到，正是真机「整块对话区空白」），挪回前面即 6/6 全绿。
- **另发现的既有问题（本次未修，与问卷无关，建议单独排期）**：全量 e2e 95 passed / **10 failed**，经核对均为既有漂移而非本次改动引入 —— `smoke.spec.ts` 断言的 `.workspace-brand` 在 `src/` 中**已不存在**（选器过期）；`updater.spec.ts` E-IN-001/002 断言 `0.2.0` 而 UI 现渲染 `v0.2.0`（`SettingsPanel.vue:807` 为 `v{{ upFoundVersion }}`）；`branchBadge`（`.git-item` 3 vs 4、`__conflict__` 分支缺失）、`mw-restore`（画布几何 4px vs 0px）、`queue`/`session`/`todoPanel` 各 1 条（hero-mode 几何、首条消息建会话、队列徽标）为环境/数据/顺序相关。这些用例与 ask_user_question 链路无任何代码交集，但**其中 `SESSION-E2E-001`、`QC-001`、`TSC-E2E-009b` 是否隐藏真实功能回归需单独确认**。
- 文档：`docs/test/03_conversation/e2e.md`（CV-S12 标题扩为 E-CV-026~028、新增 E-CV-028 设计段、标注落地 spec 与用例名、覆盖表加行）、`coverage-matrix.md`（新增 E-CV-028 行；AC-CV-043 的 E2E 列补 E-CV-028）、本变更日志。


## v3.71 (改进：问卷答完即收（自动折叠关闭）+ 空 payload 禁用提交)

- 用户反馈：「回答完了之后自动关闭这个窗口，回答完成就不需要了，AI 已经拿到答案了，关闭方式可以参考 todo，折叠关闭」。
- **答完即收**：提交后摘要（`已答 n/N · 答案摘要 [· 备注]`）只亮 `ASK_ANSWERED_AUTO_CLOSE_MS = 1500ms`，随后面板 `emit('dismiss')` → 父级清状态 → 复用既有 `ask-panel-hide` 过渡（淡出 + 下沉 + 折叠，240ms）整体卸载。对齐 TodoPanel 的「先收起、后隐藏」节奏。收起动作**由父级执行**（摘要的存续属于 composable 状态仓，组件自己藏起来的话切走再切回会复活）。
- **必须一起处理的 race（否则收起后会重新弹出）**：收尾是**乐观**的 —— `settle` 先落摘要，权威的 `tool.completed`（`applyCompletion`）随后才到；若只删表，迟到的权威摘要会把它写回去，面板就在用户眼前**重新弹出**。故状态仓新增 `suppressed` 集合：`dismissAnswered`（自动收起）与 `clearAnswered`（用户发下一条消息）都打标记，`answered` computed 统一兜住；新问卷 `accept` 时解除。
  - 顺带修掉一个既存缺陷：`clearAnswered` 原本只删表不打标记，同样会被迟到的 `tool.completed` 顶回来。
- **提交按钮在 payload 为空时禁用**（新增纯函数 `canSubmitAnswers`）：空 payload 落到扩展侧是 `DECLINE_MESSAGE` + `details.cancelled = true`，与用户点「取消」**完全同一条信号**。此前「0 答时点提交」与「点取消」无法区分，那条著名的 *"User declined to answer questions"* 就是这么来的。禁用后这条信号只能由显式取消产出（含「只填备注、一题未选」—— 契约 §2.1 里它同样走取消分支）。
- **唯一保留面板的情形**：`deliveryFailed`（用户点了提交、答案没送达扩展侧）→ **不自动收**，摘要留在界面上。否则答案静默消失、用户以为已答完，模型却只能等到超时拿 `DECLINE`，答案直接丢了。
  - 该标记必须**显式传递**而不是从 `cancelled && answers 非空` 推断：**超时归零**同样满足这个形状（已答部分会被主动回填、`cancelled` 为真），但那条路径答案是**送达成功**的 —— 误判会让「答了几题后挂机超时」留下永不收起的过期卡片，正是本次要消除的现象。故 `AskUserAnsweredState` 增加 `deliveryFailed?`，由 composable 按 `!payload.cancelled && !delivered` 置位。
  - `applyCompletion` 还必须**保留**该标记：权威 `details` 里没有这个本地判定，直接覆盖会把「答案没送出去」抹成一次普通取消。
- 实现位置：`utils/askUserQuestion.ts`（`ASK_ANSWERED_AUTO_CLOSE_MS` / `canSubmitAnswers` / `shouldAutoCloseAnswered` / `deliveryFailed` 字段）、`composables/askQuestionStore.ts`（`suppressed` + `dismissAnswered` + 权威覆盖时保留 `deliveryFailed`）、`AskUserQuestionPanel.vue`（`dismiss` emit + 收起定时器 + 按钮禁用 + `draftAnswers` 复用）、`useSessionConversation.ts` / `ConversationView.vue`（`dismissAskAnswered` 接线）。
  - 收起定时器监听 `showAnswered`（布尔）而非 `props.answered`（对象）：权威 `details` 会整体替换摘要对象，监听对象会让计时器被重新触发、消失时机随「权威结果何时到达」飘。
- **验证**：`forge-ui` **264/264**（252 → +12：纯逻辑 7 + 状态仓 5）、`vue-tsc` 0 错。**反向验证**：注释掉 `answered` 里的抑制判断 → 恰好「dismissAnswered 后迟到 completed 不得重新弹出」与「clearAnswered 同样抑制」两条**变红**、其余 11 条保持绿，证明锁定在与 bug 同一位置。
- 文档：PRD CV-S12 交互条目重写、新增 **AC-CV-050**（答完即收 + 空 payload 禁用提交）、AC-CV-043 措辞更新；`coverage-matrix.md` U-CV-022（函数清单与断言）、U-CV-025（抑制集与反向验证）、新增 AC-CV-050 行；`e2e.md` E-CV-026 新增「答完即收」与「提交按钮禁用」两组断言；`artifacts.json`、`test/index.md` AC 范围同步。

## v3.70 (修复：问卷预览内列表黑点落到框外 + 预览列收窄)

- 用户反馈（两条，真机试用 v3.69）：
  1. 「右侧预览的 ul、ol 的黑点在框外，让他显示在框内」；
  2. 「我觉得预览的这种是不是框可以窄一点」。
- 修复 1（**黑点在框外 —— 全局 reset 吃掉列表内边距**）：
  - **根因链**：`global.css` 有 `* { margin: 0; padding: 0 }` 通用重置，作者样式压过浏览器对 `ul/ol` 默认的 `padding-inline-start: 40px` → `padding-left` 变 0；而 `list-style-position` 仍是默认的 `outside`，黑点画在内容盒**左侧**，`.ask-preview-body` 只有 10px 内边距托不住 → 黑点落在 x ≈ 10 − 11.5 ≈ **−1.5px**，露在圆角框外（列表序号 `1.` 同样被切）。`MessageCard.vue:547` 当初正是靠显式 `padding-left: 0 + list-style-position: inside` 绕开同一个坑。
  - **修复**：`.ask-preview-body` 显式补回列表样式 —— `padding-left: 1.3em` + `list-style-position: outside`（保留悬挂缩进，换行文字与首行对齐）+ 嵌套列表不叠加外边距 + 末块不拖底部空隙。
  - **顺带修掉一个同源缺陷**：容器上的 `white-space: pre-wrap`（给纯文本预览用）会把 marked 输出中标记之间的换行空白节点渲染成换行 → 每两个列表项之间多出一整行空隙。列表容器恢复 `white-space: normal`，`li` 内部仍保留 `pre-wrap`。
- 修复 2（预览列收窄）：分栏比例 `1fr : 1fr` → **`1.4fr : 1fr`**（820px 面板下预览 390 → 325px，选项列 455px）。依据：分栏态下选项描述已被 `.ask-split .ask-option-desc` 隐藏，左列只剩选项名，不需要一半宽度。
- **验证**：`forge-ui` 252/252、`vue-tsc` 0 错；另用 Playwright 起探针页（抽真实 `.vue` scoped 样式 + 真实 `renderMarkdown`）在 Chromium 里实测：旧态 `ul` 内容盒距框内沿仅 10px、黑点 x ≈ −1.5px（框外），新态内容盒 24.9px（框内）；`ul` 高度 86px → 35px 证实空行消失；窄至 200px 预览仍不越界。

## v3.69 (修复：问卷面板倒计时恒显示 0（响应式缓存）+ 多选下「自己答」与选项并列)

- 用户反馈（两条，真机试用 v3.68）：
  1. 「多选的情况下，自己答可以作为其中一个答案，而无需把其他选项取消勾选」；
  2. 「右上角的读秒倒计时，现在一直是 0」。
- 修复 1（**倒计时恒为 0 —— 真 bug，computed 缓存了首屏空值**）：
  - **根因链**：面板挂在 `v-if="!showResultView"` 下，**常驻挂载**（首屏没有问卷也渲染）→ 此时 `askDeadline` computed 就求值一次，把 `undefined → null` **缓存**；而它依赖的 `askDeadlines` 是**普通 `Map`**（旁边三个表都是 `reactive`，唯独这个漏了）→ 后续 `set` 不产生依赖变更 → computed 永不重算 → 面板拿到的 `deadline` 恒为 `null` → `tick()` 里 `if (at === null) return` 每次直接返回 → `remaining` 停在初值 **0**。
  - **修复 a**：把四个会话级表 + 三个 computed 抽成 `forge-ui/src/composables/askQuestionStore.ts` 的 `createAskQuestionStore`（只依赖 vue 响应式原语，`bridge` 仅作类型引用），四张表统一 `reactive`。抽出来的目的是**可测** —— 组件层没有组件测试设施，这组状态原本零回归锁。
  - **修复 b**：`AskUserQuestionPanel` 增加 `watch(() => props.deadline)` 自愈兜底：只要拿到有效截止时刻就保证秒表在跑（`props.request !== null` 时），释放（提交 / `tool.completed`）时停表归零。防「某条路径只更新了 deadline」再次静默卡 0。
  - **回归锁 + 反向验证**：新增 `forge-ui/test/askQuestionStore.test.ts`（9 例），前两条专钉这个时序（先读一次 computed 缓存空值 → 再 `accept` → 再读）。**反向验证**：把 `deadlines` 改回普通 `Map`，恰好这 2 条变红、其余 7 条保持绿 —— 证明锁在了正确的位置。
- 修复 2（**多选下「自己答」与选项并列**）：原先三个地方把「自己答」写死成与选项互斥（`selectOption` 多选分支清 `custom`、`selectCustom` 无条件清 `selected`、`onCustomInput` 无条件清 `selected`），多选时只能二选一。现按题型分治：
  - **单选**：保持严格互斥（选选项即清文本，反之亦然）—— 契约 §2.1 的 `kind` 三态下 `custom` 优先于 `option`，残留文本会静默覆盖刚勾的选项。
  - **多选**：两者**并列**，勾普通选项不动「自己答」的文本，反之亦然；点「自己答」变成**开关**（收起只折输入框、**不丢文本**）。
  - **提交形态**：多选的 `custom` **并入 `selected` 末位**（与「自己答」行排末尾的视觉顺序一致），**不**另起 `kind='custom'` 条目 —— 对模型而言这仍是「一个多选答案」，多产一条会改变 `content.text` 的段数与 `<serial>` 语义。契约 §2.1 已补这一条（`selected` 本就是 `string[]`，未限定只能是选项 label）。
  - **选中态**：新增 `customRowSelected` —— 多选下收起输入框后文本仍在答案里，该行必须**保持高亮**，否则界面谎称「没选这一项」而提交的答案里却带着它。选项行文案随之区分（多选显示「可与其他选项同时选」）。
- 代码：新增 `forge-ui/src/composables/askQuestionStore.ts`、`forge-ui/test/askQuestionStore.test.ts`；`forge-ui/src/composables/useSessionConversation.ts`（四个表 + 三个 computed 改为调用状态仓，`onAskUserQuestionRequested` / `submitAskUserAnswers` / `onToolCompleted` 收敛为 `accept` / `settle` / `applyCompletion`）、`forge-ui/src/components/AskUserQuestionPanel.vue`（deadline watch + 多选并列 + `customRowSelected` + 选项行文案）、`forge-ui/src/utils/askUserQuestion.ts`（多选合并 custom 进 `selected`；`AskDraft.custom` 注释区分题型）、`forge-ui/test/askUserQuestion.test.ts`（+3）。
- 文档：契约 §2.1 新增「多选里的自定义答案」；PRD `03_conversation.md` CV-S12（业务数据指明状态仓与「必须 reactive」的告诫、交互条目区分单选互斥/多选并列、AC-CV-044 补多选自定义并入 `selected`、AC-CV-047 边界补「常驻挂载下仍须正常读秒」）；`test/03_conversation/coverage-matrix.md`（U-CV-022 补多选并存断言、新增 U-CV-025 状态仓回归锁、E-CV-026）；`test/03_conversation/e2e.md`（E-CV-026 多选并列、E-CV-027 读数必须 > 0）。静态示意稿 `prototypes/ask-user-question-panel-v2.html` 增用例 D（多选并列）。
- 验证：`forge-ui` 252/252 单测全绿（240 → +3 纯逻辑 + 9 状态仓）、`vue-tsc` 0 错；反向验证见「修复 1」。
- 已知缺口：组件层交互（选项行高亮、输入框展开/收起、按钮出现消失）仍无组件级自动化回归锁，E-CV-026 / E-CV-027 是唯一验证路径。
- 剩余风险：末步在 `已答 0/N` 时仍可提交，依旧落 `DECLINE`（等价取消）；要堵需「0 答禁用提交」或二次确认，尚未做。

## v3.68 (改进：问卷面板操作条上移标题行 + 单选自动前进 + 「自己答」折叠为选项 + preview 尺寸稳定)

- 用户反馈（四条，均来自真机试用 v3.67）：
  1. 右侧 preview 「样式会动会变形，要固定住，不应该跳来跳去」；
  2. 「选完一个 tab 页，自动切到下一个」，上一题 / 下一题 留给用户手动点；
  3. 按钮放顶部、「放到待回答左侧」（在「等待回答 · Ns」徽标左边），「已答」也上顶部，取消按钮同样上移；
  4. 「自己答太宽了，就作为一种选项」—— 不是什么时候都能选/常驻，选其他选项就不填、选了自己答才给填，整体压缩成一个选项。
- 修复 1（**preview 尺寸稳定**）：`.ask-preview` 由 `height:auto + max-height:260px` 改为**固定 `height:240px` + flex 纵向布局 + body 内滚动**，caption 也 `flex-shrink:0` + 单行省略。原因：preview 是各选项长短差很大的 markdown，高度随内容浮动时，hover 到不同选项会让整个分栏区、面板底部与下方输入框整体上下跳。**这是个易复发点，样式里已写明「不要改回 height:auto / max-height」。**
- 修复 2（**单选自动前进**）：新增纯函数 `shouldAutoAdvance(multiSelect, index, questionCount)`，`selectOption` 命中单选后调用。三条不前进：多选（前进等于打断继续勾选）、点「自己答」（要留输入时间，`selectCustom` 根本不调）、末步（无路可走）。抽成纯函数是为可单测 —— 组件层没有组件测试设施，规则写在 `selectOption` 里就只能靠 E2E 兜。
- 修复 3（**操作条上移标题行**）：底部 `.ask-actions` 整块删除，`已答 n/N` / 上一题 / 下一题 / 取消 / 提交答案 全部移入 `.ask-heading`（标题与状态徽标之间）。**结构坑**：原来整个头部是一个 `<button>`（点任意处折叠），里面再塞按钮就是非法 HTML 嵌套 → 头部改为 `div[role=button][tabindex=0]`（保留整行点击 + Enter/Space 折叠），操作条容器加 `@click.stop`，否则点「提交答案」会顺带把面板折叠掉。视觉层级：新增 `.ask-btn-mini`，并让「上一题 / 下一题」透明底降级，形成 导航 < 取消 < 提交 的权重。折叠时操作条随之隐藏。
- 修复 4（**「自己答」折叠为选项**）：删除原常驻虚线大卡片（`.ask-custom` / `.ask-custom-label`），改为选项列表**末位的一行**（复用 `.ask-option` 全套形态与 radio/checkbox 标记），选中才在分栏区**下方整宽**展开输入框（照抄 rpiv guideline：分栏时不挤进窄选项列）。展开态存组件内 `customOpenByTab`（按 tab 记忆），**不进 `AskDraft`** —— 它是纯 UI 展开态，「选中自己答但还没输入」不应计入「已答 n/N」，所以 `isDraftAnswered` / `buildAskUserAnswers` 等纯逻辑零改动。互斥收紧：**多选分支此前不清 `custom`**（`selectOption` 只在单选分支清），先输入自定义文本再勾多选会让 `buildAskUserAnswers` 的 custom 优先分支静默吃掉刚勾的选项 —— 本次一并修掉，两条分支都清空并撤销展开态。
- 代码：`forge-ui/src/components/AskUserQuestionPanel.vue`（头部重构 + 选项区重构 + CSS 三处；净增 `.ask-head-actions` / `.ask-btn-mini` / `.ask-option-custom`，删除 `.ask-custom*` / `.ask-actions*` / `.ask-nav` / `.ask-heading-toggle`）；`forge-ui/src/utils/askUserQuestion.ts`（+`shouldAutoAdvance`）；`forge-ui/test/askUserQuestion.test.ts`（+3）。
- 验证：`forge-ui` 240 单测全绿（237 → +3）；该包 typecheck 0 错。
- 文档：`prd/03_conversation.md` CV-S12 交互与反馈条目重写（操作条位置 / 自动前进 /「自己答」形态 / preview 固定高度）；`test/03_conversation/coverage-matrix.md` U-CV-022 补 `shouldAutoAdvance` 与断言、E-CV-026 重写；`test/03_conversation/e2e.md` E-CV-026 操作 / 断言 / 负向 / 汇总行同步（新增「点操作条按钮不得顺带折叠」负向断言）。
- **已知缺口（沿用 v3.67）**：组件层渲染与交互（按钮位置、自动前进、展开/收起）**无自动化回归锁** —— forge-ui 测试均为纯函数 `node:test`，无组件测试设施；E-CV-026 是唯一验证路径，真机观察与 E2E 才能覆盖。
- 剩余风险（仍未做）：末步仍可在 `已答 0/N` 时提交 → 依旧落 `DECLINE`（等价于取消）；自动前进使「选完即离开该屏」，想反复比对 preview 的用户需靠 hover 或点「上一题」回看（hover 仍会更新预览，未受影响）。

## v3.67 (改进：问卷面板改向导式步骤导航，「提交答案」只在末步出现)

- 用户反馈：多题问卷底部只有「提交答案」没有「下一步」，且提交后面板直接收起，希望是向导式流转。
- 澄清（不改的部分）：tab 本就是**并列表单分页**而非步骤条 —— 契约允许部分作答（未答题不产出 `answers` 条目），每屏可跳过/可回填/可乱序点，因此终点只需一个动作。原型也只有单个「提交答案」（`prototype.js:174`）；原型 HTML 里 `/* Submit tab */ .review-*` 那套审阅样式是**从未接线的悬空 CSS**（`prototype.js` 内搜不到「审阅」）。「提交后收起」也是既定生命周期：点提交 → 乐观折成已答摘要 → `tool.completed` 用权威 `details` 覆盖 → **下一条用户消息**才真正清掉，不是立即消失。
- **查出的真问题（本次改动动机）**：`已答 0/N` 时点「提交答案」与点「取消」对模型**完全等价** —— 零段 envelope 直接落到 `DECLINE_MESSAGE = "User declined to answer questions"`，且 `details.cancelled` 被置真（`extensions/src/askUserQuestion/envelope.ts:76-78`）。模型分不清「我点了提交」与「我点了取消」，而 `已答 0/N` 下按钮既不禁用也不改文案。这正是「提交了就关闭了、模型却说 declined」的来源。
- 修复：向导式步骤导航。
  - 步骤序列 = 题目 `0..N-1` + 末位「备注」tab，共 `N+1` 步；底部左侧新增「上一题 / 下一题」沿序列逐屏走，与点 tab 同路径（同样重置 hover 预览，避免上一题 preview 残留）。
  - **「提交答案」改为只在末步渲染** —— 中间步该按钮根本不存在，上述歧义路径被结构性消除。代价：部分作答者需走到末步才能提交（2 题问卷 = 2 次「下一题」）。
  - tab 仍可自由点击，顺序不强制；两种导航不冲突。
  - 单题场景无 tab 栏 → `stepCount=1` → 不出导航、提交按钮常驻（**行为与改造前一致**，零回归面）。
- 代码：`forge-ui/src/utils/askUserQuestion.ts` 新增纯逻辑 `stepCount / isLastStep / canStepPrev / canStepNext`；`AskUserQuestionPanel.vue` 新增 `stepPrev / stepNext` + `.ask-actions-left` / `.ask-nav` 布局（导航按钮刻意弱化配色与尺寸，不与「取消 / 提交答案」抢注意力）+ 组件头注释补向导语义说明。
- 验证：`forge-ui` 237 单测全绿（+5：步骤计数 / 末步判定 / 前后可用性 / 单题退化 / 末步互斥）；该包 typecheck 0 错。
- 文档：`test/03_conversation/coverage-matrix.md` U-CV-022 补入 4 个纯函数与导航断言、E-CV-026 补导航与「中间步无提交按钮」断言；`test/03_conversation/e2e.md` E-CV-026 的操作 / UI 断言 / 负向 / 汇总行同步。
- **已知缺口（如实记录）**：组件层渲染（按钮出现/消失）无自动化回归锁 —— forge-ui 测试均为纯函数 `node:test`，无组件测试设施（与 v3.66 同类缺口）；E-CV-026 是该行为的唯一验证路径，跑 E2E 前勿信单测。
- 剩余风险（本次未做）：末步仍可在 `已答 0/N` 时点提交 → 依旧落 `DECLINE`（等价于取消）。要彻底堵住需再补「0 答时禁用提交」或「未答满二次确认」，用户本轮只选了导航方案。

## v3.66 (修复：冷启动会话树延迟出现——pi 扩展预热不得在 openProject handler 内同步触发)

- 用户反馈：首次 app 启动后项目树已显示，但会话树一直空白，隔几秒才出内容。
- 根因（v3.46 首条消息卡顿修复的副作用）：`main.ts` 在 `project.opened` 上挂 `void warmPiResourceLoader(opened)` —— **`void` 只保证不 await，不保证不阻塞**。`resourceLoader.reload()` 的同步前缀（`SettingsManager.create` + `new DefaultResourceLoader` + jiti 首段模块解析，本机 10 个包实测 3~9s）是**在 `project/openProject` 的 RPC handler 内联执行**的（`rpc/projectMethods.ts` 在 handler 内同步 `emit('project.opened')` 之后才 `return`），于是把该请求**自身的 IPC 响应**也堵住：渲染进程卡在 `await call(...)` → `selectProject` 后面的 `loadSessions()` 根本没机会发出 → 会话树空白到编译结束。而项目已渲染是因为 `queryProjectList` 是纯 store 内存读、在 openProject 之前就返回了。
  - **放大器（结构原因）**：前端把 `loadSessions()` 串在 `openProject()` 之后，但 `session/querySessionList` 传 `{}` 返回**全部**会话、与打开项目零依赖 —— 两个本可并行的请求被写成严格串行。
  - **首启叠加**：`createStartupUpdate` 在 `preinstallDone=false` 时逐项 `pi install` 推荐组件（子进程 + 网络 + 磁盘），与冷编译抢 I/O，首次启动更明显。
  - 附注：pi 扩展模块缓存是 loader.js 的**进程内 Map**（按 cwd 记忆），跨进程全冷 → **每次冷启动都要重编译一遍**，不是"只慢第一次"。
- 修复（两处，均不触碰 pi 的缓存语义）：
  1. `forge-desktop/src/main.ts`：新增常量 `PI_WARMUP_DEFER_MS = 1500`，`project.opened` 改为 `setTimeout(() => void warmPiResourceLoader(path), PI_WARMUP_DEFER_MS)`，让启动关键路径（项目/会话列表 IPC，毫秒级）先跑完再预热。代价：预热完成时刻推迟同样时长，对首条发送无实质影响。
  2. `forge-ui/src/App.vue` `onMounted`：`void loadSessions()` 与 `void loadProjects()` **并行**发出，会话请求排到 openProject/预热之前落地。安全性已核实：会话树以 projects 为外层循环按 `projectPath` 分组（`ProjectTree.vue` `sessionsOf`），sessions 先到无副作用；且 `currentProjectPath` 无 watcher，不会重复触发。
- 验证：
  - `forge-desktop` 234 单测全过 + `forge-ui` 232 单测全过（合计 466）；两包 typecheck 0 错。
  - **新增 E2E 回归锁 E-SM-008**（`e2e/session.spec.ts` `SESSION-E2E-008`）：init script 抢在 mock 句柄赋值瞬间注入 `seed('project/openProject')` 延迟 6s + 会话种子，断言 `.tree-project` 先到、且 `.tree-session` 在 **2000ms** 内到位。**已实测 RED→GREEN** —— 仅回退 `App.vue` 那一行并行调用，`.tree-session` 在整个 2000ms 窗口内解析为 0 个元素、用例失败；恢复后 543ms 通过。测试文档同步 `test/02_session/e2e.md` + `coverage-matrix.md`。
  - 缺口保留：`main.ts` 侧改动（延后预热）仍无自动化覆盖（Electron 入口，不可单测）。
- **顺带发现（与本次修复无关，未改）**：
  - `SESSION-E2E-001` 在当前工作区**确定性失败**：期望 `.tree-session` 最后一行为新会话名，实得「已有会话」（数量断言 `toHaveCount(2)` 通过，失败在顺序断言）。已用「仅回退本次 `App.vue` 改动」做对照——**失败与本次改动无关**，属工作区既有问题（疑似新建会话进 activatedOrder 后置顶，与用例 `.last()` 期望不符），需另行定位。
  - `docs/test/02_session/e2e.md` 的 `E-SM-007` 与 `coverage-matrix.md` 的 `E-SM-007` **指向不同用例**（前者「多窗口窄窗格工具组」→ `mwToolGroupVisible.spec.ts`；后者 AC-SM-028~030 项目选择器 → `session.spec.ts`）。编号冲突，去留待裁定（同模块 07 双覆盖矩阵的同类问题）。
- 文档同步：`knowledge/pi-extension-cold-load.md` 新增「二次回归」一节（含可复用的排查判据"启动后某块 UI 空白数秒且后续操作正常 → 查是否有重活挂在启动关键路径的同步段上"），并给原「修复模式」条目加上警告——该触发点本身就是本次问题来源。
- 剩余风险：预热推迟 1500ms 后若用户在该窗口内就发首条消息，仍可能冷编译一次（与 v3.46 记录的「预热与首条发送几乎同时发生」同类）；根因（jiti 编译留在主进程）未动，根治仍需把 pi 会话运行时挪出主进程。

## v3.65 (功能：ask_user_question 内嵌问卷 + 自建内置扩展，移除 rpiv 推荐项)

- 需求：模型在多分支决策场景下频繁猜测，需要能在不确定时主动向用户确认（原型 `prototypes/ask-user-question-prototype.html`：内嵌输入框上方、N+1 tab、左右 preview、多选 checkbox、备注、已答折叠摘要、推荐标记）。
- 方案：**Path 2 —— forge 自建 pi 内置扩展**，而非接入 rpiv npm 插件。原因：rpiv 插件的完整 UX 依赖 `ctx.ui.custom()`，而该接口在 RPC 宿主恒返回 `undefined`（`rpc-mode.js` 文档原话），forge 走 RPC 通路只能降级到逐题弹窗（单选点按、多选打数字、无 preview、无备注），原型可还原度仅约 15%。自建扩展用 pi 官方 `registerTool` SDK + 照抄 rpiv 的业务契约（schema / envelope），可 100% 还原原型且完全可控。
  - **扩展层**（`packages/forge-extensions/src/askUserQuestion/`）：`schema.ts`（TypeBox 入参，1–4 题 / 2–4 选项 / label ≤60 / header ≤16）、`types.ts`、`validate.ts`（6 条校验规则）、`envelope.ts`（模型侧三段引导文本逐字照抄 + envelope 三形态）、`format-answer.ts`、`extension.ts`（注册 `ask_user_question` 工具 + 与 pi 解耦的纯逻辑核心）、`channels.ts`。**双阈值超时**：60s 下发面板驱动倒计时（归零由面板主动回填已答部分），extension 实际等 60s + 1.5s 兜底，避免「extension 先超时 → 已答部分丢失」竞态。
  - **传输层**：`conversation.askUserQuestionRequested`（事件，main→renderer，已登记 `FORGE_EVENTS` 白名单）+ `askUserQuestion/reply`（RPC 方法，renderer→main 唯一上行入口）+ `window.forge.askUserQuestion.{onRequest,reply}`。`sessionId` 为**必需字段**。
  - **会话隔离**（关键）：`bindAskUserBus` 按**每会话私有总线**订阅，`sessionId` 取自订阅闭包（无需从 `ctx.sessionManager` 反查）；回填经**该会话**总线投递，无 lease 返回 `delivered:false` 且零投递。防的是「N 窗格同时弹 N 份问卷」与错窗格回填 —— 多窗格画布（`MultiWindowCanvas.vue`，PRD 02 TD-SM-02 方案 A）下比「看不到问卷」更危险的是**无报错的错误数据进入模型上下文**。`removeSession` 退订，迟到请求不再上抛。
  - **UI 层**：`AskUserQuestionPanel.vue`（923 行，原型形态：tab / 左右分栏 preview / 多选 / 备注 / 已答摘要 / 倒计时）+ `utils/askUserQuestion.ts`（纯逻辑，可单测）+ `useSessionConversation` 按 `sessionId` Map 隔离的问卷态。
- **两处有意偏离 rpiv**（契约 §1.4）：① `preview` **不回流**给模型 —— envelope 不含 `selected preview:` 段（rpiv 回流是因 CLI 无面板被迫为之），`details.answers[].preview` 照常填充供 UI 面板渲染，省 token 且上下文干净；② 新增 `options[].recommended?: boolean` 扩展字段（原型有、rpiv schema 无），UI **双通道**识别：`recommended===true` 或 label **尾部** `(Recommended)` 后缀均渲染「推荐」徽标，后缀**仅显示层**剥离、回填 label 保持原始值（模型有很强的旧习惯，双通道才稳）。
- **冲突处置**：`recommendedPlugins.ts` 移除 `@juicesharp/rpiv-ask-user-question`（v1 清单 11 → 10）。运行时不靠「先注册者胜」的注册顺序赌运气，而在 `createPiAgentSessionFactory.ts` 注入 `extensionsOverride` **纯代码过滤**该插件 —— 不写用户 `settings.json`，`pi-subagents` / `rpiv-todo` 不受影响，系统 `pi` CLI 仍照常加载该插件（不同宿主，各自独立）。实测确认过滤语法：`extensions: ["-index.ts"]` ✅ 生效；⚠️ 文档 `docs/packages.md:212` 称 `extensions: []` 表示「load none」，**实测仍加载**（走 `collectDefaultResources` 分支），文档与实现不一致，已记档避坑。
- 代码：新增 `packages/forge-extensions/src/askUserQuestion/*`（8 文件）+ `packages/forge-ui/src/components/AskUserQuestionPanel.vue` + `packages/forge-ui/src/utils/askUserQuestion.ts` + `packages/forge-extensions/test/askUserQuestion/*`（3 文件）+ `packages/forge-ui/test/askUserQuestion.test.ts`；改 `forge-core/src/conversation/conversationService.ts`、`forge-core/src/rpc/conversationMethods.ts`、`forge-core/src/index.ts`、`forge-desktop/src/ipc-contract.ts`、`forge-desktop/src/preload.ts`、`forge-desktop/src/pi/piConversationAdapter.ts`、`forge-desktop/src/pi/createPiAgentSessionFactory.ts`、`forge-desktop/src/pi/recommendedPlugins.ts`、`forge-ui/src/bridge.ts`、`forge-ui/src/mock-bridge.ts`、`forge-ui/src/composables/useSessionConversation.ts`、`forge-ui/src/components/ConversationView.vue`、`forge-desktop/test/pi/piConversationAdapter.test.ts`、`forge-desktop/test/pi/startupUpdate.test.ts`。
- 依赖：`packages/forge-extensions` 声明 `"typebox": "1.3.7"`（**包名是 `typebox`，不是 `@sinclair/typebox`**；版本与 pi 0.84.3 的 pin 一致）。注意 pi **不** re-export `Type`，必须从 `typebox` 直接 `import { type Static, Type } from 'typebox'`。
- 文档：`plan/ask-user-question-contract.md`（契约冻结，三层归属表 + 落地接线点 + 开放项全裁定）+ `plan/ask-user-question-extension.md`（开发计划 WU-00~11）；`prd/03_conversation.md` 新增 CV-S12 与 AC-CV-043~049；`api/03_conversation.md` 新增 §11（事件 + RPC 方法 + preload + 桥接约定 + 状态机）；`test/03_conversation/coverage-matrix.md` 新增 U-CV-022~024 / A-CV-016 / E-CV-025~027，并补上 **CV-S11 遗留未展开**的 E-CV-020~025；`test/03_conversation/e2e.md` 新增 E-CV-020~027 章节与汇总行；`prd/07_installer_update.md` 与 `test/07_pi/coverage-matrix.md`、`test/07_installer_update/coverage-matrix.md` 同步清单 11 → 10 与 AC-IN-015 语义反转；`artifacts.json` 登记 `CV-S12_ask_user_question`。
- 验证：`forge-extensions` 43 单测全绿（schema 约束 / 校验 / envelope / 超时 / 取消 / 部分作答 / execute 端到端 / 注册面）；`forge-ui` 单测全绿；`forge-desktop` 适配器新增 6 例（会话隔离 / 畸形载荷 8 种 / 退订 / leaseless 降级）全绿；全仓 typecheck 通过。**顺带修出一个真 bug**：`removeSession` 未退订新增的问卷 channel（由退订测试暴露）。
- 已知未验证：`execute` await 期间是否阻塞 agent 主循环（需真实 pi 会话）；真实 `pi.events` 总线上的往返；`extensionsOverride` 与自建工具的联合效果。
- 文档结构待整理：模块 07 存在两份覆盖矩阵（`test/07_pi/` 为 artifacts.json 引用的规范版，`test/07_installer_update/` 为 v3.64 新建），E-IN 编号重叠且语义不同，合并去留待裁定。

## v3.64 (扩充：推荐组件清单 v1=10 → 11，添加 ask_user_question)

- 需求：模型在多分支决策场景下频繁猜测，希望让模型在不确定时主动向用户确认（原生 pi TUI 终端插件 `@juicesharp/rpiv-ask-user-question`）。
- 方案：仅完成最小接入（插件上架）。`RECOMMENDED_PLUGINS` 末尾追加 `@juicesharp/rpiv-ask-user-question`，首启静默预装后即被自动写入共享 `~/.pi/agent/settings.packages`。forge UI 内对该工具调用尚无原生 host dialog（Electron 非 TTY，插件原生 TUI 不工作），模型调它时仍会走标准失败路径；完整 UI 接入（按 prototypes/ask-user-question-prototype.html 设计 AskUserQuestionPanel.vue）作为后续独立 work item。
- 文档：`prd/07_installer_update.md` IN-F02 业务规则 / TD-IN-03 / 清单 v1 数 = 10 → 11 三处；新建 `test/07_installer_update/coverage-matrix.md`（AC-IN-015 验证清单包含 ask_user_question）；`recommendedPlugins.ts` 顶部 JSDoc `10 → 11`。
- 范围：仅 plugins 清单 + 文档同步；UI 组件未交付。

## v3.63 (修正：Todo 面板按会话隔离 + 长列表锁进行中)

- 需求：用户反馈「切换会话丢失 todo 任务窗口」+「任务超 3 且 pending > 3 时滚动条锁到 in_progress」（2026-10）。
- 方案：**(1)** `useSessionConversation` 的 `todoSnapshot` 由单 ref 改为 `reactive(new Map<sessionId, TodoSnapshot>())`，对外暴露的 `todoSnapshot` 改 computed = 当前会话 Map 槽位；`resetForSession` 不再清空 todo，按 sessionId 隔离、切走再切回还原上次视图；`onToolCompleted` 的 todo 分支按当前 `sessionId` 写入对应槽位，多会话同时有 todo 互不串。**(2)** TodoPanel 新增可见性保证（v3.63 修正）：有 in_progress 时保证其在 3 行可视窗口内（不强求顶部，用户不需手动滚动即可看到），无 in_progress（全部完成）时滚到最后一行；触发时机：初次挂载 / 折叠→展开 / 布局变化；函数内部检查目标行已可视则 no-op，不抢用户手动滚动位置。v3.63 初版阈值「总任务>3 且 pending>3」过于严格被用户反馈后去掉。
- 限制：仅内存，APP 退出随进程消失；切走会话不清空，切回时还原上一份有效快照；用户手动滚动后状态变化才重新贴顶（与默认下动一律贴顶的差异是用户主动下动不会被抢）。
- 文档：`prd/03_conversation.md` CV-S11 业务规则 / 交互反馈 / 状态流转 / AC 表（AC-CV-041 改为会话隔离语义，新增 AC-CV-042 可见性保证，v3.63 修正去阈值）+ TD-CV-11 改为 B 方案 + 自检表；`api/03_conversation.md` §10 订阅约定同步；`test/03_conversation/coverage-matrix.md` AC-CV-041 / 新增 AC-CV-042；`artifacts.json` `CV-S11_todo_panel` 加 `amended: 2026-10` 与 `AC-CV-042`。
- 代码：`composables/useSessionConversation.ts`（单 ref → reactive Map + computed）、`components/TodoPanel.vue`（ensureTargetRowVisible + layoutKey 触发 + watch/onMounted）。

## v3.62 (功能：输入框上方 Todo 面板 + tool.completed 透传 details)

- 需求：用户要求「想做一个 todo 的页面展示，参考 opencode 的折叠式 checklist 形式」（附 opencode 参考图 2026-09-10）。
- 方案：**(1)** forge-ui 在主会话输入框上方渲染只读 todo 面板（TodoPanel.vue + useTodoPanelSessionState），复用 pi `todo` 工具返回的 `details` 快照作为单数据源（与 pi TUI 端 rpiv-todo 面板同款视觉：标题「已完成 X / 共 Y 个」+ 状态字符 `○/◐/✓` + activeForm 括号 + 完成态删除线 + tree 前缀 `├─/└─`），点击头部任意位置折叠/展开；**(2)** 仅做只读 + 折叠，不做快捷键、手动增删改、拖拽、依赖图编辑、跨会话重放、持久化；**(3)** 空任务时整个面板从 DOM 卸载（不留高度、不留占位）；**(4)** IPC 契约扩展：模块 04 TE-S05 在 `tool.completed.result` 上增加可选 `details` 字段透传 pi 工具结构化详情（补充不重写，旧使用方零变更；JSON omit 语义）。
- 文档：`prd/03_conversation.md` 加 CV-S11（5 项 AC + 1.2/1.3/1.4/2/3.3/3.4/3.5/4 全节承接） + `prd/04_tool_execution.md` 加 TE-S05（3 项 AC + 同节承接）；`prd/index.md` 跨模块索引添 `CV-S11 ↔ TE-S05`；`artifacts.json` 添 `extensions` 节点；`api/04_tool.md` 添 `details` 字段示例 + `api/03_conversation.md` 添 §10 订阅约定；`test/03_conversation/coverage-matrix.md` + `test/04_tool/coverage-matrix.md` 添 5 + 3 行 AC + 对应 unit/api/e2e 设计。
- 范围：仅前/中端（forge-ui + forge-desktop IPC + forge-core 契约）；pi TUI 端 rpiv-todo 不动（单数据源自然一致）。
- 待开发：进入 dev-tdd 完成实现。

## v3.61 (功能：模块 07 IN-S01~04 交付——安装包、静默预装、应用自更新、组件联动更新)

- dev-flow run `20260908164205` 完成（5 WU：startup-state / updater-rpc / updater-ui / updater-e2e / packaging；D0~D8 全过，QA 三轮终审 PASS）。
- 壳层基础（IN-S02/IN-S04）：`updater-state.json`（userData，schemaVersion/lastRunForgeVersion/preinstallDone/preinstallDoneAt/lastUpdateCheckAt/components，原子写+损坏重建）；内置推荐组件清单 10 个；首启静默预装（settings.packages 补缺只增不删，经内置 CLI `pi install`）与 forge 版本变化联动更新（`pi update --extensions`，失败静默保留旧标志）；main.ts 启动后台编排 fire-and-forget 不阻塞启动。
- 应用自更新（IN-S03 后端）：集成 electron-updater（GitHub Releases feed）；`updater/getState|checkForUpdates|downloadUpdate|quitAndInstall` 四方法 + `updater.stateChanged` 事件（FORGE_EVENTS 白名单登记，回归锚点见测试）；错误码 6003/6004/6005；启动自动检查；feed 未配置静默降级不触碰网络；手动更新成功回写 components 快照 +「包名 旧→新 (来源=手动)」结构化日志（QA G1）；检查完成回写 lastUpdateCheckAt（QA G4）。
- 应用自更新（IN-S03 前端）：设置页「关于」Tab 自更新交互——分区打开自动检查 + 手动检查、发现新版 toast 一次 + 分区常驻「发现新版本 + 更新按钮」、下载进度百分比、下载完成「重启安装」→ **居中确认弹窗**（fixed 遮罩 + 居中 box，标题含新版本号 +「关闭应用并安装更新，完成后自动重启。」+ 取消/确认安装，取消停留当前版本；QA G6）；检查/下载/安装失败静默可重试。
- 安装包（IN-S01）：electron-builder NSIS per-user（oneClick + perMachine=false，免管理员）；`dist`/`dist:dir` 脚本；NSIS 实测产出 forge-0.1.0-x64-setup.exe + latest.yml + app-update.yml（发布前替换 publish owner/repo 占位）。
- E2E：`updater.spec.ts` E-IN-001~004（发现新版 toast 一次+常驻、下载进度→确认弹窗→quitAndInstall 调用捕获、检查失败静默、无新版/后台更新无提示无「组件/插件」字样——QA G3）；settings.spec 9/9 回归。
- 验证：typecheck 三包 0 错；单测 core 365 / desktop 223（+31 模块新增）/ ui 178 全过；E2E settings 9/9 + updater 4/4；smoke 为 HEAD 存量已知失败（v3.52 有案）。
- 文档同步（QA G2）：coverage-matrix AC-PI-004 补 manual 标注 + 发布前 manual checklist 第 6 项；B2 备注更正白名单回归锚点（appUpdater.test.ts）。
- 未提交：本 run 全部改动在工作区，待用户决定提交。

## v3.60 (功能：AI 回复改动文件汇总卡片 + 真实 pi 会话 diff 渲染修复)

- 交互原型：`prototypes/changed-files-prototype.html`（流式渐进 / 静态折叠 / 展开态 / 无改动轮次四场景，令牌取自 design-tokens.css）。用户确认：卡片默认折叠、diff 带行号、不出现引导性收尾文案、卡片位于轮末 footer 之下。
- ui 新增「改动文件汇总卡片」：`useChangedFiles.ts`（parseFileToolInput 按入参形状识别修改文件类工具——pi 真实 `{path,edits[]}`/`{path,content}` 与旧形状 `{file_path,old_string,new_string}` 全兼容，read/bash 形状不命中；countDiffLines 经 buildSideBySideDiff 数行；collectTurnChangedFiles 按轮收集，分轮口径同 useTurnFooter，同轮同文件聚合）+ `ChangedFilesCard.vue`（头部「N 个文件已更改」+ 总计与行级 +A -R；默认折叠；行点击行内展开 diff，edit 多 hunk 逐块 hunk i/n 分隔；路径按会话项目根转相对展示）。`displayItems` 新增 `files-summary` 项，轮末（下一条 user 前 / 流式末尾）插入，仅计 `status=completed` 的工具。
- ui 修复：真实 pi 会话工具卡 / 工具组 diff 不渲染——`toToolDiff`/`ToolCallCard` 原只认旧键名 `file_path/old_string/new_string`，pi 真实入参不匹配导致 diff 恒空；统一改共享 `parseFileToolInput`，edit 多 hunk 逐 DiffView 渲染（仅首块显示文件名）。`DiffView` 全局增加行号列（旧/新文件行号独立计数，空侧不留号）。
- desktop：`loadPiSessionHistory` 预扫描 assistant 消息 toolCall parts 建 toolCallId→arguments 映射，回填历史 tool 消息 `input`（条件性添加，无匹配不加字段，旧数据形态不变）；toolResult 缺 toolName 时从 toolCall part 兜底。历史会话切回同样显示卡片。
- 文档：`api/04_tool.md` §2 更正为真实 pi 入参形状（原文档 file_path/old_string/new_string 为 mock 形状，即本次 bug 根源）+ 前端消费口径；`api/03_conversation.md` queryHistory 补历史 tool 消息 `input` 说明。
- 验证：typecheck 三包 0 错；单测 core 365 / ui 178（+17 changedFiles）/ desktop 187（+2 history 回填）全过；E2E 新增 `changedFiles.spec` 4/4（历史回显折叠与行内 diff、工具卡 diff 修复、流式渐进出现、失败与 read 不计入）；全量 E2E 80 过 / 2 挂（smoke、E-SM-001 为 HEAD 存量已知失败，v3.52 已 stash 基线验证与本次无关）。
- 未提交：本 run 全部改动在工作区，待用户决定提交。

## v3.59 (功能：设置页改 Tab 结构「通用/关于」，版本更新迁入关于)

- 用户决策：设置页内容变多，改 Tab 结构。`SettingsPanel.vue`：header 下新增 Tab（通用/关于，active 底线 brand-accent）；「通用」= 模型配置 + 外观（现状不变）；「关于」= 版本更新分区（单栏 about-body，max-width 760px）。
- 同步落实原型反馈：版本更新分区**移除内置组件清单**（v-if Tab + 负向 e2e 断言）。
- 契约收缩：`pi/getInfo` 仅返回 `forgeVersion`（plugins 字段移除；ipc-contract/bridge/mock-bridge 同步；readPiExtensionList 保留在 piRuntime 供 IN-F02/F04 使用）。
- 原型 `updater-prototype.html` 增加设置页 Tab 模拟（通用/关于）。
- 验证：typecheck（ui/desktop）0 错；desktop 单测 piRuntime 5/5；e2e settings.spec 9/9（一次 waitForMock 环境抖动重跑通过）。
- 追加（原型确认后）：Tab 样式定稿**方案 A 分段控件 + 滑动选中块动效**（muted 容器 + 绝对定位 thumb，transform/width 0.28s cubic-bezier；深色用前景色 14% 混合提亮；函数式 ref 测量 offsetLeft/offsetWidth，watch(activeTab)+resize+onMounted 校准）；「关于」Tab 移除「forge 版本与内置组件更新」desc 行；原型整体重写（补丁编辑与 IDE 保存多次互相覆盖，改整文件重写——同文件多次 Edit 严禁并行）。

## v3.58 (原型：模块 07 更新体系交互原型 + 敲定三项反馈)

- 新增 `prototypes/updater-prototype.html`（单文件，明暗可切，令牌取自 design-tokens.css）：展示设置页「版本更新」分区全状态（已是最新/发现新版+toast/下载进度/重启安装/检查失败静默）、自更新状态机示意、后台静默流程模拟面板（updater-state 标志与明细日志）。
- 原型确认三项反馈并同步文档（PRD 07 / api/07_pi.md / db/07_installer / test/07_pi/*）：
  1. 「重启安装」点击后弹确认框（含新版本号与影响说明），确认才执行安装重启 → AC-IN-009 修订；
  2. 设置页不再展示内置组件清单（含已实现的清单 UI 移除，随 dev 调整；AC-PI-002 改为负向断言，AC-PI-003 作废）；
  3. 组件变更明细（包名 · 旧版本 → 新版本 · 来源）写结构化日志（§3.5 字段明确），updater-state.json 新增 `components` 版本快照（db schema 补字段）。
- 待用户最终确认原型后调用 dev 实现 IN-S01~04（含 PU 展示形态调整）。

## v3.57 (文档：模块 07 补齐待开发部分下游文档，dev 可接手)

- DB：新增 `db/07_installer/schema.md`——userData 独立 `updater-state.json`（用户拍板：不进 forge-store），字段 lastRunForgeVersion / preinstallDone / preinstallDoneAt / lastUpdateCheckAt + schemaVersion；损坏按默认值重建；单写者原子写。
- API：`api/07_pi.md` 扩展自更新契约（IN-S03 待开发）——updater/getState、updater/checkForUpdates、updater/downloadUpdate、updater/quitAndInstall 四方法 + `updater.stateChanged` 事件（须登记 FORGE_EVENTS 白名单）；错误码 6003（检查失败，UI 静默）/6004（下载/校验失败）/6005（安装启动失败）；预装/联动更新无 RPC（后台静默）。api/index.md 错误码表同步。
- 测试设计：`test/07_pi/coverage-matrix.md` 补 AC-IN-001~014 全基线（unit U-IN-001~004 / API A-IN-001~003 / E2E E-IN-001~004 / manual 发布前 checklist 5 项）+ 契约完整性走既有 ipcEventContract 静态扫描不单设 AC；新增 `test/07_pi/e2e.md`（自更新 UI 4 用例，mock-backend，含「预装/联动全程无 UI」反向断言）；test/index.md 行更新。
- artifacts.json：登记 07_installer 模块（prd/verification/api/db/test-e2e/test-api 均 approved）。
- 状态：模块 07 文档集就绪，可调用 dev 实现 IN-S01~04。

## v3.56 (文档：PRD 08 并入 PRD 07，合并为完整更新体系需求)

- 按用户决策，安装包与联动更新（原 PRD 08）并入 PRD 07，更名为「版本更新与安装包（pi 运行时）」，作为一套完整需求 PRD；`prd/08_installer_update.md` 删除，PRD 文件定名 `prd/07_installer_update.md`。
- 合并后结构：场景 PU-S01/S02（设置页版本更新分区，已实现）+ IN-S01~04（安装包/预装/自更新/联动更新，待开发）；决策 TD-PI-01~05 + TD-IN-01~06；AC 编号保持稳定（AC-PI-001~008 已实现、AC-IN-001~014 待开发）；自检报告合并全 PASS。
- 索引（prd/index.md、overview.md）同步：模块 08 移除，07 备注含实现进度。API（api/07_pi.md）与测试设计（test/07_pi/*）不变，安装包部分实现时再扩展。

## v3.55 (PRD：模块 08 安装包与联动更新 确认)

- 新增 `prd/08_installer_update.md`（gen-doc-prd 两轮确认，状态 PRD 已确认）：IN-S01 Windows 安装包（NSIS per-user）/ IN-S02 推荐组件首启静默预装（无感、只增不删、幂等）/ IN-S03 应用自更新（GitHub Releases，发现新版提示一次+设置页常驻入口，用户手动点击更新）/ IN-S04 引擎-插件联动更新（forge 版本变化后台静默更新组件，不提示）。
- 用户拍板：更新通道 GitHub Releases；预装对客户完全无感（不做设置页入口）；预装清单=当前 10 个插件；组件自动更新不提示、forge 更新包提示+手动；Windows only v1；semver 单 latest 通道。
- 14 条 AC（AC-IN-001~014）+ 自检报告全 PASS；索引/overview 同步。实现排期未开始。

## v3.54 (功能：模块 07 版本更新分区 + BranchBadge 两处修复)

- BranchBadge 修复（用户报障）：过滤分支输入框无法聚焦/输入——浮窗容器 `@mousedown.prevent` 吞掉 mousedown 聚焦默认行为；移除该修饰符（外层 onDocMouseDown 已按 `.git-badge` 放行）+ 打开浮窗自动聚焦过滤框；E-PM-006 过滤步骤从 `fill()` 改真实点击+键盘输入防回归。徽标图标与文字改顶部对齐（inline-flex + flex-start，原基线对齐致图标高出文字）+ 间距 2px。
- 模块 07 版本更新（设置页「版本更新」分区，明面 forge 产品更新，内部更新 pi 共享扩展）：
  - 需求对齐结论：全局 pi CLI 检测/更新不做；预装推荐插件与安装包/联动更新另立专项 PRD；引擎（内置 SDK）版本不露出。
  - core/desktop：`piRuntime.ts`（readPiExtensionList 读 ~/.pi/agent/settings.json packages + npm 实体版本，JSONC 剥离复用 piModelsFileAdapter.stripJsonComments 并导出；updatePiExtensions 经 ELECTRON_RUN_AS_NODE 跑内置引擎 CLI `pi update --extensions --no-approve`，超时 10 分钟，输出尾部 ≤4000 字符）；createForgeCore 注入 piMethods（pi/getInfo、pi/updatePlugins，6002+output 失败信封，更新器可注入）；main.ts 注入 app.getVersion()。
  - ui：SettingsPanel 新增「版本更新」分区（版本行 + 更新组件按钮 busy 态 + 组件清单/未安装红标/空态；失败内联展示错误与输出尾部，不弹 toast）；契约 ipc-contract/bridge 同步；mock-bridge 默认 mock。
  - 文档：prd/07_pi_runtime.md、api/07_pi.md、api/index.md（6002 + 模块行）、test/07_pi/*（矩阵 + api.md）、test/index.md、prd/index.md。
- 验证：typecheck（ui/desktop）0 错；desktop 单测 piRuntime 5/5；e2e settings.spec 10/10（新增版本更新 3 用例）。
- 未提交：本 run 全部改动在工作区，待用户决定提交。

## v3.52 (开发交付：PM-S05 分支查看与切换，dev-flow run 20260907175149 COMPLETE)

- 交付：4 WU 全部 D4 通过 + D5 Fan-in + D6 模块 QA PASS（gap 0）。
  - wu-01 core：`gitService.ts`（execFile 调 git CLI，gitBin 可注入；getBranchInfo 五态/dirty/dict 序；switchBranch `git switch --` 参数数组防注入，6001+stderr 透传，幂等无事件）+ `gitMethods.ts`（信封 1001/1002/6001/5000，事件 git.branchChanged）+ 21 单测（真实临时仓库含 detached/unborn/远程跟踪）。
  - wu-02 desktop：ipc-contract 方法/事件/白名单 + createForgeCore 同构注入 gitApi；事件白名单静态扫描契约回归绿（修复 wu-01 引入的跨包缺口）；32 单测。
  - wu-03 ui：bridge/types/mock-bridge 契约同步；BranchBadge 组件（徽标+浮窗过滤+dirty 确认框+6001 stderr 展示浮窗不关+busy 禁用态+事件刷新+聚焦重查）；InstructionInput proj-pill 旁挂载；App/MultiWindow 按项目级 busy（任一会话 streaming）逐窗口传；纯函数提取 + 13 单测。
  - wu-04 e2e：branchBadge.spec 5 用例覆盖 E-PM-005~008（含流式禁用/取消确认/冲突 stderr 展示分支不变）；RED 均为真实交互缺陷后修复。
- D5 集成修复 1 项：BranchBadge scoped 样式不继承宿主 `.meta-link svg` 尺寸规则，SVG 默认尺寸撑爆 compose-bar（114px）拦截输入框点击，级联打挂 13 条存量 e2e；单行 `.git-pill svg{13px}` 修复后全部恢复（教训：子组件内的宿主 scoped 规则不可依赖，需显式约束）。
- 验证：typecheck 四包 0 错；单测 706/706（core 365 + desktop 180 + ui 161）；e2e 74 过/2 挂（smoke、E-SM-001 为 HEAD 存量，基线 stash 验证与本次改动无关）。
- 工具链修复：dev skill 的 wu-normalize.js 丢失 test_selector 字段（references/dev-flow.md 明文要求），致 D4 全量跑跨 WU 中间态误报；已补字段透传并重开 run（旧 run 20260907171139 弃用，状态文件 .abandoned 留档）。前一次误提交（cc0d6c2 把三个并行会话未提交改动打包且提交信息声称 PM-S05 已实现）不实，实际实现以本 run 为准。
- 已知偏差（QA 判定不阻塞）：E-PM-005/006/008 以 mock-backend 表达矩阵 real-backend 场景（spec 头部已声明），真实 git 语义由 core 单测真实临时仓库覆盖。
- 未提交：本 run 全部改动在工作区，待用户决定提交。

## v3.51 (功能：模块 01 扩展 PM-S05 分支查看与切换全档确认)

- 需求：在 forge 内感知项目 git 分支并切换。用户拍板：展示/切换入口只放输入框项目选择器旁；流式中徽标与其他控件一致呈禁用态（非点击后拦截）；有未提交更改先弹确认框；确认后切换失败原样展示 git 错误。
- PRD：`prd/01_project_management.md` 扩展 PM-S05（场景行/已确认决策/TD-PM-06~09/功能点 + AC-PM-013~023/徽标与浮窗承载/性能量化，自检 21 项 PASS）；状态 → PRD 已确认（含扩展 PM-S05）。
- 关键决策：TD-PM-06 git CLI（child_process 零新依赖）；TD-PM-07 实时读不缓存不落 forge-store（无 DB 变更）；TD-PM-08 禁用+确认+透传（用户拍板）；TD-PM-09 切换广播 git.branchChanged + 聚焦/打开重查，不做文件监听。
- API：`api/01_project.md` 新增 §10 `git/getBranchInfo`（isGitRepo/branch/branches/dirty/detached；非 git 与 git 不可用均 isGitRepo:false 不报错）与 §11 `git/switchBranch`（git switch 默认语义含远程同名自动建跟踪；冲突返回 6001 + data.stderr，分支不变；幂等重切无事件）；§8 新增事件 `git.branchChanged`；§9 与全局错误码表新增 6001。
- 测试设计：`test/01_project/coverage-matrix.md` 新增 11 条基线（U-PM-006~009 / A-PM-009~010 / E-PM-005~008），覆盖 detached/空仓库/流式禁用/dirty 确认/冲突透传/多窗口同步/实时读收敛。
- 文档同步：`prd/index.md`、`overview.md`（模块表+MVP 范围+当前状态）、`api/index.md`（6001）；`artifacts.json` 无需变更（01_project 各 artifact 路径与状态不变，均 approved）。
- 剩余风险：git CLI 依赖用户机器安装 git（开发者用户群风险低；不可用时徽标隐藏降级，无功能损失）。

## v3.50 (样式：技能引用配色暖琥珀→青瓷绿)

- 背景：用户觉得全 app 黑白太单调，希望技能引用保留颜色但更耐看；通过原型页多方案对比后选定 E 青瓷绿（demo：`prototypes/skill-color-options.html`，可切 light/dark）。
- 改动：`design-tokens.css` `--brand-accent` light `oklch(0.65 0.14 85)` → `oklch(0.62 0.09 170)`，dark `oklch(0.8 0.14 85)` → `oklch(0.78 0.1 170)`；注释同步更新。该令牌当前仅 `MessageCard` 技能名 `.is-skill` 与「技能」标签 `.tag-skill` 引用，零误伤；LOGO（`--logo-gradient-accent`）、Toast 渐变线、shimmer 流光的暖琥珀均为独立变量/字面值，不受影响。
- 备选方案（用户指定留档）：D 淬火钢蓝 light `oklch(0.58 0.08 240)` ≈ #4b81a5 / dark `oklch(0.76 0.08 240)` ≈ #82b8df，将来如需冷色点缀可直接替换 `--brand-accent` 两处值。
- 验证：纯 CSS 变量替换，无测试/e2e 断言颜色值；刷新 dev 页面即可见。

## v3.49 (修复：消息队列浮窗真实端始终不出现——IPC 事件转发白名单漏登记)

- 用户反馈：忙时入队后，发送按钮旁的「待发送 N」徽标/浮窗仍然看不到（v3.47/v3.48 修复后依旧）。
- 根因（forge-desktop `ipc-contract.ts`）：main 进程 `registerIpc` 只把 `FORGE_EVENTS` 白名单内的事件经 `webContents.send` 转发给渲染进程，而 CV-S09 新增的 `conversation.queueUpdated` 通道漏登白名单。链条前段全部正常：pi `queue_update` → adapter `onQueueUpdated` → forge-core `events.emit('conversation.queueUpdated')`——事件在主进程事件总线上发出，但无监听转发，渲染进程 `subscribe('conversation.queueUpdated')` 永不触发，`queueBySession` 恒空，徽标 `v-if` 恒假。
- 为何 v3.47/v3.48 两轮修复都没发现：mock-bridge（浏览器 dev/e2e）在同一 JS 上下文内 emit/consume，不经主进程 IPC 转发，白名单缺失对 mock 路径无影响——单测/e2e 全绿但真实 Electron 端必挂。
- 修复：`ForgeEvent` 联合类型与 `FORGE_EVENTS` 数组补登 `conversation.queueUpdated`（各一行）；新增契约回归测试 `ipcEventContract.test.ts`：静态扫描 forge-core 全部 `events.emit('<channel>')` 字面量，断言每个通道均已登记白名单——以后新增事件漏登直接红。
- 验证：契约测试先红（还原修复精确报出 `conversation.queueUpdated`）后绿；forge-desktop 全量单测 179 过；typecheck 0 错。真实端验证需用户重启 dev（start.bat）后忙时连发两条确认徽标出现。
- 文档同步：知识库新增 kb-2026-09-09-ipc-events-whitelist（IPC 事件转发白名单陷阱，mock 绕过 IPC 导致 e2e 盲区）。

## v3.48 (修复：新建项目未自动选中——新建后下拉置顶但归属仍是旧项目)

- 用户反馈：新建项目（输入框下拉“打开项目…”注册）后，新项目在列表排第一（MRU 置顶生效）但未被选中——草稿归属/当前项目仍是旧项目。
- 根因（App.vue `onAddProject`）：注册成功后只做三件事——`loadProjects()`（仅当 `currentProjectPath === null` 才自动选中，已有选中项目时恒不成立）、`bumpProjectToFront`（只改下拉 MRU 序）、toast；从未切换当前项目。
- 修复：注册后追加 `await onPickProject(path)`——归属切到新项目，复用下拉选中语义（草稿保留），与 v3.21“选中=切换当前项目，草稿保留”一致；空态“打开项目”入口同步受益。MRU 置顶触发点不变（新建项目/创建会话成功）。
- mock 修复（e2e 逼真度）：mock-bridge `project/queryProjectList` 原样返回 `DB.projects` 活数组，而真实 IPC 结构化克隆每次返回新数组——共享实例使 `projects.value` 赋同实例不触发响应式、mock 侧 push 绕过 reactive proxy，computed 缓存永不失效。改为逐项浅拷贝返回；补 `project/addProject` case（重复返 1001、排尾，同真实端未打开垫底语义）。
- 验证：新增 e2e SESSION-E2E-007（E-SM-007 回归）先红后绿（修复前 pill 停留 'forge▾' 复现，修复后归属切新项目+草稿文本保留+树选中态+下拉置顶）；全量 e2e 69 过/2 挂（smoke、E-SM-001 为存量，同 v3.47）；forge-ui typecheck 0 错；单测 148 全过。
- 文档同步：PRD SM-S01 输入框项目选择器（“注册成功后自动切换为当前项目，草稿保留”）、test/02_session/coverage-matrix AC-SM-028 与 E-SM-007（补回归断言）。

## v3.47 (修复：消息队列不稳定——入队徽标不出现/切会话后丢失)

- 用户反馈：消息队列很不稳定，页面上经常看不到待发送徽标。
- 根因①（adapter 分流竞态，主因）：pi `AgentSession.prompt()` 在置位 `_isAgentRunActive`（即 `isStreaming`）前有 preflight 窗口——扩展 input 钩子、鉴权 `checkAuth`（可含网络往返）、压缩预检、before_agent_start 均为 await。适配器仅以 `session.isStreaming` 分流入队/直发，窗口内（首条发送后数百 ms 至数秒）到达的第二条误走直发：重置在途轮次状态 + 二次 `prompt()`，与启动中的轮次相撞（`already processing` → 适配器反手 `abort()` 误杀在途轮并报错；或双重并发轮次交错）。用户在首条发送后立即补发（分段指令习惯）极易命中 → 队列徽标不出现、报错、回复被截断。
  - 修复：适配器增设**直发提交门**（`pendingSubmit`，sessionId → promise）：直发路径登记（先于 factory/preflight 首个 await），pi `preflightResult` 回调（提交完成，含 factory/预检失败释放）提前放行，异常/收尾兑底放行（resolve 幂等）；同会话后续 sendMessage 循环等待提交完成后再按 `isStreaming` 分流（入队等待者 FIFO 保序）；removeSession 同步清理。
- 根因②（UI 队列镜像切换丢失）：`useSessionConversation` 的 `queueItems` 仅镜像当前会话（事件回调过滤非当前 sessionId）且 `resetForSession` 切换即清空，无查询接口可恢复 → 排队后切走再切回，徽标永久丢失（pi 队列仍在，收尾仍会派发，但用户不可见）。
  - 修复：`queueBySession`（reactive Map）按会话镜像全部 `conversation.queueUpdated` 事件，`queueItems` 改为当前会话的 computed 读取；`resetForSession` 不再清队列镜像。
- 验证：adapter 回归用例先红后绿（U-CV-014：preflight 窗口内第二条不二次直发、提交后 followUp 入队——修复前 `promptCalls=2` 复现相撞；U-CV-015：factory 失败释放等待者不悬挂）；e2e QC-004 切走再切回徽标不丢（stash 复原后确认 RED，修复后 GREEN）；三包单测 670 全过（344+178+148）；全量 e2e 68 过/2 挂（smoke、session E-SM-001 为存量，干净工作区同样挂）；typecheck 0 错。
- 文档同步：`api/03_conversation.md`（CV-S09 分流语义 v1.2：提交门 + 按会话镜像）、`test/03_conversation/coverage-matrix.md`（U-CV-014/015 + QC-004）、`test/03_conversation/e2e.md`（QC-004）。
- 剩余风险：①轮次收尾后、forge 状态尚未置 done 的短暂窗口（如子 agent 收尾门控延迟）内入队的消息会由适配器直发，UI 因误判忙时未本地渲染 user 气泡（消息丢失视觉，非队列问题；根治需 sendMessage 响应携带 queued 标志，涉及契约变更未做）；②停止时若有消息仍在提交门等待，门释放后将以直发开启新轮（罕见：停止落在首条 preflight 内且已有第二条在等）。

## v3.46 (修复：发送消息全 app 卡顿——首条冻结 + 流式渲染冻结)

- 用户反馈：发送第一条消息整个 app 很卡、会话树里新会话显示延迟；发送第二条消息也卡住。
- 根因①（首条消息，主进程）：会话工厂冷启动时 pi `DefaultResourceLoader.reload()` 经 jiti 现场编译 settings.packages 全部 npm 扩展（本机 10 个包实测 3~9s，CPU profile 主体为 stat/statSync + jiti 解析转译），同步占用 Electron 主进程事件循环 → 全部 IPC/事件延迟（会话树刷新、窗口控制、@ 补全等），表现为“整个 app 卡”。pi 扩展模块缓存按 cwd 进程内记忆，同进程二次 reload 仅 75~550ms（实测 cold 3848/9077/6987ms vs warm 75/109ms；工厂整体 5444ms → 预热后 175ms）。
  - 修复：新增 `warmPiResourceLoader(cwd)`（forge-desktop/pi/createPiAgentSessionFactory.ts，同 cwd 幂等），main.ts 订阅 `project.opened` 后台预热——启动时自动打开首个项目也触发，冷编译从首条发送路径挪到打开项目时；失败仅告警不影响正常工厂创建。
- 根因②（流式期间，渲染进程）：`MessageCard.renderedContent` 为 computed，逐 delta 全量重跑 marked + hljs + sanitizeHtml（33KB 回复单次 44ms，40 delta/s ≈ 176% 渲染线程）且 bodyHtml 逐 delta 重换 v-html → 长回复流式时整个渲染进程冻结（代码内既有 ponytail 注释预告的天花板）。
  - 修复：流式期间（streaming=true）每 150ms 尾随重渲染一次，非流式（历史加载/终态覆盖/取消收尾）立即渲染；开围栏标记与 html 一同在节流点快照，mermaid/bodyHtml 派生量只依赖节流后状态，不再逐 delta 重算（实测渲染线程占用 176% → ~29%）。角色分支保留（user/system/tool 仍纯文本转义）。
- 验证：forge-desktop/ui typecheck 0 错；三包 668 测试全过（344+176+148）；工厂预热计时脚本（cold 5444ms → warm 175ms）与 renderMarkdown 基准（44ms/次）实测记录于调查过程；MessageCard 节流无组件测试设施（forge-ui 测试均为纯函数 node:test），行为验证依赖 typecheck + 人工流式观察——缺口如实记录。
- 文档同步：PRD CV-S02/AC-CV-004 本就要求“增量渲染不卡顿”，实现已满足，契约无变化；沉淀知识库 kb-2026-09-07-pi-extension-cold-load。
- 剩余风险：①多项目轮流首发仍可能各冷启动一次（pi 缓存按 cwd 记忆，切换预热目标会失效前一个）；②预热与首条发送若几乎同时发生（打开项目后 <5s 内发送）可能双重编译，发送仍可能卡一次；③根治需把 pi 会话运行时挪出主进程（utilityProcess），成本高未做。

## v3.45 (SM-S01 验收修正：下拉项目排序改最近使用置顶 MRU)

- 用户需求：新建项目在下拉里排最后，应排第一；本次选中的项目在创建会话后也应变成第一（原规则=首次选中定序永不重排，与新项目/新会话预期不符）。
- 对齐粒度（用户裁定，方案 B）：下拉序与项目树拖拽序完全独立；置顶触发点仅两个——新建项目（打开项目…注册成功）、创建会话成功（草稿发首条消息归属落定）；纯下拉选中不改序；重复使用也置顶，其余相对顺序不变。
- 实现：App.vue `pickOrder` 写入由「首次选中追加」改为 `bumpProjectToFront`（move-to-front），写入时机从 `onPickProject` 移到 `onAddProject` + `onSessionCreated`（草稿归属即 currentProjectPath）；`orderedProjects` 排序逻辑不变（indexOf 序、未记录按后端序垫底，天然兼容 MRU）；移除项目同步清除记录保留；后端 lastOpenedAt/侧栏语义不变。
- 验证：typecheck 0 错、forge-ui 148 测试全过。
- 文档同步：`prd/02_session_management.md`（选择器排序规则改 MRU + AC-SM-028）、`test/02_session/coverage-matrix.md`（AC-SM-028 断言 + E-SM-007 步骤改置顶断言）。

## v3.44 (CV-S09 消息队列 + CV-S10 输入历史翻阅)

- CV-S09 消息队列（think-1788425299398 对齐，方案 C5 + pi TUI ESC 语义）：忙时发送 = 入队，完全托管 pi —— 适配器以 `session.isStreaming` 分流，streaming 中经 `prompt(content, {streamingBehavior:'followUp'})` 入队，pi 收尾自动 FIFO 派发（投递时 `message_start(role=user)` + `queue_update` 移队，适配器以「离队+message_start(user)」确认派发转发 user 气泡，直发路径不转发无重复）；UI「待发送 N」徽标 + 只读浮窗（无删除/立即发送）；上限 5 条 UI 软校验；**停止 = `clearQueue()`（双层清，防 while 循环续跑）→ `abort()` → 被清文本 `\n\n` 拼接回填输入框**（源码核实 pi TUI ESC 同款，单条删除 pi 无 API、唯一丢弃入口 = 停止）；RPC：cancelStream 响应改带 `clearedMessages`，新增 `conversation.queueUpdated` 事件，忙时 sendMessage 不再返 1001 且不推 statusChanged（防重置读秒）。
- CV-S10 输入历史翻阅（方案 B）：仅输入框为空（或已在历史模式）时 ↑/↓ 触发；`forge.inputHistory.{sessionId}` localStorage 持久化（上限 100 FIFO）；会话隔离 + 切换时历史模式残留清空；连续相同去重；草稿态不翻阅不入栈。
- 附带行为变更：忙时输入框不再禁用（placeholder「Enter 推队发送」、斜杠浮窗 streaming 中可触发）；排队消息派发前只住浮窗不进对话区（方案 A，与 ai-coding 一致）。
- 验证：forge-core 344 单测（含入队/入队失败不影响在途/cancelStream clearedMessages 新断言）、forge-desktop 176（含 CV-S09 adapter 四用例）、forge-ui 148；e2e 新增 queue.spec（QC-001~003）与 inputHistory.spec（AC-IH-001~007）全过；全量 e2e 67 过/2 挂（smoke、session E-SM-001 均为存量，与本批无关）；v3.43 预告的 slashCommands TSC-E2E-001 步骤 5 已随 CV-S09 更新为 streaming 可用断言。
- 文档同步：PRD 03（CV-S01 翻案 + CV-S09/CV-S10 场景与状态机 + 自检报告）、API 03（sendMessage 入队语义/cancelStream 响应/queueUpdated 事件）、test 03 coverage-matrix + e2e（QC/AC-IH 行 + E-CV-014 修正）。

## v3.43 (重构：多窗口会话窗口合并复用 ConversationView)

- 用户决策（think-1788488643459 对齐）：双壳层是“单视图修了、多窗口没份”事故类的根源（footer 重复/读秒/工具条压缩三连），合并后此类问题结构性消失。D1=A：时间线竖条+历史浮窗随 ConversationView 带入多窗口，零刻意差异。
- 实现：`MultiWindowConversation` 重写为 ~40 行薄壳——只保留多窗口专属的每窗口模型状态（getSessionModel/setSessionModel）+ 由 session.projectPath 合成 ConversationView 所需 ProjectItem（其内部只消费 path）；消息流/子 agent/横幅/停止确认全部删除（单实现，-368 行）。`InstructionInput` 的 `compact` 死 prop（无对应样式）一并删除；MultiWindowCanvas 去掉 project-path 传参。App 装配与画布布局/拖拽/吸附不动（win-focus 聚焦层本就渲染 ConversationView，已有先例）。
- 合并后首个回归修复（用户实测反馈：多窗口宽度不对、发送按钮看不到）：旧壳层两条横向防御随删除丢失——① `.mw-body > * { min-width: 0 }`（flex row 子项默认 min-width:auto，长 token/URL/代码行的 min-content 把整列撑宽越出窗口右缘，实测 438px 窗格被撑到 1238px、发送按钮裁在窗外）；② `.conv-messages` 补 `min-width:0 + overflow-x:hidden`（阻断长行 min-content 向上传递，溢出就地隐藏，代码块内部自有横向滚动，单视图同享防御）。回归用例：mwConversationView.spec 长行场景断言视图不超宽 + 发送按钮在窗口内（修复前 1238px/不可见 → 修复后 436px/可见）。
- 附带效果：多窗口获得回看模式/回到底部、空会话欢迎页、时间线竖条+历史浮窗；v3.42 的 `.wc-messages > *` 规则随壳层删除（单视图 `.conv-messages-inner` 包装层结构性免疫 flex 压缩，工具条回归锁 mwToolGroupVisible.spec.ts 继续有效）。
- 验证：新增冒烟 `mwConversationView.spec.ts`（合并前 RED：窗口内无 .conv-view；合并后 GREEN）；全量 e2e 62 过/3 挂，三挂均非本次引入（smoke=存量断言已删元素；session E-SM-001=存量；slashCommands TSC-E2E-001 步骤5=与在途 CV-S09 排队语义冲突，见 v3.42 后工作区说明）；单测 148 全过；vue-tsc 0 错。
- 注：工作区同时存在用户在途 CV-S09 排队发送改动（forge-core/desktop/ui 多文件），本条目仅含合并重构；slashCommands 用例步骤 5 断言 streaming 禁用输入框，与排队语义冲突，需随 CV-S09 交付一并更新。

## v3.42 (修复：多窗口窄窗格工具调用条不显示)

- 用户反馈：多窗口会话窗口里工具调用条不显示（又出现），单视图同一会话正常；并追问多窗口会话窗口与单窗口是否同一组件。
- 组件事实：多窗口 `MultiWindowConversation` 与单视图 `ConversationView` 是两个壳层，共享状态机 `useSessionConversation` 与输入框/子 agent 子组件；本次 bug 不在共享层，在多窗口壳层自己的滚动区。
- 根因（无头浏览器实测复现，量测 DOM 几何）：`.wc-messages` 是 flex column + `overflow-y:auto` 滚动容器，但展示项是它的**直接子元素**且默认 `flex-shrink:1`；窗格矮+会话长内容超高时 flex 先收缩而不滚动——文本消息压到 min-content 地板（中文字块地板高）几乎不变形，而 `overflow:hidden` 的 `.tool-group`/`.tool-calls` min-height 地板为 0，吸收全部收缩量 → 计算高度 0px，视觉“消失”。间歇性 = 仅内容总高超过窗格才触发，多窗口窗格矮几乎必现，单窗口高几乎不现（且单视图 `.conv-messages` 内有唯一的 `.conv-messages-inner` 包装层，子项不直接参与收缩，结构性免疫）。
- 修复：`.wc-messages > * { flex-shrink: 0 }`，超高恢复为正常滚动；compact 横幅/错误/思考指示同为直接子元素一并受保护。单视图不动。
- 验证：新增 e2e `mwToolGroupVisible.spec.ts`（矮窗格 1280×640 + 工具组历史，断言 `.tool-group` offsetHeight > 0）；未修复时 failed、修复后 passed（TDD 闭环）；mw-restore/session/subagent 回归 20 过，session.spec 的 SESSION-E2E-001 为存量失败（不带本改动同样失败，与本次无关）。

## v3.41 (修复：子 agent 头部条窄容器下变形)

- 用户反馈：子 agent 的工具条（头部：描述名 + 类型徽标 + 状态点 + 运行中 + 耗时）有时候会变形。
- 根因：`.srv-header` 是不换行 flex 行，但 `.srv-status-text`（“运行中”）与 `.srv-elapsed`（“· 4 分 58 秒”）无 `white-space: nowrap` / `flex-shrink: 0`；容器不够宽时（多窗口窄分块、描述名长、耗时进位变宽）被 flex 压到 min-content 以下，中文任意字符间可断行——“运行中”竖排成三行、耗时折成两行，整条变高错位。间歇性 = 只有总宽跨过临界值才触发。
- 修复：两项加 `white-space: nowrap` + `flex-shrink: 0`，压缩量全部由描述名（已有 ellipsis，overflow:hidden 使 min-width 归零）吸收；头部最坏情况只截断名字，不再折行变形。单/多窗口共用同一组件，一处修复全覆盖。
- 验证：forge-ui typecheck 0 错（纯 CSS 改动，布局行为人工核验）。

## v3.40 (技能标签语义色：暖琥珀)

- 用户反馈：消息气泡里"技能"标签文字没有颜色。原因：技能名/标签用的是 `--brand`，而本套设计系统 brand=中性灰（chroma 0），视觉上无色。
- 实现：design-tokens 新增 `--brand-accent`（暖琥珀，与 LOGO 渐变点缀色同源；light `oklch(0.65 0.14 85)` / dark `oklch(0.8 0.14 85)` 提亮保对比）；仅 `MessageCard` 消息气泡内技能名 `.is-skill` 与"技能"标签 `.tag-skill` 改用该令牌（用户裁定：浮窗/列表保留原色不夸张）。
- 验证：forge-ui typecheck 0 错、143 测试全过。

## v3.39 (修复：贴图后拖拽输入框高度导致内容重叠)

- 用户反馈：贴图后往下拉（拖拽上边沿调低输入框高度），文本与拼写红线、附件缩略图、底部操作条叠在一起。
- 根因：拖拽下限 `rsFloor = 上内边距12 + 输入区minHeight68 + 底部预留58 − 2 ≈ 136px`，**未计入附件行实高**（贴图后约 74px）；盒子被压到 136px 时内容溢出，`.compose-bar` 是 absolute 钉底，视觉上直接叠在文本上。
- 修复：提取 `minBoxHeight()`（上内边距 + 附件行 offsetHeight + 输入区最小高度 + 底部预留）；拖拽起点与拖拽中均用新下限；另加 `watch(attachments.length)`——手动拖过（inline height 已设）的盒子在附件增减后低于新下限则抬起（nextTick 后量 attach-row 实高，覆盖“先拖矮后贴图”时序）；auto 高度盒子自然增长不干预。
- 验证：forge-ui typecheck 0 错、143 测试全过。

## v3.38 (新建会话默认选中项目列表第一项)

- 用户反馈：新建会话的归属默认不是最近使用的项目，而是某个历史项目。排查：① `lastActiveAt` 仅在 createSession 写一次、之后从不更新，"最近激活项目"实为"最近创建会话的项目"；② 旧默认仅在 `currentProjectPath === null` 时生效，但启动时 `loadProjects` 自动打开 `projects[0]`，条件几乎永远不成立，草稿直接继承侧栏当前选中（可能是钉扎的老项目）。
- 用户裁定（体验定版）：下拉列表**顺序不变**（pickOrder=首次选中次序），新建会话时**默认选中列表第一项**；项目工作区行内"新建会话"仍固定归属所在项目。
- 实现：`App` 提取 `orderedProjects` computed（pickOrder 排序收口，picker 与默认落点共用）；`onCreateSession(sessionProjectPath?)` 无载荷→归属=列表第一项，有载荷（`ProjectTree` 行内新建 emit 携带项目 path）→归属=该项目；删除 `sessionView.defaultDraftProjectPath` 及其 3 个单测（孤儿代码）；工具栏新建按钮改 `@click="onCreateSession()"`（避免 PointerEvent 误作路径载荷）。
- 验证：forge-ui typecheck 0 错、143 测试全过。
- 文档同步：`prd/02_session_management.md` SM-S01 业务规则 + AC-SM-030 + 追溯表 v3.38 行；`test/02_session/coverage-matrix.md` AC-SM-030 / U-SM-006 / E-SM-007。

## v3.37 (流式指示器读秒)

- 用户需求："思考中"动画右侧增加读秒，从 AI 回复开始计时。
- 实现：`useSessionConversation` 新增 `streamElapsedSec`（watch `isStreaming` 唯一收口：置 true 记起点 + 1s interval 计数，置 false/卸载清除归零；覆盖 send/statusChanged/statusHint 兒底全部入口）；单视图 `.conv-thinking` 与多窗口 `.wc-thinking` 指示文字右侧追加计时（tabular-nums 小号弱化色）；格式化 `utils/formatElapsed.ts`：秒→分→小时进位且秒位持续在转（`42s`/`1m26s`/`1h2m8s`，整分/整时省零位 `10m`、`1h`）。
- 验证：typecheck 0 错，forge-ui 143 测试全过。
- 修复（用户反馈：切会话读秒被重置）：起点改存模块级 `turnStartAt`（sessionId → 时刻，跨视图实例共享）——切走仅停表不删起点，切回（statusHint 兒底置 true）按原起点继续读秒；轮次终态 done/idle/canceled/error、取消、send 即时失败才删；`statusChanged streaming` 无条件刷新起点（防切走期间终态事件被过滤后残留旧起点串入新轮次）。
- 修复（用户反馈：单视图切会话读秒全同）：根因是会话切换在同 tick 内 `isStreaming` false→true，`watch(isStreaming)` 去重后视为无变化不触发，计时器永不重启、沿用上个会话起点（多窗口每窗格独立实例故无此问题）。重写为显式 `startElapsed/stopElapsed`（send/statusChanged streaming/statusHint 兒底/restoreStreaming 各真实转折点调用）+ 新增 `restoreStreaming(active)` 供 ConversationView 切会话处替换直写 `isStreaming`（一并接管读秒启停）。新增回归测试 `streamElapsed.test.ts` 2 用例（同 tick 切会话各显各的秒数；跨实例起点共享续算）；src/composables 导入补 `.ts` 后缀使 node --test 可直跑，forge-ui tsconfig `allowImportingTsExtensions` 放开（noEmit 下无构建影响）。

## v3.36 (项目右键菜单：打开项目所在目录)

- 用户需求：侧栏项目右键/⋯ 菜单增加"打开项目所在目录"，快捷定位项目文件夹。
- 实现：forge-desktop 新增 IPC 通道 `forge:shell:openPath`（main 调 `shell.openPath`，成功 true/失败 false；路径非 string/空串直接 false）+ preload `window.forge.shell.openPath` + bridge 类型 + mock-bridge no-op；`ProjectTree` 菜单插入"打开项目所在目录"项（文件夹图标，位于重命名之前、删除项保持最末），点击后关菜单并直接调 shell（沿用 InstructionInput/TitleBar 直调 window.forge 先例，不经 emit 链），菜单高度估算 96→144。
- 验证：typecheck 全 workspace 0 错。
- 文档同步：`prd/01_project_management.md` 操作入口 + v3.36 交互补段。

## v3.35 (展示修复：气泡内孤立 @ 残留)

- 用户反馈：粘贴图片发送后，气泡正文尾部多出一个裸 `@`（用户并未手打 @）。
- 根因：forge 粘贴图发送 `@绝对路径` 行，全局 pi-image-view 扩展在 pi 会话内把路径改写为 `[[Image #N]](file:///…blobs/…)` 链接并附 base64 图 part；forge 展示层剥离链接后行首残留孤立 `@`。
- 实现：`attachmentText.ts` 链接图片正则与 `[Image #N]` 占位行正则均兼容可选 `@` 前缀（`!?@?\[…\](…)`、`@?\s*\[Image #N\]`），改写后的附件行整体剥除不残留；非图片链接/普通 @mention 不受影响（匹配后仍需过图片路径校验）。
- 测试：attachmentText.test 新增 3 用例（真实会话 `@[[]]` 形态 / 裸 `@[Image #N]` / 无 base64 part 时提取缩略图且不留 @），forge-ui 143 全过；typecheck 存量 2 错（useSessionConversation.vue 类型导入）非本次引入。

## v3.34 (SM-S01 验收修正：会话中项目 pill 不再弹浮窗)

- 用户反馈：已创建会话的归属项目浮窗（信息态）不需要，只有新会话（草稿态）选归属才要弹。
- 实现：`InstructionInput.toggleProjMenu` 仅 draft 态生效；删除会话中信息态下拉块及孤立 `.proj-item-static` 样式；会话中 pill 变只读（`proj-pill-static`：无 ▾、无 hover 反馈、cursor default，tooltip 去掉"点击查看"）；`v-if` 加 mode 守卫防草稿转会话瞬间残留空浮窗壳。
- 验证：typecheck 0 错、forge-ui 140 测试全过。
- 文档同步：`prd/02_session_management.md`（v3.21 规则 + AC-SM-029）、`test/02_session/coverage-matrix.md`（AC-SM-029/E-SM-007）。

## v3.33 (PM-S03 决策改判：移除项目级联删除名下会话)

- 用户验收反馈：v3.31 的"有会话禁止移除"不好用；裁定改回"删除项目就连同名下会话一并删除"（经核实旧代码从未是级联逻辑，TD-PM-05 原 A 决策保留会话正是孤儿会话问题的根因；本次正式改判为 B）。
- 实现：`ProjectService` 新增可选 `ProjectSessionsPort`（`deleteSession` 委托 sessionService：停运行+删 pi 会话文件+删 forge 会话记录），`removeProject` 改 async 级联删除后删项目记录；RPC 层逐个发射 `session.removed`（多窗口同步）+ `project.removed`，响应 `data={removedSessions:N}`；未注入端口时保持旧语义（测试兼容）。`createForgeCore` 晚绑定注入端口（同 subagentServiceRef 模式）。前端去掉 v3.31 阻止守卫，toast 汇报"项目已移除，连同 N 个会话一并删除"；下拉 × tooltip 改为"连同其下会话一并删除，源文件保留"。
- 测试：projectService/projectHandler 新增级联用例（只删本项目会话、他项目不受影响、session.removed 逐个发射、幂等 removedSessions:0），存量 removeProject 用例改 async，334/172/140 全过、typecheck 0 错。
- 文档同步：`api/01_project.md`（removeProject 契约改级联 + data 形状）、`prd/01_project_management.md`（TD-PM-05 改判 B + PM-S03 规则/边界/AC-PM-006/007/009）、`prd/02_session_management.md`（AC-SM-028 + v3.21 规则）、两份 coverage-matrix。

## v3.32 (CV-S01 扩展：@ 弹文件补全，与附件 @ 协议闭环)

- 用户需求（已确认）：输入框行内敲 `@` 弹出当前项目文件补全，选中即进待发区——与 v3.30 的 @ 路径行协议、待发区 chip、气泡展示全链路闭环。
- 交互：光标所在 token 以 `@` 开头且 @ 前为空白/行首时触发（邮箱式 token 不误触发）；↑↓ 循环、Enter/Tab/点击选中、Esc/失焦/@ 后空格关闭；与斜杠浮窗互斥。
- 实现：forge-desktop `attachments.ts` 新增 `listProjectFiles`（BFS 遍历项目内白名单文件，忽略 node_modules/.git/dist 等，上限 2000，浅层优先；IPC 通道 `forge:file:listProjectFiles` 直连，不走 RPC 表）；forge-ui 新增 `utils/atCompletion.ts` 纯函数（`detectAtContext` token 检测 + `filterAtFiles` 分级排序：basename 前缀>包含>路径包含、同级路径短者前）；`InstructionInput` 新增 @ 浮窗（复用 slash-menu 样式）与 `projectPath` prop（单视图传 project.path，多窗口经 MultiWindowConversation 透传 session.projectPath）；候选按项目缓存，切项目失效；选中 = 移除 @token + addPaths 进待发区（与选择/粘贴/拖拽同链路，发送时统一拼 @ 路径行）。
- 明确不做：不内联插入路径（保持 v3.30 展示层零歧义）；目录导航；模糊拼音匹配。
- 测试：atCompletion.test 8 用例、desktop attachments.test 补遍历用例（白名单/忽略目录/缺失目录）、e2e 新增 atCompletion.spec（E-CV-019：触发/过滤/选中/空态，全过）；forge-ui 140、desktop 172、core 332 全过，typecheck 0 错。
- 文档同步：`prd/03_conversation.md`（AC-CV-034~036）、`test/03_conversation/coverage-matrix.md`（AC 矩阵 + U-CV-013 + A-CV-014 + E-CV-019）、`test/03_conversation/e2e.md`（E-CV-019）。
- 已知无关失败：e2e smoke/session 两用例因并行 SM-S01 工作树改了 TitleBar（.workspace-brand 移除）而过期，非本交付引入。

## v3.31 (PM-S03 验收修正：项目名下有会话时禁止移除)（已被 v3.33 取代）

- 用户验收反馈：移除项目后，原本在该项目下创建的会话"丢失项目"——项目视角按项目记录分组渲染会话，项目记录删除后其会话不再出现在项目树（任务视角仅剩 basename tag）。侧栏右键移除入口一直存在此问题，下拉删除使其更易触发。
- 实现：`App.onRemoveProject` 增加前置守卫——项目名下仍有会话（含运行中）时 toast 阻止并提示"先删除会话再移除项目"；下拉 × 与侧栏右键两个入口同一 handler 自动全覆盖。服务层 `removeProject` 保持幂等可移除不变（headless 兼容；TD-PM-05 不级联删会话的冻结决策不变）。
- 验证：typecheck 0 错、forge-ui 132 测试全过。
- 文档同步：`prd/01_project_management.md`（PM-S03 异常边界改写 + AC-PM-009 新增 + AC-PM-006 边界条件修正）、`prd/02_session_management.md`（AC-SM-028）、`test/02_session/coverage-matrix.md`（E-SM-007）。

## v3.30 (CV-S01 附件协议标记：@路径行，展示层零歧义)

- 用户方案（已确认）：附件（选择/粘贴/拖拽三入口）发送时路径行统一加 `@` 前缀（`正文\n@C:\a.ts`），手敲裸路径一律当正文——把“展示层猜路径行”换成“显式协议标记”，根除路径开头消息被误吞成 chip 一类问题（v3.26 的根因）。
- 实现：`InstructionInput.onSend` 拼附件行加 `@`；`attachmentText.ts` 新增 `attachmentPathOf`（`@` 后必须是路径形状，防 @mention 被吞），`@` 行优先提取为附件（展示时剥离 @），裸路径行保留为旧会话兼容兕底；模型侧零改动（`@C:\x` 仍是正文里的绝对路径，模型自行 read）。
- 明确不做：手敲 `@` 弹文件补全（Cursor 式，大功能）；正文中间内联 `@路径` 解析（空格分词问题，另立 feature）。
- 测试：attachmentText.test 新增 3 用例（@行提取/@mention 不吞/裸路径兕底），forge-ui 132 全过、typecheck 0 错。
- 文档同步：`api/03_conversation.md`（附件约定改 @ 路径行格式）、`test/03_conversation/coverage-matrix.md`（AC-CV-013/U-CV-005/A-CV-007/E-CV-006 同步措辞）。

## v3.29 (CV-S08 验收扩展：浮窗过滤由前缀匹配放宽为模糊匹配)

- 用户需求：只记得命令名中间的文字（或描述关键词）时前缀匹配搜不到，浮窗筛选改为模糊匹配。
- 实现：`utils/slashCommand.ts` `filterCommands` 由 `startsWith` 改为 `includes`——匹配键=原始名（含 `skill:` 前缀）或描述，大小写不敏感，保持清单原序不做相关度排序；空串仍返回全量副本，入参不变契约保留。此规则与 pi TUI 前缀匹配分叉（用户裁定）。
- 测试：过滤用例改为包含语义并新增中间文字（`tests`）与描述关键词（`推送`/`查看`）用例，forge-ui 132 全过、typecheck 0 锉；e2e（`skill`/`zzz` 序列）语义兼容无需改。
- 文档同步：`prd/03_conversation.md`（场景表/常规默认项/功能点过滤/AC-CV-028/ASCII 图/性能段 6 处）、`test/03_conversation/coverage-matrix.md`（AC-CV-028 与 U-CV-012 断言）。

## v3.29 (SM-S01 验收扩展：下拉项目按选中次序排序)

- 用户需求：A/B/C 三项目，先选 B 再选 C，下拉应为 B、C、A（按最后选中次序，先选中在前）。
- 实现：App.vue 新增 `pickOrder`（localStorage `forge:project-pick-order` 持久，复用 treeView 记忆模式）——`onPickProject` 首次选中追加定序（重复选中不变），移除项目同步清除记录；`projectPicker.items` 按 pickOrder 序稳定排序，未选中的保持后端序排后。仅影响输入框下拉排序，侧栏/后端 lastOpenedAt 语义不变。
- 验证：typecheck 0 错、forge-ui 132 测试全过。
- 文档同步：`prd/02_session_management.md`（选择器排序规则 + AC-SM-028）。

## v3.28 (SM-S01 验收修正：打开项目直达系统选择器 + 下拉去杂标)

- 用户反馈：新建/打开项目不要中间弹窗，直接弹文件夹选择器；下拉条目黄点（运行中）和 ✓ 都去掉，只留悬停删除。
- 实现：删除 `ProjectPickerDialog.vue`（弹窗及其"最近路径"链路一并移除）；App.vue 新增 `openFolderPicker()`——`window.forge.dialog.selectDirectory()` 选中即注册（取消无操作），"打开项目…"菜单项/空态"打开项目"按钮均接此函数；InstructionInput 下拉去掉 `proj-item-dot`/`proj-item-check` 及对应 CSS，条目唯一操作标=悬停裸 ×（无底色），首点变红色「确认」胶囊（同删除会话两阶段款）；types.ts `ProjectPickerDescriptor.items` 去掉孤立字段 `hasRunning`。
- 验证：typecheck 全 workspace 0 错、forge-ui 127 测试全过。
- 文档同步：`prd/01_project_management.md`（操作入口改为直达系统选择器）、`prd/02_session_management.md`（选择器规则 + AC-SM-028）、`test/02_session/coverage-matrix.md`（AC-SM-028/E-SM-007）。

## v3.27 (SM-S01 验收扩展：输入框项目下拉支持移除项目)

- 用户需求：输入框项目选择器下拉（新会话归属项目）中的项目要可删除。
- 实现：`InstructionInput.vue` 草稿态下拉条目悬停显示移除 ×，两阶段确认（首点变红“确认移除”，3s 内再点才发）——与侧栏 ProjectTree 同模式；事件链 `InstructionInput → ConversationView → App.onRemoveProject`（复用已有 `project/removeProject` RPC，仅删 forge 元数据，源文件/会话不动）；移除当前归属项目后由 loadProjects 自动回落首个剩余项目。会话中信息态不下拉列表，不提供移除入口。
- 验证：typecheck 全 workspace 0 错、forge-ui 127 测试全过。
- 文档同步：`prd/02_session_management.md`（v3.21 选择器规则 + AC-SM-028）、`test/02_session/coverage-matrix.md`（AC-SM-028/E-SM-007 补移除断言）。

## v3.26 (CV-S01 修复：路径开头的单行消息不再整行吞成文件 chip)

- 用户验收反馈：单行消息以路径开头（首路径 + 中间长段文字 + 尾路径）发送后，气泡只剩一个文件 chip（尾路径文件名），正文消失。
- 根因：`attachmentText.ts` `isPathLine` 只判行首路径格式，`parseUserContent` 尾部路径行剥离把整行当纯路径行吃进 `files`，`body` 变空。仅展示层问题：消息原文完整发送与存档（复制/模型可见性不受影响）。
- 实现：`isPathLine` 收紧为只认“纯路径行”——空白 + CJK（`C:\x 帮我看这个项目`）或盘符后出现 Windows 文件名非法字符（第二个冒号等，英文混排 `C:\a is at C:\b`）一律不算路径行，保留为正文；无空白的中文路径（`C:\资料\文档.docx`）与含空格英文路径（`C:\Program Files\x`）仍正常出 chip。宁可漏收（真路径显示为文字）不误吞（整条消息变 chip）。
- 测试：attachmentText.test 新增 3 用例（单行混排回归/含空格英文路径/无空白中文路径），forge-ui 14/14 过。
- 文档同步：`test/03_conversation/coverage-matrix.md` E-CV-006「用户气泡按原文展示正文+路径行」契约未变，本次为恢复该契约，无 PRD/API 改动。

## v3.25 (CV-S08 验收扩展：气泡内多个 skill 引用全部美化)

- 用户确认 pi 语义（仅展开消息开头第一个 `/skill:` 命令，其余为字面量参数）后裁定：forge 气泡内出现的全部 `/skill:name` 引用都美化——样式归 forge，执行语义归 pi；美化是样式性的，不代表该引用会被 pi 执行。
- 实现：`utils/slashCommand.ts` 新增 `splitSkillRefs`（正文按 `/skill:name` 切段，名字符集 `[A-Za-z0-9_-]+`，中文标点/`/`不吞进名）；`MessageCard.vue` 用户正文由 v-html 转为分段渲染——文本段原样插值（自动转义），引用段复用浮窗同款美化（品牌色加粗 + 技能胶囊）；命令段与正文同行内联穿插（v3.24）不变；无前导命令但句中含引用的消息同样美化。另：斜杠浮窗加 `max-width: 100%` 封顶输入框宽度（此前长描述把浮窗撑得比输入框宽，超出由条目 ellipsis 截断）。
- 测试：slashCommand.test 新增 3 用例（多引用切段/无引用与防御/标点与连写边界），forge-ui 124 全过、typecheck 0 锉。
- 文档同步：`prd/03_conversation.md`（消息气泡显示规则补多技能引用）、`test/03_conversation/coverage-matrix.md`（U-CV-012 补 splitSkillRefs 断言）。

## v3.24 (CV-S08 验收修正：气泡命令段与正文同行穿插)

- 用户验收反馈：命令段（如 `Git Pull` + 技能标签）单独占一行、正文在下一行，希望穿插在文本中、仅保留自身美化。
- 实现：`MessageCard.vue` 纯 CSS 调整——`.msg-cmd-head` 由 flex 块改为 inline，`.msg-cmd-head + .msg-content` 降为 inline，命令名/标签与剩余正文同行流式排布（间距由 name/tag margin 提供，替代原 flex gap）；美化样式（品牌色加粗 + 来源标签胶囊）不变，长正文自然折行；模板与识别逻辑零改动，复制仍为原始串。
- 验证：forge-ui 121 测试全过、typecheck 0 锉；PRD 03 仅约定「命令段浮窗同款美化 + 剩余正文照常展示」，未约束布局，无需改 PRD。

## v3.23 (CV-S08 验收修正：消息气泡斜杠命令美化 + 技能展开块收起)

- 用户验收反馈：发送 `/skill:gen-doc-all 测试一下技能` 后气泡里命令是 plain 原文，和浮窗的美化样式（Gen Doc All 加粗品牌色 + 技能标签）不一致；且 pi 展开后持久化的 user 消息是整段 `<skill>` 指令文档，历史重载后气泡会渲染出整墙技能说明。
- 实现：`utils/slashCommand.ts` 新增 `extractCommandFromMessage`（识别两种形态：发送原始串「行首 / + 无空白 token」与 pi 展开块 `<skill name=...>…</skill>`，非命令不误伤）；`MessageCard` 用户气泡把命令段渲染为浮窗同款美化（品牌色加粗 + 来源标签胶囊），命令后剩余正文照常展示，展开块指令文档收起不展示；复制按钮仍复制原始内容（语义不变，TD-CV-09 零拦截不受影响）。
- 测试：slashCommand.test 新增 6 用例（40/40），forge-ui 121 全过、typecheck 0 锉、slash/输入框相关 e2e 17/17。
- 文档同步：`prd/03_conversation.md`（CV-S08 消息气泡显示规则）、`test/03_conversation/coverage-matrix.md`（U-CV-012 补气泡命令段识别断言）。

## v3.22 (模块 03 扩展 CV-S08 斜杠命令交付：输入框 / 命令浮窗，pi 原生执行)

- 交付（dev-flow run 20260902145236，5 WU 全过 + D5 Fan-in + D6 模块 QA PASS，开发视图 `plan/cv-s08-slash-commands.md`）：输入框行首 `/` 弹出命令浮窗（pi 生态三类：扩展命令/skills/prompt 模板；pi TUI 内置命令不映射不拦截），↑↓ 循环导航 + Enter/Tab/鼠标单击选择，插入恒为原始命令串（`/skill:git-push ` 尾随空格光标在后），随消息发送后 pi 原生解析执行——零拦截零注册表；浮窗 codex 风格美化（剥前缀/Title Case/skill 加粗品牌色/描述副文本/来源标签），前缀实时过滤，无匹配/无可用命令空态，枚举失败降级空清单不阻塞输入，streaming 期间禁用。
- 实现：forge-core conversationService（SlashCommand 类型/getSlashCommands 双模式/ingest 会话级缓存幂等）；forge-extensions 首个真实 pi 扩展 slashCommandReporter（session_start 调 pi.getCommands() 经 `slash-commands:reported` 总线上报，抛错静默不阻断）；forge-ui utils/slashCommand.ts 纯函数（检测/过滤/美化/插入串，34 用例）+ InstructionInput 浮窗集成；forge-desktop createForgeCore 桥接接线 + 草稿态轻量资源查询 port（DefaultResourceLoader noExtensions 直查，失败返回 []）。
- 测试：core 332 / desktop 171 / ui 112 单测全绿；e2e slashCommands.spec 5 条（E-CV-014~018）全过；PIC-007 真实链路 QA 期验证 5/5（真实 ~/.pi/agent 上报 51 条命令、缓存生效、/skill:git-push 原样发送、草稿态无扩展、降级无报错；模型回复端到端因无真实 LLM 端点按 PIC-005/006 先例记已知集成待办）。
- 修复：e2e 全局超时根因为根入口 `@forge/core` import（node:events 浏览器炸 → mock 注入崩），forge-ui 浏览器引用一律改瘦子路径；TSC-E2E-004 无脚本草稿激活按真实后端语义补两侧事件（树侧 DB done + session.updated、视图侧 conversation.statusChanged）。
- 文档同步：`prd/03_conversation.md`（AC-CV-026~033）、`api/03_conversation.md` §9、`test/03_conversation/coverage-matrix.md` + `e2e.md`（E-CV-014~018）、`test/integration/pi-core.md`（PIC-007）。

## v3.21 (输入框项目选择器：新会话归属显性化，移除侧栏打开项目按钮)

- 用户需求（对齐稿 `plan/input-project-picker-mockup.html` 已确认）：任务视角下新建会话不知道落哪个项目；参考 zcode/WorkBuddy/OpenCode 在输入框附近选项目的做法改造。
- 交互：输入框底行左侧第一位 `📁 项目名 ▾`——**草稿态**=下拉选归属（已打开项目：别名+路径+运行中状态点+当前 ✓；底部"打开项目…"复用 ProjectPickerDialog；选中=切当前项目，草稿保留）；**会话中**=同式样可点，信息态（归属+完整路径，归属绑定 cwd 不可换；定位动作用户裁定裁剪）。任务视角"新建会话"默认落最近激活项目（lastActiveAt），禁用条件放宽为"无任何已打开项目"；侧栏顶部打开项目按钮移除（入口收敏到输入框下拉+内容区空态）。
- 实现：`utils/sessionView.ts` 新增 `defaultDraftProjectPath`（TDD RED→GREEN，4 用例）；`InstructionInput` 新增 `projectPicker` prop + `pick-project/open-project-picker` 事件（多窗口 compact 不传不渲染，窗口标题行已有项目 pill）；`ConversationView` 透传；`App` 组装描述符（`projectTagOf` 复用命名）+ 新建默认落点。
- 测试：forge-ui 115 全过，四包 typecheck 通过。
- 文档同步：PRD 01（入口描述）、PRD 02（SM-S01 交互规则 + AC-SM-028~030 + 自检 24 项）、coverage-matrix（基线 3 行 + U-SM-006 + E-SM-007）。

## v3.20 (会话列表双视角 + LOGO 缩放按钮合一，SM-S06/S07)

- 用户需求（设计稿 `plan/logo-view-mockup.html` 已确认）：①FORGE 文字 LOGO 先隐藏，左上角缩放按钮改 zcode 风格方形 LOGO 瓷片——默认显瓷片、hover 变缩放图标、点击折叠/展开会话树行为不变；②会话列表增加项目/任务双视角——任务视角平摊所有会话不分项目、行尾项目 tag，排序复用激活序（运行中置顶且保留）；项目视角增加「收起全部/展开全部」无 边框 ghost 按钮（对角双箭头内收/外扩两态）；③多窗口「返回多窗口」聚焦行补项目 pill（窗口标题行项目 pill 现状已有，保留）。
- PRD 增量：`prd/02_session_management.md` 新增场景 SM-S06/SM-S07、AC-SM-022~027、已确认决策 3 条、页面承载入口更新、自检扩至 23 项 PASS。
- 实现：新增 `forge-ui/src/utils/sessionView.ts` 纯函数（`sortSessionsByActivation` 激活序排序、`nextFoldAllAction` 两态判定、`projectTagOf` 项目 tag，项目/任务两视角共用）；`ProjectTree.vue` 接 `view` prop 渲染任务视角平摊列表（重命名/删除/拖拽开窗/已开窗灰态与项目视角一致；默认前 20 条截断，多余「展开显示 N 个」），`collapseAll/expandAll` expose + `fold-state` 上报；`App.vue` 侧栏顶部「项目/任务」分段开关（localStorage `forge:sidebar:view` 记忆）+ 收起/展开全部按钮（仅项目视角）+ 聚焦行项目 pill + 移除 FORGE 文字；`TitleBar.vue` 缩放按钮 LOGO 瓷片化（120ms 交叉淡入，折叠态箭头朝右）。
- 测试：TDD RED→GREEN，forge-ui 新增 `test/sessionView.test.ts` 8 用例（激活序稳定排序/纯函数性/两态判定含空列表/项目 tag 别名优先与脏数据回退）；forge-ui 112 全过，四包 typecheck 通过；E2E 补 `E-SM-006`（双视角/收起展开/LOGO 按钮/聚焦行/视角记忆）。
- 文档同步：`test/02_session/coverage-matrix.md`（AC-SM-022~027 基线 + U-SM-005 + E-SM-006）、`test/02_session/e2e.md`（E-SM-006 详情 + 汇总行）。

## v3.19 (附件格式白名单：粘贴/拖拽补上格式校验，新增 Excel/Word)

- 用户需求：上传附件、粘贴、拖拽都要判断文件格式；当前粘贴与拖拽不判格式，任意文件（exe/dll 均可）直接进待发区；同时新增 Excel/Word 支持。
- 现状梳理：格式约束仅存在于文件选择器的 Electron dialog filter（软过滤，可手动输入文件名绕过，选中后渲染层不再复查）；粘贴/拖拽完全不判格式（无盘文件仅收截图图片，其余静默丢弃）。
- 变更：新增 `@forge/core` `attachments.ts` 附件格式白名单（单一事实来源）：图片 `png/jpg/jpeg/gif/webp` + 文本与代码 `txt/md/json/log/csv/yaml/yml/toml/xml/html/css/js/ts/py/java/go/rs/c/cpp/h` + **新增 Office 文档 `xlsx/xls/docx/doc`**；①主进程选择器 dialog filters 改由白名单派生（原硬编码 25 项）；②渲染层 `addPaths` 统一白名单校验（选择/粘贴/拖拽三入口的必经汇聚点），不支持格式拒绝入待发区并提示「不支持的文件格式：xxx」；③粘贴无盘非图片文件从静默跳过改为报错提示。
- 边界：xlsx/xls/docx/doc 为二进制（zip）格式，不参与密钥嗅探（TEXT_SCAN_EXTS 仅收文本扩展名，对压缩字节做明文正则无意义）；无扩展名文件（如 Dockerfile）按白名单拒绝。
- 测试：forge-core 新增 `test/attachments.test.ts`（放行/大小写/拒绝/过滤项派生共 3 用例）；forge-core 332 / forge-desktop 171 / forge-ui 103 全过，三包 typecheck 通过。
- 文档同步：`api/03_conversation.md`（附件格式白名单段落）、`test/03_conversation/coverage-matrix.md`（U-CV-005 补不支持格式拒绝断言）。

## v3.18 (模块 03 扩展 CV-S08 斜杠命令 PRD 确认)

- 用户需求「输入 / 斜杠需要跟 pi 一样把内容浮窗出来，回车或者 tab 或鼠标单击选择，输入之后 pi 要能识别到这些命令」；用户逐步裁定：①命令面板只列 **pi 生态自动发现命令**（扩展命令 + skills + prompt 模板），**pi TUI 内置命令（/model /compact /quit 等）一律不做 forge 侧映射与拦截**（曾考虑映射 /compact，后整层砍掉）；②浮窗显示参考 codex 美化（不显示 `/` 与 `skill:` 前缀、`git-push` → `Git Push`、skill 加粗品牌色）；③草稿态必须能看到 skill 命令。
- PRD 03 新增：场景 CV-S08、技术决策 TD-CV-07/08/09、功能点 CV-S08（含页面承载浮窗 ASCII 图与非功能量化）、AC-CV-026~033（8 条）；自检扩展 10 项全 PASS。
- 关键决策：TD-CV-07=A（forge-extensions 承载**首个真实 pi 扩展**——命令上报扩展，会话启动时调运行时命令枚举经事件总线上报，与 pi-subagents 桥接同构）；TD-CV-08=A（草稿态轻量资源查询直取 skills/模板，扩展命令会话激活后补全）；TD-CV-09=A（选中命令原样经既有发送链路，pi 原生解析执行，零拦截零注册表）。
- 硬边界：插入文本恒为原始命令串（`/skill:git-push ` 尾随空格光标在后），美化名不进输入框；命令枚举失败降级空清单不阻塞输入。
- 同步：`prd/03_conversation.md`（第 1-4 节扩展）、`prd/index.md`（03 行）、`overview.md`（模块表 03 行 + MVP 范围 + 当前状态）。
- API 增量（`api/03_conversation.md` §9）：方法 `conversation/getSlashCommands`（sessionId 可选=会话/草稿态双模式，projectPath 草稿态项目级发现；枚举失败返回空清单不报错）；事件 `conversation.slashCommandsUpdated`（上报到达 → UI 缓存失效重拉）；桥接约定（命令上报扩展 `session_start` 经事件总线上报，与 pi-subagents 同构；命令执行无专用接口，经 sendMessage 原样发送）。
- 测试设计增量：`test/03_conversation/coverage-matrix.md`（AC-CV-026~033 基线含必测标记 + U-CV-011/012 纯函数 + A-CV-011~013 契约）；`test/03_conversation/e2e.md`（E-CV-014~018：触发/美化/过滤/空态、导航/选择/插入原始串、四关闭路径、草稿态补全、枚举失败降级）；`test/integration/pi-core.md` 新增 **PIC-007**（命令上报扩展真实链路：上报清单与 getCommands 一致、skill 原生展开、草稿态降级、扩展缺失降级）；`test/index.md` 03 行 8/8 覆盖。
- DB 增量：无（命令清单会话级内存缓存，不持久化）。
- 状态：gen-doc-all 流程完成——确认点 1、确认点 2、PRD 两轮、API/测试设计均已确认；artifacts.json 03 各项维持 approved（既有文件内容扩展，无新增产物）。下一步可调 `dev` 开发（建议 WU 拆分：forge-extensions 命令上报扩展 + desktop/core 枚举链路 / InstructionInput 斜杠浮窗纯函数与交互 / e2e 与集成验证）。

## v3.17 (附件统一给路径)

- 背景：附件原为「读内容内联」机制——图片转 base64 经 `prompt(images)` 直出、文本 ≤200KB 以受控片段拼入正文，与 pi 原生「路径进消息、模型自行 read」机制并存，两套逻辑维护成本高。
- 变更：附件统一给路径——选择/粘贴/拖入只收集绝对路径，以独立行追加在正文后随消息发送；文件内容由模型自行用 read 工具读取（图片自动转 image 块）。剪贴板截图（无盘文件）由主进程落盘系统临时目录（`forge-paste-HHmmss.png`）再给路径。
- 删除：文本内联拼装与 `TEXT_ATTACHMENT_PREAMBLE` 防注入前导（forge-core）、多模态门控与 `skippedImages`（forge-core + UI 标记；非视觉模型遇图片由 pi-ai 传输层 `downgradeUnsupportedImages` 自动降级占位，不报错）、历史回显的附件片段剥离（loadPiSessionHistory）、base64/文本内容读取与 10MB/200KB/30MB 限制（forge-desktop）。
- 保留：附件密钥嗅探（移至主进程 `attachments.ts`，文本文件命中凭据特征 → 待发区警示边框 + 发送前确认，覆盖选择/粘贴/拖拽三个入口）、附件数上限 10。
- UI 还原（v3.17 追加，用户实测反馈）：① 用户气泡内附件不再显示路径——图片出缩略图（120px，点击灯箱放大，异步读 data URL），非图片出文件占位 chip（icon+文件名，title 显示完整路径）；解析覆盖三种形态：forge 发送的尾部路径行、markdown 链接图片（单层/双层方括号）、pi 会话消息的裸 `[Image #N]` 占位行；**同一条消息同时含 base64 image part 时，文本里的链接/占位符只剥离不渲染（pi 存储格式是链接+base64 双份引用同一张图，否则同一张图出现两遍——v3.17 首版的回归，`hasEmbeddedImages` 修复）**；`attachmentText.ts` `parseUserContent` 纯函数 + 11 单测；② 输入框图片附件恢复 64px 缩略图 + 点击灯箱放大（磁盘图片新增 `file.readImage` IPC 读 data URL（≤10MB），粘贴截图直接复用手上 base64 不回读）。
- 附带修正：`generateSessionTitle` 改取首行（路径行不进标题）；首句切分修正英文句点后跟字母/数字不切（`a.ts`、`1.2` 不被腰斩）。
- 测试：新增 forge-desktop `attachments.test.ts`（嗅探/落盘 5 例）；改写门控/拼片段/剥离相关用例为新契约（RED→GREEN 全过）；三包 typecheck + build 通过。
- 文档同步：`api/03_conversation.md` §1（attachments 参数与 skippedImages 响应移除，补路径行约定）；coverage-matrix AC-CV-013/U-CV-005/A-CV-007/E-CV-006 重写为路径化行为。

## v3.16 (首条消息自动命名不再包含附件占位)

- 用户反馈：带附件发送首条消息时，会话树标题变成「这个文件能识别吗[附件：build_docker_or…]」——附件拼片段被当作标题的一部分。
- 根因（`createForgeCore.ts` `generateSessionTitle`）：RPC 层把文本附件以「不可信声明 + [附件：<name>] 块」拼在正文末尾后才进 `onFirstUserMessage`，标题生成直接对拼接后全文截首句，附件块（及其文件内容）随入标题。
- 修复：`generateSessionTitle` 先剥离拼接的附件片段（按声明标记截断 + 兼容旧格式裸 `[附件：<name>]` 块）再取首句；纯附件消息（无正文）回退「新会话」。已有会话的脏标题可右键重命名修正。
- 测试：forge-desktop `createForgeCore.test.ts` 新增「generateSessionTitle：附件拼片段不进标题」（现格式/旧格式/纯附件/无附件不变共 4 断言）；forge-desktop 150 全过 + typecheck 通过。
- 文档同步：PRD 02 跨模块影响补附件不进标题规则；docs/test/02_session/e2e.md E-SM-001 断言补充。

## v3.15 (子 agent 视图三处体验修正 + 状态回退 bug)

- 用户实测反馈三问题：1) 运行中顶部占位文案"子 Agent 排队中，开始运行后此处将显示进展"多余，且跑了 11 秒状态仍显示"排队中"；2) 消息流外层套边框容器太丑；3) 完成后正文是原始 markdown 源码（pre 纯文本），与过程中的渲染效果不一致。
- 根因与修复：
  - **状态回退 bug（forge-core）**：pi-subagents 实际事件序为 started（spawn 内部）先于 created（工具处理器后补），`SubagentService.applyEvent` 原本允许活跃态任意互转，迟到的 created(queued) 把 running 拉回 queued → 全程误显"排队中"。修复：活跃态只前进不回退（running→queued 回退忽略），新增 U-SA-010 单测。
  - **占位与外框（forge-ui）**：删除占位文案块与 `.srv-stream` 边框容器；改为底部无边框"正在思考…/正在输出…"指示（与主会话一致），消息流直接排版。
  - **终态一致性（forge-ui）**：终态不再切换视图——同一条消息流保留（末条 assistant 正文即 result），指示消失、附 Token 用量；无过程数据时 completed 兜底用 result 全文同源 markdown 渲染。补终态切换时的 tail 补拉（watch isActive），否则完成瞬间拿不到含 result 的完整尾部。
- **尾部悬挂围栏清理（v3.15 追加，用户实测反馈）**：子 agent 嵌套代码块时常把围栏写不配平，渲染成空代码块框或把收尾语套进代码框。`subagentStream.ts` 新增 `stripDanglingFence`（CommonMark 语义模拟开合；消息以未闭合围栏收尾时丢弃该行围栏，其后内容转普通文本），消息流 flush 与 result 兜底路径共用；配平围栏不受影响。
- **工具折叠分组（v3.15 追加，用户实测反馈）**：子 agent 连续工具摘要行刷屏（截图一长串 grep/bash）观感复杂。对齐主会话 tool-group 交互：`subagentStream.ts` 新增 `groupStreamNodes`（连续 ≥2 工具聚组，纯函数），视图渲染折叠头（"工具调用 N 次"+工具名×次数 chips，默认收起，点击展开），单工具行不分组。
- 测试：forge-core 310（+1）、forge-ui 58（+3）全过；subagent e2e 11/11（SUB-E2E-005/011 断言改为新视图语义，mock 终态末条正文=result、双工具连发触发分组，对齐真实链路）；vue-tsc 通过。
- 文档同步：PRD 06 SA-F04 业务规则/AC-SA-013/025/026 改版；docs/test/06_subagent E-SA-010 重写、U-SA-010 新增、coverage-matrix 同步。

## v3.14 (子 agent 实时过程改为可读消息流)

- 用户反馈：切到子 agent 后"实时过程"区显示原始 JSON 协议流与命令输出（如 grep 结果、{"type":"toolResult",...}），用户看不懂；期望与主会话一致看渲染后的文字，大概了解子 agent 在干什么。
- 根因（`SubagentResultView.vue`）：把 `subagent/queryOutput` 返回的输出文件尾部当纯文本 `<pre>` 渲染。该文件是 pi-subagents 写的 JSONL（type=user/assistant/toolResult 条目），内容是 SDK 协议对象而非给人看的过程；主会话的渲染链路（pushDelta→renderMarkdown）与它完全不相通。
- 修复：
  - forge-ui 新增 `utils/subagentStream.ts`：把输出文件尾部按 JSONL 行解析成时间线——assistant 文本块 → markdown 正文条目；toolCall/toolResult → 工具摘要行（工具名+参数预览+running/ok/error，按 toolCallId 配对，切断时从 result 合成）；thinking/user 条目与解析失败行（尾部切断首行残片）静默跳过。
  - `SubagentResultView.vue`：运行中正文改为消息流渲染（renderMarkdown 与主会话同源 + 工具摘要行 + 自动滚动）；删除终态"执行过程"折叠面板与文件大小显示（终态直接看 result 正文）。
  - `mock-bridge.ts` queryOutput 改返回真实 JSONL 格式（运行中按 startedAt 逐步推进，不含末条终态正文）。
- 测试：新增 `test/subagentStream.test.ts`（6 用例）；E2E SUB-E2E-011 重写为消息流断言，subagent 套件 11 用例全过；vue-tsc 通过。
- 文档同步：PRD 06 SA-F04 业务规则与 AC-SA-025/026 改版；docs/test/06_subagent 补 E-SA-010（e2e.md）、U-SA-009（unit.md）、coverage-matrix 两行。

## v3.13 (运行中会话状态点选中态一致性)

- 用户反馈：会话运行中时选中该会话，会话树的状态点（黄点/脉动）不显示；移开（切到其他会话）后状态点才出现。状态可见性与选中态耦合，同一会话表现不一致。
- 根因（`ProjectTree.vue` `shouldShowDot`）：函数首位写死 `currentId === s.sessionId return false`——把"选中高亮"与"状态点"绑在一起，隐含假设高亮已携带状态信息。实际上高亮只表达选中、不表达状态；运行中/出错的状态点必须独立可见，否则用户看不到会话在跑。
- 修复：删除该特判，`shouldShowDot` 不再依赖 `currentSessionId`。done 状态的「查看后隐藏绿点」语义仍由 `doneReadSessions` + `selectSession` / `streaming→done` watcher 兜底，与选中态无关。
- 验证：UI e2e 新增 SESSION-E2E-002b（选中 running 会话→状态点存在；切走→状态点仍存在），全量 47 用例通过；`vue-tsc` typecheck 通过。
- 文档同步：`docs/test/02_session/coverage-matrix.md` 新增 E-SM-002b（AC-SM-010 正交一致性回归）。

## v3.12 (草稿态思考级别切换器：新建会话即可见可选，级别随会话创建写入)

- 用户反馈：新建会话时输入框模型选择旁无思考级别切换器，发送首条消息后才出现。
- 根因（`InstructionInput.vue`）：`loadThinkingState` 要求 `sessionId` 与 `currentModel` 同时存在，草稿态（新会话未创建）无 sessionId → 切换器隐藏。而级别列表只依赖模型（`model/getModelThinkingLevels` 不需要会话），草稿的生效模型（全局默认）是可用的。
- 修复：
  - `forge-core`：`model/getSessionThinkingLevel` 的 `sessionId` 改为可选（`modelService.getSessionThinkingLevel(sessionId: string | null)`；RPC 层缺省时传 null）——缺省直接查全局默认（`effective: "global"`），供草稿态回显「新会话将继承的级别」；显式空串/非法值仍 1001，未知会话仍 1002。
  - `forge-ui`：`loadThinkingState` 拆分守卫——级别列表仅需 `currentModel`；级别回显草稿态传空参查全局默认，有会话则查会话。
  - 草稿态所选级别不丢失：`selectLevel` 在草稿态仅本地记录（原逻辑），`ConversationView.onSend` 草稿分支创建会话后、`session-created` 事件前先 `setSessionThinkingLevel` 落库（与既有 draftModel 写入对称）——保证首条消息按输入框所示级别发送，且先写后 emit 避免与输入框对 sid 的级别查询竞态。`InstructionInput` 经 `defineExpose` 暴露 `currentLevel`。
- 测试：core 新增 `sessionId=null` 查全局默认（service 层）与 `{}` 缺省 sessionId（RPC 层，含空串 1001）用例；E2E TLEVEL-E2E-002 草稿态断言改为「切换器可见 + 回显全局默认 + flush 调用断言」，种子 `getModelThinkingLevels` 对未列入映射的已配模型回退推理级别（修 boot 期 queryModels 未 seed 的全局默认模型无级别问题）。全量：core 311、desktop 141、UI e2e 46 全过；core/desktop/UI typecheck 通过。
- 文档同步：`docs/api/05_model.md` §9 sessionId 改可选；`docs/test/05_model/coverage-matrix.md` A-MP-013 补草稿态用例、E-MP-007 操作/断言同步。

## v3.11 (消息正文块间距统一：修复 pre-wrap 把 markdown 标签间换行渲染成隐形空行)

- 用户需求：对话正文的行距/块间距忽宽忽窄（截图反馈：段落↔标题、列表项、文字卡↔工具条间隙不一致）。
- 根因（无头 Chromium + 真实 renderMarkdown 实测复现，脚本 `prototypes/spacing-repro/`）：`MessageCard.vue` 的 `.msg-content` 带 `white-space: pre-wrap`（本为用户消息纯文本保留换行），但 assistant 消息走 marked 渲染，输出的 HTML 标签间带 `\n`（`</p>\n<h2>`、`</li>\n<li>`、结尾 `\n`），pre-wrap 把这些排版换行渲染成 ~21px 隐形空行：块间 6px 外边距被撑到 25~27px、列表项间 10px（ul 的 `line-height:10px` 压小了空行）、消息尾部多 27px；文字卡↔工具条视觉间隙 45px vs 18px 不对称。
- 修复（均在 `MessageCard.vue`）：① `pre-wrap` 只作用于纯文本消息（user/system/tool），markdown 消息用 normal（breaks:true 已把段内换行转 `<br>`，段内换行不受影响）；② 删除 ul/ol 的 `line-height:10px` 与 `margin-block-end:4px` 覆盖；③ 标题 `margin-block-start:18px`（首块除外，外边距塌陷后标题上方实际 18px）；④ 首块无顶边距、末块无底边距（消息内部不拖空隙）；⑤ 密度校准：基础块间距 6px→**12px**（修复 bug 后用户反馈历史消息过密：同条消息 1077px→614px，密度近翻倍；用会话 JSONL 里的真实历史消息实测后定 12px 档，代码块/表格 margin 同步 12px）。
- 修复后实测（含代码块/表格全场景）：块间 12px / 标题上 18px / 列表项 0（行距即行高）/ 尾部 0px / 文字卡↔工具条上下均 18px 对称；历史消息总高 1077→714px。
- 验证：forge-ui + forge-core 310 测试全过，`vue-tsc` typecheck 通过；复现/验证脚本在 `prototypes/spacing-repro/`（`repro.mjs` 根因对比、`compare-styles.mjs` 三档密度对比+截图、`verify-final.mjs` 终版全场景）。

## v3.10 (图片展示优化：输入框纯缩略图 + 对话框正方形图 + 弹窗看原图)

- 用户需求：①输入框图片附件不再「缩略图+文件名」胶囊，只留固定缩略图；②消息图片固定正方形；③点击放大改为全屏弹窗看原图（取消原气泡内 zoomed class 放大缩小），弹窗支持滚轮缩放。
- 新增共用组件 `ImageLightbox.vue`：全屏遮罩 + 居中原图（初始 fit 屏幕内），滚轮缩放 1x~8x（以光标位置为中心，缩回 1x 自动复位居中），Esc / 点击遮罩关闭；单窗口/多窗口共用（经 MessageCard）。
- `MessageCard.vue`：消息图片改 120px 正方形缩略图（object-fit: cover，多图横排 wrap），点击开弹窗；删除原 `zoomedImage`/`toggleZoom` 气泡内放大逻辑。
- `InstructionInput.vue`：图片附件改 64px 正方形缩略图卡片（无文件名，hover 右上角浮 × 移除），点击开弹窗预览；文本等其他附件胶囊 chip（icon+文件名）保持不变。
- 验证：forge-ui `vue-tsc` typecheck 通过。

## v3.9 (CV-S07 上下文压缩：自动压缩可感知 + 手动压缩反馈修复)

- 背景：检查上下文压缩功能时发现链路「通但不可用」——单测全绿却未覆盖压缩的真实行为。
- **修复 1（P0，dev 预览直接报错）**：`mock-bridge.ts` 未实现 `conversation/compact`，落 default 返回 `data:null`，UI 侧对 null 取值抛 TypeError。补齐该分支，返回与真实链路同构的 `{result:{ok,tokensBefore,tokensAfter,summary}}`，并让 mock 用量压缩后按 40% 回落。
- **修复 2（P1，自动压缩完全静默）**：`piConversationAdapter.handleEvent` 只处理 message/tool/agent 事件，**不处理 compaction_start/compaction_end**——而运行时自动压缩（阈值/溢出触发）只能靠这两个事件感知。新增 `conversation.compacted` 事件（reason 归一为 manual/auto + 前后 token + 摘要），经 `createForgeCore` 转发到 eventBus；UI 订阅后重拉 `conversation/queryHistory` 并显示提示条（压缩会把 transcript 替换为摘要，不重拉则界面与真实上下文不一致）。自动压缩失败改走 `conversation.error` 上报，绝不静默。
- **修复 3（P2，静默截断当前轮）**：压缩按钮此前仅在「压缩中」禁用，流式期间仍可点，而运行时 `compact()` 会先 `abort` 当前轮。改为 streaming 期间一并禁用并给出「回答生成中，暂不支持压缩」。
- **修复 4（P3，结果与详情丢失）**：`compactResult` 只在 script 赋值、**模板从未渲染**，压缩成功/失败在界面上毫无反馈；且适配层取 `result?.message`，而 pi `CompactionResult` 并无 message 字段，压缩前后 token 变化被丢弃。现渲染结果提示（成功显示「压缩完成：90000 → 12000 tokens」，失败显示原因原文），并从 `tokensBefore/estimatedTokensAfter/summary` 透传详情。
- 契约：新增 `conversation.compacted` 事件（`ipc-contract.ts` / `bridge.ts` 同步）；core 新增 `CompactReason` / `ConversationCompactResult` / `ConversationCompactedPayload` 并从 index 导出；`ConversationApi.emitCompacted`。
- 测试（TDD，先 RED 后 GREEN）：适配器层 6 例（自动/手动/失败/中止/详情/异常），集成层 4 例（自动压缩事件、自动压缩失败上报、compact 详情透传、会话不存在 1002），E2E 5 例（mock 默认实现可用、详情展示、失败不静默、流式禁用、自动压缩重拉历史并提示）。全量：core 305、desktop 139、UI e2e 46 全过；core/desktop/UI typecheck 通过。
- 注意：`npm test` 的裸 `node --test` 匹配不到 `.ts`（实跑 0 用例），需用 `node --experimental-strip-types --test "test/**/*.test.ts"`；desktop 测试依赖 `@forge/core` 的 dist，改 core 后须 `npm run build` 才生效。
- 文档同步：PRD 03 新增 CV-S07 场景与 AC-CV-020~024；API 03 补齐查询历史/上下文用量/手动压缩三节与 `conversation.compacted` 事件；`test/03_conversation` 覆盖矩阵与 e2e 新增 E-CV-012/013、U-CV-009/010、A-CV-008~010。

## v3.8 (真实验收状态更新 + forge v1.1 计划草案)

- 验收状态（2026-08-30 用户确认）：真实 provider 内测基本通过（真实对话可正常进行）；PIC-005（思考级别真实链路 + 1M 上下文运行时）、PIC-006（子 agent 真实事件链路）确认 OK。`pi-integration-status.md` 关键风险 1 标记解除，`overview.md` §8 风险项同步；E-SM-001/002 已修复（全量 e2e 41/41 通过，已实测复核）。
- 新增 `plan/forge-v1.1-plan.md`（草案 v2 待确认）：主线 = forge-desktop 桌面壳补全（D-01 单例锁 / D-02 安装器 / D-03 自动更新 / D-04 托盘 / D-05 系统通知 / D-06 健壮性杂项）+ **SQ 发送队列专项**；质量收尾 Q-01 损坏 session 样本 / Q-02 多会话真实并发 / Q-03 CI。
- **F-04（per-tool 审批扩展）、F-05（嵌入式终端）搁置**（2026-08-30 用户指示）；F-07 维持搁置；F-02 子 agent 逐 token / F-03 多窗口时间线 / F-06 子 agent 左树列为 M3 候选。
- **发送队列对标 ai-coding**（`backend/internal/sendqueue` ~440 行 + SendQueuePanel + 4 e2e）：队列状态机（pending/sending/cancelled + dispatch_failed 回退）、5 类 queue.* 事件、4 个 API、turn 完成尾部 auto-dequeue（forceDirect 防死循环）、异常 CancelAll/超时保留、立即发送 interrupt 路径、前端分流（busy→入队）+ 面板 + sending 才上屏时序。结论：forge 可实现 ~90%（单引擎裁掉 capabilities 探测与 runtime 快照；附件队列化是小增量），无需改 pi。现状：forge streaming 中发送返回 1001 拒绝。
- 建议里程碑 M1 桌面壳可用 → M2 发布链路 + 队列 → M3 收尾。待确认点：安装器方案、签名证书/更新源、SQ 范围裁定（立即发送/error 保留/附件上限）、M3 择项、CI 立项。

## v3.7 (CV-S06 时间线波浪衰减 + 定位贴底不退出回看)

- 用户反馈：不只是选中突出——悬停条**周边**要有平滑的波浪衰减（附 ZCode 截图：波峰周围的横条按距离递减伸长）。
- 实现（TDD，E-CV-007b 扩为波浪断言先 RED 后 GREEN）：悬停时以悬停条为中心输出宽度波包（22/18/15/13→12px，按**条目序数**距离衰减——修复了按消息索引算距离导致相邻条目被隔空压缩的问题）；回看选中条目以较低波包（18/15/13）带动邻居；width 200ms 过渡使指针扫过时波包平滑流动。
- **行为修复（AC-CV-016 接线细化）**：定位滚动结束若贴近滚动底部（目标靠后的条目被钳制在底部附近，实测距底 4px），原有"触底退出回看"会立即把回看态退出、选中突出丢失——新增 800ms 定位触底抑制窗口（`LOCATE_NEAR_BOTTOM_SUPPRESS_MS`）：程序化定位 ≠ 手动滚到底，窗口内触底信号不退出；真实手动触底与"回到底部"点击行为不变。
- 测试：E-CV-007b（波峰/一阶/二阶衰减单调、左右对称、选中保持、贴底不退出）RED→GREEN；全量 e2e 40/40、单测 50/50 通过。
- 文档同步：PRD CV-S06 交互与反馈（波浪衰减）、`test/03_conversation/e2e.md` E-CV-007b。
- 备注：本轮末期 typecheck 出现 3 个错误，均位于用户**并发编辑中**的子 Agent 输出查看 WIP（SubagentResultView 的 `subagent/queryOutput` 未注册进 ForgeMethod 等），与本模块改动无关，未代为修改。

## v3.6 (CV-S06 时间线动画修正为 ZCode 悬停伸长风格)

- 用户反馈：上一版"独立指示条滑动"理解偏了——ZCode 的效果是**悬停时横条自身平滑伸长**（指针扫过时"最长的那根"随之流动），点击选中后该条保持加长。
- 实现（TDD，重写 E-CV-007b 先 RED 后 GREEN）：移除独立指示条元素；横条自身 width 过渡（200ms cubic-bezier）承担动画——默认 12px、hover 22px（颜色同步提亮）、回看选中 18px brand 色常驻、定位闪烁 22px brand。
- **根因修复（隐藏 bug）**：横条是按钮（flex，内容宽 12px）的子项，`flex-shrink:1` 把任何 >12px 的宽度压回 12px——**此前 hover 伸长从未真正生效**；加 `flex:none` 并将 Rail 内容区预留伸长空间（宽 28px、左右 padding 3px，`overflow-x:hidden` 不再裁切伸长段）。
- 测试：E-CV-007b 断言改为悬停伸长（>20px）/移开复位/选中保持（>14px + brand 色）/无 thumb 元素；全量 e2e 40/40、单测 50/50、typecheck 通过；hover 态截图 `e2e-report/E-CV-007b-hover-style.png`（伸长条+浮窗，与 ZCode 参考一致）。
- 文档同步：PRD CV-S06 交互与反馈（悬停伸长描述）、`test/03_conversation/e2e.md` E-CV-007b。

## v3.5 (CV-S06 时间线视觉细化：纵向居中 + 选中滑动指示条)

- 用户反馈：风格已接近 ZCode，但需①横条列垂直居中（少量条目时不堆顶部）②滑动横条动画③选中的更长。
- 实现（TDD，新增 E-CV-007b 先 RED 后 GREEN）：Rail `justify-content: safe center`（溢出回退顶部保持可滚动）；新增 18px brand 色滑动指示条（`v-if` 回看态渲染、`top` 260ms cubic-bezier 平滑滑动、首次出现无动画直接就位后淡入——避免从顶部滑入；普通横条 12px 保持不变）。条目 offsetTop 经 ref 登记测量，指示条随内容滚动。
- 排障记录：E-CV-007 曾因**长期复用的 vite dev server（端口 51731）多轮 HMR 后 scoped 样式注入失效**而整块样式不生效（rail 120px、bar inline），重启 dev server 后恢复——与代码无关，测试基建注意项。
- 测试：全量 e2e 40/40（新增 E-CV-007b：居中偏差 ≤30px、指示条宽度>14px、目标对齐 ≤8px、transitionDuration>0）、单测 50/50、typecheck 通过。
- 文档同步：PRD CV-S06 交互与反馈（居中+滑动指示条）、`test/03_conversation/e2e.md`（新增 E-CV-007b + 汇总行）。

## v3.4 (CV-S06 时间线样式简化：横条标记替代文本行，去除分隔竖线)

- 用户反馈：时间线条目应为简化横条/圆点，而非文本行；Rail 与消息区之间的竖线切割感重。
- 实现（TDD，E-CV-007 断言先行 RED→GREEN）：`ConversationTimelineRail.vue` 条目改为 12×3 圆角短横条（不展示文本，截断文本保留在原生 title 提示；hover 加长变品牌色、定位闪烁/回看目标加宽高亮）；Rail 移除 `border-right` 分隔边框、背景透明、宽度 32→24px，融入消息区。交互语义不变（hover 300ms 浮窗、点击定位、高亮态、testid 不变），纯函数与单测零改动（50/50）。
- 测试：E-CV-007 断言改为横条几何（宽>8px、高≤6px）、textContent 为空 + title 承载截断文本、条目 y 正序、Rail borderRight=0；全量 e2e 39/39、typecheck 通过。
- 文档同步（用户裁定的样式修订）：PRD 03 CV-S06 业务规则与 AC-CV-014、`test/03_conversation/coverage-matrix.md`（AC-CV-014/E-CV-007 行）、`test/03_conversation/e2e.md`（E-CV-007 断言）中"条目文本单行截断"改为"简化短横条标记"。

## v3.3 (CV-S06 会话历史导航开发交付：dev-flow run 20260829155926 COMPLETE)

- 交付范围：模块 03 扩展 CV-S06（AC-CV-014~019），纯前端 forge-ui，forge-core/forge-desktop 零改动。3 个 WU 串行链全部通过 D4 验证 + D5 Fan-in + D6 模块 QA PASS。
- 实现结构：
  - 纯函数（零运行时依赖，node --test 直跑 TS）：`src/utils/conversationTimeline.ts`（buildTimelineEntries 时间线条目 40 码点、buildRoundSnapshot 轮次快照 120/200 码点截断、Array.from 码点截断无半代理对、畸形输入按空处理）、`src/utils/popoverPosition.ts`（solvePopoverPosition 右弹/翻左/垂直夹取/极窄收拢，输出恒在视口内）、`src/utils/reviewMode.ts`（browse↔review 状态机：enter 定位、exit/nearBottom 恰好一次退出、autoFollow 结构性门控、reset 会话重置）。
  - 组件：`ConversationTimelineRail.vue`（32px 左缘时间线、空态不渲染、300ms hover 延迟 emit、点击 select、定位闪烁高亮）、`ConversationHistoryPopover.vue`（320px/40vh/纯文本插值无 v-html/150ms 过渡/等待回复与运行中提示态）、`ConversationView.vue` 集成（Rail+浮窗+定位滚动 scrollIntoView+1.5s 高亮、8 处 scrollToBottom 全部经 autoFollow 门控、底部"回到底部"提示条 review 态渲染、120ms 去抖触底退出、会话切换 reset、loadHistory 数组拷贝隔离 mock 引用污染）。
  - 基建：forge-ui package.json 补 `"test": "node --test"`（先例 forge-core/desktop）。
- 测试证据：单测 50/50（22 快照/16 定位/12 状态机，RED→GREEN 全记录）；Playwright 全量回归 39/39（新增 10 条：E-CV-007/008×3/009/010×2/011）+ vite build 通过；QA Agent 独立复跑证实（50 unit + 8 新 e2e + 39 全量 + typecheck 零错误 + 无 v-html/XSS 面 + write_scope 无越界）。证据：`docs/plan/results/`（任务包/结果/验证）、`docs/plan/review-qa/module-qa-20260829155926.json`、`packages/forge-ui/e2e-report/E-CV-0*.png`（10 张截图）、flow state `docs/plan/dev-20260829155926-flow.json`（D8 COMPLETE）。
- 已知语义（非缺陷）：浮窗 Esc 关闭后指针未移开时需重新 hover 才再现（无新 mouseenter 不触发）；触底判定含 120ms 停稳去抖（smooth 滚动途中路过底部不误退）；定位高亮 class 用 ConversationView 内非 scoped 全局命名空间样式块（目标元素在孙组件 fragment 内，仅限该类名影响面）。

## v3.2 (模块 03 扩展 CV-S06 会话历史导航已确认；独立模块 07 方案撤销)

- 背景：用户需求「增加一个这种左侧的用户会话历史，点击可以定位，然后可以看到历史的对话浮窗」（附 ZCode 客户端参考图）。初稿曾按独立模块 07（左侧跨项目历史列表方案）起草；**用户裁定：不单独设模块，并入主会话（对话区）一侧**，07 的 PRD/测试设计文件与全部登记已撤销（`prd/07_session_history.md`、`test/07_session_history/` 删除，index/overview/artifacts 回退）。
- 扩展设计（并入 PRD 03，已确认）：**会话内提问时间线**——对话区左缘按时间正序列出当前会话全部用户消息（单行截断）；hover ≥300ms 弹浮窗预览该轮对话（用户消息 120 码点 + 助手回复 200 码点纯文本截断快照，流式中为快照不实时刷新，Esc/移开即关）；点击定位到该消息并进入**回看模式**（流式不强制滚底 + 底部"回到底部"提示，触底/点击恢复，TD-CV-06）。数据为已加载消息流纯派生：零新增接口、零新增存储（TD-CV-05）。范围限定主会话消息流（子 agent 结果视图不渲染，画布小窗后续）。
- 登记：`prd/03_conversation.md`（场景 CV-S06、TD-CV-05/06、功能点 CV-S06、AC-CV-014~019、页面承载、自检——扩展 6 项 PASS）；`test/03_conversation/coverage-matrix.md`（扩展基线 6 AC + unit U-CV-006~008 + e2e E-CV-007~011 行）；`test/03_conversation/e2e.md`（E-CV-007~011 详设 + 汇总行）；`prd/index.md`、`overview.md`（03 行扩展标记 + MVP 范围 + 当前状态）、`test/index.md`（03 行）。扩展为纯前端派生视图，无 API/DB 增量文档。
- 确认（2026-08-29）：用户确认扩展章节；PRD 03 与测试设计 03（含扩展 CV-S06）全部转「已确认」，`prd/index.md`、`overview.md`（03 行 + MVP 范围 + 当前状态）、`test/index.md` 同步；artifacts 03 各项维持 approved（verification/api/test-e2e 为既有文件，已覆盖扩展内容，无新增登记）。下一步可调 `dev` 开发（建议拆 WU：时间线组件与派生纯函数 / 浮窗交互 / 定位与回看模式）。

## v3.1 (PRD 06 配套 API 文档与测试设计)

- API（`api/06_subagent.md` 新增，`api/index.md` 登记）：方法 `subagent/queryList` / `subagent/stop` / `subagent/clearFinished`；事件 `subagent.updated`（完整记录幂等 upsert）/ `subagent.removed`；跨模块语义扩展 `conversation/cancelStream`（级联终止全部活跃子 agent）与 `conversation.statusChanged`（done 判据 = 主轮结束且活跃计数为 0，30 分钟兜底）；Subagent 业务对象与状态机定义；扩展缺失走非错误路径（空列表/1002）。
- 测试设计（`test/06_subagent/` 新增 coverage-matrix.md + unit.md + e2e.md）：24 条 AC 全映射（U-SA-001~007 状态机/门控/兜底/级联/隔离清理；E-SA-001~009 mock 事件序列驱动 UI 用例）；`test/integration/pi-core.md` 新增 PIC-006（真实 pi + pi-subagents 事件链路，不得全 mock）；`test/index.md` 登记（模块 06 功能点 8/8、P0/P1 100%，3 项风险维度不适用有据）。

## v3.0 (新增 PRD 06 子 Agent 管理并确认；footer 轮次分组修复)

- PRD 06（`prd/06_subagent_management.md`）从无到有并确认：背景为派生后台子 agent 后主会话误判"已完成"且完全不可见。范围：SA-F01 事件接入（pi.events 共享事件总线，TD-SA-01）、SA-F02 主会话状态联动（done = 主 agent 本轮结束且活跃子 agent 计数为 0，30 分钟超时兜底，TD-SA-02）、SA-F03 Tab 栏（输入框上方，主会话+子 agent Tab，参照 ai-coding 模式，TD-SA-04）、SA-F04 结果视图（状态/实时耗时/result 全文/Token，v-show 切换）、SA-F05 停止按钮级联终止（主 agent 本轮+全部活跃子 agent，TD-SA-03）、SA-F06 单个终止（二次确认）、SA-F07 运行期内存态按会话隔离+重启不恢复（TD-SA-05）、SA-F08 扩展缺失静默降级（TD-SA-06）。24 条 AC（AC-SA-001~024）。明确不做：spawn、左树"子 Agent (N)"分组（用户裁定 v1 不加）、子 agent 逐 token 实时查看。`prd/index.md`、`overview.md`（模块表/MVP 范围）同步更新。
- UI 修复：一次 AI 回复被工具调用拆成多张 assistant 卡片时复制按钮+时间戳重复出现。新增 `forge-ui/src/composables/useTurnFooter.ts` 轮次分组（以 user 消息为界，仅末卡显示 footer，复制内容为整轮文本）；MessageCard 增加 showFooter/copyText；ConversationView 与 MultiWindowConversation 同步接入；新增 e2e `footerTurn.spec.ts`（E-CV-FOOTER-001），全套 21/21 通过。

## v2.9 (桌面应用打包：免安装 forge.exe 手动组装流程)

- 实现范围：新增 `scripts/package.mjs`（一条命令出免安装包）与 `scripts/collect-prod-deps.mjs`（production 依赖扁平收集）。背景：electron-builder 在 npm workspaces + pi 生态大 node_modules 上依赖扫描卡死（"searching for node modules" 无进展），改为确定性手动组装：构建 workspaces → 收集 @forge/core/pi-ai/pi-coding-agent production 依赖（136 包，Dereference 穿透 workspace symlink）→ 组装 `release/`（forge.exe + resources/app）→ 拷贝 Electron 运行时。
- 产物布局：`release/forge.exe` 双击即用；主进程 `resources/app/{package.json,dist/,node_modules/}`；UI 在 `resources/forge-ui/dist/`（对齐 `src/main.ts` 生产路径 `../../forge-ui/dist/index.html`）。
- 生效方式：`node scripts/package.mjs` 重新打包，产物在 `release/`，已 .gitignore；运行用 data 目录不变（forge-store.json 照常落盘）。
- 验证：全链路冒烟通过——主进程稳定（多进程存活）、`forge-store.json` 落盘、CDP 确认 UI 渲染（FORGE/项目树/设置等，58 DOM 节点）。
- 文档同步：`scripts/package.mjs` 头部注释（背景/布局/用法）；changelog 本条。

## v2.8 (项目拖拽排序：会话树项目按优先级钉扎)

- 实现范围：
  - forge-core：`ProjectRecord` 新增 `priority`（number | null，null=未钉扎）；store `listProjects` 排序改为 priority 升序优先、未钉扎按最近打开倒序排其后；新增 `reorderProjects(paths)` 全量重排（按顺序写 priority=0..n-1 一次落盘，含未注册路径返回 1003 不写盘）；`projectService.reorderProjects`（非法 1001 / 未注册 1002）；RPC 新增 `project/reorderProjects`（requireArray 校验 paths 非空字符串数组）。
  - forge-desktop：ipc-contract 新增 `project/reorderProjects`。
  - forge-ui：ProjectTree 项目节点拖拽排序（指针在目标节点上半部插入其前、下半部其后，容器空白处放下排末尾），发射 `reorder-project` 全量新顺序；修复会话拖拽冒泡触发项目拖拽的隐患（onSessionDragStart 阻止传播）；App 接管 `reorder-project` 调 RPC 并刷新列表。
- 生效方式：拖拽项目排序立即持久化（写 forge-store.json priority），刷新/重启保持；首次拖拽后项目全部钉扎，打开项目不再重排列表；之后新增项目保持未钉扎（排钉扎之后）。
- 测试：forge-core 新增 7 例（store 重排/持久化/未注册不写盘/钉扎优先排序、service 校验透传、rpc 参数与合法重排），全套 267 绿；forge-desktop 107 绿；typecheck 全绿。
- 文档同步：`prd/01_project_management.md`（PM-S01 排序规则 + AC-PM-012）、`api/01_project.md`（queryProjectList 排序说明 + 新增 project/reorderProjects 章节）、`db/forge-store/schema.md`（project.priority 字段 + 索引/设计说明）、`test/01_project/coverage-matrix.md`（AC-PM-012、U-PM-004/005、A-PM-008）。

## v2.7 (火山方舟自动兼容：保存 provider 时按地址自动补 compat)

- 实现范围：
  - forge-desktop：piModelsFileAdapter `writeProviders` 按 `baseUrl` 判定火山方舟地址（域名含 `volces.com`），自动为缺 `compat` 的模型记录补默认兼容块（`thinkingFormat: deepseek` / `supportsDeveloperRole: false` / `maxTokensField: max_tokens` / `requiresReasoningContentOnAssistantMessages: true`）；已有手配 `compat` 保留不覆盖，非火山地址不注入。
- 生效方式：保存火山地址 provider 后 models.json 模型记录出现默认 compat，pi 加载即按 DeepSeek 系协议请求；存量无 compat 的火山模型在下一次任何保存时自愈。
- 测试：forge-desktop 新增 2 例（火山注入 + 已有 compat 保留），相关回归 15 例全过，typecheck 全绿。
- 文档同步：`prd/05_model_provider.md`（MP-S01 业务规则 + AC-MP-028）、`api/05_model.md`（saveProvider 落盘附加行为）、`test/05_model/coverage-matrix.md`（AC-MP-028、U-MP-012/013）。

## v2.6 (思考等级配置：模型表单「思考强度」勾选 + 思考等级多选下拉)

- 实现范围：
  - forge-core：`saveProvider` 新增 `reasoning`（布尔校验）与 `thinkingLevels`（THINKING_LEVELS 内去重列表，null 移除）参数；新增导出 `THINKING_LEVELS`/`DEFAULT_THINKING_LEVELS`/`buildThinkingLevelMap`（全量 7 项显式 map：选中=级别名，未选=null，TD-MP-07）；`ProviderConfig` 回显 `reasoning` 与 `thinkingLevels`；RPC 解析层校验去重。
  - forge-desktop：piModelsFileAdapter 首模型 `reasoning` 写/移除、`thinkingLevels` 映射写 `thinkingLevelMap`（数组覆盖/ null 移除/缺省不触碰）；读侧按 pi `getSupportedThinkingLevels` 语义推导白名单回显。
  - forge-ui：设置页模型表单新增「思考强度」勾选 + 下方思考等级多选下拉（off 不参与配置、写 null 隐藏，对话框不出现「关闭思考」挡位；未勾选时禁用置灰、编辑回显按 pi 语义推导、触发器显示已选挡位）。
- 生效方式：保存写 models.json（reasoning/thinkingLevelMap）→ pi 重载 → 对话框思考级别切换器可选挡位按白名单变化。
- 测试：forge-core 259 例、forge-desktop 105 例（新增 buildThinkingLevelMap/service 校验透传/解析层去重/adapter 读写回显 7 例），typecheck 全绿。
- 文档同步：`prd/05_model_provider.md`（新增 MP-S07 场景/TD-MP-07/功能点/AC-MP-023~027）、`api/05_model.md`（provider.reasoning/thinkingLevels、saveProvider.reasoning/thinkingLevels）、`test/05_model/coverage-matrix.md`（AC-MP-023~027、代码后记 U/A/E-MP-009 等）。

## v2.5 (多模态图片支持：模型配置「支持图片输入」勾选 + 发送门控)

- 根因修复：MiniMax-M3 等多模态模型在 models.json 中未声明 `input` 能力时，pi 默认按纯文本处理，图片被降级为占位文本、模型回复"无法识别图片"。本版本提供配置 + 发送侧双保险。
- 实现范围：
  - forge-core：`saveProvider` 新增 `vision` 参数（布尔校验，缺省保留原值），`ProviderConfig` 回显 `vision`；`conversation/sendMessage` 新增多模态门控（注入 `modelSupportsImages` 端口，不支持图片时过滤图片附件、内容追加跳过说明、响应返回 `skippedImages`）。
  - forge-desktop：piModelsFileAdapter 首模型 `input: ["text","image"]` 写/移除/回显（与 contextWindow 同模式，undefined 不覆盖手工 input）；createForgeCore 注入 `modelSupportsImages`（`resolvePiModel(model).input.includes("image")`）。
  - forge-ui：设置页「支持图片输入（多模态）」勾选（编辑回显、列表「多模态」标签）；发送后气泡显示「图片未发送：当前模型不支持图片输入」标记（单/多窗口同步）。
- 生效方式：勾选保存触发模型运行时缓存刷新，立即生效无需重启。
- 测试：forge-core 248 例、forge-desktop 101 例（新增 vision 落盘/回显、能力门控 skippedImages 等），typecheck 全绿。
- 文档同步：`api/05_model.md`（provider.vision / saveProvider.vision）、`api/03_conversation.md`（sendMessage attachments/skippedImages）、05/03 coverage-matrix 新增 AC-MP-020~022、AC-CV-013。

## v2.4 (PRD 05 扩展开发完成：思考级别选择 + 上下文 1M)

- dev-flow run `20260827115957` 交付模块 05 扩展，6 个 WU 全部通过 D3/D4，D5 Fan-in、D6 模块 QA 终审 PASS（含一轮回流：MP-QA-G01 修复 + G03 证据闭合），dev-flow 返回 COMPLETE。
- 实现范围：
  - forge-core：ModelService 新增 `getModelThinkingLevels`/`getSessionThinkingLevel`/`setSessionThinkingLevel`（写会话+同步全局默认、null 清除覆盖、off 兜底），`SaveProviderInput`/`ProviderConfig` 增加 contextWindow 透传与回显；store settings 播种 `thinkingLevel='off'`；RPC 注册三新方法。
  - forge-desktop：piModelsFileAdapter 首模型 contextWindow 写/移除/回显；piModelResolver 消费 `@earendil-works/pi-ai` 官方 `getSupportedThinkingLevels`/`clampThinkingLevel`（TD-MP-04，新增依赖 pi-ai@0.84.3）；AgentSession.setThinkingLevel 应用（创建/发送/去重）；createForgeCore 注入 ThinkLevelsPort、resolveSendOptions 实时读取全局默认（修复 QA-G01 快照不一致）。
  - forge-ui：设置页「上下文窗口 1M」勾选（按勾选覆盖、编辑回显 ===1000000）；输入框模型选择旁思考级别切换器（仅 >1 显示/降级隐藏、会话隔离、无多余 toast）与 **max 金色流光动画**（纯 CSS conic-gradient+mask、rotate 合成器动画，实测 ≈61fps / ≈2.6s）。
- 测试：forge-core 240 例、forge-desktop 90 例、settings.spec 5、thinkingLevel.spec 4（含时长/帧率量化断言），typecheck 全绿。
- 已知待办：AC-MP-019 运行时「上下文按 1000000 计算」与思考级别持久化的真实 pi 集成验证需集成环境执行 PIC-005（docs/test/integration/pi-core.md，QA 接受为 documented limitation）。

## v2.3 (PRD 05 扩展：思考级别选择 + 上下文 1M)

- `prd/05_model_provider.md` 由"PRD 已确认"重新进入草稿并完成扩展确认：新增 MP-S05 思考级别选择（输入框模型选择旁切换器，按 pi `getSupportedThinkingLevels` 渲染可用级别，会话级 + 同步全局默认，非推理模型隐藏入口，切 max 触发金色流光动画）、MP-S06 上下文大小配置（表单「上下文窗口 1M」勾选，写 `contextWindow: 1000000`，取消移除字段）。
- 新增关键技术决策 TD-MP-04（能力来源 = pi SDK）、TD-MP-05（输入框切换 + 会话级 + 全局默认）、TD-MP-06（contextWindow=1000000，取消移除）。
- 新增验收 AC-MP-010~014（思考级别）与 AC-MP-015~019（上下文 1M）。
- 当前生效语义（已确认）：思考级别切换下一轮生效、不打断；正常切换无提示、切 max 输入框金色流光动画约 2-3s；上下文保存一律按勾选覆盖（非 1M 存量未勾选保存会移除字段）。
- 下游文档已同步：`db/forge-store/schema.md`（session.thinkingLevel、settings.thinkingLevel seed）、`api/05_model.md`（saveProvider.contextWindow、getModelThinkingLevels、get/setSessionThinkingLevel，错误码扩充）、`test/05_model/coverage-matrix.md`（AC-MP-010~019 + PIC-005 真实集成）、`test/integration/pi-core.md`（PIC-005）、`test/index.md`（05 覆盖率 6/6、17/17）、forge-core `types/forge-store.ts`（SessionRecord.thinkingLevel、StoreKey thinkingLevel）。
- 思考级别计划文档：`plan/think-20260827102000138-plan.md`。
- 文档状态：PRD/DB/API/测试均保持"已确认"（含扩展），`docs/artifacts.json` 状态不变（approved）。

## v2.2 (DB/API/测试设计三档确认)

- DB schema（`db/forge-store/schema.md` + `db/README.md`）、API 契约（`api/index.md` + 01~05）、测试设计（`test/index.md` + 5 模块 coverage-matrix + 02/03/04 e2e + 05 api + `test/integration/pi-core.md`）状态由"规划中"确认置为"已确认"。
- `docs/artifacts.json` 各模块与 per-artifact 状态同步为 `approved`。
- `overview.md` §5 配套设计文档、§8 当前状态同步：文档全部冻结，可进入 `dev` 开发阶段。

## v2.1 (测试设计改进 F1-F6)

- F1：`test/index.md` 修自洽缺口：必测场景口径定义 + “P0 断言 100% 自动覆盖，manual 仅补充”（纠正误标“P0 无 manual”）。
- F2：PRD 02 补多窗口 AC（AC-SM-017~020：8 区吸附/4 窗格/resize/窗口崩溃恢复），02 覆盖矩阵跟进。
- F3：展开 `test/02_session/e2e.md`（多窗口交互，按新 skill 前置/步骤/断言三要素）。
- F4：展开 `test/03_conversation/e2e.md`（流式 mock 时序/XSS）、`test/04_tool/e2e.md`（Diff fixtures/大文件）、`test/05_model/api.md`（keychain mock/models.json 断言）。
- F5/F6：新增 `test/integration/pi-core.md`——pi 事件→CanonicalEvent 映射完整性（PIC-001）、AgentSession 生命周期（PIC-002）、多 AgentSession 真实并发非 mock（PIC-003）、后端健康+契约（PIC-004）。补各矩阵把 pi 当 mock 之下的真实集成层（最大后端盲区）。
- 同步更新 `test/index.md` 模块展开文档列 + 新增跨模块集成入口。
- 关联：skill 加强（gen-doc-test-cases C1-C7）已落地，本批按新 contract 触发展开。

## v1.9 (下游文档审核修正)

审核其他模型生成的 db/api/test/artifacts，修正 3 处：
- **artifacts.json**：补登 `db`/`api` 产物声明（01/02/05 含 db，全 5 模块含 api）；改为 per-artifact 状态（`prd`=approved、`verification`/`api`/`db`=draft），纠正原 verification 误标 approved。
- **DB schema/README**：存储介质表述由"Electron userData 目录"改为"forge-desktop 传入的路径"（forge-core 纯 Node 不调 Electron API）；补并发选型理由（forge-core 单一写入中心串行化->JSON+原子写安全；SQLite 为后续升级路径，呼应决策 4 消除并发写者）。
- **API 01**：澄清 `openProject` 同步返回 `code=1005` 是 v1 信任询问主路径，`project.trustRequested` 事件为预留不依赖。

审核结论：其他模型文档质量高、正确采纳传输无关决策 4、数据归属正确、AC 覆盖完整，无原则性错误。

## v2.0 (gen-doc-all：DB/API/测试设计生成)

- 新增 `docs/db/forge-store/schema.md`：forge 自有存储设计（本地 JSON 文件，无传统数据库）。3 张表：project / session / settings；明确 forge-pi 数据边界（pi 会话、models.json、keychain 归 pi，forge 不重造）。
- 新增 `docs/db/README.md`：DB 索引。
- 新增 `docs/api/`：forge-core 传输无关接口契约（方法+事件，桌面 IPC v1 / headless v2+），index.md + 01 项目管理 / 02 会话 / 03 对话 / 04 工具 / 05 模型五个模块文档，统一响应格式 `{code,message,data}` 与错误码。
- 新增 `docs/test/`：5 个模块 coverage-matrix.md（unit/api/api/e2e 内嵌设计），功能点/风险维度/必测场景覆盖率见 `docs/test/index.md`。
- 新增 `docs/artifacts.json`：5 个模块 PRD + verification 登记（approved）。
- overview §5 增补配套设计文档导航；§8 状态更新为"DB/API/测试设计待确认"。
- 待确认：DB schema、API 契约、测试设计三者的"规划中 → 已确认"。确认后即可进入 `dev`。

## v1.9 (PRD 残留修正)

- 修正 `docs/overview.md` §7：MVP 范围"多窗口观察"中 **Aero Snap 吸附** -> **窗口吸附**（v1.6 已改术语，此处残留旧词）。
- 修正 `docs/prd/03_conversation.md` CV-S02 业务规则："pi 事件 -> CanonicalEvent -> SSE -> 前端" -> "-> 增量事件推送（桌面 IPC 事件 / headless SSE）"（v1.8 传输架构修正后桌面端走 IPC，此处仍残留 SSE；headless SSE 仅 v2+）。
- 修正 `docs/prd/02_session_management.md` 多窗口状态同步："SSE 流由 forge-core 统一管理" -> "会话输出流经 IPC 事件推送"（同上，对齐 v1.8）。

## v1.8 (架构决策修正 + PRD 次要修正)

**B. 传输架构修正（决策 4）**：forge-core 由"REST/SSE 服务层"改为**传输无关接口**（方法+事件）；桌面端走 **Electron IPC**、headless 走 **HTTP/SSE**（v2+）。原因：HTTP-in-Electron 有本地攻击面（同机其他进程可打端口借 AgentSession 执行任意操作）；IPC 只许自家渲染进程调用，堵死攻击面。功能不变、更安全、接缝更干净。涉及：`forge-v1-plan` 决策4、`overview` 原则6/技术栈/技术分层/风险、`PRD 03` TD-CV-01+1.4、`embedded-agent-discussion` §6。

**A. 三处次要修正**：
- PRD 01：project_trust 拦截注明"以 user/global 扩展形式（project-local 信任前未加载）、SDK 模式不走 ctx.ui、经 forge-core 桥接 Vue"。
- PRD 05：注明 forge 需自带跨 OS keychain 读取命令（`!forge-secret get <provider>`，macOS/Windows/Linux 适配）。
- PRD 02：跨项目会话池由 forge 自行遍历 `~/.pi/agent/sessions/` 解码 cwd 枚举（pi 无此 API）。

**风险项更新**：多 AgentSession 并发由"待 spike"改为"源码分析支持 + demo 已运行时验证 2 并发"。

## v1.7 (会议室概念存档)

- 新增 `plan/meeting-room-concept.md`：会议室（多模型互相审核）概念文档，含架构A（编排器+对等 AgentSession，非子agent）、3轮流程图、分阶段、demo 验证证据。
- demo 佐证：2 并发 AgentSession 运行时跑通（顺带验证 PRD 02 TD-SM-01）；真模型调用（minimax 官方站 + huoshan ARK）有 fetch 拦截 + request-id 证据。
- 会议室定位为 v2+ 候选（非 v1 MVP），待 v1 多会话能力落地后 Phase 1 顺手可做。
- 关联产物：`meeting-room-demo.mjs`（脚本）、`meeting-room-demo.html`（可视化）、`meeting-room-demo-output.md`（纪要）。

## v1.6 (PRD 审核修正)

- 多窗口正式纳入 MVP（用户决策，非常想要）。
- PRD 02 修正：明确视窗形态=**应用内画布**（单 BrowserWindow 模拟多窗口，非真 OS 窗口）；"Aero Snap" 改为 "窗口吸附"（自定义 snap，非 OS）；标注不支持跨屏（跨屏需改真 BrowserWindow，属重写）；标注多窗口为新开发、会话内部组件复用 ai-coding。
- PRD 02 TD-SM-01 补并发纪律（源码分析）：AgentSession 无全局单例、事件总线 per-loader、扩展实例 per-loader；纪律=每会话独立 ResourceLoader + forge 扩展不得用模块级可变状态。新增 SM-S04/SM-S05 解耦说明（多窗口 UI 不依赖并发，仅并行执行依赖）。印证 v1.2 风险降级判断。
- 新增 `plan/spike-multi-session.ts`：pi 多 AgentSession 并发运行时验证脚本（需先构建 pi；此环境缺 tsgo 未能跑，源码分析已支持结论）。
- 修正原型 `window-mode-mockup.html`：去掉方案A 跨屏错误声称；演示文本 `beforeToolCall` 改为正确的 `tool_call` 事件。
- 次要项待修（PRD 01/05）：project_trust 拦截细节（user/global 扩展+forge-core 桥接非 ctx.ui）、PRD 05 注明 forge 需自带跨 OS keychain 读取命令、PRD 02 跨项目会话池由 forge 自行遍历 sessions 目录。

## v1.5

- 模块 05 模型与 Provider 配置 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，14 项 PASS，0 WARN/FAIL）。
- 确认 3 项技术决策：密钥安全引用 !command/env（TD-MP-01）、全局默认+会话覆盖（TD-MP-02）、复用 pi models.json 不用 registerProvider（TD-MP-03）。
- 澄清：v1 forge 是 pi models.json 的可视化编辑器，扩展层 registerProvider 不在 v1 范围。
- 5 个 PRD 模块全部确认完成，进入 gen-doc-all 确认点 2。

## v1.4

- 模块 04 工具执行展示 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，14 项 PASS，0 WARN/FAIL）。
- 确认 3 项技术决策：并排 Diff（TD-TE-01）、长结果折叠（TD-TE-02）、对话流穿插（TD-TE-03）。

## v1.3

- 模块 03 对话与消息 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，17 项 PASS，0 WARN/FAIL）。
- 确认 4 项技术决策：流式增量传输（TD-CV-01）、Markdown 白名单安全渲染（TD-CV-02，防 XSS）、取消+保留已生成（TD-CV-03）、历史全量加载（TD-CV-04）。

## v1.2

- 模块 02 会话管理 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，18 项 PASS，0 WARN/FAIL）。
- 确认 5 项技术决策：多会话并行（TD-SM-01）、多窗口画布+Aero Snap（TD-SM-02）、跨项目会话池（TD-SM-03）、会话输出与窗口解耦+一会话一窗口（TD-SM-04）、硬删+二次确认（TD-SM-05）。
- 多会话并行风险降级：CLI 多进程已证明 pi 支持多 session，进程内多 AgentSession 仅需验证全局状态隔离，风险中低。

## v1.1

- 模块 01 项目管理 PRD 确认：完成第 3、4 节（详细设计 + 自检报告，14 项 PASS，0 WARN/FAIL）。
- 作废 TD-PM-03「工作区模型」：项目仅为会话分类容器，非活动单元；会话执行模型与视窗模型移至模块 02。
- 新增 v1 需求：多窗口观察（多会话跨项目并排，Aero Snap 吸附 + 自由 resize + z-index 置顶），纳入 MVP 范围，归入模块 02 会话管理。
- 新增风险项：pi 多 AgentSession 并发可行性、pi 信任事件拦截可行性。
- 新增原型：`plan/window-mode-mockup.html`（多窗口形态对比 + 方案 A 交互验证）。

## v1.0 (初始化)

- 立项 forge：以 pi 为固定引擎的桌面项目工作台。
- 锁定架构决策：pi 进程内 SDK + Electron + 复用 ai-coding Vue + 业务=pi 扩展 + 权限/存储跟 pi 一致 + v1 MVP。
- 初始化 docs 目录（specs/templates/prd/db/api/test/plan/ui）。
- 新增 PRD 队列（5 个业务模块，均草稿-待确认）：项目管理、会话管理、对话与消息、工具执行展示、模型与 Provider 配置。
- 关联文档：`plan/forge-v1-plan.md`、`plan/embedded-agent-discussion.md`、`plan/think-1786004271124-plan.md`。
